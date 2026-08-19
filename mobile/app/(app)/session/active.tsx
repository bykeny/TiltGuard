/**
 * Live session screen (§3.5, §3.6, §7).
 *
 * The state machine is server-authoritative: this screen renders whatever the
 * session store holds and reacts when it flips to `CooldownLocked`, whether
 * that came from the REST evaluation or a hub push.
 */
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ErrorBanner,
  PrimaryButton,
  RISK_PRESENTATION,
  RiskBadge,
} from '@/components/ui';
import { toErrorMessage } from '@/src/api/errors';
import { gameLabel, type MatchOutcome } from '@/src/api/sessions';
import { tiltHub, useHubStatus } from '@/src/realtime/tiltHub';
import { useSessionStore } from '@/src/stores/sessionStore';

function formatDuration(startedAt: string | null, now: number): string {
  if (!startedAt) {
    return '—';
  }

  const elapsedMs = now - new Date(startedAt).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) {
    return '—';
  }

  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (value: number) => value.toString().padStart(2, '0');

  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * Dependency-free 0-100 slider: the track measures itself, then taps and drags
 * map an x offset onto the value. Avoids pulling in a native slider package
 * for one control.
 */
function ScoreSlider({
  value,
  onChange,
  disabled,
}: {
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
}) {
  const widthRef = useRef(0);

  const handleLayout = (event: LayoutChangeEvent) => {
    widthRef.current = event.nativeEvent.layout.width;
  };

  const applyFromX = (x: number) => {
    if (disabled || widthRef.current <= 0) {
      return;
    }
    const ratio = Math.min(Math.max(x / widthRef.current, 0), 1);
    onChange(Math.round(ratio * 100));
  };

  return (
    <View
      className="h-11 justify-center"
      onLayout={handleLayout}
      accessibilityRole="adjustable"
      accessibilityLabel="Performance score"
      accessibilityValue={{ min: 0, max: 100, now: value }}
      onStartShouldSetResponder={() => !disabled}
      onMoveShouldSetResponder={() => !disabled}
      onResponderGrant={(event) => applyFromX(event.nativeEvent.locationX)}
      onResponderMove={(event) => applyFromX(event.nativeEvent.locationX)}>
      <View className="h-2 overflow-hidden rounded-full bg-slate-800">
        <View className="h-full rounded-full bg-emerald-500" style={{ width: `${value}%` }} />
      </View>
      <View
        className="absolute h-5 w-5 rounded-full border-2 border-emerald-300 bg-slate-950"
        style={{ left: `${value}%`, marginLeft: -10 }}
        pointerEvents="none"
      />
    </View>
  );
}

