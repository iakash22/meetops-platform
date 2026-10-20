import pino, { type LoggerOptions, type Logger } from 'pino';

const redactionPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers.set-cookie',
  '*.password',
  '*.secret',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.access_token',
  '*.refresh_token'
];

export type CreateLoggerOptions = LoggerOptions & {
  name?: string;
};

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const logger = pino({
    level: process.env.NODE_ENV === 'production' ? 'info' : 'debug',
    redact: {
      paths: redactionPaths,
      censor: '***redacted***'
    },
    ...options
  });
  return logger;
}

export const logger = createLogger({ name: 'meetops' });
