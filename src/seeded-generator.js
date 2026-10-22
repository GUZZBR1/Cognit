// Separate deterministic generator API. The fixed challenge runner does not import this module.
export function createSeededStimulus(seed, size = 9) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  let state = Number(seed) >>> 0;
  const next = () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const symbols = ["circle", "square", "triangle"];
  return Array.from({ length: size }, () => symbols[Math.floor(next() * symbols.length)]);
}
