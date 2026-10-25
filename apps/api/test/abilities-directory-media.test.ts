import { describe, it, expect } from 'vitest';
import {
  DIRECTORY_SUBJECTS,
  MEDIA_SUBJECTS,
  defineAbilityFor,
  orgSubject,
  type Action,
} from '../src/modules/organizations/domain/abilities.js';
import type { Role } from '../src/modules/organizations/domain/membership.js';

// G14: Role x action x subject table for the directory (Employee, Team, Project) and media
// (FileObject = uploads, RecordingSession) subjects. Derived from rbac-matrix.md
// ("Recordings / media: owner/admin all, member C R; D own, viewer R") and next-phase-tasks.md BE-2
// (directory: owner/admin manage, member and viewer read).

const A = 'org-a';
const B = 'org-b';
const ME = 'user-me';
const OTHER = 'user-other';
const ACTIONS: CrudAction[] = ['create', 'read', 'update', 'delete'];
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer'];

type CrudAction = Exclude<Action, 'manage'>;
type Expect = Record<CrudAction, boolean>;
const all: Expect = { create: true, read: true, update: true, delete: true };
const readOnly: Expect = { create: false, read: true, update: false, delete: false };
const memberMediaOwn: Expect = all;
const memberMediaOthers: Expect = { create: true, read: true, update: false, delete: false };

/** expected[role][subjectGroup][ownership] */
const matrix: Record<Role, { directory: Expect; mediaOwn: Expect; mediaOthers: Expect }> = {
  owner: { directory: all, mediaOwn: all, mediaOthers: all },
  admin: { directory: all, mediaOwn: all, mediaOthers: all },
  member: { directory: readOnly, mediaOwn: memberMediaOwn, mediaOthers: memberMediaOthers },
  viewer: { directory: readOnly, mediaOwn: readOnly, mediaOthers: readOnly },
};

const ability = (role: Role | null, organizationId: string | null = A) =>
  defineAbilityFor({ userId: ME, organizationId, role });

describe('CASL directory + media subjects (G14, rbac-matrix)', () => {
  for (const role of ROLES) {
    for (const subject of DIRECTORY_SUBJECTS) {
      for (const action of ACTIONS) {
        const want = matrix[role].directory[action];
        it(`${role} ${want ? 'can' : 'cannot'} ${action} ${subject} in own org`, () => {
          expect(ability(role).can(action, orgSubject(subject, { organizationId: A }))).toBe(want);
        });
      }
    }
    for (const subject of MEDIA_SUBJECTS) {
      for (const action of ACTIONS) {
        const own = matrix[role].mediaOwn[action];
        const others = matrix[role].mediaOthers[action];
        it(`${role} ${own ? 'can' : 'cannot'} ${action} own ${subject}; ${others ? 'can' : 'cannot'} for another user's`, () => {
          const a = ability(role);
          expect(a.can(action, orgSubject(subject, { organizationId: A, createdById: ME }))).toBe(
            own,
          );
          expect(
            a.can(action, orgSubject(subject, { organizationId: A, createdById: OTHER })),
          ).toBe(others);
        });
      }
    }
  }

  it('a cross-org subject is always denied, for every role, action and new subject', () => {
    for (const role of ROLES) {
      const a = ability(role);
      for (const subject of [...DIRECTORY_SUBJECTS, ...MEDIA_SUBJECTS]) {
        for (const action of [...ACTIONS, 'manage' as const]) {
          expect(a.can(action, orgSubject(subject, { organizationId: B }))).toBe(false);
          expect(a.can(action, orgSubject(subject, { organizationId: B, createdById: ME }))).toBe(
            false,
          );
        }
      }
    }
  });

  it('no membership (or no active org) grants nothing on the new subjects', () => {
    for (const a of [ability(null), ability(null, null), ability('owner', null)]) {
      for (const subject of [...DIRECTORY_SUBJECTS, ...MEDIA_SUBJECTS]) {
        for (const action of ACTIONS) {
          expect(a.can(action, orgSubject(subject, { organizationId: A }))).toBe(false);
        }
      }
    }
  });

  it('member media ownership needs an explicit createdById match (missing owner = denied)', () => {
    const m = ability('member');
    for (const subject of MEDIA_SUBJECTS) {
      expect(m.can('update', orgSubject(subject, { organizationId: A }))).toBe(false);
      expect(m.can('delete', orgSubject(subject, { organizationId: A }))).toBe(false);
    }
  });

  it('only owner/admin hold manage on directory and media; existing rules are unchanged', () => {
    for (const subject of [...DIRECTORY_SUBJECTS, ...MEDIA_SUBJECTS]) {
      expect(ability('owner').can('manage', orgSubject(subject, { organizationId: A }))).toBe(true);
      expect(ability('admin').can('manage', orgSubject(subject, { organizationId: A }))).toBe(true);
      expect(
        ability('member').can(
          'manage',
          orgSubject(subject, { organizationId: A, createdById: ME }),
        ),
      ).toBe(false);
      expect(ability('viewer').can('manage', orgSubject(subject, { organizationId: A }))).toBe(
        false,
      );
    }
    expect(ability('admin').can('delete', orgSubject('Organization', { organizationId: A }))).toBe(
      false,
    );
    expect(ability('member').can('read', orgSubject('Billing', { organizationId: A }))).toBe(false);
    expect(ability('viewer').can('create', orgSubject('Meeting', { organizationId: A }))).toBe(
      false,
    );
  });
});
