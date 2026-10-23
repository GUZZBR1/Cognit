/** JSON object accepted by the session telemetry endpoint. */
export type Telemetry = Record<string, unknown>;

/** Session response used by the demo service and verification API. */
export interface Session {
  session_id: string;
  status?: 'active' | 'expired';
  state?: 'active' | 'expired';
  attempt_state?: 'pending' | 'succeeded' | 'failed';
  expires_at?: string;
}

/** Public challenge presentation returned for a session. */
export interface Challenge {
  challenge_id: string;
  stimulus?: string;
  question?: string;
  choices?: string[];
  order?: string[];
  duration_ms?: number;
  expires_at?: string;
  stimulus_id?: string;
  title?: string;
  instruction?: string;
  answer_label?: string;
  tiles?: unknown[];
}

/** Response from submitting or retrieving a challenge result. */
export interface Result {
  result_id?: string;
  accepted?: boolean;
  state?: 'pending' | 'succeeded' | 'failed';
  status?: 'pending' | 'completed' | 'received' | 'succeeded' | 'failed';
  result?: unknown;
  verification_token?: string;
}

/** Acknowledgement returned after telemetry is accepted by the API. */
export interface TelemetryResponse {
  accepted?: boolean;
  status?: string;
}

/** Server-side verification state for a session. */
export interface Verification {
  session_id: string;
  state: 'active' | 'expired';
  attempt_state: 'pending' | 'succeeded' | 'failed';
}

export interface CognitClientErrorOptions {
  status?: number | null;
  code?: string;
  cause?: unknown;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

export interface CognitClientOptions {
  baseUrl: string;
  fetch?: FetchLike;
}

/** Error returned when a Cognit API request cannot be completed. */
export class CognitClientError extends Error {
  status: number | null;
  code: string | undefined;

  constructor(message: string, { status = null, code, cause }: CognitClientErrorOptions = {}) {
    super(message, { cause });
    this.name = 'CognitClientError';
    this.status = status;
    this.code = code;
  }
}

/** Small browser client for the Cognit session API. */
export class CognitClient {
  private readonly baseUrl: string;
  private readonly fetch: FetchLike;

  constructor({ baseUrl, fetch: fetchImpl }: CognitClientOptions) {
    if (typeof baseUrl !== 'string' || !baseUrl) throw new TypeError('baseUrl is required');
    const resolvedFetch = fetchImpl ?? globalThis.fetch?.bind(globalThis) as FetchLike | undefined;
    if (typeof resolvedFetch !== 'function') throw new TypeError('fetch must be a function');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = resolvedFetch;
  }

  createSession(): Promise<Session> {
    return this.request<Session>('/sessions', 'POST');
  }

  getChallenge(sessionId: string): Promise<Challenge> {
    return this.request<Challenge>(`${this.sessionPath(sessionId)}/challenge`, 'GET');
  }

  submitTelemetry(sessionId: string, telemetry: Telemetry): Promise<TelemetryResponse> {
    return this.request<TelemetryResponse>(`${this.sessionPath(sessionId)}/telemetry`, 'POST', telemetry);
  }

  submitResult(sessionId: string, result: Record<string, unknown>): Promise<Result> {
    return this.request<Result>(`${this.sessionPath(sessionId)}/result`, 'POST', result);
  }

  getResult(sessionId: string): Promise<Result> {
    return this.request<Result>(`${this.sessionPath(sessionId)}/result`, 'GET');
  }

  verifySession(sessionId: string): Promise<Verification> {
    return this.request<Verification>(`${this.sessionPath(sessionId)}/verify`, 'POST');
  }

  private sessionPath(sessionId: string): string {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    return `/sessions/${encodeURIComponent(sessionId)}`;
  }

  private async request<T>(path: string, method: string, payload?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }

    let response: FetchResponse;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new CognitClientError('Network request to Cognit API failed', {
        code: 'NETWORK_ERROR', cause,
      });
    }

    let text: string;
    try {
      text = await response.text();
    } catch (cause) {
      throw new CognitClientError('Network request to Cognit API failed while reading the response', {
        status: response.status, code: 'NETWORK_ERROR', cause,
      });
    }

    let data: unknown = null;
    try {
      if (text) data = JSON.parse(text);
    } catch (cause) {
      throw new CognitClientError('Cognit API returned invalid JSON', {
        status: response.status, code: 'INVALID_JSON', cause,
      });
    }
    if (!response.ok) {
      const errorData = data && typeof data === 'object' ? data as { message?: string; code?: string } : {};
      throw new CognitClientError(errorData.message || `Cognit API request failed (${response.status})`, {
        status: response.status, code: errorData.code || 'HTTP_ERROR',
      });
    }
    return data as T;
  }
}
