/**
 * RevenueCat SDK lifecycle (§6.1).
 *
 * `react-native-purchases` contains native code, so it does not exist in Expo
 * Go — only in a dev build or an EAS build. Every entry point here therefore
 * degrades to a **mock mode** instead of throwing: no public API key configured,
 * or a `configure` call that fails because the native module is absent, and the
 * app keeps running with purchases disabled. That is what lets the paywall be
 * laid out and reviewed on a simulator without a signed build.
 *
 * Mock mode never fabricates entitlement. It can render prices; it cannot
 * report a purchase as successful — the server's webhook (§6.2) is the only
 * thing that grants access.
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import Purchases, {
  PACKAGE_TYPE,
  type PurchasesOffering,
  type PurchasesPackage,
} from 'react-native-purchases';

/** Offering identifiers configured in the RevenueCat dashboard (§6.1). */
export const PRO_OFFERING_ID = 'pro';

export type PurchasesMode = 'live' | 'mock';

/**
 * View model the paywall renders. Deliberately not `PurchasesPackage`: in mock
 * mode there is no real package, and this keeps the screen from having to
 * fabricate a full SDK object just to draw a price row.
 */
export type PaywallPlan = {
  id: 'monthly' | 'annual';
  title: string;
  /** Formatted, store-localised when live (`priceString`). */
  priceLabel: string;
  periodLabel: string;
  /** Secondary line, e.g. the annual plan's effective monthly rate. */
  footnote: string | null;
  /** e.g. "Save 33%" — computed from real prices when both are available. */
  badge: string | null;
  /** Null in mock mode; `purchasePlan` refuses to proceed without it. */
  packageToBuy: PurchasesPackage | null;
};

export type PurchaseOutcome =
  | { status: 'purchased' }
  | { status: 'cancelled' }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string };

export type RestoreOutcome =
  | { status: 'restored'; hadEntitlements: boolean }
  | { status: 'unavailable'; message: string }
  | { status: 'failed'; message: string };

const MOCK_MESSAGE =
  'Purchases need a development build with RevenueCat keys configured. Nothing was charged.';

let mode: PurchasesMode = 'mock';
let configured = false;

/**
 * Fallback pricing from §6.1. Used only to lay the paywall out when the SDK is
 * unavailable — it is illustrative, never authoritative.
 */
const FALLBACK_PLANS: PaywallPlan[] = [
  {
    id: 'monthly',
    title: 'Monthly',
    priceLabel: '$4.99',
    periodLabel: 'per month',
    footnote: 'Billed monthly. Cancel anytime.',
    badge: null,
    packageToBuy: null,
  },
  {
    id: 'annual',
    title: 'Annual',
    priceLabel: '$39.99',
    periodLabel: 'per year',
    footnote: '$3.33 / month, billed yearly.',
    badge: 'Save 33%',
    packageToBuy: null,
  },
];

function readConfiguredKey(): string | null {
  const extra = Constants.expoConfig?.extra as { revenueCat?: Record<string, unknown> } | undefined;
  const keys = extra?.revenueCat;

  const raw = Platform.select({
    ios: keys?.iosApiKey,
    android: keys?.androidApiKey,
    default: null,
  });

  if (typeof raw !== 'string') {
    return null;
  }

  const key = raw.trim();
  // Treat the committed placeholder as "unset" so a repo checkout lands in mock
  // mode rather than handing the SDK a key that cannot work.
  if (key.length === 0 || key.startsWith('REPLACE_ME')) {
    return null;
  }

  return key;
}

/**
 * Idempotent. Safe to call from app start; returns the mode it settled into.
 */
export function configurePurchases(): PurchasesMode {
  if (configured) {
    return mode;
  }
  configured = true;

  const apiKey = readConfiguredKey();
  if (!apiKey) {
    mode = 'mock';
    console.warn(
      '[purchases] No RevenueCat public key for this platform; running in mock mode. ' +
        'Set EXPO_PUBLIC_RC_IOS_KEY / EXPO_PUBLIC_RC_ANDROID_KEY and use a dev build to enable purchases.'
    );
    return mode;
  }

  try {
    Purchases.configure({ apiKey });
    mode = 'live';
  } catch (error) {
    // Thrown when the native module is missing (Expo Go). Not fatal.
    mode = 'mock';
    console.warn('[purchases] configure failed; running in mock mode:', error);
  }

  return mode;
}

export function isMockMode(): boolean {
  return mode !== 'live';
}

/**
 * Links the RevenueCat App User ID to the TiltGuard user Guid (§6.1), which is
 * what makes `event.app_user_id` resolvable by the webhook handler.
 */
export async function identifyUser(userId: string): Promise<void> {
  if (isMockMode() || !userId) {
    return;
  }

  try {
    await Purchases.logIn(userId);
  } catch (error) {
    // Never block sign-in on the billing SDK.
    console.warn('[purchases] logIn failed:', error);
  }
}

