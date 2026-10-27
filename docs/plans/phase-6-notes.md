# Phase 6 notes

## A1.4 frequent-refresh logging (feat/api-extension-refresh-frequency-log)

- ADR-005 A1.4: "A refresh more often than every 60 s per family SHOULD be logged." A refresh that arrives less than
  60 s after the previous accepted-for-processing refresh of the same family logs one `warn` line,
  `event: 'extension.token.refresh_frequent'`, with familyId, organizationId, userId, extensionId, deviceId, ip and
  `windowSeconds: 60`. It never contains tokens, codes or hashes.
- Defaults: log only, never reject (the 10/min per-family limit still rejects). The marker is the shared rate limiter
  (`ext:refresh:freq:<familyId>`, 1 per 60 s), so it is Redis-backed and works across API instances; no schema change.
  It runs after the reuse, binding and per-family limit checks, so replays and 429s are not double-reported. It is best
  effort: a limiter error never fails the refresh. No audit row (it is a signal, not a state change).
- Logger: `ModuleDeps.extensionAuthLog`, defaulting to the API's redacting `app.log`.
