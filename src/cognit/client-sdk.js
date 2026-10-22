/** Error returned when a Cognit API request cannot be completed. */
export class CognitClientError extends Error {
  constructor(message, { status = null, code, cause } = {}) {
    super(message, { cause });
    this.name = 'CognitClientError';
    this.status = status;
    this.code = code;
  }
}

/** Small browser client for the Cognit session API. */
export class CognitClient {
  constructor({ baseUrl, fetch: fetchImpl = globalThis.fetch } = {}) {
    if (typeof baseUrl !== 'string' || !baseUrl) throw new TypeError('baseUrl is required');
    if (typeof fetchImpl !== 'function') throw new TypeError('fetch must be a function');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  createSession() {
    return this.request('/sessions', 'POST');
  }

  getChallenge(sessionId) {
    return this.request(`${this.sessionPath(sessionId)}/challenge`, 'GET');
  }

  submitTelemetry(sessionId, telemetry) {
    return this.request(`${this.sessionPath(sessionId)}/telemetry`, 'POST', telemetry);
  }

  submitResult(sessionId, result) {
    return this.request(`${this.sessionPath(sessionId)}/result`, 'POST', result);
  }

  getResult(sessionId) {
    return this.request(`${this.sessionPath(sessionId)}/result`, 'GET');
  }

  sessionPath(sessionId) {
    if (typeof sessionId !== 'string' || !sessionId) throw new TypeError('sessionId is required');
    return `/sessions/${encodeURIComponent(sessionId)}`;
  }

  async request(path, method, payload) {
    const headers = { Accept: 'application/json' };
    const init = { method, headers };
    if (payload !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(payload);
    }

    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, init);
    } catch (cause) {
      throw new CognitClientError('Network request to Cognit API failed', {
        code: 'NETWORK_ERROR', cause,
      });
    }

    let text;
    try {
      text = await response.text();
    } catch (cause) {
      throw new CognitClientError('Network request to Cognit API failed while reading the response', {
        status: response.status, code: 'NETWORK_ERROR', cause,
      });
    }

    let data = null;
    try {
      if (text) data = JSON.parse(text);
    } catch (cause) {
      throw new CognitClientError('Cognit API returned invalid JSON', {
        status: response.status, code: 'INVALID_JSON', cause,
      });
    }
    if (!response.ok) {
      throw new CognitClientError(data?.message || `Cognit API request failed (${response.status})`, {
        status: response.status, code: data?.code || 'HTTP_ERROR',
      });
    }
    return data;
  }
}
