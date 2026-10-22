import { fixedChallenges, createResult, createAttemptRecorder } from "./fixed-challenges.js";

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
let activePresentation;
let recordAttempt = createAttemptRecorder();
let hideTimer;

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

const tileDescriptions = {
  "blue-circle": "blue circle",
  "coral-square": "coral square",
  "gold-triangle": "gold triangle",
  star: "star",
  heart: "heart",
  moon: "moon",
  green: "green",
  violet: "violet",
  gold: "gold"
};

function renderAccessiblePattern(challenge) {
  const list = $("accessible-stimulus");
  list.replaceChildren();
  for (const tile of challenge.tiles) {
    const item = document.createElement("li");
    item.textContent = tileDescriptions[tile];
    list.append(item);
  }
}

$("presentation").addEventListener("change", () => {
  $("duration-setting").hidden = $("presentation").value === "text";
});

$("start").addEventListener("click", () => {
  clearTimeout(hideTimer);
  activeChallenge = fixedChallenges[Number(challengeSelect.value)];
  activePresentation = $("presentation").value;
  activeDurationMs = activePresentation === "visual" ? Number($("duration").value) : null;
  recordAttempt = createAttemptRecorder();
  resultArea.hidden = true;
  area.hidden = false;
  $("prompt-title").textContent = activeChallenge.title;
  $("instruction").textContent = activePresentation === "visual"
    ? activeChallenge.instruction
    : "Read the pattern sequence in order. Count the requested item, then enter your answer. There is no time limit.";
  $("answer-label").textContent = activeChallenge.answer_label;
  form.hidden = true;
  answer.value = "";
  answer.disabled = false;
  form.querySelector('button[type="submit"]').disabled = false;
  if (activePresentation === "text") {
    stimulus.hidden = true;
    renderAccessiblePattern(activeChallenge);
    $("accessible-stimulus").hidden = false;
    form.hidden = false;
    $("status").textContent = "The accessible pattern is ready. Read the sequence and submit your answer when ready.";
    answerStartedAt = undefined;
    $("prompt-title").focus();
  } else {
    $("accessible-stimulus").hidden = true;
    renderTiles(activeChallenge);
    stimulus.hidden = false;
    $("status").textContent = "Pattern is shown briefly.";
    hideTimer = setTimeout(() => {
      stimulus.hidden = true;
      form.hidden = false;
      $("status").textContent = "The pattern is hidden. Submit your answer when ready.";
      answerStartedAt = performance.now();
      answer.focus();
    }, activeDurationMs);
  }
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;
  const result = recordAttempt(() => createResult({
    challenge: activeChallenge,
    duration_ms: activeDurationMs,
    response: answer.value,
    reaction_time_ms: activePresentation === "visual" ? performance.now() - answerStartedAt : null
  }));
  if (!result) return;
  activeResult = result;
  answer.disabled = true;
  form.querySelector('button[type="submit"]').disabled = true;
  $("result-summary").textContent = activeResult.correct ? "Correct." : "Challenge complete.";
  $("result-json").textContent = JSON.stringify(activeResult, null, 2);
  resultArea.hidden = false;
  $("status").textContent = "Attempt recorded.";
  $("download").focus();
});

$("download").addEventListener("click", () => {
  const blob = new Blob([`${JSON.stringify(activeResult, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${activeResult.challenge_id}-result.json`;
  link.click();
  URL.revokeObjectURL(url);
});
