/**
 * Extension-local limit not exported by @meetops/contracts: longest durationMs the recorder reports
 * to complete() (24 h). Keep in sync with the API's validation.
 */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
