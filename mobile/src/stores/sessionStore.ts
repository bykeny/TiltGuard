/**
 * Session store (§7): mirrors the server's session state machine.
 *
 * Two independent inputs drive this store and they can race:
 *   - REST responses (§3.4-3.6), which embed the tilt evaluation, and
 *   - SignalR pushes (§4.4).
 * Whichever arrives first engages the lock; the other is idempotent.
 */
import { create } from 'zustand';

import { ApiError, readActiveSessionId, readCooldownLock } from '@/src/api/errors';
import {
  DEFAULT_COOLDOWN_SECONDS,
  endSession as endSessionRequest,
  logMatch as logMatchRequest,
  startSession as startSessionRequest,
  type GameType,
  type LogMatchRequest,
  type MatchLogResponse,
  type SessionEndResponse,
  type SessionStartResponse,
  type TiltEvaluation,
} from '@/src/api/sessions';
import type {
  CooldownLockPayload,
  CooldownReleasePayload,
  TiltAlertPayload,
} from '@/src/realtime/payloads';

export type SessionState = 'Idle' | 'InMatch' | 'Evaluating' | 'CooldownLocked';

/** What the cooldown screen needs to render and count down. */
export type CooldownLock = {
  cooldownId: string | null;
  coachMessage: string;
  /** ISO-8601. The countdown is derived from this, never from a local tick. */
  expiresAtUtc: string;
  strategyType: string;
};

type SessionStoreState = {
  activeSessionId: string | null;
  gameType: GameType | null;
  sessionState: SessionState;
  latestAlert: TiltAlertPayload | null;
  cooldownLock: CooldownLock | null;
  /** ISO-8601 session start, for the duration ticker. */
  startedAt: string | null;
  matchesLogged: number;
  isBusy: boolean;

  startSession: (gameType: GameType) => Promise<SessionStartResponse | null>;
  endSession: () => Promise<SessionEndResponse>;
  logMatch: (payload: Omit<LogMatchRequest, 'sessionId'>) => Promise<MatchLogResponse>;
  setTiltAlert: (payload: TiltAlertPayload) => void;

  engageCooldown: (payload: CooldownLockPayload) => void;
  releaseCooldown: (payload: CooldownReleasePayload) => void;
  /** Adopts a session the server says is already open (§3.4 409 details). */
  adoptSession: (sessionId: string, gameType: GameType | null) => void;
  reset: () => void;
};

const IDLE_STATE = {
  activeSessionId: null,
  gameType: null,
  sessionState: 'Idle' as SessionState,
  latestAlert: null,
  cooldownLock: null,
  startedAt: null,
  matchesLogged: 0,
  isBusy: false,
};

function expiryFromSeconds(durationSeconds: number): string {
  const seconds = durationSeconds > 0 ? durationSeconds : DEFAULT_COOLDOWN_SECONDS;
  return new Date(Date.now() + seconds * 1000).toISOString();
}

/**
 * Builds a lock from the REST evaluation. §3.6 gives a duration but no expiry
 * timestamp, so it is anchored to the moment of receipt.
 */
function lockFromEvaluation(evaluation: TiltEvaluation): CooldownLock {
  const recommendation = evaluation.recommendedCooldown;
  return {
    cooldownId: recommendation?.cooldownId ?? null,
    coachMessage:
      evaluation.consecutiveLosses > 1
        ? `${evaluation.consecutiveLosses} losses in a row. Reset before you queue again.`
        : 'Tilt is critical. Reset before you queue again.',
    expiresAtUtc: expiryFromSeconds(recommendation?.durationSeconds ?? 0),
    strategyType: recommendation?.strategyType ?? 'breathing',
  };
}

