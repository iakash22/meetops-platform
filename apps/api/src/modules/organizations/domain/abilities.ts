import { AbilityBuilder, createMongoAbility, type MongoAbility } from '@casl/ability';
import type { Role } from './membership.js';

export type Action = 'manage' | 'read' | 'update' | 'delete' | 'invite' | 'create';
export type Subject = 'Organization' | 'Membership' | 'Invitation' | 'Meeting' | 'all';
export type AppAbility = MongoAbility<[Action, Subject]>;

/** Abilities within a single organization, derived from the member's role. */
export function defineAbilityFor(role: Role | null): AppAbility {
  const { can, cannot, build } = new AbilityBuilder<AppAbility>(createMongoAbility);
  switch (role) {
    case 'owner':
      can('manage', 'all');
      break;
    case 'admin':
      can('manage', 'all');
      cannot('delete', 'Organization');
      break;
    case 'member':
      can('read', ['Organization', 'Membership', 'Meeting']);
      can(['create', 'update'], 'Meeting');
      break;
    case 'viewer':
      can('read', ['Organization', 'Membership', 'Meeting']);
      break;
    default:
      break;
  }
  return build();
}
