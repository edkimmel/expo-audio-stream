protocol MicrophoneDataDelegate: AnyObject {
    func onMicrophoneData(_ microphoneData: Data, _ soundLevel: Float?, _ frequencyBands: FrequencyBands?)
    func onMicrophoneError(_ error: String, _ errorMessage: String)
}
