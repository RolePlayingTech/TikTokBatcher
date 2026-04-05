export interface PlanEntry {
  /** Path to the video file, relative to project root or absolute */
  videoFile: string;
  /** Caption / description to type into Studio (supports #hashtags as plain text) */
  caption: string;
  /** ISO 8601 datetime with timezone offset, e.g. 2026-04-05T09:00:00+02:00 */
  scheduledFor: string;
  /** SHA-256 of the video file at plan time. Used for duplicate detection. */
  fileHash?: string;
}

export interface Plan {
  entries: PlanEntry[];
}

export interface UploadedRecord {
  /** videoFile path as stored in plan.yaml */
  videoFile: string;
  /** SHA-256 of the uploaded video file content */
  fileHash: string;
  /** SHA-256 of the normalized caption, secondary cross-check */
  captionHash: string;
  /** The scheduledFor value from the plan */
  scheduledFor: string;
  /** When this upload was recorded by the script (ISO 8601) */
  uploadedAt: string;
}

export interface UploadedLog {
  records: UploadedRecord[];
}
