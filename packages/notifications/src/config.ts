import { z } from 'zod';

const boolString = z
  .string()
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => ['true', 'false', '1', '0', 'yes', 'no', 'on', 'off', ''].includes(s), {
    message: 'Invalid boolean string'
  })
  .transform((s) => ['true', '1', 'yes', 'on'].includes(s));

const smtpSchema = z
  .object({
    EMAIL_PROVIDER: z.literal('smtp'),
    SMTP_HOST: z.string().min(1, 'SMTP_HOST is required'),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(465),
    SMTP_SECURE: boolString.optional(),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD: z.string().min(1).optional(),
    EMAIL_FROM: z.string().min(3, 'EMAIL_FROM is required')
  })
  .refine((v) => (v.SMTP_USER === undefined) === (v.SMTP_PASSWORD === undefined), {
    message: 'SMTP_USER and SMTP_PASSWORD must be set together'
  });

const consoleSchema = z.object({
  EMAIL_PROVIDER: z.literal('console'),
  EMAIL_FROM: z.string().min(3).default('MeetOps <no-reply@meetops.local>')
});

export interface SmtpEmailConfig {
  provider: 'smtp';
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
}

export interface ConsoleEmailConfig {
  provider: 'console';
  from: string;
}

export type EmailConfig = SmtpEmailConfig | ConsoleEmailConfig;

export class EmailConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailConfigError';
  }
}

function clean(env: Record<string, string | undefined>) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v !== undefined && v !== '') out[k] = v;
  }
  return out;
}

/**
 * Load and validate email configuration from env. Error messages never include values.
 * EMAIL_PROVIDER defaults to "smtp". "console" is intended for tests/dev only.
 */
export function loadEmailConfig(env: Record<string, string | undefined> = process.env): EmailConfig {
  const raw = clean(env);
  const provider = raw.EMAIL_PROVIDER ?? 'smtp';
  if (provider === 'console') {
    if (raw.NODE_ENV === 'production') {
      throw new EmailConfigError('EMAIL_PROVIDER=console is not allowed in production');
    }
    const r = consoleSchema.safeParse({ ...raw, EMAIL_PROVIDER: 'console' });
    if (!r.success) throw new EmailConfigError(formatIssues(r.error));
    return { provider: 'console', from: r.data.EMAIL_FROM };
  }
  if (provider !== 'smtp') {
    throw new EmailConfigError(`Unsupported EMAIL_PROVIDER (expected "smtp" or "console")`);
  }
  const r = smtpSchema.safeParse({ ...raw, EMAIL_PROVIDER: 'smtp' });
  if (!r.success) throw new EmailConfigError(formatIssues(r.error));
  const d = r.data;
  const cfg: SmtpEmailConfig = {
    provider: 'smtp',
    host: d.SMTP_HOST,
    port: d.SMTP_PORT,
    // Implicit TLS on 465 by default; STARTTLS otherwise unless explicitly set.
    secure: d.SMTP_SECURE ?? d.SMTP_PORT === 465,
    from: d.EMAIL_FROM
  };
  if (d.SMTP_USER && d.SMTP_PASSWORD) cfg.auth = { user: d.SMTP_USER, pass: d.SMTP_PASSWORD };
  return cfg;
}

function formatIssues(err: z.ZodError): string {
  return (
    'Invalid email configuration: ' +
    err.issues.map((i) => `${i.path.join('.') || 'config'}: ${i.message}`).join('; ')
  );
}

/** Safe-to-log view of config (secrets masked). */
export function redactEmailConfig(cfg: EmailConfig): Record<string, unknown> {
  if (cfg.provider === 'console') return { ...cfg };
  return {
    provider: cfg.provider,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    from: cfg.from,
    auth: cfg.auth ? { user: cfg.auth.user, pass: '***redacted***' } : undefined
  };
}
