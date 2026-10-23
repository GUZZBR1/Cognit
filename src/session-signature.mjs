export const SESSION_SIGNATURE_SCHEMA_VERSION = 0;
const GROUPS = {
  perception: ['duration_ms', 'correct'],
  timing: ['durationMs', 'reactionTimeMs'],
  behavior: ['distancePx', 'durationMs', 'meanSpeedPxPerMs', 'pauseCount', 'directionChanges', 'speedVariation', 'trajectoryEntropyBits'],
  journey: ['sessionCount', 'succeededCount', 'failedCount'],
  browser: ['navigator_webdriver', 'playwright_globals', 'selenium_globals', 'puppeteer_global', 'headless_chromium_user_agent', 'empty_plugin_list', 'empty_languages_list'],
  history: ['sessionCount', 'succeededCount', 'failedCount'],
};
const BOOLEAN_FEATURES = new Set([
  'perception.correct',
  'browser.navigator_webdriver',
  'browser.playwright_globals',
  'browser.selenium_globals',
  'browser.puppeteer_global',
  'browser.headless_chromium_user_agent',
  'browser.empty_plugin_list',
  'browser.empty_languages_list',
]);
const COUNT_FEATURES = new Set([
  'behavior.pauseCount',
  'behavior.directionChanges',
  'journey.sessionCount',
  'journey.succeededCount',
  'journey.failedCount',
  'history.sessionCount',
  'history.succeededCount',
  'history.failedCount',
]);
const FEATURE_KEYS = new Set(Object.entries(GROUPS).flatMap(([group, fields]) => fields.map((field) => `${group}.${field}`)));

function normalizeFeature(key, value) {
  if (BOOLEAN_FEATURES.has(key)) return typeof value === 'boolean' ? Number(value) : undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  if (COUNT_FEATURES.has(key) && !Number.isSafeInteger(value)) return undefined;
  return value;
}

function validateFeatureMap(features) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw new TypeError('signature_features_required');
  }
  for (const [key, value] of Object.entries(features)) {
    if (!FEATURE_KEYS.has(key)) throw new TypeError(`unsupported_signature_feature: ${key}`);
    if (BOOLEAN_FEATURES.has(key)) {
      if (value !== 0 && value !== 1) throw new TypeError(`invalid_signature_feature: ${key}`);
    } else if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 ||
        (COUNT_FEATURES.has(key) && !Number.isSafeInteger(value))) {
      throw new TypeError(`invalid_signature_feature: ${key}`);
    }
  }
}

/** Flatten caller-supplied minimized aggregates. No events, IDs, or persistence. */
export function buildSessionSignature(session) {
  if (!session || typeof session !== 'object' || Array.isArray(session)) throw new TypeError('session_must_be_an_object');
  const features = {};
  const unavailable = {};
  for (const [group, fields] of Object.entries(GROUPS)) {
    const source = group === 'behavior' ? session.behavior?.features : session[group];
    const absentGroup = source === undefined || source === null || typeof source !== 'object' || Array.isArray(source);
    unavailable[group] = [];
    for (const field of fields) {
      const key = `${group}.${field}`;
      const value = absentGroup || !Object.hasOwn(source, field) ? undefined : source[field];
      const normalized = normalizeFeature(key, value);
      if (normalized !== undefined) features[key] = normalized;
      else unavailable[group].push(key);
    }
  }
  return { schemaVersion: SESSION_SIGNATURE_SCHEMA_VERSION, features, unavailable };
}

/** Mean symmetric relative difference over jointly available values. */
export function compareSessionSignatures(left, right) {
  if (left?.schemaVersion !== SESSION_SIGNATURE_SCHEMA_VERSION || right?.schemaVersion !== SESSION_SIGNATURE_SCHEMA_VERSION) throw new TypeError('incompatible_signature_schema_version');
  const a = left?.features;
  const b = right?.features;
  validateFeatureMap(a);
  validateFeatureMap(b);
  const common = Object.keys(a).filter((key) => Object.hasOwn(b, key)).sort();
  const union = new Set([...Object.keys(a), ...Object.keys(b)]);
  const distance = common.length
    ? common.reduce((sum, key) => sum + Math.abs(a[key] - b[key]) / Math.max(1, Math.abs(a[key]), Math.abs(b[key])), 0) / common.length
    : null;
  return { method: 'mean-symmetric-relative-difference-v0', distance, commonFeatureCount: common.length, unionFeatureCount: union.size, coverage: union.size ? common.length / union.size : 0, commonFeatures: common };
}
