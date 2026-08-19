/**
 * Mandatory cooldown lockdown (§5.4, §7).
 *
 * Non-dismissable by construction: no header, no back affordance, the Android
 * hardware back press is swallowed, and the stack disables the swipe gesture.
 * The only exits are `CooldownLockReleased` from the hub or the server-side
 * watchdog releasing the lock on expiry — the client never unlocks itself.
 */
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BackHandler, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { DEFAULT_COOLDOWN_SECONDS } from '@/src/api/sessions';
import { tiltHub } from '@/src/realtime/tiltHub';
import { useSessionStore } from '@/src/stores/sessionStore';

/** Box breathing: 4s inhale, 4s hold, 4s exhale, 4s hold. */
const PHASE_MS = 4000;
const CYCLE_MS = PHASE_MS * 4;

const PHASES = [
  { label: 'Breathe in', hint: 'Fill your lungs' },
  { label: 'Hold', hint: 'Stay with it' },
  { label: 'Breathe out', hint: 'Let it go' },
  { label: 'Hold', hint: 'Empty and still' },
] as const;

function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

export default function CooldownScreen() {
  const insets = useSafeAreaInsets();

  const sessionState = useSessionStore((state) => state.sessionState);
  const cooldownLock = useSessionStore((state) => state.cooldownLock);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);

  // Anchored once at mount: both the breathing cycle and the fallback expiry
  // read from it, so neither drifts when the component re-renders.
  const [mountedAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const complianceSentRef = useRef(false);

  const expiresAtUtc = cooldownLock?.expiresAtUtc ?? null;
  const cooldownId = cooldownLock?.cooldownId ?? null;

  // Absolute expiry, so a backgrounded app resumes with the correct remainder
  // instead of a paused local counter.
  const expiresAt = useMemo(() => {
    if (expiresAtUtc) {
      const parsed = new Date(expiresAtUtc).getTime();
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return mountedAt + DEFAULT_COOLDOWN_SECONDS * 1000;
  }, [expiresAtUtc, mountedAt]);

  const remainingMs = Math.max(0, expiresAt - now);
  const totalMs = DEFAULT_COOLDOWN_SECONDS * 1000;
  const elapsedRatio = Math.min(1, Math.max(0, 1 - remainingMs / totalMs));

  // Swallow the Android hardware back press for as long as this screen lives.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(interval);
  }, []);

  // The server is the authority on release. When the store stops reporting a
  // lock, the screen steps aside.
  useEffect(() => {
    if (sessionState !== 'CooldownLocked') {
      router.replace(activeSessionId ? '/session/active' : '/');
    }
  }, [sessionState, activeSessionId]);

  // Tell the server the flow completed once the wall-clock window has passed
  // (§4.3 re-verifies elapsed time server-side; this only ever accelerates the
  // release the watchdog would perform on its next tick).
  useEffect(() => {
    if (remainingMs > 0 || complianceSentRef.current || !cooldownId) {
      return;
    }
    complianceSentRef.current = true;
    void tiltHub.confirmCooldownCompliance(cooldownId);
  }, [remainingMs, cooldownId]);

  const phaseIndex = Math.floor(((now - mountedAt) % CYCLE_MS) / PHASE_MS);
  const phase = PHASES[phaseIndex] ?? PHASES[0];

  // Breathing coach. One 16s sequence, repeated forever; the two holds are
  // timings to the value the circle already sits at.
  const scale = useSharedValue(0.62);
  const glow = useSharedValue(0.25);

  useEffect(() => {
    const easing = Easing.inOut(Easing.ease);

    scale.value = withRepeat(
      withSequence(
        withTiming(1, { duration: PHASE_MS, easing }),
        withTiming(1, { duration: PHASE_MS }),
        withTiming(0.62, { duration: PHASE_MS, easing }),
        withTiming(0.62, { duration: PHASE_MS })
      ),
      -1,
      false
    );

    glow.value = withRepeat(
      withSequence(
        withTiming(0.6, { duration: PHASE_MS, easing }),
        withTiming(0.6, { duration: PHASE_MS }),
        withTiming(0.25, { duration: PHASE_MS, easing }),
        withTiming(0.25, { duration: PHASE_MS })
      ),
      -1,
      false
    );
  }, [scale, glow]);

  const circleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glow.value,
    transform: [{ scale: scale.value * 1.18 }],
  }));

  return (
    <View className="flex-1 bg-slate-950">
      <StatusBar style="light" />

      {/* High-intensity red wash behind the lockdown. */}
      <View className="absolute -top-32 left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-red-600/15" />
      <View className="absolute bottom-[-120px] left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-red-500/5" />

      <View
        className="flex-1 items-center px-6"
        style={{ paddingTop: insets.top + 32, paddingBottom: insets.bottom + 32 }}>
        <View className="flex-row items-center gap-2 self-center rounded-full border border-red-500/40 bg-red-500/10 px-4 py-2">
          <View className="h-2 w-2 rounded-full bg-red-400" />
          <Text className="text-xs font-bold uppercase tracking-[0.2em] text-red-300">
            Cooldown locked
          </Text>
        </View>

        <Text className="mt-8 text-center text-2xl font-bold leading-8 tracking-tight text-white">
          {cooldownLock?.coachMessage ?? 'Step away from the queue.'}
        </Text>

        {/* Breathing coach */}
        <View className="my-auto items-center justify-center">
          <View className="h-64 w-64 items-center justify-center">
            <Animated.View style={glowStyle}>
              <View className="h-56 w-56 rounded-full bg-red-500/20" />
            </Animated.View>

            <Animated.View style={[circleStyle, { position: 'absolute' }]}>
              <View className="h-48 w-48 items-center justify-center rounded-full border-2 border-red-400/50 bg-red-500/10">
                <Text className="text-xl font-semibold tracking-tight text-red-100">
                  {phase.label}
                </Text>
                <Text className="mt-1.5 text-xs uppercase tracking-widest text-red-300/60">
                  {phase.hint}
                </Text>
              </View>
            </Animated.View>
          </View>

          <Text className="mt-6 text-xs uppercase tracking-[0.2em] text-slate-600">
            Box breathing · 4-4-4-4
          </Text>
        </View>

        {/* Countdown */}
        <View className="w-full items-center">
          <Text className="font-mono text-6xl font-bold tabular-nums tracking-tight text-white">
            {formatCountdown(remainingMs)}
          </Text>

          <View className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <View
              className="h-full rounded-full bg-red-500"
              style={{ width: `${elapsedRatio * 100}%` }}
            />
          </View>

          <Text className="mt-5 text-center text-sm leading-5 text-slate-500">
            {remainingMs > 0
              ? 'This lock cannot be dismissed. Matches stay blocked until it clears.'
              : 'Time served — waiting for the server to release the lock.'}
          </Text>
        </View>
      </View>
    </View>
  );
}
