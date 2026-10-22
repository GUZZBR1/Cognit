import { readFile } from 'node:fs/promises';
import { buildSessionSignature, compareSessionSignatures, SESSION_SIGNATURE_SCHEMA_VERSION } from '../src/session-signature.mjs';

const fixturePath = new URL('../test/fixtures/session-signatures-v0.json', import.meta.url);
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
if (fixture.schemaVersion !== SESSION_SIGNATURE_SCHEMA_VERSION) {
  throw new TypeError('unsupported_session_signature_fixture_version');
}
const sessions = fixture.sessions.map((session) => ({ name: session.name, signature: buildSessionSignature(session) }));
const comparisons = [];
for (let left = 0; left < sessions.length; left += 1) {
  for (let right = left + 1; right < sessions.length; right += 1) {
    comparisons.push({ left: sessions[left].name, right: sessions[right].name, ...compareSessionSignatures(sessions[left].signature, sessions[right].signature) });
  }
}
console.log(JSON.stringify({ reportVersion: 0, interpretation: 'Experimental feature similarity only; no identity or class inference.', comparisons }, null, 2));
