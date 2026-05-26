import withRecordingPermission from '../index'

describe('withRecordingPermission', () => {
  it('adds mic usage description and audio background mode to Info.plist', async () => {
    const config: any = { name: 'test', slug: 'test' }

    // Calling the plugin registers an async Info.plist mod under
    // result.mods.ios.infoPlist. Invoking that mod with a blank modResults
    // runs only the plugin's transform (it does not read the filesystem).
    const result: any = withRecordingPermission(config, {
      microphonePermission: 'Mic please',
    })

    const infoPlistMod = result.mods.ios.infoPlist
    const applied: any = await infoPlistMod({
      ...result,
      modResults: {},
      modRequest: {},
    })

    expect(applied.modResults.NSMicrophoneUsageDescription).toBeDefined()
    expect(applied.modResults.UIBackgroundModes).toContain('audio')
  })
})