function TiltScale({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  disabled: boolean;
}) {
  return (
    <View>
      <Text className="mb-2 text-xs font-medium uppercase tracking-widest text-slate-500">
        {label}
      </Text>
      <View className="flex-row gap-2">
        {[1, 2, 3, 4, 5].map((level) => {
          const isSelected = level === value;
          return (
            <Pressable
              key={level}
              disabled={disabled}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={`${label} ${level}`}
              onPress={() => onChange(level)}
              className={`h-12 flex-1 items-center justify-center rounded-xl border ${
                isSelected
                  ? 'border-emerald-400/60 bg-emerald-500/15'
                  : 'border-white/10 bg-slate-900/60 active:bg-slate-900'
              }`}>
              <Text
                className={`text-base font-semibold ${
                  isSelected ? 'text-emerald-300' : 'text-slate-400'
                }`}>
                {level}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

export default function ActiveSessionScreen() {
  const insets = useSafeAreaInsets();

  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const gameType = useSessionStore((state) => state.gameType);
  const sessionState = useSessionStore((state) => state.sessionState);
  const latestAlert = useSessionStore((state) => state.latestAlert);
  const matchesLogged = useSessionStore((state) => state.matchesLogged);
  const isBusy = useSessionStore((state) => state.isBusy);
  const logMatch = useSessionStore((state) => state.logMatch);
  const endSession = useSessionStore((state) => state.endSession);
  const startedAt = useSessionStore((state) => state.startedAt);

  const hubStatus = useHubStatus((state) => state.status);

  const [now, setNow] = useState(() => Date.now());
  const [isSheetRequested, setSheetRequested] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [outcome, setOutcome] = useState<MatchOutcome>('loss');
  const [performanceScore, setPerformanceScore] = useState(50);
  const [preTilt, setPreTilt] = useState(3);
  const [postTilt, setPostTilt] = useState(3);

  // One shared ticker drives the duration readout.
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // The lock can engage from either input path; this is the single place that
  // reacts to it, so REST and hub pushes converge on one navigation.
  useEffect(() => {
    if (sessionState === 'CooldownLocked') {
      router.replace('/session/cooldown');
    }
  }, [sessionState]);

  // Guard against landing here with no session (deep link, or after an end).
  useEffect(() => {
    if (!activeSessionId) {
      router.replace('/');
    }
  }, [activeSessionId]);

  const duration = useMemo(() => formatDuration(startedAt, now), [startedAt, now]);

  // Derived, not stored: a lock engaging must close the sheet without an
  // effect writing state back into render.
  const isSheetOpen = isSheetRequested && sessionState !== 'CooldownLocked';

  const handleLogMatch = useCallback(async () => {
    setErrorMessage(null);
    try {
      await logMatch({
        matchOutcome: outcome,
        performanceScore,
        preMatchTiltLevel: preTilt,
        postMatchTiltLevel: postTilt,
      });
      setSheetRequested(false);
    } catch (error) {
      // A 423 already flipped the store to CooldownLocked; the effect above
      // takes over, so only non-lock failures need to be shown here.
      if (useSessionStore.getState().sessionState !== 'CooldownLocked') {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }, [logMatch, outcome, performanceScore, preTilt, postTilt]);

  const handleEndSession = useCallback(async () => {
    setErrorMessage(null);
    const sessionId = activeSessionId;

    try {
      await endSession();
      if (sessionId) {
        await tiltHub.leaveSession(sessionId);
      }
      await tiltHub.stop();
      router.replace('/');
    } catch (error) {
      if (useSessionStore.getState().sessionState !== 'CooldownLocked') {
        setErrorMessage(toErrorMessage(error));
      }
    }
  }, [activeSessionId, endSession]);

  const risk = latestAlert?.riskFlag ?? 'stable';
  const preset = RISK_PRESENTATION[risk];

  return (
    <View className="flex-1 bg-slate-950">
      <StatusBar style="light" />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 24,
        }}
        showsVerticalScrollIndicator={false}>
        <View className="flex-row items-start justify-between">
          <View className="flex-1">
            <Text className="text-xs font-medium uppercase tracking-widest text-slate-500">
              Active session
            </Text>
            <Text className="mt-1.5 text-3xl font-bold tracking-tight text-white">
              {gameLabel(gameType)}
            </Text>
          </View>
          <View className="items-end">
            <Text className="font-mono text-2xl font-semibold tabular-nums text-slate-200">
              {duration}
            </Text>
            <Text className="mt-1 text-[11px] uppercase tracking-wider text-slate-600">
              {hubStatus === 'connected' ? 'Live' : hubStatus}
            </Text>
          </View>
        </View>

        {/* Tilt gauge */}
        <View className="mt-8 rounded-3xl border border-white/5 bg-slate-900/50 p-6">
          <View className="flex-row items-center justify-between">
            <Text className="text-xs font-medium uppercase tracking-widest text-slate-500">
              Tilt coefficient
            </Text>
            <RiskBadge risk={risk} />
          </View>

          <Text
            className="mt-4 text-6xl font-bold tracking-tight"
            style={{ color: preset.hex }}>
            {(latestAlert?.tiltCoefficient ?? 0).toFixed(2)}
          </Text>

          {/* Linear gauge — the coefficient is already normalised 0..1. */}
          <View className="mt-5 h-2 overflow-hidden rounded-full bg-slate-800">
            <View
              className="h-full rounded-full"
              style={{
                width: `${Math.min(Math.max((latestAlert?.tiltCoefficient ?? 0) * 100, 0), 100)}%`,
                backgroundColor: preset.hex,
              }}
            />
          </View>

          <View className="mt-5 flex-row justify-between">
            <View>
              <Text className="text-xs uppercase tracking-wider text-slate-600">Matches</Text>
              <Text className="mt-1 text-lg font-semibold text-slate-200">{matchesLogged}</Text>
            </View>
            <View>
              <Text className="text-xs uppercase tracking-wider text-slate-600">Streak</Text>
              <Text className="mt-1 text-lg font-semibold text-slate-200">
                {latestAlert?.consecutiveLosses ?? 0}L
              </Text>
            </View>
            <View>
              <Text className="text-xs uppercase tracking-wider text-slate-600">Trajectory</Text>
              <Text className="mt-1 text-lg font-semibold text-slate-200">
                {latestAlert ? latestAlert.tiltTrajectory.toFixed(1) : '0.0'}
              </Text>
            </View>
          </View>
        </View>

        <View className="mt-6">
          <ErrorBanner message={errorMessage} />
        </View>

        <View className="mt-2 gap-3">
          <PrimaryButton
            label="Log match"
            onPress={() => setSheetRequested(true)}
            disabled={sessionState === 'CooldownLocked'}
          />
          <PrimaryButton
            label="End session"
            tone="danger"
            onPress={handleEndSession}
            busy={isBusy && !isSheetOpen}
          />
        </View>

        <Text className="mt-6 text-center text-xs leading-5 text-slate-600">
          Ending a session is blocked while a mandatory cooldown is unresolved.
        </Text>
      </ScrollView>

      {/* Match logging bottom sheet */}
      <Modal
        visible={isSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setSheetRequested(false)}>
        <View className="flex-1 justify-end bg-black/60">
          <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
            <View
              className="rounded-t-3xl border-t border-white/10 bg-slate-900 px-6 pt-5"
              style={{ paddingBottom: insets.bottom + 24 }}>
              <View className="mb-6 h-1 w-10 self-center rounded-full bg-slate-700" />

              <View className="flex-row items-center justify-between">
                <Text className="text-xl font-bold tracking-tight text-white">Log match</Text>
                <Pressable
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Close"
                  onPress={() => setSheetRequested(false)}>
                  <Text className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                    Cancel
                  </Text>
                </Pressable>
              </View>

              {/* Outcome */}
              <Text className="mb-2 mt-6 text-xs font-medium uppercase tracking-widest text-slate-500">
                Outcome
              </Text>
              <View className="flex-row gap-3">
                {(['win', 'loss'] as MatchOutcome[]).map((option) => {
                  const isSelected = option === outcome;
                  const selectedTone =
                    option === 'win'
                      ? 'border-emerald-400/60 bg-emerald-500/15'
                      : 'border-red-500/50 bg-red-500/15';
                  const selectedText =
                    option === 'win' ? 'text-emerald-300' : 'text-red-300';

                  return (
                    <Pressable
                      key={option}
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      onPress={() => setOutcome(option)}
                      className={`h-14 flex-1 items-center justify-center rounded-2xl border ${
                        isSelected
                          ? selectedTone
                          : 'border-white/10 bg-slate-950/40 active:bg-slate-950'
                      }`}>
                      <Text
                        className={`text-base font-semibold uppercase tracking-wide ${
                          isSelected ? selectedText : 'text-slate-400'
                        }`}>
                        {option}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Performance */}
              <View className="mb-2 mt-6 flex-row items-center justify-between">
                <Text className="text-xs font-medium uppercase tracking-widest text-slate-500">
                  Performance
                </Text>
                <Text className="text-sm font-semibold tabular-nums text-slate-200">
                  {performanceScore}
                </Text>
              </View>
              <ScoreSlider
                value={performanceScore}
                onChange={setPerformanceScore}
                disabled={isBusy}
              />

              <View className="mt-6">
                <TiltScale
                  label="Pre-match tilt"
                  value={preTilt}
                  onChange={setPreTilt}
                  disabled={isBusy}
                />
              </View>

              <View className="mt-6">
                <TiltScale
                  label="Post-match tilt"
                  value={postTilt}
                  onChange={setPostTilt}
                  disabled={isBusy}
                />
              </View>

              <View className="mt-8">
                <PrimaryButton label="Submit match" onPress={handleLogMatch} busy={isBusy} />
              </View>
            </View>
          </KeyboardAvoidingView>
        </View>
      </Modal>
    </View>
  );
}
