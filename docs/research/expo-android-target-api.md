# Expo SDK 54–56 Android target API and Google Play's target-API rule

- Checked: **2026-11-18 (IST)**. Repo facts are from `integration/phase-1` at `14361406` (merge of #521). Every
  source row gives the date we fetched it and the page's own date where it shows one.
- **Nothing was built, submitted or changed in code or config.** No Play Console, EAS or Expo account was opened. No
  one was contacted.
- Labels:
  - **PROPOSAL** means a suggestion that hasn't been decided.
  - **ESTIMATE** means our own number or date.
  - **INFERRED** means our reading, not stated by the source.
  - **UNVERIFIED** means we couldn't confirm it. A build claim stays UNVERIFIED until a real build.
- Store policy is summarised from Google's and Apple's own pages. This is not legal advice.

## 1. Summary

1. **Expo SDK 54 already targets Android API 36 by default.** So do SDK 55 and SDK 56.
   - Evidence: Expo's versions table [E1, E2], React Native's version catalog for each SDK's RN [E8–E10], and the
     Expo Gradle plugin that reads that catalog [E5, E6].
   - The SDK 54 release notes say: "React Native for Android now targets Android 16 / API 36" [E11].
2. **Google Play has required API 36 for new apps and app updates since 31 Aug 2026.** The extension option ran to
   1 Nov 2026, so it has expired [G1, G2].
3. **SDK 54 is the last SDK with the Legacy Architecture.** SDK 55 removed it, and `newArchEnabled` is gone from the
   app config [E11, E12, E15].
4. **Conclusion (INFERRED, §5):** the reported decision (SDK 54 next, on the Legacy Architecture) is store-safe for
   Play new submissions and updates today, with no target override. It stays safe until Google raises the target
   above 36.
   - Google has announced no later level as of 2026-11-18.
   - ESTIMATE from the page's yearly rows: API 37 around 31 Aug 2027.
   - Apple's yearly Xcode minimum may bind earlier.
   - Any move after SDK 54 means the New Architecture (SDK 55 or later).
5. **Corrections:** two repo claims are wrong.
   - `capture-platform-policy.md` §6.1 says "Expo SDK 56 and later target 36".
   - `phase-2-roadmap.md` C1 says it's UNVERIFIED whether SDK 55 targets 36.
   - Dated notes in this PR correct both (§6).

## 2. Expo SDK defaults (Android)

| SDK | Expo (`sdk-*` dist-tag, 2026-11-18) | React Native | minSdk | compileSdk | targetSdk | Legacy Architecture                               | Xcode min (Expo table) | Sources                |
| --- | ----------------------------------- | ------------ | ------ | ---------- | --------- | ------------------------------------------------- | ---------------------- | ---------------------- |
| 52  | 52.0.49 (the repo)                  | 0.76.9       | 24     | 35         | **34**    | Default off (`newArchEnabled=false`)              | 16 (16.1 recommended)  | [E3, E7], capture §6.1 |
| 54  | 54.0.38                             | 0.81.5       | 24     | 36         | **36**    | Supported, last SDK with it; template default on  | 16.1+                  | [E1–E6, E8, E11, E14]  |
| 55  | 55.0.32                             | 0.83.10      | 24     | 36         | **36**    | Removed; `newArchEnabled` dropped from app config | 26.2+                  | [E1, E2, E9, E12]      |
| 56  | 56.0.24                             | 0.85.3       | 24     | 36         | **36**    | Removed                                           | 26.4+                  | [E2, E10, E13]         |

How the default is set, per SDK tag:

- **SDK 52:** the template `android/build.gradle` sets `targetSdkVersion = findProperty('android.targetSdkVersion') ?:
'34'` and `compileSdkVersion` `?: '35'` (L6–8) [E3]. RN 0.76.9's catalog also says target 34 / compile 35 [E7].
- **SDK 54, 55 and 56:** the template applies the `expo-root-project` plugin (L23) [E4]. `ExpoRootProjectPlugin.kt`
  (L27–31) takes `minSdk`, `compileSdk` and `targetSdk` from the `expoLibs` version catalog, falling back to 24 / 35 /
  35 only when the catalog has no value [E5].
  - `settings.gradle` L36 calls `expoAutolinking.useExpoVersionCatalog()` [E4].
  - That builds `expoLibs` from React Native's `gradle/libs.versions.toml` (`ExpoAutolinkingSettingsExtension.kt`
    L106–125) [E6].
  - RN 0.81.5, 0.83.10 and 0.85.3 all set `targetSdk = "36"` and `compileSdk = "36"` (catalog L3–6) [E8–E10].
