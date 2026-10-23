/** Deterministic policy for the local fixture; it receives only the screenshot capability. */
export function createMockPolicy(steps) {
  let index = 0;
  return {
    async act({ screenshot, viewport }) {
      if (!(screenshot.data instanceof Uint8Array) || !screenshot.mimeType.startsWith('image/')) {
        throw new TypeError('mock policy expected screenshot bytes');
      }
      if (!viewport.width || !viewport.height) throw new TypeError('mock policy expected viewport dimensions');
      const step = steps[index++];
      if (!step) return { action: { type: 'stop' }, observation: 'No more fixture actions.' };
      return structuredClone(step);
    },
  };
}
