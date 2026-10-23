import { CognitClient } from '/dist/client-sdk.js';

const output = document.querySelector('#output');
const button = document.querySelector('#run');
const client = new CognitClient({ baseUrl: '/api' });

button.addEventListener('click', async () => {
  button.disabled = true;
  output.textContent = 'Running…';
  try {
    const session = await client.createSession();
    const challenge = await client.getChallenge(session.session_id);
    await client.submitTelemetry(session.session_id, { events: [{ type: 'demo', at: Date.now() }] });
    const result = await client.submitResult(session.session_id, {
      challenge_id: challenge.challenge_id,
      answer: 'blue',
    });
    const verification = await client.verifySession(session.session_id);
    output.textContent = JSON.stringify({ session, challenge, result, verification }, null, 2);
  } catch (error) {
    output.textContent = `${error.name}: ${error.message}`;
  } finally {
    button.disabled = false;
  }
});
