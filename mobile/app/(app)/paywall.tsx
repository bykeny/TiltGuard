/**
 * TiltGuard Pro paywall (§6.1, §6.5). Presented as a modal by the `(app)` stack.
 *
 * The store is the only thing that takes money and the RevenueCat webhook
 * (§6.2) is the only thing that grants access, so a resolved purchase here is
 * followed by a server entitlement re-sync — the screen never flips the user to
 * premium on its own.
 */
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorBanner, PrimaryButton } from '@/components/ui';
import {
  getPaywallPlans,
  isMockMode,
  purchasePlan,
  restorePurchases,
  type PaywallPlan,
} from '@/src/purchases/purchases';
import { useEntitlementStore } from '@/src/stores/entitlementStore';

const SELLING_POINTS = [
  {
    title: 'Real-Time Tilt Telemetry',
    body: 'Live coefficient tracking with predictive fatigue warnings before the streak turns.',
  },
  {
    title: 'Unlimited History & Analytics',
    body: 'Every match and tilt reading you have ever logged, not just the last ten.',
  },
  {
    title: 'Personalized Cooldown Protocols',
    body: 'Anti-tilt routines tuned to the patterns in your own sessions.',
  },
];

type Notice = { tone: 'error' | 'info'; message: string } | null;

/**
 * The paywall is normally pushed as a modal, but it can also be the entry route
 * (deep link, or a reload in dev). `back()` would be a no-op there, leaving the
 * user stuck on a sheet with no way out.
 */
function dismiss() {
  if (router.canGoBack()) {
    router.back();
  } else {
    router.replace('/');
  }
}

