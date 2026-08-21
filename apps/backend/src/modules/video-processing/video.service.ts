import path from 'path';
import { chunkRepository } from '../recording-session/chunk.repository.js';
import { videoRepository, DbVideo } from './video.repository.js';
import { finalizeAssembled } from './ffmpeg-runner.js';
import { VideoAssembler } from './video-assembler.js';
import { IStorageProvider } from '../../core/storage/storage.interface.js';

const FINAL_VIDEO_FILENAME = 'meeting.webm';

export class VideoProcessingService {
  private assembler: VideoAssembler;

  constructor(
    private storage: IStorageProvider,
    assembler?: VideoAssembler
  ) {
    this.assembler = assembler || new VideoAssembler(storage);
  }

  /**
   * Turns a session's complete, verified chunk set into one final video. Safe to call
   * more than once for the same session (crash recovery, accidental duplicate /stop) —
   * see the crash-safety cases this covers:
   *  - already COMPLETED: no-op, returns immediately.
   *  - final file exists on disk but the row isn't COMPLETED yet (crashed between
   *    writing the file and updating the DB): trusts the existing file, just completes
   *    the DB transition, never re-encodes.
   *  - anything else: claims/reuses the single Video row for this session and (re)runs
   *    processing from the untouched source chunks.
   */
  public async processSession(sessionId: string, userId: string): Promise<DbVideo> {
    const claimed = await videoRepository.claim(sessionId, userId);
    if (claimed.status === 'COMPLETED') {
      return claimed;
    }

    const alreadyOnDisk = await this.storage.finalVideoExists(sessionId);
    if (alreadyOnDisk) {
      const storageKey = path.posix.join('sessions', sessionId, 'final', FINAL_VIDEO_FILENAME);
      return videoRepository.update(sessionId, {
        status: 'COMPLETED',
        storageKey,
        fileName: FINAL_VIDEO_FILENAME,
        mimeType: 'video/webm',
        completedAt: new Date(),
      });
    }

    await videoRepository.update(sessionId, { status: 'PROCESSING' });

    try {
      const chunks = await chunkRepository.findBySessionId(sessionId); // already sorted by sequenceNumber
      if (chunks.length === 0) {
        throw new Error('No chunks found for session; cannot produce a video');
      }

      // Chunks were already folded into assembled.webm incrementally as they arrived
      // (see VideoAssembler); this call is a defensive catch-up for anything that
      // wasn't folded yet (e.g. a DB outage deferred it) and verifies completeness.
      // Finalization here is a single stream-copy remux, not a re-concatenation.
      const assembledPath = await this.assembler.ensureFullyAssembled(sessionId, chunks.length);
      const scratchDir = await this.storage.getProcessingScratchDir(sessionId);

      const result = await finalizeAssembled(assembledPath, scratchDir);

      const finalStorageKey = await this.storage.saveFinalVideo(
        sessionId,
        result.outputPath,
        FINAL_VIDEO_FILENAME
      );

      return await videoRepository.update(sessionId, {
        status: 'COMPLETED',
        storageKey: finalStorageKey,
        fileName: FINAL_VIDEO_FILENAME,
        mimeType: 'video/webm',
        sizeBytes: result.sizeBytes,
        durationMs: result.durationMs,
        completedAt: new Date(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await videoRepository.update(sessionId, {
        status: 'FAILED',
        errorMessage: message,
        processingAttempts: { increment: 1 },
      });
      throw err;
    }
  }
}
