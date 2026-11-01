Pod::Spec.new do |s|
  s.name           = 'ChunkCrypto'
  s.version        = '0.1.0'
  s.summary        = 'AES-256-GCM for MeetOps chunk files with a Keychain-held key (CryptoKit).'
  s.author         = 'MeetOps'
  s.homepage       = 'https://example.invalid/meetops'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'CryptoKit', 'Security'
  s.source_files   = '**/*.swift'
end
