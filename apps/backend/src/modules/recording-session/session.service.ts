import crypto from 'crypto';
import { SessionManifest, SessionStatus } from '@openplan/contracts';
import { sessionRepository, DbVideoSession } from './session.repository.js';
import { chunkRepository, DbVideoChunk } from './chunk.repository.js';
import { canTransition } from './session-state.machine.js';
import { LocalStorageAdapter } from '../../core/storage/local-storage.adapter.js';
import { IStorageProvider } from '../../core/storage/storage.interface.js';
import { env } from '../../core/config/env.schema.js';
import { VideoProcessingService } from '../video-processing/video.service.js';
import { videoRepository, DbVideo } from '../video-processing/video.repository.js';

export class SessionServiceError extends Error {
  public code: string;
  public statusCode: number;

  constructor(code: string, message: string, statusCode: number = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SessionService {
  private storage: IStorageProvider;
  private videoProcessing: VideoProcessingService;

  constructor(storage?: IStorageProvider) {
    this.storage = storage || new LocalStorageAdapter();
    this.videoProcessing = new VideoProcessingService(this.storage);
  }

  public async initSession(params: {
    sessionId: string;
    userId: string;
    title: string;
    sourceTabUrl?: string;
  }): Promise<DbVideoSession> {
    const { sessionId, userId, title, sourceTabUrl } = params;

    // UUIDv4 validation regex
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!sessionId || !uuidRegex.test(sessionId)) {
      throw new SessionServiceError('ERR_INVALID_PAYLOAD', 'sessionId must be a valid UUIDv4', 400);
    }

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      throw new SessionServiceError('ERR_INVALID_PAYLOAD', 'title is required', 400);
    }

    const now = new Date();
    const newSession: DbVideoSession = {
      id: sessionId,
      userId,
      title,
      sourceTabUrl: sourceTabUrl || null,
      status: 'INITIALIZED',
      totalChunksExpected: null,
      totalChunksReceived: 0,
      gracePeriodEndsAt: null,
      startedAt: now,
      endedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    // DB is best-effort: local chunk storage must keep working even when the database
    // is unreachable (paused/expired-trial Postgres, network blip, ...). If we can't
    // reach it to check for or persist a session row, fall back to this in-memory
    // session so the caller — and subsequent chunk uploads for this sessionId — can
    // proceed writing to local disk. The DB row is created lazily once the database
    // comes back and this session is touched again.
    let existing: DbVideoSession | undefined;
    try {
      existing = await sessionRepository.findById(sessionId);
    } catch (err) {
      console.warn(`[SessionService] DB unreachable while checking for existing session ${sessionId}; proceeding without a persisted row:`, err);
      return newSession;
    }

    if (existing) {
      if (existing.userId !== userId) {
        throw new SessionServiceError('ERR_INSUFFICIENT_PERMISSIONS', 'Session owned by another user', 403);
      }
      if (existing.status === 'INITIALIZED' || existing.status === 'RECORDING') {
        return existing; // Idempotent success
      }
      throw new SessionServiceError('ERR_SESSION_ALREADY_EXISTS', `Session ${sessionId} already exists in status ${existing.status}`, 409);
    }

    try {
      return await sessionRepository.save(newSession);
    } catch (err) {
      console.warn(`[SessionService] DB unreachable while saving new session ${sessionId}; proceeding without a persisted row:`, err);
      return newSession;
    }
  }

  public async ingestChunk(params: {
    sessionId: string;
    userId: string;
    sequenceNumber: number;
    checksumSha256: string;
    buffer: Buffer;
    mimeType: string;
  }): Promise<{
    sessionId: string;
    sequenceNumber: number;
    byteSize: number;
    checksumSha256: string;
    status: 'ACKNOWLEDGED';
    isDuplicate: boolean;
  }> {
    const { sessionId, userId, sequenceNumber, checksumSha256, buffer, mimeType } = params;

    // Session/ownership/state validation all reads from the DB — only enforce it while
    // the DB is actually reachable. When it's down, the chunk must still land safely on
    // local disk (that's the durable artifact the recording depends on); DB bookkeeping
    // is reconciled later once the database is back.
    let session: DbVideoSession | undefined;
    let dbAvailable = true;
    try {
      session = await sessionRepository.findById(sessionId);
    } catch (err) {
      dbAvailable = false;
      console.warn(`[SessionService] DB unreachable while looking up session ${sessionId} for chunk ${sequenceNumber}; writing to local storage without DB validation:`, err);
    }

    if (dbAvailable) {
      if (!session) {
        throw new SessionServiceError('ERR_SESSION_NOT_FOUND', `Session ${sessionId} not found`, 404);
      }

      if (session.userId !== userId) {
        throw new SessionServiceError('ERR_INSUFFICIENT_PERMISSIONS', 'Session owned by another user', 403);
      }

      // Grace period expiration check
      if (session.status === 'WAITING_FOR_CHUNKS' && session.gracePeriodEndsAt) {
        if (new Date() > new Date(session.gracePeriodEndsAt)) {
          await sessionRepository.update(sessionId, { status: 'INCOMPLETE' });
          throw new SessionServiceError('ERR_SESSION_EXPIRED', 'Grace period expired for missing chunks', 400);
        }
      }

      if (session.status === 'PROCESSING' || session.status === 'READY') {
        throw new SessionServiceError('ERR_SESSION_ALREADY_FINALIZED', 'Session is already finalized', 400);
      }

      if (session.status === 'INCOMPLETE' || session.status === 'FAILED') {
        throw new SessionServiceError('ERR_SESSION_EXPIRED', `Session is in terminal state: ${session.status}`, 400);
      }
    }

    // MIME type check
    if (!mimeType || !mimeType.toLowerCase().startsWith('video/webm')) {
      throw new SessionServiceError('ERR_INVALID_MIME_TYPE', 'Payload MIME type must be video/webm', 400);
    }

    // Size limit check (10MB)
    if (buffer.length > env.MAX_CHUNK_SIZE_BYTES) {
      throw new SessionServiceError('ERR_CHUNK_SIZE_EXCEEDED', `Chunk size ${buffer.length} exceeds max limit of ${env.MAX_CHUNK_SIZE_BYTES}`, 400);
    }

    // SHA-256 checksum format check
    if (!checksumSha256 || !/^[0-9a-f]{64}$/i.test(checksumSha256)) {
      throw new SessionServiceError('ERR_CHECKSUM_MISMATCH', 'checksumSha256 must be a 64-character lowercase hex string', 400);
    }

    // Recalculate SHA-256 hash from raw binary buffer
    const computedSha256 = crypto.createHash('sha256').update(buffer).digest('hex').toLowerCase();
    const providedSha256 = checksumSha256.toLowerCase();

    if (computedSha256 !== providedSha256) {
      throw new SessionServiceError('ERR_CHECKSUM_MISMATCH', 'Recalculated SHA-256 checksum does not match provided checksum', 400);
    }

    // Idempotency check (DB-backed; skipped when the DB is unreachable — see above,
    // this only downgrades duplicate-detection, it never blocks the local write below)
    let existingChunk: DbVideoChunk | undefined;
    if (dbAvailable) {
      try {
        existingChunk = await chunkRepository.findBySessionAndSequence(sessionId, sequenceNumber);
      } catch (err) {
        dbAvailable = false;
        console.warn(`[SessionService] DB unreachable during duplicate-chunk check for ${sessionId}:${sequenceNumber}; proceeding with local write:`, err);
      }
    }

    if (existingChunk) {
      if (existingChunk.checksumSha256.toLowerCase() === providedSha256) {
        // Identical duplicate -> HTTP 200 OK ACK without storage rewrite or DB metadata duplicate
        return {
          sessionId,
          sequenceNumber,
          byteSize: existingChunk.byteSize,
          checksumSha256: existingChunk.checksumSha256,
          status: 'ACKNOWLEDGED',
          isDuplicate: true,
        };
      } else {
        // Sequence duplicate with conflicting SHA-256 -> HTTP 409 Conflict
        throw new SessionServiceError(
          'ERR_DUPLICATE_SEQUENCE_CONFLICT',
          `Sequence ${sequenceNumber} already exists with a different SHA-256 checksum`,
          409
        );
      }
    }

    // Storage write — the durable artifact. Happens unconditionally: local disk does
    // not depend on the database being reachable.
    const storageKey = await this.storage.putChunk(sessionId, sequenceNumber, buffer);

    if (!dbAvailable) {
      // Chunk is safely on disk. DB metadata (chunk row, session counters, status
      // transitions) is reconciled the next time this session is touched with a
      // reachable DB — nothing more to do for this request.
      return {
        sessionId,
        sequenceNumber,
        byteSize: buffer.length,
        checksumSha256: providedSha256,
        status: 'ACKNOWLEDGED',
        isDuplicate: false,
      };
    }

    // session is guaranteed defined here: dbAvailable is only still true if the
    // findById lookup above both succeeded and returned a session (the `!session`
    // branch throws otherwise).
    const currentSession = session as DbVideoSession;

    // DB metadata write is best-effort from here on: the chunk is already durably on
    // disk, so a DB failure at this point must not fail the request (the client would
    // just retry and re-write an identical file for no benefit).
    try {
      const chunkId = crypto.randomUUID();
      const dbChunk: DbVideoChunk = {
        id: chunkId,
        sessionId,
        sequenceNumber,
        checksumSha256: providedSha256,
        byteSize: buffer.length,
        mimeType,
        storageKey,
        createdAt: new Date(),
      };

      await chunkRepository.save(dbChunk);

      // Update session state
      const allChunks = await chunkRepository.findBySessionId(sessionId);
      const updates: Partial<DbVideoSession> = {
        totalChunksReceived: allChunks.length,
      };

      if (currentSession.status === 'INITIALIZED') {
        updates.status = 'RECORDING';
      }

      // Check if waiting for missing chunks and now complete
      let justCompletedViaLateChunk = false;
      if (currentSession.status === 'WAITING_FOR_CHUNKS' && currentSession.totalChunksExpected !== null) {
        const missing = this.getMissingSequenceNumbers(allChunks, currentSession.totalChunksExpected);
        if (missing.length === 0) {
          updates.status = 'PROCESSING';
          updates.gracePeriodEndsAt = null;
          justCompletedViaLateChunk = true;
        }
      }

      await sessionRepository.update(sessionId, updates);

      if (justCompletedViaLateChunk) {
        // Same synchronous trigger as the /stop complete-manifest path — this late chunk
        // was the one that made the set complete, so this is the point processing must start.
        let finalStatus: SessionStatus = 'PROCESSING';
        try {
          const video = await this.videoProcessing.processSession(sessionId, userId);
          finalStatus = video.status === 'COMPLETED' ? 'READY' : 'FAILED';
        } catch {
          finalStatus = 'FAILED';
        }
        await sessionRepository.update(sessionId, { status: finalStatus });
      }
    } catch (err) {
      console.warn(`[SessionService] Chunk ${sessionId}:${sequenceNumber} stored locally but DB metadata sync failed:`, err);
    }

    return {
      sessionId,
      sequenceNumber,
      byteSize: buffer.length,
      checksumSha256: providedSha256,
      status: 'ACKNOWLEDGED',
      isDuplicate: false,
    };
  }

  public async stopSession(params: {
    sessionId: string;
    userId: string;
    manifest: SessionManifest;
  }): Promise<{
    sessionId: string;
    status: SessionStatus;
    totalChunksExpected: number;
    totalChunksReceived: number;
    missingSequences: number[];
    gracePeriodEndsAt?: string;
  }> {
    const { sessionId, userId, manifest } = params;

    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionServiceError('ERR_SESSION_NOT_FOUND', `Session ${sessionId} not found`, 404);
    }

    if (session.userId !== userId) {
      throw new SessionServiceError('ERR_INSUFFICIENT_PERMISSIONS', 'Session owned by another user', 403);
    }

    const { totalChunks } = manifest;
    const existingChunks = await chunkRepository.findBySessionId(sessionId);

    // Zero-chunk stop
    if (totalChunks === 0) {
      await sessionRepository.update(sessionId, {
        status: 'INCOMPLETE',
        totalChunksExpected: 0,
        totalChunksReceived: 0,
        endedAt: new Date(),
      });
      return {
        sessionId,
        status: 'INCOMPLETE',
        totalChunksExpected: 0,
        totalChunksReceived: 0,
        missingSequences: [],
      };
    }

    // Find missing sequence numbers from 1..totalChunks
    const missingSequences = this.getMissingSequenceNumbers(existingChunks, totalChunks);

    if (missingSequences.length === 0) {
      // All chunks present
      await sessionRepository.update(sessionId, {
        status: 'PROCESSING',
        totalChunksExpected: totalChunks,
        totalChunksReceived: existingChunks.length,
        gracePeriodEndsAt: null,
        endedAt: new Date(),
      });

      // Synchronous for this phase (no job queue yet): the video is fully produced and
      // verified, or the session is marked FAILED, before this request responds. Never
      // report READY without a real, verified COMPLETED Video behind it.
      let finalStatus: SessionStatus = 'PROCESSING';
      try {
        const video = await this.videoProcessing.processSession(sessionId, userId);
        finalStatus = video.status === 'COMPLETED' ? 'READY' : 'FAILED';
      } catch {
        finalStatus = 'FAILED';
      }
      await sessionRepository.update(sessionId, { status: finalStatus });

      return {
        sessionId,
        status: finalStatus,
        totalChunksExpected: totalChunks,
        totalChunksReceived: existingChunks.length,
        missingSequences: [],
      };
    } else {
      // Sequence gaps exist -> 5 minute grace period
      const gracePeriodEndsAt = new Date(Date.now() + env.SESSION_GRACE_PERIOD_MINUTES * 60 * 1000);

      await sessionRepository.update(sessionId, {
        status: 'WAITING_FOR_CHUNKS',
        totalChunksExpected: totalChunks,
        totalChunksReceived: existingChunks.length,
        gracePeriodEndsAt,
        endedAt: new Date(),
      });

      return {
        sessionId,
        status: 'WAITING_FOR_CHUNKS',
        totalChunksExpected: totalChunks,
        totalChunksReceived: existingChunks.length,
        missingSequences,
        gracePeriodEndsAt: gracePeriodEndsAt.toISOString(),
      };
    }
  }

  public async getSessionWithVideo(
    sessionId: string,
    userId: string
  ): Promise<{ session: DbVideoSession; video: DbVideo | undefined }> {
    const session = await sessionRepository.findById(sessionId);
    if (!session) {
      throw new SessionServiceError('ERR_SESSION_NOT_FOUND', `Session ${sessionId} not found`, 404);
    }
    if (session.userId !== userId) {
      throw new SessionServiceError('ERR_INSUFFICIENT_PERMISSIONS', 'Session owned by another user', 403);
    }
    const video = await videoRepository.findBySessionId(sessionId);
    return { session, video };
  }

  private getMissingSequenceNumbers(existingChunks: DbVideoChunk[], totalExpected: number): number[] {
    const presentSeqSet = new Set(existingChunks.map((c) => c.sequenceNumber));
    const missing: number[] = [];
    for (let i = 1; i <= totalExpected; i++) {
      if (!presentSeqSet.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }
}

export const sessionService = new SessionService();
