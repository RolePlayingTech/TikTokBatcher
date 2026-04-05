import 'dotenv/config';
import path from 'node:path';

const root = process.cwd();

function env(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? fallback : v;
}

export const config = {
  root,
  videosDir: path.resolve(root, env('VIDEOS_DIR', './filmy')),
  planFile: path.resolve(root, env('PLAN_FILE', './schedule/plan.yaml')),
  stateDir: path.resolve(root, env('STATE_DIR', './state')),
  studioUrl: env(
    'STUDIO_URL',
    'https://www.tiktok.com/tiktokstudio/upload?from=creator_center'
  ),
  maxUploadsPerRun: parseInt(env('MAX_UPLOADS_PER_RUN', '0'), 10),
  videosPerDay: parseInt(env('VIDEOS_PER_DAY', '3'), 10),
  postingTimes: env('POSTING_TIMES', '09:00,14:00,19:00')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  timezone: env('TIMEZONE', 'Europe/Warsaw'),
  remoteDuplicateCheck:
    env('REMOTE_DUPLICATE_CHECK', 'true').toLowerCase() === 'true',
};

export const stateFiles = {
  userDataDir: path.resolve(config.stateDir, 'user-data'),
  uploadedLog: path.resolve(config.stateDir, 'uploaded.json'),
  screenshotsDir: path.resolve(config.stateDir, 'screenshots'),
};
