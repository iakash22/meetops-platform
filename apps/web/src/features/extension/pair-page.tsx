import { useState } from 'react';
import { CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/states/states';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useApi } from '@/lib/api/context';
import { useOrgStore } from '@/stores/org-store';
import {
  buildPairingMessage,
  ExtensionUnavailableError,
  getChromeRuntime,
  isValidPairingCode,
  sendPairingMessage,
  toPairRequest,
  type PairSearch,
} from './pairing';

type Status =
  | { kind: 'idle' }
  | { kind: 'pairing' }
  | { kind: 'success'; organizationName: string }
  | { kind: 'api-error'; error: unknown }
  | { kind: 'extension-error' };

function Notice({ title, children }: { title: string; children: string }) {
  return (
    <Alert variant="destructive" data-testid="pair-notice">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

/** /extension/pair (ADR-005 A1.1): confirm org + device, POST pair, hand the code to the extension. */
export function ExtensionPairPage({ search }: { search: PairSearch }) {
  const api = useApi();
  const org = useOrgStore((s) => s.organizations.find((o) => o.id === s.currentOrganizationId));
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const request = toPairRequest(search);
  const hasRuntime = getChromeRuntime() !== null;

  const body = (() => {
    if (!request)
      return (
        <Notice title="Invalid pairing link">
          This pairing link is incomplete or malformed. Start pairing again from the MeetOps
          extension.
        </Notice>
      );
    if (!hasRuntime)
      return (
        <Notice title="Extension not available">
          Open this page in Chrome with the MeetOps extension installed, then start pairing from the
          extension.
        </Notice>
      );
    if (!org)
      return (
        <Notice title="No organization selected">
          Create or select an organization before connecting the extension.
        </Notice>
      );
    if (status.kind === 'success')
      return (
        <div role="status" data-testid="pair-success" className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-5 w-5 text-green-600" aria-hidden />
          <span>Extension connected to {status.organizationName}. You can close this tab.</span>
        </div>
      );

    const pair = async () => {
      setStatus({ kind: 'pairing' });
      let res;
      try {
        res = await api.extension.pair(request);
      } catch (error) {
        setStatus({ kind: 'api-error', error });
        return;
      }
      if (!isValidPairingCode(res.pairingCode)) {
        setStatus({ kind: 'api-error', error: null });
        return;
      }
      try {
        await sendPairingMessage(
          request.extensionId,
          buildPairingMessage(res.pairingCode, request.nonce),
        );
        setStatus({ kind: 'success', organizationName: res.organizationName });
      } catch (err) {
        if (err instanceof ExtensionUnavailableError) setStatus({ kind: 'extension-error' });
        else throw err;
      }
    };

    const pending = status.kind === 'pairing';
    return (
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Organization</dt>
          <dd data-testid="pair-org">{org.name}</dd>
          <dt className="text-muted-foreground">Device</dt>
          <dd data-testid="pair-device">{request.deviceLabel ?? 'Unnamed device'}</dd>
        </dl>
        {status.kind === 'api-error' ? (
          <ErrorState title="Pairing failed" error={status.error} />
        ) : null}
        {status.kind === 'extension-error' ? (
          <Notice title="Couldn't reach the extension">
            Make sure the MeetOps extension is installed and enabled, then start pairing again from
            the extension.
          </Notice>
        ) : null}
        <Button onClick={() => void pair()} disabled={pending} className="w-fit">
          {pending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden /> : null}
          {pending ? 'Connecting…' : 'Connect extension'}
        </Button>
      </div>
    );
  })();

  return (
    <div className="mx-auto max-w-lg p-6">
      <Card>
        <CardHeader>
          <CardTitle>Connect the MeetOps extension</CardTitle>
          <CardDescription>
            Confirm the organization and device. The extension never receives your web session.
          </CardDescription>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    </div>
  );
}
