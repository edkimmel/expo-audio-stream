package expo.modules.audiostream

import android.app.Activity
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.util.Log
import java.util.concurrent.atomic.AtomicInteger

/**
 * Owns Android communication-mode lifecycle and output device routing for
 * hands-free voice sessions (microphone + speaker playback with AEC).
 *
 * Responsibilities:
 *   - Set MODE_IN_COMMUNICATION before AudioRecord starts so the HAL echo
 *     reference path is active when AcousticEchoCanceler initializes.
 *   - Route output to the best available device: Bluetooth HFP > wired headset
 *     > built-in speaker. Re-routes automatically when devices connect or
 *     disconnect.
 *   - Bind hardware volume buttons to STREAM_VOICE_CALL while a session is
 *     active so the user's volume buttons control playback volume.
 *   - Reset everything when all callers have stopped so the phone's audio
 *     state is clean.
 *
 * Reference-counted: mic and pipeline each call startSession/stopSession
 * independently. Communication mode stays active until both have stopped.
 *
 * Usage:
 *   cam.startSession(activity)  // call before AudioRecord.startRecording() or pipeline connect
 *   cam.onDeviceChanged()       // call from AudioDeviceCallback
 *   cam.stopSession(activity)   // call after AudioRecord.stop() or pipeline disconnect
 */
class CommunicationAudioManager(private val audioManager: AudioManager) {

    private val refCount = AtomicInteger(0)

    private val sessionActive get() = refCount.get() > 0

    /**
     * Start (or join) a voice session. Safe to call from multiple owners —
     * communication mode is activated on the first call.
     * Pass the current Activity so volume buttons bind to STREAM_VOICE_CALL.
     */
    fun startSession(activity: Activity? = null) {
        if (refCount.getAndIncrement() == 0) {
            audioManager.mode = AudioManager.MODE_IN_COMMUNICATION
            activity?.volumeControlStream = AudioManager.STREAM_VOICE_CALL
            Log.d(TAG, "Session started — MODE_IN_COMMUNICATION")
        }
        applyBestRoute()
    }

    /**
     * Release this owner's hold on the session. Communication mode is reset
     * only when all owners have called stopSession.
     * No-op if the session was already ended via forceReset.
     */
    fun stopSession(activity: Activity? = null) {
        // Decrement only if currently positive — prevents post-forceReset calls
        // from re-triggering cleanup (getAndUpdate returns the previous value).
        val prev = refCount.getAndUpdate { if (it > 0) it - 1 else 0 }
        if (prev <= 0) {
            Log.d(TAG, "stopSession — already stopped, no-op")
            return
        }
        val remaining = prev - 1
        if (remaining == 0) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                audioManager.clearCommunicationDevice()
            } else {
                @Suppress("DEPRECATION")
                audioManager.stopBluetoothSco()
                @Suppress("DEPRECATION")
                audioManager.isSpeakerphoneOn = false
            }
            audioManager.mode = AudioManager.MODE_NORMAL
            activity?.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
            Log.d(TAG, "Session ended — audio mode reset to NORMAL")
        } else {
            Log.d(TAG, "stopSession — $remaining owner(s) still active")
        }
    }

    /**
     * Re-evaluate and apply the best available output route.
     * Call this from AudioDeviceCallback whenever devices are added or removed.
     */
    fun onDeviceChanged() {
        applyBestRoute()
    }

    /**
     * Unconditionally reset all communication audio state regardless of ref count.
     * Use in OnDestroy and explicit destroy flows where normal lifecycle won't run.
     */
    fun forceReset(activity: Activity? = null) {
        refCount.set(0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            audioManager.clearCommunicationDevice()
        } else {
            @Suppress("DEPRECATION")
            audioManager.stopBluetoothSco()
            @Suppress("DEPRECATION")
            audioManager.isSpeakerphoneOn = false
        }
        audioManager.mode = AudioManager.MODE_NORMAL
        activity?.volumeControlStream = AudioManager.USE_DEFAULT_STREAM_TYPE
        Log.d(TAG, "forceReset — audio mode reset to NORMAL")
    }

    // ── Private ─────────────────────────────────────────────────────────────

    private fun applyBestRoute() {
        if (!sessionActive) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            applyBestRouteApi31()
        } else {
            applyBestRouteLegacy()
        }
    }

    private fun applyBestRouteApi31() {
        val devices = audioManager.availableCommunicationDevices
        // Priority: BT HFP > wired headset > built-in speaker
        val preferred = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
            ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET }
            ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_SPEAKER }
        if (preferred != null) {
            audioManager.setCommunicationDevice(preferred)
            Log.d(TAG, "Route → ${preferred.productName} (type=${preferred.type})")
        } else {
            Log.w(TAG, "No suitable communication device found")
        }
    }

    @Suppress("DEPRECATION")
    private fun applyBestRouteLegacy() {
        // Detect a connected BT HFP device via the full device list (API 23+).
        val allDevices = audioManager.getDevices(AudioManager.GET_DEVICES_ALL)
        val btSco = allDevices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
        if (btSco != null) {
            audioManager.startBluetoothSco()
            audioManager.isSpeakerphoneOn = false
            Log.d(TAG, "Route → Bluetooth SCO (${btSco.productName})")
        } else {
            audioManager.stopBluetoothSco()
            audioManager.isSpeakerphoneOn = true
            Log.d(TAG, "Route → built-in speaker")
        }
    }

    companion object {
        private const val TAG = "CommunicationAudioMgr"
    }
}
