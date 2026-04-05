import fs from 'node:fs';
import path from 'node:path';
import { config, stateFiles } from './config.js';
import type { UploadedLog, UploadedRecord } from './types.js';

interface LegacyUploadedLog {
  done?: string[];
  records?: UploadedRecord[];
}

/**
 * Load the uploaded-videos log. Accepts both the new `records` format and
 * the legacy `{done: string[]}` format, migrating the latter in-memory so
 * the rest of the code only deals with records.
 */
export function loadUploadedLog(): UploadedLog {
  if (!fs.existsSync(stateFiles.uploadedLog)) return { records: [] };
  try {
    const raw = JSON.parse(
      fs.readFileSync(stateFiles.uploadedLog, 'utf8')
    ) as LegacyUploadedLog;
    if (Array.isArray(raw.records)) return { records: raw.records };
    if (Array.isArray(raw.done)) {
      // Legacy: we didn't store hashes, just paths. Convert to records
      // with empty hashes — they still work as path-based dedup.
      return {
        records: raw.done.map((p) => ({
          videoFile: p,
          fileHash: '',
          captionHash: '',
          scheduledFor: '',
          uploadedAt: '',
        })),
      };
    }
    return { records: [] };
  } catch {
    return { records: [] };
  }
}

export function saveUploadedLog(log: UploadedLog): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(
    stateFiles.uploadedLog,
    JSON.stringify(log, null, 2),
    'utf8'
  );
}

/** Build a Set of file hashes from the uploaded log for fast lookup. */
export function uploadedHashes(log: UploadedLog): Set<string> {
  return new Set(log.records.map((r) => r.fileHash).filter((h): h is string => !!h));
}

/** Build a Set of videoFile paths (as stored) for fast lookup. */
export function uploadedPaths(log: UploadedLog): Set<string> {
  return new Set(log.records.map((r) => r.videoFile));
}

/**
 * Resolve a plan entry's videoFile to an absolute path. Handles both
 * absolute and project-relative paths.
 */
export function resolveVideoPath(videoFile: string): string {
  return path.isAbsolute(videoFile)
    ? videoFile
    : path.resolve(config.root, videoFile);
}
