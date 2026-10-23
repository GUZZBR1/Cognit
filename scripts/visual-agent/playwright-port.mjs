import { ALLOWED_ORIGIN } from './adapter.mjs';

const ALLOWED_PATHS = new Set(['/visual-agent-demo', '/examples/browser/visual-agent-demo.js']);

export function isAllowedVisualRequest(requestUrl) {
  try {
    const url = new URL(requestUrl);
    return url.protocol === 'http:' && url.origin === ALLOWED_ORIGIN && !url.username && !url.password && !url.search && ALLOWED_PATHS.has(url.pathname);
  } catch {
    return false;
  }
}

/**
 * Builds a real-browser port with request interception installed before navigation.
 * The returned agent-facing port contains screenshot and coordinate-click methods only.
 */
export async function createPlaywrightVisualPort({ chromium, targetUrl = `${ALLOWED_ORIGIN}/visual-agent-demo`, viewport = { width: 640, height: 360 } }) {
  const parsedTarget = new URL(targetUrl);
  if (parsedTarget.origin !== ALLOWED_ORIGIN || parsedTarget.pathname !== '/visual-agent-demo' || parsedTarget.search || parsedTarget.username || parsedTarget.password) {
    throw new Error(`blocked visual demo URL: ${targetUrl}`);
  }
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport });
  const blockedRequests = [];
  await context.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    if (!isAllowedVisualRequest(requestUrl)) {
      blockedRequests.push(requestUrl);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const page = await context.newPage();
  try {
    await page.goto(targetUrl, { waitUntil: 'load' });
    assertControlledPage(page);
  } catch (error) {
    await browser.close();
    throw error;
  }

  const port = Object.freeze({
    get origin() { return new URL(page.url()).origin; },
    async screenshot() {
      assertControlledPage(page);
      const data = await page.screenshot({ type: 'png' });
      assertControlledPage(page);
      const viewport = page.viewportSize();
      return { data, mimeType: 'image/png', width: viewport.width, height: viewport.height };
    },
    async click(x, y) {
      assertControlledPage(page);
      await page.mouse.click(x, y);
      assertControlledPage(page);
    },
  });

  return {
    port,
    browserVersion: browser.version(),
    blockedRequests,
    async close() {
      await browser.close();
    },
  };
}

function assertControlledPage(page) {
  let current;
  try {
    current = new URL(page.url());
  } catch {
    throw new Error('browser left the controlled visual demo');
  }
  if (current.origin !== ALLOWED_ORIGIN || current.pathname !== '/visual-agent-demo') {
    throw new Error(`browser left the controlled visual demo: ${current.origin}${current.pathname}`);
  }
}
