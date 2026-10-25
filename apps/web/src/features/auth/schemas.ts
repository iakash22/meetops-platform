import { z } from 'zod';

// zod 4: top-level z.email() replaces the deprecated z.string().email(). Piping keeps the v3 UX
// where an empty field reports only "Email is required" (pipe stops on the first failure).
const email = z.string().min(1, 'Email is required').pipe(z.email('Enter a valid email'));

export const loginSchema = z.object({
  email: email,
  password: z.string().min(1, 'Password is required'),
});

export const signupSchema = z
  .object({
    name: z.string().min(1, 'Name is required'),
    email: email,
    password: z
      .string()
      .min(12, 'Password must be at least 12 characters')
      .max(128, 'Password must be at most 128 characters'),
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    error: 'Passwords do not match',
  });

export const forgotPasswordSchema = z.object({
  email: email,
});

export type LoginValues = z.infer<typeof loginSchema>;
export type SignupValues = z.infer<typeof signupSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;
