import { createHash } from "node:crypto";
import { readFile, writeFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const TRIAL_RECORD_VERSION = "1.0.0";
export const SUPPORTED_FRAMEWORKS = ["playwright", "selenium", "puppeteer"];
export const TRIAL_RECORD_REQUIRED_FIELDS = ["record_version", "record_id", "manifest_id", "framework", "tool_version", "browser", "browser_version", "cognit_commit", "protocol_version", "config", "config_sha256", "seed", "session_id", "attempt_id", "challenge_id", "evidence_class", "actor_class", "oracle_access", "oracle_source", "observed_result", "perception_metric_eligible", "target_source", "target_origin"];
const FRAMEWORK_TO_TOOL = { playwright: "playwright", selenium: "selenium-webdriver", puppeteer: "puppeteer" };
const TRIAL_RECORD_FIELDS = new Set([...TRIAL_RECORD_REQUIRED_FIELDS, "human_ground_truth"]);

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function configHash(config) {
  return createHash("sha256").update(canonicalize(config), "utf8").digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function requiredString(value, path) {
  if (typeof value !== "string" || !value.trim()) fail(`${path}: required non-empty string`);
  return value;
}

function isControlledOrigin(value) {
  try {
    const origin = new URL(value);
    const allowedHost = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    const canonicalOrigin = origin.origin === value || (origin.port === "" && value === `http://${origin.hostname}:80`);
    return origin.protocol === "http:" && allowedHost && origin.port !== "0" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash && canonicalOrigin;
  } catch { return false; }
}

function isHumanConfirmed(value) {
  return value === "HUMAN_CONFIRMED" || (value && typeof value === "object" && value.label === "HUMAN_CONFIRMED");
}

function runnerAttempts(framework, run) {
  if (!SUPPORTED_FRAMEWORKS.includes(framework)) fail(`framework: expected one of ${SUPPORTED_FRAMEWORKS.join(", ")}`);
  if (!run || typeof run !== "object" || Array.isArray(run)) fail("runner output: expected JSON object");
  if (run.source !== "cognit-fixed-demo") fail("runner output.source: only cognit-fixed-demo is accepted");
  if (!Array.isArray(run.attempts) || run.attempts.length === 0) fail("runner output.attempts: expected at least one attempt");
  return run.attempts;
}

function validateContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("trial record context: expected JSON object");
  if (context.record_version !== TRIAL_RECORD_VERSION) fail(`trial record context.record_version: unsupported version (expected ${TRIAL_RECORD_VERSION})`);
  if (!SUPPORTED_FRAMEWORKS.includes(context.framework)) fail(`trial record context.framework: expected one of ${SUPPORTED_FRAMEWORKS.join(", ")}`);
  requiredString(context.manifest_id, "trial record context.manifest_id");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(context.cognit_commit ?? "")) fail("trial record context.cognit_commit: expected 40- or 64-character lowercase git hash");
  requiredString(context.protocol_version, "trial record context.protocol_version");
  if (typeof context.config !== "object" || !context.config || Array.isArray(context.config)) fail("trial record context.config: expected JSON object");
  if (context.config_sha256 !== configHash(context.config)) fail("trial record context.config_sha256: does not match canonical config SHA-256");
  if (!(requiredNonEmpty(context.seed) || Number.isSafeInteger(context.seed))) fail("trial record context.seed: expected non-empty string or safe integer");
  requiredString(context.tool_version, "trial record context.tool_version");
  requiredString(context.browser, "trial record context.browser");
  requiredString(context.browser_version, "trial record context.browser_version");
  if (!isControlledOrigin(context.target_origin)) fail("trial record context.target_origin: expected an http loopback origin (localhost, 127.0.0.1, or ::1)");
  return context;
}

