import { loadEmailConfig, type EmailConfig } from './config.js';
import { ConsoleEmailService } from './console.js';
import { SmtpEmailService, type SmtpTransportFactory } from './smtp.js';
import type { EmailService } from './types.js';

export function createEmailService(
  config: EmailConfig = loadEmailConfig(),
  deps: { smtpTransportFactory?: SmtpTransportFactory } = {}
): EmailService {
  switch (config.provider) {
    case 'smtp':
      return new SmtpEmailService(config, deps.smtpTransportFactory);
    case 'console':
      return new ConsoleEmailService({ from: config.from });
  }
}
