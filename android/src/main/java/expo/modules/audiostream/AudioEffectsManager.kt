package expo.modules.audiostream

import android.media.AudioRecord
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.util.Log

/**
 * Manages hardware audio effects for voice recording.
 *
 * We use VOICE_RECOGNITION as our audio source. The Android CDD (Section 5.4)
 * mandates that this source delivers unprocessed audio:
 *   [C-1-2] MUST disable noise reduction by default
 *   [C-1-3] MUST disable automatic gain control by default
 *
 * NS and AGC are therefore off by default to honor the spec. Enabling them
 * re-introduces the processing the CDD explicitly prohibits for this source
 * and can cause low-volume capture on many OEMs.
 *
 * AEC is the one effect the CDD permits for VOICE_RECOGNITION ("expects a
 * stream that has an echo cancellation effect if available"), so it is
 * enabled by default.
 */
class AudioEffectsManager(
    /** Enable hardware noise suppressor. Default false — CDD 5.4 [C-1-2] prohibits it for VOICE_RECOGNITION. */
    private val enableNS: Boolean = false,
    /** Enable hardware AGC. Default false — CDD 5.4 [C-1-3] prohibits it for VOICE_RECOGNITION. */
    private val enableAGC: Boolean = false
) {
    // Audio effects
    private var acousticEchoCanceler: AcousticEchoCanceler? = null
    private var noiseSuppressor: NoiseSuppressor? = null
    private var automaticGainControl: AutomaticGainControl? = null

    /**
     * Sets up audio effects for the provided AudioRecord instance
     * @param audioRecord The AudioRecord instance to apply effects to
     */
    fun setupAudioEffects(audioRecord: AudioRecord) {
        val audioSessionId = audioRecord.audioSessionId
        
        // Release any existing effects first
        releaseAudioEffects()
        
        try {
            // Log availability of audio effects
            Log.d(Constants.TAG, "AEC available: ${AcousticEchoCanceler.isAvailable()}")
            Log.d(Constants.TAG, "NS available: ${NoiseSuppressor.isAvailable()}")
            Log.d(Constants.TAG, "AGC available: ${AutomaticGainControl.isAvailable()}")
            
            // Apply echo cancellation if available
            if (AcousticEchoCanceler.isAvailable()) {
                acousticEchoCanceler = AcousticEchoCanceler.create(audioSessionId)
                acousticEchoCanceler?.enabled = true
                Log.d(Constants.TAG, "Acoustic Echo Canceler enabled: ${acousticEchoCanceler?.enabled}")
            }
            
            // NS off by default — CDD 5.4 [C-1-2] prohibits it for VOICE_RECOGNITION.
            // Enabling it can aggressively attenuate speech on many OEMs.
            if (enableNS) {
                enableNoiseSuppression(audioSessionId)
            } else {
                Log.d(Constants.TAG, "Noise Suppressor skipped (CDD 5.4 [C-1-2])")
            }

            // AGC off by default — CDD 5.4 [C-1-3] prohibits it for VOICE_RECOGNITION.
            // Hardware AGC is also unreliable across devices.
            if (enableAGC) {
                enableAutomaticGainControl(audioSessionId)
            } else {
                Log.d(Constants.TAG, "Hardware AGC skipped (CDD 5.4 [C-1-3])")
            }
            
        } catch (e: Exception) {
            Log.e(Constants.TAG, "Error setting up audio effects", e)
        }
    }

    /**
     * Enables Noise Suppression if available for the given audio session.
     * @param audioSessionId The audio session ID to apply the effect to.
     */
    private fun enableNoiseSuppression(audioSessionId: Int) {
        // Apply noise suppression if available
        if (NoiseSuppressor.isAvailable()) {
            noiseSuppressor = NoiseSuppressor.create(audioSessionId)
            noiseSuppressor?.enabled = true
            Log.d(Constants.TAG, "Noise Suppressor enabled: ${noiseSuppressor?.enabled}")
        }
    }

    /**
     * Enables Automatic Gain Control if available for the given audio session.
     * @param audioSessionId The audio session ID to apply the effect to.
     */
    private fun enableAutomaticGainControl(audioSessionId: Int) {
        // Apply automatic gain control if available
        if (AutomaticGainControl.isAvailable()) {
            automaticGainControl = AutomaticGainControl.create(audioSessionId)
            automaticGainControl?.enabled = true
            Log.d(Constants.TAG, "Automatic Gain Control enabled: ${automaticGainControl?.enabled}")
        }
    }

    /**
     * Releases all audio effects
     */
    fun releaseAudioEffects() {
        try {
            acousticEchoCanceler?.let {
                if (it.enabled) it.enabled = false
                it.release()
                acousticEchoCanceler = null
            }
            
            noiseSuppressor?.let {
                if (it.enabled) it.enabled = false
                it.release()
                noiseSuppressor = null
            }
            
            automaticGainControl?.let {
                if (it.enabled) it.enabled = false
                it.release()
                automaticGainControl = null
            }
        } catch (e: Exception) {
            Log.e(Constants.TAG, "Error releasing audio effects", e)
        }
    }
} 