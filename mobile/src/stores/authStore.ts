/**
 * Global auth store (§1.3, §7).
 *
 * The token pair lives in `expo-secure-store`; this store holds the derived,
 * render-relevant slice of it. `accessToken` is mirrored in memory so the
 * fetch wrapper can inject the bearer header without an async read per call.
 */
import { create } from 'zustand';

import { isAccessTokenUsable, readIdentity } from '@/src/api/jwt';
import {
  clearTokenPair,
  getTokenPair,
  setTokenPair,
} from '@/src/api/secureStore';
import { identifyUser, resetUser } from '@/src/purchases/purchases';

type AuthState = {
  /** Boot-time hydration is still in flight — render the splash, not routes. */
  isLoading: boolean;
  isAuthenticated: boolean;
  accessToken: string | null;

  /** Persists a fresh token pair and unlocks the `(app)` stack. */
  login: (token: string, refreshToken: string) => Promise<void>;
  /** Drops the token pair and returns the navigator to `(auth)`. */
  logout: () => Promise<void>;
  /** Rehydrates from secure storage on app start. Runs exactly once. */
  initializeAuth: () => Promise<void>;
};

/**
 * Guards against a second hydration pass — the root layout can remount (fast
 * refresh, theme change) and re-running would flash the splash screen.
 */
let hydration: Promise<void> | null = null;

/**
 * Links the billing SDK to this account and pulls the server's entitlement view
 * (§6.1). Never awaited by the caller and never allowed to throw: neither the
 * RevenueCat SDK nor the entitlements endpoint may hold up, or fail, a sign-in.
 *
 * `entitlementStore` is imported lazily on purpose. It reaches the API client,
 * which reads *this* store for its bearer token; a static import would close
 * that cycle at module-evaluation time, when `useAuthStore` is still undefined.
 */
async function syncEntitlements(accessToken: string): Promise<void> {
  try {
    const { userId } = readIdentity(accessToken);
    if (userId) {
      await identifyUser(userId);
    }

    const { useEntitlementStore } = await import('@/src/stores/entitlementStore');
    await useEntitlementStore.getState().fetchEntitlements();
  } catch (error) {
    console.warn('[auth] entitlement sync failed:', error);
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  isLoading: true,
  isAuthenticated: false,
  accessToken: null,

  login: async (token, refreshToken) => {
    const persisted = await setTokenPair(token, refreshToken);
    if (!persisted) {
      // The session still works for this launch; it just will not survive a
      // cold start. Surfacing it beats silently logging the user out later.
      console.warn('[auth] token pair could not be persisted to secure storage');
    }

    set({ accessToken: token, isAuthenticated: true, isLoading: false });

    // Fire-and-forget: the route guard should swap stacks immediately rather
    // than waiting on a store round trip.
    void syncEntitlements(token);
  },

  logout: async () => {
    // Clear in-memory state first so no in-flight render can read a token that
    // is on its way out.
    set({ accessToken: null, isAuthenticated: false, isLoading: false });
    await clearTokenPair();

    // Return the billing SDK to an anonymous user so the next account that
    // signs in on this device does not inherit the previous one's identity.
    await resetUser();
  },

  initializeAuth: async () => {
    if (hydration) {
      return hydration;
    }

    hydration = (async () => {
      const { accessToken } = await getTokenPair();

      if (isAccessTokenUsable(accessToken)) {
        set({ accessToken, isAuthenticated: true, isLoading: false });

        // A returning user never passes through `login`, so without this the
        // entitlement store would sit at its `free` default all session and
        // show the upgrade pill to a paying subscriber.
        void syncEntitlements(accessToken);
        return;
      }

      // Missing or expired access token: stay unauthenticated. The stored
      // refresh token is left intact for the §3.3 refresh flow to consume.
      set({ accessToken: null, isAuthenticated: false, isLoading: false });
    })();

    return hydration;
  },
}));

/** Test/hot-reload seam: lets hydration run again from a clean slate. */
export function resetAuthHydration(): void {
  hydration = null;
}
