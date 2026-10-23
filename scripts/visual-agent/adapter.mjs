import { randomUUID } from 'node:crypto';

export const SCHEMA_VERSION = 1;
export const ALLOWED_ORIGIN = 'http://127.0.0.1:4173';
export const MAX_ACTIONS = 20;

const REQUIRED_PROVENANCE = [
  'provider',
  'model',
  'model_version',
  'prompt_template_version',
  'browser',
  'cognit_commit',
];

function safeConfiguration(value, key = '', depth = 0) {
  if (/(?:api[_-]?key|private[_-]?key|auth(?:entication|orization)?|credential|password|secret|token)/i.test(key)) return '[REDACTED]';
  if (depth >= 5) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => safeConfiguration(entry, '', depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).slice(0, 50).map(([name, entry]) => [name, safeConfiguration(entry, name, depth + 1)]));
  }
  if (typeof value === 'string') return value.slice(0, 240);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return String(value).slice(0, 80);
}

function validateProvenance(provenance) {
  for (const field of REQUIRED_PROVENANCE) {
    if (typeof provenance?.[field] !== 'string' || provenance[field].trim() === '') {
      throw new TypeError(`provenance.${field} must be a non-empty string`);
    }
  }
  if (!provenance.configuration || typeof provenance.configuration !== 'object' || Array.isArray(provenance.configuration) || Object.keys(provenance.configuration).length === 0) {
    throw new TypeError('provenance.configuration must be a non-empty object');
  }
  if (!['SIMULATED', 'MEASURED_LAB'].includes(provenance.execution_mode)) {
    throw new TypeError('provenance.execution_mode must be SIMULATED or MEASURED_LAB');
  }
  if (provenance.execution_mode === 'MEASURED_LAB' && provenance.provider === 'mock') {
    throw new TypeError('mock executions must be marked SIMULATED');
  }
}

function validateBrowser(browser) {
  const origin = new URL(browser?.origin).origin;
  if (origin !== ALLOWED_ORIGIN) {
    throw new Error(`blocked browser origin: ${origin}`);
  }
  for (const method of ['screenshot', 'click']) {
    if (typeof browser[method] !== 'function') {
      throw new TypeError(`browser.${method} must be a function`);
    }
  }
  for (const forbidden of ['evaluate', 'locator', 'request', 'navigate', 'challenge', 'expectedAnswer']) {
    if (forbidden in browser) {
      throw new TypeError(`browser.${forbidden} is not an allowed visual capability`);
    }
  }
}

function validateAction(action, viewport) {
  if (action?.type === 'stop') return { type: 'stop' };
  if (action?.type !== 'click') throw new TypeError('agent action must be click or stop');
  const { x, y } = action;
  const roundedX = Math.round(x);
  const roundedY = Math.round(y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || roundedX < 0 || roundedY < 0 || roundedX >= viewport.width || roundedY >= viewport.height) {
    throw new RangeError('click coordinates must be within the screenshot viewport');
  }
  return { type: 'click', x: roundedX, y: roundedY };
}

/**
 * Runs a screenshot-only agent against a browser port with no DOM, network, or navigation API.
 * The port is pinned to the controlled local demo origin; raw screenshots are never exported.
 */
export async function runVisualAttempt({ browser, agent, provenance, sessionId = randomUUID(), attemptId = randomUUID(), maxActions = MAX_ACTIONS }) {
  validateBrowser(browser);
  validateProvenance(provenance);
  if (!agent || typeof agent.act !== 'function') throw new TypeError('agent.act must be a function');
  if (!Number.isInteger(maxActions) || maxActions < 1 || maxActions > MAX_ACTIONS) throw new RangeError(`maxActions must be 1-${MAX_ACTIONS}`);

  const startedAt = new Date().toISOString();
  const actions = [];
  let observedResult = null;
  let failure = null;
  try {
    for (let index = 0; index < maxActions; index += 1) {
      validateBrowser(browser);
      const frame = await browser.screenshot();
      validateBrowser(browser);
      if (!frame || !(frame.data instanceof Uint8Array) || typeof frame.mimeType !== 'string' || !frame.mimeType.startsWith('image/') ||
          !Number.isFinite(frame.width) || !Number.isFinite(frame.height) || frame.width <= 0 || frame.height <= 0) {
        throw new TypeError('browser.screenshot must return image bytes, mimeType, width, and height');
      }
      const response = await agent.act({
        screenshot: { data: frame.data, mimeType: frame.mimeType },
        viewport: { width: frame.width, height: frame.height },
      });
      validateBrowser(browser);
      if (response?.status === 'refused' || response?.refusal === true || typeof response?.refusal === 'string') {
        failure = { name: 'AgentRefusal', message: String(response.refusal === true ? response.observation ?? 'agent refused the attempt' : response.refusal).slice(0, 240) };
        break;
      }
      const action = validateAction(response?.action, frame);
      if (typeof response?.observation === 'string') observedResult = response.observation.slice(0, 240);
      if (action.type === 'stop') break;
      await browser.click(action.x, action.y);
      validateBrowser(browser);
      actions.push(action);
      if (index === maxActions - 1) throw new Error('maximum visual action count reached');
    }
  } catch (error) {
    failure = { name: error.name || 'Error', message: String(error.message || error).slice(0, 240) };
  }

  return {
    schema_version: SCHEMA_VERSION,
    session_id: sessionId,
    attempt_id: attemptId,
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    execution_mode: provenance.execution_mode,
    result: 'UNKNOWN',
    observed_result: observedResult,
    actions,
    failure,
    provenance: { ...structuredClone(provenance), configuration: safeConfiguration(provenance.configuration) },
  };
}
