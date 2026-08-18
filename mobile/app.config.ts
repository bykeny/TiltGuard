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
 */
const apiUrl = process.env.EXPO_PUBLIC_API_URL?.trim();

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: config.name ?? 'TiltGuard',
  slug: config.slug ?? 'tiltguard',
  extra: {
    ...config.extra,
    // Omitted rather than nulled when unset — the config serializer turns a
    // null into `{}`, which would defeat a naive truthiness check downstream.
    ...(apiUrl ? { apiUrl } : {}),
  },
});
