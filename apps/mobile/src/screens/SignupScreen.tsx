import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { ApiError } from '../api/client';
import { useSignupApi } from '../auth/SignupApiProvider';
import {
  NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  validateSignup,
  type SignupFieldErrors,
} from '../auth/signupValidation';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from '../auth/validation';
import { IS_DEMO_MODE } from '../services';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';
import { Toast } from '../ui/Toast';

/** Errors that belong to one field (shown inline). Everything else goes to the toast. */
export function signupFieldError(e: unknown): SignupFieldErrors | null {
  if (e instanceof ApiError && e.code === 'CONFLICT' && e.reason === 'EMAIL_TAKEN')
    return { email: 'An account with this email already exists.' };
  return null;
}

/** User-facing copy for non-field errors. Never echoes server messages or credentials. */
export function signupErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'RATE_LIMITED') return 'Too many attempts. Try again later.';
    if (e.code === 'VALIDATION_FAILED' || e.code === 'BAD_REQUEST')
      return 'Some details were not accepted. Check them and try again.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export function SignupScreen() {
  const api = useSignupApi();
  const router = useRouter();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);

  const edit =
    (field: keyof SignupFieldErrors, set: (v: string) => void) =>
    (value: string): void => {
      set(value);
      if (fieldErrors[field]) setFieldErrors((e) => ({ ...e, [field]: undefined }));
    };

  const goToLogin = () => router.replace('/login');

  const submit = async () => {
    if (submitting) return;
    const { ok, errors, request } = validateSignup({ name, email, password, confirm });
    setFieldErrors(errors);
    setToast(null);
    if (!ok) return;
    setSubmitting(true);
    try {
      await api.signup(request);
      setPassword('');
      setConfirm('');
      setSentTo(request.email);
    } catch (e) {
      const inline = signupFieldError(e);
      if (inline) setFieldErrors(inline);
      else setToast(signupErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (sentTo) {
    return (
      <View style={[styles.flex, styles.container]} testID="signup-check-email">
        <Text style={styles.title} accessibilityRole="header">
          Check your email
        </Text>
        <Text style={styles.subtitle}>
          Open the link we sent to <Text style={styles.strong}>{sentTo}</Text> to verify your
          account, then sign in.
        </Text>
        <Button testID="signup-back-to-login" label="Back to sign in" onPress={goToLogin} />
      </View>
    );
  }

  const longEnough = password.length >= PASSWORD_MIN_LENGTH;

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.container}>
        <Text style={styles.title} accessibilityRole="header">
          Create your account
        </Text>
        <Text style={styles.subtitle}>Sign up with your work email and a password.</Text>

        {IS_DEMO_MODE ? (
          <Text testID="demo-notice" style={styles.demo}>
            Demo mode: sign-up is simulated on this device. No data is sent anywhere.
          </Text>
        ) : null}

        <TextField
          testID="signup-name"
          label="Name"
          value={name}
          onChangeText={edit('name', setName)}
          error={fieldErrors.name}
          autoComplete="name"
          textContentType="name"
          maxLength={NAME_MAX_LENGTH}
          returnKeyType="next"
          editable={!submitting}
        />
        <TextField
          testID="signup-email"
          label="Email"
          value={email}
          onChangeText={edit('email', setEmail)}
          error={fieldErrors.email}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="email"
          keyboardType="email-address"
          textContentType="username"
          inputMode="email"
          maxLength={EMAIL_MAX_LENGTH}
          returnKeyType="next"
          editable={!submitting}
        />
        <TextField
          testID="signup-password"
          label="Password"
          value={password}
          onChangeText={edit('password', setPassword)}
          error={fieldErrors.password}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          maxLength={PASSWORD_MAX_LENGTH}
          returnKeyType="next"
          editable={!submitting}
        />
        <View style={styles.passwordMeta}>
          <Text
            testID="signup-password-hint"
            style={[styles.hint, longEnough && styles.hintMet]}
            accessibilityLabel={`At least ${PASSWORD_MIN_LENGTH} characters, ${longEnough ? 'met' : 'not met yet'}`}
          >
            {longEnough ? '✓ ' : ''}
            {PASSWORD_MIN_LENGTH}+ characters ({Math.min(password.length, PASSWORD_MIN_LENGTH)}/
            {PASSWORD_MIN_LENGTH})
          </Text>
          <Pressable
            testID="signup-toggle-password"
            onPress={() => setShowPassword((s) => !s)}
            accessibilityRole="button"
            accessibilityState={{ selected: showPassword }}
            hitSlop={8}
          >
            <Text style={styles.toggle}>{showPassword ? 'Hide password' : 'Show password'}</Text>
          </Pressable>
        </View>
        <TextField
          testID="signup-confirm"
          label="Confirm password"
          value={confirm}
          onChangeText={edit('confirm', setConfirm)}
          error={fieldErrors.confirm}
          secureTextEntry={!showPassword}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="new-password"
          textContentType="newPassword"
          maxLength={PASSWORD_MAX_LENGTH}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!submitting}
        />

        <Button
          testID="signup-submit"
          label="Create account"
          onPress={() => void submit()}
          loading={submitting}
        />

        <View style={styles.switchRow}>
          <Text style={styles.switchPrompt}>Already have an account?</Text>
          <Pressable
            testID="signup-to-login"
            onPress={goToLogin}
            accessibilityRole="link"
            hitSlop={8}
          >
            <Text style={styles.link}>Sign in</Text>
          </Pressable>
        </View>
      </View>
      <Toast testID="signup-toast" message={toast} onDismiss={() => setToast(null)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xs },
  title: { color: colors.foreground, fontSize: 28, fontWeight: '700', marginBottom: 6 },
  subtitle: { color: colors.mutedForeground, fontSize: 15, marginBottom: spacing.xxl },
  strong: { color: colors.foreground },
  demo: {
    color: colors.mutedForeground,
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.xl,
    fontSize: 13,
  },
  passwordMeta: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: -spacing.sm,
    marginBottom: spacing.lg,
  },
  hint: { color: colors.mutedForeground, fontSize: 13 },
  hintMet: { color: colors.link },
  toggle: { color: colors.link, fontSize: 13, fontWeight: '600' },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  switchPrompt: { color: colors.mutedForeground, fontSize: 14 },
  link: { color: colors.link, fontSize: 14, fontWeight: '600' },
});
