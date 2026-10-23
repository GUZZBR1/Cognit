import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { validateRecords, exportJsonl, canonical } from '../scripts/trial-record.mjs';
import { hashManifest } from '../scripts/trial-manifest.mjs';

const base = new URL('../fixtures/trial-record-v1/', import.meta.url);
const records = JSON.parse(await readFile(new URL('records.json', base), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('manifest.json', base), 'utf8'));
const invalid = JSON.parse(await readFile(new URL('invalid.json', base), 'utf8'));
const benchmarkFixture = new URL('../fixtures/trial-record-benchmark-v1/', import.meta.url);
const bridgeRecords = JSON.parse(await readFile(new URL('records.json', benchmarkFixture), 'utf8'));
const bridgeManifest = JSON.parse(await readFile(new URL('manifest.json', benchmarkFixture), 'utf8'));
const trialManifest = JSON.parse(await readFile(new URL('trial-manifest.json', benchmarkFixture), 'utf8'));
const TEST_PSEUDONYM_KEY = 'fixture-test-key-at-least-32-characters';
process.env.TRIAL_RECORD_PSEUDONYM_KEY = TEST_PSEUDONYM_KEY;

test('fixture set covers requested actor and evidence classes', () => {
  assert.equal(validateRecords(records, manifest).valid, true);
  assert.deepEqual(new Set(records.map(r => r.actor)), new Set(['HUMAN_CONFIRMED','AUTOMATION_CONTROL','AI_AGENT','UNKNOWN']));
  assert.ok(records.some(r => r.evidence_class === 'accessible'));
  assert.ok(records.some(r => r.oracle_access));
  assert.ok(records.every(r => !Object.hasOwn(r, 'participant_id')));
});
test('canonical Trial Manifest is hash-bound to TrialRecord challenge metadata and evidence class', () => {
  const qc = validateRecords(bridgeRecords, bridgeManifest, { trialManifest });
  assert.equal(qc.valid, true, JSON.stringify(qc.errors));
  const output = JSON.parse(exportJsonl(bridgeRecords, bridgeManifest, { trialManifest }).split('\n')[0]);
  assert.deepEqual(output.trial_manifest, {
    manifest_id: trialManifest.manifest_id,
    version: trialManifest.manifest_version,
    sha256: trialManifest.manifest_sha256,
    evidence_class: 'SIMULATED',
  });

  const changedManifest = structuredClone(trialManifest);
  changedManifest.challenge_set.id = 'different-challenge-set';
  assert.equal(validateRecords(bridgeRecords, bridgeManifest, { trialManifest: changedManifest }).valid, false);

  const expandedMembership = structuredClone(trialManifest);
  expandedMembership.challenge_set.challenge_ids.push(`challenge-${'f'.repeat(16)}`);
  expandedMembership.manifest_sha256 = hashManifest(expandedMembership);
  const tamperedQc = validateRecords(bridgeRecords, bridgeManifest, { trialManifest: expandedMembership });
  assert.equal(tamperedQc.valid, false);
  assert.ok(tamperedQc.errors.some(error => error.code === 'manifest_bridge'));
});
test('UNKNOWN stays unlabeled and risk/prediction/policy are observations only', () => {
  const unknown = records.find(r => r.actor === 'UNKNOWN');
  assert.equal(unknown.label, null);
  const row = records.find(r => r.outcome.observations);
  assert.equal(row.outcome.observations.risk_score, 0.2);
  assert.equal(validateRecords([row], manifest).valid, true);
});
test('protected-action observations preserve tri-state values and attempt-scoped provenance', () => {
  const row = structuredClone(records[0]);
  row.outcome.observations.protected_action_reached = true;
  row.outcome.observations.protected_action_reached_provenance = {
    trial_id: row.trial_id, source: 'browser event log', method: 'observed click outcome', origin: 'instrumentation', observed_at: row.ended_at
  };
  assert.equal(validateRecords([row], manifest).valid, true);
  const output = exportJsonl([row], manifest);
  const exported = JSON.parse(output.split('\n')[1]);
  assert.equal(exported.outcome.observations.protected_action_reached, true);
  assert.deepEqual(exported.outcome.observations.protected_action_reached_provenance, {
    ...row.outcome.observations.protected_action_reached_provenance,
    trial_id: exported.trial_id
  });

  for (const value of [false, null]) {
    const candidate = structuredClone(row);
    candidate.outcome.observations.protected_action_reached = value;
    if (value === null) delete candidate.outcome.observations.protected_action_reached_provenance;
    assert.equal(validateRecords([candidate], manifest).valid, true);
    const exportedValue = JSON.parse(exportJsonl([candidate], manifest).split('\n')[1]).outcome.observations.protected_action_reached;
    assert.equal(exportedValue, value);
  }

  const unknown = structuredClone(records[0]);
  assert.equal(validateRecords([unknown], manifest).valid, true);
  const absentExport = JSON.parse(exportJsonl([unknown], manifest).split('\n')[1]);
  assert.equal(Object.hasOwn(absentExport.outcome.observations ?? {}, 'protected_action_reached'), false);
});
test('rejects malformed protected-action values and provenance not tied to this attempt', () => {
  const row = structuredClone(records[0]);
  row.outcome.observations.protected_action_reached = false;
  row.outcome.observations.protected_action_reached_provenance = {
    trial_id: row.trial_id, source: 'observer', method: 'direct observation', origin: 'browser', observed_at: row.ended_at
  };
  const malformed = structuredClone(row);
  malformed.outcome.observations.protected_action_reached = 'false';
  assert.ok(validateRecords([malformed], manifest).errors.some(e => e.code === 'protected_action_reached'));
  const missing = structuredClone(row);
  delete missing.outcome.observations.protected_action_reached_provenance;
  assert.ok(validateRecords([missing], manifest).errors.some(e => e.code === 'protected_action_provenance'));
  const otherAttempt = structuredClone(row);
  otherAttempt.outcome.observations.protected_action_reached_provenance.trial_id = records[1].trial_id;
  assert.ok(validateRecords([otherAttempt], manifest).errors.some(e => e.code === 'protected_action_provenance'));
  const badTime = structuredClone(row);
  badTime.outcome.observations.protected_action_reached_provenance.observed_at = 'yesterday';
  assert.ok(validateRecords([badTime], manifest).errors.some(e => e.code === 'protected_action_provenance'));
});
test('rejects label without independently valid provenance', () => {
  const row = structuredClone(records[0]); row.provenance.independent = false;
  assert.ok(validateRecords([row], manifest).errors.some(e => e.code === 'label_provenance'));
});
test('rejects duplicate IDs, manifest mismatch, invalid timestamps and impossible values', () => {
  const dup = structuredClone(records[0]);
  const duplicate = validateRecords([records[0], dup], manifest);
  assert.ok(duplicate.errors.some(e => e.code === 'duplicate_id'));
  const bad = validateRecords(invalid, manifest);
  for (const code of ['label_provenance','manifest_ref','challenge_ref','timestamp_order','duration']) assert.ok(bad.errors.some(e => e.code === code), code);
});
test('rejects a manifest whose declared hash does not match its content', () => {
  const tampered = { ...manifest, version: 'changed' };
  assert.ok(validateRecords(records, tampered).errors.some(e => e.index === null && e.code === 'manifest_hash'));
});
test('export is deterministic, versioned, hashed, QC reported, and minimized', () => {
  const one = exportJsonl(records, manifest); const two = exportJsonl(records, manifest);
  assert.equal(one, two);
  const lines = one.trimEnd().split('\n').map(JSON.parse);
  assert.equal(lines[0].contract_version, 'trial-record-v1');
  assert.equal(lines[0].source_evidence_class, 'SIMULATED');
  assert.match(lines[0].artifact_hash, /^[a-f0-9]{64}$/);
  assert.equal(lines[0].qc_report.valid, true);
  assert.equal(lines[0].qc_report.accepted_count, records.length);
  assert.deepEqual(lines[0].qc_report.rejected_records, []);
  assert.equal(JSON.stringify(lines).includes('private@example.com'), false);
  assert.equal(JSON.stringify(lines).includes('raw_trajectory'), false);
  assert.equal(JSON.stringify(lines).includes('email'), false);
});
test('reports missing fields and oracle access remains explicit metadata', () => {
  const row = structuredClone(records[5]); delete row.oracle_access;
  assert.ok(validateRecords([row], manifest).errors.some(e => e.code === 'required'));
  assert.equal(records[5].oracle_access, true);
  assert.equal(records[5].evidence_class, 'oracle_assisted');
  assert.equal(records[5].actor, 'AUTOMATION_CONTROL');
  assert.equal(records[5].label, null);
});
test('rejects unsupported labels/provenance and oracle rows presented as perception ground truth', () => {
  const arbitrary = structuredClone(records[0]); arbitrary.label = 'certainly-human';
  assert.ok(validateRecords([arbitrary], manifest).errors.some(e => e.code === 'label_value'));
  arbitrary.label = 'human'; arbitrary.provenance.source = 'risk-score';
  assert.ok(validateRecords([arbitrary], manifest).errors.some(e => e.code === 'provenance'));
  const oracle = structuredClone(records[5]); oracle.label = 'automation';
  assert.ok(validateRecords([oracle], manifest).errors.some(e => e.code === 'oracle_exclusion'));
  oracle.label = null; oracle.oracle_access = false;
  assert.ok(validateRecords([oracle], manifest).errors.some(e => e.code === 'oracle_evidence'));
});
test('rejects impossible dates, invalid observation values, and non-finite JSON values', () => {
  for (const [mutate, code] of [
    [r => { r.started_at = '2025-02-31T10:00:00Z'; }, 'timestamp'],
    [r => { r.outcome.observations.risk_score = 1.01; }, 'risk_score'],
    [r => { r.outcome.observations.prediction = { value: 'human' }; }, 'prediction'],
    [r => { r.outcome.observations.policy = 'drop table'; }, 'policy'],
    [r => { r.outcome.observations.risk_score = Number.NaN; }, 'json_value']
  ]) {
    const row = structuredClone(records[0]); mutate(row);
    assert.ok(validateRecords([row], manifest).errors.some(e => e.code === code), code);
  }
  const undef = structuredClone(records[0]); undef.outcome.observations.private = undefined;
  assert.ok(validateRecords([undef], manifest).errors.some(e => e.code === 'json_value'));
});
test('export is invariant to input order and emits opaque session IDs', () => {
  const shuffled = [...records].reverse();
  assert.equal(exportJsonl(records, manifest), exportJsonl(shuffled, manifest));
  const rows = exportJsonl(records, manifest).trimEnd().split('\n').slice(1).map(JSON.parse);
  assert.ok(rows.every(r => typeof r.session_id === 'string'));
  assert.ok(rows.every(r => /^session-[a-f0-9]{64}$/.test(r.session_id)));
});

