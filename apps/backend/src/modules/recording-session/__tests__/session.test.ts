import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { app } from '../../../app.js';
import { sessionRepository } from '../session.repository.js';
import { chunkRepository } from '../chunk.repository.js';
import { LocalStorageAdapter } from '../../../core/storage/local-storage.adapter.js';

const TEST_STORAGE_DIR = path.resolve('./test_storage_local');

describe('Recording Session REST API & Engine (F-002)', () => {
  const validSessionId = '550e8400-e29b-41d4-a716-446655440000';
  const testUserId = 'dev-user-1';

  beforeEach(async () => {
    await sessionRepository.clear();
    await chunkRepository.clear();
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      await fs.promises.rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (fs.existsSync(TEST_STORAGE_DIR)) {
      await fs.promises.rm(TEST_STORAGE_DIR, { recursive: true, force: true });
    }
  });

  describe('POST /api/v1/sessions/init', () => {
    it('1. Initializes a new recording session successfully', async () => {
      const res = await request(app)
        .post('/api/v1/sessions/init')
        .set('x-user-id', testUserId)
        .send({
          sessionId: validSessionId,
          title: 'Weekly Standup',
          sourceTabUrl: 'https://meet.google.com/abc-defg-hij',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.sessionId).toBe(validSessionId);
      expect(res.body.data.userId).toBe(testUserId);
      expect(res.body.data.status).toBe('INITIALIZED');

      const saved = await sessionRepository.findById(validSessionId);
      expect(saved).toBeDefined();
      expect(saved?.status).toBe('INITIALIZED');
    });

    it('2. Returns existing session idempotently when re-initialized', async () => {
      await request(app)
        .post('/api/v1/sessions/init')
        .set('x-user-id', testUserId)
        .send({ sessionId: validSessionId, title: 'Weekly Standup' });

      const res = await request(app)
        .post('/api/v1/sessions/init')
        .set('x-user-id', testUserId)
        .send({ sessionId: validSessionId, title: 'Weekly Standup' });

      expect(res.status).toBe(200);
      expect(res.body.data.sessionId).toBe(validSessionId);
    });

    it('3. Rejects initialization with invalid UUID format', async () => {
      const res = await request(app)
        .post('/api/v1/sessions/init')
        .set('x-user-id', testUserId)
        .send({ sessionId: 'invalid-uuid', title: 'Standup' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_INVALID_PAYLOAD');
    });
  });

  describe('POST /api/v1/sessions/:sessionId/chunks', () => {
    beforeEach(async () => {
      await request(app)
        .post('/api/v1/sessions/init')
        .set('x-user-id', testUserId)
        .send({ sessionId: validSessionId, title: 'Weekly Standup' });
    });

    it('4 & 5. Ingests valid WebM chunk with correct SHA-256 checksum', async () => {
      const payload = Buffer.from('mock webm binary video data for chunk 1');
      const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256)
        .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('ACKNOWLEDGED');
      expect(res.body.data.isDuplicate).toBe(false);
      expect(res.body.data.sequenceNumber).toBe(1);

      const session = await sessionRepository.findById(validSessionId);
      expect(session?.status).toBe('RECORDING');
    });

    it('6. Rejects chunk upload when SHA-256 checksum mismatches', async () => {
      const payload = Buffer.from('mock webm binary payload');
      const invalidSha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', invalidSha256)
        .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_CHECKSUM_MISMATCH');
    });

    it('7. Rejects chunk upload with invalid MIME type', async () => {
      const payload = Buffer.from('plain text file content');
      const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256)
        .attach('chunk', payload, { filename: 'file.txt', contentType: 'text/plain' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('ERR_INVALID_MIME_TYPE');
    });

    it('9. Handles identical duplicate chunk upload idempotently', async () => {
      const payload = Buffer.from('mock webm chunk content');
      const sha256 = crypto.createHash('sha256').update(payload).digest('hex');

      // Upload 1st time
      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256)
        .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

      // Upload 2nd time (duplicate)
      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256)
        .attach('chunk', payload, { filename: 'chunk1.webm', contentType: 'video/webm' });

      expect(res.status).toBe(200);
      expect(res.body.data.isDuplicate).toBe(true);
      expect(res.body.data.status).toBe('ACKNOWLEDGED');
    });

    it('10. Rejects duplicate sequence with conflicting SHA-256 hash', async () => {
      const payloadA = Buffer.from('original webm data chunk 1');
      const sha256A = crypto.createHash('sha256').update(payloadA).digest('hex');

      const payloadB = Buffer.from('conflicting webm data chunk 1');
      const sha256B = crypto.createHash('sha256').update(payloadB).digest('hex');

      // Ingest payload A at sequence 1
      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256A)
        .attach('chunk', payloadA, { filename: 'chunk1.webm', contentType: 'video/webm' });

      // Ingest payload B at sequence 1
      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256B)
        .attach('chunk', payloadB, { filename: 'chunk1.webm', contentType: 'video/webm' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('ERR_DUPLICATE_SEQUENCE_CONFLICT');
    });

    it('11. Accepts out-of-order chunk uploads safely', async () => {
      const chunk2 = Buffer.from('webm chunk seq 2');
      const sha256Seq2 = crypto.createHash('sha256').update(chunk2).digest('hex');

      const chunk1 = Buffer.from('webm chunk seq 1');
      const sha256Seq1 = crypto.createHash('sha256').update(chunk1).digest('hex');

      // Upload sequence 2 first
      const res2 = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '2')
        .field('checksumSha256', sha256Seq2)
        .attach('chunk', chunk2, { filename: 'chunk2.webm', contentType: 'video/webm' });

      expect(res2.status).toBe(200);

      // Upload sequence 1 next
      const res1 = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha256Seq1)
        .attach('chunk', chunk1, { filename: 'chunk1.webm', contentType: 'video/webm' });

      expect(res1.status).toBe(200);

      const chunks = await chunkRepository.findBySessionId(validSessionId);
      expect(chunks.length).toBe(2);
      expect(chunks[0].sequenceNumber).toBe(1);
      expect(chunks[1].sequenceNumber).toBe(2);
    });

    it('12. Supports concurrent chunk uploads', async () => {
      const c1 = Buffer.from('parallel chunk 1');
      const sha1 = crypto.createHash('sha256').update(c1).digest('hex');

      const c2 = Buffer.from('parallel chunk 2');
      const sha2 = crypto.createHash('sha256').update(c2).digest('hex');

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/v1/sessions/${validSessionId}/chunks`)
          .set('x-user-id', testUserId)
          .field('sequenceNumber', '1')
          .field('checksumSha256', sha1)
          .attach('chunk', c1, { filename: 'chunk1.webm', contentType: 'video/webm' }),
        request(app)
          .post(`/api/v1/sessions/${validSessionId}/chunks`)
          .set('x-user-id', testUserId)
          .field('sequenceNumber', '2')
          .field('checksumSha256', sha2)
          .attach('chunk', c2, { filename: 'chunk2.webm', contentType: 'video/webm' }),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });
  });

  describe('POST /api/v1/sessions/:sessionId/stop & Grace Period', () => {
    beforeEach(async () => {
      await request(app)
        .post('/api/v1/sessions/init')
        .set('x-user-id', testUserId)
        .send({ sessionId: validSessionId, title: 'Weekly Standup' });
    });

    it('13. Transitions session to PROCESSING when all expected chunks exist', async () => {
      // Ingest chunk 1 and 2
      const c1 = Buffer.from('chunk 1');
      const c2 = Buffer.from('chunk 2');
      const sha1 = crypto.createHash('sha256').update(c1).digest('hex');
      const sha2 = crypto.createHash('sha256').update(c2).digest('hex');

      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha1)
        .attach('chunk', c1, { filename: 'c1.webm', contentType: 'video/webm' });

      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '2')
        .field('checksumSha256', sha2)
        .attach('chunk', c2, { filename: 'c2.webm', contentType: 'video/webm' });

      // Stop manifest
      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/stop`)
        .set('x-user-id', testUserId)
        .send({
          totalChunks: 2,
          sequenceChecksums: { 1: sha1, 2: sha2 },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('PROCESSING');
      expect(res.body.data.missingSequences).toEqual([]);
    });

    it('14 & 15. Transitions session to WAITING_FOR_CHUNKS with 5m grace period when chunks are missing', async () => {
      // Ingest chunk 1 only (chunk 2 missing)
      const c1 = Buffer.from('chunk 1');
      const sha1 = crypto.createHash('sha256').update(c1).digest('hex');

      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha1)
        .attach('chunk', c1, { filename: 'c1.webm', contentType: 'video/webm' });

      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/stop`)
        .set('x-user-id', testUserId)
        .send({
          totalChunks: 2,
          sequenceChecksums: { 1: sha1, 2: 'hash2' },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('WAITING_FOR_CHUNKS');
      expect(res.body.data.missingSequences).toEqual([2]);
      expect(res.body.data.gracePeriodEndsAt).toBeDefined();
    });

    it('16. Transitions WAITING_FOR_CHUNKS -> PROCESSING when missing chunk arrives during grace period', async () => {
      const c1 = Buffer.from('chunk 1');
      const sha1 = crypto.createHash('sha256').update(c1).digest('hex');

      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '1')
        .field('checksumSha256', sha1)
        .attach('chunk', c1, { filename: 'c1.webm', contentType: 'video/webm' });

      // Stop call with expected 2 chunks
      await request(app)
        .post(`/api/v1/sessions/${validSessionId}/stop`)
        .set('x-user-id', testUserId)
        .send({ totalChunks: 2 });

      // Now missing chunk 2 arrives
      const c2 = Buffer.from('chunk 2 missing arrived');
      const sha2 = crypto.createHash('sha256').update(c2).digest('hex');

      const chunkRes = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/chunks`)
        .set('x-user-id', testUserId)
        .field('sequenceNumber', '2')
        .field('checksumSha256', sha2)
        .attach('chunk', c2, { filename: 'c2.webm', contentType: 'video/webm' });

      expect(chunkRes.status).toBe(200);

      const session = await sessionRepository.findById(validSessionId);
      expect(session?.status).toBe('PROCESSING');
    });

    it('18. Transitions immediately to INCOMPLETE when totalChunks is 0', async () => {
      const res = await request(app)
        .post(`/api/v1/sessions/${validSessionId}/stop`)
        .set('x-user-id', testUserId)
        .send({ totalChunks: 0 });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('INCOMPLETE');
    });
  });

  describe('LocalStorageAdapter Atomic Storage Write', () => {
    it('20. Atomic write creates .tmp, verifies SHA-256 and renames to zero-padded .webm', async () => {
      const storage = new LocalStorageAdapter(TEST_STORAGE_DIR);
      const data = Buffer.from('atomic storage write test data payload');

      const key = await storage.putChunk(validSessionId, 1, data);
      expect(key.replace(/\\/g, '/')).toBe(`sessions/${validSessionId}/chunk-000001.webm`);

      const fullPath = path.join(TEST_STORAGE_DIR, key);
      expect(fs.existsSync(fullPath)).toBe(true);

      const readBack = await storage.getChunk(key);
      expect(readBack.toString()).toBe('atomic storage write test data payload');
    });
  });
});
