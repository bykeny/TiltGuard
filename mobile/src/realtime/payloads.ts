/**
 * Server->client hub payloads (§4.2) plus defensive normalisers.
 *
 * Why normalise at all: the running backend's `ITiltClient` declares these
 * arguments as `object` (and `CooldownLockReleased` as a bare `string`), so the
 * wire shape is not pinned by a typed contract yet. SignalR's JSON protocol
 * also carries its own serializer options, independent of the REST layer's
 * camelCase policy, and enums may arrive as either their string label or their
 * numeric ordinal. Every reader below accepts all of those spellings so the
 * client keeps working as §4.4's push path lands.
 */
import type { RiskFlag, StrategyType } from '@/src/api/sessions';

export type RecommendedCooldownAction = {
  cooldownId: string | null;
  strategyType: StrategyType;
  durationSeconds: number;
  isMandatory: boolean;
};

export type TiltAlertPayload = {
  /** 0.00-1.00 */
  tiltCoefficient: number;
  riskFlag: RiskFlag;
  consecutiveLosses: number;
  /** avg(post - pre) over the window */
  tiltTrajectory: number;
  recommendedCooldownAction: RecommendedCooldownAction | null;
  evaluatedAtUtc: string;
};

export type CooldownLockPayload = {
  cooldownId: string | null;
  strategyType: StrategyType;
  durationSeconds: number;
  lockExpiresAtUtc: string | null;
  coachMessage: string;
};

export type CooldownReleasePayload = {
  cooldownId: string | null;
  complianceVerified: boolean;
  message: string;
};

/** Enum ordinals, in the declaration order of the C# enums (§4.2). */
const RISK_FLAGS: RiskFlag[] = ['stable', 'elevated', 'critical', 'lockRequired'];
const STRATEGY_TYPES: StrategyType[] = ['breathing', 'stretching', 'hydration'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a property by camelCase name, falling back to its PascalCase twin. */
function pick(source: unknown, key: string): unknown {
  if (!isRecord(source)) {
    return undefined;
  }
  const pascal = key.charAt(0).toUpperCase() + key.slice(1);
  return source[key] ?? source[pascal];
}

function readNumber(source: unknown, key: string, fallback: number): number {
  const value = pick(source, key);
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(source: unknown, key: string): string | null {
  const value = pick(source, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function readBoolean(source: unknown, key: string, fallback: boolean): boolean {
  const value = pick(source, key);
  return typeof value === 'boolean' ? value : fallback;
}

/** Accepts `"lockRequired"`, `"LockRequired"`, or the ordinal `3`. */
export function readRiskFlag(source: unknown, key = 'riskFlag'): RiskFlag {
  const value = pick(source, key);

  if (typeof value === 'number') {
    return RISK_FLAGS[value] ?? 'stable';
  }
  if (typeof value === 'string') {
    const match = RISK_FLAGS.find(
      (flag) => flag.toLowerCase() === value.toLowerCase()
    );
    return match ?? 'stable';
  }
  return 'stable';
}

function readStrategyType(source: unknown, key = 'strategyType'): StrategyType {
  const value = pick(source, key);

  if (typeof value === 'number') {
    return STRATEGY_TYPES[value] ?? 'breathing';
  }
  if (typeof value === 'string') {
    const match = STRATEGY_TYPES.find(
      (strategy) => strategy.toLowerCase() === value.toLowerCase()
    );
    return match ?? 'breathing';
  }
  return 'breathing';
}

function normalizeRecommendedAction(source: unknown): RecommendedCooldownAction | null {
  const raw = pick(source, 'recommendedCooldownAction') ?? pick(source, 'recommendedCooldown');
  if (!isRecord(raw)) {
    return null;
  }

  return {
    cooldownId: readString(raw, 'cooldownId'),
    strategyType: readStrategyType(raw),
    durationSeconds: readNumber(raw, 'durationSeconds', 0),
    isMandatory: readBoolean(raw, 'isMandatory', false),
  };
}

export function normalizeTiltAlert(source: unknown): TiltAlertPayload {
  return {
    tiltCoefficient: readNumber(source, 'tiltCoefficient', 0),
    riskFlag: readRiskFlag(source),
    consecutiveLosses: readNumber(source, 'consecutiveLosses', 0),
    tiltTrajectory: readNumber(source, 'tiltTrajectory', 0),
    recommendedCooldownAction: normalizeRecommendedAction(source),
    evaluatedAtUtc: readString(source, 'evaluatedAtUtc') ?? new Date().toISOString(),
  };
}

const DEFAULT_COACH_MESSAGE =
  'Cooldown engaged. Breathe with the guide before you queue again.';

export function normalizeCooldownLock(source: unknown): CooldownLockPayload {
  return {
    cooldownId: readString(source, 'cooldownId'),
    strategyType: readStrategyType(source),
    durationSeconds: readNumber(source, 'durationSeconds', 0),
    lockExpiresAtUtc: readString(source, 'lockExpiresAtUtc'),
    coachMessage: readString(source, 'coachMessage') ?? DEFAULT_COACH_MESSAGE,
  };
}

const DEFAULT_RELEASE_MESSAGE = 'Cooldown complete. Play focused.';

/**
 * The watchdog currently invokes `CooldownLockReleased` with a plain string,
 * while §4.2 specifies a `CooldownReleasePayload`. Both are accepted.
 */
export function normalizeCooldownRelease(source: unknown): CooldownReleasePayload {
  if (typeof source === 'string') {
    return {
      cooldownId: null,
      complianceVerified: false,
      message: source.length > 0 ? source : DEFAULT_RELEASE_MESSAGE,
    };
  }

  return {
    cooldownId: readString(source, 'cooldownId'),
    complianceVerified: readBoolean(source, 'complianceVerified', false),
    message: readString(source, 'message') ?? DEFAULT_RELEASE_MESSAGE,
  };
}
