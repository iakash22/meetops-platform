import { useEffect, useState } from 'react';
import { LogOut } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { API_BASE_URL } from '@/lib/config';
import { getAppInfo, type AppInfo } from '@/lib/native';
import { activeOrganizationName, displayName, useSession } from '@/features/auth/session';

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

export function SettingsScreen() {
  const { session, signOut } = useSession();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [infoError, setInfoError] = useState(false);

  useEffect(() => {
    let active = true;
    getAppInfo()
      .then((i) => {
        if (active) setInfo(i);
      })
      .catch(() => {
        if (active) setInfoError(true);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>

      <Card>
        <CardHeader>
          <CardTitle>Account</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="divide-y divide-border">
            <Row label="User" value={session ? displayName(session) : '—'} />
            <Row label="Organization" value={(session && activeOrganizationName(session)) ?? '—'} />
          </dl>
          <Button variant="outline" className="mt-4" onClick={() => void signOut()}>
            <LogOut aria-hidden />
            Sign out
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Application</CardTitle>
          <CardDescription>
            Reported by the native (Rust) side when running in Tauri.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {infoError ? (
            <p className="text-sm text-destructive">Could not read app info.</p>
          ) : !info ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <dl className="divide-y divide-border" aria-label="Application info">
              <Row label="Version" value={info.version} />
              <Row
                label="Runtime"
                value={info.runtime === 'tauri' ? 'Desktop (Tauri)' : 'Browser preview'}
              />
              <Row label="Platform" value={`${info.os} / ${info.arch}`} />
              <Row label="API" value={API_BASE_URL} />
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Offline recording</CardTitle>
          <CardDescription>
            Local storage location, retention and upload settings will appear here (Phase 8).
          </CardDescription>
        </CardHeader>
      </Card>
    </div>
  );
}
