#!/usr/bin/env node
import { createHash, createHmac } from 'node:crypto';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONTRACT_VERSION = 'trial-record-v1';
const required = ['contract_version', 'trial_id', 'session_id', 'actor', 'label', 'provenance', 'manifest_ref', 'challenge_ref', 'outcome', 'started_at', 'ended_at', 'evidence_class', 'oracle_access'];
const actors = new Set(['HUMAN_CONFIRMED', 'AUTOMATION_CONTROL', 'AI_AGENT', 'UNKNOWN']);
const labels = new Set(['human', 'automation', 'ai_agent']);
const evidenceClasses = new Set(['human_report', 'automation', 'agent', 'unknown', 'accessible', 'oracle_assisted']);
const provenanceSources = new Set(['independent-human-review', 'independent-agent-review', 'controlled-automation', 'accessibility-review', 'oracle-control', 'unknown']);
const opaqueIdPattern = /^(trial|session|participant|challenge|seed|manifest)-[a-f0-9]{16,64}$/;
const isOpaqueId = value => typeof value === 'string' && opaqueIdPattern.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const validPseudonymKey = key => typeof key === 'string' && key.length >= 32;
const pseudonymizeId = (kind, value, studyId, key) => `${kind}-${createHmac('sha256', key).update(`${studyId}\0${kind}\0${value}`).digest('hex')}`;

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function clean(record, studyId, pseudonymKey) {
  const row = Object.fromEntries(required.map(key => [key, record[key]]));
  row.trial_id = pseudonymizeId('trial', record.trial_id, studyId, pseudonymKey);
  row.session_id = pseudonymizeId('session', record.session_id, studyId, pseudonymKey);
  row.manifest_ref = { ...record.manifest_ref, manifest_id: pseudonymizeId('manifest', record.manifest_ref.manifest_id, studyId, pseudonymKey) };
  row.challenge_ref = {
    ...record.challenge_ref,
    challenge_id: pseudonymizeId('challenge', record.challenge_ref.challenge_id, studyId, pseudonymKey),
    seed_ref: pseudonymizeId('seed', record.challenge_ref.seed_ref, studyId, pseudonymKey)
  };
  if (record.participant_id !== undefined) row.participant_id = pseudonymizeId('participant', record.participant_id, studyId, pseudonymKey);
  const observations = record.outcome?.observations;
  row.outcome = { status: record.outcome.status, duration_ms: record.outcome.duration_ms };
  if (observations) {
    const safe = {};
    for (const key of ['risk_score', 'prediction', 'policy']) {
      if (Object.hasOwn(observations, key)) safe[key] = observations[key];
    }
    if (Object.keys(safe).length) row.outcome.observations = safe;
  }
  return row;
}

function validUtcTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59 || second > 59) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function validateObservations(observations, index, error) {
  if (observations === undefined) return;
  if (!observations || typeof observations !== 'object' || Array.isArray(observations)) {
    error(index, 'observations', 'observations must be an object');
    return;
  }
  if (Object.keys(observations).some(key => !['risk_score', 'prediction', 'policy'].includes(key))) error(index, 'observations', 'Only risk_score, prediction, and policy observations are allowed');
  if (Object.hasOwn(observations, 'risk_score') && !(typeof observations.risk_score === 'number' && Number.isFinite(observations.risk_score) && observations.risk_score >= 0 && observations.risk_score <= 1)) error(index, 'risk_score', 'risk_score must be a finite number from 0 to 1');
  if (Object.hasOwn(observations, 'prediction') && !(typeof observations.prediction === 'string' && ['human', 'automation', 'ai_agent', 'unknown'].includes(observations.prediction))) error(index, 'prediction', 'prediction must be a documented scalar category');
  if (Object.hasOwn(observations, 'policy') && !(typeof observations.policy === 'string' && ['allow', 'block', 'challenge', 'unknown'].includes(observations.policy))) error(index, 'policy', 'policy must be a documented scalar category');
}

