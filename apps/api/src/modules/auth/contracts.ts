/**
 * Zod contracts for auth. Kept inside apps/api until Architecture decides whether
 * to promote them into packages/contracts/src/auth.
 */
import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(320);
export const passwordSchema = z.string().min(8).max(256);

export const signupRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().trim().min(1).max(120).optional()
});
export const loginRequestSchema = z.object({ email: emailSchema, password: z.string().min(1).max(256) });

export const publicUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  name: z.string().nullable(),
  createdAt: z.string().datetime()
});
export const sessionResponseSchema = z.object({
  user: publicUserSchema,
  session: z.object({ activeOrganizationId: z.string().nullable(), expiresAt: z.string().datetime() })
});

export type SignupRequest = z.infer<typeof signupRequestSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type PublicUserDto = z.infer<typeof publicUserSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