test('export hashes pseudonym fields instead of preserving reversible input encodings', () => {
  const row = structuredClone(records[0]);
  row.participant_id = `participant-${Buffer.from('private@example.com').toString('hex')}`;
  assert.ok(validateRecords([row], manifest, { pseudonymKey: null }).errors.some(e => e.code === 'participant_key'));
  const output = exportJsonl([row], manifest, { pseudonymKey: TEST_PSEUDONYM_KEY });
  assert.equal(output.includes('private@example.com'), false);
  const exported = JSON.parse(output.split('\n')[1]);
  assert.match(exported.participant_id, /^participant-[a-f0-9]{64}$/);
  assert.notEqual(Buffer.from(exported.participant_id.slice('participant-'.length), 'hex').toString(), 'private@example.com');
  const otherKey = exportJsonl([row], manifest, { pseudonymKey: 'different-fixture-key-at-least-32-characters' });
  assert.notEqual(JSON.parse(otherKey.split('\n')[1]).participant_id, exported.participant_id);
});

test('export pseudonymizes source IDs and references before writing JSONL', () => {
  const row = structuredClone(records[0]);
  const emailHex = Buffer.from('private@example.com').toString('hex');
  row.trial_id = `trial-${emailHex}`;
  row.session_id = `session-${emailHex}`;
  row.participant_id = `participant-${emailHex}`;
  row.challenge_ref.challenge_id = `challenge-${emailHex}`;
  row.challenge_ref.seed_ref = `seed-${emailHex}`;
  const scopedManifest = structuredClone(manifest);
  scopedManifest.challenge_ids[0] = row.challenge_ref.challenge_id;
  delete scopedManifest.sha256;
  scopedManifest.sha256 = createHash('sha256').update(canonical(scopedManifest)).digest('hex');
  row.manifest_ref.sha256 = scopedManifest.sha256;

  const output = exportJsonl([row], scopedManifest, { pseudonymKey: TEST_PSEUDONYM_KEY });
  assert.equal(output.includes('private@example.com'), false);
  const exported = JSON.parse(output.split('\n')[1]);
  for (const [key, kind] of [['trial_id', 'trial'], ['session_id', 'session'], ['participant_id', 'participant']]) {
    assert.match(exported[key], new RegExp(`^${kind}-[a-f0-9]{64}$`));
    assert.notEqual(exported[key], row[key]);
  }
  assert.match(exported.challenge_ref.challenge_id, /^challenge-[a-f0-9]{64}$/);
  assert.match(exported.challenge_ref.seed_ref, /^seed-[a-f0-9]{64}$/);
  assert.match(exported.manifest_ref.manifest_id, /^manifest-[a-f0-9]{64}$/);
});