function containsUnsafeJsonValue(value, seen = new Set()) {
  if (typeof value === 'number') return !Number.isFinite(value);
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') return true;
  if (value && typeof value === 'object') {
    if (seen.has(value)) return true;
    seen.add(value);
    const unsafe = Object.values(value).some(child => containsUnsafeJsonValue(child, seen));
    seen.delete(value);
    return unsafe;
  }
  return false;
}

export function validateRecords(records, manifest, { pseudonymKey = process.env.TRIAL_RECORD_PSEUDONYM_KEY, requirePseudonymKey = false } = {}) {
  const errors = [];
  const error = (index, code, message) => errors.push({ index, code, message });
  if (!Array.isArray(records)) return { valid: false, errors: [{ index: null, code: 'records_type', message: 'Input must be an array' }], accepted_indices: [], accepted_count: 0, rejected_records: [] };
  const manifestPayload = manifest && Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== 'sha256'));
  const actualManifestHash = manifestPayload ? sha(canonical(manifestPayload)) : null;
  const manifestValid = !!manifest && isOpaqueId(manifest.manifest_id) && typeof manifest.version === 'string' && /^\d+\.\d+\.\d+$/.test(manifest.version) && typeof manifest.study_id === 'string' && !!manifest.study_id && typeof manifest.protocol_version === 'string' && !!manifest.protocol_version && Array.isArray(manifest.challenge_ids) && manifest.challenge_ids.length > 0 && manifest.challenge_ids.every(isOpaqueId) && /^[a-f0-9]{64}$/.test(manifest.config_hash ?? '') && manifest.sha256 === actualManifestHash;
  if (!manifestValid) error(null, 'manifest_hash', 'Manifest must have study, protocol, id, version, and a sha256 matching its canonical content');
  const idCounts = new Map();
  for (const record of records) if (record && typeof record.trial_id === 'string' && record.trial_id.trim()) idCounts.set(record.trial_id, (idCounts.get(record.trial_id) ?? 0) + 1);

  records.forEach((record, index) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) { error(index, 'record_type', 'Record must be an object'); return; }
    if (requirePseudonymKey && !validPseudonymKey(pseudonymKey)) error(index, 'pseudonym_key', 'A secret of at least 32 characters is required to pseudonymize exported identifiers');
    if (!manifestValid) error(index, 'manifest_invalid', 'Record cannot be accepted without a valid referenced manifest');
    if (containsUnsafeJsonValue(record)) error(index, 'json_value', 'Records must contain only finite JSON-safe values');
    for (const key of required) if (!Object.hasOwn(record, key)) error(index, 'required', `Missing ${key}`);
    if (record.contract_version !== CONTRACT_VERSION) error(index, 'contract_version', 'Unsupported contract version');
    if (!isOpaqueId(record.trial_id) || !record.trial_id.startsWith('trial-')) error(index, 'trial_id', 'trial_id must be an opaque trial-prefixed identifier');
    else if (idCounts.get(record.trial_id) > 1) error(index, 'duplicate_id', `Duplicate trial_id ${record.trial_id}`);
    if (!isOpaqueId(record.session_id) || !record.session_id.startsWith('session-')) error(index, 'session_id', 'session_id must be an opaque session-prefixed identifier');
    if (record.participant_id !== undefined && (!isOpaqueId(record.participant_id) || !record.participant_id.startsWith('participant-'))) error(index, 'participant_id', 'participant_id must be an optional opaque pseudonymous identifier');
    if (record.participant_id !== undefined && !validPseudonymKey(pseudonymKey)) error(index, 'participant_key', 'A secret of at least 32 characters is required to export participant pseudonyms');

    if (!actors.has(record.actor)) error(index, 'actor', 'Unknown actor');
    if (!evidenceClasses.has(record.evidence_class)) error(index, 'evidence_class', 'Unknown evidence class');
    if (typeof record.oracle_access !== 'boolean') error(index, 'oracle_access', 'oracle_access must be explicit boolean');
    if ((record.evidence_class === 'oracle_assisted') !== (record.oracle_access === true)) error(index, 'oracle_evidence', 'oracle_assisted evidence requires oracle_access=true and oracle access requires oracle_assisted evidence');

    const provenance = record.provenance;
    if (!provenance || typeof provenance.source !== 'string' || !provenanceSources.has(provenance.source) || typeof provenance.independent !== 'boolean' || typeof provenance.valid !== 'boolean') error(index, 'provenance', 'Provenance must use a documented source and include independent and valid booleans');
    if (record.label !== null && !labels.has(record.label)) error(index, 'label_value', 'label must be null or a documented category');
    if (record.label !== null && (!provenance?.independent || !provenance?.valid || ['unknown', 'oracle-control'].includes(provenance?.source))) error(index, 'label_provenance', 'A ground-truth label requires valid independent provenance');
    if (record.actor === 'UNKNOWN' && record.label !== null) error(index, 'unknown_label', 'UNKNOWN actor must preserve a null label');
    const expectedLabel = { HUMAN_CONFIRMED: 'human', AUTOMATION_CONTROL: 'automation', AI_AGENT: 'ai_agent' }[record.actor];
    if (expectedLabel && record.label !== null && record.label !== expectedLabel) error(index, 'actor_label', 'label must match the confirmed actor category');
    if (record.oracle_access === true && record.label !== null) error(index, 'oracle_exclusion', 'Oracle-assisted rows cannot carry a ground-truth label for perception');
    if (record.actor === 'HUMAN_CONFIRMED' && !['independent-human-review', 'accessibility-review'].includes(provenance?.source) && record.label !== null) error(index, 'label_provenance', 'HUMAN_CONFIRMED requires human review provenance');
    if (record.actor === 'AI_AGENT' && provenance?.source !== 'independent-agent-review' && record.label !== null) error(index, 'label_provenance', 'AI_AGENT requires independent agent review provenance');
    if (record.actor === 'AUTOMATION_CONTROL' && provenance?.source !== 'controlled-automation' && record.label !== null) error(index, 'label_provenance', 'AUTOMATION_CONTROL requires controlled automation provenance');
    const validEvidenceByActor = {
      HUMAN_CONFIRMED: ['human_report', 'accessible'],
      AUTOMATION_CONTROL: ['automation', 'oracle_assisted'],
      AI_AGENT: ['agent', 'oracle_assisted'],
      UNKNOWN: ['unknown']
    };
    if (validEvidenceByActor[record.actor] && !validEvidenceByActor[record.actor].includes(record.evidence_class)) error(index, 'actor_evidence', 'evidence_class must match the actor and oracle status');
    if (record.oracle_access === true && !['AUTOMATION_CONTROL', 'AI_AGENT'].includes(record.actor)) error(index, 'oracle_evidence', 'Oracle access is only valid for automation or agent controls');

    const reference = record.manifest_ref;
    if (!reference || reference.manifest_id !== manifest?.manifest_id || reference.sha256 !== manifest?.sha256 || reference.version !== manifest?.version) error(index, 'manifest_ref', 'Manifest reference does not match the supplied manifest');
    if (!reference || !/^[a-f0-9]{64}$/.test(reference.sha256 ?? '')) error(index, 'manifest_hash', 'Manifest hash must be lowercase SHA-256');
    const challenge = record.challenge_ref;
    if (!challenge || !isOpaqueId(challenge.challenge_id) || !challenge.challenge_id.startsWith('challenge-') || !isOpaqueId(challenge.seed_ref) || !challenge.seed_ref.startsWith('seed-') || !/^[a-f0-9]{64}$/.test(challenge.config_hash ?? '') || !manifest?.challenge_ids?.includes(challenge.challenge_id) || challenge.config_hash !== manifest?.config_hash) error(index, 'challenge_ref', 'Challenge, seed, or config reference does not match the manifest');

    const start = validUtcTimestamp(record.started_at);
    const end = validUtcTimestamp(record.ended_at);
    if (start === null || end === null) error(index, 'timestamp', 'Timestamps must be valid UTC ISO date-times');
    else if (end < start) error(index, 'timestamp_order', 'ended_at cannot precede started_at');
    if (!record.outcome || !['completed', 'failed', 'abandoned', 'unknown'].includes(record.outcome.status)) error(index, 'outcome_status', 'Invalid outcome status');
    const duration = record.outcome?.duration_ms;
    if (duration !== null && !(typeof duration === 'number' && Number.isFinite(duration) && duration >= 0)) error(index, 'duration', 'duration_ms must be null or a finite non-negative number');
    if (start !== null && end !== null && typeof duration === 'number' && Number.isFinite(duration) && Math.abs(duration - (end - start)) > 1) error(index, 'duration_mismatch', 'duration_ms disagrees with timestamps');
    validateObservations(record.outcome?.observations, index, error);
  });
  const errorsByIndex = new Map();
  for (const item of errors) {
    if (item.index === null) continue;
    if (!errorsByIndex.has(item.index)) errorsByIndex.set(item.index, []);
    errorsByIndex.get(item.index).push({ code: item.code, message: item.message });
  }
  const accepted_indices = records.map((_, index) => index).filter(index => !errorsByIndex.has(index));
  const rejected_records = [...errorsByIndex.entries()].map(([index, reasons]) => ({ index, trial_id: validPseudonymKey(pseudonymKey) && isOpaqueId(records[index]?.trial_id) && records[index].trial_id.startsWith('trial-') ? pseudonymizeId('trial', records[index].trial_id, manifest?.study_id ?? '', pseudonymKey) : null, reasons }));
  return { valid: errors.length === 0, errors, accepted_indices, accepted_count: accepted_indices.length, rejected_records };
}

