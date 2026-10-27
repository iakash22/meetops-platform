import { REDACT_KEYS } from '@meetops/contracts';
import { createLogger, type Logger } from '@meetops/logger';

/** Worker logger: contracts REDACT_KEYS redacted at any depth, in log objects and child bindings (ADR-005 A1.5). */
export function createWorkerLogger(destination?: Parameters<typeof createLogger>[1]): Logger {
  return createLogger({ name: 'worker', redactKeys: REDACT_KEYS }, destination);
}

export const logger: Logger = createWorkerLogger();
