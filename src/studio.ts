import fs from 'node:fs';
import path from 'node:path';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import type { BrowserContext, Page } from 'playwright';
import { config, stateFiles } from './config.js';
import { findFirst, selectors } from './selectors.js';
import { log } from './logger.js';
import {
  jitter,
  microPause,
  pasteText,
  shortPause,
  sleep,
  wanderMouse,
} from './humanize.js';
import type { PlanEntry } from './types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

export interface UploadOptions {
  dryRun: boolean;
}

export async function openStudio(context: BrowserContext): Promise<Page> {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(config.studioUrl, { waitUntil: 'domcontentloaded' });
  await shortPause();
  return page;
}

/**
 * Upload and schedule one video end-to-end.
 *
 * Flow:
 *   1. Navigate to a fresh upload page.
 *   2. Attach the video file to the hidden <input type="file">.
 *   3. Wait for the caption editor to appear (signals transcode finished).
 *   4. Type the caption with human-like per-character delays.
 *   5. Switch the posting time to "Schedule" and set date + time.
 *   6. Click the final post/schedule button, wait for success toast.
 *
 * Screenshots are captured on any failure for post-mortem debugging.
 */
export async function uploadOne(
  page: Page,
  entry: PlanEntry,
  opts: UploadOptions
): Promise<void> {
  const absPath = path.isAbsolute(entry.videoFile)
    ? entry.videoFile
    : path.resolve(config.root, entry.videoFile);

  log.step(`Upload: ${path.basename(absPath)}`);
  log.dim(`schedule: ${entry.scheduledFor}`);
  const captionPreview =
    entry.caption.length > 80 ? entry.caption.slice(0, 77) + '...' : entry.caption;
  log.dim(`caption:  ${captionPreview}`);

  // 1) Fresh upload page
  await page.goto(config.studioUrl, { waitUntil: 'domcontentloaded' });
  await wanderMouse(page);
  await shortPause();

  // Dismiss any one-time "What's new" / onboarding modals that Studio
  // sometimes injects on top of the form. They block scheduleToggle clicks
  // and were the root cause of early upload failures.
  await dismissModals(page);

  // 2) Attach file to the hidden input
  const fileInput = await findFirst(page, selectors.fileInput, { timeout: 20_000 });
  await fileInput.setInputFiles(absPath);
  log.dim('file attached, waiting for transcode...');

  // 3) Caption editor appears once the upload is processed
  const caption = await findFirst(page, selectors.captionEditor, {
    timeout: 180_000,
    state: 'visible',
  });
  await jitter(1_500, 3_500);

  // 4) Caption — paste via clipboard (fires a real `paste` event, matches
  // how a human actually fills long captions with hashtags).
  await pasteText(page, caption, entry.caption);
  await shortPause();

  // 5) Schedule
  await dismissModals(page);
  await setSchedule(page, entry.scheduledFor);
  await shortPause();

  // 6) Submit
  if (opts.dryRun) {
    log.warn('dry-run enabled — not submitting');
    await screenshot(page, 'dryrun');
    return;
  }

  const postBtn = await findFirst(page, selectors.postButton, {
    timeout: 10_000,
    state: 'visible',
  });
  await wanderMouse(page);
  await postBtn.click();

  // After clicking "Zaplanuj", Studio often shows a confirmation modal:
  //   Title: "Kontynuować publikowanie?"
  //   Body:  "Wciąż sprawdzamy Twój film pod kątem potencjalnych problemów..."
  //   Buttons: "Anuluj" / "Opublikuj teraz" (primary)
  // "Opublikuj teraz" here does NOT mean "post without schedule" — it means
  // "continue publishing with the selected schedule despite moderation still
  // running". We must click it, otherwise the upload is stuck.
  await confirmPublishModal(page);

  // IMPORTANT: we MUST throw on no-success. Previously this was a warning,
  // which caused upload.ts to mark failed uploads as successful in
  // state/uploaded.json — the remote account didn't match local state.
  await waitForUploadSuccess(page);
}

