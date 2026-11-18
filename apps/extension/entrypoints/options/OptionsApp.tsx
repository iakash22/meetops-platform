import { PrivacyPolicyLink } from '../../src/lib/privacy-link.js';

/** Chrome's extension options page: keep this short and keyboard-accessible. */
export function OptionsApp({
  privacyUrl,
  webOrigin,
}: {
  privacyUrl?: string | undefined;
  webOrigin?: string | undefined;
} = {}) {
  return (
    <main className="mo-options">
      <h1>MeetOps AI</h1>
      <p>Record meetings you are part of, with clear consent.</p>
      <p>
        <PrivacyPolicyLink url={privacyUrl} webOrigin={webOrigin} />
      </p>
    </main>
  );
}
