import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import crypto from 'crypto';
import { LocalStorageAdapter } from '../../../core/storage/local-storage.adapter.js';
import { VideoAssembler } from '../video-assembler.js';
import { finalizeAssembled } from '../ffmpeg-runner.js';
import { generateValidWebm } from './fixtures.js';

const storage = new LocalStorageAdapter();
const createdSessionIds: string[] = [];

function newSessionId(): string {
  const id = crypto.randomUUID();
  createdSessionIds.push(id);
  return id;
}

async function putChunk(sessionId: string, seq: number, content: string): Promise<Buffer> {
  const buf = Buffer.from(content);
  await storage.putChunk(sessionId, seq, buf);
  return buf;
}

async function readAssembled(assembler: VideoAssembler, sessionId: string): Promise<Buffer> {
  const p = await assembler.getAssembledPath(sessionId);
  return fs.promises.readFile(p);
}

describe('VideoAssembler', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const id of createdSessionIds) {
      await storage.deleteSession(id).catch(() => {});
    }
    createdSessionIds.length = 0;
  });

  it('1. sequential chunks 1->2->3->4 are each appended exactly once, in order', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    const bufs = [1, 2, 3, 4].map((n) => Buffer.from(`chunk-${n}`));

    for (let i = 0; i < 4; i++) {
      await storage.putChunk(sessionId, i + 1, bufs[i]);
      const outcome = await assembler.onChunkPersisted(sessionId, i + 1);
      expect(outcome.status).toBe('appended');
    }

    expect(await assembler.getLastAppendedSequence(sessionId)).toBe(4);
    const assembled = await readAssembled(assembler, sessionId);
    expect(assembled).toEqual(Buffer.concat(bufs));
  });

  it('2. out-of-order 1->3->2: 1 appends, 3 holds, 2 appends then 3 auto-folds', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    // Chunk 2's bytes are only written to disk when it "arrives" below — writing it
    // upfront would let chunk 1's fold discover it early and defeat the out-of-order case.
    const b1 = await putChunk(sessionId, 1, 'one');
    const b3 = await putChunk(sessionId, 3, 'three');

    const r1 = await assembler.onChunkPersisted(sessionId, 1);
    expect(r1.status).toBe('appended');

    const r3 = await assembler.onChunkPersisted(sessionId, 3);
    expect(r3).toEqual({ status: 'waiting', sequenceNumber: 3, nextRequired: 2 });
    // held, not appended — chunk 3's file must still be on disk
    expect(await storage.chunkExists(storage.getChunkStorageKey(sessionId, 3))).toBe(true);

    const b2 = await putChunk(sessionId, 2, 'two');
    const r2 = await assembler.onChunkPersisted(sessionId, 2);
    expect(r2.status).toBe('appended');

    // chunk 3 should have been auto-discovered and folded immediately after 2
    expect(await assembler.getLastAppendedSequence(sessionId)).toBe(3);
    const assembled = await readAssembled(assembler, sessionId);
    expect(assembled).toEqual(Buffer.concat([b1, b2, b3]));
  });

  it('3. duplicate 1->1->2: 1 appended once, duplicate skipped, 2 appended', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    const b1 = await putChunk(sessionId, 1, 'one');

    const r1 = await assembler.onChunkPersisted(sessionId, 1);
    expect(r1.status).toBe('appended');

    // Simulate a duplicate re-delivery of chunk 1 (bytes already folded, file gone).
    const rDup = await assembler.onChunkPersisted(sessionId, 1);
    expect(rDup).toEqual({ status: 'duplicate-skipped', sequenceNumber: 1 });

    const b2 = await putChunk(sessionId, 2, 'two');
    const r2 = await assembler.onChunkPersisted(sessionId, 2);
    expect(r2.status).toBe('appended');

    const assembled = await readAssembled(assembler, sessionId);
    expect(assembled).toEqual(Buffer.concat([b1, b2]));
  });

  it('4. missing chunk 1->3: chunk 3 remains stored, assembled contains only 1', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    const b1 = await putChunk(sessionId, 1, 'one');
    await putChunk(sessionId, 3, 'three');

    await assembler.onChunkPersisted(sessionId, 1);
    const r3 = await assembler.onChunkPersisted(sessionId, 3);
    expect(r3.status).toBe('waiting');

    expect(await assembler.getLastAppendedSequence(sessionId)).toBe(1);
    const assembled = await readAssembled(assembler, sessionId);
    expect(assembled).toEqual(b1);
    expect(await storage.chunkExists(storage.getChunkStorageKey(sessionId, 3))).toBe(true);
  });

  it('5. missing chunk arrives 1->3->2: assembled becomes 1+2+3', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    const b1 = await putChunk(sessionId, 1, 'one');
    const b3 = await putChunk(sessionId, 3, 'three');

    await assembler.onChunkPersisted(sessionId, 1);
    await assembler.onChunkPersisted(sessionId, 3); // waiting

    const b2 = await putChunk(sessionId, 2, 'two');
    const r2 = await assembler.onChunkPersisted(sessionId, 2);
    expect(r2.status).toBe('appended');

    expect(await assembler.getLastAppendedSequence(sessionId)).toBe(3);
    const assembled = await readAssembled(assembler, sessionId);
    expect(assembled).toEqual(Buffer.concat([b1, b2, b3]));
  });

  it('6. append failure leaves the chunk undeleted and progress unchanged', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    await putChunk(sessionId, 1, 'one');

    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(new Error('simulated disk failure'));

    await expect(assembler.onChunkPersisted(sessionId, 1)).rejects.toThrow('simulated disk failure');

    expect(await assembler.getLastAppendedSequence(sessionId)).toBe(0);
    expect(await storage.chunkExists(storage.getChunkStorageKey(sessionId, 1))).toBe(true);

    // retry after the transient failure clears must still succeed
    const retry = await assembler.onChunkPersisted(sessionId, 1);
    expect(retry.status).toBe('appended');
  });

  it('7. restart/recovery: a fresh VideoAssembler instance resumes from durable state, no duplicate append', async () => {
    const sessionId = newSessionId();
    const assemblerA = new VideoAssembler(storage);
    const b1 = await putChunk(sessionId, 1, 'one');
    const b2 = await putChunk(sessionId, 2, 'two');
    await assemblerA.onChunkPersisted(sessionId, 1);
    await assemblerA.onChunkPersisted(sessionId, 2);

    // Simulate a backend restart: brand new instance, no in-memory state carried over.
    const assemblerB = new VideoAssembler(storage);
    expect(await assemblerB.getLastAppendedSequence(sessionId)).toBe(2);

    const b3 = await putChunk(sessionId, 3, 'three');
    const r3 = await assemblerB.onChunkPersisted(sessionId, 3);
    expect(r3.status).toBe('appended');

    const assembled = await readAssembled(assemblerB, sessionId);
    expect(assembled).toEqual(Buffer.concat([b1, b2, b3]));
  });

  it('7b. restart/recovery: an unconfirmed partial append (crash mid-write) is discarded, not duplicated', async () => {
    const sessionId = newSessionId();
    const assemblerA = new VideoAssembler(storage);
    const b1 = await putChunk(sessionId, 1, 'one');
    await assemblerA.onChunkPersisted(sessionId, 1);

    // Simulate a crash that appended bytes to assembled.webm for chunk 2 but died before
    // the metadata commit: write garbage directly past the confirmed length.
    const assembledPath = await assemblerA.getAssembledPath(sessionId);
    await fs.promises.appendFile(assembledPath, Buffer.from('UNCOMMITTED-GARBAGE'));

    const assemblerB = new VideoAssembler(storage);
    // Reading state must truncate the uncommitted tail back to the last confirmed length.
    expect(await assemblerB.getLastAppendedSequence(sessionId)).toBe(1);
    const recovered = await readAssembled(assemblerB, sessionId);
    expect(recovered).toEqual(b1);
  });

  it('8. complete recording: all chunks available produces a fully assembled file', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    const bufs = [1, 2, 3].map((n) => Buffer.from(`part-${n}`));
    for (let i = 0; i < 3; i++) {
      await storage.putChunk(sessionId, i + 1, bufs[i]);
      await assembler.onChunkPersisted(sessionId, i + 1);
    }

    const path = await assembler.ensureFullyAssembled(sessionId, 3);
    const content = await fs.promises.readFile(path);
    expect(content).toEqual(Buffer.concat(bufs));
  });

  it('ensureFullyAssembled throws when chunks are still missing', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    await putChunk(sessionId, 1, 'one');
    await assembler.onChunkPersisted(sessionId, 1);

    await expect(assembler.ensureFullyAssembled(sessionId, 2)).rejects.toThrow(/cannot finalize/);
  });

  it('9 & 10. finalization: assembled.webm -> ffmpeg -c copy -> final.webm with valid video+audio streams', async () => {
    const sessionId = newSessionId();
    const assembler = new VideoAssembler(storage);
    const chunk = generateValidWebm(1);
    await storage.putChunk(sessionId, 1, chunk);
    const outcome = await assembler.onChunkPersisted(sessionId, 1);
    expect(outcome.status).toBe('appended');

    const assembledPath = await assembler.ensureFullyAssembled(sessionId, 1);
    const scratchDir = await storage.getProcessingScratchDir(sessionId);

    const result = await finalizeAssembled(assembledPath, scratchDir);

    expect(fs.existsSync(result.outputPath)).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);

    // ffprobe both streams to confirm video+audio survived the remux untouched (stream copy).
    const { spawnSync } = await import('child_process');
    const probe = spawnSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'stream=codec_type,codec_name',
      '-print_format',
      'json',
      result.outputPath,
    ]);
    const parsed = JSON.parse(probe.stdout.toString());
    const codecTypes = parsed.streams.map((s: { codec_type: string }) => s.codec_type);
    expect(codecTypes).toContain('video');
    expect(codecTypes).toContain('audio');
  });
});
