import type { EmailName, EmailVariables } from '../src';

const pref = {
  preferencesUrl: 'https://app.meetops.test/settings/notifications',
  unsubscribeUrl: 'https://app.meetops.test/u/one-click?t=demo',
};

/** Sample variables for every email (used by snapshots and the preview script). */
export const sampleVariables: { [K in EmailName]: EmailVariables[K] } = {
  verification: {
    name: 'Ana',
    verificationUrl: 'https://app.meetops.test/verify-email?token=demo',
    expiresInHours: 24,
  },
  'password-reset': {
    name: 'Ana',
    resetUrl: 'https://app.meetops.test/reset-password?token=demo',
    expiresInMinutes: 30,
  },
  invitation: {
    inviterName: 'Bo Lee',
    workspaceName: 'Acme Inc',
    inviteUrl: 'https://app.meetops.test/invite?token=demo',
    role: 'Member',
    expiresInDays: 7,
  },
  'account-exists': { resetUrl: 'https://app.meetops.test/reset-password?token=demo' },
  'login-lockout': {
    name: 'Ana',
    resetUrl: 'https://app.meetops.test/reset-password?token=demo',
    lockedForMinutes: 15,
  },
  'password-changed': {
    name: 'Ana',
    changedAt: '26 Oct 2026, 11:40 PM IST',
    resetUrl: 'https://app.meetops.test/forgot-password',
  },
  'member-added': {
    name: 'Ana',
    workspaceName: 'Acme Inc',
    addedBy: 'Bo Lee',
    role: 'Admin',
    workspaceUrl: 'https://app.meetops.test/orgs/acme',
    ...pref,
  },
  'member-removed': { name: 'Ana', workspaceName: 'Acme Inc', removedBy: 'Bo Lee', ...pref },
  'meeting-summary': {
    recipientName: 'Ana',
    meetingTitle: 'Weekly product sync',
    meetingDate: '26 Oct 2026',
    summary: 'We agreed to ship the upload queue on Friday.\nDesktop sign-in waits on ADR-012.',
    actionItems: [
      { title: 'Ship upload queue', owner: 'Bo', dueDate: '30 Oct' },
      { title: 'Review ADR-012' },
    ],
    meetingUrl: 'https://app.meetops.test/meetings/m1',
    ...pref,
  },
  'tasks-ready-for-review': {
    name: 'Ana',
    meetingTitle: 'Weekly product sync',
    taskTitles: [
      'Ship upload queue',
      'Review ADR-012',
      'Fix flaky members test',
      'Bump nodemailer',
      'Write runbook',
      'Rotate keys',
    ],
    reviewUrl: 'https://app.meetops.test/meetings/m1/tasks/review',
    ...pref,
  },
  'task-assigned': {
    assigneeName: 'Ana',
    taskTitle: 'Ship upload queue',
    taskUrl: 'https://app.meetops.test/tasks/t1',
    assignedBy: 'Bo Lee',
    dueDate: '30 Oct 2026',
    meetingTitle: 'Weekly product sync',
    ...pref,
  },
  'integration-error': {
    name: 'Ana',
    provider: 'Jira',
    workspaceName: 'Acme Inc',
    reason: 'The access token was revoked.',
    failingSince: '26 Oct 2026, 9:00 PM IST',
    settingsUrl: 'https://app.meetops.test/settings/integrations',
    ...pref,
  },
};
