Pod::Spec.new do |s|
  s.name           = 'BackupExclusion'
  s.version        = '0.1.0'
  s.summary        = 'Marks MeetOps audio folders NSURLIsExcludedFromBackupKey.'
  s.author         = 'MeetOps'
  s.homepage       = 'https://example.invalid/meetops'
  s.license        = { :type => 'UNLICENSED' }
  s.platforms      = { :ios => '15.1' }
  s.source         = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '**/*.swift'
end
