/**
 * The meeting a new recording belongs to (InitRecordingSessionRequest.meetingId, required by
 * @meetops/contracts v0.2). The only place the extension decides a meetingId.
 *
 * TODO(meeting-api): interim. A fresh random UUID per recording, so the stub upload client accepts
 * it, but no real meeting row exists for it. Real flow: before recording, call the Backend endpoint
 * that creates the meeting (org-scoped, authenticated) and return the meetingId it responds with;
 * a real API will reject unknown meetingIds. Do not build that client here until the endpoint exists.
 */
export function resolveMeetingId(): Promise<string> {
  return Promise.resolve(crypto.randomUUID());
}
