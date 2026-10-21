import { Type, type Static } from '@sinclair/typebox';

export const ErrorBody = Type.Object({
  error: Type.Object({ code: Type.String(), message: Type.String() })
});

export const PublicUser = Type.Object({
  id: Type.String(),
  email: Type.String({ format: 'email' }),
  name: Type.Union([Type.String(), Type.Null()]),
  createdAt: Type.String({ format: 'date-time' })
});

export const SessionResponse = Type.Object({
  user: PublicUser,
  session: Type.Object({
    activeOrganizationId: Type.Union([Type.String(), Type.Null()]),
    expiresAt: Type.String({ format: 'date-time' })
  })
});

export const SignupBody = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 8, maxLength: 256 }),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
  },
  { additionalProperties: false }
);

export const LoginBody = Type.Object(
  {
    email: Type.String({ format: 'email', maxLength: 320 }),
    password: Type.String({ minLength: 1, maxLength: 256 })
  },
  { additionalProperties: false }
);

export type SignupBodyT = Static<typeof SignupBody>;
export type LoginBodyT = Static<typeof LoginBody>;
