import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const schemaPath = new URL('../schemas/trial-manifest-v1.schema.json', import.meta.url);
export const CURRENT_MANIFEST_VERSION = '1.0.0';
export const CURRENT_PROTOCOL_VERSION = '1.0.0';

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashConfig(config) {
  return createHash('sha256').update(canonicalize(config), 'utf8').digest('hex');
}

export function hashManifest(manifest) {
  const { manifest_sha256: _manifestHash, ...content } = manifest;
  return createHash('sha256').update(canonicalize(content), 'utf8').digest('hex');
}

function isRfc3339DateTime(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.\d+)?(Z|([+-])(\d\d):(\d\d))$/.exec(value);
  if (!match) return false;
  const [, y, m, d, hh, mm, ss, , , offsetHour, offsetMinute] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const hour = Number(hh), minute = Number(mm), second = Number(ss);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth && hour <= 23 && minute <= 59 && second <= 59 &&
    (offsetHour === undefined || (Number(offsetHour) <= 23 && Number(offsetMinute) <= 59));
}

const required = [
  'manifest_version', 'manifest_id', 'manifest_sha256', 'study_id', 'protocol_version', 'cognit_commit', 'created_at',
  'environment', 'actor', 'challenge_set', 'seed', 'config', 'config_sha256', 'accessible_mode',
  'evidence_class', 'result', 'observations',
];
const allowed = new Set([...required, 'ground_truth']);

function expectObject(value, path, errors) {
  if (!value || Array.isArray(value) || typeof value !== 'object') {
    errors.push(`${path}: expected object`);
    return false;
  }
  return true;
}

