import fs from 'node:fs';
import yaml from 'js-yaml';
import dayjs from 'dayjs';
import { launchContext } from './browser.js';
import { config } from './config.js';
import { log } from './logger.js';
import { openStudio, uploadOne, screenshot } from './studio.js';
import { longPause } from './humanize.js';
import { hashFile, hashString } from './hash.js';
import { fetchRemoteCaptionHashes } from './remote.js';
import {
  loadUploadedLog,
  saveUploadedLog,
  uploadedHashes,
  resolveVideoPath,
} from './storage.js';
import type { Plan, PlanEntry, UploadedRecord } from './types.js';

function loadPlan(): Plan {
  if (!fs.existsSync(config.planFile)) {
    log.err(`Plan file not found: ${config.planFile}`);
    log.info('Run: npm run plan');
    process.exit(1);
  }
  const parsed = yaml.load(fs.readFileSync(config.planFile, 'utf8')) as Plan | null;
  if (!parsed || !Array.isArray(parsed.entries)) {
    log.err('Plan file is malformed.');
    process.exit(1);
  }
  return parsed;
}

interface PendingEntry {
  entry: PlanEntry;
  fileHash: string;
}

async function buildPending(
  plan: Plan,
  alreadyUploaded: Set<string>
): Promise<PendingEntry[]> {
  const now = dayjs();
  const tenDaysOut = now.add(10, 'day');
  const minScheduleTime = now.add(15, 'minute');
  const pending: PendingEntry[] = [];

  for (const entry of plan.entries) {
    if (!entry.caption.trim()) {
      log.warn(`skip ${entry.videoFile}: empty caption (add a sidecar .txt and re-run plan)`);
      continue;
    }
    const absPath = resolveVideoPath(entry.videoFile);
    if (!fs.existsSync(absPath)) {
      log.warn(`skip ${entry.videoFile}: file missing on disk`);
      continue;
    }
    const when = dayjs(entry.scheduledFor);
    if (when.isAfter(tenDaysOut)) {
      log.warn(`skip ${entry.videoFile}: scheduled beyond 10 days out (re-run later)`);
      continue;
    }
    if (when.isBefore(minScheduleTime)) {
      log.warn(`skip ${entry.videoFile}: scheduled < 15 min from now`);
      continue;
    }

    // Hash-based duplicate check. Use the hash from the plan if present,
    // otherwise recompute from the file on disk.
    const fileHash = entry.fileHash || (await hashFile(absPath));
    if (alreadyUploaded.has(fileHash)) {
      log.warn(`skip ${entry.videoFile}: already uploaded (hash match)`);
      continue;
    }

    pending.push({ entry, fileHash });
  }

  return pending;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const maxPerRun =
    config.maxUploadsPerRun > 0 ? config.maxUploadsPerRun : Number.POSITIVE_INFINITY;

  if (dryRun) log.warn('Dry run mode — no videos will actually be posted');

  const plan = loadPlan();
  const uploadedLog = loadUploadedLog();
  const alreadyUploaded = uploadedHashes(uploadedLog);

  log.info(`Checking ${plan.entries.length} plan entries against ${uploadedLog.records.length} previously uploaded record(s)...`);
  const pending = await buildPending(plan, alreadyUploaded);

  if (pending.length === 0) {
    log.ok('Nothing to upload.');
    return;
  }

  log.info(
    `${pending.length} video(s) ready — max this run: ${
      maxPerRun === Number.POSITIVE_INFINITY ? 'unlimited' : maxPerRun
    }`
  );

  const context = await launchContext({ headless: false });

  // Remote duplicate check: scrape Studio's content page for captions of
  // already-posted / scheduled videos and skip plan entries that match.
  let remoteCaptionHashes = new Set<string>();
  if (config.remoteDuplicateCheck) {
    remoteCaptionHashes = await fetchRemoteCaptionHashes(context);
  } else {
    log.dim('remote duplicate check disabled (REMOTE_DUPLICATE_CHECK=false)');
  }

  const filteredPending = pending.filter(({ entry }) => {
    if (remoteCaptionHashes.size === 0) return true;
    const ch = hashString(entry.caption);
    if (remoteCaptionHashes.has(ch)) {
      log.warn(`skip ${entry.videoFile}: caption already posted on TikTok`);
      return false;
    }
    return true;
  });

  if (filteredPending.length === 0) {
    log.ok('All pending videos already exist on TikTok — nothing to upload.');
    await context.close();
    return;
  }
  if (filteredPending.length !== pending.length) {
    log.info(
      `After remote check: ${filteredPending.length} video(s) remaining (was ${pending.length})`
    );
  }

  const page = await openStudio(context);

  let successes = 0;
  let failures = 0;

  for (let i = 0; i < filteredPending.length; i++) {
    if (successes >= maxPerRun) {
      log.info(`hit max uploads per run (${maxPerRun}), stopping`);
      break;
    }

    const { entry, fileHash } = filteredPending[i];

    // Re-check against in-memory set in case two plan entries happen to
    // point at the same hashed content.
    if (alreadyUploaded.has(fileHash)) {
      log.warn(`skip ${entry.videoFile}: duplicate content already uploaded in this run`);
      continue;
    }

    try {
      await uploadOne(page, entry, { dryRun });
      if (!dryRun) {
        const record: UploadedRecord = {
          videoFile: entry.videoFile,
          fileHash,
          captionHash: hashString(entry.caption),
          scheduledFor: entry.scheduledFor,
          uploadedAt: new Date().toISOString(),
        };
        uploadedLog.records.push(record);
        saveUploadedLog(uploadedLog);
        alreadyUploaded.add(fileHash);
      }
      successes++;
    } catch (e) {
      failures++;
      log.err(`failed on ${entry.videoFile}: ${(e as Error).message}`);
      await screenshot(page, 'error').catch(() => {});
      // continue to next entry
    }

    const isLast = i === filteredPending.length - 1;
    if (!isLast && successes < maxPerRun) {
      log.dim('pausing before next upload...');
      await longPause();
    }
  }

  log.ok(`Run complete. Success: ${successes}, Failures: ${failures}`);
  await context.close();
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  log.err(String(e));
  process.exit(1);
});