/** Returns the SDK to an anonymous user so the next sign-in starts clean. */
export async function resetUser(): Promise<void> {
  if (isMockMode()) {
    return;
  }

  try {
    await Purchases.logOut();
  } catch (error) {
    // logOut rejects if the current user is already anonymous — harmless.
    console.warn('[purchases] logOut failed:', error);
  }
}

function formatSavings(monthly: PurchasesPackage, annual: PurchasesPackage): string | null {
  const monthlyYearly = monthly.product.price * 12;
  if (monthlyYearly <= 0 || annual.product.price <= 0) {
    return null;
  }

  const saved = 1 - annual.product.price / monthlyYearly;
  return saved > 0.01 ? `Save ${Math.round(saved * 100)}%` : null;
}

function toPlans(offering: PurchasesOffering): PaywallPlan[] {
  const monthly =
    offering.monthly ??
    offering.availablePackages.find((entry) => entry.packageType === PACKAGE_TYPE.MONTHLY) ??
    null;
  const annual =
    offering.annual ??
    offering.availablePackages.find((entry) => entry.packageType === PACKAGE_TYPE.ANNUAL) ??
    null;

  const plans: PaywallPlan[] = [];

  if (monthly) {
    plans.push({
      id: 'monthly',
      title: 'Monthly',
      priceLabel: monthly.product.priceString,
      periodLabel: 'per month',
      footnote: 'Billed monthly. Cancel anytime.',
      badge: null,
      packageToBuy: monthly,
    });
  }

  if (annual) {
    // `pricePerMonthString` is already store-localised, so it beats formatting
    // the raw number against a currency code ourselves.
    const perMonth = annual.product.pricePerMonthString;
    plans.push({
      id: 'annual',
      title: 'Annual',
      priceLabel: annual.product.priceString,
      periodLabel: 'per year',
      footnote: perMonth ? `${perMonth} / month, billed yearly.` : 'Billed yearly.',
      badge: monthly ? formatSavings(monthly, annual) : null,
      packageToBuy: annual,
    });
  }

  return plans;
}

/**
 * Resolves the plans to display. Falls back to the illustrative §6.1 pricing
 * whenever the SDK is unavailable or the offering cannot be fetched, so the
 * paywall always renders something rather than an empty sheet.
 */
export async function getPaywallPlans(): Promise<{ plans: PaywallPlan[]; isLive: boolean }> {
  if (isMockMode()) {
    return { plans: FALLBACK_PLANS, isLive: false };
  }

  try {
    const offerings = await Purchases.getOfferings();
    const offering = offerings.current ?? offerings.all[PRO_OFFERING_ID] ?? null;

    if (!offering) {
      console.warn('[purchases] no current offering configured; using fallback pricing.');
      return { plans: FALLBACK_PLANS, isLive: false };
    }

    const plans = toPlans(offering);
    return plans.length > 0
      ? { plans, isLive: true }
      : { plans: FALLBACK_PLANS, isLive: false };
  } catch (error) {
    console.warn('[purchases] getOfferings failed; using fallback pricing:', error);
    return { plans: FALLBACK_PLANS, isLive: false };
  }
}

function isUserCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { userCancelled?: unknown; code?: unknown };
  return (
    candidate.userCancelled === true ||
    candidate.code === 'PURCHASE_CANCELLED_ERROR' ||
    candidate.code === 1
  );
}

function toMessage(error: unknown, fallback: string): string {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { message?: unknown; underlyingErrorMessage?: unknown };
    if (typeof candidate.message === 'string' && candidate.message.length > 0) {
      return candidate.message;
    }
    if (typeof candidate.underlyingErrorMessage === 'string') {
      return candidate.underlyingErrorMessage;
    }
  }
  return fallback;
}

/**
 * A resolved `purchased` means the store accepted payment. It does **not** mean
 * the account is upgraded — RevenueCat's webhook (§6.2) is what moves
 * `premium_status`, so the caller must re-sync entitlements from the server.
 */
export async function purchasePlan(plan: PaywallPlan): Promise<PurchaseOutcome> {
  if (isMockMode() || !plan.packageToBuy) {
    return { status: 'unavailable', message: MOCK_MESSAGE };
  }

  try {
    await Purchases.purchasePackage(plan.packageToBuy);
    return { status: 'purchased' };
  } catch (error) {
    if (isUserCancellation(error)) {
      return { status: 'cancelled' };
    }
    return {
      status: 'failed',
      message: toMessage(error, 'The purchase could not be completed.'),
    };
  }
}

/** Restores prior purchases on this store account (App Store / Play requirement). */
export async function restorePurchases(): Promise<RestoreOutcome> {
  if (isMockMode()) {
    return { status: 'unavailable', message: MOCK_MESSAGE };
  }

  try {
    const customerInfo = await Purchases.restorePurchases();
    return {
      status: 'restored',
      hadEntitlements: Object.keys(customerInfo.entitlements.active).length > 0,
    };
  } catch (error) {
    return {
      status: 'failed',
      message: toMessage(error, 'Could not restore purchases.'),
    };
  }
}
