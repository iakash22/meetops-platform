import { isAcceptablePassword } from '@meetops/contracts/types';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import { ApiError } from '../api/client';
import { useSignupApi } from '../auth/SignupApiProvider';
import {
  NAME_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordStrength,
  validateSignup,
  type PasswordStrength,
  type SignupFieldErrors,
} from '../auth/signupValidation';
import { EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from '../auth/validation';
import { IS_DEMO_MODE } from '../services';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';
import { Toast } from '../ui/Toast';

/**
 * Signup is enumeration-safe (docs/references.md section 5): `EMAIL_TAKEN` ends on the same "Check your email" state
 * as a new account, never an "already taken" message.
 */
export function isEnumerationSafeSuccess(e: unknown): boolean {
  return e instanceof ApiError && e.code === 'CONFLICT' && e.reason === 'EMAIL_TAKEN';
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
  const [showPassword, setShowPassword] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<SignupFieldErrors>({});
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const nameRef = useRef<TextInput>(null);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const edit =
    (field: keyof SignupFieldErrors, set: (v: string) => void) =>
    (value: string): void => {
      set(value);
      if (fieldErrors[field]) setFieldErrors((e) => ({ ...e, [field]: undefined }));
    };

  const goToLogin = () => router.replace('/login');

  const submit = async () => {
    if (submitting) return;
    const { ok, errors, request } = validateSignup({ name, email, password });
    setFieldErrors(errors);
    setToast(null);
    if (!ok) {
      // Focus the first invalid field.
      (errors.name ? nameRef : errors.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await api.signup(request);
      setPassword('');
      setSentTo(request.email);
    } catch (e) {
      if (isEnumerationSafeSuccess(e)) {
        setPassword('');
        setSentTo(request.email);
      } else setToast(signupErrorMessage(e));
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

  const longEnough = isAcceptablePassword(password);
  const strength = passwordStrength(password);

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
          ref={nameRef}
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
          ref={emailRef}
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
          ref={passwordRef}
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
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!submitting}
        />
        <StrengthMeter strength={strength} />
        <View style={styles.passwordMeta}>
          <Text
            testID="signup-password-hint"
            style={[styles.hint, longEnough && styles.hintMet]}
            accessibilityLabel={`8 or more characters with a letter, number, and symbol, ${longEnough ? 'met' : 'not met yet'}`}
          >
            {longEnough ? '✓ ' : ''}
            {PASSWORD_MIN_LENGTH}+ with a letter, number, and symbol
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

const STRENGTH: Record<PasswordStrength, { label: string; bars: number; color: string }> = {
  'too-short': { label: 'Too short', bars: 0, color: colors.border },
  weak: { label: 'Weak', bars: 1, color: colors.destructive },
  fair: { label: 'Fair', bars: 2, color: colors.warning },
  strong: { label: 'Strong', bars: 3, color: colors.primary },
};

/** Three-bar strength meter. Bars are fills (cerulean only as a fill); the label carries the meaning. */
function StrengthMeter({ strength }: { strength: PasswordStrength }) {
  const { label, bars, color } = STRENGTH[strength];
  return (
    <View
      testID="signup-strength"
      style={styles.meter}
      accessible
      accessibilityLabel={`Password strength: ${label}`}
    >
      {[0, 1, 2].map((i) => (
        <View
          key={i}
          style={[styles.meterBar, { backgroundColor: i < bars ? color : colors.border }]}
        />
      ))}
      <Text style={styles.meterLabel}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  meter: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginTop: -4 },
  meterBar: { flex: 1, height: 4, borderRadius: radius.full },
  meterLabel: { color: colors.mutedForeground, fontSize: 13, marginLeft: spacing.sm, minWidth: 64 },
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