export function exportJsonl(records, manifest, { pseudonymKey = process.env.TRIAL_RECORD_PSEUDONYM_KEY } = {}) {
  const qc = validateRecords(records, manifest, { pseudonymKey, requirePseudonymKey: true });
  const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const rows = qc.accepted_indices.map(index => clean(records[index], manifest.study_id, pseudonymKey)).sort((a, b) => compare(a.session_id, b.session_id) || compare(a.trial_id, b.trial_id));
  const artifactHash = sha(rows.map(canonical).join('\n'));
  const header = { type: 'trial-record-export', contract_version: CONTRACT_VERSION, artifact_hash: artifactHash, qc_report: { valid: qc.valid, total_count: Array.isArray(records) ? records.length : 0, accepted_count: qc.accepted_count, rejected_count: qc.rejected_records.length, rejected_records: qc.rejected_records, errors: qc.errors.filter(item => item.index === null) } };
  return `${canonical(header)}\n${rows.map(canonical).join('\n')}${rows.length ? '\n' : ''}`;
}

async function main(args) {
  const opts = Object.fromEntries(args.slice(2).reduce((pairs, arg, i, all) => arg.startsWith('--') ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
  if (!opts.input || !opts.manifest) throw new Error('Usage: node scripts/trial-record.mjs --input FILE --manifest FILE [--output FILE]');
  const records = JSON.parse(await readFile(opts.input, 'utf8'));
  const manifest = JSON.parse(await readFile(opts.manifest, 'utf8'));
  if (opts.output) {
    const inputPath = await realpath(opts.input);
    const manifestPath = await realpath(opts.manifest);
    let outputPath;
    try { outputPath = await realpath(opts.output); }
    catch { outputPath = resolve(await realpath(dirname(resolve(opts.output))), basename(opts.output)); }
    if (outputPath === inputPath || outputPath === manifestPath) throw new Error('Output path must differ from input and manifest paths');
  }
  const pseudonymKey = process.env.TRIAL_RECORD_PSEUDONYM_KEY;
  const qc = validateRecords(records, manifest, { pseudonymKey, requirePseudonymKey: true });
  const output = exportJsonl(records, manifest, { pseudonymKey });
  if (opts.output) await writeFile(opts.output, output); else process.stdout.write(output);
  if (!qc.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 2; });
