/** A job handle from main(): either a `register*` result or a bare close function (undefined = not started). */
export interface ClosableJob {
  name: string;
  close?: (() => Promise<unknown>) | undefined;
  job?: { registered: boolean; close?: () => Promise<unknown> } | undefined;
}

/** Names of the jobs that are actually running. */
export function runningJobs(jobs: readonly ClosableJob[]): string[] {
  return jobs.filter((j) => resolveClose(j)).map((j) => j.name);
}

function resolveClose(j: ClosableJob): (() => Promise<unknown>) | undefined {
  if (j.close) return j.close;
  if (j.job?.registered && j.job.close) return j.job.close;
  return undefined;
}

/** Graceful shutdown: close every running job; one failure never stops the others. Logs names only. */
export async function closeAll(
  jobs: readonly ClosableJob[],
  log?: { warn(obj: object, msg: string): void },
): Promise<string[]> {
  const running = jobs.flatMap((j) => {
    const c = resolveClose(j);
    return c ? [{ name: j.name, close: c }] : [];
  });
  const results = await Promise.allSettled(running.map((j) => j.close()));
  results.forEach((r, i) => {
    if (r.status === 'rejected')
      log?.warn(
        { job: running[i]!.name, errName: r.reason instanceof Error ? r.reason.name : 'unknown' },
        'worker job close failed',
      );
  });
  return running.map((j) => j.name);
}