function checkKeys(value, path, requiredKeys, allowedKeys, errors) {
  for (const key of requiredKeys) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required`);
  for (const key of Object.keys(value)) if (!allowedKeys.includes(key)) errors.push(`${path}.${key}: unknown field`);
}

function nonEmpty(value, path, errors) {
  if (typeof value !== 'string' || value.length === 0) errors.push(`${path}: expected non-empty string`);
}

function checkRecord(record, path, requiredKeys, optionalKeys, errors) {
  if (!expectObject(record, path, errors)) return false;
  checkKeys(record, path, requiredKeys, [...requiredKeys, ...optionalKeys], errors);
  return true;
}

/** Validate a manifest with stable, path-qualified diagnostics. */
export function validateManifest(manifest) {
  const errors = [];
  if (!expectObject(manifest, '$', errors)) return { valid: false, errors };
  checkKeys(manifest, '$', required, [...allowed], errors);
  if (manifest.manifest_version !== CURRENT_MANIFEST_VERSION) errors.push(`$.manifest_version: unsupported version (expected ${CURRENT_MANIFEST_VERSION})`);
  for (const key of ['manifest_id', 'study_id']) if (Object.hasOwn(manifest, key)) nonEmpty(manifest[key], `$.${key}`, errors);
  if (manifest.protocol_version !== CURRENT_PROTOCOL_VERSION) errors.push(`$.protocol_version: unsupported version (expected ${CURRENT_PROTOCOL_VERSION})`);
  if (typeof manifest.cognit_commit !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(manifest.cognit_commit)) errors.push('$.cognit_commit: expected 40- or 64-character lowercase git hash');
  if (!isRfc3339DateTime(manifest.created_at)) errors.push('$.created_at: expected RFC 3339 date-time');

  if (checkRecord(manifest.environment, '$.environment', ['browser', 'browser_version', 'os', 'os_version'], [], errors)) {
    for (const key of ['browser', 'browser_version', 'os', 'os_version']) nonEmpty(manifest.environment[key], `$.environment.${key}`, errors);
  }
  if (checkRecord(manifest.actor, '$.actor', ['type', 'version'], [], errors)) {
    if (!['HUMAN', 'SCRIPTED_AUTOMATION', 'AI_AGENT', 'UNKNOWN'].includes(manifest.actor.type)) errors.push('$.actor.type: invalid actor type');
    nonEmpty(manifest.actor.version, '$.actor.version', errors);
  }
  if (checkRecord(manifest.challenge_set, '$.challenge_set', ['id', 'version'], ['challenge_ids'], errors)) {
    nonEmpty(manifest.challenge_set.id, '$.challenge_set.id', errors);
    nonEmpty(manifest.challenge_set.version, '$.challenge_set.version', errors);
    if (manifest.challenge_set.challenge_ids !== undefined) {
      const ids = manifest.challenge_set.challenge_ids;
      if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== 'string' || !/^challenge-[a-f0-9]{16,64}$/.test(id)) || new Set(ids).size !== ids.length) errors.push('$.challenge_set.challenge_ids: expected unique opaque challenge IDs');
    }
  }
  if (!(typeof manifest.seed === 'string' || (Number.isSafeInteger(manifest.seed)))) errors.push('$.seed: expected string or safe integer');
  if (!expectObject(manifest.config, '$.config', errors)) { /* diagnostic recorded */ }
  if (typeof manifest.config_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.config_sha256)) errors.push('$.config_sha256: expected 64-character lowercase SHA-256');
  else if (manifest.config && typeof manifest.config === 'object' && !Array.isArray(manifest.config) && hashConfig(manifest.config) !== manifest.config_sha256) errors.push('$.config_sha256: does not match canonical config SHA-256');
  if (typeof manifest.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.manifest_sha256)) errors.push('$.manifest_sha256: expected 64-character lowercase SHA-256');
  else if (hashManifest(manifest) !== manifest.manifest_sha256) errors.push('$.manifest_sha256: does not match canonical manifest SHA-256');
  if (!['STANDARD', 'ACCESSIBLE', 'NOT_APPLICABLE'].includes(manifest.accessible_mode)) errors.push('$.accessible_mode: invalid accessible mode');
  if (!['SIMULATED', 'OBSERVED', 'REPLAYED'].includes(manifest.evidence_class)) errors.push('$.evidence_class: invalid evidence class');
  if (!['PASS', 'FAIL', 'UNKNOWN'].includes(manifest.result)) errors.push('$.result: invalid result');

  if (manifest.ground_truth !== undefined && checkRecord(manifest.ground_truth, '$.ground_truth', ['label', 'provenance'], ['reference'], errors)) {
    if (!['HUMAN', 'SCRIPTED_AUTOMATION', 'AI_AGENT', 'UNKNOWN'].includes(manifest.ground_truth.label)) errors.push('$.ground_truth.label: invalid label');
    if (!['independent_human_confirmation', 'dataset_label', 'external_oracle'].includes(manifest.ground_truth.provenance)) errors.push('$.ground_truth.provenance: must identify independent ground-truth provenance');
    if (manifest.ground_truth.reference !== undefined) nonEmpty(manifest.ground_truth.reference, '$.ground_truth.reference', errors);
  }
  if (!Array.isArray(manifest.observations)) errors.push('$.observations: expected array');
  else manifest.observations.forEach((item, index) => {
    const path = `$.observations[${index}]`;
    if (!checkRecord(item, path, ['source', 'value'], ['version'], errors)) return;
    if (!['risk_score', 'policy', 'classifier', 'other'].includes(item.source)) errors.push(`${path}.source: invalid observation source`);
    if (item.version !== undefined) nonEmpty(item.version, `${path}.version`, errors);
  });
  errors.sort();
  return { valid: errors.length === 0, errors };
}

async function validateFixtureDirectory() {
  const root = new URL('../fixtures/trial-manifest-v1/', import.meta.url);
  const cases = [
    ['valid.json', true, []],
    ['unknown-values.json', true, []],
    ['missing-required.json', false, ['$.config_sha256: required', '$.manifest_sha256: required', '$.study_id: required']],
    ['unsafe-seed.json', false, ['$.seed: expected string or safe integer']],
    ['unknown-version.json', false, ['$.manifest_version: unsupported version (expected 1.0.0)', '$.protocol_version: unsupported version (expected 1.0.0)']],
    ['changed-config.json', false, ['$.config_sha256: does not match canonical config SHA-256']],
    ['unsafe-ground-truth.json', false, ['$.ground_truth.provenance: must identify independent ground-truth provenance']],
  ];
  let failures = 0;
  for (const [name, expectedValid, expectedErrors] of cases) {
    const manifest = JSON.parse(await readFile(new URL(name, root), 'utf8'));
    const result = validateManifest(manifest);
    const matched = result.valid === expectedValid && expectedErrors.every((expected) => result.errors.includes(expected));
    console.log(`${matched ? 'PASS' : 'FAIL'} ${name}${result.errors.length ? `: ${result.errors.join('; ')}` : ''}`);
    if (!matched) failures += 1;
  }
  console.log(`${failures ? 'FAIL' : 'PASS'} trial manifest fixtures (${cases.length - failures}/${cases.length})`);
  if (failures) process.exitCode = 1;
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) return validateFixtureDirectory();
  const manifest = JSON.parse(await readFile(resolve(inputPath), 'utf8'));
  const result = validateManifest(manifest);
  if (result.valid) console.log(`PASS manifest ${manifest.manifest_id} (${manifest.protocol_version}, ${manifest.cognit_commit}, manifest ${manifest.manifest_sha256}, config ${manifest.config_sha256})`);
  else {
    console.error(`FAIL manifest (${manifest.protocol_version ?? 'unknown protocol'}, ${manifest.cognit_commit ?? 'unknown commit'}, config ${manifest.config_sha256 ?? 'missing config hash'})`);
    result.errors.forEach((error) => console.error(`- ${error}`));
    process.exitCode = 1;
  }
}

export const schemaUrl = schemaPath;
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
