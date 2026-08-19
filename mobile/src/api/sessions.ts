/**
 * Session + match-logging REST calls (§3.4-3.6) and the domain vocabulary the
 * UI renders from.
 *
 * Wire strings match the DDL's Postgres enum labels (snake_case), except
 * `RiskFlag`, which is API/hub-only and camelCase — see the backend's
 * `ApiEnumMapping`.
 */
import { apiPost } from './client';

export type GameType =
  | 'cs2'
  | 'lol'
  | 'valorant'
  | 'dota2'
  | 'tanki_online'
  | 'rocket_league'
  | 'apex_legends'
  | 'fortnite'
  | 'other';

export type MatchOutcome = 'win' | 'loss';

export type RiskFlag = 'stable' | 'elevated' | 'critical' | 'lockRequired';

export type StrategyType = 'breathing' | 'stretching' | 'hydration';

/** Display metadata for the dashboard picker, in spec order. */
export const GAME_CATALOG: { id: GameType; label: string; short: string }[] = [
  { id: 'cs2', label: 'CS2', short: 'CS' },
  { id: 'lol', label: 'League of Legends', short: 'LoL' },
  { id: 'valorant', label: 'Valorant', short: 'VAL' },
  { id: 'dota2', label: 'Dota 2', short: 'DOTA' },
  { id: 'tanki_online', label: 'Tanki Online', short: 'TO' },
  { id: 'rocket_league', label: 'Rocket League', short: 'RL' },
  { id: 'apex_legends', label: 'Apex Legends', short: 'APEX' },
  { id: 'fortnite', label: 'Fortnite', short: 'FN' },
  { id: 'other', label: 'Other', short: '—' },
];

const GAME_LABELS = new Map(GAME_CATALOG.map((game) => [game.id, game.label]));

export function gameLabel(gameType: string | null): string {
  if (!gameType) {
    return 'Session';
  }
  return GAME_LABELS.get(gameType as GameType) ?? gameType;
}

/** §3.4 `201 Created`. */
export type SessionStartResponse = {
  sessionId: string;
  gameType: GameType;
  startTime: string;
  isActive: boolean;
};

export type SessionSummary = {
  matchesPlayed: number;
  wins: number;
  losses: number;
  avgPerformanceScore: number;
  peakTiltLevel: number;
  cooldownsTriggered: number;
  cooldownsComplied: number;
};

/** §3.5 `200 OK`. */
export type SessionEndResponse = {
  sessionId: string;
  endTime: string;
  summary: SessionSummary;
};

export type RecommendedCooldown = {
  cooldownId: string;
  strategyType: StrategyType;
  durationSeconds: number;
  isMandatory: boolean;
};

/**
 * §3.6 embeds the tilt evaluation in the 201 so the UI can render the lock
 * even if the parallel SignalR push races it — or, as with the current
 * backend, has not been wired yet.
 */
export type TiltEvaluation = {
  tiltCoefficient: number;
  riskFlag: RiskFlag;
  windowSize: number;
  consecutiveLosses: number;
  recommendedCooldown: RecommendedCooldown | null;
};

export type MatchLogResponse = {
  matchId: string;
  loggedAt: string;
  tiltEvaluation: TiltEvaluation;
};

export type LogMatchRequest = {
  sessionId: string;
  matchOutcome: MatchOutcome;
  /** 0.00-100.00 */
  performanceScore: number;
  /** int 1-5 */
  preMatchTiltLevel: number;
  /** int 1-5 */
  postMatchTiltLevel: number;
};

/** POST /api/v1/sessions/start. 409 `SESSION_ALREADY_ACTIVE` carries the id. */
export async function startSession(gameType: GameType): Promise<SessionStartResponse> {
  const { data } = await apiPost<SessionStartResponse>('/sessions/start', { gameType });
  return data;
}

/** POST /api/v1/sessions/end. 423 while a mandatory cooldown is unresolved. */
export async function endSession(sessionId: string): Promise<SessionEndResponse> {
  const { data } = await apiPost<SessionEndResponse>('/sessions/end', { sessionId });
  return data;
}

/** POST /api/v1/matches/log. 423 is the lock enforcement mechanism itself. */
export async function logMatch(request: LogMatchRequest): Promise<MatchLogResponse> {
  const { data } = await apiPost<MatchLogResponse>('/matches/log', request);
  return data;
}

/** Cooldown durations are fixed at 15 minutes server-side for this phase. */
export const DEFAULT_COOLDOWN_SECONDS = 900;
