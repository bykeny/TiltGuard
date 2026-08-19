/**
 * Dashboard (§7): user status, game picker, and the session entry point.
 *
 * "Start Session" is the composition point for the whole realtime flow —
 * REST start, hub connect, group join, then navigate.
 */
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  AmbientGlow,
  BrandMark,
  ErrorBanner,
  PrimaryButton,
  RISK_PRESENTATION,
  RiskBadge,
} from '@/components/ui';
import { toErrorMessage } from '@/src/api/errors';
import { readIdentity } from '@/src/api/jwt';
import { GAME_CATALOG, gameLabel, type GameType } from '@/src/api/sessions';
import { tiltHub, useHubStatus } from '@/src/realtime/tiltHub';
import { useAuthStore } from '@/src/stores/authStore';
import { useSessionStore } from '@/src/stores/sessionStore';

const HUB_STATUS_COPY: Record<string, { label: string; dot: string }> = {
  connected: { label: 'Live', dot: 'bg-emerald-400' },
  connecting: { label: 'Connecting', dot: 'bg-amber-400' },
  reconnecting: { label: 'Reconnecting', dot: 'bg-amber-400' },
  disconnected: { label: 'Offline', dot: 'bg-slate-600' },
};

export default function DashboardScreen() {
  const insets = useSafeAreaInsets();

  const accessToken = useAuthStore((state) => state.accessToken);
  const logout = useAuthStore((state) => state.logout);
  const identity = useMemo(() => readIdentity(accessToken), [accessToken]);

  const startSession = useSessionStore((state) => state.startSession);
  const activeSessionId = useSessionStore((state) => state.activeSessionId);
  const activeGameType = useSessionStore((state) => state.gameType);
  const latestAlert = useSessionStore((state) => state.latestAlert);
  const isBusy = useSessionStore((state) => state.isBusy);

  const hubStatus = useHubStatus((state) => state.status);

  const [selectedGame, setSelectedGame] = useState<GameType>('cs2');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleStart = useCallback(async () => {
    setErrorMessage(null);

    try {
      // A 409 is absorbed by the store, which adopts the live session instead.
      await startSession(selectedGame);

      const sessionId = useSessionStore.getState().activeSessionId;
      if (!sessionId) {
        setErrorMessage('Could not open a session. Please try again.');
        return;
      }

      // Realtime is best-effort: `start` swallows its own failures so a hub
      // outage cannot block a session the server already opened.
      await tiltHub.start();
      await tiltHub.joinSession(sessionId);

      router.push('/session/active');
    } catch (error) {
      setErrorMessage(toErrorMessage(error));
    }
  }, [selectedGame, startSession]);

  const handleResume = useCallback(() => {
    router.push('/session/active');
  }, []);

  const status = HUB_STATUS_COPY[hubStatus] ?? HUB_STATUS_COPY.disconnected;

  return (
    <View className="flex-1 bg-slate-950">
      <StatusBar style="light" />
      <AmbientGlow />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 32,
          paddingHorizontal: 24,
        }}
        showsVerticalScrollIndicator={false}>
        <View className="flex-row items-center justify-between">
          <BrandMark />
          <View className="flex-row items-center gap-2 rounded-full border border-white/5 bg-slate-900/60 px-3 py-1.5">
            <View className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
            <Text className="text-[11px] font-medium uppercase tracking-wider text-slate-400">
              {status.label}
            </Text>
          </View>
        </View>

        {/* Identity + entitlement, read straight from the access token claims. */}
        <View className="mt-8 rounded-3xl border border-white/5 bg-slate-900/50 p-5">
          <Text className="text-xs font-medium uppercase tracking-widest text-slate-500">
            Signed in as
          </Text>
          <Text className="mt-2 text-lg font-semibold text-slate-100" numberOfLines={1}>
            {identity.email ?? 'Player'}
          </Text>

          <View className="mt-4 flex-row items-center justify-between">
            <View className="flex-row items-center gap-2 self-start rounded-full border border-white/10 bg-white/5 px-3 py-1.5">
              <Text className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                {identity.premiumStatus ?? 'Free'}
              </Text>
            </View>
            <Pressable
              hitSlop={8}
              accessibilityRole="button"
              onPress={() => {
                // The root layout resets session state off the auth flip.
                void logout();
              }}>
              <Text className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                Sign out
              </Text>
            </Pressable>
          </View>
        </View>

        {/* Last evaluation, if the session already produced one. */}
        {latestAlert ? (
          <View className="mt-4 rounded-3xl border border-white/5 bg-slate-900/50 p-5">
            <View className="flex-row items-center justify-between">
              <Text className="text-xs font-medium uppercase tracking-widest text-slate-500">
                Latest read
              </Text>
              <RiskBadge risk={latestAlert.riskFlag} />
            </View>

            <View className="mt-4 flex-row items-end gap-2">
              <Text
                className="text-4xl font-bold tracking-tight"
                style={{ color: RISK_PRESENTATION[latestAlert.riskFlag].hex }}>
                {latestAlert.tiltCoefficient.toFixed(2)}
              </Text>
              <Text className="mb-1.5 text-sm text-slate-500">tilt coefficient</Text>
            </View>

            <Text className="mt-2 text-sm text-slate-400">
              {latestAlert.consecutiveLosses} consecutive{' '}
              {latestAlert.consecutiveLosses === 1 ? 'loss' : 'losses'}
            </Text>
          </View>
        ) : null}

        <ErrorBanner message={errorMessage} />

        {activeSessionId ? (
          /* A session is already open — resuming beats starting a second one,
             which the server would reject with 409 anyway. */
          <View className="mt-4 rounded-3xl border border-emerald-400/20 bg-emerald-500/5 p-5">
            <Text className="text-xs font-medium uppercase tracking-widest text-emerald-400/70">
              Session in progress
            </Text>
            <Text className="mt-2 text-lg font-semibold text-slate-100">
              {gameLabel(activeGameType)}
            </Text>
            <View className="mt-5">
              <PrimaryButton label="Resume session" onPress={handleResume} />
            </View>
          </View>
        ) : (
          <>
            <Text className="mb-4 mt-8 text-xs font-medium uppercase tracking-widest text-slate-500">
              Pick your game
            </Text>

            <View className="flex-row flex-wrap gap-3">
              {GAME_CATALOG.map((game) => {
                const isSelected = game.id === selectedGame;
                return (
                  <Pressable
                    key={game.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setSelectedGame(game.id)}
                    className={`min-w-[30%] flex-1 basis-[30%] rounded-2xl border px-3 py-4 ${
                      isSelected
                        ? 'border-emerald-400/60 bg-emerald-500/10'
                        : 'border-white/5 bg-slate-900/50 active:bg-slate-900'
                    }`}>
                    <Text
                      className={`text-base font-bold tracking-tight ${
                        isSelected ? 'text-emerald-300' : 'text-slate-300'
                      }`}>
                      {game.short}
                    </Text>
                    <Text
                      className={`mt-1 text-[11px] leading-4 ${
                        isSelected ? 'text-emerald-400/70' : 'text-slate-500'
                      }`}
                      numberOfLines={2}>
                      {game.label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>

            <View className="mt-8">
              <PrimaryButton
                label={`Start ${gameLabel(selectedGame)} session`}
                onPress={handleStart}
                busy={isBusy}
              />
            </View>

            <Text className="mt-4 text-center text-xs leading-5 text-slate-600">
              TiltGuard watches your last five matches and enforces a cooldown
              when the streak turns.
            </Text>
          </>
        )}
      </ScrollView>
    </View>
  );
}