/**
 * Wait until we have solid evidence the upload completed. Studio's success
 * signals are unreliable:
 *   - Toast may appear and disappear faster than our wait interval
 *   - URL may or may not change
 *   - Form may simply be cleared
 *
 * We accept ANY of these as confirmation:
 *   A) URL navigated away from /upload (e.g. to /content)
 *   B) `schedule_container` DOM element vanished (form reset/cleared)
 *   C) `caption_container` DOM element vanished
 *   D) A text toast matching any success pattern became visible
 *
 * Throws after 120s if none of the above triggered.
 */
async function waitForUploadSuccess(page: Page): Promise<void> {
  const start = Date.now();
  const timeout = 120_000;
  const startUrl = page.url();

  while (Date.now() - start < timeout) {
    // A) URL change
    const currentUrl = page.url();
    if (currentUrl !== startUrl && !currentUrl.includes('/upload')) {
      log.ok(`scheduled successfully (URL changed to ${currentUrl})`);
      return;
    }

    // B/C) Form vanished — upload flow completed on the page itself
    const scheduleVisible = await page
      .locator('div[data-e2e="schedule_container"]')
      .first()
      .isVisible()
      .catch(() => true);
    const captionVisible = await page
      .locator('div[data-e2e="caption_container"]')
      .first()
      .isVisible()
      .catch(() => true);
    if (!scheduleVisible && !captionVisible) {
      log.ok('scheduled successfully (form cleared)');
      return;
    }

    // D) Success toast text
    for (const pattern of [/zaplanowan/i, /opublikowan/i, /scheduled/i, /posted/i, /success/i]) {
      const t = page.locator(`text=${pattern.source}`).first();
      if (await t.isVisible().catch(() => false)) {
        log.ok(`scheduled successfully (toast matched ${pattern})`);
        return;
      }
    }

    await sleep(1_000);
  }

  await screenshot(page, 'no-success');
  throw new Error(
    `upload success not detected within ${timeout / 1_000}s — HTML + PNG dumped. ` +
      `URL=${page.url()}`
  );
}

/**
 * If Studio shows the "Kontynuować publikowanie?" confirmation modal after
 * clicking the post button, click its primary "Opublikuj teraz" button to
 * continue. If no modal appears within ~4s, assume the post went straight
 * through (moderation check already finished) and return.
 */
async function confirmPublishModal(page: Page): Promise<void> {
  const confirmTexts = [
    'Opublikuj teraz',  // PL primary
    'Post now',          // EN primary
    'Publish now',       // EN alt
    'Kontynuuj',         // PL alt
    'Continue',          // EN alt
  ];
  const start = Date.now();
  while (Date.now() - start < 5_000) {
    for (const text of confirmTexts) {
      try {
        const btn = page.getByRole('button', { name: text, exact: true }).first();
        if (await btn.isVisible({ timeout: 200 })) {
          log.dim(`publish confirmation modal: clicking "${text}"`);
          await btn.click({ timeout: 3_000 });
          await sleep(600);
          return;
        }
      } catch {
        /* not visible — try next */
      }
    }
    await sleep(200);
  }
  log.dim('no publish confirmation modal — proceeding');
}

/**
 * Dismiss any "What's new" / onboarding modal Studio may have injected on
 * top of the upload form. Non-fatal: if no modal is present, returns fast.
 *
 * Observed modal: "Dodano nowe funkcje do edycji" with red "Rozumiem" button.
 */
async function dismissModals(page: Page): Promise<void> {
  const texts = ['Rozumiem', 'Got it', 'Zamknij', 'Close', 'OK'];
  for (const text of texts) {
    try {
      const btn = page.getByRole('button', { name: text, exact: true }).first();
      if (await btn.isVisible({ timeout: 300 })) {
        log.dim(`dismissing modal: "${text}"`);
        await btn.click({ timeout: 2_000 });
        await sleep(500);
      }
    } catch {
      /* no such button visible — continue */
    }
  }
  // Some modals use an Escape-to-close pattern
  await page.keyboard.press('Escape').catch(() => {});
}

/**
 * Click the "Zaplanuj" / "Schedule" radio.
 *
 * Confirmed from Studio HTML dump: these are NATIVE radio inputs inside
 * `<label class="Radio__root">` elements with name="postSchedule" and
 * value="schedule". The native input is `visibility: hidden` but still
 * clickable via the label. We click the label (which wraps the input) to
 * avoid interactable-visibility errors on the hidden <input> itself.
 */
