import { z } from 'zod';
import {
  DIRECTORY_KEY_PATTERN,
  MAX_DIRECTORY_DESCRIPTION_LENGTH,
  MAX_DIRECTORY_NAME_LENGTH,
  MAX_EMAIL_LENGTH,
  MAX_EMPLOYEE_FIELD_LENGTH,
  PROJECT_STATUSES,
  TEAM_MEMBER_ROLES,
  UNSAFE_DISPLAY_TEXT_CHARS,
  UNSAFE_MULTILINE_TEXT_CHARS,
} from './contracts-shim';

/**
 * Client-side mirrors of the contracts v0.4 directory request rules, for early feedback only.
 * The API (TypeBox/Ajv) stays authoritative. Tag characters (U+E0000-U+E007F) are left to the server.
 */
const UNSAFE_DISPLAY = new RegExp(`[${UNSAFE_DISPLAY_TEXT_CHARS}]`);
const UNSAFE_MULTILINE = new RegExp(`[${UNSAFE_MULTILINE_TEXT_CHARS}]`);
const KEY = new RegExp(DIRECTORY_KEY_PATTERN);

const UNSAFE_MESSAGE = 'Remove control characters and < > " \' &';

/** Required SafeDisplayText (trimmed). */
const displayText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`)
    .refine((v) => !UNSAFE_DISPLAY.test(v), UNSAFE_MESSAGE);

/** Optional SafeDisplayText: '' means "not provided". */
const optionalDisplayText = (label: string, max: number) =>
  z
    .string()
    .trim()
    .max(max, `${label} must be at most ${max} characters`)
    .refine((v) => !UNSAFE_DISPLAY.test(v), UNSAFE_MESSAGE);

const description = z
  .string()
  .trim()
  .max(
    MAX_DIRECTORY_DESCRIPTION_LENGTH,
    `Description must be at most ${MAX_DIRECTORY_DESCRIPTION_LENGTH} characters`,
  )
  .refine((v) => !UNSAFE_MULTILINE.test(v), 'Remove control characters');

const key = z
  .string()
  .trim()
  .refine((v) => KEY.test(v), 'Use 2-10 uppercase letters or digits, starting with a letter');

export const employeeFormSchema = z.object({
  fullName: displayText('Full name', MAX_DIRECTORY_NAME_LENGTH),
  email: z
    .string()
    .trim()
    .max(MAX_EMAIL_LENGTH, `Email must be at most ${MAX_EMAIL_LENGTH} characters`)
    .refine((v) => v === '' || z.email().safeParse(v).success, 'Enter a valid email'),
  title: optionalDisplayText('Title', MAX_EMPLOYEE_FIELD_LENGTH),
  department: optionalDisplayText('Department', MAX_EMPLOYEE_FIELD_LENGTH),
});
export type EmployeeFormValues = z.infer<typeof employeeFormSchema>;

export const teamFormSchema = z.object({
  name: displayText('Team name', MAX_DIRECTORY_NAME_LENGTH),
  key: z.union([z.literal(''), key]),
  description,
});
export type TeamFormValues = z.infer<typeof teamFormSchema>;

export const projectFormSchema = z.object({
  name: displayText('Project name', MAX_DIRECTORY_NAME_LENGTH),
  key,
  description,
  teamId: z.string(),
});
export type ProjectFormValues = z.infer<typeof projectFormSchema>;

export const teamMemberFormSchema = z.object({
  employeeId: z.string().min(1, 'Choose an employee'),
  role: z.enum(TEAM_MEMBER_ROLES),
});
export type TeamMemberFormValues = z.infer<typeof teamMemberFormSchema>;

export const projectStatusSchema = z.enum(PROJECT_STATUSES);

/** Drop '' values so optional request fields are omitted rather than sent empty. */
export function omitEmpty<T extends Record<string, string>>(values: T): Partial<T> {
  return Object.fromEntries(Object.entries(values).filter(([, v]) => v !== '')) as Partial<T>;
}

/** List `q` param: trimmed and safe, else omitted (the API would reject it with 400). */
export function toSearchQuery(v: string): { q?: string } {
  const q = v.trim().slice(0, MAX_DIRECTORY_NAME_LENGTH);
  return q && !UNSAFE_DISPLAY.test(q) ? { q } : {};
}
