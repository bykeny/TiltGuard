/**
 * Central API configuration (§7).
 *
 * Resolution order:
 *   1. `EXPO_PUBLIC_API_URL` (surfaced through app.config.ts -> expo-constants)
 *   2. The platform-appropriate localhost alias below.
 *
 * Physical-device testing: an emulator loopback alias is meaningless to a real
 * phone, so point it at your machine's LAN IP:
 *   EXPO_PUBLIC_API_URL=http://192.168.1.42:5191 npx expo start
 */
import Constants from 'expo-constants';
import { Platform } from 'react-native';

/**
 * Kestrel's HTTP port from backend/TiltGuard.API/Properties/launchSettings.json.
 * (ASP.NET's own default is 5000 — change this one constant if you rebind it.)
 */
const LOCAL_API_PORT = 5191;

/**
 * The Android emulator reaches the host machine through 10.0.2.2; the iOS
 * simulator shares the host's loopback directly.
 */
const LOCAL_API_HOST = Platform.OS === 'android' ? '10.0.2.2' : 'localhost';

const DEFAULT_API_URL = `http://${LOCAL_API_HOST}:${LOCAL_API_PORT}`;

function resolveApiUrl(): string {
  const configured = Constants.expoConfig?.extra?.apiUrl;
  const fromEnv = typeof configured === 'string' ? configured.trim() : '';
  const base = fromEnv.length > 0 ? fromEnv : DEFAULT_API_URL;

  // Trailing slashes would double up against the versioned path prefix.
  return base.replace(/\/+$/, '');
}

/** Origin only, e.g. `http://10.0.2.2:5191`. */
export const API_BASE_URL = resolveApiUrl();

/** Versioned REST prefix, e.g. `http://10.0.2.2:5191/api/v1`. */
export const API_V1_URL = `${API_BASE_URL}/api/v1`;

/** SignalR hub endpoint (§4). */
export const TILT_HUB_URL = `${API_BASE_URL}/hubs/tilt`;

/** Request timeout for REST calls, in milliseconds. */
export const API_TIMEOUT_MS = 15_000;

export const AUTH_ENDPOINTS = {
  register: `${API_V1_URL}/auth/register`,
  login: `${API_V1_URL}/auth/login`,
  refresh: `${API_V1_URL}/auth/refresh`,
} as const;
