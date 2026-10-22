// Authored fixed stimuli used by the runner. Expected answers are explicit.
export const fixedChallenges = [
  {
    challenge_id: "color-count-01",
    stimulus_id: "grid-blue-01",
    title: "Count the blue circles",
    instruction: "Study the grid. After it disappears, enter the number of blue circles.",
    answer_label: "How many blue circles did you see?",
    expected_answer: "3",
    tiles: ["blue-circle", "coral-square", "blue-circle", "gold-triangle", "coral-square", "blue-circle", "gold-triangle", "coral-square", "gold-triangle"]
  },
  {
    challenge_id: "symbol-count-01",
    stimulus_id: "grid-star-01",
    title: "Count the stars",
    instruction: "Study the grid. After it disappears, enter the number of stars.",
    answer_label: "How many stars did you see?",
    expected_answer: "4",
    tiles: ["star", "heart", "star", "moon", "heart", "star", "moon", "star", "heart"]
  },
  {
    challenge_id: "color-majority-01",
    stimulus_id: "grid-majority-01",
    title: "Spot the majority color",
    instruction: "Study the grid. After it disappears, enter the color you saw most often.",
    answer_label: "Which color appeared most often?",
    expected_answer: "green",
    tiles: ["green", "violet", "green", "green", "gold", "violet", "green", "gold", "violet"]
  }
];

export function normalizeResponse(response) {
  return String(response).trim().toLocaleLowerCase();
}

export function createResult({ challenge, duration_ms, response, reaction_time_ms }) {
  const normalized = normalizeResponse(response);
  return {
    challenge_id: challenge.challenge_id,
    stimulus_id: challenge.stimulus_id,
    duration_ms,
    response: String(response).trim(),
    correct: normalized === normalizeResponse(challenge.expected_answer),
    reaction_time_ms: Math.max(0, Math.round(reaction_time_ms))
  };
}

export function createAttemptRecorder() {
  let completed = false;
  return (record) => {
    if (completed) return null;
    completed = true;
    return record();
  };
}
