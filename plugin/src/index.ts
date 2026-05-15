import {
    AndroidConfig,
    ConfigPlugin,
    withAndroidManifest,
    withInfoPlist,
} from '@expo/config-plugins'

const MICROPHONE_USAGE = 'Allow $(PRODUCT_NAME) to access your microphone'
// AVFoundation enumerates AirPlay/Continuity audio devices on the local network
// even though we don't use them — without this description, iOS shows a generic
// prompt and a denial leaves the audio session unable to activate.
const LOCAL_NETWORK_USAGE = 'Allow $(PRODUCT_NAME) to discover audio devices on your local network'

const withRecordingPermission: ConfigPlugin<{
    microphonePermission: string
}> = (config, existingPerms) => {
    if (!existingPerms) {
        console.warn('No previous permissions provided')
    }
    config = withInfoPlist(config, (config) => {
        config.modResults['NSMicrophoneUsageDescription'] = config.modResults['NSMicrophoneUsageDescription'] || MICROPHONE_USAGE
        config.modResults['NSLocalNetworkUsageDescription'] = config.modResults['NSLocalNetworkUsageDescription'] || LOCAL_NETWORK_USAGE

        // Add audio to UIBackgroundModes to allow background audio recording
        const existingBackgroundModes =
            config.modResults.UIBackgroundModes || []
        if (!existingBackgroundModes.includes('audio')) {
            existingBackgroundModes.push('audio')
        }
        config.modResults.UIBackgroundModes = existingBackgroundModes

        return config
    })

    config = withAndroidManifest(config, (config) => {
        const mainApplication =
            AndroidConfig.Manifest.getMainApplicationOrThrow(config.modResults)

        AndroidConfig.Manifest.addMetaDataItemToMainApplication(
            mainApplication,
            'android.permission.RECORD_AUDIO',
            MICROPHONE_USAGE
        )

        // Add FOREGROUND_SERVICE permission for handling background recording
        AndroidConfig.Manifest.addMetaDataItemToMainApplication(
            mainApplication,
            'android.permission.FOREGROUND_SERVICE',
            'This apps needs access to the foreground service to record audio in the background'
        )

        return config
    })

    return config
}

export default withRecordingPermission
