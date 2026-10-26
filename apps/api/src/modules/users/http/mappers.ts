import type { User as UserDto } from '@meetops/contracts';
import type { PublicUser, User } from '../domain/user.js';

/** Domain/Prisma user → contract User DTO. Never includes passwordHash. */
export function toUserDto(u: PublicUser & Partial<Pick<User, 'updatedAt'>>): UserDto {
  return {
    id: u.id,
    email: u.email,
    ...(u.name ? { name: u.name } : {}),
    createdAt: u.createdAt.toISOString(),
    updatedAt: (u.updatedAt ?? u.createdAt).toISOString(),
  };
}
