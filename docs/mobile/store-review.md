# Store review notes (M6 draft)

Draft text for App Store Connect and Google Play Console. Nothing here has been submitted. Placeholder ids
(`com.example.meetops`) must be replaced by the owner first.

## Apple App Review notes

> MeetOps records meeting audio only when the signed-in user starts a recording. Before the first recording the user
> opts in; before every recording they confirm that all participants were notified (or agreed). The microphone is
> requested only when the user first taps Record, after an in-app explanation. While recording, a banner shows on every
> screen and iOS shows the microphone indicator. Background audio (`UIBackgroundModes: audio`) is used only to keep a
> user-started recording running when the user switches apps. It's turned off when the recording stops. A phone call
> pauses the recording and the user has to resume it. There is no auto-start or background-triggered recording.
> Demo account: _to be provided by the owner_.

### Privacy nutrition label

| Data type                           | Collected | Linked to user | Tracking | Purpose           |
| ----------------------------------- | --------- | -------------- | -------- | ----------------- |
| Audio Data                          | Yes       | Yes            | No       | App Functionality |
| Email Address / Name (account)      | Yes       | Yes            | No       | App Functionality |
| User ID / Device ID (sign-in, push) | Yes       | Yes            | No       | App Functionality |

## Google Play

### Data safety

- **Audio (voice or sound recordings):** collected, not shared, encrypted in transit (TLS), user can request deletion, required for core functionality. Processed for transcription for the user's organization.
- **Personal info (name, email), App info / device IDs:** collected for account management, encrypted in transit.
- No data sold, no ads, no tracking.

### Prominent disclosure

The in-app pre-prompt (`ConsentSheet` mic step) explains microphone use before the OS dialog. Android 13+ also asks
for notifications before recording.

### Foreground service declaration

Not filed yet. The microphone foreground service isn't implemented (see `security-review.md`). Until it is, the
manifest declares no foreground service and recording pauses when the app leaves the foreground. When the service
lands: declare `FOREGROUND_SERVICE_MICROPHONE` with a demo video of a user-started recording, the ongoing notification
and its Stop action.

## EAS submit

`eas.json` keeps an empty `submit.production` profile. App Store Connect and Play credentials live in EAS secrets and
never in the repo. `eas submit` isn't run from this repo's CI.