test('export requires a secret before pseudonymizing any identifier', () => {
  const [header, ...rows] = exportJsonl(records, manifest, { pseudonymKey: null }).trimEnd().split('\n').map(JSON.parse);
  assert.equal(header.qc_report.valid, false);
  assert.equal(header.qc_report.accepted_count, 0);
  assert.equal(rows.length, 0);
  assert.ok(header.qc_report.rejected_records.every(row => row.trial_id === null && row.reasons.some(reason => reason.code === 'pseudonym_key')));
});

test('rejects personal data shaped IDs and redacts them from rejection reports', () => {
  const row = structuredClone(records[0]);
  row.trial_id = 'person@example.com';
  row.session_id = 'person@example.com';
  row.challenge_ref.seed_ref = 'person@example.com';
  const output = exportJsonl([row], manifest);
  const [header] = output.trimEnd().split('\n').map(JSON.parse);
  assert.equal(header.qc_report.accepted_count, 0);
  assert.equal(header.qc_report.rejected_records[0].trial_id, null);
  assert.equal(JSON.stringify(header).includes('person@example.com'), false);
  assert.ok(validateRecords([row], manifest).errors.some(e => e.code === 'trial_id'));
  assert.ok(validateRecords([row], manifest).errors.some(e => e.code === 'session_id'));
  assert.ok(validateRecords([row], manifest).errors.some(e => e.code === 'challenge_ref'));
});

