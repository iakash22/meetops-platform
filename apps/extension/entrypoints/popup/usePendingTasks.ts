import { useEffect, useState } from 'react';
import type { AuthStatus } from '../../src/lib/auth/messages.js';
import type {
  PendingTasks,
  PendingTasksRequest,
  PendingTasksResponse,
} from '../../src/lib/pending-tasks.js';

/** One read per popup open (and per paired organization), not on the 1 s timer. Failures hide the row. */
export function usePendingTasks(auth: AuthStatus | undefined): PendingTasks | undefined {
  const [pending, setPending] = useState<PendingTasks>();
  const org = auth?.state === 'paired' ? auth.organizationId : undefined;
  useEffect(() => {
    setPending(undefined);
    if (!org) return;
    let live = true;
    chrome.runtime
      .sendMessage<PendingTasksRequest, PendingTasksResponse>({
        target: 'background',
        type: 'TASKS_PENDING',
      })
      .then(
        (res) => {
          if (live && res?.ok) setPending({ count: res.count, more: res.more });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [org]);
  return pending;
}
