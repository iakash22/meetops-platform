Pod::Spec.new do |s|
  s.name           = 'LiveActivity'
  s.version        = '0.1.0'
  s.summary        = 'MeetOps recording Live Activity / Dynamic Island bridge (ActivityKit).'
  s.description    = 'Local Expo module of apps/mobile: starts, updates and ends the in-progress recording Live Activity and forwards its Stop action to JS. The widget UI lives in apps/mobile/targets/RecordingLiveActivity.'
  s.author         = 'MeetOps (iakash22)'
  s.homepage       = 'https://github.com/iakash22/meetops-platform'
  s.license        = 'UNLICENSED' # private repo (root package.json "private": true) with no LICENSE file
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => 'https://github.com/iakash22/meetops-platform.git' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.weak_frameworks = 'ActivityKit'
  s.source_files = '**/*.swift'
end
