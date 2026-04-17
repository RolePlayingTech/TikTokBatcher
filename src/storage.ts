import fs from 'node:fs';
import path from 'node:path';
import { config, stateFiles } from './config.js';
import type { UploadedLog, UploadedRecord } from './types.js';

export function loadUploadedLog(): UploadedLog {
  let raw: { records?: UploadedRecord[] };
  try {
    raw = JSON.parse(fs.readFileSync(stateFiles.uploadedLog, 'utf8'));
  } catch {
    return { records: [] };
  }
  return { records: Array.isArray(raw.records) ? raw.records : [] };
}

export function saveUploadedLog(log: UploadedLog): void {
  fs.mkdirSync(config.stateDir, { recursive: true });
  fs.writeFileSync(
    stateFiles.uploadedLog,
    JSON.stringify(log, null, 2),
    'utf8'
  );
}

export function uploadedHashes(log: UploadedLog): Set<string> {
  return new Set(log.records.map((r) => r.fileHash).filter((h): h is string => !!h));
}

export function resolveVideoPath(videoFile: string): string {
  return path.isAbsolute(videoFile)
    ? videoFile
    : path.resolve(config.root, videoFile);
}
