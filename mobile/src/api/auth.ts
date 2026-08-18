/**
 * Auth REST calls (§3.1-3.3) and the uniform error envelope (§3).
 */
import { API_TIMEOUT_MS, AUTH_ENDPOINTS } from './config';

/** Error `code` registry from §3. `UNKNOWN` covers transport/parse failures. */
export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'REFRESH_REUSE_DETECTED'
  | 'PREMIUM_REQUIRED'
  | 'NOT_FOUND'
  | 'SESSION_ALREADY_ACTIVE'
  | 'EMAIL_TAKEN'
  | 'COOLDOWN_LOCK_ACTIVE'
  | 'RATE_LIMITED'
  | 'NETWORK_UNAVAILABLE'
  | 'UNKNOWN';

/** Uniform non-2xx body shape (§3). */
type ErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    traceId?: string;
    details?: Record<string, string[]>;
  };
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly traceId?: string;
  readonly details?: Record<string, string[]>;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    traceId?: string,
    details?: Record<string, string[]>
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.traceId = traceId;
    this.details = details;
  }
}

/** §3.1/§3.2 success body — login and register return the same shape. */
export type AuthTokenResponse = {
  userId: string;
  email: string;
  premiumStatus: string;
  accessToken: string;
  accessTokenExpiresAtUtc: string;
  refreshToken: string;
  refreshTokenExpiresAtUtc: string;
};

export type LoginCredentials = {
  email: string;
  password: string;
};

const KNOWN_CODES = new Set<string>([
  'VALIDATION_FAILED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'REFRESH_REUSE_DETECTED',
  'PREMIUM_REQUIRED',
  'NOT_FOUND',
  'SESSION_ALREADY_ACTIVE',
  'EMAIL_TAKEN',
  'COOLDOWN_LOCK_ACTIVE',
  'RATE_LIMITED',
]);

/** Human-facing copy. §3.2 deliberately does not distinguish unknown email
 *  from wrong password, so neither does the message we render. */
const FALLBACK_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  VALIDATION_FAILED: 'Please check the details you entered.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  NETWORK_UNAVAILABLE: 'Cannot reach the TiltGuard server. Check your connection.',
  UNKNOWN: 'Something went wrong. Please try again.',
};

function toApiError(status: number, body: unknown): ApiError {
  const envelope = (body ?? {}) as ErrorEnvelope;
  const rawCode = envelope.error?.code ?? '';
  const code: ApiErrorCode = KNOWN_CODES.has(rawCode)
    ? (rawCode as ApiErrorCode)
    : 'UNKNOWN';
  const message =
    envelope.error?.message ?? FALLBACK_MESSAGES[code] ?? FALLBACK_MESSAGES.UNKNOWN!;

  return new ApiError(code, message, status, envelope.error?.traceId, envelope.error?.details);
}

/** POSTs JSON with a hard timeout, normalising every failure into `ApiError`. */
async function postJson<TResponse>(url: string, payload: unknown): Promise<TResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    console.warn(`[api] request to ${url} failed:`, error);
    throw new ApiError(
      'NETWORK_UNAVAILABLE',
      FALLBACK_MESSAGES.NETWORK_UNAVAILABLE!,
      0
    );
  } finally {
    clearTimeout(timeoutId);
  }

  // A body is not guaranteed on every status, so parsing is best-effort.
  const raw = await response.text();
  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      console.warn(`[api] malformed JSON from ${url}:`, error);
    }
  }

  if (!response.ok) {
    throw toApiError(response.status, parsed);
  }

  return parsed as TResponse;
}

/** POST /api/v1/auth/login (§3.2). Throws `ApiError` on any non-200. */
export function login(credentials: LoginCredentials): Promise<AuthTokenResponse> {
  return postJson<AuthTokenResponse>(AUTH_ENDPOINTS.login, {
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  });
}

/** POST /api/v1/auth/register (§3.1). Same success body as login. */
export function register(credentials: LoginCredentials): Promise<AuthTokenResponse> {
  return postJson<AuthTokenResponse>(AUTH_ENDPOINTS.register, {
    email: credentials.email.trim().toLowerCase(),
    password: credentials.password,
  });
}