- **Expo's versions table** agrees [E1, E2]:
  - SDK 54: 36/36, Xcode 16.1+.
  - SDK 55: 36/36, Xcode 26.2+.
  - SDK 56: 36/36, Xcode 26.4+.
  - On the latest page, SDK 57 is 36/36 and SDK 58 is compileSdk **37**, target **36** [E2b].
- **Template `gradle.properties`:** SDK 52 has `newArchEnabled=false` (L38). SDK 54, 55 and 56 have
  `newArchEnabled=true` (L38) and `edgeToEdgeEnabled=true` (L47) [E4].

## 3. Overriding the target (documented mechanism)

- **`expo-build-properties`** documents `android.compileSdkVersion`, `android.targetSdkVersion` and
  `android.minSdkVersion` as optional numbers that "Override the default … version number in build.gradle" [E16].
  The SDK 54 bundled version is `~1.0.10` [E14].
- **Wiring at `sdk-54`:**
  - The plugin writes these as the Gradle properties `android.minSdkVersion`, `android.compileSdkVersion` and
    `android.targetSdkVersion` (`expo-build-properties/src/android.ts` L37–45) [E17].
  - The autolinking settings plugin maps those properties over the catalog values (`ExpoAutolinkingSettingsExtension.kt`
    L122–125) [E6].
- **Limits:**
  - The config schema accepts any integer for `compileSdkVersion` and `targetSdkVersion` (`pluginConfig.ts` L605–606)
    [E18]. The docs page states no minimum, maximum or compatibility limit [E16].
  - We found no documented limit on setting 36. INFERRED: a target above the RN catalog's compileSdk would also need
    compileSdk raised, and AGP support for it. Neither is documented per SDK.
- **What this means for 36:**
  - On SDK 54 an override to 36 is **not needed**, because 36 is the default. Setting it explicitly would be redundant.
  - On SDK 52, overriding to 36 would also need compileSdk 36 on RN 0.76.9 (catalog compile 35). That combination is
    **undocumented and untested: UNVERIFIED**, and not recommended.

## 4. Google Play target-API rule (fetched 2026-11-18)

- **Current rule, "Starting August 31, 2026":** "New apps and app updates must target Android 16 (API level 36) or
  higher to be submitted to Google Play" [G1, G2]. Lower floors apply to other device types:
  - Wear OS and Android Automotive OS: API 35.
  - Android TV and Android XR: API 34.
- **The page's table** lists two rows [G1]:
  - API 36: new apps 31 Aug 2026, app updates 31 Aug 2026.
  - API 35: new apps 31 Aug 2025, app updates 31 Aug 2025.
- **Extension:** "You will be able to request an extension to November 1, 2026" [G1, G2]. As of 2026-11-18 that date
  has passed. INFERRED: no extension is available now under the current rule.
- **Existing apps and installs:**
  - "Existing apps must target Android 15 (API level 35) or higher to remain available to new users on devices running
    Android OS higher than your app's target API level."
  - Apps on API 34 or lower are only available on devices at or below their target.
  - "Users who have previously installed the app from Google Play will not be impacted and will still be able to
    discover, re-install, and use the app" [G1].
- **Definitions:**
  - New app: "not yet published on Google Play".
  - App update: a new version "to replace your existing app".
  - Permanently private, internal-only apps are exempt [G1].
  - MeetOps has no published Play app (INFERRED from `docs/mobile/store-review.md` being a draft), so the first upload
    is a **new app** and needs API 36.
- **Later dates:** neither page lists a requirement above API 36 or any 2027 date [G1, G2].
- **Apple (context for "store-safe"):** apps uploaded to App Store Connect "must be built with Xcode 26 or later using
  an SDK for iOS 26", "Since April 28, 2026" [A1].
  - Expo's minimum for SDK 54 is Xcode 16.1, but its SDK 54 notes say "EAS Build and Workflows will default to using
    Xcode 26 for SDK 54" [E1, E11].
  - INFERRED: SDK 54 on Xcode 26 is a supported path. UNVERIFIED for our app until a build.

## 5. Conclusion

