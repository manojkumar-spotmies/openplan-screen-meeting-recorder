import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';

export interface FfmpegRunResult {
  outputPath: string;
  durationMs: number;
  sizeBytes: number;
}

function runProcess(command: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));

    child.on('error', (err) => reject(new Error(`Failed to start ${command}: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr.slice(-2000)}`));
      }
    });
  });
}

async function concatenateRaw(chunkPaths: string[], outPath: string): Promise<void> {
  const writeStream = fs.createWriteStream(outPath);
  try {
    for (const chunkPath of chunkPaths) {
      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(chunkPath);
        readStream.on('error', reject);
        readStream.pipe(writeStream, { end: false });
        readStream.on('end', resolve);
      });
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      writeStream.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
    });
  }
}

/** Runs `ffmpeg -c copy` on `inputPath` into `scratchDir/output.webm`, then verifies the result with ffprobe. */
async function remuxAndValidate(inputPath: string, scratchDir: string): Promise<FfmpegRunResult> {
  const outputPath = path.join(scratchDir, 'output.webm');

  await runProcess('ffmpeg', ['-y', '-i', inputPath, '-c', 'copy', outputPath]);

  const probeOutput = await runProcess('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-print_format',
    'json',
    outputPath,
  ]);

  let durationSeconds = 0;
  try {
    const parsed = JSON.parse(probeOutput);
    durationSeconds = parseFloat(parsed?.format?.duration ?? '0');
  } catch {
    throw new Error(`ffprobe returned unparseable output: ${probeOutput.slice(0, 500)}`);
  }

  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error(`ffprobe reported an invalid duration (${durationSeconds}) for the output`);
  }

  const stats = await fs.promises.stat(outputPath);
  if (stats.size === 0) {
    throw new Error('Remuxed output file is empty');
  }

  return {
    outputPath,
    durationMs: Math.round(durationSeconds * 1000),
    sizeBytes: stats.size,
  };
}

/**
 * Combines this session's sequential WebM chunks into one playable file.
 *
 * STRATEGY (confirmed against real F-001 chunks — see the architecture review's FFmpeg
 * spike): Chrome's MediaRecorder, run with a fixed timeslice, emits `ondataavailable`
 * blobs that are fragments of ONE continuous muxed WebM stream, not independent files —
 * only the first fragment carries the EBML/Segment header. Verified directly against a
 * real 7-chunk, 34.47s recording: chunks 2-7 each fail `ffprobe`/`ffmpeg` on their own
 * ("EBML header parsing failed" — proof they are headerless continuations, not standalone
 * files, so the concat demuxer would not have worked here), while raw concatenation +
 * one `ffmpeg -c copy` remux pass produced a file that decodes cleanly start-to-end
 * (`ffmpeg -f null -`, exit 0) with `probe_score=100` and correct duration. The remux
 * pass repairs container-level metadata a piecewise-recorded stream lacks (Cues/SeekHead
 * index, resolved Duration) — byte-for-byte the output is the concatenated stream data
 * plus ~450 bytes of added index/duration metadata, confirming `-c copy` never re-encodes.
 */
export async function combineChunks(chunkPaths: string[], scratchDir: string): Promise<FfmpegRunResult> {
  if (chunkPaths.length === 0) {
    throw new Error('combineChunks called with zero chunk paths');
  }

  const rawPath = path.join(scratchDir, 'raw.webm');
  await concatenateRaw(chunkPaths, rawPath);

  const result = await remuxAndValidate(rawPath, scratchDir);

  await fs.promises.rm(rawPath, { force: true });

  return result;
}

/**
 * Finalizes an already-incrementally-assembled WebM (see VideoAssembler) with a single
 * `ffmpeg -c copy` remux pass — no re-concatenation, no re-encoding. Used by the
 * incremental assembly pipeline instead of `combineChunks`, since the chunk bytes are
 * already joined in `assembledPath`.
 */
export async function finalizeAssembled(assembledPath: string, scratchDir: string): Promise<FfmpegRunResult> {
  const stats = await fs.promises.stat(assembledPath).catch(() => null);
  if (!stats || stats.size === 0) {
    throw new Error(`finalizeAssembled called with missing/empty assembled file: ${assembledPath}`);
  }

  return remuxAndValidate(assembledPath, scratchDir);
}
