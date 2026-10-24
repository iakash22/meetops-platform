import { describe, it } from 'vitest';

/*
 * Member email visibility (Security pre-release item): member and viewer responses must not
 * contain an `email` field at all; owner and admin responses must.
 *
 * TODO(QA): Backend's role-aware serialiser has not landed on integration/phase-1 (as of
 * 2026-10-22 there is no members-listing route and toMembershipDto has no email). When it
 * lands, replace these todos with real tests: seed owner/admin/member/viewer in one org via
 * invitations, GET the members list as each role, and assert
 *   - owner/admin: every item has a string `email`;
 *   - member/viewer: `'email' in item === false` for every item (not null, not '').
 */
describe('member email visibility by role (waiting on Backend serialiser)', () => {
  it.todo('owner sees email on every member');
  it.todo('admin sees email on every member');
  it.todo('member response has no email field at all');
  it.todo('viewer response has no email field at all');
});