export function normalizeRunnerOutput({ framework, run, context }) {
  const attempts = runnerAttempts(framework, run);
  const metadata = validateContext(context);
  if (metadata.framework !== framework) fail(`trial record context.framework: ${metadata.framework} does not match requested ${framework}`);
  if (run.target_source !== undefined && run.target_source !== "cognit-fixed-demo") fail("runner output.target_source: only cognit-fixed-demo is accepted");
  if (run.target_origin !== undefined && run.target_origin !== metadata.target_origin) fail("runner output.target_origin: does not match TrialRecord context");
  const docSession = requiredString(run.session_id, "runner output.session_id");

  return attempts.map((attempt, index) => {
    if (!attempt || typeof attempt !== "object" || Array.isArray(attempt)) fail(`runner output.attempts[${index}]: expected object`);
    const sessionId = attempt.session_id ?? docSession;
    requiredString(sessionId, `attempts[${index}].session_id`);
    const challengeId = requiredString(attempt.challenge_id, `attempts[${index}].challenge_id`);
    if (attempt.tool !== undefined && attempt.tool !== FRAMEWORK_TO_TOOL[framework]) fail(`attempts[${index}].tool: does not match framework ${framework}`);
    if (framework !== "playwright") {
      if (requiredString(attempt.tool, `attempts[${index}].tool`) !== FRAMEWORK_TO_TOOL[framework]) fail(`attempts[${index}].tool: does not match framework ${framework}`);
    }
    if (attempt.tool_version !== undefined && attempt.tool_version !== metadata.tool_version) fail(`attempts[${index}].tool_version: does not match TrialRecord context`);
    if (attempt.browser !== undefined && attempt.browser !== metadata.browser) fail(`attempts[${index}].browser: does not match TrialRecord context`);
    if (attempt.browser_version !== undefined && attempt.browser_version !== metadata.browser_version) fail(`attempts[${index}].browser_version: does not match TrialRecord context`);
    const observed = attempt.observed_result;
    if (!observed || typeof observed !== "object" || Array.isArray(observed)) fail(`attempts[${index}].observed_result: required object`);
    if (observed.challenge_id !== challengeId) fail(`attempts[${index}].observed_result.challenge_id: does not match challenge_id`);
    const oracleAnswer = attempt.ground_truth?.expected_answer;
    if (oracleAnswer === undefined || oracleAnswer === null || oracleAnswer === "") fail(`attempts[${index}].ground_truth.expected_answer: missing oracle disclosure source`);
    if (isHumanConfirmed(attempt.human_ground_truth) || isHumanConfirmed(attempt.ground_truth?.label)) fail(`attempts[${index}].human_ground_truth: oracle-assisted automation cannot be HUMAN_CONFIRMED`);
    if (attempt.oracle_access === false) fail(`attempts[${index}].oracle_access: runner used its configured expected answer; disclosure cannot be disabled`);

    const attemptId = attempt.attempt_id === undefined ? `${sessionId}-${index + 1}` : requiredString(attempt.attempt_id, `attempts[${index}].attempt_id`);
    return {
      record_version: TRIAL_RECORD_VERSION,
      record_id: `${metadata.manifest_id}:${sessionId}:${index + 1}`,
      manifest_id: metadata.manifest_id,
      framework,
      tool_version: metadata.tool_version,
      browser: metadata.browser,
      browser_version: metadata.browser_version,
      cognit_commit: metadata.cognit_commit,
      protocol_version: metadata.protocol_version,
      config: metadata.config,
      config_sha256: metadata.config_sha256,
      seed: metadata.seed,
      session_id: sessionId,
      attempt_id: attemptId,
      challenge_id: challengeId,
      evidence_class: "SIMULATED",
      actor_class: "AUTOMATION_CONTROLLED",
      oracle_access: true,
      oracle_source: "runner.ground_truth.expected_answer",
      observed_result: observed,
      perception_metric_eligible: false,
      target_source: "cognit-fixed-demo",
      target_origin: metadata.target_origin,
    };
  });
}

