import { fixedChallenges, createResult, createAttemptRecorder } from "./fixed-challenges.js";
import { HumanDataset } from "./human-dataset.js";

const $ = (id) => document.getElementById(id);
const challengeSelect = $("challenge");
const area = $("challenge-area");
const stimulus = $("stimulus");
const form = $("answer-form");
const answer = $("answer");
const resultArea = $("result-area");
let answerStartedAt;
let activeResult;
let activeChallenge;
let activeDurationMs;
let recordAttempt = createAttemptRecorder();
let hideTimer;
let dataset;

$("consent").addEventListener("change", () => {
  $("begin-study").disabled = !$("consent").checked;
});

$("begin-study").addEventListener("click", () => {
  if (!$("consent").checked) return;
  dataset = new HumanDataset();
  const pseudonym = dataset.consent({ informed: true, consentVersion: "human-dataset-consent-v1" });
  $("participant-code").textContent = pseudonym;
  $("consent-panel").hidden = true;
  $("setup-panel").hidden = false;
  $("withdraw-area").hidden = false;
  $("consent-status").textContent = "Consent recorded. You may withdraw at any time.";
});

for (const [index, challenge] of fixedChallenges.entries()) {
  const option = document.createElement("option");
  option.value = String(index);
  option.textContent = challenge.title;
  challengeSelect.append(option);
}

function renderTiles(challenge) {
  stimulus.replaceChildren();
  stimulus.style.gridTemplateColumns = "repeat(3, 1fr)";
  stimulus.setAttribute("aria-label", challenge.title);
  for (const kind of challenge.tiles) {
    const tile = document.createElement("div");
    tile.className = "tile";
    if (kind === "blue-circle") Object.assign(tile.style, { background: "#4d86ed", borderRadius: "50%" });
    else if (kind === "coral-square") Object.assign(tile.style, { background: "#f17772" });
    else if (kind === "gold-triangle") {
      tile.style.background = "#f2c04e";
      tile.textContent = "▲";
    } else if (kind === "star" || kind === "heart" || kind === "moon") {
      tile.style.background = "#e9ebf7";
      tile.style.color = "#394da6";
      tile.textContent = ({ star: "★", heart: "♥", moon: "☾" })[kind];
    } else {
      tile.style.background = ({ green: "#54b78a", violet: "#a486df", gold: "#f2c04e" })[kind];
      tile.setAttribute("aria-hidden", "true");
    }
    stimulus.append(tile);
  }
}

$("start").addEventListener("click", () => {
  clearTimeout(hideTimer);
  activeChallenge = fixedChallenges[Number(challengeSelect.value)];
  activeDurationMs = Number($("duration").value);
  recordAttempt = createAttemptRecorder();
  resultArea.hidden = true;
  area.hidden = false;
  $("prompt-title").textContent = activeChallenge.title;
  $("instruction").textContent = activeChallenge.instruction;
  $("answer-label").textContent = activeChallenge.answer_label;
  $("status").textContent = "Pattern is shown briefly.";
  form.hidden = true;
  answer.value = "";
  answer.disabled = false;
  form.querySelector('button[type="submit"]').disabled = false;
  renderTiles(activeChallenge);
  stimulus.hidden = false;
  hideTimer = setTimeout(() => {
    stimulus.hidden = true;
    form.hidden = false;
    $("status").textContent = "The pattern is hidden. Submit your answer when ready.";
    answerStartedAt = performance.now();
    answer.focus();
  }, activeDurationMs);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const result = recordAttempt(() => createResult({
    challenge: activeChallenge,
    duration_ms: activeDurationMs,
    response: answer.value,
    reaction_time_ms: performance.now() - answerStartedAt
  }));
  if (!result) return;
  activeResult = result;
  answer.disabled = true;
  form.querySelector('button[type="submit"]').disabled = true;
  $("result-summary").textContent = activeResult.correct ? "Correct." : "Challenge complete.";
  $("result-json").textContent = JSON.stringify(activeResult, null, 2);
  resultArea.hidden = false;
  $("save-record").disabled = false;
  $("download").disabled = true;
  $("dataset-status").textContent = "This result has not been added to the pilot dataset.";
  $("status").textContent = "Attempt recorded.";
  $("save-record").focus();
});

$("save-record").addEventListener("click", () => {
  if (!dataset || !activeResult) return;
  try {
    dataset.record(activeResult);
    $("save-record").disabled = true;
    $("download").disabled = false;
    $("dataset-status").textContent = "Added to the in-memory pilot dataset. You can download it or withdraw and delete it.";
  } catch (error) {
    $("dataset-status").textContent = error.message;
  }
});

$("download").addEventListener("click", () => {
  if (!dataset) return;
  const records = dataset.getRecords();
  if (!records.length) return;
  const blob = new Blob([`${JSON.stringify({ schema_version: 1, records }, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "human-dataset.json";
  link.click();
  URL.revokeObjectURL(url);
});

$("withdraw").addEventListener("click", () => {
  dataset?.withdraw();
  clearTimeout(hideTimer);
  activeResult = undefined;
  $("result-area").hidden = true;
  $("challenge-area").hidden = true;
  $("setup-panel").hidden = true;
  $("withdraw-area").hidden = true;
  $("consent").disabled = true;
  $("begin-study").disabled = true;
  $("consent").parentElement.hidden = true;
  $("begin-study").hidden = true;
  $("consent-panel").hidden = false;
  $("consent-panel").querySelector("h2").textContent = "Participation ended";
  $("withdraw-message").textContent = "Your participation ended. Records held in this page were deleted and no more data will be collected in this session. To request deletion of files already exported, contact the researcher using the details on your study invitation.";
  $("consent-status").textContent = "Collection ended and records held in this page were deleted.";
});
