Pod::Spec.new do |s|
  s.name = 'T3PushConfig'
  s.version = '1.0.0'
  s.summary = 'Self-hosted push credential baked into the T3 Code binary.'
  s.author = 'T3 Tools'
  s.homepage = 'https://t3tools.com'
  s.platform = :ios, '16.1'
  s.source = { :path => '.' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
end
