import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from '../../../app.js';
import { sessionRepository } from '../../recording-session/session.repository.js';
import { chunkRepository } from '../../recording-session/chunk.repository.js';
import { videoRepository } from '../video.repository.js';
import { VideoProcessingService } from '../video.service.js';
import { LocalStorageAdapter } from '../../../core/storage/local-storage.adapter.js';
import { prisma } from '../../../core/db/prisma.js';
import { env } from '../../../core/config/env.schema.js';
import { generateValidWebm, sha256 } from './fixtures.js';

const testUserId = 'dev-user-1';
const storage = new LocalStorageAdapter();
const createdSessionIds: string[] = [];

async function initSession(title = 'Video Processing Test') {
  const sessionId = crypto.randomUUID();
  createdSessionIds.push(sessionId);
  await request(app).post('/api/v1/sessions/init').set('x-user-id', testUserId).send({ sessionId, title });
  return sessionId;
}

describe('Video processing (M3)', () => {
  beforeEach(async () => {
    await sessionRepository.clear();
    await chunkRepository.clear();
    await videoRepository.clear();
  });

  afterEach(async () => {
    for (const id of createdSessionIds) {
      await storage.deleteSession(id).catch(() => {});
    }
    createdSessionIds.length = 0;
  });

  it('produces exactly one COMPLETED video for a valid single-chunk session', async () => {
    const sessionId = await initSession();
    const chunk = generateValidWebm(1);
    const checksum = sha256(chunk);

    await request(app)
      .post(`/api/v1/sessions/${sessionId}/chunks`)
      .set('x-user-id', testUserId)
      .field('sequenceNumber', '1')
      .field('checksumSha256', checksum)
      .attach('chunk', chunk, { filename: 'chunk-1.webm', contentType: 'video/webm' });

    const stopRes = await request(app)
      .post(`/api/v1/sessions/${sessionId}/stop`)
      .set('x-user-id', testUserId)
      .send({ totalChunks: 1, sequenceChecksums: { 1: checksum } });

    expect(stopRes.status).toBe(200);
    expect(stopRes.body.data.status).toBe('READY');

    const video = await videoRepository.findBySessionId(sessionId);
    expect(video?.status).toBe('COMPLETED');
    expect(video?.storageKey).toBe(`sessions/${sessionId}/final/meeting.webm`);
    expect(video?.sizeBytes).toBeGreaterThan(0);
    expect(video?.durationMs).toBeGreaterThan(0);
    expect(video?.completedAt).not.toBeNull();

    const finalPath = path.join(env.STORAGE_LOCAL_DIR, video!.storageKey!);
    expect(fs.existsSync(finalPath)).toBe(true);

    // GET verification endpoint reports the same facts.
    const getRes = await request(app).get(`/api/v1/sessions/${sessionId}`).set('x-user-id', testUserId);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.status).toBe('READY');
    expect(getRes.body.data.video.status).toBe('COMPLETED');
    expect(getRes.body.data.video.storageKey).toBe(video!.storageKey);
  });

  it('marks the video FAILED (not silently READY) when chunk data cannot be processed', async () => {
    const sessionId = await initSession();
    // Declared as video/webm (passes the MIME header check) but not real WebM bytes —
    // simulates a corrupted/invalid chunk, per the "what happens if one chunk is
    // corrupt" question in the architecture review: a hard failure, never skipped.
    const garbage = Buffer.from('this is not a valid webm container');
    const checksum = sha256(garbage);

    await request(app)
      .post(`/api/v1/sessions/${sessionId}/chunks`)
      .set('x-user-id', testUserId)
      .field('sequenceNumber', '1')
      .field('checksumSha256', checksum)
      .attach('chunk', garbage, { filename: 'chunk-1.webm', contentType: 'video/webm' });

    const stopRes = await request(app)
      .post(`/api/v1/sessions/${sessionId}/stop`)
      .set('x-user-id', testUserId)
      .send({ totalChunks: 1, sequenceChecksums: { 1: checksum } });

    expect(stopRes.status).toBe(200);
    expect(stopRes.body.data.status).toBe('FAILED');

    const video = await videoRepository.findBySessionId(sessionId);
    expect(video?.status).toBe('FAILED');
    expect(video?.errorMessage).toBeTruthy();
    expect(video?.processingAttempts).toBeGreaterThanOrEqual(1);
  });

  it('never creates a second Video row across repeated processing attempts for one session', async () => {
    const sessionId = await initSession();
    const chunk = generateValidWebm(1);
    const checksum = sha256(chunk);

    await request(app)
      .post(`/api/v1/sessions/${sessionId}/chunks`)
      .set('x-user-id', testUserId)
      .field('sequenceNumber', '1')
      .field('checksumSha256', checksum)
      .attach('chunk', chunk, { filename: 'chunk-1.webm', contentType: 'video/webm' });

    const service = new VideoProcessingService(storage);

    await service.processSession(sessionId, testUserId);
    await service.processSession(sessionId, testUserId); // repeated call — must be a no-op, not a new row
    await service.processSession(sessionId, testUserId);

    const rows = await prisma.video.findMany({ where: { sessionId } });
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe('COMPLETED');
  });

  it('enforces one-video-per-session at the schema level, independent of application logic', async () => {
    const sessionId = await initSession();
    await videoRepository.claim(sessionId, testUserId);

    await expect(
      prisma.video.create({ data: { sessionId, userId: testUserId, status: 'PENDING' } })
    ).rejects.toThrow();
  });

  it('retries FAILED -> COMPLETED on the same row, never inserting a new one', async () => {
    const sessionId = await initSession();
    const chunk = generateValidWebm(1);
    const checksum = sha256(chunk);

    await request(app)
      .post(`/api/v1/sessions/${sessionId}/chunks`)
      .set('x-user-id', testUserId)
      .field('sequenceNumber', '1')
      .field('checksumSha256', checksum)
      .attach('chunk', chunk, { filename: 'chunk-1.webm', contentType: 'video/webm' });

    const claimed = await videoRepository.claim(sessionId, testUserId);
    await videoRepository.update(sessionId, {
      status: 'FAILED',
      errorMessage: 'simulated transient failure',
      processingAttempts: { increment: 1 },
    });

    const service = new VideoProcessingService(storage);
    const result = await service.processSession(sessionId, testUserId);

    expect(result.id).toBe(claimed.id); // same row throughout
    expect(result.status).toBe('COMPLETED');
    expect(result.processingAttempts).toBeGreaterThanOrEqual(1);

    const rows = await prisma.video.findMany({ where: { sessionId } });
    expect(rows.length).toBe(1);
  });

  it('Case E: trusts an existing final file on disk instead of re-encoding', async () => {
    const sessionId = await initSession();
    // No chunks ingested at all — if this reached the encode step it would fail with
    // "No chunks found for session". Placing the final file directly and claiming
    // PENDING simulates "ffmpeg finished and wrote the file, then the process crashed
    // before the DB was updated" (architecture review Case E).
    const scratchDir = await storage.getProcessingScratchDir(sessionId);
    const fakeOutput = path.join(scratchDir, 'output.webm');
    fs.writeFileSync(fakeOutput, generateValidWebm(1));
    await storage.saveFinalVideo(sessionId, fakeOutput, 'meeting.webm');

    await videoRepository.claim(sessionId, testUserId);

    const service = new VideoProcessingService(storage);
    const result = await service.processSession(sessionId, testUserId);

    expect(result.status).toBe('COMPLETED');
    expect(result.storageKey).toBe(`sessions/${sessionId}/final/meeting.webm`);
  });
});