async function clickScheduleRadio(page: Page): Promise<void> {
  const strategies: Array<{ name: string; run: () => Promise<void> }> = [
    {
      name: 'label:has(input[value=schedule])',
      run: async () => {
        await page
          .locator('label:has(input[type="radio"][value="schedule"])')
          .first()
          .click({ timeout: 3_000 });
      },
    },
    {
      name: 'input[value=schedule] force click',
      run: async () => {
        await page
          .locator('input[type="radio"][name="postSchedule"][value="schedule"]')
          .first()
          .click({ timeout: 3_000, force: true });
      },
    },
    {
      name: 'getByText(Zaplanuj exact)',
      run: async () => {
        await page
          .getByText('Zaplanuj', { exact: true })
          .first()
          .click({ timeout: 3_000 });
      },
    },
    {
      name: 'getByText(Schedule exact)',
      run: async () => {
        await page
          .getByText('Schedule', { exact: true })
          .first()
          .click({ timeout: 3_000 });
      },
    },
  ];

  for (const s of strategies) {
    try {
      await s.run();
      // Verify radio actually flipped to checked
      const checked = await page
        .locator('input[type="radio"][name="postSchedule"][value="schedule"]')
        .first()
        .isChecked()
        .catch(() => false);
      if (checked) {
        log.dim(`schedule radio clicked via: ${s.name} (checked=true)`);
        return;
      }
      log.dim(`  ${s.name} click succeeded but radio not checked — retrying`);
    } catch (e) {
      log.dim(`  ${s.name} failed: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error('Could not click Schedule/Zaplanuj radio — all strategies failed');
}

/**
 * Toggle the "Schedule" radio and fill in date + time fields.
 *
 * TikTok Studio uses a custom TUX form with READONLY text inputs that open
 * a scroll picker on click — you cannot type into them. We click the input
 * to open the picker, then click the option items that match our target.
 *
 * Confirmed DOM (from state/screenshots/date-fail-*.html):
 *   .scheduled-picker
 *     ├─ input.TUXTextInputCore-input (readonly, value="HH:MM")    ← TIME
 *     │  └─ .tiktok-timepicker-time-picker-container (popup)
 *     │       ├─ .tiktok-timepicker-time-scroll-container (hours 00-23)
 *     │       └─ .tiktok-timepicker-time-scroll-container (mins 00-55 /5)
 *     └─ input.TUXTextInputCore-input (readonly, value="YYYY-MM-DD") ← DATE
 *         └─ calendar popup (opens on click, structure TBD)
 */
async function setSchedule(page: Page, scheduledFor: string): Promise<void> {
  // IMPORTANT: use .tz(config.timezone).format() so the display matches the
  // value we're actually going to set (plan stores ISO with +02:00, but
  // plain .format() converts to the Node process's local TZ).
  const when = dayjs(scheduledFor).tz(config.timezone);
  const dateStr = when.format('YYYY-MM-DD');
  const timeStr = when.format('HH:mm');
  const hourStr = when.format('HH');
  const minuteStr = when.format('mm');
  log.dim(`setting schedule: ${dateStr} ${timeStr}`);

  await clickScheduleRadio(page);
  await shortPause();

  // --- DATE ---
  // Read the current date shown in the input. If it already matches, skip.
  try {
    const dateInput = await findFirst(page, selectors.dateField, { timeout: 5_000 });
    const currentDate = await dateInput.inputValue().catch(() => '');
    log.dim(`current date in picker: "${currentDate}", target: "${dateStr}"`);
    if (currentDate !== dateStr) {
      await pickDate(page, dateInput, dateStr);
    } else {
      log.dim('date already matches — skipping date picker');
    }
  } catch (e) {
    log.warn(`date field interaction failed: ${(e as Error).message}`);
    await screenshot(page, 'date-fail');
  }

  await microPause();

  // --- TIME ---
  try {
    const timeInput = await findFirst(page, selectors.timeField, { timeout: 5_000 });
    const currentTime = await timeInput.inputValue().catch(() => '');
    log.dim(`current time in picker: "${currentTime}", target: "${timeStr}"`);
    if (currentTime !== timeStr) {
      await pickTime(page, timeInput, hourStr, minuteStr);
    } else {
      log.dim('time already matches — skipping time picker');
    }
  } catch (e) {
    log.warn(`time field interaction failed: ${(e as Error).message}`);
    await screenshot(page, 'time-fail');
  }

  // Dismiss any lingering dropdowns
  await page.keyboard.press('Escape').catch(() => {});
  await microPause();

  // Verification: read both fields back and confirm they match target
  await verifySchedule(page, dateStr, timeStr);
}

/**
 * Open the time picker and click the option items for target hour + minute.
 * Studio's picker has two vertical scroll columns (hours, minutes). Each
 * option is a div.tiktok-timepicker-option-item with a span containing the
 * zero-padded number as text. Minutes come in 5-minute granularity.
 */
async function pickTime(
  page: Page,
  timeInput: import('playwright').Locator,
  hour: string,
  minute: string
): Promise<void> {
  log.dim(`pickTime: ${hour}:${minute}`);
  await timeInput.click();
  await sleep(500);

  // Wait for the picker popup to become visible (loses .tiktok-timepicker-invisible)
  const popup = page.locator('.tiktok-timepicker-time-picker-container').first();
  await popup.waitFor({ state: 'attached', timeout: 5_000 });
  await sleep(300);

  const columns = popup.locator('.tiktok-timepicker-time-scroll-container');
  const colCount = await columns.count();
  if (colCount < 2) {
    throw new Error(`time picker: expected 2 scroll columns, got ${colCount}`);
  }

  // Hours column (first)
  const hoursCol = columns.nth(0);
  const hourOption = hoursCol
    .locator('.tiktok-timepicker-option-item', { hasText: new RegExp(`^${hour}$`) })
    .first();
  // Custom scroll containers defeat Playwright's auto-scroll. Jump into
  // view via JS evaluate, then click with force to skip the visibility
  // reachability check (the option may briefly be outside the clipped area).
  await hourOption.evaluate((el) =>
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
  );
  await sleep(200);
  await hourOption.click({ timeout: 3_000, force: true });
  await sleep(400);

  // Minutes column (second)
  const minutesCol = columns.nth(1);
  const minuteOption = minutesCol
    .locator('.tiktok-timepicker-option-item', { hasText: new RegExp(`^${minute}$`) })
    .first();
  await minuteOption.evaluate((el) =>
    (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' })
  );
  await sleep(200);
  await minuteOption.click({ timeout: 3_000, force: true });
  await sleep(400);

  // Click outside to dismiss picker
  await page.mouse.click(10, 10).catch(() => {});
  await sleep(400);
}

/**
 * Open the TikTok Studio date picker and click the cell matching targetDate.
 *
 * Confirmed DOM (from state/screenshots/calendar-open-*.html):
 *   .calendar-wrapper
 *     ├─ .month-header-wrapper
 *     │   ├─ span.arrow (prev month, first)
 *     │   ├─ .title-wrapper
 *     │   │   ├─ .month-title  ("Kwiecień")
 *     │   │   └─ .year-title   ("2026")
 *     │   └─ span.arrow (next month, last)
 *     ├─ .day-header-wrapper (weekday labels)
 *     └─ .days-wrapper × N  (one per week)
 *         └─ .day-span-container
 *             └─ span.day          ← text is day number
 *                    .valid        ← clickable (inside current month)
 *                    .selected     ← currently chosen
 *
 * Algorithm:
 *   1. Read .month-title + .year-title; compare to target month/year
 *   2. Click next/prev arrow until calendar lands on target month
 *   3. Click span.day.valid with text === target day number
 */
const POLISH_MONTHS = [
  'styczeń', 'luty', 'marzec', 'kwiecień', 'maj', 'czerwiec',
  'lipiec', 'sierpień', 'wrzesień', 'październik', 'listopad', 'grudzień',
];

async function pickDate(
  page: Page,
  dateInput: import('playwright').Locator,
  targetDate: string // "YYYY-MM-DD"
): Promise<void> {
  log.dim(`pickDate: ${targetDate}`);
  await dateInput.click();
  await sleep(600);

  const when = dayjs(targetDate);
  const targetDay = when.date();
  const targetMonth = when.month(); // 0-11
  const targetYear = when.year();
  const targetMonthName = POLISH_MONTHS[targetMonth];

  const calendar = page.locator('.calendar-wrapper').first();
  await calendar.waitFor({ state: 'visible', timeout: 3_000 });

  // --- Navigate to target month ---
  for (let safety = 0; safety < 24; safety++) {
    const monthText = (await calendar.locator('.month-title').first().textContent() || '').trim().toLowerCase();
    const yearText = (await calendar.locator('.year-title').first().textContent() || '').trim();
    const currentYear = parseInt(yearText, 10);
    const currentMonth = POLISH_MONTHS.findIndex((m) => m === monthText);
    log.dim(`calendar at: ${monthText} ${yearText} (target: ${targetMonthName} ${targetYear})`);

    if (currentMonth === targetMonth && currentYear === targetYear) break;

    // Decide direction: go forward if target is in the future
    const targetTotal = targetYear * 12 + targetMonth;
    const currentTotal = (Number.isFinite(currentYear) ? currentYear : targetYear) * 12 + (currentMonth >= 0 ? currentMonth : targetMonth);
    const goForward = targetTotal > currentTotal;

    const arrows = calendar.locator('.month-header-wrapper .arrow');
    const arrowCount = await arrows.count();
    if (arrowCount < 2) {
      throw new Error(`calendar: expected 2 nav arrows, got ${arrowCount}`);
    }
    const arrow = goForward ? arrows.nth(1) : arrows.nth(0);
    await arrow.click({ timeout: 2_000 });
    await sleep(200);
  }

  // --- Click the target day ---
  // span.day.valid with exact text === targetDay. Filter by ^N$ to avoid
  // matching "12" when looking for "1" (filter with hasText regex).
  const dayCell = calendar
    .locator('span.day.valid')
    .filter({ hasText: new RegExp(`^${targetDay}$`) })
    .first();
  await dayCell.waitFor({ state: 'visible', timeout: 3_000 });
  await dayCell.click({ timeout: 3_000 });
  await sleep(400);

  // Dismiss calendar by clicking elsewhere (top-left)
  await page.mouse.click(10, 10).catch(() => {});
  await sleep(300);

  // Verify
  const newVal = await dateInput.inputValue().catch(() => '');
  if (newVal !== targetDate) {
    await screenshot(page, 'calendar-open');
    throw new Error(`pickDate: clicked day ${targetDay} but input value is "${newVal}" (expected ${targetDate})`);
  }
  log.dim(`date picked: ${newVal}`);
}

/**
 * Re-read the date and time inputs after setting them. If they don't match
 * the target, throw — better to abort this video than to post at the wrong
 * time.
 */
async function verifySchedule(
  page: Page,
  expectedDate: string,
  expectedTime: string
): Promise<void> {
  const dateVal = await page
    .locator(selectors.dateField[0])
    .first()
    .inputValue()
    .catch(() => '');
  const timeVal = await page
    .locator(selectors.timeField[0])
    .first()
    .inputValue()
    .catch(() => '');
  if (dateVal !== expectedDate || timeVal !== expectedTime) {
    await screenshot(page, 'verify-fail');
    throw new Error(
      `schedule verification failed: got ${dateVal} ${timeVal}, expected ${expectedDate} ${expectedTime}`
    );
  }
  log.dim(`schedule verified: ${dateVal} ${timeVal}`);
}

export async function screenshot(page: Page, tag: string): Promise<void> {
  const ts = Date.now();
  const pngFile = path.join(stateFiles.screenshotsDir, `${tag}-${ts}.png`);
  const htmlFile = path.join(stateFiles.screenshotsDir, `${tag}-${ts}.html`);
  try {
    await page.screenshot({ path: pngFile, fullPage: true });
    log.dim(`screenshot: ${pngFile}`);
  } catch {
    /* ignore */
  }
  // Also dump the DOM — selector debugging is 10x easier with raw HTML than
  // trying to reverse-engineer a screenshot.
  try {
    const html = await page.content();
    fs.writeFileSync(htmlFile, html, 'utf8');
    log.dim(`html dump: ${htmlFile}`);
  } catch {
    /* ignore */
  }
}
