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

import { Toast } from '../ui/Toast';
import { useAuth } from '../auth/AuthProvider';
import { isAuthClientError } from '../auth/types';
import {
  EMAIL_MAX_LENGTH,
  PASSWORD_MAX_LENGTH,
  validateLogin,
  type LoginFieldErrors,
} from '../auth/validation';
import { IS_DEMO_MODE } from '../services';
import { colors, radius, spacing } from '../theme/colors';
import { Button } from '../ui/Button';
import { TextField } from '../ui/TextField';

/** User-facing copy per API error code. Never echoes server messages or credentials. */
export function loginErrorMessage(e: unknown): string {
  if (isAuthClientError(e)) {
    if (e.code === 'AUTH_FAILED' || e.code === 'UNAUTHENTICATED')
      return 'Invalid email or password.';
    if (e.code === 'RATE_LIMITED') return 'Too many attempts. Try again later.';
    if (e.code === 'FORBIDDEN')
      return 'This account has no organization yet. Ask an admin for an invite.';
  }
  return 'Something went wrong. Check your connection and try again.';
}

export function LoginScreen() {
  const { signIn } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<LoginFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const emailRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);

  const submit = async () => {
    if (submitting) return;
    const { ok, errors, credentials } = validateLogin({ email, password });
    setFieldErrors(errors);
    setFormError(null);
    if (!ok) {
      (errors.email ? emailRef : passwordRef).current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await signIn(credentials);
      // The (auth) guard redirects to the app once the state is signedIn.
    } catch (e) {
      setPassword('');
      setFormError(loginErrorMessage(e));
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.container}>
        <Text style={styles.title} accessibilityRole="header">
          Sign in to MeetOps
        </Text>
        <Text style={styles.subtitle}>Use your MeetOps work account.</Text>

        {IS_DEMO_MODE ? (
          <Text testID="demo-notice" style={styles.demo}>
            Demo mode: sign-in is simulated on this device. No data is sent anywhere.
          </Text>
        ) : null}

        <TextField
          ref={emailRef}
          testID="login-email"
          label="Email"
          value={email}
          onChangeText={setEmail}
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
          testID="login-password"
          label="Password"
          value={password}
          onChangeText={setPassword}
          error={fieldErrors.password}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="current-password"
          textContentType="password"
          maxLength={PASSWORD_MAX_LENGTH}
          returnKeyType="go"
          onSubmitEditing={() => void submit()}
          editable={!submitting}
        />

        <Button
          testID="login-submit"
          label="Sign in"
          onPress={() => void submit()}
          loading={submitting}
        />

        <View style={styles.switchRow}>
          <Text style={styles.switchPrompt}>New to MeetOps?</Text>
          <Pressable
            testID="login-to-signup"
            onPress={() => router.push('/signup')}
            accessibilityRole="link"
            hitSlop={8}
          >
            <Text style={styles.link}>Create an account</Text>
          </Pressable>
        </View>
      </View>
      <Toast testID="login-error" message={formError} onDismiss={() => setFormError(null)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: colors.background },
  container: { flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.xs },
  title: { color: colors.foreground, fontSize: 28, fontWeight: '700', marginBottom: 6 },
  subtitle: { color: colors.mutedForeground, fontSize: 15, marginBottom: spacing.xxl },
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
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.xs,
    marginTop: spacing.lg,
  },
  switchPrompt: { color: colors.mutedForeground, fontSize: 14 },
  link: { color: colors.link, fontSize: 14, fontWeight: '600' },
});
