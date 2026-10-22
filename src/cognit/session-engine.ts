import { randomUUID } from 'node:crypto';

export type SessionState = 'active' | 'expired';
export type AttemptState = 'pending' | 'succeeded' | 'failed';
export type SessionReferenceKind = 'challenge' | 'result' | 'telemetry';

export interface SessionAssociations {
  attemptState?: AttemptState;
  challengeId?: string;
  resultId?: string;
  telemetryId?: string;
}

export interface Session {
  id: string;
  appId: string;
  state: SessionState;
  attemptState: AttemptState;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  expiredAt?: number;
  challengeId?: string;
  resultId?: string;
  telemetryId?: string;
}

export interface SessionEngineOptions {
  now?: () => number;
  createId?: () => string;
}

export class SessionEngine {
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly sessions = new Map<string, Session>();
  private readonly references = new Map<string, Set<string>>();

  constructor(options: SessionEngineOptions = {}) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  /** Register an existing app-owned record so it can be associated with a session. */
  registerReference(appId: string, kind: SessionReferenceKind, id: string): void {
    this.requireIdentifier(appId, 'appId');
    this.requireIdentifier(id, 'reference id');
    const key = this.referenceKey(appId, kind);
    let ids = this.references.get(key);
    if (!ids) this.references.set(key, (ids = new Set()));
    ids.add(id);
  }

  createSession(appId: string, expiresAt: number): Session {
    this.requireIdentifier(appId, 'appId');
    const now = this.now();
    if (!Number.isFinite(expiresAt) || expiresAt <= now) {
      throw new RangeError('expiresAt must be later than the current time');
    }

    const id = this.createId();
    this.requireIdentifier(id, 'session id');
    const key = this.sessionKey(appId, id);
    if (this.sessions.has(key)) throw new Error('session id already exists for app');
    const session: Session = {
      id,
      appId,
      state: 'active',
      attemptState: 'pending',
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    this.sessions.set(key, session);
    return { ...session };
  }

  getSession(appId: string, id: string): Session {
    const session = this.findSession(appId, id);
    this.expireIfDue(session);
    return { ...session };
  }

  updateSession(appId: string, id: string, associations: SessionAssociations): Session {
    const session = this.findSession(appId, id);
    this.assertActive(session);
    if (associations === null || typeof associations !== 'object' || Array.isArray(associations)) {
      throw new TypeError('update payload must be an object');
    }
    const allowedKeys = new Set(['attemptState', 'challengeId', 'resultId', 'telemetryId']);
    for (const key of Object.keys(associations)) {
      if (!allowedKeys.has(key)) throw new TypeError(`unsupported update field: ${key}`);
    }
    if (associations.attemptState !== undefined &&
        !(['pending', 'succeeded', 'failed'] as const).includes(associations.attemptState)) {
      throw new TypeError('attemptState must be pending, succeeded, or failed');
    }
    for (const kind of ['challenge', 'result', 'telemetry'] as const) {
      const refId = associations[`${kind}Id`];
      if (refId !== undefined && !this.references.get(this.referenceKey(appId, kind))?.has(refId)) {
        throw new Error(`${kind} reference does not exist for app`);
      }
    }
    if (associations.attemptState !== undefined) session.attemptState = associations.attemptState;
    if (associations.challengeId !== undefined) session.challengeId = associations.challengeId;
    if (associations.resultId !== undefined) session.resultId = associations.resultId;
    if (associations.telemetryId !== undefined) session.telemetryId = associations.telemetryId;
    session.updatedAt = this.now();
    return { ...session };
  }

  expireSession(appId: string, id: string): Session {
    const session = this.findSession(appId, id);
    if (session.state === 'active') {
      const now = this.now();
      session.state = 'expired';
      session.expiredAt = now;
      session.updatedAt = now;
    }
    return { ...session };
  }

  private findSession(appId: string, id: string): Session {
    this.requireIdentifier(appId, 'appId');
    this.requireIdentifier(id, 'session id');
    const session = this.sessions.get(this.sessionKey(appId, id));
    if (!session) throw new Error('session does not exist for app');
    return session;
  }

  private assertActive(session: Session): void {
    this.expireIfDue(session);
    if (session.state !== 'active') throw new Error('session is expired');
  }

  private expireIfDue(session: Session): void {
    const now = this.now();
    if (session.state === 'active' && now >= session.expiresAt) {
      session.state = 'expired';
      session.expiredAt = now;
      session.updatedAt = now;
    }
  }

  private requireIdentifier(value: string, name: string): void {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} is required`);
  }

  private sessionKey(appId: string, id: string): string {
    return `${appId.length}:${appId}${id}`;
  }

  private referenceKey(appId: string, kind: SessionReferenceKind): string {
    return `${appId.length}:${appId}:${kind}`;
  }
}
