import { launchContext } from './browser.js';
import { config } from './config.js';
import { log } from './logger.js';

async function main(): Promise<void> {
  log.info('Opening TikTok Studio in a persistent browser profile...');
  const context = await launchContext({ headless: false });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.studioUrl);

  log.info('Log in with your TikTok account in the browser window.');
  log.info('When you see the upload page and you are fully logged in,');
  log.info('come back to this terminal and press Enter.');

  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  await new Promise<void>((resolve) => {
    process.stdin.once('data', () => resolve());
  });

  // launchPersistentContext persists cookies automatically on context close.
  await context.close();
  log.ok('Session saved. You can now run: npm run plan && npm run upload');
  process.exit(0);
}

main().catch((e) => {
  log.err(String(e));
  process.exit(1);
});
