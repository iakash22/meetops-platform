/* global module, require, __dirname */
/**
 * iOS Live Activity / Dynamic Island for an in-progress recording (plan.md "iOS background audio", R2).
 * - Info.plist: `NSSupportsLiveActivities = YES`. No `NSSupportsLiveActivitiesFrequentUpdates` (updates are
 *   local, on start / pause / resume / stop only) and no push token, so no APNs or other entitlement is needed.
 * - Copies `targets/RecordingLiveActivity` into `ios/RecordingLiveActivity` and adds a WidgetKit app-extension
 *   target (embedded in the app, iOS 16.2+) with bundle id `<app bundle id>.RecordingLiveActivity`.
 * The app side (ActivityKit calls, Stop intent) is the `modules/live-activity` Expo module.
 * Idempotent: running prebuild twice doesn't add a second target.
 */
const fs = require('fs');
const path = require('path');
const {
  IOSConfig,
  withDangerousMod,
  withInfoPlist,
  withXcodeProject,
} = require('expo/config-plugins');

const TARGET = 'RecordingLiveActivity';
const DEPLOYMENT_TARGET = '16.2';
const SOURCE_DIR = path.join(__dirname, '..', 'targets', TARGET);
const INTENT_FILE = 'StopRecordingIntent.swift';
const SWIFT_FILES = [
  'RecordingActivityAttributes.swift',
  'RecordingLiveActivityBundle.swift',
  'RecordingLiveActivityWidget.swift',
  INTENT_FILE,
];

function setInfoPlist(plist) {
  plist.NSSupportsLiveActivities = true;
  return plist;
}

function copyTargetFiles(iosRoot) {
  const dest = path.join(iosRoot, TARGET);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of [...SWIFT_FILES, 'Info.plist'])
    fs.copyFileSync(path.join(SOURCE_DIR, f), path.join(dest, f));
  return dest;
}

const quoted = (v) => `"${v}"`;
const unquote = (v) => String(v || '').replace(/^"|"$/g, '');

/** The widget target in the project, matched with or without quotes (the xcode lib quotes some names). */
function findWidgetTarget(project) {
  const section = project.pbxNativeTargetSection();
  for (const key of Object.keys(section)) {
    const t = section[key];
    if (typeof t === 'object' && unquote(t.name) === TARGET) return t;
  }
  return null;
}

/** The xcode lib leaves `key = undefined` on file references it creates; Xcode would read them as strings. */
function dropUndefined(project) {
  const refs = project.pbxFileReferenceSection();
  for (const key of Object.keys(refs)) {
    const ref = refs[key];
    if (typeof ref !== 'object') continue;
    for (const k of Object.keys(ref)) if (ref[k] === undefined) delete ref[k];
  }
}

/** Adds the widget extension target to an `xcode` pbxProject. Returns false when it already exists. */
function addWidgetTarget(project, appBundleId) {
  if (findWidgetTarget(project)) return false;
  // pbxGroupByName needs these sections even in a fresh project.
  const objects = project.hash.project.objects;
  objects.PBXTargetDependency = objects.PBXTargetDependency || {};
  objects.PBXContainerItemProxy = objects.PBXContainerItemProxy || {};

  const bundleId = `${appBundleId}.${TARGET}`;
  const target = project.addTarget(TARGET, 'app_extension', TARGET, bundleId);

  const group = project.addPbxGroup([...SWIFT_FILES, 'Info.plist'], TARGET, TARGET);
  const mainGroup = project.getFirstProject().firstProject.mainGroup;
  project.addToPbxGroup(group.uuid, mainGroup);

  project.addBuildPhase(SWIFT_FILES, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
  project.addBuildPhase([], 'PBXResourcesBuildPhase', 'Resources', target.uuid);
  project.addBuildPhase(
    ['WidgetKit.framework', 'SwiftUI.framework', 'ActivityKit.framework'],
    'PBXFrameworksBuildPhase',
    'Frameworks',
    target.uuid,
  );

  const configs = project.pbxXCBuildConfigurationSection();
  const listId = target.pbxNativeTarget.buildConfigurationList;
  const list = project.pbxXCConfigurationList()[listId];
  for (const ref of list.buildConfigurations) {
    const s = configs[ref.value].buildSettings;
    Object.assign(s, {
      PRODUCT_NAME: quoted('$(TARGET_NAME)'),
      PRODUCT_BUNDLE_IDENTIFIER: quoted(bundleId),
      INFOPLIST_FILE: quoted(`${TARGET}/Info.plist`),
      IPHONEOS_DEPLOYMENT_TARGET: DEPLOYMENT_TARGET,
      SWIFT_VERSION: '5.0',
      TARGETED_DEVICE_FAMILY: quoted('1'),
      CODE_SIGN_STYLE: 'Automatic',
      SKIP_INSTALL: 'YES',
      GENERATE_INFOPLIST_FILE: 'NO',
      MARKETING_VERSION: '0.0.0',
      CURRENT_PROJECT_VERSION: '1',
      LD_RUNPATH_SEARCH_PATHS: quoted(
        '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks',
      ),
    });
  }
  dropUndefined(project);
  return true;
}

/**
 * Adds StopRecordingIntent.swift to the app target too (copied into `<app>/`), so Xcode extracts its App Intents
 * metadata from the app and the iOS 17 Stop button's `perform()` runs in the app process. Idempotent.
 */
function addIntentToAppTarget(project, appName) {
  const target = project.getFirstTarget();
  const filepath = `${appName}/${INTENT_FILE}`;
  const refs = project.pbxFileReferenceSection();
  const exists = Object.keys(refs).some(
    (k) => typeof refs[k] === 'object' && unquote(refs[k].path) === filepath,
  );
  if (exists) return false;
  // Same helper Expo uses for app sources: puts the file in the `<app>` group (created if missing) and the app
  // target's Sources phase.
  IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
    filepath,
    groupName: appName,
    project,
    targetUuid: target.uuid,
  });
  dropUndefined(project);
  return true;
}

function copyIntentToApp(iosRoot, appName) {
  const dest = path.join(iosRoot, appName);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(SOURCE_DIR, INTENT_FILE), path.join(dest, INTENT_FILE));
}

function withLiveActivity(config) {
  config = withInfoPlist(config, (c) => {
    c.modResults = setInfoPlist(c.modResults);
    return c;
  });
  config = withDangerousMod(config, [
    'ios',
    (c) => {
      copyTargetFiles(c.modRequest.platformProjectRoot);
      copyIntentToApp(c.modRequest.platformProjectRoot, c.modRequest.projectName);
      return c;
    },
  ]);
  config = withXcodeProject(config, (c) => {
    const bundleId = c.ios && c.ios.bundleIdentifier;
    if (!bundleId) throw new Error('withLiveActivity: ios.bundleIdentifier is required.');
    addWidgetTarget(c.modResults, bundleId);
    addIntentToAppTarget(c.modResults, c.modRequest.projectName);
    return c;
  });
  return config;
}

module.exports = withLiveActivity;
module.exports.TARGET = TARGET;
module.exports.SWIFT_FILES = SWIFT_FILES;
module.exports.setInfoPlist = setInfoPlist;
module.exports.addWidgetTarget = addWidgetTarget;
module.exports.findWidgetTarget = findWidgetTarget;
module.exports.addIntentToAppTarget = addIntentToAppTarget;
module.exports.INTENT_FILE = INTENT_FILE;
module.exports.copyTargetFiles = copyTargetFiles;
