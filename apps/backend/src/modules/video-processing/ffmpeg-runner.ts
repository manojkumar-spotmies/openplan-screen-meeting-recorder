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

/**
 * Combines this session's sequential WebM chunks into one playable file.
 *
 * STRATEGY (pending confirmation against real F-001 chunks — see the architecture
 * review's FFmpeg spike): Chrome's MediaRecorder, run with a fixed timeslice, emits
 * `ondataavailable` blobs that are fragments of ONE continuous muxed WebM stream, not
 * independent files — only the first fragment carries the EBML/Segment header. This is
 * corroborated by the existing `LocalInspector.tsx` preview, which already reconstructs
 * a playable video by raw-concatenating chunk blobs. On that basis, the strategy here is
 * raw byte concatenation followed by one `ffmpeg -c copy` remux pass to repair
 * container-level metadata a piecewise-recorded stream typically lacks (Cues/SeekHead
 * index, resolved Duration). If the real-chunk spike disproves this, swap the body of
 * this function for the concat-demuxer approach instead — callers are unaffected either
 * way since the public contract is just "chunk paths in order -> one verified file".
 */
export async function combineChunks(chunkPaths: string[], scratchDir: string): Promise<FfmpegRunResult> {
  if (chunkPaths.length === 0) {
    throw new Error('combineChunks called with zero chunk paths');
  }

  const rawPath = path.join(scratchDir, 'raw.webm');
  const outputPath = path.join(scratchDir, 'output.webm');

  await concatenateRaw(chunkPaths, rawPath);

  await runProcess('ffmpeg', ['-y', '-i', rawPath, '-c', 'copy', outputPath]);

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
    throw new Error(`ffprobe reported an invalid duration (${durationSeconds}) for the combined output`);
  }

  const stats = await fs.promises.stat(outputPath);
  if (stats.size === 0) {
    throw new Error('Combined output file is empty');
  }

  await fs.promises.rm(rawPath, { force: true });

  return {
    outputPath,
    durationMs: Math.round(durationSeconds * 1000),
    sizeBytes: stats.size,
  };
}
