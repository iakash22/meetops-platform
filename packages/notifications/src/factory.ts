import { EmailConfigError, loadEmailConfig, type EmailConfig } from './config.js';
import { ConsoleEmailService } from './console.js';
import { SmtpEmailService, type SmtpTransportFactory } from './smtp.js';
import type { EmailService } from './types.js';

export function createEmailService(
  config: EmailConfig = loadEmailConfig(),
  deps: { smtpTransportFactory?: SmtpTransportFactory; nodeEnv?: string | undefined } = {}
): EmailService {
  const nodeEnv = 'nodeEnv' in deps ? deps.nodeEnv : process.env.NODE_ENV;
  if (config.provider === 'console' && nodeEnv === 'production') {
    throw new EmailConfigError('Console email provider is not allowed in production');
  }
  switch (config.provider) {
    case 'smtp':
      return new SmtpEmailService(config, deps.smtpTransportFactory);
    case 'console':
      return new ConsoleEmailService({ from: config.from });
  }
}
