# Auth and realtime backlog (Low)

These are Low-severity follow-ups from the extension, desktop and realtime auth review. They are not scheduled yet.

- **Org-wide status fan-out.** Cookie sockets join `organizations:{id}`, so every member receives the upload and processing status for every meeting in the org, including meetings they cannot open. Consider fanning out per meeting or per user instead.
- **Old access token TTL after rotation.** Rotating a refresh token (extension or desktop) does not revoke the access token issued with the previous pair. It stays valid until it expires (up to the access token TTL). Consider revoking the previous access token on rotation, once the refresh grace window has passed.
- **Bearer case mismatch.** `apps/api/src/modules/extension-auth/http/dual-caller.ts` (`hasBearer`) matches `Bearer` case-insensitively (`/^Bearer\s/i`), while `bearer-guard.ts` requires exactly `Bearer ` (`/^Bearer (...)$/`). A `bearer xyz` header skips the cookie CSRF path and is then rejected by the guard. That is safe, but the two checks should agree; RFC 7235 makes the scheme case-insensitive.
