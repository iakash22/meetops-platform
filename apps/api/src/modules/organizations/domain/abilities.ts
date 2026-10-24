import { AbilityBuilder, createMongoAbility, subject as caslSubject, type MongoAbility } from '@casl/ability';
import type { Role } from './membership.js';

export type Action = 'manage' | 'create' | 'read' | 'update' | 'delete';
export type SubjectName = 'Organization' | 'Membership' | 'Invitation' | 'Meeting' | 'Billing' | 'all';
type OrgScoped = { organizationId: string; createdById?: string };
// Conditions are Mongo queries over { organizationId, createdById }.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AppAbility = MongoAbility<[Action, SubjectName | Record<string, any>]>;

/** Tag a plain object for CASL condition checks. */
export const orgSubject = (type: Exclude<SubjectName, 'all'>, attrs: OrgScoped) => caslSubject(type, { ...attrs });

/**
 * Abilities per rbac-matrix.md. Every rule is conditioned on organizationId so an ability
 * built for org A never authorizes org B resources.
 * userId/role null => an authenticated user with no membership in this org.
 */
export function defineAbilityFor(ctx: { userId: string; organizationId: string | null; role: Role | null }): AppAbility {
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
        cannot('delete', 'Organization');
        break;
      case 'member':
        can('read', ['Organization', 'Membership', 'Invitation'], o);
        can(['create', 'read'], 'Meeting', o);
        can(['update', 'delete'], 'Meeting', { organizationId, createdById: ctx.userId });
        break;
      case 'viewer':
        can('read', ['Organization', 'Membership', 'Invitation', 'Meeting'], o);
        break;
    }
  }
  return build();
}
