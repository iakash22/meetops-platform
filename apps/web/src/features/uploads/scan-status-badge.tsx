import { memo } from 'react';
import { Badge, type BadgeProps } from '@/components/ui/badge';
import type { FileObjectScanStatus } from './types';

const META: Record<
  FileObjectScanStatus,
  { label: string; hint: string; variant: BadgeProps['variant'] }
> = {
  pending: {
    label: 'Scanning',
    hint: 'Security scan in progress; download is available once it is clean.',
    variant: 'secondary',
  },
  clean: { label: 'Clean', hint: 'Passed the security scan.', variant: 'outline' },
  quarantined: {
    label: 'Quarantined',
    hint: 'Held by the security scan and will not be served.',
    variant: 'destructive',
  },
  rejected: {
    label: 'Rejected',
    hint: 'Failed file validation and will be deleted.',
    variant: 'destructive',
  },
};

/** Text label (never colour alone) plus an sr-only explanation. */
export const ScanStatusBadge = memo(function ScanStatusBadge({
  status,
}: {
  status: FileObjectScanStatus;
}) {
  const m = META[status];
  return (
    <Badge variant={m.variant} data-testid="scan-status" data-status={status}>
      {m.label}
      <span className="sr-only">: {m.hint}</span>
    </Badge>
  );
});
