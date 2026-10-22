export type HistoryOutcome = 'succeeded' | 'failed';

export interface HistoryProfileEngineOptions {
  now?: () => number;
  retentionMs?: number;
  maxRecentSessions?: number;
}

export interface HistorySessionInput {
  outcome?: HistoryOutcome;
}

export interface HistorySessionSummary {
  lastActivityAt: string;
}

export interface HistoryResultSummary {
  outcome: HistoryOutcome;
  recordedAt: string;
}

export interface HistoryProfile {
  lastActivityAt: string;
  recentSessions: readonly HistorySessionSummary[];
  previousResults: readonly HistoryResultSummary[];
}

interface StoredSession {
  lastActivityAt: number;
  outcome?: HistoryOutcome;
}

interface StoredProfile { sessions: StoredSession[] }

export const DEFAULT_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MAX_RECENT_SESSIONS = 10;

/**
 * In-memory, app-scoped summaries keyed by a pseudonym supplied by the app.
 * This engine does not create identifiers, persist data, collect attributes,
 * or turn absent history into a risk signal. A pseudonym is not anonymity.
 */
export class HistoryProfileEngine {
  private readonly now: () => number;
  private readonly retentionMs: number;
  private readonly maxRecentSessions: number;
  private readonly profiles = new Map<string, StoredProfile>();
  private expiryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: HistoryProfileEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.retentionMs = options.retentionMs ?? DEFAULT_HISTORY_RETENTION_MS;
    this.maxRecentSessions = options.maxRecentSessions ?? DEFAULT_MAX_RECENT_SESSIONS;
    if (!Number.isFinite(this.retentionMs) || this.retentionMs <= 0) {
      throw new RangeError('retentionMs must be a positive finite duration');
    }
    if (!Number.isSafeInteger(this.maxRecentSessions) || this.maxRecentSessions <= 0) {
      throw new RangeError('maxRecentSessions must be a positive integer');
    }
  }

  /** Store one minimized activity/result summary for an app-owned session. */
  recordSession(appId: string, pseudonym: string, input: HistorySessionInput): void {
    this.requireIdentifier(appId, 'appId');
    this.requireIdentifier(pseudonym, 'pseudonym');
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new TypeError('session input must be an object');
    }
    if (Object.keys(input).some((key) => key !== 'outcome')) {
      throw new TypeError('session input contains unsupported fields');
    }
    if (input.outcome !== undefined && input.outcome !== 'succeeded' && input.outcome !== 'failed') {
      throw new TypeError('outcome must be succeeded or failed');
    }

    const now = this.timestamp();
    this.prune(now);
    const key = this.profileKey(appId, pseudonym);

    let profile = this.profiles.get(key);
    if (!profile) this.profiles.set(key, (profile = { sessions: [] }));
    profile.sessions.push({
      lastActivityAt: now,
      ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
    });
    this.trim(profile);
    this.scheduleExpiry(now);
  }

  /** Return only retained history; missing, expired, and opted-out history is absent. */
  getProfile(appId: string, pseudonym: string): HistoryProfile | undefined {
    this.requireIdentifier(appId, 'appId');
    this.requireIdentifier(pseudonym, 'pseudonym');
    const now = this.timestamp();
    this.prune(now);
    this.scheduleExpiry(now);
    const key = this.profileKey(appId, pseudonym);
    const profile = this.profiles.get(key);
    if (!profile || profile.sessions.length === 0) return undefined;

    const sessions = profile.sessions;
    const recentSessions = sessions.map((session) => Object.freeze({
      lastActivityAt: new Date(session.lastActivityAt).toISOString(),
    }));
    const previousResults = sessions.flatMap((session) => session.outcome === undefined ? [] : [Object.freeze({
      outcome: session.outcome,
      recordedAt: new Date(session.lastActivityAt).toISOString(),
    })]);
    return Object.freeze({
      lastActivityAt: new Date(sessions[sessions.length - 1].lastActivityAt).toISOString(),
      recentSessions: Object.freeze(recentSessions),
      previousResults: Object.freeze(previousResults),
    });
  }

  /** Erase this profile when the application opts the pseudonym out of history. */
  optOut(appId: string, pseudonym: string): void {
    this.requireIdentifier(appId, 'appId');
    this.requireIdentifier(pseudonym, 'pseudonym');
    const key = this.profileKey(appId, pseudonym);
    this.profiles.delete(key);
    this.scheduleExpiry(this.timestamp());
  }

  private trim(profile: StoredProfile): void {
    profile.sessions.splice(0, profile.sessions.length - this.maxRecentSessions);
  }

  private prune(now: number): void {
    const cutoff = now - this.retentionMs;
    for (const [key, profile] of this.profiles) {
      profile.sessions = profile.sessions.filter((session) => session.lastActivityAt > cutoff);
      if (profile.sessions.length === 0) this.profiles.delete(key);
    }
  }

  private scheduleExpiry(now: number): void {
    if (this.expiryTimer !== undefined) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let nextExpiry = Number.POSITIVE_INFINITY;
    for (const profile of this.profiles.values()) {
      for (const session of profile.sessions) {
        nextExpiry = Math.min(nextExpiry, session.lastActivityAt + this.retentionMs);
      }
    }
    if (!Number.isFinite(nextExpiry)) return;

    const delay = Math.max(1, Math.min(nextExpiry - now, 2_147_483_647));
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = undefined;
      const currentTime = this.timestamp();
      this.prune(currentTime);
      this.scheduleExpiry(currentTime);
    }, delay);
    (this.expiryTimer as unknown as { unref?: () => void }).unref?.();
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isFinite(value)) throw new TypeError('now must return a finite timestamp in milliseconds');
    return value;
  }

  private requireIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new TypeError(`${name} must be a non-empty string`);
    }
  }

  private profileKey(appId: string, pseudonym: string): string {
    return `${appId.length}:${appId}${pseudonym}`;
  }
}
