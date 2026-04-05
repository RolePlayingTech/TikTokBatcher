import type { Locator, Page } from 'playwright';

export const rand = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Random delay between min and max milliseconds. */
export const jitter = (minMs: number, maxMs: number): Promise<void> =>
  sleep(rand(minMs, maxMs));

/** ~200–600ms pause between small UI actions. */
export const microPause = (): Promise<void> => jitter(200, 600);

/** ~1–3s pause after a visible UI change settles. */
export const shortPause = (): Promise<void> => jitter(1_000, 3_000);

/** ~30–120s pause between consecutive video uploads. */
export const longPause = (): Promise<void> => jitter(30_000, 120_000);

/** Type text into a locator with realistic per-character delay. */
export async function humanType(locator: Locator, text: string): Promise<void> {
  // pressSequentially types characters one at a time with a per-key delay,
  // which fires keydown/keypress/keyup events — unlike .fill() which is atomic.
  await locator.pressSequentially(text, { delay: rand(40, 140) });
}

/**
 * Paste text into a contenteditable / input locator the way a human would:
 * click to focus, select-all + delete any prefilled content, then Ctrl+V
 * from a clipboard we populate via the page's clipboard API.
 *
 * A real paste event fires in the page, which is both faster and less
 * conspicuous than typing hundreds of characters one at a time.
 *
 * Fallback chain if the clipboard path is blocked:
 *   1. navigator.clipboard.writeText + Ctrl+V  (primary, fires `paste` event)
 *   2. page.keyboard.insertText                (one-shot, fires `input` event)
 *   3. locator.pressSequentially              (last resort — typing)
 */
export async function pasteText(
  page: Page,
  locator: Locator,
  text: string
): Promise<void> {
  await locator.click();
  await sleep(rand(200, 500));

  // Clear any prefilled content (e.g. filename that Studio auto-inserts)
  await page.keyboard.press('Control+A');
  await sleep(rand(80, 200));
  await page.keyboard.press('Delete');
  await sleep(rand(200, 500));

  // Primary: clipboard + Ctrl+V
  try {
    await page.evaluate(async (t) => {
      await navigator.clipboard.writeText(t);
    }, text);
    await sleep(rand(100, 300));
    await page.keyboard.press('Control+V');
    return;
  } catch {
    /* fall through */
  }

  // Fallback 1: CDP insertText (no clipboard needed)
  try {
    await page.keyboard.insertText(text);
    return;
  } catch {
    /* fall through */
  }

  // Fallback 2: type it out
  await locator.pressSequentially(text, { delay: rand(40, 140) });
}

/**
 * Move the mouse around the viewport a few times to add ambient motion.
 * Does NOT click anything.
 */
export async function wanderMouse(page: Page): Promise<void> {
  const vp = page.viewportSize();
  if (!vp) return;
  const steps = rand(2, 5);
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(
      rand(100, vp.width - 100),
      rand(100, vp.height - 100),
      { steps: rand(10, 25) }
    );
    await jitter(50, 200);
  }
}
