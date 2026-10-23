import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { hashConfig, hashManifest, validateManifest } from '../scripts/trial-manifest.mjs';

const fixture = (name) => readFile(new URL(`../fixtures/trial-manifest-v1/${name}`, import.meta.url), 'utf8').then(JSON.parse);

test('v1 manifest fixtures validate and retain explicit UNKNOWN values', async () => {
  const valid = await fixture('valid.json');
  const unknown = await fixture('unknown-values.json');
  assert.deepEqual(validateManifest(valid), { valid: true, errors: [] });
  assert.deepEqual(validateManifest(unknown), { valid: true, errors: [] });
  assert.equal(unknown.actor.type, 'UNKNOWN');
  assert.equal(unknown.result, 'UNKNOWN');
});

test('config digest is canonical across object key order', () => {
  assert.equal(hashConfig({ alpha: 1, nested: { a: true, z: 2 } }), hashConfig({ nested: { z: 2, a: true }, alpha: 1 }));
});

test('manifest digest binds all manifest metadata and excludes only itself', async () => {
  const manifest = await fixture('valid.json');
  assert.equal(hashManifest(manifest), manifest.manifest_sha256);
  manifest.study_id = 'tampered-study';
  assert.ok(validateManifest(manifest).errors.includes('$.manifest_sha256: does not match canonical manifest SHA-256'));
});

test('calendar-invalid timestamps are rejected', async () => {
  const manifest = await fixture('valid.json');
  manifest.created_at = '2026-02-31T12:00:00Z';
  manifest.manifest_sha256 = hashManifest(manifest);
  assert.ok(validateManifest(manifest).errors.includes('$.created_at: expected RFC 3339 date-time'));
});

test('missing fields and unsupported contract versions are identified', async () => {
  const missing = await fixture('missing-required.json');
  assert.deepEqual(validateManifest(missing).errors.filter((error) => error.endsWith(': required')), ['$.config_sha256: required', '$.manifest_sha256: required', '$.study_id: required']);
  const version = await fixture('unknown-version.json');
  assert.deepEqual(validateManifest(version).errors, [
    '$.manifest_version: unsupported version (expected 1.0.0)',
    '$.protocol_version: unsupported version (expected 1.0.0)',
  ]);
});

test('config tampering and classifier-as-ground-truth are rejected', async () => {
  for (const [name, expected] of [
    ['changed-config.json', '$.config_sha256: does not match canonical config SHA-256'],
    ['unsafe-ground-truth.json', '$.ground_truth.provenance: must identify independent ground-truth provenance'],
  ]) {
    assert.ok(validateManifest(await fixture(name)).errors.includes(expected));
  }
});

test('schema is valid JSON and describes the same current contract versions', async () => {
  const schema = JSON.parse(await readFile(new URL('../schemas/trial-manifest-v1.schema.json', import.meta.url), 'utf8'));
  assert.equal(schema.properties.manifest_version.const, '1.0.0');
  assert.equal(schema.properties.protocol_version.const, '1.0.0');
  assert.deepEqual(schema.required, [
    'manifest_version', 'manifest_id', 'manifest_sha256', 'study_id', 'protocol_version', 'cognit_commit', 'created_at',
    'environment', 'actor', 'challenge_set', 'seed', 'config', 'config_sha256', 'accessible_mode',
    'evidence_class', 'result', 'observations',
  ]);
});
