package expo.modules.audiostream

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.Bundle
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.Promise
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.consumeAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.max
import kotlin.math.min

/**
 * Enum representing PCM encoding formats
 */
enum class PCMEncoding {
    PCM_F32LE,  // 32-bit float, little-endian
    PCM_S16LE   // 16-bit signed integer, little-endian
}

data class ChunkData(
    val chunk: String, 
    val turnId: String, 
    val promise: Promise,
    val encoding: PCMEncoding = PCMEncoding.PCM_S16LE
) // contains the base64 chunk and encoding info

data class AudioChunk(
    val audioData: FloatArray,
    val promise: Promise,
    val turnId: String,
    var isPromiseSettled: Boolean = false
) // contains the decoded base64 chunk

class AudioPlaybackManager(private val eventSender: EventSender? = null) {
    private lateinit var processingChannel: Channel<ChunkData>
    private lateinit var playbackChannel: Channel<AudioChunk>

    private val coroutineScope = CoroutineScope(Dispatchers.Default + SupervisorJob())

    private var processingJob: Job? = null
    private var currentPlaybackJob: Job? = null

    private lateinit var audioTrack: AudioTrack
    private var isPlaying = false
    private var currentTurnId: String? = null
    private var hasSentSoundStartedEvent = false
    private var segmentsLeftToPlay = 0

    // Current sound configuration
    private var config: SoundConfig = SoundConfig.DEFAULT

    // Whether the AudioTrack was created with PCM_FLOAT (true) or PCM_16BIT (false).
    // Some device HALs don't support FLOAT output; we detect this at init and fall back.
    private var trackUsesFloat: Boolean = true
    
    // Specific turnID to ignore sound events (similar to iOS)
    // Removed: private val suspendSoundEventTurnId: String = "suspend-sound-events"

    init {
        initializeAudioTrack()
        initializeChannels()
    }

    private fun initializeAudioTrack() {
        // Try PCM_FLOAT first; fall back to PCM_16BIT if the HAL doesn't support it.
        var encoding = AudioFormat.ENCODING_PCM_FLOAT
        var minBufferSize = AudioTrack.getMinBufferSize(
            config.sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            encoding
        )

        if (minBufferSize <= 0) {
            Log.w("AudioPlaybackManager",
                "getMinBufferSize returned $minBufferSize for PCM_FLOAT " +
                "(sampleRate=${config.sampleRate}). Falling back to PCM_16BIT.")
            encoding = AudioFormat.ENCODING_PCM_16BIT
            minBufferSize = AudioTrack.getMinBufferSize(
                config.sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                encoding
            )
            if (minBufferSize <= 0) {
                // Last resort: calculate a 20 ms frame for 16-bit mono (2 bytes/sample)
                Log.e("AudioPlaybackManager",
                    "getMinBufferSize also failed for PCM_16BIT ($minBufferSize). " +
                    "Using 20ms fallback buffer.")
                minBufferSize = (config.sampleRate * 2) / 50
            }
        }

        trackUsesFloat = (encoding == AudioFormat.ENCODING_PCM_FLOAT)

        val audioFormat = AudioFormat.Builder()
            .setSampleRate(config.sampleRate)
            .setEncoding(encoding)
            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
            .build()

        // Configure audio attributes based on playback mode
        val audioAttributesBuilder = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)

        // Set content type based on playback mode
        val contentType = when (config.playbackMode) {
            PlaybackMode.CONVERSATION, PlaybackMode.VOICE_PROCESSING ->
                AudioAttributes.CONTENT_TYPE_SPEECH
            else ->
                AudioAttributes.CONTENT_TYPE_MUSIC
        }

        audioAttributesBuilder.setContentType(contentType)

        audioTrack =
            AudioTrack.Builder()
                .setAudioAttributes(audioAttributesBuilder.build())
                .setAudioFormat(audioFormat)
                .setBufferSizeInBytes(minBufferSize * 2)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()

