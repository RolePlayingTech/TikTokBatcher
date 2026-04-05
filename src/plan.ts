import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { config } from './config.js';
import { log } from './logger.js';
import { hashFile } from './hash.js';
import { loadUploadedLog, uploadedHashes } from './storage.js';
import type { Plan, PlanEntry } from './types.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv']);

interface VideoInfo {
  filename: string; // basename, e.g. "01.mp4"
  absPath: string;
  relPath: string; // relative to project root, forward slashes
  caption: string; // from sidecar .txt or empty
  fileHash: string;
}

function listVideoFilenames(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    log.err(`Videos directory not found: ${dir}`);
    log.info(`Create it and drop your video files in, then re-run.`);
    process.exit(1);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
}

/** Read the sidecar .txt file for a video, or '' if absent. */
function readSidecarCaption(videoAbsPath: string): string {
  const txtPath = videoAbsPath.replace(/\.[^.]+$/, '.txt');
  if (!fs.existsSync(txtPath)) return '';
  try {
    return fs.readFileSync(txtPath, 'utf8').trim();
  } catch {
    return '';
  }
}

async function gatherVideoInfo(filenames: string[]): Promise<VideoInfo[]> {
  const infos: VideoInfo[] = [];
  for (const name of filenames) {
    const absPath = path.join(config.videosDir, name);
    const relPath = path
      .relative(config.root, absPath)
      .replace(/\\/g, '/');
    log.dim(`hashing ${name}...`);
    const fileHash = await hashFile(absPath);
    const caption = readSidecarCaption(absPath);
    infos.push({ filename: name, absPath, relPath, caption, fileHash });
  }
  return infos;
}

/**
 * Explicit priority ordering for the Wielkanoc / Lany Poniedziałek weekend
 * (2026-04-05 / 2026-04-06), as directed by the user. With the Sunday 09:00
 * slot unreachable (current time is past the 15-min buffer), the sequence
 * fills:
 *
 *   Sun 14:00 — wielkanoc_reel   (główna historia Wielkanocy)
 *   Sun 19:00 — moai_reel        (Wyspa Wielkanocna — odkryta w Niedzielę Wielkanocną)
 *   Mon 09:00 — smigus_reel      (Śmigus-Dyngus flagship)
 *   Mon 14:00 — wodne_reel       (wodne tradycje świata — Lany Pon adjacent)
 *   Mon 19:00 — kakure_reel      (ukryci chrześcijanie świętujący Wielkanoc)
 *   Tue 09:00 — easter1916_reel  (Powstanie Wielkanocne — orphan Easter)
 *
 * Videos not listed fall through to alphabetic-natural ordering.
 */
const THEME_PRIORITY: readonly string[] = [
  'wielkanoc_reel.mp4',
  'moai_reel.mp4',
  'smigus_reel.mp4',
  'wodne_reel.mp4',
  'kakure_reel.mp4',
  'easter1916_reel.mp4',
];

function applyThemeOrdering(videos: VideoInfo[]): VideoInfo[] {
  const byName = new Map(videos.map((v) => [v.filename, v]));
  const priority: VideoInfo[] = [];
  for (const name of THEME_PRIORITY) {
    const v = byName.get(name);
    if (v) {
      priority.push(v);
      byName.delete(name);
    }
  }
  const rest = [...byName.values()].sort((a, b) =>
    a.filename.localeCompare(b.filename, 'en', {
      numeric: true,
      sensitivity: 'base',
    })
  );

  if (priority.length > 0) {
    log.info(`theme priority: ${priority.length} video(s) go first`);
    priority.forEach((v, i) => log.dim(`  #${i + 1} ${v.filename}`));
  }

  return [...priority, ...rest];
}

function loadExistingPlan(): Plan | null {
  if (!fs.existsSync(config.planFile)) return null;
  const raw = fs.readFileSync(config.planFile, 'utf8');
  const parsed = yaml.load(raw) as Plan | null;
  if (!parsed || !Array.isArray(parsed.entries)) return null;
  return parsed;
}