test('challenge references use exact membership in an array manifest field', () => {
  const row = structuredClone(records[0]);
  row.challenge_ref.challenge_id = 'challenge-00000000000000aa';
  assert.ok(validateRecords([row], manifest).errors.some(e => e.code === 'challenge_ref'));
  const malformedManifest = { ...manifest, challenge_ids: 'xchallenge-0000000000000001x' };
  delete malformedManifest.sha256;
  malformedManifest.sha256 = createHash('sha256').update(canonical(malformedManifest)).digest('hex');
  assert.ok(validateRecords([records[0]], malformedManifest).errors.some(e => e.code === 'manifest_invalid'));
});

test('malformed top-level input still yields a structured QC export', () => {
  const [header] = exportJsonl(null, null).trimEnd().split('\n').map(JSON.parse);
  assert.equal(header.qc_report.valid, false);
  assert.equal(header.qc_report.total_count, 0);
  assert.equal(header.qc_report.accepted_count, 0);
  assert.ok(header.qc_report.errors.some(e => e.code === 'records_type'));
});

test('rejects PII-shaped manifest versions without copying them into QC output', () => {
  const unsafeManifest = { ...manifest, version: 'private@example.com' };
  delete unsafeManifest.sha256;
  unsafeManifest.sha256 = createHash('sha256').update(canonical(unsafeManifest)).digest('hex');
  const unsafeRow = structuredClone(records[0]);
  unsafeRow.manifest_ref.version = unsafeManifest.version;
  unsafeRow.manifest_ref.sha256 = unsafeManifest.sha256;
  const output = exportJsonl([unsafeRow], unsafeManifest);
  assert.equal(output.includes('private@example.com'), false);
  assert.equal(JSON.parse(output.split('\n')[0]).qc_report.accepted_count, 0);
});

