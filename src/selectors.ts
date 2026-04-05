import type { Locator, Page } from 'playwright';

/**
 * TikTok Studio DOM selectors.
 *
 * IMPORTANT: TikTok's DOM changes without warning. If uploads start failing,
 * open Studio in your browser, inspect the relevant element, and update the
 * matching selector list here. Each field is an array — `findFirst` tries
 * them in order and returns the first one that attaches.
 *
 * Keep language-agnostic / data-attribute selectors FIRST (most stable),
 * text-based selectors LAST (most likely to break on UI copy changes).
 */
export const selectors = {
  // Hidden <input type="file"> that accepts the video upload
  fileInput: [
    'input[type="file"][accept*="video"]',
    'input[type="file"]',
  ],

  // Caption / description editor (DraftJS contenteditable div)
  captionEditor: [
    'div[contenteditable="true"][role="combobox"]',
    'div[contenteditable="true"][data-contents="true"]',
    'div[data-e2e="video_caption"] div[contenteditable="true"]',
    'div[contenteditable="true"]',
  ],

  // The "Schedule" radio in the posting time section.
  // Confirmed from HTML dump: Studio actually uses native radio inputs
  // <input type="radio" name="postSchedule" value="schedule">. We click the
  // native input directly for reliability; text-label fallbacks remain for
  // older / English Studio variants.
  scheduleToggle: [
    'input[type="radio"][name="postSchedule"][value="schedule"]',
    'input[type="radio"][value="schedule"]',
    'label:has(input[type="radio"][value="schedule"])',
    'label:has-text("Zaplanuj")',
    'label:has-text("Schedule")',
  ],

  // One-time "What's new" modals that occasionally cover the form. We click
  // the dismiss button before interacting with the schedule controls.
  modalDismiss: [
    'button:has-text("Rozumiem")',
    'button:has-text("Got it")',
    'button:has-text("OK")',
    'button:has-text("Zamknij")',
    'button:has-text("Close")',
    'div[role="dialog"] button',
  ],

  // Schedule picker root (confirmed selector inside data-e2e="schedule_container")
  schedulePicker: [
    'div[data-e2e="schedule_container"] .scheduled-picker',
    '.scheduled-picker',
  ],

  // Date picker trigger. Confirmed from HTML: readonly TUX text input
  // with value "YYYY-MM-DD". There are TWO such inputs inside .scheduled-picker;
  // date is the SECOND one (time comes first in DOM order). We match by the
  // value pattern to avoid positional fragility.
  dateField: [
    'div[data-e2e="schedule_container"] input.TUXTextInputCore-input[value^="20"]',
    '.scheduled-picker input.TUXTextInputCore-input[value^="20"]',
  ],

  // Time picker trigger. Confirmed: readonly TUX text input with value "HH:MM".
  // Matches by 5-char value pattern via CSS :not() on the 10-char date input.
  timeField: [
    '.scheduled-picker input.TUXTextInputCore-input:not([value^="20"])',
    'div[data-e2e="schedule_container"] input.TUXTextInputCore-input:not([value^="20"])',
  ],

  // Time picker dropdown (appears after clicking the time input). Contains
  // two scroll columns: first = hours (00-23), second = minutes (00,05,...,55).
  timePickerPopup: [
    '.tiktok-timepicker-time-picker-container:not(.tiktok-timepicker-invisible)',
    '.tiktok-timepicker-time-picker-container',
  ],
  timePickerColumn: ['.tiktok-timepicker-time-scroll-container'],
  timePickerOption: ['.tiktok-timepicker-option-item'],

  // Final post / schedule button
  postButton: [
    'button[data-e2e="post_video_button"]',
    'button[data-e2e="publish-button"]',
    'button:has-text("Schedule"):not(:has-text("Now"))',
    'button:has-text("Zaplanuj"):not(:has-text("Teraz"))',
    'button:has-text("Post")',
    'button:has-text("Opublikuj")',
  ],

  // Success toast / confirmation after posting
  successIndicator: [
    'text=/your video (has been|is being) (scheduled|posted)/i',
    'text=/video scheduled/i',
    'text=/zaplanowano/i',
    'text=/opublikowano/i',
  ],
} as const;

/**
 * Try each selector in order and return the first locator that attaches
 * within the timeout budget. Throws a descriptive error listing all
 * attempted selectors if none match.
 */
export async function findFirst(
  page: Page,
  candidates: readonly string[],
  opts: { timeout?: number; state?: 'attached' | 'visible' } = {}
): Promise<Locator> {
  const timeout = opts.timeout ?? 10_000;
  const state = opts.state ?? 'attached';
  const perCandidate = Math.max(500, Math.floor(timeout / candidates.length));

  let lastErr: unknown;
  for (const sel of candidates) {
    const loc = page.locator(sel).first();
    try {
      await loc.waitFor({ state, timeout: perCandidate });
      return loc;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `No selector matched. Tried:\n  - ${candidates.join('\n  - ')}\n` +
      `Last error: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`
  );
}
