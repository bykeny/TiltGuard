/**
 * Registration screen (§3.1).
 *
 * On 201 the token pair goes into the auth store exactly as login does, so the
 * root route guard performs the transition into `(app)`.
 */
import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AmbientGlow,
  BrandMark,
  ErrorBanner,
  FieldLabel,
  PrimaryButton,
  TextField,
} from '@/components/ui';
import { register as registerRequest } from '@/src/api/auth';
import { API_BASE_URL } from '@/src/api/config';
import { toErrorMessage } from '@/src/api/errors';
import { useAuthStore } from '@/src/stores/authStore';

type Field = 'email' | 'password';

/** §3.1: 10-128 chars, at least one uppercase letter and one digit. */
function passwordRules(password: string) {
  return [
    { key: 'length', label: 'At least 10 characters', met: password.length >= 10 && password.length <= 128 },
    { key: 'upper', label: 'One uppercase letter', met: /[A-Z]/.test(password) },
    { key: 'digit', label: 'One number', met: /\d/.test(password) },
  ];
}

export default function RegisterScreen() {
  const authenticate = useAuthStore((state) => state.login);
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [focused, setFocused] = useState<Field | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  const rules = useMemo(() => passwordRules(password), [password]);
  const passwordValid = rules.every((rule) => rule.met);
  const emailValid = /^\S+@\S+\.\S+$/.test(email.trim());
  const canSubmit = emailValid && passwordValid && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }

    Keyboard.dismiss();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const tokens = await registerRequest({ email, password });
      await authenticate(tokens.accessToken, tokens.refreshToken);
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
      setPassword('');
    } finally {
      setIsSubmitting(false);
    }
  }, [authenticate, canSubmit, email, password]);

  return (
    <View className="flex-1 bg-slate-950">
      <StatusBar style="light" />
      <AmbientGlow />

      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{
            flexGrow: 1,
            paddingTop: insets.top + 48,
            paddingBottom: insets.bottom + 32,
            paddingHorizontal: 24,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <BrandMark />

          <View className="mt-12">
            <Text className="text-4xl font-bold leading-tight tracking-tight text-white">
              Create account
            </Text>
            <Text className="mt-3 text-base leading-6 text-slate-400">
              Track your tilt across every session and let TiltGuard call the
              breaks before a losing streak does.
            </Text>
          </View>

          <View className="mt-10 rounded-3xl border border-white/5 bg-slate-900/50 p-5">
            <ErrorBanner message={errorMessage} />

            <FieldLabel>Email</FieldLabel>
            <TextField
              isFocused={focused === 'email'}
              value={email}
              onChangeText={setEmail}
              onFocus={() => setFocused('email')}
              onBlur={() => setFocused(null)}
              placeholder="player@example.com"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              editable={!isSubmitting}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />

            <View className="mt-6" />
            <FieldLabel>Password</FieldLabel>
            <View className="justify-center">
              <TextField
                ref={passwordRef}
                isFocused={focused === 'password'}
                className="pr-20"
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocused('password')}
                onBlur={() => setFocused(null)}
                placeholder="Choose a strong password"
                secureTextEntry={!revealPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="new-password"
                textContentType="newPassword"
                returnKeyType="go"
                editable={!isSubmitting}
                onSubmitEditing={handleSubmit}
              />
              <Pressable
                className="absolute right-3 rounded-lg px-2.5 py-1.5 active:bg-white/5"
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={revealPassword ? 'Hide password' : 'Show password'}
                onPress={() => setRevealPassword((visible) => !visible)}>
                <Text className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                  {revealPassword ? 'Hide' : 'Show'}
                </Text>
              </Pressable>
            </View>

            {/* Live requirement checklist — the server rejects on the same three
                rules, so showing them up front avoids a round trip. */}
            <View className="mt-4 gap-2">
              {rules.map((rule) => (
                <View key={rule.key} className="flex-row items-center gap-2.5">
                  <View
                    className={`h-1.5 w-1.5 rounded-full ${
                      rule.met ? 'bg-emerald-400' : 'bg-slate-700'
                    }`}
                  />
                  <Text
                    className={`text-xs ${rule.met ? 'text-emerald-300/80' : 'text-slate-500'}`}>
                    {rule.label}
                  </Text>
                </View>
              ))}
            </View>

            <View className="mt-8">
              <PrimaryButton
                label="Create account"
                onPress={handleSubmit}
                disabled={!canSubmit}
                busy={isSubmitting}
              />
            </View>
          </View>

          <View className="mt-8 flex-row items-center justify-center gap-1.5">
            <Text className="text-sm text-slate-500">Already have an account?</Text>
            <Link href="/login" replace asChild>
              <Pressable hitSlop={8} accessibilityRole="link">
                <Text className="text-sm font-semibold text-emerald-400">Sign in</Text>
              </Pressable>
            </Link>
          </View>

          <View className="flex-1" />

          <Text className="mt-10 text-center text-xs leading-5 text-slate-600">
            Tokens are held in your device&apos;s hardware-backed keystore.
          </Text>

          {__DEV__ ? (
            <Text className="mt-2 text-center text-[11px] text-slate-700">
              API · {API_BASE_URL}
            </Text>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
