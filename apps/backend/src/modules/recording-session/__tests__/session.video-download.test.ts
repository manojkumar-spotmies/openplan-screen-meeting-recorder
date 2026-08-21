import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import { app } from '../../../app.js';
import { sessionRepository } from '../session.repository.js';
import { chunkRepository } from '../chunk.repository.js';
import { videoRepository } from '../../video-processing/video.repository.js';
import { LocalStorageAdapter } from '../../../core/storage/local-storage.adapter.js';
import { generateValidWebm, sha256 } from '../../video-processing/__tests__/fixtures.js';

const testUserId = 'dev-user-1';
const storage = new LocalStorageAdapter();
const createdSessionIds: string[] = [];

async function initSession(title = 'Video Download Test') {
  const sessionId = crypto.randomUUID();
  createdSessionIds.push(sessionId);
  await request(app).post('/api/v1/sessions/init').set('x-user-id', testUserId).send({ sessionId, title });
  return sessionId;
}

describe('GET /api/v1/sessions/:sessionId/video', () => {
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

  it('streams the final video bytes once the session is READY', async () => {
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

    const videoRes = await request(app)
      .get(`/api/v1/sessions/${sessionId}/video`)
      .set('x-user-id', testUserId)
      .buffer(true)
      .parse((res, callback) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => callback(null, Buffer.concat(chunks)));
      });

    expect(videoRes.status).toBe(200);
    expect(videoRes.headers['content-type']).toBe('video/webm');
    expect(Number(videoRes.headers['content-length'])).toBeGreaterThan(0);
    expect((videoRes.body as Buffer).length).toBe(Number(videoRes.headers['content-length']));
  });

  it('returns 409 when the video is not ready yet', async () => {
    const sessionId = await initSession();

    const res = await request(app).get(`/api/v1/sessions/${sessionId}/video`).set('x-user-id', testUserId);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('ERR_VIDEO_NOT_READY');
  });

  it('returns 404 for an unknown session', async () => {
    const res = await request(app)
      .get(`/api/v1/sessions/${crypto.randomUUID()}/video`)
      .set('x-user-id', testUserId);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ERR_SESSION_NOT_FOUND');
  });

  it('never deletes or mutates the backend final video file', async () => {
    const sessionId = await initSession();
    const chunk = generateValidWebm(1);
    const checksum = sha256(chunk);

    await request(app)
      .post(`/api/v1/sessions/${sessionId}/chunks`)
      .set('x-user-id', testUserId)
      .field('sequenceNumber', '1')
      .field('checksumSha256', checksum)
      .attach('chunk', chunk, { filename: 'chunk-1.webm', contentType: 'video/webm' });

    await request(app)
      .post(`/api/v1/sessions/${sessionId}/stop`)
      .set('x-user-id', testUserId)
      .send({ totalChunks: 1, sequenceChecksums: { 1: checksum } });

    await request(app).get(`/api/v1/sessions/${sessionId}/video`).set('x-user-id', testUserId);
    // A second download must still succeed identically — the file must not have moved/gone.
    const second = await request(app).get(`/api/v1/sessions/${sessionId}/video`).set('x-user-id', testUserId);
    expect(second.status).toBe(200);

    const video = await videoRepository.findBySessionId(sessionId);
    expect(video?.status).toBe('COMPLETED');
  });
});
