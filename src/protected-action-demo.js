const question = document.querySelector("#question");
const choices = document.querySelector("#choices");
const status = document.querySelector("#status");
const protectedAction = document.querySelector("#protected-action");
const protectedResult = document.querySelector("#protected-result");
let challengeId;
let verificationToken;

async function request(path, body) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.message || result.status), { result });
  return result;
}

async function loadChallenge() {
  verificationToken = undefined;
  protectedAction.hidden = true;
  const challenge = await request("/api/challenge");
  challengeId = challenge.challenge_id;
  question.textContent = challenge.question;
  choices.replaceChildren(...challenge.choices.map((answer) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = answer;
    button.addEventListener("click", () => submitAnswer(answer));
    return button;
  }));
  status.textContent = "";
}

async function submitAnswer(answer) {
  try {
    const verified = await request("/api/verify", { challenge_id: challengeId, answer });
    verificationToken = verified.token;
    const released = await request("/api/action", { token: verificationToken });
    verificationToken = undefined;
    protectedResult.textContent = released.payload;
    protectedAction.hidden = released.status !== "released";
    status.textContent = released.message;
  } catch (error) {
    if (error.result?.status === "secondary_verification_required") {
      const secondary = await request("/api/secondary-verification");
      status.textContent = secondary.message;
      return;
    }
    status.textContent = "Ação bloqueada. Tente novamente.";
  }
}

document.querySelector("#new-challenge").addEventListener("click", () => {
  loadChallenge().catch(() => { status.textContent = "Não foi possível carregar o desafio."; });
});
loadChallenge().catch(() => { status.textContent = "Não foi possível carregar o desafio."; });
