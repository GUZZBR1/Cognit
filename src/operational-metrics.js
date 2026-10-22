/** Aggregate only the count of completed challenges for this page visit. */
export function createOperationalMetrics({ startedAt = new Date() } = {}) {
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) {
    throw new TypeError("startedAt must be a valid Date");
  }

  let completedAttempts = 0;

  return Object.freeze({
    recordCompletedAttempt() {
      completedAttempts += 1;
    },
    snapshot() {
      return Object.freeze({
        completedAttempts,
        periodStart: startedAt.toISOString(),
      });
    },
  });
}