test('mixed export lists accepted and rejected rows with stable reasons', () => {
  const malformed = structuredClone(records[0]);
  malformed.trial_id = 'trial-0000000000000007';
  malformed.provenance.source = 'unknown';
  const output = exportJsonl([...records, malformed], manifest);
  const [header, ...rows] = output.trimEnd().split('\n').map(JSON.parse);
  assert.equal(header.qc_report.valid, false);
  assert.equal(header.qc_report.accepted_count, records.length);
  assert.equal(header.qc_report.rejected_records[0].index, records.length);
  assert.match(header.qc_report.rejected_records[0].trial_id, /^trial-[a-f0-9]{64}$/);
  assert.notEqual(header.qc_report.rejected_records[0].trial_id, malformed.trial_id);
  assert.deepEqual(header.qc_report.rejected_records[0].reasons, [{ code: 'label_provenance', message: 'A ground-truth label requires valid independent provenance' }, { code: 'label_provenance', message: 'HUMAN_CONFIRMED requires human review provenance' }]);
  assert.equal(rows.length, records.length);
  assert.ok(!rows.some(row => row.trial_id === 'trial-0000000000000007'));
});

test('CLI exports valid fixtures and emits a rejection report with exit status 1', () => {
  const cli = fileURLToPath(new URL('../scripts/trial-record.mjs', import.meta.url));
  const manifestPath = fileURLToPath(new URL('manifest.json', base));
  const validPath = fileURLToPath(new URL('records.json', base));
  const invalidPath = fileURLToPath(new URL('invalid.json', base));
  const validRun = spawnSync(process.execPath, [cli, '--input', validPath, '--manifest', manifestPath], { encoding: 'utf8' });
  assert.equal(validRun.status, 0, validRun.stderr);
  assert.equal(JSON.parse(validRun.stdout.split('\n')[0]).qc_report.accepted_count, records.length);
  const invalidRun = spawnSync(process.execPath, [cli, '--input', invalidPath, '--manifest', manifestPath], { encoding: 'utf8' });
  assert.equal(invalidRun.status, 1);
  const report = JSON.parse(invalidRun.stdout.split('\n')[0]).qc_report;
  assert.equal(report.accepted_count, 0);
  assert.ok(report.rejected_records[0].reasons.some(reason => reason.code === 'challenge_ref'));
});

test('CLI refuses to overwrite the input file with its export', async () => {
  const cli = fileURLToPath(new URL('../scripts/trial-record.mjs', import.meta.url));
  const inputPath = fileURLToPath(new URL('records.json', base));
  const manifestPath = fileURLToPath(new URL('manifest.json', base));
  const before = await readFile(inputPath);
  const result = spawnSync(process.execPath, [cli, '--input', inputPath, '--manifest', manifestPath, '--output', inputPath], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Output path must differ/);
  assert.deepEqual(await readFile(inputPath), before);
});
