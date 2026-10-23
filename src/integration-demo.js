import { CognitClient } from "./cognit/client-sdk.js";
import { createDemoServiceStub } from "./cognit/demo-service-stub.js";
import { aggregateMouseAttempt } from "./mouse-telemetry.mjs";

const $ = (id) => document.getElementById(id);
const stub = createDemoServiceStub();
const client = new CognitClient({ baseUrl: "http://cognit-demo.local", fetch: stub.fetch });
const points = [];
let sessionId;
let activeChallenge;
let answerStartedAt;
let hideTimer;

function setStatus(message) {
  $("status").textContent = message;
}

function renderTiles(challenge) {
  const stimulus = $("stimulus");
  stimulus.replaceChildren();
  stimulus.setAttribute("aria-label", challenge.title);
  const symbols = { "blue-circle": "", "coral-square": "", "gold-triangle": "▲" };
  for (const tileType of challenge.tiles) {
    const tile = document.createElement("div");
    tile.className = "tile";
    if (tileType === "blue-circle") Object.assign(tile.style, { background: "#4d86ed", borderRadius: "50%" });
    else if (tileType === "coral-square") tile.style.background = "#f17772";
    else if (tileType === "gold-triangle") {
      tile.style.background = "#f2c04e";
      tile.textContent = symbols[tileType];
    }
    stimulus.append(tile);
  }
}

function recordPointer(event) {
  if (!sessionId || $("stimulus").hidden) return;
  const bounds = $("stimulus").getBoundingClientRect();
  points.push({ x: event.clientX - bounds.left, y: event.clientY - bounds.top, t: performance.now() });
}

$("stimulus").addEventListener("pointermove", recordPointer);
$("stimulus").addEventListener("pointerdown", recordPointer);

$("simulate-network-error").addEventListener("click", () => {
  stub.failNextRequest();
  setStatus("Próxima chamada falhará para demonstrar o estado de erro.");
});

$("start").addEventListener("click", async () => {
  clearTimeout(hideTimer);
  sessionId = undefined;
  $("result-area").hidden = true;
  $("result-json").textContent = "";
  $("token-output").textContent = "";
  $("challenge-area").hidden = true;
  try {
    setStatus("Iniciando sessão…");
    const session = await client.createSession();
    sessionId = session.session_id;
    const challenge = await client.getChallenge(sessionId);
    activeChallenge = challenge;
    points.length = 0;
    $("challenge-title").textContent = challenge.title;
    $("instruction").textContent = challenge.instruction;
    $("answer-label").textContent = challenge.answer_label;
    $("answer").value = "";
    $("answer-form").hidden = true;
    renderTiles(challenge);
    $("stimulus").hidden = false;
    $("challenge-area").hidden = false;
    setStatus("Sessão iniciada. O padrão será mostrado brevemente.");
    hideTimer = setTimeout(() => {
      $("stimulus").hidden = true;
      $("answer-form").hidden = false;
      answerStartedAt = performance.now();
      $("answer").focus();
      setStatus("Padrão oculto. Responda para enviar o resultado ao serviço.");
    }, Number($("duration").value));
  } catch (error) {
    setStatus(`Falha ao iniciar: ${error.message}`);
  }
});

$("answer-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!sessionId || !activeChallenge || !$("answer").reportValidity()) return;
  const result = {
    challenge_id: activeChallenge.challenge_id,
    stimulus_id: activeChallenge.stimulus_id,
    response: $("answer").value.trim(),
    reaction_time_ms: Math.max(0, Math.round(performance.now() - answerStartedAt))
  };
  const telemetry = aggregateMouseAttempt(points);
  $("answer").disabled = true;
  $("answer-form").querySelector("button").disabled = true;
  try {
    setStatus("Enviando telemetria agregada e resposta…");
    await client.submitTelemetry(sessionId, telemetry);
    let finalResult = await client.submitResult(sessionId, result);
    let polls = 0;
    while (finalResult.status === "pending" && polls < 5) {
      polls += 1;
      setStatus(`Resultado pendente; consultando o serviço (${polls}/5)…`);
      await new Promise((resolve) => setTimeout(resolve, 250));
      finalResult = await client.getResult(sessionId);
    }
    if (finalResult.status === "pending") {
      setStatus("O serviço ainda está processando o resultado. Você pode consultar novamente ao reiniciar o fluxo.");
      $("result-json").textContent = JSON.stringify(finalResult, null, 2);
      $("result-area").hidden = false;
    } else {
      $("result-json").textContent = JSON.stringify(finalResult.result ?? finalResult, null, 2);
      $("token-output").textContent = finalResult.verification_token
        ? `Token fictício do stub: ${finalResult.verification_token}`
        : "O serviço não retornou token.";
      $("result-area").hidden = false;
      setStatus("Resposta recebida do serviço stub.");
    }
  } catch (error) {
    setStatus(`Não foi possível enviar ou consultar o resultado: ${error.message}`);
  } finally {
    $("answer").disabled = false;
    $("answer-form").querySelector("button").disabled = false;
  }
});
