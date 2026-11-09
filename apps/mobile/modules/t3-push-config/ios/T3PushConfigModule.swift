import ExpoModulesCore
import Foundation

public class T3PushConfigModule: Module {
  public func definition() -> ModuleDefinition {
    Name("T3PushConfig")

    // Written by plugins/withT3PushConfig.cjs at prebuild; never part of the JS config or bundle.
    Constants([
      "url": Bundle.main.object(forInfoDictionaryKey: "T3PushURL") as? String,
      "token": Bundle.main.object(forInfoDictionaryKey: "T3PushToken") as? String,
    ])
  }
}