/**
 * Assign each new video to the next free posting slot, starting from
 * `startFrom` + 15 min safety buffer. Slots are defined by
 * config.postingTimes in config.timezone.
 */
function assignSlots(videos: VideoInfo[], startFrom: dayjs.Dayjs): PlanEntry[] {
  const entries: PlanEntry[] = [];
  const times = config.postingTimes;
  if (times.length === 0) {
    throw new Error('POSTING_TIMES is empty — check your .env');
  }

  const baseDay = startFrom.tz(config.timezone).startOf('day');
  let dayOffset = 0;
  let slotInDay = 0;

  for (const v of videos) {
    let candidate: dayjs.Dayjs;
    while (true) {
      const day = baseDay.add(dayOffset, 'day');
      const [hStr, mStr] = times[slotInDay].split(':');
      const h = parseInt(hStr, 10);
      const m = parseInt(mStr, 10);
      candidate = day.hour(h).minute(m).second(0).millisecond(0);

      if (candidate.isAfter(startFrom.add(15, 'minute'))) break;
      slotInDay++;
      if (slotInDay >= times.length) {
        slotInDay = 0;
        dayOffset++;
      }
    }

    entries.push({
      videoFile: v.relPath,
      caption: v.caption,
      scheduledFor: candidate.format(),
      fileHash: v.fileHash,
    });

    slotInDay++;
    if (slotInDay >= times.length) {
      slotInDay = 0;
      dayOffset++;
    }
  }

  return entries;
}

