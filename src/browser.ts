import fs from 'node:fs';
import { chromium, type BrowserContext } from 'playwright';
import { config, stateFiles } from './config.js';

export interface LaunchOpts {
  headless?: boolean;
}

/**
 * Launch a persistent Chromium context so the TikTok session survives between
 * runs (cookies, localStorage, IndexedDB are all stored on disk in stateDir).
 *
 * We deliberately run:
 *   - headful (TikTok trivially detects headless)
 *   - with the AutomationControlled blink feature disabled (basic stealth)
 *   - with a pl-PL locale and the configured timezone so browser env matches the user
 */
export async function launchContext(opts: LaunchOpts = {}): Promise<BrowserContext> {
  fs.mkdirSync(stateFiles.userDataDir, { recursive: true });
  fs.mkdirSync(stateFiles.screenshotsDir, { recursive: true });

  const context = await chromium.launchPersistentContext(stateFiles.userDataDir, {
    headless: opts.headless ?? false,
    viewport: { width: 1440, height: 900 },
    locale: 'pl-PL',
    timezoneId: config.timezone,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });

  // Hide the navigator.webdriver flag that Playwright sets by default.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  // Allow navigator.clipboard.writeText so we can paste captions via Ctrl+V
  // instead of typing them character by character (which is both slow and
  // conspicuous for long captions with hashtags).
  try {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: 'https://www.tiktok.com',
    });
  } catch {
    // Non-fatal — pasteText() has fallbacks that don't need the clipboard API.
  }

  return context;
}
