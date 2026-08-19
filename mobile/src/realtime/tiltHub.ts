/**
 * SignalR hub singleton (§4, §7).
 *
 * Maps server events 1:1 onto session-store actions:
 *   ReceiveTiltAlert     -> setTiltAlert
 *   CooldownLockEngaged  -> engageCooldown + replace('/session/cooldown')
 *   CooldownLockReleased -> releaseCooldown + return to the session
 *
 * One connection per app instance. `start()` is idempotent and safe to call
 * from several screens; the in-flight promise is shared rather than racing a
 * second negotiate.
 */
import {
  HubConnection,
  HubConnectionBuilder,
  HubConnectionState,
  LogLevel,
} from '@microsoft/signalr';
import { router } from 'expo-router';
import { create } from 'zustand';

import { ensureFreshAccessToken } from '@/src/api/client';
import { TILT_HUB_URL } from '@/src/api/config';
import { useSessionStore } from '@/src/stores/sessionStore';
import {
  normalizeCooldownLock,
  normalizeCooldownRelease,
  normalizeTiltAlert,
} from './payloads';

export type HubStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

type HubStatusStore = {
  status: HubStatus;
  setStatus: (status: HubStatus) => void;
};

/** Small store so screens can render a live connection pip. */
export const useHubStatus = create<HubStatusStore>((set) => ({
  status: 'disconnected',
  setStatus: (status) => set({ status }),
}));

const setStatus = (status: HubStatus) => useHubStatus.getState().setStatus(status);

/** §4.4 reconnect policy, verbatim. */
const RECONNECT_DELAYS_MS = [0, 2000, 5000, 10000, 30000];

let connection: HubConnection | null = null;
let startPromise: Promise<void> | null = null;
/** Re-invoked after every reconnect — groups do not survive a new id (§4.4). */
let joinedSessionId: string | null = null;
let warnedAboutMissingJoin = false;

function goToCooldown() {
  router.replace('/session/cooldown');
}

function leaveCooldown() {
  // Back to the live session if one is still open, otherwise the dashboard.
  if (useSessionStore.getState().activeSessionId) {
    router.replace('/session/active');
  } else {
    router.replace('/');
  }
}

function registerHandlers(hub: HubConnection) {
  hub.on('ReceiveTiltAlert', (payload: unknown) => {
    useSessionStore.getState().setTiltAlert(normalizeTiltAlert(payload));
  });

  hub.on('CooldownLockEngaged', (payload: unknown) => {
    useSessionStore.getState().engageCooldown(normalizeCooldownLock(payload));
    goToCooldown();
  });

  hub.on('CooldownLockReleased', (payload: unknown) => {
    const release = normalizeCooldownRelease(payload);
    const wasLocked = useSessionStore.getState().sessionState === 'CooldownLocked';

    useSessionStore.getState().releaseCooldown(release);

    // Only navigate if this release actually cleared the lock — a stale one is
    // ignored by the store and must not yank the user off the screen.
    if (wasLocked && useSessionStore.getState().sessionState !== 'CooldownLocked') {
      leaveCooldown();
    }
  });

  // §4.1 also declares ReceiveSessionState; JoinSession replays it on connect.
  hub.on('ReceiveSessionState', (payload: unknown) => {
    if (__DEV__) {
      console.log('[tiltHub] session state replay:', payload);
    }
  });

  hub.onreconnecting(() => setStatus('reconnecting'));

  hub.onreconnected(() => {
    setStatus('connected');
    // Group membership is keyed to the connection id, which changed.
    if (joinedSessionId) {
      void joinSession(joinedSessionId);
    }
  });

  hub.onclose(() => {
    setStatus('disconnected');
    startPromise = null;
  });
}

function buildConnection(): HubConnection {
  const hub = new HubConnectionBuilder()
    .withUrl(TILT_HUB_URL, {
      // Routed through the refresh queue so a 15-minute-old access token is
      // rotated before the handshake rather than failing it (§1.3).
      accessTokenFactory: async () => (await ensureFreshAccessToken()) ?? '',
    })
    .withAutomaticReconnect(RECONNECT_DELAYS_MS)
    .configureLogging(__DEV__ ? LogLevel.Warning : LogLevel.Error)
    .build();

  registerHandlers(hub);
  return hub;
}

/** Opens the connection, or resolves immediately if it is already open. */
export async function start(): Promise<void> {
  if (connection?.state === HubConnectionState.Connected) {
    return;
  }
  if (startPromise) {
    return startPromise;
  }

  connection ??= buildConnection();
  setStatus('connecting');

  startPromise = connection
    .start()
    .then(() => {
      setStatus('connected');
    })
    .catch((error: unknown) => {
      setStatus('disconnected');
      startPromise = null;
      // Realtime is an enhancement: the REST responses already carry the tilt
      // evaluation (§3.6), so a failed hub must not break the session flow.
      console.warn('[tiltHub] connection failed:', error);
    });

  return startPromise;
}

/**
 * Joins the session group (§4.3).
 *
 * The deployed hub has no `JoinSession` method yet — it auto-joins a per-user
 * group in `OnConnectedAsync` — so a "method does not exist" rejection is
 * downgraded to a single warning instead of surfacing as a session-start
 * failure. Everything else is rethrown.
 */
export async function joinSession(sessionId: string): Promise<void> {
  joinedSessionId = sessionId;

  if (connection?.state !== HubConnectionState.Connected) {
    return;
  }

  try {
    await connection.invoke('JoinSession', sessionId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/method does not exist|Method does not exist/i.test(message)) {
      if (!warnedAboutMissingJoin) {
        warnedAboutMissingJoin = true;
        console.warn(
          '[tiltHub] hub has no JoinSession method; relying on the per-user group ' +
            'joined in OnConnectedAsync. Wire §4.3 server-side to scope pushes per session.'
        );
      }
      return;
    }
    console.warn('[tiltHub] JoinSession failed:', error);
  }
}

/** Leaves the session group and forgets it across reconnects. */
export async function leaveSession(sessionId: string): Promise<void> {
  joinedSessionId = null;

  if (connection?.state !== HubConnectionState.Connected) {
    return;
  }

  try {
    await connection.invoke('LeaveSession', sessionId);
  } catch {
    // Same story as JoinSession — absent server-side, and harmless either way.
  }
}

/** Tells the server the cooldown UI flow completed (§4.3). */
export async function confirmCooldownCompliance(cooldownId: string): Promise<boolean> {
  if (connection?.state !== HubConnectionState.Connected) {
    return false;
  }

  try {
    await connection.invoke('ConfirmCooldownCompliance', cooldownId);
    return true;
  } catch (error) {
    // Not yet implemented server-side; the watchdog releases on expiry anyway.
    console.warn('[tiltHub] ConfirmCooldownCompliance unavailable:', error);
    return false;
  }
}

/** Tears the connection down — called on logout and when a session ends. */
export async function stop(): Promise<void> {
  joinedSessionId = null;
  startPromise = null;

  if (!connection) {
    return;
  }

  try {
    await connection.stop();
  } catch (error) {
    console.warn('[tiltHub] stop failed:', error);
  } finally {
    setStatus('disconnected');
  }
}

export const tiltHub = {
  start,
  stop,
  joinSession,
  leaveSession,
  confirmCooldownCompliance,
  get state() {
    return connection?.state ?? HubConnectionState.Disconnected;
  },
};
