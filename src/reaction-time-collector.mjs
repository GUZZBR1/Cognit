const EVENT_FIELDS = [
  "firstMovementAt",
  "firstClickAt",
  "firstInteractionAt",
  "responseAt",
];

/**
 * Collects monotonic-clock timestamps for one attempt. Every timestamp must
 * use the same clock and unit (milliseconds, such as performance.now()).
 */
export class ReactionTimeCollector {
  #stimulusAt;
  #events = Object.fromEntries(EVENT_FIELDS.map((field) => [field, null]));
  #finishedAt = null;

  constructor(stimulusAt) {
    this.#assertTimestamp(stimulusAt, "stimulusAt");
    this.#stimulusAt = stimulusAt;
  }

  recordMovement(at) {
    return this.#recordFirst("firstMovementAt", at, true);
  }

  recordClick(at) {
    return this.#recordFirst("firstClickAt", at, true);
  }

  recordInteraction(at) {
    return this.#recordFirst("firstInteractionAt", at, false);
  }

  recordResponse(at) {
    return this.#recordFirst("responseAt", at, false);
  }

  /** Closes the attempt and returns its immutable timing result. */
  finish(at) {
    this.#assertOpen();
    this.#assertEventTimestamp(at, "finishedAt");
    if (Object.values(this.#events).some((eventAt) => eventAt !== null && eventAt > at)) {
      throw new RangeError("finishedAt cannot precede a recorded event");
    }
    this.#finishedAt = at;

    return Object.freeze({
      stimulusAt: this.#stimulusAt,
      firstMovementAt: this.#events.firstMovementAt,
      firstClickAt: this.#events.firstClickAt,
      firstInteractionAt: this.#events.firstInteractionAt,
      responseAt: this.#events.responseAt,
      totalTime: at - this.#stimulusAt,
    });
  }

  #recordFirst(field, at, countsAsInteraction) {
    this.#assertOpen();
    this.#assertEventTimestamp(at, field);

    if (this.#events[field] === null || at < this.#events[field]) {
      this.#events[field] = at;
    }
    if (
      countsAsInteraction &&
      (this.#events.firstInteractionAt === null || at < this.#events.firstInteractionAt)
    ) {
      this.#events.firstInteractionAt = at;
    }
    return this;
  }

  #assertTimestamp(at, field) {
    if (typeof at !== "number" || !Number.isFinite(at)) {
      throw new TypeError(`${field} must be a finite timestamp in milliseconds`);
    }
  }

  #assertEventTimestamp(at, field) {
    this.#assertTimestamp(at, field);
    if (at < this.#stimulusAt) {
      throw new RangeError(`${field} cannot precede stimulusAt`);
    }
    if (this.#finishedAt !== null && at > this.#finishedAt) {
      throw new RangeError(`${field} cannot follow finishedAt`);
    }
  }

  #assertOpen() {
    if (this.#finishedAt !== null) {
      throw new Error("The attempt has already been finished");
    }
  }
}
