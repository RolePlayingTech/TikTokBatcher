# TikTokBatcher

Batch-schedule videos to **TikTok Studio** by dropping `.mp4` files (plus a matching `.txt` caption) into a folder and running two commands. No API keys, no official upload endpoint — the tool drives a real Chromium browser via [Playwright](https://playwright.dev/) against `tiktok.com/tiktokstudio/upload`, reusing your logged-in session.

Built for creators who want to queue up a week or two of content at a time without sitting through the Studio UI for every clip.

> **Heads up — this is automation against a third-party UI.** TikTok's DOM changes without warning. Selectors may break; you'll need to be comfortable tweaking a CSS selector in `src/selectors.ts` once in a while. The tool is designed to fail loudly (screenshots + thrown errors) when that happens, not silently mark broken uploads as successes.

---

## What it does

Given a folder like this:

```
filmy/
  01_intro.mp4
  01_intro.txt          <- caption for 01_intro.mp4
  02_main_story.mp4
  02_main_story.txt
  03_outro.mp4
  03_outro.txt
```

…the tool will:

1. **Plan** a posting schedule — assign each video to the next free slot using the daily posting times you configured (e.g. `09:00, 14:00, 19:00`) in your timezone, writing everything to `schedule/plan.yaml`.
2. **Open TikTok Studio** in a persistent, headful Chromium profile using the session you created once with `npm run login`.
3. **Skip duplicates** — locally (via SHA-256 of the file) and remotely (by scraping captions already posted on your account).
4. **Upload each video**, paste the caption, flip the "Schedule" toggle, open the date/time pickers and click the correct cells, and press "Schedule".
5. **Verify** each upload actually succeeded (URL change + form reset + success toast) before recording it. Failures throw — they do **not** end up in `state/uploaded.json`.
6. **Pause** between uploads with jitter so the session looks human.

After the run, `state/uploaded.json` contains a record of every successful upload with file hash, caption hash, scheduled time, and timestamp — this is what prevents re-uploading the same video on the next run.

---

## How it works (architecture)

```
 ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐
 │  filmy/      │    │ schedule/    │    │ state/               │
 │  *.mp4+.txt  │───▶│ plan.yaml    │───▶│ uploaded.json        │
 └──────────────┘    └──────────────┘    │ user-data/ (cookies) │
   (you drop files) (npm run plan)       │ screenshots/ (debug) │
                                          └──────────────────────┘
                                                    ▲
                                             (npm run upload)
                                                    │
                                                    ▼
                                          TikTok Studio (Chromium)
```

Pipeline:

| Step           | Command            | What it does                                                                                                         |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 1. Log in      | `npm run login`    | Opens Chromium, you sign in manually, hit Enter in the terminal. Cookies persisted to `state/user-data/`. Run once.  |
| 2. Plan        | `npm run plan`     | Hashes every `filmy/*.mp4`, merges with an existing plan, assigns new clips to free slots, writes `schedule/plan.yaml`. |
| 3. Dry run     | `npm run upload:dry` | Same as upload but stops before clicking the final "Schedule" button. Good for verifying selectors without posting.  |
| 4. Upload      | `npm run upload`   | Drives Studio for each planned entry and records successes to `state/uploaded.json`.                                 |

### Key modules (`src/`)

- **`config.ts`** — reads `.env`, exposes paths and posting settings.
- **`browser.ts`** — launches `chromium.launchPersistentContext()` with `pl-PL` locale, the configured timezone, clipboard permissions, and the `AutomationControlled` blink feature disabled.
- **`login.ts`** — interactive helper; opens Studio and waits for you to press Enter in the terminal before closing (so cookies flush to disk).
- **`hash.ts`** — SHA-256 of file content and normalized strings.
- **`plan.ts`** — walks `VIDEOS_DIR`, reads sidecar `.txt` captions, merges against existing `plan.yaml`, assigns slots via `assignSlots()` and writes YAML. Warns about missing captions, content duplicates, and entries scheduled more than 10 days out.
- **`selectors.ts`** — all TikTok Studio DOM selectors, grouped by element, with fallback chains. **This is the file you'll touch when TikTok changes their UI.** `findFirst()` tries each candidate in order and returns the first that attaches.
- **`studio.ts`** — the Playwright driver: file input, caption paste, schedule radio, date picker, time picker, publish button, success detection. Every critical step is verified, and `uploadOne()` **throws** if it cannot confirm the video was actually scheduled.
- **`remote.ts`** — optional; opens Studio's "content" page and scrapes captions already on your account. Prevents re-posting if `state/uploaded.json` gets cleared or a video was posted manually.
- **`storage.ts`** — load/save `state/uploaded.json`, with legacy format migration.
- **`humanize.ts`** — small-jitter helpers (random delays, mouse wander) used throughout the upload flow so the automation doesn't look like an unrelenting robot.
- **`upload.ts`** — entry point for `npm run upload` / `upload:dry`. Loads plan, filters skippable entries, fetches remote caption hashes, loops through the rest calling `uploadOne()`.

### What gets checked before a video counts as uploaded

`studio.ts` waits for **all** of the following after clicking the schedule button:

1. URL navigates away from `/upload` (Studio redirects to the content page on success).
2. The upload form resets (the video preview disappears).
3. A success toast / text matching `/your video (has been|is being) (scheduled|posted)/i`, `/zaplanowano/i`, or `/opublikowano/i` appears.
4. A hard timeout.

If the verifier cannot confirm success, `uploadOne()` throws, a screenshot is saved to `state/screenshots/`, and nothing is written to `uploaded.json`. The next run will retry the same video.

### Safety rails

- **15-minute buffer** — videos scheduled less than 15 min from "now" are skipped. TikTok rejects schedules too close to the current time.
- **10-day limit** — TikTok Studio refuses schedules more than 10 days out. `plan.ts` warns and `upload.ts` skips these, so if you plan a large batch you simply re-run `npm run upload` every few days to top up the queue.
- **Empty captions are skipped** — if `filmy/foo.mp4` has no matching `filmy/foo.txt`, it will appear in the plan with an empty caption and be skipped by upload until you add one.
- **Local + remote dedup** — the same content won't get uploaded twice even if you rename the file or clear `state/uploaded.json`.
- **Theme-priority ordering** — `plan.ts` has a `THEME_PRIORITY` constant for pinning specific files to the front of the queue (useful when a clip is tied to a holiday date). Edit the array in `src/plan.ts` for your own events, or leave it empty for pure alphabetic ordering.

---

## Prerequisites

- **Node.js 20+** (tested on 20 and 22)
- **npm** (ships with Node)
- ~500 MB free disk for Chromium (Playwright downloads it on install)
- A working TikTok account with access to `tiktok.com/tiktokstudio`
- Windows, macOS, or Linux — Chromium is cross-platform. Paths in the docs use forward slashes; Windows users can use either.

---

## Installation

```bash
git clone https://github.com/RolePlayingTech/TikTokBatcher.git
cd TikTokBatcher
npm install
```

The `postinstall` hook runs `playwright install chromium` automatically, so a clean `npm install` is all you need. No other system dependencies.

---

## Configuration

Copy the example env file and edit it:

```bash
cp .env.example .env
```

Every variable:

| Variable                 | Default                                              | Meaning                                                                                                                       |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `VIDEOS_DIR`             | `./filmy`                                            | Folder holding your `.mp4` + `.txt` pairs. Create it and drop files in.                                                       |
| `PLAN_FILE`              | `./schedule/plan.yaml`                               | Generated plan output. Do not edit by hand while `plan.ts` is running.                                                        |
| `STATE_DIR`              | `./state`                                            | Persistent Chromium profile, uploaded log, and debug screenshots all live here. **Never commit this directory.**              |
| `STUDIO_URL`             | `https://www.tiktok.com/tiktokstudio/upload?from=creator_center` | Studio upload URL. Leave as-is unless TikTok moves the page.                                                                   |
| `MAX_UPLOADS_PER_RUN`    | `0`                                                  | Safety cap on uploads per `npm run upload` invocation. `0` = unlimited. Set to e.g. `10` if you want shorter sessions.        |
| `VIDEOS_PER_DAY`         | `3`                                                  | Informational; the real slot count is the length of `POSTING_TIMES`.                                                          |
| `POSTING_TIMES`          | `09:00,14:00,19:00`                                  | Comma-separated `HH:mm` slots in the timezone below. Each entry plans into the next free slot in this list.                   |
| `TIMEZONE`               | `Europe/Warsaw`                                      | Any IANA tz name. Used both for scheduling math **and** as the Chromium `timezoneId`, so browser and planner stay aligned.    |
| `REMOTE_DUPLICATE_CHECK` | `true`                                               | If `true`, Studio's content page is scraped at the start of each upload run to dedup against videos already posted/scheduled. |

There are no API keys or secrets anywhere in this project. Authentication is handled entirely by the browser cookies stored in `state/user-data/` after `npm run login`.

---

## Workflow — the full loop

### 1. One-time: log in

```bash
npm run login
```

A Chromium window opens on `tiktok.com/tiktokstudio/upload`. Log in with your account (including 2FA). When you see the upload page fully loaded, switch back to your terminal and **press Enter**. The browser closes and your session is saved in `state/user-data/`.

You only need to repeat this if the session expires, or if you delete `state/`.

### 2. Drop your videos

For every clip, place the video and its caption next to each other in `filmy/`:

```
filmy/
  clip_01.mp4
  clip_01.txt      <- "Your caption text with #hashtags"
  clip_02.mp4
  clip_02.txt
```

Caption requirements:

- **Same basename** as the video (`clip_01.mp4` ↔ `clip_01.txt`).
- UTF-8 plain text. Leading/trailing whitespace is trimmed.
- Hashtags go inline, as plain text (`#foo #bar`). Studio will linkify them on submission.
- Missing caption → the video is skipped at upload time with a warning, not an error. Add the `.txt` and re-run `npm run plan`.

### 3. Generate the plan

```bash
npm run plan
```

This hashes every video, picks up sidecar captions, merges with any existing `schedule/plan.yaml`, and assigns new clips to the next free posting slots starting from "now + 15 min". Newly added videos always take the **next** free slots; previously-planned-but-not-yet-uploaded entries are rescheduled after them (so a fresh batch publishes sooner, and the queue shifts back).

Open `schedule/plan.yaml` to eyeball it. Each entry looks like:

```yaml
entries:
  - videoFile: filmy/clip_01.mp4
    caption: Caption text here #tags
    scheduledFor: '2026-04-07T09:00:00+02:00'
    fileHash: 1c901b54212b0e59...
```

You can safely re-run `npm run plan` any number of times — already-uploaded entries are preserved verbatim, captions get refreshed from the sidecar `.txt` files, and only new files take fresh slots.

### 4. Dry-run first (optional but recommended)

```bash
npm run upload:dry
```

Opens Studio and walks through the upload for each entry but stops before clicking the final "Schedule" button. If this fails, the DOM selectors need updating — see Troubleshooting.

### 5. Upload for real

```bash
npm run upload
```

Watch the terminal; the tool logs each step. You can leave the Chromium window visible — it's meant to be run headful. When the run finishes, `state/uploaded.json` is updated with one record per successful upload. Videos remain in `filmy/`; they're tracked by hash, not by being moved.

Re-run later to process any entries that were still more than 10 days out the last time. Videos that are already uploaded, or that already exist on your account under the same caption, are skipped automatically.

---

## Commands reference

| Command              | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| `npm run login`      | Interactive login; saves cookies to `state/user-data/`.                            |
| `npm run plan`       | (Re)generate `schedule/plan.yaml` from the contents of `filmy/`.                   |
| `npm run upload:dry` | Drive the UI without clicking the final Schedule button. Validates selectors.      |
| `npm run upload`     | Actual uploads. Writes successes to `state/uploaded.json`.                         |
| `npm run typecheck`  | `tsc --noEmit`. Run before committing changes to `src/`.                           |

---

## File structure

```
TikTokBatcher/
├── .env.example          # Copy to .env and edit
├── .gitignore            # Excludes state/, filmy/*.mp4, .env, etc.
├── README.md             # This file
├── package.json
├── tsconfig.json
├── filmy/                # ← you drop .mp4 + .txt pairs here
│   └── .gitkeep
├── schedule/             # ← generated plan.yaml lives here
│   └── .gitkeep
├── state/                # ← cookies + upload log; never commit
│   ├── user-data/        #   Chromium profile (session cookies)
│   ├── uploaded.json     #   List of successful uploads w/ hashes
│   └── screenshots/      #   Debug screenshots (on failure)
└── src/
    ├── browser.ts        # Playwright persistent context launcher
    ├── config.ts         # .env loader + exported config object
    ├── hash.ts           # SHA-256 helpers
    ├── humanize.ts       # Jitter / pauses / mouse wander
    ├── logger.ts         # Tiny colored console logger
    ├── login.ts          # `npm run login` entry
    ├── plan.ts           # `npm run plan` entry
    ├── remote.ts         # Remote caption scraping (dedup)
    ├── selectors.ts      # TikTok Studio DOM selectors (MOST FRAGILE)
    ├── storage.ts        # uploaded.json load/save + migration
    ├── studio.ts         # Upload driver (the meat)
    ├── types.ts          # Shared TS interfaces
    └── upload.ts         # `npm run upload` entry
```

---

## Troubleshooting

### "No selector matched. Tried: …"

TikTok changed their UI. Open Studio in a normal browser, inspect the element that failed, and add a new candidate to the relevant array in `src/selectors.ts`. Keep language-agnostic / `data-*` attribute selectors at the top of the list and text-based ones at the bottom — they're the most likely to break on copy changes.

The tool also saves a screenshot to `state/screenshots/` on every failure; that's usually enough to tell which step broke.

### Uploads succeed but `uploaded.json` is not updated

If the success verifier can't confirm the post went through (URL didn't change, form didn't reset, no success toast within the timeout), `uploadOne()` throws on purpose. Check the screenshot saved to `state/screenshots/` — usually it's either a modal ("Kontynuować publikowanie?") or a toast in a language variant that isn't in `selectors.successIndicator`. Add the missing regex / button text.

### "Scheduled beyond 10 days out"

TikTok refuses schedules more than 10 days in the future. The planner will warn; the uploader will skip the entry. Solution: let the current batch run, wait a few days, and re-run `npm run upload` — videos in the queue will catch up naturally.

### The schedule ends up in the wrong timezone

`TIMEZONE` is used both by the planner (via `dayjs.tz`) and by Playwright's `timezoneId`. If they disagree you'll see times land an hour off. Make sure `.env`'s `TIMEZONE` is an IANA name (`Europe/Warsaw`, not `CEST`) and that your system clock isn't also skewed.

### Login keeps logging out

`state/user-data/` must be writable and must not be cleared between runs. Check that it's in `.gitignore` and that nothing in your OS is auto-cleaning the folder. If you deliberately wiped state, run `npm run login` again.

### Caption pastes as literal `Ctrl+V`

The clipboard permission grant in `browser.ts` sometimes fails on fresh profiles. The paste helper has fallbacks, but if you see captions coming out as keystrokes, run `npm run login` once to warm the profile, then retry the upload.

### Videos are being uploaded in the "wrong" order

Plan ordering is: (1) any files listed in `THEME_PRIORITY` inside `src/plan.ts`, then (2) the rest sorted by natural alphabetic order of the filename. Rename files with numeric prefixes (`01_`, `02_`, …) to control the queue, or edit `THEME_PRIORITY`.

---

## Security and privacy notes

- **No credentials are stored in files tracked by git.** Authentication is handled entirely by browser cookies in `state/user-data/`.
- **`state/` is gitignored** — do not commit it. It contains your logged-in TikTok session.
- **`.env` is gitignored** — there are no secrets in the default config, but keep the habit if you add any.
- **This tool does not interact with TikTok's official API.** It drives the Studio web UI the same way a human would, using your logged-in browser. Use at your own discretion and within TikTok's ToS — automation of any kind may put your account at risk if used excessively or in ways that look inorganic. Conservative defaults (`MAX_UPLOADS_PER_RUN`, long pauses between posts, human jitter) are there for a reason; leave them on.

---

## Development

```bash
npm run typecheck    # must pass before commits
```

The codebase is plain ES-modules TypeScript, run directly with [`tsx`](https://github.com/privatenumber/tsx) — no build step, no bundler. Everything under `src/` is loaded as `.ts` at runtime.

Pull requests that update `src/selectors.ts` to cover new TikTok UI revisions are especially welcome.

---

## License

No license file is included. If you intend to redistribute this, add one that fits your use case.
