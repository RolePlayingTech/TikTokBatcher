import crypto from 'node:crypto';
import fs from 'node:fs';

/**
 * Compute SHA-256 of a file's full contents, streamed so we don't load
 * large videos fully into memory. Returns lowercase hex.
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Stable hash of a user-provided string (caption, etc.). Trim + NFC normalize
 * so whitespace and unicode form differences don't cause false mismatches.
 */
export function hashString(s: string): string {
  return crypto
    .createHash('sha256')
    .update(s.trim().normalize('NFC'))
    .digest('hex');
}