        Log.d("AudioPlaybackManager",
            "AudioTrack created: encoding=${if (trackUsesFloat) "FLOAT" else "16BIT"}, " +
            "sampleRate=${config.sampleRate}, bufferBytes=${minBufferSize * 2}")
    }

    private fun initializeChannels() {
        // Close the channels if they are still open
        if (!::processingChannel.isInitialized || processingChannel.isClosedForSend) {
            processingChannel = Channel(Channel.UNLIMITED)
        }
        if (!::playbackChannel.isInitialized || playbackChannel.isClosedForSend) {
            playbackChannel = Channel(Channel.UNLIMITED)
        }
    }

    fun playAudio(chunk: String, turnId: String, promise: Promise, encoding: PCMEncoding = PCMEncoding.PCM_S16LE) {
        coroutineScope.launch {
            if (processingChannel.isClosedForSend || playbackChannel.isClosedForSend) {
                Log.d("ExpoPlayStreamModule", "Re-initializing channels")
                initializeChannels()
            }
            // Update the current turnId (this will reset flags if needed through setCurrentTurnId)
            setCurrentTurnId(turnId)
            
            processingChannel.send(ChunkData(chunk, turnId, promise, encoding))
            ensureProcessingLoopStarted()
        }
    }

    fun setCurrentTurnId(turnId: String) {
        // Reset tracking flags when turnId changes
        if (currentTurnId != turnId) {
            hasSentSoundStartedEvent = false
            // Only reset segments counter if we're not in the middle of playback
            if (!isPlaying || playbackChannel.isEmpty) {
                segmentsLeftToPlay = 0
            }
        }
        currentTurnId = turnId
    }

    fun runOnDispose() {
        stopPlayback()
        processingChannel.close()
        stopProcessingLoop()
        coroutineScope.cancel()
    }

    fun stopProcessingLoop() {
        processingJob?.cancel()
        processingJob = null
    }


    private fun ensureProcessingLoopStarted() {
        if (processingJob == null || processingJob?.isActive != true) {
            startProcessingLoop()
        }
    }

    private fun startProcessingLoop() {
        processingJob =
            coroutineScope.launch {
                for (chunkData in processingChannel) {
                    if (chunkData.turnId == currentTurnId) {
                        processAndEnqueueChunk(chunkData)
                    }

                    if (processingChannel.isEmpty && !isPlaying && playbackChannel.isEmpty) {
                        break // Stop the loop if there's no more work to do
                    }
                }
                processingJob = null
            }
    }

    private suspend fun processAndEnqueueChunk(chunkData: ChunkData) {
        try {
            val decodedBytes = Base64.decode(chunkData.chunk, Base64.DEFAULT)
            val audioDataWithoutRIFF = removeRIFFHeaderIfNeeded(decodedBytes)
            
            // Use the encoding specified in the chunk data
            val audioData = convertPCMDataToFloatArray(audioDataWithoutRIFF, chunkData.encoding)

            // Check if this is the first chunk and we need to send the SoundStarted event
            // Using hybrid approach checking both flag, segments count, and channel state
            val isFirstChunk = segmentsLeftToPlay == 0 && 
                              playbackChannel.isEmpty && 
                              (!hasSentSoundStartedEvent || !isPlaying)
                              
            if (isFirstChunk && chunkData.turnId != SUSPEND_SOUND_EVENT_TURN_ID) {
                sendSoundStartedEvent()
                hasSentSoundStartedEvent = true
            }

            playbackChannel.send(
                AudioChunk(
                    audioData,
                    chunkData.promise,
                    chunkData.turnId
                )
            )
            
            // Increment the segments counter
            segmentsLeftToPlay++

            if (!isPlaying) {
                startPlayback()
            }
        } catch (e: Exception) {
            chunkData.promise.reject("ERR_PROCESSING_AUDIO", e.message, e)
        }
    }

    fun startPlayback(promise: Promise? = null) {
        try {
            if (!isPlaying) {
                if (::audioTrack.isInitialized && audioTrack.state != AudioTrack.STATE_UNINITIALIZED) {
                    audioTrack.play()
                    isPlaying = true
                    startPlaybackLoop()
                    ensureProcessingLoopStarted()
                } else {
                    throw IllegalStateException("AudioTrack not initialized or in invalid state")
                }
            }
            promise?.resolve(null)
        } catch (e: Exception) {
            promise?.reject("ERR_START_PLAYBACK", e.message, e)
        }
    }

    fun stopPlayback(promise: Promise? = null) {
        if (!isPlaying || playbackChannel.isEmpty ) {
            promise?.resolve(null)
            return
        }
        isPlaying = false
        coroutineScope.launch {
            try {

                if (::audioTrack.isInitialized && audioTrack.state != AudioTrack.STATE_UNINITIALIZED) {
                    try {
                        audioTrack.stop()
                        try {
                            audioTrack.flush()
                        } catch (e: Exception) {
                            Log.e("ExpoPlayStreamModule", "Error flushing AudioTrack: ${e.message}", e)
                            // Continue with other cleanup operations
                        }
                    } catch (e: Exception) {
                        Log.e("ExpoPlayStreamModule", "Error stopping AudioTrack: ${e.message}", e)
                        // Continue with other cleanup operations
                    }
                }
                // Safely cancel jobs
                if (currentPlaybackJob != null) {
                    currentPlaybackJob?.cancelAndJoin()
                    currentPlaybackJob = null
                }

                if (processingJob != null) {
                    processingJob?.cancelAndJoin()
                    processingJob = null
                }

                // Resolve remaining promises in playbackChannel
                for (chunk in playbackChannel) {
                    if (!chunk.isPromiseSettled) {
                        chunk.isPromiseSettled = true
                        chunk.promise.resolve(null)
                    }
                }

                if (!processingChannel.isClosedForSend) {
                    processingChannel.close()
                }
                if (!playbackChannel.isClosedForSend) {
                    playbackChannel.close()
                }

                // Reset the sound started event flag
                hasSentSoundStartedEvent = false
                
                // Reset the segments counter
                segmentsLeftToPlay = 0

                promise?.resolve(null)
            } catch (e: CancellationException) {
                Log.d("ExpoPlayStreamModule", "Stop playback was cancelled: ${e.message}")
                promise?.resolve(null)
            } catch (e: Exception) {
                Log.d("ExpoPlayStreamModule", "Error in stopPlayback: ${e.message}")
                promise?.reject("ERR_STOP_PLAYBACK", e.message, e)
            }
        }
    }

    private fun startPlaybackLoop() {
        currentPlaybackJob =
            coroutineScope.launch {
                playbackChannel.consumeAsFlow().collect { chunk ->
                    if (isPlaying) {
                        
                        if (currentTurnId == chunk.turnId) {
                            playChunk(chunk)
                        }

                    } else {
                        // If not playing, we should resolve the promise to avoid leaks
                        chunk.promise.resolve(null)
                    }
                }
            }
    }

    private suspend fun playChunk(chunk: AudioChunk) {
        withContext(Dispatchers.IO) {
            try {
                val chunkSize = chunk.audioData.size

                suspendCancellableCoroutine { continuation ->
                    // Write the audio data — convert to shorts if the track is 16-bit
                    val written = if (trackUsesFloat) {
                        audioTrack.write(
                            chunk.audioData,
                            0,
                            chunkSize,
                            AudioTrack.WRITE_BLOCKING
                        )
                    } else {
                        val shortData = ShortArray(chunkSize) { i ->
                            (chunk.audioData[i].coerceIn(-1f, 1f) * 32767f).toInt().toShort()
                        }
                        audioTrack.write(
                            shortData,
                            0,
                            chunkSize,
                            AudioTrack.WRITE_BLOCKING
                        )
                    }
                    
                    // Resolve the promise immediately after writing
                    // This lets the client know the data was accepted
                    if (!chunk.isPromiseSettled) {
                        chunk.isPromiseSettled = true
                        chunk.promise.resolve(null)
                    }
                    
                    if (written != chunkSize) {
                        // If we couldn't write all the data, resume with failure
                        val error = Exception("Failed to write entire audio chunk")
                        continuation.resumeWith(Result.failure(error))
                        return@suspendCancellableCoroutine
                    }
                    
                    // Calculate expected playback duration in milliseconds
                    val playbackDurationMs = (written.toFloat() / config.sampleRate * 1000).toLong()
                    
                    // Store a reference to the delay job
                    val delayJob = coroutineScope.launch {
                        // Wait for a portion of the audio to play
                        // Wait for 50% of duration, but cap at 90% of duration to ensure loop continues reasonably quickly
                        val waitTime = (playbackDurationMs * 0.5).toLong().coerceAtMost((playbackDurationMs * 0.9).toLong()) // Keep early resume
                        delay(waitTime) // Wait for partial duration
                        continuation.resumeWith(Result.success(Unit))

                        // Continue waiting in the background for the rest of the estimated duration
                        delay(playbackDurationMs - waitTime)
                        // Signal that this chunk has finished playing asynchronously
                        handleChunkCompletion(chunk)
                    }
                    
                    continuation.invokeOnCancellation {
                        // Cancel the delay job to prevent it from resuming the continuation
                        delayJob.cancel()
                        
                        // Settle the promise if it hasn't been settled yet
                        if (!chunk.isPromiseSettled) {
                            chunk.isPromiseSettled = true
                            chunk.promise.reject("ERR_PLAYBACK_CANCELLED", "Playback was cancelled", null)
                        }
                        
                        // Any other cleanup specific to this chunk
                        // For example, if we were tracking this chunk in a map or list, we would remove it
                    }
                }
            } catch (e: Exception) {
                Log.e("ExpoPlayStreamModule", "Error in playChunk: ${e.message}", e)
                if (!chunk.isPromiseSettled) {
                    chunk.isPromiseSettled = true
                    chunk.promise.reject("ERR_PLAYBACK", e.message, e)
                }
            }
        }
    }

    /**
     * Handles the completion of a single audio chunk's estimated playback duration.
     * This is called asynchronously from the delay job within playChunk.
     * Decrements the segment counter and sends the final event if applicable.
     * Uses coroutineScope to ensure thread safety if needed for state access.
     */
    private fun handleChunkCompletion(chunk: AudioChunk) {
        coroutineScope.launch { // Launch on default dispatcher for safety
            segmentsLeftToPlay = (segmentsLeftToPlay - 1).coerceAtLeast(0)

            // Check if this was the last chunk for the current turn ID and the queue is empty
            val isFinalChunk = segmentsLeftToPlay == 0 && playbackChannel.isEmpty && chunk.turnId == currentTurnId

            if (isFinalChunk && chunk.turnId != SUSPEND_SOUND_EVENT_TURN_ID) {
                sendSoundChunkPlayedEvent(isFinal = true)
                // Reset the flag after the final chunk event for this turn is sent
                hasSentSoundStartedEvent = false
            }
        }
    }

    /**
     * Sends the SoundStarted event to JavaScript
     */
    private fun sendSoundStartedEvent() {
        eventSender?.sendExpoEvent(Constants.SOUND_STARTED_EVENT_NAME, Bundle())
    }

    /**
     * Sends the SoundChunkPlayed event to JavaScript
     * @param isFinal Boolean indicating if this is the final chunk in the playback sequence
     */
    private fun sendSoundChunkPlayedEvent(isFinal: Boolean) {
        val params = Bundle()
        params.putBoolean("isFinal", isFinal)
        eventSender?.sendExpoEvent(Constants.SOUND_CHUNK_PLAYED_EVENT_NAME, params)
    }

    /**
     * Converts PCM data to a float array based on the specified encoding format
     * @param pcmData The raw PCM data bytes
     * @param encoding The PCM encoding format (PCM_F32LE or PCM_S16LE)
     * @return FloatArray containing normalized audio samples (-1.0 to 1.0)
     */
    private fun convertPCMDataToFloatArray(pcmData: ByteArray, encoding: PCMEncoding): FloatArray {
        return when (encoding) {
            PCMEncoding.PCM_F32LE -> {
                // Handle Float32 PCM data (4 bytes per sample)
                val floatBuffer = ByteBuffer.wrap(pcmData).order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer()
                val floatArray = FloatArray(floatBuffer.remaining())
                floatBuffer.get(floatArray)
                floatArray
            }
            PCMEncoding.PCM_S16LE -> {
                // Handle Int16 PCM data (2 bytes per sample)
                val shortBuffer = ByteBuffer.wrap(pcmData).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
                val shortArray = ShortArray(shortBuffer.remaining())
                shortBuffer.get(shortArray)
                // Convert Int16 samples to normalized Float32 (-1.0 to 1.0)
                FloatArray(shortArray.size) { index -> shortArray[index] / 32768.0f }
            }
        }
    }
    
    private fun removeRIFFHeaderIfNeeded(audioData: ByteArray): ByteArray {
        val headerSize = 44
        val riffHeader = "RIFF".toByteArray(Charsets.US_ASCII)

        return if (audioData.size > headerSize && audioData.startsWith(riffHeader)) {
            audioData.copyOfRange(headerSize, audioData.size)
        } else {
            audioData
        }
    }

    private fun ByteArray.startsWith(prefix: ByteArray): Boolean {
        if (this.size < prefix.size) return false
        return prefix.contentEquals(this.sliceArray(prefix.indices))
    }

    /**
     * Updates the sound configuration
     * @param newConfig The new configuration to apply
     * @param promise Promise to resolve when configuration is updated
     */
    fun updateConfig(newConfig: SoundConfig, promise: Promise) {
        Log.d("ExpoPlayStreamModule", "Updating sound configuration - sampleRate: ${newConfig.sampleRate}, playbackMode: ${newConfig.playbackMode}")
        
        // Skip if configuration hasn't changed
        if (newConfig.sampleRate == config.sampleRate && newConfig.playbackMode == config.playbackMode) {
            Log.d("ExpoPlayStreamModule", "Configuration unchanged, skipping update")
            promise.resolve(null)
            return
        }
        
        // Save current playback state
        val wasPlaying = isPlaying
        
        // Step 1: Pause audio and cancel jobs (but don't close channels)
        pauseAudioAndJobs()
        
        // Step 2: Update configuration
        config = newConfig
        
        // Step 3: Create new AudioTrack with updated config
        initializeAudioTrack()
        
        // Step 4: Restart playback if it was active before
        if (wasPlaying) {
            restartPlayback()
        }
        
        promise.resolve(null)
    }
    
    /**
     * Pauses audio without touching the jobs or channels
     */
    private fun pauseAudioAndJobs() {
        if (isPlaying) {
            Log.d("ExpoPlayStreamModule", "Pausing audio before config update")
            
            try {
                // Pause and flush audio track
                if (::audioTrack.isInitialized && audioTrack.state != AudioTrack.STATE_UNINITIALIZED) {
                    try {
                        audioTrack.pause()
                        try {
                            audioTrack.flush()
                        } catch (e: Exception) {
                            Log.e("ExpoPlayStreamModule", "Error flushing AudioTrack in pauseAudioAndJobs: ${e.message}", e)
                            // Continue with other operations
                        }
                        Log.d("ExpoPlayStreamModule", "Audio paused, playback job left running")
                    } catch (e: Exception) {
                        Log.e("ExpoPlayStreamModule", "Error pausing AudioTrack: ${e.message}", e)
                    }
                } else {
                    Log.d("ExpoPlayStreamModule", "AudioTrack not initialized or in invalid state, skipping pause/flush")
                }
                
                // Update state
                isPlaying = false
                
                // Note: We don't cancel any jobs anymore
                // The playback loop will continue running but won't process chunks due to isPlaying being false
                // This avoids any issues with channels being closed when cancelling jobs
            } catch (e: Exception) {
                Log.e("ExpoPlayStreamModule", "Error pausing AudioTrack: ${e.message}", e)
            }
        }
        
        // Release AudioTrack
        if (::audioTrack.isInitialized) {
            try {
                Log.d("ExpoPlayStreamModule", "Releasing AudioTrack")
                if (audioTrack.state != AudioTrack.STATE_UNINITIALIZED) {
                    audioTrack.release()
                }
            } catch (e: Exception) {
                Log.e("ExpoPlayStreamModule", "Error releasing AudioTrack: ${e.message}", e)
            }
        }
    }
    
    /**
     * Restarts playback with the new AudioTrack
     */
    private fun restartPlayback() {
        try {
            Log.d("ExpoPlayStreamModule", "Restarting playback")
            
            // Start AudioTrack
            if (::audioTrack.isInitialized && audioTrack.state != AudioTrack.STATE_UNINITIALIZED) {
                try {
                    audioTrack.play()
                    isPlaying = true
                } catch (e: Exception) {
                    Log.e("ExpoPlayStreamModule", "Error starting AudioTrack: ${e.message}", e)
                    isPlaying = false
                    return
                }
            } else {
                Log.e("ExpoPlayStreamModule", "AudioTrack not initialized or in invalid state, cannot restart playback")
                return
            }
            
            // The playback loop is already running, we just need to set isPlaying to true
            // Only start a new loop if the current one doesn't exist
            if (currentPlaybackJob == null || currentPlaybackJob?.isActive != true) {
                Log.d("ExpoPlayStreamModule", "Starting new playback loop")
                startPlaybackLoop()
            } else {
                Log.d("ExpoPlayStreamModule", "Using existing playback loop")
            }
            
            // Ensure processing loop is running
            ensureProcessingLoopStarted()
        } catch (e: Exception) {
            Log.e("ExpoPlayStreamModule", "Error restarting playback: ${e.message}", e)
        }
    }
    
    /**
     * Resets the sound configuration to default values
     * @param promise Promise to resolve when configuration is reset
     */
    fun resetConfigToDefault(promise: Promise) {
        Log.d("ExpoPlayStreamModule", "Resetting sound configuration to default values")
        updateConfig(SoundConfig.DEFAULT, promise)
    }

    companion object {
        // Public constant for suspending sound events
        public const val SUSPEND_SOUND_EVENT_TURN_ID: String = "suspend-sound-events"
    }
}