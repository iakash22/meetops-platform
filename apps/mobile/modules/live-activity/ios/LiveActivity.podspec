Pod::Spec.new do |s|
  s.name           = 'LiveActivity'
  s.version        = '0.1.0'
  s.summary        = 'MeetOps recording Live Activity / Dynamic Island bridge (ActivityKit).'
  s.author         = 'MeetOps'
  s.homepage       = 'https://example.invalid/meetops'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks     = 'ActivityKit'
  s.weak_frameworks = 'ActivityKit', 'AppIntents'
  s.source_files = '**/*.swift'
end
