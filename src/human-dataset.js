const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const CHALLENGE_CONTRACTS = new Map([
  ["color-count-01", { stimulusId: "grid-blue-01", correctAnswer: "3", responses: new Set(Array.from({ length: 10 }, (_, count) => String(count))) }],
  ["symbol-count-01", { stimulusId: "grid-star-01", correctAnswer: "4", responses: new Set(Array.from({ length: 10 }, (_, count) => String(count))) }],
  ["color-majority-01", { stimulusId: "grid-majority-01", correctAnswer: "green", responses: new Set(["green", "violet", "gold"]) }],
]);

/** In-memory, consent-gated collection of minimized human task results. */
export class HumanDataset {
  #records = [];
  #consented = false;
  #withdrawn = false;
  #pseudonym = null;
  #consentVersion = null;
  #consentedAt = null;
  #now;
  #randomUUID;
  #retentionMs;
  #setTimeout;
  #clearTimeout;
  #expiryTimers = new Map();

  constructor({ retentionMs = DEFAULT_RETENTION_MS, now = Date.now, randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto), setTimeout = globalThis.setTimeout, clearTimeout = globalThis.clearTimeout } = {}) {
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) throw new RangeError("retentionMs must be positive");
    if (typeof now !== "function" || typeof randomUUID !== "function" || typeof setTimeout !== "function" || typeof clearTimeout !== "function") throw new TypeError("now, randomUUID, setTimeout, and clearTimeout must be functions");
    this.#retentionMs = retentionMs;
    this.#now = now;
    this.#randomUUID = randomUUID;
    this.#setTimeout = setTimeout;
    this.#clearTimeout = clearTimeout;
  }

  get rawEnabled() { return false; }

  consent({ informed, consentVersion } = {}) {
    if (this.#withdrawn) throw new Error("Consent was withdrawn; collection is closed");
    if (this.#consented) throw new Error("Consent has already been recorded");
    if (informed !== true) throw new Error("Explicit informed consent is required");
    if (typeof consentVersion !== "string" || !consentVersion.trim()) throw new TypeError("consentVersion is required");
    const pseudonym = this.#randomUUID();
    if (typeof pseudonym !== "string" || !pseudonym) throw new TypeError("randomUUID must return a non-empty string");
    this.#consented = true;
    this.#pseudonym = pseudonym;
    this.#consentVersion = consentVersion;
    this.#consentedAt = this.#timestamp();
    return pseudonym;
  }

  record(input) {
    if (!this.#consented || this.#withdrawn) throw new Error("Active consent is required before collection");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("A result object is required");
    const allowed = new Set(["challenge_id", "stimulus_id", "duration_ms", "response", "correct", "reaction_time_ms"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new TypeError("Unsupported fields; raw data is not collected");
    for (const field of ["challenge_id", "stimulus_id"]) {
      if (typeof input[field] !== "string" || !input[field].trim()) throw new TypeError(`${field} is required`);
    }
    for (const field of ["duration_ms", "reaction_time_ms"]) {
      if (!Number.isFinite(input[field]) || input[field] < 0) throw new TypeError(`${field} must be non-negative`);
    }
    if (typeof input.correct !== "boolean") throw new TypeError("correct must be boolean");
    const contract = CHALLENGE_CONTRACTS.get(input.challenge_id);
    const response = String(input.response).trim().toLocaleLowerCase();
    if (!contract || input.stimulus_id !== contract.stimulusId) throw new TypeError("challenge and stimulus IDs do not match the pilot catalog");
    if (!contract.responses.has(response)) throw new TypeError("response is not an allowed answer for this challenge");
    if (input.correct !== (response === contract.correctAnswer)) throw new TypeError("correctness does not match the recorded answer");

    const record = {
      challenge_id: input.challenge_id,
      stimulus_id: input.stimulus_id,
      duration_ms: input.duration_ms,
      response,
      correct: input.correct,
      reaction_time_ms: input.reaction_time_ms,
      consent_version: this.#consentVersion,
      consented_at: this.#consentedAt,
      recorded_at: this.#timestamp(),
      pseudonym: this.#pseudonym,
    };
    const frozen = Object.freeze(record);
    this.#records.push(frozen);
    this.#scheduleExpiry(frozen);
    return frozen;
  }

  getRecords() {
    this.#expireDue();
    return Object.freeze([...this.#records]);
  }

  withdraw() {
    this.#records.length = 0;
    for (const timer of this.#expiryTimers.values()) this.#clearTimeout(timer);
    this.#expiryTimers.clear();
    this.#consented = false;
    this.#withdrawn = true;
    this.#pseudonym = null;
    this.#consentVersion = null;
    this.#consentedAt = null;
  }

  #timestamp() {
    const value = this.#now();
    if (!Number.isFinite(value)) throw new TypeError("now must return a finite timestamp");
    return new Date(value).toISOString();
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
    for (const record of this.#records) {
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

export { DEFAULT_RETENTION_MS };