async function main(): Promise<void> {
  const filenames = listVideoFilenames(config.videosDir);
  log.info(`Found ${filenames.length} video file(s) in ${config.videosDir}`);

  if (filenames.length === 0) {
    log.warn('Nothing to plan. Drop .mp4 files (with matching .txt captions) into the folder.');
    return;
  }

  const infos = await gatherVideoInfo(filenames);

  // Warn about missing captions
  const missingCaptions = infos.filter((i) => !i.caption);
  if (missingCaptions.length > 0) {
    log.warn(`${missingCaptions.length} video(s) have no sidecar .txt caption:`);
    for (const i of missingCaptions) log.dim(`- ${i.filename}`);
    log.warn('Entries with empty captions will be skipped by upload.');
  }

  // Warn about duplicate content within filmy/
  const seenInFolder = new Map<string, string>(); // hash -> first filename
  const dupesInFolder: VideoInfo[] = [];
  const uniqueInfos: VideoInfo[] = [];
  for (const i of infos) {
    const prev = seenInFolder.get(i.fileHash);
    if (prev) {
      dupesInFolder.push(i);
      log.warn(`duplicate content: ${i.filename} = ${prev} (same hash) — skipping ${i.filename}`);
    } else {
      seenInFolder.set(i.fileHash, i.filename);
      uniqueInfos.push(i);
    }
  }

  const existing = loadExistingPlan();
  const existingHashes = new Set(
    (existing?.entries ?? [])
      .map((e) => e.fileHash)
      .filter((h): h is string => !!h)
  );
  const existingPaths = new Set(
    (existing?.entries ?? []).map((e) => path.basename(e.videoFile))
  );

  const alreadyUploaded = uploadedHashes(loadUploadedLog());

  // Partition: need to plan vs. already planned vs. already uploaded
  const toPlan: VideoInfo[] = [];
  for (const i of uniqueInfos) {
    if (alreadyUploaded.has(i.fileHash)) {
      log.warn(`skip ${i.filename}: already uploaded to TikTok earlier (hash match)`);
      continue;
    }
    if (existingHashes.has(i.fileHash) || existingPaths.has(i.filename)) {
      // Already in plan — update caption from .txt in case user edited it
      if (existing) {
        const match = existing.entries.find(
          (e) =>
            (e.fileHash && e.fileHash === i.fileHash) ||
            path.basename(e.videoFile) === i.filename
        );
        if (match && i.caption && match.caption !== i.caption) {
          match.caption = i.caption;
          if (!match.fileHash) match.fileHash = i.fileHash;
          log.info(`updated caption for ${i.filename} from sidecar .txt`);
        }
      }
      continue;
    }
    toPlan.push(i);
  }

  if (toPlan.length === 0 && dupesInFolder.length === 0) {
    // Still write back existing plan in case captions were refreshed
    if (existing) {
      fs.mkdirSync(path.dirname(config.planFile), { recursive: true });
      fs.writeFileSync(config.planFile, yaml.dump(existing, { lineWidth: 0 }), 'utf8');
    }
    log.ok('Plan is up to date. Nothing new to schedule.');
    return;
  }

  // Theme ordering: Wielkanoc / Lany Poniedziałek first (so they match the
  // 2026-04-05/06 slots), rest by filename. Applied BEFORE slot assignment.
  const orderedToPlan = applyThemeOrdering(toPlan);

  log.info(`${orderedToPlan.length} new video(s) to schedule`);

  // Start from now + safety buffer. New videos take the next free slots.
  // If there's an existing plan, previously-scheduled-but-not-yet-uploaded
  // videos are RESCHEDULED after the new batch — this implements the
  // "new videos publish next" behavior.
  const startFrom = dayjs().tz(config.timezone);

  // Rebuild schedule for: new videos first, then any previously planned
  // videos that haven't been uploaded yet (preserving their relative order).
  const alreadyUploadedPaths = new Set(
    loadUploadedLog().records.map((r) => path.basename(r.videoFile))
  );
  const carryOver: VideoInfo[] = [];
  if (existing) {
    for (const e of existing.entries) {
      const base = path.basename(e.videoFile);
      if (alreadyUploadedPaths.has(base)) continue; // locked — already live
      // Re-materialize as VideoInfo from the entry so we can reuse assignSlots
      const absPath = path.isAbsolute(e.videoFile)
        ? e.videoFile
        : path.resolve(config.root, e.videoFile);
      if (!fs.existsSync(absPath)) continue;
      carryOver.push({
        filename: base,
        absPath,
        relPath: e.videoFile,
        caption: e.caption,
        fileHash: e.fileHash ?? '',
      });
    }
  }

  // Dedupe carryOver against new (by filename), so a file that's in both
  // only appears once (as a "new" entry).
  const newNames = new Set(orderedToPlan.map((v) => v.filename));
  const carryFiltered = carryOver.filter((v) => !newNames.has(v.filename));

  const fullOrder = [...orderedToPlan, ...carryFiltered];
  const newEntries = assignSlots(fullOrder, startFrom);

  // Preserve uploaded entries verbatim at the front of the plan.
  const uploadedEntries = (existing?.entries ?? []).filter((e) =>
    alreadyUploadedPaths.has(path.basename(e.videoFile))
  );
  const plan: Plan = {
    entries: [...uploadedEntries, ...newEntries],
  };

  const tenDaysOut = dayjs().add(10, 'day');
  const beyondLimit = plan.entries.filter((e) =>
    dayjs(e.scheduledFor).isAfter(tenDaysOut)
  );
  if (beyondLimit.length > 0) {
    log.warn(
      `${beyondLimit.length} entries scheduled more than 10 days out. ` +
        `TikTok's scheduler will refuse those — run upload now for what fits, ` +
        `then re-run in a few days to top up the queue.`
    );
  }

  fs.mkdirSync(path.dirname(config.planFile), { recursive: true });
  fs.writeFileSync(config.planFile, yaml.dump(plan, { lineWidth: 0 }), 'utf8');
  log.ok(`Plan written: ${config.planFile}`);
  log.info(`Total entries: ${plan.entries.length} (new: ${newEntries.length})`);
  log.info('Next: npm run upload:dry   (test run)  /  npm run upload   (real)');
}

main().catch((e) => {
  log.err(String(e));
  process.exit(1);
});
