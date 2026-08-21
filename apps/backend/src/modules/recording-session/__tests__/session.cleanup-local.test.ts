import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../../../app.js';
import { sessionRepository } from '../session.repository.js';
import { chunkRepository } from '../chunk.repository.js';
import { videoRepository } from '../../video-processing/video.repository.js';
import { LocalStorageAdapter } from '../../../core/storage/local-storage.adapter.js';
import { env } from '../../../core/config/env.schema.js';
import { generateValidWebm, sha256 } from '../../video-processing/__tests__/fixtures.js';

const testUserId = 'dev-user-1';
const storage = new LocalStorageAdapter();
const createdSessionIds: string[] = [];

function sessionDir(sessionId: string): string {
  return path.join(path.resolve(env.STORAGE_LOCAL_DIR), 'sessions', sessionId);
}

async function initSession(title = 'Cleanup Test') {
  const sessionId = crypto.randomUUID();
  createdSessionIds.push(sessionId);
  await request(app).post('/api/v1/sessions/init').set('x-user-id', testUserId).send({ sessionId, title });
  return sessionId;
}

async function recordAndFinishSession(): Promise<string> {
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

  expect(stopRes.body.data.status).toBe('READY');
  return sessionId;
}

describe('POST /api/v1/sessions/:sessionId/cleanup-local', () => {
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

  it('returns 409 when the final video is not ready yet', async () => {
    const sessionId = await initSession();

    const res = await request(app).post(`/api/v1/sessions/${sessionId}/cleanup-local`).set('x-user-id', testUserId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ERR_VIDEO_NOT_READY');
  });

  it('returns 404 for an unknown session', async () => {
    const res = await request(app)
      .post(`/api/v1/sessions/${crypto.randomUUID()}/cleanup-local`)
      .set('x-user-id', testUserId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ERR_SESSION_NOT_FOUND');
  });

  it('removes disposable working files but keeps the final video and DB metadata', async () => {
    const sessionId = await recordAndFinishSession();
    const dir = sessionDir(sessionId);

    // Sanity: the assembly buffer exists before cleanup.
    expect(fs.existsSync(path.join(dir, 'assembled'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'final', 'meeting.webm'))).toBe(true);

    const res = await request(app).post(`/api/v1/sessions/${sessionId}/cleanup-local`).set('x-user-id', testUserId);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sessionId, cleaned: true });

    // Temporary artifacts are gone...
    expect(fs.existsSync(path.join(dir, 'assembled'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'processing'))).toBe(false);

    // ...but the final video and all DB metadata are untouched.
    expect(fs.existsSync(path.join(dir, 'final', 'meeting.webm'))).toBe(true);
    const session = await sessionRepository.findById(sessionId);
    const video = await videoRepository.findBySessionId(sessionId);
    expect(session?.status).toBe('READY');
    expect(video?.status).toBe('COMPLETED');

    // The final video is still downloadable after cleanup.
    const videoRes = await request(app).get(`/api/v1/sessions/${sessionId}/video`).set('x-user-id', testUserId);
    expect(videoRes.status).toBe(200);
  });

  it('is idempotent: a second call succeeds as a no-op', async () => {
    const sessionId = await recordAndFinishSession();

    const first = await request(app).post(`/api/v1/sessions/${sessionId}/cleanup-local`).set('x-user-id', testUserId);
    const second = await request(app)
      .post(`/api/v1/sessions/${sessionId}/cleanup-local`)
      .set('x-user-id', testUserId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data).toEqual({ sessionId, cleaned: true });
  });
});
