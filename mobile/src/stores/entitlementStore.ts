/**
 * Entitlement store (§6.5).
 *
 * Mirrors the server's view of what this account has paid for. Every premium
 * gate in the UI reads from here, never from the JWT's `premium` claim — that
 * claim is a snapshot taken at login on a 15-minute token, so a purchase made
 * mid-session would not appear until the next refresh.
 */
import { create } from 'zustand';

import {
  getEntitlements,
  isEntitledStatus,
  type EntitlementFeatures,
  type PremiumStatus,
} from '@/src/api/entitlements';

const FREE_FEATURES: EntitlementFeatures = {
  unlimitedHistory: false,
  liveTelemetry: false,
  advancedAnalytics: false,
};

type EntitlementState = {
  premiumStatus: PremiumStatus;
  /** Derived from `premiumStatus` on every write — premium OR grace_period. */
  isPremium: boolean;
  features: EntitlementFeatures;
  entitlements: string[];
  isLoading: boolean;
  /** Null until the first successful sync; drives "never loaded" UI. */
  lastSyncedAt: string | null;

  fetchEntitlements: () => Promise<void>;
  reset: () => void;
};

const FREE_STATE = {
  premiumStatus: 'free' as PremiumStatus,
  isPremium: false,
  features: FREE_FEATURES,
  entitlements: [] as string[],
  isLoading: false,
  lastSyncedAt: null,
};

export const useEntitlementStore = create<EntitlementState>((set) => ({
  ...FREE_STATE,

  fetchEntitlements: async () => {
    set({ isLoading: true });
    try {
      const result = await getEntitlements();

      set({
        premiumStatus: result.premiumStatus,
        isPremium: isEntitledStatus(result.premiumStatus),
        features: result.features,
        entitlements: result.entitlements,
        lastSyncedAt: new Date().toISOString(),
      });
    } catch (error) {
      // A failed sync must not revoke access the user already has: a network
      // blip would otherwise flash the paywall at a paying subscriber. Keep the
      // last known state and let the next sync correct it.
      console.warn('[entitlements] sync failed; keeping last known state:', error);
    } finally {
      set({ isLoading: false });
    }
  },

  reset: () => set({ ...FREE_STATE }),
}));
