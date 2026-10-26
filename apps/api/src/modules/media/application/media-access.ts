import type { DirectoryCaller } from '../../directory/access.js';
import { ForbiddenError } from '../../organizations/domain/errors.js';
import {
  defineAbilityFor,
  orgSubject,
  type Action,
  type MediaSubject,
} from '../../organizations/domain/abilities.js';

/** CASL check for media subjects; `ownerId` enables the member "update own" rule. */
export function authorizeMedia(
  c: DirectoryCaller,
  action: Action,
  subject: MediaSubject,
  ownerId?: string,
): void {
  const attrs = {
    organizationId: c.ctx.organizationId,
    ...(ownerId !== undefined ? { createdById: ownerId } : {}),
  };
  if (defineAbilityFor(c.ctx).cannot(action, orgSubject(subject, attrs)))
    throw new ForbiddenError();
}
