import { Type, type Static } from '@sinclair/typebox';

/** All entity ids are UUIDs (ADR-004). */
export const Id = Type.String({ format: 'uuid' });
export type Id = Static<typeof Id>;
export const IsoDateTime = Type.String({ format: 'date-time' });
export type IsoDateTime = Static<typeof IsoDateTime>;

/**
 * BMP characters disallowed in user-supplied display text (regex character-class body): C0/C1 control characters, DEL,
 * line/paragraph separators, HTML-significant characters (`<`, `>`, `"`, `'`, `&`), bidi/invisible format characters
 * (U+200B-U+200F, U+202A-U+202E, U+2060, U+2066-U+2069, U+FEFF, U+061C), soft hyphen U+00AD, Mongolian vowel separator
 * U+180E, Hangul filler U+3164 and variation selectors U+FE00-U+FE0F. Tag characters (U+E0000-U+E007F) are outside the
 * BMP and are handled by UNSAFE_DISPLAY_TEXT_TAGS.
 */
export const UNSAFE_DISPLAY_TEXT_CHARS =
  '\\u0000-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u2028\\u2029<>"\'&\\u200B-\\u200F\\u2060\\uFEFF\\u061C' +
  '\\u202A-\\u202E\\u2066-\\u2069\\u3164\\uFE00-\\uFE0F';

/**
 * Tag characters U+E0000-U+E007F as an alternation of explicit surrogate pairs (`\\uDB40\\uDC00|...`). Written this way,
 * the pattern is correct both without the `u` flag (TypeBox `Value.Check` compiles `new RegExp(pattern)`, where the pair
 * matches two code units) and with it (Ajv in Fastify, where an escaped lead+trail pair is one code point). A character
 * class or `\\u{...}` range would work in only one of those modes.
 */
export const UNSAFE_DISPLAY_TEXT_TAGS = Array.from(
  { length: 0x80 },
  (_, i) => `\\uDB40\\u${(0xdc00 + i).toString(16).toUpperCase()}`,
).join('|');

/** One allowed character: not a tag character and not in UNSAFE_DISPLAY_TEXT_CHARS. */
const SAFE_CHAR = `(?:(?!${UNSAFE_DISPLAY_TEXT_TAGS})[^${UNSAFE_DISPLAY_TEXT_CHARS}])`;

/** Pattern: one or more characters, none of them unsafe (see UNSAFE_DISPLAY_TEXT_CHARS and UNSAFE_DISPLAY_TEXT_TAGS). */
export const SAFE_DISPLAY_TEXT_PATTERN = `^${SAFE_CHAR}+$`;
/**
 * Pattern: like SAFE_DISPLAY_TEXT_PATTERN, but the first and last characters must not be whitespace (`\\s`). This rejects
 * whitespace-only values and leading or trailing whitespace. A schema cannot trim, so clients MUST trim before sending.
 */
export const SAFE_DISPLAY_TEXT_TRIMMED_PATTERN = `^(?!\\s)${SAFE_CHAR}+(?<!\\s)$`;

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

/**
 * v0.4.0: BMP characters disallowed in multi-line user text (team and project descriptions): like
 * UNSAFE_DISPLAY_TEXT_CHARS, but tab, LF and CR are allowed, and so are the HTML-significant characters (`<`, `>`, `"`,
 * `'`, `&`), because prose needs apostrophes and ampersands. Clients MUST render such text as text (never as HTML).
 * Tag characters are still rejected via UNSAFE_DISPLAY_TEXT_TAGS.
 */
export const UNSAFE_MULTILINE_TEXT_CHARS =
  '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F-\\u009F\\u00AD\\u180E\\u2028\\u2029\\u200B-\\u200F\\u2060' +
  '\\uFEFF\\u061C\\u202A-\\u202E\\u2066-\\u2069\\u3164\\uFE00-\\uFE0F';

/** v0.4.0: pattern for SafeMultilineText: one or more characters, none in UNSAFE_MULTILINE_TEXT_CHARS or a tag character. */
export const SAFE_MULTILINE_TEXT_PATTERN = `^(?:(?!${UNSAFE_DISPLAY_TEXT_TAGS})[^${UNSAFE_MULTILINE_TEXT_CHARS}])+$`;

/** v0.4.0: shared schema for multi-line user text (descriptions). Length is 1..maxLength. */
export const SafeMultilineText = (opts: { maxLength: number }) =>
  Type.String({ minLength: 1, maxLength: opts.maxLength, pattern: SAFE_MULTILINE_TEXT_PATTERN });
