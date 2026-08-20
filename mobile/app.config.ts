import type { ConfigContext, ExpoConfig } from 'expo/config';

/**
 * Dynamic config layered over app.json (§7).
 *
 * Non-secret runtime configuration is surfaced through `extra` so it can be
 * read at runtime via `expo-constants`. Anything genuinely secret stays
 * server-side — only public values (API base URL, RevenueCat *public* SDK
 * keys) may travel in the bundle.
 *
 * Override the API host per machine without editing tracked files:
 *   EXPO_PUBLIC_API_URL=http://192.168.1.42:5191 npx expo start
 *
 * Purchases need a dev build plus:
 *   EXPO_PUBLIC_RC_IOS_KEY=appl_... EXPO_PUBLIC_RC_ANDROID_KEY=goog_...
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

// RevenueCat *public* SDK keys (§6.1). These are publishable by design — the
// secret half never leaves RevenueCat, and the backend is gated by its own
// webhook secret (§6.2). Absent here, the client falls back to mock mode.
const revenueCat = {
  iosApiKey: process.env.EXPO_PUBLIC_RC_IOS_KEY?.trim() ?? '',
  androidApiKey: process.env.EXPO_PUBLIC_RC_ANDROID_KEY?.trim() ?? '',
};

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'TiltGuard',
  slug: config.slug ?? 'tiltguard',
  extra: {
    ...config.extra,
    // Omitted rather than nulled when unset — the config serializer turns a
    // null into `{}`, which would defeat a naive truthiness check downstream.
    ...(apiUrl ? { apiUrl } : {}),
    revenueCat,
  },
});
