const { withInfoPlist } = require("expo/config-plugins");

// Read at prebuild, not passed as plugin props or expo.extra: those are republished in every
// update manifest, while the Info.plist only ships inside the signed binary.
module.exports = function withT3PushConfig(config) {
  const url = process.env.T3CODE_PUSH_URL?.trim();
  const token = process.env.T3CODE_PUSH_TOKEN?.trim();
  if (!url || !token) return config;
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults.T3PushURL = url;
    modConfig.modResults.T3PushToken = token;
    return modConfig;
  });
};
