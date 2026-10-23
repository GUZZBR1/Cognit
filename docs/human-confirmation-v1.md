# Human confirmation procedure v1

This is a local, in-memory research adapter. It does not recruit participants, establish identity, or prove that a person is human beyond the bounded observation recorded by a researcher. An exported record can be labelled `MEASURED_LAB` only after this procedure has actually been applied to real participants and the original provenance has been preserved. The bundled fixtures and example are synthetic and must be labelled `SIMULATED`.

## Confirmation procedure

1. Obtain explicit informed consent under a versioned consent text. Consent authorizes the minimized pilot record; it is never confirmation evidence.
2. Assign the participant a random study-local key. Keep any operational key mapping separately under the study's approved controls. Never put a civil name, email, account identifier, or contact detail in this library.
3. For every attempt, record its `session_id`, `attempt_id`, and exact start and end timestamps. Each attempt begins with `label: UNKNOWN`.
4. A researcher directly observes the participant's presence and human control of the interaction for that entire bounded attempt. The researcher independently associates the observation with the exact session and attempt identifiers. Correctness, timing, browser signals, risk scores, policies, CAPTCHA success, and model output are not evidence.
5. Record the method, origin, procedure, protocol version, observer pseudonym, complete scope, and confirmation timestamp. Partial, interrupted, unassociated, or inconclusive observation remains `UNKNOWN`. The adapter rejects scope that does not exactly cover the recorded attempt.

The local adapter currently accepts only `method: direct-researcher-observation` and `origin: researcher-facilitated-controlled-session`; `procedure` and `protocol_version` are versioned, short identifiers rather than free-form notes. These fields identify the claimed procedure and reduce accidental entry of personal details. They do not independently verify the researcher's claim.

The record signature is a local HMAC over its complete contents. It detects accidental or unauthorized edits by holders of the configured secret; it is not a public signature and does not independently prove that the observation happened. Keep the secret outside exported data. The adapter requires at least 32 random secret bytes and uses a purpose-separated HMAC to derive a participant pseudonym from a random base64url participant key and study ID. `createStudyParticipantKey()` generates a 256-bit study-local token. Retain this token only as needed to support withdrawal; it is not a civil identity. The HMAC keeps the same pseudonym stable across sessions in one study and prevents direct reuse across studies. It is pseudonymization, not anonymization.

## Data minimization and lifecycle

The adapter accepts only the existing challenge catalog's minimized challenge/stimulus IDs, answer, correctness, duration, and reaction-time summary, plus study-local participant/session/attempt identifiers and confirmation provenance. It rejects extra result fields, including raw trajectories and arbitrary personal fields. It does not collect civil identity, contact data, raw pointer events, or absolute input timestamps. `rawEnabled` is always false.

Records live only in process memory and expire after 30 days by default, including while the process remains open. Operators must delete any exported copy no later than 30 days after collection and honor earlier withdrawal requests. `withdraw(participantKey)` removes all in-memory records linked to that participant in the study and closes collection for that participant for the lifetime of the dataset instance. This library cannot erase copies already exported or held elsewhere; the study operator must locate and delete them. Reloading or restarting discards the in-memory registry and withdrawal tombstones, so the operator must enforce withdrawal against any external copies.

This adapter does not export or transmit records automatically. The study operator is responsible for secure handling of the pseudonym key, exported files, retention, access control, and deletion. Do not include the participant key or secret in exports.

## Local synthetic example

Run `node examples/human-confirmation/main.js`. Output records remain marked by the enclosing fixture as `SIMULATED`; they are not lab measurements.
