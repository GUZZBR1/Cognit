const ENGINE_VERSION = "1.0.0";
const MUTATIONS = ["durationMs", "positions", "order", "distractors"];

function fail(message) {
  throw new TypeError(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validatePosition(value, label) {
  if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    fail(`${label} must be an object with finite numeric x and y`);
  }
}

function validateIds(list, label, knownIds, { unique = true } = {}) {
  if (!Array.isArray(list)) fail(`${label} must be an array`);
  const seen = new Set();
  for (const id of list) {
    if (typeof id !== "string" || id.length === 0) fail(`${label} must contain non-empty string IDs`);
    if (knownIds && !knownIds.has(id)) fail(`${label} contains unknown ID: ${id}`);
    if (unique && seen.has(id)) fail(`${label} contains duplicate ID: ${id}`);
    seen.add(id);
  }
}

function validateOptions(config, name) {
  const options = config[name];
  if (!Array.isArray(options) || options.length === 0) fail(`config.${name} must be a non-empty array`);
  return options;
}

function validate(challenge, config, seed) {
  if (!isRecord(challenge)) fail("challenge must be an object");
  if (!Array.isArray(challenge.items) || challenge.items.length === 0) fail("challenge.items must be a non-empty array");
  const ids = [];
  for (const [index, item] of challenge.items.entries()) {
    if (!isRecord(item)) fail(`challenge.items[${index}] must be an object`);
    if (typeof item.id !== "string" || item.id.length === 0) fail(`challenge.items[${index}].id must be a non-empty string`);
    ids.push(item.id);
    validatePosition(item.position, `challenge.items[${index}].position`);
  }
  const knownIds = new Set(ids);
  if (knownIds.size !== ids.length) fail("challenge.items IDs must be unique");
  validateIds(challenge.distractors, "challenge.distractors", knownIds);
  if (!isRecord(config)) fail("config must be an object");
  const unknownMutations = Object.keys(config).filter((name) => !MUTATIONS.includes(name));
  if (unknownMutations.length > 0) {
    fail(`config contains unsupported mutation: ${unknownMutations[0]}`);
  }
  if (typeof seed !== "string" && (typeof seed !== "number" || !Number.isFinite(seed))) {
    fail("seed must be a finite number or string");
  }

  const durationOptions = validateOptions(config, "durationMs");
  durationOptions.forEach((duration, index) => {
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      fail(`config.durationMs[${index}] must be a positive finite number`);
    }
  });

  const positionOptions = validateOptions(config, "positions");
  positionOptions.forEach((option, index) => {
    if (!isRecord(option)) fail(`config.positions[${index}] must be an object`);
    if (Object.keys(option).length !== ids.length || ids.some((id) => !Object.hasOwn(option, id))) {
      fail(`config.positions[${index}] must define exactly one position for every item ID`);
    }
    for (const id of ids) validatePosition(option[id], `config.positions[${index}].${id}`);
  });

  const orderOptions = validateOptions(config, "order");
  orderOptions.forEach((option, index) => {
    validateIds(option, `config.order[${index}]`, knownIds);
    if (option.length !== ids.length || new Set(option).size !== ids.length) {
      fail(`config.order[${index}] must contain every item ID exactly once`);
    }
  });

  const distractorOptions = validateOptions(config, "distractors");
  distractorOptions.forEach((option, index) => {
    validateIds(option, `config.distractors[${index}]`, knownIds);
    if (option.length !== challenge.distractors.length) {
      fail(`config.distractors[${index}] must contain ${challenge.distractors.length} IDs`);
    }
  });
  return { ids };
}

function hash(text) {
  let value = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function chooseIndex(seed, mutationName, length) {
  let state = hash(`${typeof seed}:${String(seed)}\0${mutationName}`);
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return Math.floor((state / 0x100000000) * length);
}

/** Selects one deterministic presentation mutation per named substream. */
export function mutateChallenge(challenge, config, seed) {
  validate(challenge, config, seed);
  const choices = Object.fromEntries(MUTATIONS.map((name) => [name, chooseIndex(seed, name, config[name].length)]));
  const positionChoice = config.positions[choices.positions];
  const orderChoice = config.order[choices.order];
  const distractorChoice = config.distractors[choices.distractors];
  const positions = Object.fromEntries(Object.entries(positionChoice).map(([id, position]) => [id, { x: position.x, y: position.y }]));

  return {
    challenge,
    presentation: {
      durationMs: config.durationMs[choices.durationMs],
      positions,
      visualOrder: [...orderChoice],
      distractors: [...distractorChoice]
    },
    metadata: {
      seed,
      engineVersion: ENGINE_VERSION,
      selectedOptions: choices
    }
  };
}
