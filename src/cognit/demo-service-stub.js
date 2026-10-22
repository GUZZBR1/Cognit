import { fixedChallenges } from "../fixed-challenges.js";

/** Local-only service stub. It returns illustrative data and is not security authority. */
export function createDemoServiceStub() {
  const sessions = new Map();
  let failNextRequest = false;

  async function fetchStub(input, init = {}) {
    if (failNextRequest) {
      failNextRequest = false;
      throw new TypeError("Simulated network failure from the local demo stub");
    }

    const url = new URL(input, "http://cognit-demo.local");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const segments = url.pathname.split("/").filter(Boolean);
    let payload;
    let status = 200;

    if (method === "POST" && segments.length === 1 && segments[0] === "sessions") {
      const id = `demo-session-${sessions.size + 1}`;
      sessions.set(id, { resultReads: 0 });
      payload = { session_id: id, status: "active" };
    } else if (segments[0] === "sessions" && segments.length >= 2) {
      const session = sessions.get(segments[1]);
      if (!session) {
        status = 404;
        payload = { error: "session_not_found", message: "Sessão de demonstração não encontrada." };
      } else if (method === "GET" && segments[2] === "challenge") {
        const { challenge_id, stimulus_id, title, instruction, answer_label, tiles } = fixedChallenges[0];
        payload = { challenge_id, stimulus_id, title, instruction, answer_label, tiles, duration_ms: 100 };
      } else if (method === "POST" && segments[2] === "telemetry") {
        session.telemetry = body;
        payload = { status: "received" };
      } else if (method === "POST" && segments[2] === "result") {
        session.submittedResult = body;
        session.resultReads = 0;
        payload = { status: "pending", result_id: `${segments[1]}-result` };
        status = 202;
      } else if (method === "GET" && segments[2] === "result") {
        session.resultReads += 1;
        if (session.resultReads === 1) {
          payload = { status: "pending", result_id: `${segments[1]}-result` };
          status = 202;
        } else {
          payload = {
            status: "completed",
            result: { status: "received", message: "Resposta registrada pelo stub." },
            verification_token: "demo-token-not-for-production"
          };
        }
      } else {
        status = 404;
        payload = { error: "endpoint_not_found", message: "Rota inexistente no stub de demonstração." };
      }
    } else {
      status = 404;
      payload = { error: "endpoint_not_found", message: "Rota inexistente no stub de demonstração." };
    }

    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  return {
    fetch: fetchStub,
    failNextRequest() { failNextRequest = true; }
  };
}
