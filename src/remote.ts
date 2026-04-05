import type { BrowserContext, Page } from 'playwright';
import { log } from './logger.js';
import { hashString } from './hash.js';
import { jitter, sleep } from './humanize.js';

const CONTENT_URL = 'https://www.tiktok.com/tiktokstudio/content';

/**
 * Fetch captions of videos already on the logged-in user's TikTok account
 * (posted AND scheduled) and return a Set of normalized caption hashes.
 *
 * Strategy:
 *   1. Passively intercept JSON responses while loading Studio's Content
 *      page — this is how the UI itself fetches the post list, so it's the
 *      most reliable source (independent of DOM structure).
 *   2. Also DOM-scrape as a backup in case the JSON shape changed.
 *   3. Scroll aggressively to trigger lazy loading of older posts.
 *
 * Best-effort — if anything fails we return an empty set and log a warning,
 * so remote check never blocks an upload run.
 */
export async function fetchRemoteCaptionHashes(
  context: BrowserContext
): Promise<Set<string>> {
  const captions = new Set<string>();
  const page = await context.newPage();
  const jsonBodies: unknown[] = [];

  page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/item|post|video|aweme|content/i.test(url)) return;
      const ct = res.headers()['content-type'] ?? '';
      if (!ct.includes('json')) return;
      const body = await res.json();
      jsonBodies.push(body);
    } catch {
      /* ignore — not all responses are JSON we can read */
    }
  });

  try {
    log.info('Fetching existing posts from TikTok Studio content page...');
    await page.goto(CONTENT_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await jitter(3_000, 5_000);

    // Scroll to bottom repeatedly to load lazy-loaded older posts.
    let lastHeight = 0;
    for (let i = 0; i < 20; i++) {
      const height = await page.evaluate(() => document.body.scrollHeight);
      if (height === lastHeight && i > 3) break; // no more content
      lastHeight = height;
      await page.keyboard.press('End');
      await sleep(900);
    }
    await jitter(1_000, 2_000);

    for (const c of extractCaptionsFromJson(jsonBodies)) captions.add(c);
    for (const c of await extractCaptionsFromDom(page)) captions.add(c);

    log.info(`Found ${captions.size} existing post caption(s) on your account`);
    if (captions.size === 0) {
      log.warn(
        'No captions extracted — either your account has no posts, or the ' +
          'Studio DOM/JSON shape changed. Local hash dedup is still active.'
      );
    }
  } catch (e) {
    log.warn(`Remote caption check failed: ${(e as Error).message}`);
    log.warn('Continuing with local hash dedup only.');
  } finally {
    await page.close().catch(() => {});
  }

  return new Set(Array.from(captions).map((c) => hashString(c)));
}

/**
 * Walk arbitrary JSON bodies and collect any string values under fields
 * that TikTok uses for post text (desc, title, caption, aweme_desc, ...).
 */
function extractCaptionsFromJson(bodies: unknown[]): string[] {
  const out: string[] = [];
  const captionKeys = new Set([
    'desc',
    'description',
    'title',
    'caption',
    'aweme_desc',
    'share_desc',
    'text_extra_desc',
  ]);

  const visit = (node: unknown, depth: number): void => {
    if (depth > 10 || node == null) return;
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    for (const key of Object.keys(obj)) {
      const v = obj[key];
      if (
        captionKeys.has(key) &&
        typeof v === 'string' &&
        v.trim().length > 0
      ) {
        out.push(v);
      } else {
        visit(v, depth + 1);
      }
    }
  };

  for (const b of bodies) visit(b, 0);
  return out;
}

/**
 * DOM fallback — pull caption-looking text from the content grid. Fragile
 * to Studio redesigns, but cheap and sometimes catches posts that the JSON
 * interceptor missed (e.g. if a response was already cached).
 */
async function extractCaptionsFromDom(page: Page): Promise<string[]> {
  const candidates = [
    '[data-e2e="post-title"]',
    '[data-e2e="video-desc"]',
    '[data-e2e="video-title"]',
    '[data-e2e="post-item"] span',
    'div[class*="PostItem"] span',
    'div[class*="video-card"] span',
  ];
  for (const sel of candidates) {
    try {
      const texts = await page.locator(sel).allTextContents();
      const filtered = texts
        .map((t) => t.trim())
        .filter((t) => t.length > 2 && t.length < 2200); // TikTok caption max
      if (filtered.length > 0) return filtered;
    } catch {
      /* try next */
    }
  }
  return [];
}
