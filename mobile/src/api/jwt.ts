/**
 * Minimal JWT inspection — claims only, never verification.
 *
 * The signature is authoritative on the server; the client reads `exp` purely
 * to avoid booting into a UI that every request would 401 against.
 */

type JwtClaims = {
  exp?: number;
  sub?: string;
  email?: string;
  /** §1.3 access-token claims carry the entitlement tier. */
  premium?: string;
};

export type Identity = {
  userId: string | null;
  email: string | null;
  premiumStatus: string | null;
};

/** Clock-skew allowance so a token expiring "now" is treated as already gone. */
const EXPIRY_SKEW_SECONDS = 30;

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return atob(padded);
}

/** Returns the payload claims, or `null` if the token is unparseable. */
export function decodeJwtClaims(token: string): JwtClaims | null {
  try {
    const segments = token.split('.');
    if (segments.length !== 3) {
      return null;
    }

    const claims: unknown = JSON.parse(base64UrlDecode(segments[1]));
    if (typeof claims !== 'object' || claims === null) {
      return null;
    }

    return claims as JwtClaims;
  } catch (error) {
    console.warn('[jwt] could not decode token payload:', error);
    return null;
  }
}

/**
 * True when the token is malformed, has no `exp`, or expires within the skew
 * window. Unreadable tokens are treated as expired — fail closed.
 */
export function isAccessTokenUsable(token: string | null): token is string {
  if (!token) {
    return false;
  }

  const claims = decodeJwtClaims(token);
  if (!claims || typeof claims.exp !== 'number') {
    return false;
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  return claims.exp > nowSeconds + EXPIRY_SKEW_SECONDS;
}

/** Projects the access token's claims into the identity the UI renders. */
export function readIdentity(token: string | null): Identity {
  const claims = token ? decodeJwtClaims(token) : null;
  return {
    userId: claims?.sub ?? null,
    email: claims?.email ?? null,
    premiumStatus: claims?.premium ?? null,
  };
}
