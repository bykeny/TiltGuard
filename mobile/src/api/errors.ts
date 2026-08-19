/**
 * Uniform error envelope (§3) decoded into a typed client error.
 */

/**
 * Error `code` registry from §3, plus transport-level codes the server never
 * sends.
 *
 * `COOLDOWN_ACTIVE` is what the running backend actually emits for the 423
 * (SessionService flags the deviation from the spec's `COOLDOWN_LOCK_ACTIVE`
 * in a comment); both are listed so the client keeps working whichever way
 * that reconciliation lands.
 */
export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'REFRESH_REUSE_DETECTED'
  | 'PREMIUM_REQUIRED'
  | 'NOT_FOUND'
  | 'SESSION_ALREADY_ACTIVE'
  | 'EMAIL_TAKEN'
  | 'COOLDOWN_ACTIVE'
  | 'COOLDOWN_LOCK_ACTIVE'
  | 'RATE_LIMITED'
  | 'NETWORK_UNAVAILABLE'
  | 'UNKNOWN';

const KNOWN_CODES = new Set<string>([
  'VALIDATION_FAILED',
  'INVALID_CREDENTIALS',
  'TOKEN_EXPIRED',
  'REFRESH_REUSE_DETECTED',
  'PREMIUM_REQUIRED',
  'NOT_FOUND',
  'SESSION_ALREADY_ACTIVE',
  'EMAIL_TAKEN',
  'COOLDOWN_ACTIVE',
  'COOLDOWN_LOCK_ACTIVE',
  'RATE_LIMITED',
]);

/**
 * `details` is not one shape: validation errors send
 * `Record<string, string[]>`, while `SESSION_ALREADY_ACTIVE` and the 423 send
 * a flat object. It stays `unknown` and is read through the helpers below.
 */
type ErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    traceId?: string;
    details?: unknown;
  };
};

const FALLBACK_MESSAGES: Partial<Record<ApiErrorCode, string>> = {
  INVALID_CREDENTIALS: 'Incorrect email or password.',
  VALIDATION_FAILED: 'Please check the details you entered.',
  EMAIL_TAKEN: 'That email is already registered.',
  RATE_LIMITED: 'Too many attempts. Wait a moment and try again.',
  NETWORK_UNAVAILABLE: 'Cannot reach the TiltGuard server. Check your connection.',
  UNKNOWN: 'Something went wrong. Please try again.',
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly traceId?: string;
  readonly details?: unknown;

  constructor(
    code: ApiErrorCode,
    message: string,
    status: number,
    traceId?: string,
    details?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.traceId = traceId;
    this.details = details;
  }

  /** True for both spellings of the 423 cooldown lock. */
  get isCooldownLock(): boolean {
    return (
      this.status === 423 ||
      this.code === 'COOLDOWN_ACTIVE' ||
      this.code === 'COOLDOWN_LOCK_ACTIVE'
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(details: unknown, key: string): string | null {
  if (!isRecord(details)) {
    return null;
  }
  const value = details[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * §3.4: a 409 carries the existing session id so the client can resume rather
 * than dead-end the user.
 */
export function readActiveSessionId(error: ApiError): string | null {
  return readString(error.details, 'activeSessionId');
}

/** The 423 body carries the lock's id and wall-clock expiry. */
export function readCooldownLock(error: ApiError): {
  cooldownId: string | null;
  lockExpiresAtUtc: string | null;
} {
  return {
    cooldownId: readString(error.details, 'cooldownId'),
    lockExpiresAtUtc: readString(error.details, 'lockExpiresAtUtc'),
  };
}

/** Flattens `VALIDATION_FAILED` details into one line of user-facing copy. */
export function readValidationMessage(error: ApiError): string | null {
  if (!isRecord(error.details)) {
    return null;
  }

  const messages: string[] = [];
  for (const value of Object.values(error.details)) {
    if (Array.isArray(value)) {
      messages.push(...value.filter((entry): entry is string => typeof entry === 'string'));
    } else if (typeof value === 'string') {
      messages.push(value);
    }
  }

  return messages.length > 0 ? messages.join(' ') : null;
}

/** Builds an `ApiError` from a non-2xx status and its (possibly absent) body. */
export function toApiError(status: number, body: unknown): ApiError {
  const envelope = (body ?? {}) as ErrorEnvelope;
  const rawCode = envelope.error?.code ?? '';
  const code: ApiErrorCode = KNOWN_CODES.has(rawCode)
    ? (rawCode as ApiErrorCode)
    : 'UNKNOWN';
  const message =
    envelope.error?.message ?? FALLBACK_MESSAGES[code] ?? FALLBACK_MESSAGES.UNKNOWN!;

  return new ApiError(code, message, status, envelope.error?.traceId, envelope.error?.details);
}

/** The error shown when `fetch` itself never reached the server. */
export function networkError(): ApiError {
  return new ApiError(
    'NETWORK_UNAVAILABLE',
    FALLBACK_MESSAGES.NETWORK_UNAVAILABLE!,
    0
  );
}

/** Narrows any thrown value to user-facing copy. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'VALIDATION_FAILED') {
      return readValidationMessage(error) ?? error.message;
    }
    return error.message;
  }
  return FALLBACK_MESSAGES.UNKNOWN!;
}
