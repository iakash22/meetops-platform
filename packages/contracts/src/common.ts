import { Type, type Static } from '@sinclair/typebox';

/** All entity ids are UUIDs (ADR-004). */
export const Id = Type.String({ format: 'uuid' });
export type Id = Static<typeof Id>;
export const IsoDateTime = Type.String({ format: 'date-time' });
export type IsoDateTime = Static<typeof IsoDateTime>;

/**
 * Characters disallowed in user-supplied display text (regex character-class body): C0/C1 control characters, DEL,
 * line/paragraph separators, HTML-significant characters (`<`, `>`, `"`, `'`, `&`), and bidi/invisible format characters
 * (U+200B-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF, U+061C).
 */
export const UNSAFE_DISPLAY_TEXT_CHARS =
  '\\u0000-\\u001F\\u007F-\\u009F\\u2028\\u2029<>"\'&\\u200B-\\u200F\\u2060\\uFEFF\\u061C\\u202A-\\u202E\\u2066-\\u2069';
/** Pattern: one or more characters, none of them in UNSAFE_DISPLAY_TEXT_CHARS. */
export const SAFE_DISPLAY_TEXT_PATTERN = `^[^${UNSAFE_DISPLAY_TEXT_CHARS}]+$`;
/**
 * Pattern: like SAFE_DISPLAY_TEXT_PATTERN, but the first and last characters must not be whitespace (`\s`). This rejects
 * whitespace-only values and leading or trailing whitespace. A schema cannot trim, so clients MUST trim before sending.
 */
export const SAFE_DISPLAY_TEXT_TRIMMED_PATTERN =
  `^[^${UNSAFE_DISPLAY_TEXT_CHARS}\\s](?:[^${UNSAFE_DISPLAY_TEXT_CHARS}]*[^${UNSAFE_DISPLAY_TEXT_CHARS}\\s])?$`;

/**
 * Shared schema for user-supplied display text (device labels, org names). Length is 1..maxLength. With
 * `trimmed: true` it also rejects whitespace-only values and leading or trailing whitespace (clients MUST trim).
 */
export const SafeDisplayText = (opts: { maxLength: number; trimmed?: boolean }) =>
  Type.String({
    minLength: 1,
    maxLength: opts.maxLength,
    pattern: opts.trimmed ? SAFE_DISPLAY_TEXT_TRIMMED_PATTERN : SAFE_DISPLAY_TEXT_PATTERN,
  });

export const Timestamps = Type.Object({ createdAt: IsoDateTime, updatedAt: IsoDateTime });