export function validateTrialRecord(record) {
  const errors = [];
  for (const key of TRIAL_RECORD_REQUIRED_FIELDS) if (!Object.hasOwn(record ?? {}, key)) errors.push(`${key}: required`);
  for (const key of Object.keys(record ?? {})) if (!TRIAL_RECORD_FIELDS.has(key)) errors.push(`${key}: unknown field`);
  for (const key of ["record_id", "manifest_id", "tool_version", "browser", "browser_version", "protocol_version", "session_id", "attempt_id", "challenge_id", "oracle_source"]) {
    if (Object.hasOwn(record ?? {}, key) && !requiredNonEmpty(record[key])) errors.push(`${key}: expected non-empty string`);
  }
  if (record?.record_version !== TRIAL_RECORD_VERSION) errors.push(`record_version: expected ${TRIAL_RECORD_VERSION}`);
  if (!SUPPORTED_FRAMEWORKS.includes(record?.framework)) errors.push("framework: unsupported framework");
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record?.cognit_commit ?? "")) errors.push("cognit_commit: expected 40- or 64-character lowercase git hash");
  if (typeof record?.config !== "object" || !record.config || Array.isArray(record.config)) errors.push("config: expected JSON object");
  if (!/^[a-f0-9]{64}$/.test(record?.config_sha256 ?? "")) errors.push("config_sha256: expected 64-character lowercase SHA-256");
  if (!(requiredNonEmpty(record?.seed) || Number.isSafeInteger(record?.seed))) errors.push("seed: expected non-empty string or safe integer");
  if (!record?.observed_result || typeof record.observed_result !== "object" || Array.isArray(record.observed_result)) errors.push("observed_result: expected JSON object");
  if (typeof record?.oracle_access !== "boolean" || record.oracle_access !== true) errors.push("oracle_access: must be true because runner reads the configured expected answer");
  if (!requiredNonEmpty(record?.oracle_source)) errors.push("oracle_source: must name the answer source");
  if (record?.actor_class !== "AUTOMATION_CONTROLLED") errors.push("actor_class: must be AUTOMATION_CONTROLLED");
  if (record?.evidence_class !== "SIMULATED") errors.push("evidence_class: must be SIMULATED");
  if (record?.human_ground_truth !== undefined && record.human_ground_truth !== null) errors.push("human_ground_truth: oracle-assisted records cannot include human ground truth");
  if (record?.perception_metric_eligible !== false) errors.push("perception_metric_eligible: must be false for oracle-assisted automation");
  if (record?.target_source !== "cognit-fixed-demo") errors.push("target_source: only cognit-fixed-demo is accepted");
  if (!isControlledOrigin(record?.target_origin)) errors.push("target_origin: expected an http loopback origin (localhost, 127.0.0.1, or ::1)");
  if (record?.config && typeof record.config === "object" && !Array.isArray(record.config) && record.config_sha256 !== configHash(record.config)) errors.push("config_sha256: does not match canonical config SHA-256");
  return { valid: errors.length === 0, errors };
}

function requiredNonEmpty(value) { return typeof value === "string" && value.trim().length > 0; }

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (!["--framework", "--input", "--context", "--output"].includes(key) || !args[index + 1]) fail(`unsupported or incomplete argument: ${key}`);
    options[key.slice(2)] = args[++index];
  }
  for (const key of ["framework", "input", "context", "output"]) if (!options[key]) fail(`--${key} is required`);
  return options;
}

async function readJson(path) {
  try { return JSON.parse(await readFile(resolve(path), "utf8")); }
  catch (error) { fail(`${path}: ${error.message}`); }
}

async function canonicalPath(path) {
  const absolute = resolve(path);
  try { return await realpath(absolute); }
  catch { return join(await realpath(dirname(absolute)), basename(absolute)); }
}

async function main(args) {
  const options = parseArgs(args);
  const [inputPath, contextPath, outputPath] = await Promise.all([options.input, options.context, options.output].map(canonicalPath));
  if (outputPath === inputPath || outputPath === contextPath) fail("--output must not resolve to the same file as --input or --context");
  const [run, context] = await Promise.all([readJson(options.input), readJson(options.context)]);
  const records = normalizeRunnerOutput({ framework: options.framework, run, context });
  const invalid = records.flatMap((record) => validateTrialRecord(record).errors.map((error) => `${record.record_id}: ${error}`));
  if (invalid.length) fail(invalid.join("\n"));
  await writeFile(outputPath, `${JSON.stringify({ record_version: TRIAL_RECORD_VERSION, records }, null, 2)}\n`);
  process.stdout.write(`Exported ${records.length} ${options.framework} TrialRecord v${TRIAL_RECORD_VERSION} records to ${outputPath} (SIMULATED, oracle-assisted, excluded from perception metrics)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
