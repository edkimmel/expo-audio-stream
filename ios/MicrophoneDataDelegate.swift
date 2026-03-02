protocol MicrophoneDataDelegate: AnyObject {
    func onMicrophoneData(_ microphoneData: Data, _ soundLevel: Float?)
    func onMicrophoneError(_ error: String, _ errorMessage: String)
}
