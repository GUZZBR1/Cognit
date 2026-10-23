import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHALLENGE_CONTRACTS = new Map([
  ["color-count-01", { stimulusId: "grid-blue-01", correctAnswer: "3", responses: new Set(Array.from({ length: 10 }, (_, count) => String(count))) }],
  ["symbol-count-01", { stimulusId: "grid-star-01", correctAnswer: "4", responses: new Set(Array.from({ length: 10 }, (_, count) => String(count))) }],
  ["color-majority-01", { stimulusId: "grid-majority-01", correctAnswer: "green", responses: new Set(["green", "violet", "gold"]) }],
]);

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim();
}

function requireCode(value, field) {
  const code = requireText(value, field);
  if (code.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(code)) throw new TypeError(`${field} must be a short opaque identifier`);
  return code;
}

function isoTimestamp(value, field) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new TypeError(`${field} must be an ISO timestamp`);
  const date = new Date(value);
  if (!value.includes("T") || !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new TypeError(`${field} must include a timezone`);
  return date.toISOString();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function digest(key, purpose, value) {
  return createHmac("sha256", key).update(`${purpose}\0${value}`).digest("base64url");
}

/** Create an opaque study-local participant key; retain it only as needed to honor withdrawal. */
export function createStudyParticipantKey() {
  return randomBytes(32).toString("base64url");
}

function validateResult(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("A result object is required");
  const allowed = new Set(["challenge_id", "stimulus_id", "duration_ms", "response", "correct", "reaction_time_ms"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unsupported fields; raw data is not collected");
  for (const field of ["challenge_id", "stimulus_id"]) requireText(input[field], field);
  for (const field of ["duration_ms", "reaction_time_ms"]) {
    if (!Number.isFinite(input[field]) || input[field] < 0) throw new TypeError(`${field} must be non-negative`);
  }
  if (typeof input.correct !== "boolean") throw new TypeError("correct must be boolean");
  const contract = CHALLENGE_CONTRACTS.get(input.challenge_id);
  const response = String(input.response).trim().toLocaleLowerCase();
  if (!contract || input.stimulus_id !== contract.stimulusId) throw new TypeError("challenge and stimulus IDs do not match the pilot catalog");
  if (!contract.responses.has(response)) throw new TypeError("response is not an allowed answer for this challenge");
  if (input.correct !== (response === contract.correctAnswer)) throw new TypeError("correctness does not match the recorded answer");
  return {
    challenge_id: input.challenge_id,
    stimulus_id: input.stimulus_id,
    duration_ms: input.duration_ms,
    response,
    correct: input.correct,
    reaction_time_ms: input.reaction_time_ms,
  };
}

/** In-memory, consent-gated study records; observer confirmation is a separate operation. */
export class HumanDataset {
  #records = [];
  #consents = new Map();
  #withdrawn = new Set();
  #now;
  #retentionMs;
  #setTimeout;
  #clearTimeout;
  #expiryTimers = new Map();
  #consentTimers = new Map();
  #studyId;
  #key;

  constructor({ studyId, pseudonymKey, retentionMs = DEFAULT_RETENTION_MS, now = Date.now, setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
    this.#studyId = requireCode(studyId, "studyId");
    if (!(pseudonymKey instanceof Uint8Array) || pseudonymKey.byteLength < 32) throw new TypeError("pseudonymKey must contain at least 32 random bytes");
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new RangeError("retentionMs must be positive");
    if (typeof now !== "function" || typeof setTimeout !== "function" || typeof clearTimeout !== "function") throw new TypeError("now, setTimeout, and clearTimeout must be functions");
    this.#key = Buffer.from(pseudonymKey);
    this.#retentionMs = retentionMs;
    this.#now = now;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
  }

  get rawEnabled() { return false; }

  /** A random study-local participant key yields the same pseudonym across sessions in this study. */
  participantId(participantKey) {
    const key = requireText(participantKey, "participantKey");
    if (key.length < 32 || key.length > 128 || !/^[A-Za-z0-9_-]+$/.test(key)) throw new TypeError("participantKey must be a random base64url study token of at least 32 characters");
    return `p_${digest(this.#key, "participant-v1", `${this.#studyId}\0${key}`)}`;
  }

  consent({ participantKey, informed, consentVersion } = {}) {
    if (informed !== true) throw new Error("Explicit informed consent is required");
    const participantId = this.participantId(participantKey);
    if (this.#withdrawn.has(digest(this.#key, "withdrawn-v1", participantId))) throw new Error("Consent was withdrawn; collection is closed");
    const priorConsent = this.#consents.get(participantId);
    if (priorConsent && Date.parse(priorConsent.expires_at) > this.#now()) throw new Error("Consent has already been recorded");
    if (priorConsent) this.#removeConsent(participantId);
    const consented_at = this.#timestamp();
    const consent = deepFreeze({ consent_version: requireCode(consentVersion, "consentVersion"), consented_at, expires_at: new Date(Date.parse(consented_at) + this.#retentionMs).toISOString() });
    this.#consents.set(participantId, consent);
    this.#scheduleConsentExpiry(participantId, consent);
    return participantId;
  }

  /** Record a minimized collector result. Every new attempt starts UNKNOWN. */
  recordAttempt({ participantKey, sessionId, attemptId, startedAt, endedAt, result } = {}) {
    const participantId = this.participantId(participantKey);
    const consent = this.#consents.get(participantId);
    if (!consent || Date.parse(consent.expires_at) <= this.#now()) {
      this.#removeConsent(participantId);
      throw new Error("Active consent is required before collection");
    }
    const session_id = requireCode(sessionId, "sessionId");
    const attempt_id = requireCode(attemptId, "attemptId");
    const started_at = isoTimestamp(startedAt, "startedAt");
    const ended_at = isoTimestamp(endedAt, "endedAt");
    if (Date.parse(ended_at) <= Date.parse(started_at)) throw new TypeError("endedAt must be after startedAt");
    if (this.#records.some((record) => record.participant_id === participantId && record.session_id === session_id && record.attempt_id === attempt_id)) throw new Error("Attempt is already recorded");
    const record = this.#sign({
      study_id: this.#studyId,
      participant_id: participantId,
      session_id,
      attempt_id,
      started_at,
      ended_at,
      result: validateResult(result),
      consent_version: consent.consent_version,
      consented_at: consent.consented_at,
      recorded_at: this.#timestamp(),
      label: "UNKNOWN",
      confirmation: null,
      evidence_status: "UNKNOWN",
    });
    this.#records.push(record);
    this.#scheduleExpiry(record);
    return record;
  }

  /** Upgrade one exact attempt only when an observer confirms full human control. */
  confirmAttempt({ participantKey, sessionId, attemptId, outcome, method, origin, procedure, protocolVersion, observerId, scope, confirmedAt } = {}) {
    const participantId = this.participantId(participantKey);
    const consent = this.#consents.get(participantId);
    if (!consent || Date.parse(consent.expires_at) <= this.#now()) {
      this.#removeConsent(participantId);
      throw new Error("Active consent is required before confirmation");
    }
    const session_id = requireCode(sessionId, "sessionId");
    const attempt_id = requireCode(attemptId, "attemptId");
    const index = this.#records.findIndex((record) => record.participant_id === participantId && record.session_id === session_id && record.attempt_id === attempt_id);
    if (index < 0) throw new Error("No recorded attempt matches this participant, session, and attempt");
    const previous = this.#records[index];
    if (previous.label === "HUMAN_CONFIRMED") throw new Error("Attempt already has an independent confirmation");
    if (outcome !== "confirmed" && outcome !== "unconfirmed" && outcome !== "unknown") throw new TypeError("outcome must be confirmed, unconfirmed, or unknown");
    let confirmation = null;
    let label = "UNKNOWN";
    if (outcome === "confirmed") {
      if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw new TypeError("scope is required for a confirmed outcome");
      const scoped = {
        session_id: requireCode(scope.sessionId, "scope.sessionId"),
        attempt_id: requireCode(scope.attemptId, "scope.attemptId"),
        observed_from: isoTimestamp(scope.observedFrom, "scope.observedFrom"),
        observed_to: isoTimestamp(scope.observedTo, "scope.observedTo"),
        complete: scope.complete,
      };
      if (scoped.session_id !== previous.session_id || scoped.attempt_id !== previous.attempt_id || scoped.observed_from !== previous.started_at || scoped.observed_to !== previous.ended_at || scoped.complete !== true) {
        throw new TypeError("confirmation scope must cover the complete recorded attempt");
      }
      confirmation = {
        method: requireCode(method, "method"),
        origin: requireCode(origin, "origin"),
        procedure: requireCode(procedure, "procedure"),
        protocol_version: requireCode(protocolVersion, "protocolVersion"),
        observer_id: requireCode(observerId, "observerId"),
        scope: scoped,
        confirmed_at: isoTimestamp(confirmedAt ?? this.#timestamp(), "confirmedAt"),
      };
      if (confirmation.method !== "direct-researcher-observation" || confirmation.origin !== "researcher-facilitated-controlled-session") {
        throw new TypeError("confirmation must use the independent researcher observation procedure");
      }
      if (Date.parse(confirmation.confirmed_at) < Date.parse(previous.ended_at)) throw new TypeError("confirmedAt cannot precede the end of the attempt");
      label = "HUMAN_CONFIRMED";
    }
    const { signature: _previousSignature, ...previousPayload } = previous;
    const replacement = this.#sign({ ...previousPayload, label, confirmation, evidence_status: outcome === "confirmed" ? "INDEPENDENTLY_OBSERVED" : "UNKNOWN" });
    this.#records[index] = replacement;
    const timer = this.#expiryTimers.get(previous);
    if (timer !== undefined) this.#clearTimeout(timer);
    this.#expiryTimers.delete(previous);
    this.#scheduleExpiry(replacement);
    return replacement;
  }

  getRecords() {
    this.#expireDue();
    return Object.freeze([...this.#records]);
  }

  verifyProvenance(record) {
    if (!record || record.study_id !== this.#studyId || typeof record.signature !== "string") return false;
    const { signature, ...payload } = record;
    const expected = Buffer.from(this.#signature(payload));
    const actual = Buffer.from(signature);
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  /** Delete all records for this study-local participant and close collection in this instance. */
  withdraw(participantKey) {
    const participantId = this.participantId(participantKey);
    this.#removeConsent(participantId);
    this.#withdrawn.add(digest(this.#key, "withdrawn-v1", participantId));
    for (const record of this.#records) {
      if (record.participant_id !== participantId) continue;
      const timer = this.#expiryTimers.get(record);
      if (timer !== undefined) this.#clearTimeout(timer);
      this.#expiryTimers.delete(record);
    }
    this.#records = this.#records.filter((record) => record.participant_id !== participantId);
  }

  #signature(payload) {
    return digest(this.#key, "record-v1", JSON.stringify(payload));
  }

  #sign(payload) {
    const frozenPayload = deepFreeze(structuredClone(payload));
    return deepFreeze({ ...frozenPayload, signature: this.#signature(frozenPayload) });
  }

  #timestamp() {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new TypeError("now must return a finite timestamp");
    return new Date(value).toISOString();
  }

  #scheduleConsentExpiry(participantId, consent) {
    const expiresAt = Date.parse(consent.expires_at);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - this.#now()));
    const timer = this.#setTimeout(() => {
      this.#consentTimers.delete(participantId);
      if (expiresAt <= this.#now()) this.#removeConsent(participantId);
      else this.#scheduleConsentExpiry(participantId, consent);
    }, delay);
    timer?.unref?.();
    this.#consentTimers.set(participantId, timer);
  }

  #removeConsent(participantId) {
    this.#consents.delete(participantId);
    const timer = this.#consentTimers.get(participantId);
    if (timer !== undefined) this.#clearTimeout(timer);
    this.#consentTimers.delete(participantId);
  }

  #scheduleExpiry(record) {
    const expiresAt = Date.parse(record.recorded_at) + this.#retentionMs;
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, expiresAt - this.#now()));
    const timer = this.#setTimeout(() => {
      this.#expiryTimers.delete(record);
      if (expiresAt <= this.#now()) this.#removeRecord(record);
      else this.#scheduleExpiry(record);
    }, delay);
    timer?.unref?.();
    this.#expiryTimers.set(record, timer);
  }

  #expireDue() {
    const now = this.#now();
    if (!Number.isFinite(now)) throw new TypeError("now must return a finite timestamp");
    for (const [participantId, consent] of this.#consents) {
      if (Date.parse(consent.expires_at) <= now) this.#removeConsent(participantId);
    }
    for (const record of [...this.#records]) {
      if (Date.parse(record.recorded_at) + this.#retentionMs <= now) this.#removeRecord(record);
    }
  }

  #removeRecord(record) {
    this.#records = this.#records.filter((item) => item !== record);
    const timer = this.#expiryTimers.get(record);
    if (timer !== undefined) this.#clearTimeout(timer);
    this.#expiryTimers.delete(record);
  }
}