export const useSessionStore = create<SessionStoreState>((set, get) => ({
  ...IDLE_STATE,

  startSession: async (gameType) => {
    set({ isBusy: true });
    try {
      const session = await startSessionRequest(gameType);
      set({
        activeSessionId: session.sessionId,
        gameType: session.gameType,
        startedAt: session.startTime,
        sessionState: 'InMatch',
        latestAlert: null,
        cooldownLock: null,
        matchesLogged: 0,
      });
      return session;
    } catch (error) {
      // §3.4: a 409 hands back the live session id so the client resumes
      // rather than stranding the user with an error they cannot clear.
      if (error instanceof ApiError && error.code === 'SESSION_ALREADY_ACTIVE') {
        const existingId = readActiveSessionId(error);
        if (existingId) {
          get().adoptSession(existingId, gameType);
          return null;
        }
      }
      throw error;
    } finally {
      set({ isBusy: false });
    }
  },

  endSession: async () => {
    const { activeSessionId } = get();
    if (!activeSessionId) {
      throw new ApiError('NOT_FOUND', 'No active session to end.', 404);
    }

    set({ isBusy: true });
    try {
      const summary = await endSessionRequest(activeSessionId);
      set({ ...IDLE_STATE });
      return summary;
    } catch (error) {
      // §3.5: ending is not an escape hatch from a mandatory cooldown. Adopt
      // the lock the server reports so the UI shows the wall the user hit.
      if (error instanceof ApiError && error.isCooldownLock) {
        const { cooldownId, lockExpiresAtUtc } = readCooldownLock(error);
        set({
          sessionState: 'CooldownLocked',
          cooldownLock: {
            cooldownId,
            coachMessage: error.message,
            expiresAtUtc: lockExpiresAtUtc ?? expiryFromSeconds(0),
            strategyType: 'breathing',
          },
        });
      }
      throw error;
    } finally {
      set({ isBusy: false });
    }
  },

  logMatch: async (payload) => {
    const { activeSessionId } = get();
    if (!activeSessionId) {
      throw new ApiError('NOT_FOUND', 'No active session.', 404);
    }

    set({ isBusy: true, sessionState: 'Evaluating' });
    try {
      const result = await logMatchRequest({ ...payload, sessionId: activeSessionId });
      const evaluation = result.tiltEvaluation;

      set((state) => ({
        matchesLogged: state.matchesLogged + 1,
        latestAlert: {
          tiltCoefficient: evaluation.tiltCoefficient,
          riskFlag: evaluation.riskFlag,
          consecutiveLosses: evaluation.consecutiveLosses,
          tiltTrajectory: payload.postMatchTiltLevel - payload.preMatchTiltLevel,
          recommendedCooldownAction: evaluation.recommendedCooldown
            ? {
                cooldownId: evaluation.recommendedCooldown.cooldownId,
                strategyType: evaluation.recommendedCooldown.strategyType,
                durationSeconds: evaluation.recommendedCooldown.durationSeconds,
                isMandatory: evaluation.recommendedCooldown.isMandatory,
              }
            : null,
          evaluatedAtUtc: result.loggedAt,
        },
      }));

      // The synchronous path into the lock — it does not wait for §4.4's push.
      if (evaluation.riskFlag === 'lockRequired') {
        set({
          sessionState: 'CooldownLocked',
          cooldownLock: get().cooldownLock ?? lockFromEvaluation(evaluation),
        });
      } else {
        set({ sessionState: 'InMatch' });
      }

      return result;
    } catch (error) {
      // 423 here is the enforcement mechanism: a lock is already standing.
      if (error instanceof ApiError && error.isCooldownLock) {
        const { cooldownId, lockExpiresAtUtc } = readCooldownLock(error);
        set({
          sessionState: 'CooldownLocked',
          cooldownLock: get().cooldownLock ?? {
            cooldownId,
            coachMessage: error.message,
            expiresAtUtc: lockExpiresAtUtc ?? expiryFromSeconds(0),
            strategyType: 'breathing',
          },
        });
      } else {
        set({ sessionState: 'InMatch' });
      }
      throw error;
    } finally {
      set({ isBusy: false });
    }
  },

  setTiltAlert: (payload) => {
    set({ latestAlert: payload });

    // A pushed alert can itself be the lock signal (§4.4 sends both).
    const action = payload.recommendedCooldownAction;
    if (payload.riskFlag === 'lockRequired' && action?.isMandatory) {
      set((state) => ({
        sessionState: 'CooldownLocked',
        cooldownLock: state.cooldownLock ?? {
          cooldownId: action.cooldownId,
          coachMessage: 'Tilt is critical. Reset before you queue again.',
          expiresAtUtc: expiryFromSeconds(action.durationSeconds),
          strategyType: action.strategyType,
        },
      }));
    } else if (get().sessionState === 'Evaluating') {
      set({ sessionState: 'InMatch' });
    }
  },

  engageCooldown: (payload) => {
    set({
      sessionState: 'CooldownLocked',
      cooldownLock: {
        cooldownId: payload.cooldownId,
        coachMessage: payload.coachMessage,
        expiresAtUtc: payload.lockExpiresAtUtc ?? expiryFromSeconds(payload.durationSeconds),
        strategyType: payload.strategyType,
      },
    });
  },

  releaseCooldown: (payload) => {
    const { cooldownLock, activeSessionId } = get();

    // A release for a lock we are not holding is stale — ignore it rather than
    // clearing a newer lock that engaged in between.
    if (cooldownLock && payload.cooldownId && cooldownLock.cooldownId) {
      if (cooldownLock.cooldownId !== payload.cooldownId) {
        return;
      }
    }

    set({
      cooldownLock: null,
      sessionState: activeSessionId ? 'InMatch' : 'Idle',
    });
  },

  adoptSession: (sessionId, gameType) => {
    set({
      activeSessionId: sessionId,
      gameType,
      sessionState: 'InMatch',
      // The server did not tell us when it started; the ticker shows elapsed
      // time from adoption rather than inventing a start instant.
      startedAt: null,
      cooldownLock: null,
    });
  },

  reset: () => set({ ...IDLE_STATE }),
}));
