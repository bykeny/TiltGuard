/**
 * Entitlements API (§6.5).
 *
 * The server's stored `premiumStatus` is the source of truth for every premium
 * gate (§6.1). The RevenueCat SDK's own `getCustomerInfo()` is only ever an
 * optimistic hint — a client that gated on it would trust the device over the
 * billing ledger.
 */
import { apiGet } from './client';

export type PremiumStatus = 'free' | 'premium' | 'grace_period' | 'expired';

export type EntitlementFeatures = {
  unlimitedHistory: boolean;
  liveTelemetry: boolean;
  advancedAnalytics: boolean;
};

export type EntitlementsResponse = {
  premiumStatus: PremiumStatus;
  entitlements: string[];
  features: EntitlementFeatures;
};

/** The entitlement identifier RevenueCat grants for a paid subscription (§6.1). */
export const PRO_ENTITLEMENT_ID = 'tiltguard_pro';

/** Free-tier history cap enforced server-side (§6.5); mirrored here for copy. */
export const FREE_HISTORY_LIMIT = 10;

const PREMIUM_STATUSES: PremiumStatus[] = ['free', 'premium', 'grace_period', 'expired'];

/**
 * `grace_period` still has access — that is the entire point of a grace period,
 * and it matches the server's `RequirePremium` definition (§6.5). Getting this
 * wrong would lock out a paying user over a transient billing hiccup.
 */
export function isEntitledStatus(status: PremiumStatus): boolean {
  return status === 'premium' || status === 'grace_period';
}

/** Fails closed: anything unrecognised is treated as `free`, never as premium. */
function normalizeStatus(value: unknown): PremiumStatus {
  return typeof value === 'string' && (PREMIUM_STATUSES as string[]).includes(value)
    ? (value as PremiumStatus)
    : 'free';
}

function normalizeFeatures(value: unknown, fallback: boolean): EntitlementFeatures {
  const source = (value ?? {}) as Partial<Record<keyof EntitlementFeatures, unknown>>;
  const read = (key: keyof EntitlementFeatures) =>
    typeof source[key] === 'boolean' ? (source[key] as boolean) : fallback;

  return {
    unlimitedHistory: read('unlimitedHistory'),
    liveTelemetry: read('liveTelemetry'),
    advancedAnalytics: read('advancedAnalytics'),
  };
}

/** GET /api/v1/me/entitlements. Throws `ApiError` on any non-200. */
export async function getEntitlements(): Promise<EntitlementsResponse> {
  const { data } = await apiGet<EntitlementsResponse>('/me/entitlements');

  const premiumStatus = normalizeStatus(data?.premiumStatus);
  const entitled = isEntitledStatus(premiumStatus);

  return {
    premiumStatus,
    entitlements: Array.isArray(data?.entitlements)
      ? data.entitlements.filter((id): id is string => typeof id === 'string')
      : [],
    // If the server ever omits a flag, derive it from the status rather than
    // defaulting to `true` and handing out a feature nobody paid for.
    features: normalizeFeatures(data?.features, entitled),
  };
}
