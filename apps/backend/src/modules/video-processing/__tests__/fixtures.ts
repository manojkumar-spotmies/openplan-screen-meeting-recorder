import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { spawnSync } from 'child_process';

/**
 * Generates one small, genuinely valid vp8/opus WebM file via ffmpeg — enough to exercise
 * the real ffmpeg-runner.ts against real media for a single-chunk session (see video.test.ts
 * for why single-chunk sidesteps the still-open multi-fragment reassembly question, which
 * only the real F-001-recorded-chunk spike can answer).
 */
export function generateValidWebm(durationSeconds = 1): Buffer {
  const tmpPath = path.join(os.tmpdir(), `openplan-fixture-${crypto.randomUUID()}.webm`);
  const result = spawnSync('ffmpeg', [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc=duration=${durationSeconds}:size=64x64:rate=5`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:duration=${durationSeconds}`,
    '-c:v',
    'libvpx',
    '-c:a',
    'libopus',
    '-f',
    'webm',
    tmpPath,
  ]);

  if (result.status !== 0) {
    throw new Error(`ffmpeg fixture generation failed: ${result.stderr?.toString().slice(-1000)}`);
  }

  const buffer = fs.readFileSync(tmpPath);
  fs.rmSync(tmpPath, { force: true });
  return buffer;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}
