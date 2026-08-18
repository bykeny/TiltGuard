/**
 * Hardware-backed token storage (§1.3, §7).
 *
 * Wraps `expo-secure-store` so the rest of the app never touches raw keychain
 * APIs. Android persists through SharedPreferences encrypted by the Android
 * Keystore; iOS uses Keychain Services.
 *
 * Every operation is fail-soft: SecureStore is unavailable on web and can
 * legitimately reject on device (keystore invalidated after a biometric
 * change, storage pressure). Callers get `null` / a boolean instead of an
 * exception, so a storage fault degrades to "logged out" rather than a crash.
 */
import * as SecureStore from 'expo-secure-store';

/** Keys must match `[A-Za-z0-9._-]+` to be valid SecureStore identifiers. */
export const ACCESS_TOKEN_KEY = 'tiltguard.accessToken';
export const REFRESH_TOKEN_KEY = 'tiltguard.refreshToken';

/**
 * Scopes our entries into a dedicated iOS keychain service so they can be
 * wiped independently of anything else the bundle stores.
 */
const STORE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainService: 'tiltguard.auth',
};

function logFailure(operation: string, key: string, error: unknown): void {
  console.warn(`[secureStore] ${operation} failed for "${key}":`, error);
}

/** Reads a value, or `null` when absent or unreadable. */
async function getItem(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key, STORE_OPTIONS);
  } catch (error) {
    logFailure('read', key, error);
    return null;
  }
}

/** Writes a value. Returns `false` when the write could not be persisted. */
async function setItem(key: string, value: string): Promise<boolean> {
  try {
    await SecureStore.setItemAsync(key, value, STORE_OPTIONS);
    return true;
  } catch (error) {
    logFailure('write', key, error);
    return false;
  }
}

/** Removes a value. Returns `false` when the delete could not be applied. */
async function deleteItem(key: string): Promise<boolean> {
  try {
    await SecureStore.deleteItemAsync(key, STORE_OPTIONS);
    return true;
  } catch (error) {
    logFailure('delete', key, error);
    return false;
  }
}

/** True on devices where the OS keystore is actually reachable (iOS/Android). */
export async function isSecureStoreAvailable(): Promise<boolean> {
  try {
    return await SecureStore.isAvailableAsync();
  } catch (error) {
    logFailure('availability check', '-', error);
    return false;
  }
}

export const getAccessToken = (): Promise<string | null> => getItem(ACCESS_TOKEN_KEY);

export const setAccessToken = (token: string): Promise<boolean> =>
  setItem(ACCESS_TOKEN_KEY, token);

export const deleteAccessToken = (): Promise<boolean> => deleteItem(ACCESS_TOKEN_KEY);

export const getRefreshToken = (): Promise<string | null> => getItem(REFRESH_TOKEN_KEY);

export const setRefreshToken = (token: string): Promise<boolean> =>
  setItem(REFRESH_TOKEN_KEY, token);

export const deleteRefreshToken = (): Promise<boolean> => deleteItem(REFRESH_TOKEN_KEY);

/** A stored token pair; either half may be missing after a partial write. */
export type StoredTokenPair = {
  accessToken: string | null;
  refreshToken: string | null;
};

/** Reads both tokens in parallel — used by boot-time hydration. */
export async function getTokenPair(): Promise<StoredTokenPair> {
  const [accessToken, refreshToken] = await Promise.all([
    getAccessToken(),
    getRefreshToken(),
  ]);
  return { accessToken, refreshToken };
}

/** Persists both tokens. Returns `false` if either half failed to store. */
export async function setTokenPair(
  accessToken: string,
  refreshToken: string
): Promise<boolean> {
  const results = await Promise.all([
    setAccessToken(accessToken),
    setRefreshToken(refreshToken),
  ]);
  return results.every(Boolean);
}

/** Clears both tokens. Returns `false` if either half failed to clear. */
export async function clearTokenPair(): Promise<boolean> {
  const results = await Promise.all([deleteAccessToken(), deleteRefreshToken()]);
  return results.every(Boolean);
}
