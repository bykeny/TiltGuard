/**
 * Match history (§7).
 *
 * The history list itself is not built yet. What is wired here is the free-tier
 * boundary: §6.5 truncates history queries to the last 10 matches server-side,
 * so the UI states that limit up front rather than silently showing a short
 * list and letting the user assume matches were lost.
 */
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AmbientGlow } from '@/components/ui';
import { FREE_HISTORY_LIMIT } from '@/src/api/entitlements';
import { useEntitlementStore } from '@/src/stores/entitlementStore';

export default function HistoryScreen() {
  const insets = useSafeAreaInsets();
  const unlimitedHistory = useEntitlementStore((state) => state.features.unlimitedHistory);

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
        <Text className="text-3xl font-bold tracking-tight text-white">History</Text>
        <Text className="mt-3 text-base leading-6 text-slate-400">
          Every match you log feeds the five-match window the tilt engine scores.
        </Text>

        {unlimitedHistory ? (
          <View className="mt-8 rounded-3xl border border-emerald-400/20 bg-emerald-500/5 p-5">
            <Text className="text-xs font-medium uppercase tracking-widest text-emerald-400/70">
              Pro · Unlimited history
            </Text>
            <Text className="mt-2 text-sm leading-5 text-slate-400">
              Your full match and tilt archive is retained. The timeline view lands
              with the analytics slice.
            </Text>
          </View>
        ) : (
          <View className="mt-8 rounded-3xl border border-amber-400/25 bg-amber-500/[0.07] p-5">
            <View className="flex-row items-center gap-2">
              <View className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              <Text className="text-xs font-bold uppercase tracking-widest text-amber-300">
                Free tier
              </Text>
            </View>

            <Text className="mt-3 text-base font-semibold tracking-tight text-slate-100">
              Last {FREE_HISTORY_LIMIT} matches only
            </Text>
            <Text className="mt-2 text-sm leading-5 text-slate-400">
              Free accounts keep a rolling {FREE_HISTORY_LIMIT}-match window. Pro
              retains everything and unlocks trend analytics across it.
            </Text>

            <Pressable
              accessibilityRole="button"
              onPress={() => router.push('/paywall')}
              className="mt-5 h-12 items-center justify-center rounded-2xl bg-amber-500 active:bg-amber-600">
              <Text className="text-sm font-bold tracking-tight text-amber-950">
                Unlock unlimited history
              </Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
    </View>
  );
}