export default function PaywallScreen() {
  const insets = useSafeAreaInsets();

  const fetchEntitlements = useEntitlementStore((state) => state.fetchEntitlements);
  const isPremium = useEntitlementStore((state) => state.isPremium);

  const [plans, setPlans] = useState<PaywallPlan[]>([]);
  const [selectedId, setSelectedId] = useState<PaywallPlan['id']>('annual');
  const [isLoadingPlans, setLoadingPlans] = useState(true);
  const [isLivePricing, setLivePricing] = useState(false);
  const [isWorking, setWorking] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { plans: resolved, isLive } = await getPaywallPlans();
      if (cancelled) {
        return;
      }
      setPlans(resolved);
      setLivePricing(isLive);
      setLoadingPlans(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Covers both a purchase completing and an entitlement arriving from
  // elsewhere (a webhook landing while this sheet is open).
  useEffect(() => {
    if (isPremium) {
      dismiss();
    }
  }, [isPremium]);

  const selected = plans.find((plan) => plan.id === selectedId) ?? plans[0] ?? null;

  const handleUpgrade = useCallback(async () => {
    if (!selected) {
      return;
    }

    setNotice(null);
    setWorking(true);

    try {
      const outcome = await purchasePlan(selected);

      switch (outcome.status) {
        case 'purchased':
          // The webhook may not have landed yet; this pull is the fast path and
          // the effect above dismisses once the server agrees.
          await fetchEntitlements();
          if (!useEntitlementStore.getState().isPremium) {
            setNotice({
              tone: 'info',
              message: 'Payment received. Unlocking Pro — this can take a few seconds.',
            });
          }
          break;
        case 'cancelled':
          break;
        case 'unavailable':
          setNotice({ tone: 'info', message: outcome.message });
          break;
        case 'failed':
          setNotice({ tone: 'error', message: outcome.message });
          break;
      }
    } finally {
      setWorking(false);
    }
  }, [fetchEntitlements, selected]);

  const handleRestore = useCallback(async () => {
    setNotice(null);
    setWorking(true);

    try {
      const outcome = await restorePurchases();

      if (outcome.status === 'restored') {
        await fetchEntitlements();
        if (!useEntitlementStore.getState().isPremium) {
          setNotice({
            tone: 'info',
            message: outcome.hadEntitlements
              ? 'Purchase found. Syncing with your account — this can take a few seconds.'
              : 'No previous purchases found on this store account.',
          });
        }
      } else {
        setNotice({
          tone: outcome.status === 'failed' ? 'error' : 'info',
          message: outcome.message,
        });
      }
    } finally {
      setWorking(false);
    }
  }, [fetchEntitlements]);

  return (
    <View className="flex-1 bg-slate-950">
      <StatusBar style="light" />

      {/* Amber wash — the paywall is the one surface that reads warm. */}
      <View className="absolute -top-24 left-1/2 h-80 w-80 -translate-x-1/2 rounded-full bg-amber-500/10" />
      <View className="absolute -top-4 right-[-60px] h-56 w-56 rounded-full bg-emerald-400/5" />

      <ScrollView
        className="flex-1"
        contentContainerStyle={{
          paddingTop: insets.top + 16,
          paddingBottom: insets.bottom + 28,
          paddingHorizontal: 24,
        }}
        showsVerticalScrollIndicator={false}>
        <View className="flex-row justify-end">
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Close"
            className="h-9 w-9 items-center justify-center rounded-full bg-white/5 active:bg-white/10"
            onPress={dismiss}>
            <Text className="text-base leading-none text-slate-400">✕</Text>
          </Pressable>
        </View>

        <View className="mt-2 items-center">
          <View className="flex-row items-center gap-2 rounded-full border border-amber-400/30 bg-amber-500/10 px-3.5 py-1.5">
            <View className="h-1.5 w-1.5 rounded-full bg-amber-400" />
            <Text className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-300">
              TiltGuard Pro
            </Text>
          </View>

          <Text className="mt-5 text-center text-4xl font-bold leading-tight tracking-tight text-white">
            Unlock TiltGuard Pro
          </Text>
          <Text className="mt-3 text-center text-base leading-6 text-slate-400">
            Stop the tilt spiral before it costs you the next three matches.
          </Text>
        </View>

        {/* Selling points */}
        <View className="mt-9 gap-4">
          {SELLING_POINTS.map((point) => (
            <View key={point.title} className="flex-row gap-3.5">
              <View className="mt-0.5 h-6 w-6 items-center justify-center rounded-lg border border-emerald-400/30 bg-emerald-500/10">
                <Text className="text-xs font-bold text-emerald-400">✓</Text>
              </View>
              <View className="flex-1">
                <Text className="text-base font-semibold tracking-tight text-slate-100">
                  {point.title}
                </Text>
                <Text className="mt-1 text-sm leading-5 text-slate-500">{point.body}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Plan selector */}
        <View className="mt-9">
          {isLoadingPlans ? (
            <View className="h-[132px] items-center justify-center">
              <ActivityIndicator color="#fbbf24" />
            </View>
          ) : (
            <View className="gap-3">
              {plans.map((plan) => {
                const isSelected = plan.id === selected?.id;
                return (
                  <Pressable
                    key={plan.id}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isSelected }}
                    onPress={() => setSelectedId(plan.id)}
                    className={`flex-row items-center justify-between rounded-2xl border px-5 py-4 ${
                      isSelected
                        ? 'border-amber-400/70 bg-amber-500/10'
                        : 'border-white/10 bg-slate-900/60 active:bg-slate-900'
                    }`}>
                    <View className="flex-1">
                      <View className="flex-row items-center gap-2">
                        <Text
                          className={`text-base font-semibold tracking-tight ${
                            isSelected ? 'text-amber-100' : 'text-slate-200'
                          }`}>
                          {plan.title}
                        </Text>
                        {plan.badge ? (
                          <View className="rounded-full bg-emerald-500/20 px-2 py-0.5">
                            <Text className="text-[10px] font-bold uppercase tracking-wider text-emerald-300">
                              {plan.badge}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      {plan.footnote ? (
                        <Text className="mt-1 text-xs text-slate-500">{plan.footnote}</Text>
                      ) : null}
                    </View>

                    <View className="items-end pl-3">
                      <Text
                        className={`text-lg font-bold tracking-tight ${
                          isSelected ? 'text-white' : 'text-slate-300'
                        }`}>
                        {plan.priceLabel}
                      </Text>
                      <Text className="text-[11px] text-slate-500">{plan.periodLabel}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>

        {notice ? (
          <View className="mt-6">
            {notice.tone === 'error' ? (
              <ErrorBanner message={notice.message} />
            ) : (
              <View className="flex-row items-start gap-3 rounded-2xl border border-amber-400/25 bg-amber-500/10 px-4 py-3">
                <View className="mt-1.5 h-2 w-2 rounded-full bg-amber-400" />
                <Text className="flex-1 text-sm leading-5 text-amber-200">{notice.message}</Text>
              </View>
            )}
          </View>
        ) : null}

        <View className="mt-7">
          <PrimaryButton
            label="Upgrade Now"
            onPress={handleUpgrade}
            disabled={!selected || isLoadingPlans}
            busy={isWorking}
          />
        </View>

        <Pressable
          hitSlop={8}
          accessibilityRole="button"
          disabled={isWorking}
          onPress={handleRestore}
          className="mt-5 self-center">
          <Text className="text-sm font-semibold text-slate-400">Restore Purchases</Text>
        </Pressable>

        <Text className="mt-6 text-center text-xs leading-5 text-slate-600">
          Subscriptions renew automatically until cancelled. Manage or cancel in your
          {' '}store account settings.
        </Text>

        {__DEV__ && !isLivePricing ? (
          <Text className="mt-3 text-center text-[11px] leading-4 text-amber-500/60">
            {isMockMode()
              ? 'Mock mode · illustrative pricing, purchases disabled'
              : 'Fallback pricing · no live offering returned'}
          </Text>
        ) : null}
      </ScrollView>
    </View>
  );
}
