import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from '../../../app.js';
import { sessionRepository } from '../session.repository.js';
import { chunkRepository } from '../chunk.repository.js';
import { env } from '../../../core/config/env.schema.js';

// Verifies the F-002 chunk-ingest bug fix: local disk storage must not depend on the
// database being reachable. These tests simulate a DB outage (Prisma throwing, e.g. the
// "Server has closed the connection" error seen with a paused/expired-trial Postgres) by
// making the repository calls reject, and assert the chunk still lands on local disk and
// the request still succeeds. They never touch a real database.
describe('Session ingest resilience when the database is unreachable', () => {
  const dbDownSessionId = '6f9619ff-8b86-4d01-9b42-00cf4fc964ff';

  afterEach(() => {
    vi.restoreAllMocks();
    const sessionDir = path.join(path.resolve(env.STORAGE_LOCAL_DIR), 'sessions', dbDownSessionId);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
  });

  it('POST /init still returns a usable session when the DB is unreachable', async () => {
    vi.spyOn(sessionRepository, 'findById').mockRejectedValueOnce(new Error('Server has closed the connection.'));

    const res = await request(app)
      .post('/api/v1/sessions/init')
      .set('x-user-id', 'dev-user-1')
      .send({ sessionId: dbDownSessionId, title: 'DB outage test' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.sessionId).toBe(dbDownSessionId);
    expect(res.body.data.status).toBe('INITIALIZED');
  });

  it('POST /:sessionId/chunks writes the chunk to local disk and acknowledges it even when the DB is unreachable', async () => {
    vi.spyOn(sessionRepository, 'findById').mockRejectedValueOnce(new Error('Server has closed the connection.'));

    const payload = Buffer.from('chunk bytes recorded while the database is down');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const res = await request(app)
      .post(`/api/v1/sessions/${dbDownSessionId}/chunks`)
      .set('x-user-id', 'dev-user-1')
      .field('sequenceNumber', '1')
      .field('checksumSha256', sha256)
      .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ACKNOWLEDGED');

    const writtenPath = path.join(
      path.resolve(env.STORAGE_LOCAL_DIR),
      'sessions',
      dbDownSessionId,
      'chunk-000001.webm'
    );
    expect(fs.existsSync(writtenPath)).toBe(true);
    expect(fs.readFileSync(writtenPath).toString()).toBe(payload.toString());
  });

  it('still rejects a bad checksum even when the DB is unreachable (validation is not DB-dependent)', async () => {
    vi.spyOn(sessionRepository, 'findById').mockRejectedValueOnce(new Error('Server has closed the connection.'));

    const payload = Buffer.from('some chunk bytes');

    const res = await request(app)
      .post(`/api/v1/sessions/${dbDownSessionId}/chunks`)
      .set('x-user-id', 'dev-user-1')
      .field('sequenceNumber', '1')
      .field('checksumSha256', 'e'.repeat(64))
      .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ERR_CHECKSUM_MISMATCH');

    const writtenPath = path.join(path.resolve(env.STORAGE_LOCAL_DIR), 'sessions', dbDownSessionId, 'chunk-000001.webm');
    expect(fs.existsSync(writtenPath)).toBe(false);
  });

  it('still writes to local disk when the DB goes down mid-flow, at the duplicate-check step', async () => {
    vi.spyOn(chunkRepository, 'findBySessionAndSequence').mockRejectedValueOnce(
      new Error('Server has closed the connection.')
    );
    vi.spyOn(sessionRepository, 'findById').mockRejectedValueOnce(new Error('Server has closed the connection.'));

    const payload = Buffer.from('chunk bytes for the mid-flow DB outage case');
    const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

    const res = await request(app)
      .post(`/api/v1/sessions/${dbDownSessionId}/chunks`)
      .set('x-user-id', 'dev-user-1')
      .field('sequenceNumber', '1')
      .field('checksumSha256', sha256)
      .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACKNOWLEDGED');

    const writtenPath = path.join(path.resolve(env.STORAGE_LOCAL_DIR), 'sessions', dbDownSessionId, 'chunk-000001.webm');
    expect(fs.existsSync(writtenPath)).toBe(true);
  });
});
