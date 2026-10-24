# waveform.json

The waveform is stored at `organizations/{organizationId}/meetings/{meetingId}/processed/{recordingId}/waveform.json`.

- **It's derived.** The media worker builds it from the normalized 16 kHz mono WAV using `computeWaveform`.
- **It's deterministic.** Each recording always gets the same key, so a retry or regeneration overwrites the file.
- **It isn't tracked.** No `file_objects` row is created for it, and no worker interface persists it. It isn't counted as a user file, and it never appears in file listings or upload records.
- **Reading it:** derive the key from `(organizationId, meetingId, recordingId)`, the same way you would for the normalized WAV.
- **Deleting it:** delete it together with the recording's `processed/{recordingId}/` prefix.
- **Format:** `{ version: 1, sampleRate, channels, durationMs, bins, peaks: number[0..1] }`, at most 1 MiB.
