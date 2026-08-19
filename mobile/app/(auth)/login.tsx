/**
 * Sign-in screen (§3.2, §7).
 *
 * On a 200 the token pair goes straight into the Zustand store, which persists
 * it to secure storage and flips `isAuthenticated`. The root layout's route
 * guard does the navigating — this screen never calls `router.replace` itself.
 */
import { Link } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useRef, useState } from 'react';
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
import { login as loginRequest } from '@/src/api/auth';
import { API_BASE_URL } from '@/src/api/config';
import { toErrorMessage } from '@/src/api/errors';
import { useAuthStore } from '@/src/stores/authStore';

type Field = 'email' | 'password';

export default function LoginScreen() {
  const authenticate = useAuthStore((state) => state.login);
  const insets = useSafeAreaInsets();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [focused, setFocused] = useState<Field | null>(null);
  const [revealPassword, setRevealPassword] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const passwordRef = useRef<TextInput>(null);

  const canSubmit = email.trim().length > 0 && password.length > 0 && !isSubmitting;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }

    Keyboard.dismiss();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      const tokens = await loginRequest({ email, password });
      // Hands off to the store; the route guard swaps the stack for us.
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
              Welcome back
            </Text>
            <Text className="mt-3 text-base leading-6 text-slate-400">
              Sign in to keep your sessions honest — live tilt tracking and
              enforced cooldowns.
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
                placeholder="Your password"
                secureTextEntry={!revealPassword}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="current-password"
                textContentType="password"
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

            <View className="mt-8">
              <PrimaryButton
                label="Sign in"
                onPress={handleSubmit}
                disabled={!canSubmit}
                busy={isSubmitting}
              />
            </View>
          </View>

          <View className="mt-8 flex-row items-center justify-center gap-1.5">
            <Text className="text-sm text-slate-500">New to TiltGuard?</Text>
            <Link href="/register" replace asChild>
              <Pressable hitSlop={8} accessibilityRole="link">
                <Text className="text-sm font-semibold text-emerald-400">Create account</Text>
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