- **Is "SDK 54 next, on the Legacy Architecture" store-safe now?** INFERRED: **yes** for Google Play new submissions and
  updates.
  - SDK 54 defaults to compileSdk 36 and targetSdk 36 (§2), which meets the API 36 rule in force since 31 Aug 2026 (§4).
  - No `expo-build-properties` override is needed. The repo doesn't use one today (`apps/mobile/app.config.ts`).
  - Legacy Architecture is still supported in SDK 54: `newArchEnabled` is a documented app-config field at `sdk-54`
    (`ExpoConfig.ts` L250–252, "Defaults to true"), and it's gone at `sdk-55` [E15, E12].
  - **Note:** this decision isn't recorded in the repo. `docs/plans/expo-rn-upgrade.md` still recommends SDK 55 (L22)
    and marks SDK 54 "does not clear RE-04" (L59). RE-04 closed on 11 Nov (#476), so that reason no longer applies.
- **Until when?**
  - **Play:** until Google enforces a target above 36. As of 2026-11-18 none is announced [G1, G2].
    - ESTIMATE from the yearly pattern on the page (API 35 by 31 Aug 2025; API 36 by 31 Aug 2026): API 37 around
      31 Aug 2027, perhaps with an extension to about 1 Nov 2027. Re-check the page; this is not a Google date.
  - **Apple (may bind first):** the SDK minimum moved to Xcode 26 on 28 Apr 2026 [A1].
    - ESTIMATE: a similar move to Xcode 27 around April 2027.
    - Whether SDK 54 builds on a future Xcode is unknown (UNVERIFIED).
  - **Expo patches:** `expo@54.0.38` (dist-tag `sdk-54`) was published 2026-10-21 per the npm registry. Expo's support
    window for SDK 54 was not checked (UNVERIFIED).
- **When must we move, and to which SDK?**
  - Any SDK after 54 requires the New Architecture [E11, E12]. So the move away from SDK 54 is also the
    New-Architecture migration in `expo-rn-upgrade.md` §3.1 item 1.
  - PROPOSAL: start it well before the earlier of the two estimated store bumps above (about April 2027 for Apple and
    August 2027 for Play), not when forced.
  - **Candidate:** SDK 55 is the smallest New-Architecture step. It stays on Node 20 and iOS 15.1 (plan L69–70) and
    targets 36.
  - **Caveat (INFERRED):** no Expo SDK through 58 (`latest`, `58.0.26`, published 2026-11-17) defaults to target 37.
    SDK 58 compiles against 37 but targets 36 [E2b].
    - If Play moves to 37, we'd need a later SDK that targets 37, or an `expo-build-properties` target override on an
      SDK that compiles 37.
    - The override is the documented mechanism (§3), but untested here: UNVERIFIED.
- **Risks to flag:**
  - **Target 36 behaviour on our native code is UNVERIFIED until a build.** Android 16 forces edge-to-edge (SDK 54
    notes [E11]). Our custom modules haven't been compiled or run at target 36: the foreground service, Keystore
    crypto and the recording module (`docs/mobile/android-device-build-checklist.md`).
  - **Legacy Architecture on SDK 54:** RN froze the Legacy Architecture in 0.80 and removed the opt-out in 0.82 [E11].
    INFERRED: third-party libraries may drop Legacy support, so library pins need checking at upgrade time.
  - **Targeting 36 via override on SDK 54 is a non-issue** (36 is the default).
  - **Overriding SDK 52 to 36 is undocumented and untested** (§3). Not recommended.

## 6. Reconciliation with repo docs (dated notes added in this PR)

| Doc                                                                      | Claim                                                                      | Finding                                                                                              | Change in this PR                |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------- |
| [capture-platform-policy.md](capture-platform-policy.md) §6.1            | "Expo SDK 56 and later target 36 [P7]"                                     | SDK 54 and 55 also target 36 [E1, E2]; P7 only listed SDK 56–58                                      | Dated note after the §6.1 result |
| `docs/plans/expo-rn-upgrade.md`                                          | Recommends SDK 55; SDK 54 "does not clear RE-04"; no Android target stated | SDK 54 and 55 both meet API 36; RE-04 is closed; SDK 54 is the last SDK with the Legacy Architecture | Dated note under the header      |
| [phase-2-roadmap.md](phase-2-roadmap.md) C1, D17, X2                     | UNVERIFIED whether SDK 55 targets 36; D17 option "56+ per capture §6.1"    | Settled: 54, 55 and 56 target 36                                                                     | Dated notes (#521 has merged)    |
| F3 in [capture-platform-policy.md](capture-platform-policy.md#1-summary) | Confirmed gap on SDK 52 (target 34)                                        | Still true for the repo today (`expo@52.0.49`)                                                       | None                             |

## 7. Sources (all fetched 2026-11-18 IST)

| ID  | Source                                                                                                                                                                                                                 |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | Expo docs, SDK 55 versions page (rows 53–55): https://docs.expo.dev/versions/v55.0.0/ (`/versions/v54.0.0/` redirects to `/latest/`)                                                                                   |
| E2  | Expo docs, SDK 56 versions page (rows 54–56): https://docs.expo.dev/versions/v56.0.0/                                                                                                                                  |
| E2b | Expo docs, latest versions page (rows 56–58): https://docs.expo.dev/versions/latest/                                                                                                                                   |
| E3  | expo/expo `sdk-52`, `templates/expo-template-bare-minimum/android/build.gradle` L6–8 and `gradle.properties` L38: https://github.com/expo/expo/tree/sdk-52/templates/expo-template-bare-minimum/android                |
| E4  | expo/expo `sdk-54`/`sdk-55`/`sdk-56`, same template: `build.gradle` L23, `settings.gradle` L36, `gradle.properties` L38 and L47: https://github.com/expo/expo/tree/sdk-54/templates/expo-template-bare-minimum/android |
| E5  | expo/expo `sdk-54`/`sdk-55`/`sdk-56`, `packages/expo-modules-autolinking/android/expo-gradle-plugin/expo-autolinking-plugin/src/main/kotlin/expo/modules/plugin/ExpoRootProjectPlugin.kt` L27–31                       |
| E6  | expo/expo `sdk-54`, `packages/expo-modules-autolinking/android/expo-gradle-plugin/expo-autolinking-settings-plugin/src/main/kotlin/expo/modules/plugin/ExpoAutolinkingSettingsExtension.kt` L106–125                   |
| E7  | facebook/react-native `v0.76.9`, `packages/react-native/gradle/libs.versions.toml` L3–6: https://github.com/facebook/react-native/blob/v0.76.9/packages/react-native/gradle/libs.versions.toml                         |
| E8  | facebook/react-native `v0.81.5`, same file L3–6                                                                                                                                                                        |
| E9  | facebook/react-native `v0.83.10`, same file L3–6                                                                                                                                                                       |
| E10 | facebook/react-native `v0.85.3`, same file L3–6                                                                                                                                                                        |
| E11 | Expo changelog, "Expo SDK 54" (Sep 10, 2025): https://expo.dev/changelog/sdk-54                                                                                                                                        |
| E12 | Expo changelog, "Expo SDK 55" (Feb 25, 2026): https://expo.dev/changelog/sdk-55                                                                                                                                        |
| E13 | Expo changelog, "Expo SDK 56" (May 21, 2026): https://expo.dev/changelog/sdk-56                                                                                                                                        |
| E14 | expo/expo `sdk-54`/`sdk-55`/`sdk-56`, `packages/expo/bundledNativeModules.json` (`react-native`, `expo-build-properties`) and `packages/expo/package.json`                                                             |
| E15 | expo/expo `sdk-54`, `packages/@expo/config-types/src/ExpoConfig.ts` L250–252 (`newArchEnabled`, "Defaults to true"); absent at `sdk-55`                                                                                |
| E16 | Expo docs, BuildProperties (page `dateModified` 2026-04-02): https://docs.expo.dev/versions/v55.0.0/sdk/build-properties/                                                                                              |
| E17 | expo/expo `sdk-54`, `packages/expo-build-properties/src/android.ts` L37–45                                                                                                                                             |
| E18 | expo/expo `sdk-54`, `packages/expo-build-properties/src/pluginConfig.ts` L605–606                                                                                                                                      |
| G1  | Play Console Help, "Target API level requirements for Google Play apps" (no page date shown): https://support.google.com/googleplay/android-developer/answer/11926878                                                  |
| G2  | Android Developers, "Meet Google Play's target API level requirement" ("Last updated 2026-10-28 UTC"): https://developer.android.com/google/play/requirements/target-sdk                                               |
| A1  | Apple Developer, "Upcoming requirements" (SDK minimum "Since April 28, 2026"): https://developer.apple.com/news/upcoming-requirements/                                                                                 |
| NPM | npm registry `expo` dist-tags and publish times: https://registry.npmjs.org/expo                                                                                                                                       |

## 8. Not verified here

- Any real build: SDK 54 prebuild at target 36, Legacy Architecture with our native modules, and Xcode 26 on SDK 54.
- Expo's support or patch window for SDK 54.
- Google's next target-API date (not announced on 2026-11-18) and Apple's next Xcode minimum.
- Who decided "SDK 54 next on Legacy Architecture". It came from the coordinator and isn't in the repo (C2 in
  `phase-2-roadmap.md` already flags who decides Expo).
