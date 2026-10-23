import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createStudyParticipantKey, HumanConfirmationRegistry } from "../../src/human-confirmation-registry.js";

const fixture = JSON.parse(await readFile(new URL("../../fixtures/human-confirmation-v1.json", import.meta.url), "utf8"));
const dataset = new HumanConfirmationRegistry({ studyId: "demo-study", pseudonymKey: randomBytes(32) });
const participantKey = createStudyParticipantKey();
dataset.consent({ participantKey, informed: true, consentVersion: "demo-consent-v1" });

for (const item of fixture.cases) {
  const start = item.confirmation?.scope.observed_from ?? "2027-01-15T12:00:00.000Z";
  const end = item.confirmation?.scope.observed_to ?? "2027-01-15T12:00:10.000Z";
  dataset.recordAttempt({
    participantKey,
    sessionId: item.confirmation?.scope.session_id ?? "session-sim-01",
    attemptId: item.confirmation?.scope.attempt_id ?? item.case_id,
    startedAt: start,
    endedAt: end,
    result: { challenge_id: "color-count-01", stimulus_id: "grid-blue-01", duration_ms: 100, response: "3", correct: true, reaction_time_ms: 700 },
  });
  if (item.confirmation || item.procedure_outcome) {
    const sessionId = item.confirmation?.scope.session_id ?? "session-sim-01";
    const attemptId = item.confirmation?.scope.attempt_id ?? item.case_id;
    dataset.confirmAttempt({
      participantKey,
      sessionId,
      attemptId,
      outcome: item.procedure_outcome ?? "confirmed",
      ...(item.confirmation ? {
        method: item.confirmation.method,
        origin: item.confirmation.origin,
        procedure: item.confirmation.procedure,
        protocolVersion: item.confirmation.protocol_version,
        observerId: item.confirmation.observer_id,
        scope: {
          sessionId: item.confirmation.scope.session_id,
          attemptId: item.confirmation.scope.attempt_id,
          observedFrom: item.confirmation.scope.observed_from,
          observedTo: item.confirmation.scope.observed_to,
          complete: item.confirmation.scope.complete,
        },
        confirmedAt: item.confirmation.confirmed_at,
      } : {}),
    });
  }
}

console.log(JSON.stringify({ evidence: fixture.evidence, records: dataset.getRecords() }, null, 2));
