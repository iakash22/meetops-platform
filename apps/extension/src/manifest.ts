/**
 * Manifest fields for the MeetOps extension. Kept separate from wxt.config.ts
 * so unit tests can assert the permission surface stays minimal.
 *
 * - `tabCapture` is the ONLY permission. It is used solely from the popup in
 *   response to an explicit user click, after the consent notice is acknowledged.
 * - No `host_permissions`: the popup click grants temporary access to the
 *   active tab via the action invocation, which is all tabCapture needs.
 */
export const manifest = {
  name: "MeetOps",
  description: "Record meetings you are part of, with clear consent.",
  permissions: ["tabCapture"] as string[],
  host_permissions: [] as string[],
  action: { default_title: "MeetOps" }
};
