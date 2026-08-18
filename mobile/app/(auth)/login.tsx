/**
 * Sign-in screen (§3.2, §7).
 *
 * On a 200 the token pair goes straight into the Zustand store, which persists
 * it to secure storage and flips `isAuthenticated`. The root layout's route
 * guard does the navigating — this screen never calls `router.replace` itself.
 */
import { StatusBar } from 'expo-status-bar';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
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

import { ApiError, login as loginRequest } from '@/src/api/auth';
import { API_BASE_URL } from '@/src/api/config';
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
      const message =
        error instanceof ApiError
          ? error.message
          : 'Something went wrong. Please try again.';
      setErrorMessage(message);
      setPassword('');
    } finally {
      setIsSubmitting(false);
    }
  }, [authenticate, canSubmit, email, password]);

  const fieldClasses = (field: Field) =>
    [
      'rounded-2xl border px-4 py-3.5 text-base text-slate-100',
      focused === field
        ? 'border-emerald-400/70 bg-slate-900'
        : 'border-white/10 bg-slate-900/60',
    ].join(' ');

  return (
    <View className="flex-1 bg-slate-950">
      <StatusBar style="light" />

      {/* Ambient depth: soft emerald discs bleeding off the top edge. */}
      <View className="absolute -left-16 -top-24 h-72 w-72 rounded-full bg-emerald-500/10" />
      <View className="absolute -top-10 right-[-70px] h-56 w-56 rounded-full bg-emerald-400/5" />

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
          {/* Brand */}
          <View className="flex-row items-center gap-3">
            <View className="h-10 w-10 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10">
              <View className="h-4 w-4 rounded bg-emerald-400" />
            </View>
            <Text className="text-lg font-semibold tracking-tight text-slate-100">
              TiltGuard
            </Text>
          </View>

          {/* Headline */}
          <View className="mt-12">
            <Text className="text-4xl font-bold leading-tight tracking-tight text-white">
              Welcome back
            </Text>
            <Text className="mt-3 text-base leading-6 text-slate-400">
              Sign in to keep your sessions honest — live tilt tracking and
              enforced cooldowns.
            </Text>
          </View>

          {/* Form card */}
          <View className="mt-10 rounded-3xl border border-white/5 bg-slate-900/50 p-5">
            {errorMessage ? (
              <View className="mb-5 flex-row items-start gap-3 rounded-2xl border border-red-500/30 bg-red-500/10 px-4 py-3">
                <View className="mt-1.5 h-2 w-2 rounded-full bg-red-400" />
                <Text className="flex-1 text-sm leading-5 text-red-300">
                  {errorMessage}
                </Text>
              </View>
            ) : null}

            <Text className="mb-2 text-xs font-medium uppercase tracking-widest text-slate-500">
              Email
            </Text>
            <TextInput
              className={fieldClasses('email')}
              value={email}
              onChangeText={setEmail}
              onFocus={() => setFocused('email')}
              onBlur={() => setFocused(null)}
              placeholder="player@example.com"
              placeholderTextColor="#475569"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType="next"
              editable={!isSubmitting}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />

            <Text className="mb-2 mt-6 text-xs font-medium uppercase tracking-widest text-slate-500">
              Password
            </Text>
            <View className="justify-center">
              <TextInput
                ref={passwordRef}
                className={`${fieldClasses('password')} pr-20`}
                value={password}
                onChangeText={setPassword}
                onFocus={() => setFocused('password')}
                onBlur={() => setFocused(null)}
                placeholder="Your password"
                placeholderTextColor="#475569"
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

            <Pressable
              className={`mt-8 h-14 flex-row items-center justify-center rounded-2xl ${
                canSubmit ? 'bg-emerald-500 active:bg-emerald-600' : 'bg-emerald-500/25'
              }`}
              disabled={!canSubmit}
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSubmit, busy: isSubmitting }}
              onPress={handleSubmit}>
              {isSubmitting ? (
                <ActivityIndicator color="#022c22" />
              ) : (
                <Text
                  className={`text-base font-semibold tracking-tight ${
                    canSubmit ? 'text-emerald-950' : 'text-emerald-100/50'
                  }`}>
                  Sign in
                </Text>
              )}
            </Pressable>
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
