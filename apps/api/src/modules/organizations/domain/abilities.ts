import {
  AbilityBuilder,
  createMongoAbility,
  subject as caslSubject,
  type MongoAbility,
} from '@casl/ability';
import type { Role } from './membership.js';

export type Action = 'manage' | 'create' | 'read' | 'update' | 'delete';
/** Directory subjects (G14): org-scoped people/structure records. */
export const DIRECTORY_SUBJECTS = ['Employee', 'Team', 'Project'] as const;
/**
 * Media subjects (G14). `FileObject` is the subject for uploads (the pending FileObject row created at
 * upload init); `RecordingSession` covers browser recording init/chunks/complete/abort.
 * Ownership: pass the row's `uploadedById` (FileObject) / `createdById` (RecordingSession) as `createdById`.
 */
export const MEDIA_SUBJECTS = ['FileObject', 'RecordingSession'] as const;
/**
 * Task subjects (Phase 4). `Task` covers tasks and the review of AI-extracted tasks: reviewing (accept/dismiss) is
 * `create Task`, since accepting creates one. Viewers read only.
 */
export const TASK_SUBJECTS = ['Task'] as const;
/**
 * Self-service notification subjects (ADR-013). Every role, viewers included, may manage only its OWN rows
 * (`createdById` = the row's user); nobody, owners included, gets another user's feed, preferences or devices.
 */
export const SELF_NOTIFICATION_SUBJECTS = ['Notification', 'NotificationPreference', 'PushDevice'] as const;
export type SelfNotificationSubject = (typeof SELF_NOTIFICATION_SUBJECTS)[number];
export type TaskSubject = (typeof TASK_SUBJECTS)[number];
export type DirectorySubject = (typeof DIRECTORY_SUBJECTS)[number];
export type MediaSubject = (typeof MEDIA_SUBJECTS)[number];
export type SubjectName =
  | 'Organization'
  | 'Membership'
  | 'Invitation'
  | 'Meeting'
  | 'Billing'
  | DirectorySubject
  | MediaSubject
  | TaskSubject
  | SelfNotificationSubject
  | 'all';
type OrgScoped = { organizationId: string; createdById?: string };
// Conditions are Mongo queries over { organizationId, createdById }.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppAbility = MongoAbility<[Action, SubjectName | Record<string, any>]>;

/** Tag a plain object for CASL condition checks. */
export const orgSubject = (type: Exclude<SubjectName, 'all'>, attrs: OrgScoped) =>
  caslSubject(type, { ...attrs });

/**
 * Abilities per rbac-matrix.md. Every rule is conditioned on organizationId so an ability
 * built for org A never authorizes org B resources.
 * userId/role null => an authenticated user with no membership in this org.
 */
export function defineAbilityFor(ctx: {
  userId: string;
  organizationId: string | null;
  role: Role | null;
}): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  // Any authenticated user may create a new organization.
  can('create', 'Organization');
  const organizationId = ctx.organizationId;
  if (organizationId && ctx.role) {
    const o = { organizationId };
    switch (ctx.role) {
      case 'owner':
        can('manage', 'all', o);
        break;
      case 'admin':
        can(['read', 'update'], 'Organization', o);
        can('read', 'Billing', o);
        can(['create', 'read', 'update', 'delete'], ['Membership', 'Invitation'], o);
        can('manage', 'Meeting', o);
        can('manage', [...DIRECTORY_SUBJECTS, ...MEDIA_SUBJECTS, ...TASK_SUBJECTS], o);
        cannot('delete', 'Organization');
        break;
      case 'member':
        can('read', ['Organization', 'Membership', 'Invitation'], o);
        can(['create', 'read'], 'Meeting', o);
        can(['update', 'delete'], 'Meeting', { organizationId, createdById: ctx.userId });
        can('read', [...DIRECTORY_SUBJECTS], o);
        can(['create', 'read', 'update'], [...TASK_SUBJECTS], o);
        // Recordings / media: C R; U D own. `update` own covers chunk upload, complete and abort of the
        // member's own upload or recording session.
        can(['create', 'read'], [...MEDIA_SUBJECTS], o);
        can(['update', 'delete'], [...MEDIA_SUBJECTS], { organizationId, createdById: ctx.userId });
        break;
      case 'viewer':
        can(
          'read',
          [
            'Organization',
            'Membership',
            'Invitation',
            'Meeting',
            ...DIRECTORY_SUBJECTS,
            ...MEDIA_SUBJECTS,
            ...TASK_SUBJECTS,
          ],
          o,
        );
        break;
    }
    // ADR-013: own notification rows only, for every role. Owners' `manage all` is narrowed back to their own rows.
    can(['create', 'read', 'update', 'delete'], [...SELF_NOTIFICATION_SUBJECTS], {
      organizationId,
      createdById: ctx.userId,
    });
    cannot(['create', 'read', 'update', 'delete', 'manage'], [...SELF_NOTIFICATION_SUBJECTS], {
      createdById: { $ne: ctx.userId },
    });
  }
  return build();
}
