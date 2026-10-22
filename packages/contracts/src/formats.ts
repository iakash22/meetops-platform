import { FormatRegistry } from '@sinclair/typebox';

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Registers string formats used by these schemas with TypeBox's Value checker. Idempotent. */
export function registerContractFormats(): void {
  if (!FormatRegistry.Has('date-time')) FormatRegistry.Set('date-time', (v) => DATE_TIME.test(v) && !Number.isNaN(Date.parse(v)));
  if (!FormatRegistry.Has('uri')) FormatRegistry.Set('uri', (v) => { try { new URL(v); return true; } catch { return false; } });
  if (!FormatRegistry.Has('uuid')) FormatRegistry.Set('uuid', (v) => UUID.test(v));
  if (!FormatRegistry.Has('email')) FormatRegistry.Set('email', (v) => EMAIL.test(v));
}
registerContractFormats();
