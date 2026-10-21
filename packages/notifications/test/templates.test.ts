import { describe, it, expect } from 'vitest';
import { renderTemplate, templateNames } from '../src';

describe('templates', () => {
  it('registers all templates', () => {
    expect(templateNames.sort()).toEqual(['invite', 'meeting_summary', 'reset_password', 'task_assigned', 'verify_email']);
  });
  it('renders verification with subject/html/text', () => {
    const r = renderTemplate('verify_email', { name: 'Ana', verificationUrl: 'https://app.test/v?t=1', expiresInHours: 24 });
    expect(r.subject).toMatch(/Verify/);
    expect(r.html).toContain('https://app.test/v?t=1');
    expect(r.text).toContain('24 hours');
  });
  it('escapes html in variables', () => {
    const r = renderTemplate('task_assigned', { assigneeName: '<script>x</script>', taskTitle: 'T', taskUrl: 'https://a.test/t' });
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
  });
  it('rejects non-http urls', () => {
    expect(() => renderTemplate('reset_password', { name: 'a', resetUrl: 'javascript:alert(1)', expiresInMinutes: 30 })).toThrow();
  });
  it('renders invitation and meeting summary', () => {
    expect(renderTemplate('invite', { inviterName: 'Bo', workspaceName: 'Acme', inviteUrl: 'https://a.test/i', role: 'admin' }).subject).toContain('Acme');
    const s = renderTemplate('meeting_summary', { recipientName: 'R', meetingTitle: 'Sync', meetingDate: '2026-10-21', summary: 'Line1\nLine2', actionItems: [{ title: 'Ship', owner: 'Bo' }], meetingUrl: 'https://a.test/m' });
    expect(s.text).toContain('- Ship — owner: Bo');
    expect(s.html).toContain('Line1<br>Line2');
  });
});
