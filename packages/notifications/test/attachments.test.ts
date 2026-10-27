import { describe, expect, it } from 'vitest';
import {
  ConsoleEmailService,
  SmtpEmailService,
  createAuthMailTransport,
  type EmailAttachment,
} from '../src/index.js';

const logo: EmailAttachment = {
  filename: 'meetops-logo.png',
  cid: 'meetops-logo@meetops',
  contentType: 'image/png',
  content: 'iVBORw0KGgo=',
  encoding: 'base64',
};
const banner: EmailAttachment = { ...logo, filename: 'banner.png', cid: 'banner@meetops' };
const msg = {
  to: 'a@x.test',
  subject: 'Hi',
  html: '<img src="cid:meetops-logo@meetops">',
  attachments: [logo, banner],
};

function smtp() {
  const sent: Record<string, unknown>[] = [];
  const svc = new SmtpEmailService(
    { host: 'smtp.test', port: 587, secure: false, from: 'MeetOps <no-reply@x.test>' } as never,
    () =>
      ({
        sendMail: async (m: Record<string, unknown>) => {
          sent.push(m);
          return { messageId: 'm1', accepted: ['a@x.test'], rejected: [] };
        },
        verify: async () => true,
        close: () => undefined,
      }) as never,
  );
  return { svc, sent };
}

describe('inline CID attachments', () => {
  it('smtp adapter passes logo and banner through as inline attachments', async () => {
    const { svc, sent } = smtp();
    await svc.send(msg);
    expect(sent[0]!.attachments).toEqual([
      { ...logo, contentDisposition: 'inline' },
      { ...banner, contentDisposition: 'inline' },
    ]);
  });

  it('smtp adapter omits attachments when none are given', async () => {
    const { svc, sent } = smtp();
    await svc.send({ to: 'a@x.test', subject: 'Hi', text: 't' });
    expect(sent[0]).not.toHaveProperty('attachments');
  });

  it('in-memory transport keeps a copy of the attachments', async () => {
    const svc = new ConsoleEmailService();
    await svc.send(msg);
    expect(svc.sent[0]!.attachments).toEqual([logo, banner]);
    expect(svc.sent[0]!.attachments![0]).not.toBe(logo);
  });

  it('rejects header-injecting or non-image attachments', async () => {
    const svc = new ConsoleEmailService();
    await expect(
      svc.send({ ...msg, attachments: [{ ...logo, cid: 'x\r\nBcc: e@x.test' }] }),
    ).rejects.toThrow(/cid/);
    await expect(
      svc.send({ ...msg, attachments: [{ ...logo, filename: 'a\r\n.png' }] }),
    ).rejects.toThrow(/filename/);
    await expect(
      svc.send({ ...msg, attachments: [{ ...logo, contentType: 'text/html' }] }),
    ).rejects.toThrow(/content type/);
    await expect(
      svc.send({ ...msg, attachments: [{ ...logo, content: 'not base64!' }] }),
    ).rejects.toThrow(/base64/);
  });

  it('auth transport forwards rendered output to the service', async () => {
    const svc = new ConsoleEmailService();
    await createAuthMailTransport(svc).send({
      to: 'a@x.test',
      template: 'account_exists',
      data: { url: 'https://app.test/f' },
    });
    expect(svc.sent).toHaveLength(1);
  });
});
