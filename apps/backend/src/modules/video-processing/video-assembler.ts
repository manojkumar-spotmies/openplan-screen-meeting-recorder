import fs from 'fs';
import path from 'path';
import { IStorageProvider } from '../../core/storage/storage.interface.js';

const ASSEMBLED_FILENAME = 'assembled.webm';
const META_FILENAME = 'assembled.meta.json';

interface AssemblyState {
  lastAppendedSequence: number;
  byteLength: number;
}

export type FoldOutcome =
  | { status: 'appended'; sequenceNumber: number }
  | { status: 'waiting'; sequenceNumber: number; nextRequired: number }
  | { status: 'duplicate-skipped'; sequenceNumber: number };

/**
 * Incrementally folds durably-persisted chunk files into one growing `assembled.webm` per
 * session, in strict sequence order, so the final FFmpeg pass only has to remux container
 * metadata instead of concatenating every chunk again.
 *
 * Durability model: chunk files on disk remain the source of truth until folded. This
 * class's own progress (`lastAppendedSequence` / `byteLength`) is persisted next to the
 * growing file in `assembled.meta.json`, written via tmp-file + atomic rename — the same
 * pattern LocalStorageAdapter already uses for chunk writes. No in-memory state is required
 * to resume correctly after a restart: every entry point re-derives progress from disk.
 *
 * Crash safety: bytes are appended (and fsync'd) to assembled.webm BEFORE the metadata
 * commit that records them as folded. If the process dies in between, assembled.webm's size
 * exceeds what the metadata confirms; the next read truncates the file back down to the
 * last confirmed length, discarding the unconfirmed tail, and folding resumes from there —
 * the source chunk file was never deleted, so nothing is lost.
 */
export class VideoAssembler {
  private locks = new Map<string, Promise<unknown>>();

  constructor(private storage: IStorageProvider) {}

  /** Call once a chunk has been durably persisted. Folds it, plus any chunks this makes contiguous. */
  public async onChunkPersisted(sessionId: string, sequenceNumber: number): Promise<FoldOutcome> {
    return this.withLock(sessionId, async () => {
      const state = await this.readState(sessionId);

      if (sequenceNumber <= state.lastAppendedSequence) {
        console.log(`[VideoAssembler] session=${sessionId} chunk=${sequenceNumber} duplicate-skipped`);
        return { status: 'duplicate-skipped', sequenceNumber };
      }

      if (sequenceNumber !== state.lastAppendedSequence + 1) {
        console.log(
          `[VideoAssembler] session=${sessionId} chunk=${sequenceNumber} waiting-for=${state.lastAppendedSequence + 1}`
        );
        return { status: 'waiting', sequenceNumber, nextRequired: state.lastAppendedSequence + 1 };
      }

      await this.foldFrom(sessionId, state);
      return { status: 'appended', sequenceNumber };
    });
  }

  /** Defensive catch-up: folds every contiguous chunk currently available on disk. Used for recovery/finalization. */
  public async foldAvailable(sessionId: string): Promise<void> {
    return this.withLock(sessionId, async () => {
      const state = await this.readState(sessionId);
      await this.foldFrom(sessionId, state);
    });
  }

  public async getLastAppendedSequence(sessionId: string): Promise<number> {
    const state = await this.readState(sessionId);
    return state.lastAppendedSequence;
  }

  public async getAssembledPath(sessionId: string): Promise<string> {
    const dir = await this.storage.getAssemblyDir(sessionId);
    return path.join(dir, ASSEMBLED_FILENAME);
  }

  /**
   * Folds any remaining available chunks, then verifies assembly is complete up to
   * `totalExpected`. Returns the path to assembled.webm, ready for the final FFmpeg remux.
   * Throws if the session is not actually complete — callers should only invoke this once
   * their own completeness rules (grace period, manifest check) have already passed.
   */
  public async ensureFullyAssembled(sessionId: string, totalExpected: number): Promise<string> {
    return this.withLock(sessionId, async () => {
      let state = await this.readState(sessionId);
      state = await this.foldFrom(sessionId, state);

      if (state.lastAppendedSequence < totalExpected) {
        throw new Error(
          `[VideoAssembler] session=${sessionId} cannot finalize: assembled up to chunk ` +
            `${state.lastAppendedSequence}, expected ${totalExpected}`
        );
      }

      return this.getAssembledPath(sessionId);
    });
  }

  private withLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(sessionId) ?? Promise.resolve();
    const result = prior.then(fn, fn);
    this.locks.set(
      sessionId,
      result.then(
        () => undefined,
        () => undefined
      )
    );
    return result;
  }

  /** Reads durable progress, reconciling assembled.webm's actual size against it (see class docstring). */
  private async readState(sessionId: string): Promise<AssemblyState> {
    const dir = await this.storage.getAssemblyDir(sessionId);
    const metaPath = path.join(dir, META_FILENAME);
    const assembledPath = path.join(dir, ASSEMBLED_FILENAME);

    let state: AssemblyState = { lastAppendedSequence: 0, byteLength: 0 };
    if (fs.existsSync(metaPath)) {
      try {
        const raw = await fs.promises.readFile(metaPath, 'utf-8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.lastAppendedSequence === 'number' && typeof parsed.byteLength === 'number') {
          state = parsed;
        }
      } catch (err) {
        throw new Error(
          `[VideoAssembler] session=${sessionId} corrupt assembly metadata at ${metaPath}: ${
            (err as Error).message
          }`
        );
      }
    }

    const actualSize = fs.existsSync(assembledPath) ? (await fs.promises.stat(assembledPath)).size : 0;

    if (actualSize > state.byteLength) {
      const fh = await fs.promises.open(assembledPath, 'r+');
      try {
        await fh.truncate(state.byteLength);
        await fh.sync();
      } finally {
        await fh.close();
      }
      console.warn(
        `[VideoAssembler] session=${sessionId} recovered from partial append: truncated assembled.webm ` +
          `from ${actualSize} to ${state.byteLength} bytes`
      );
    } else if (actualSize < state.byteLength) {
      throw new Error(
        `[VideoAssembler] session=${sessionId} assembled.webm is smaller (${actualSize}b) than its recorded ` +
          `state (${state.byteLength}b) — storage may be corrupted`
      );
    }

    // Best-effort cleanup of a chunk file orphaned by a crash that happened after the
    // metadata commit but before the chunk delete below — safe because its sequence is
    // already confirmed folded.
    if (state.lastAppendedSequence > 0) {
      const key = this.storage.getChunkStorageKey(sessionId, state.lastAppendedSequence);
      if (await this.storage.chunkExists(key)) {
        await this.storage.deleteChunk(key).catch(() => {});
      }
    }

    return state;
  }

  /** Appends `next`, `next+1`, ... for as long as each is available, starting from `state.lastAppendedSequence + 1`. */
  private async foldFrom(sessionId: string, state: AssemblyState): Promise<AssemblyState> {
    let current = state;
    let next = current.lastAppendedSequence + 1;

    while (true) {
      const storageKey = this.storage.getChunkStorageKey(sessionId, next);
      const exists = await this.storage.chunkExists(storageKey);
      if (!exists) {
        break;
      }

      const bytes = await this.storage.getChunk(storageKey);
      current = await this.appendDurably(sessionId, current, next, bytes);

      // Only now — after the append is durably committed — may the source chunk go.
      await this.storage.deleteChunk(storageKey);
      console.log(`[VideoAssembler] session=${sessionId} chunk=${next} appended`);

      next += 1;
    }

    return current;
  }

  private async appendDurably(
    sessionId: string,
    state: AssemblyState,
    sequenceNumber: number,
    bytes: Buffer
  ): Promise<AssemblyState> {
    const dir = await this.storage.getAssemblyDir(sessionId);
    const assembledPath = path.join(dir, ASSEMBLED_FILENAME);
    const metaPath = path.join(dir, META_FILENAME);
    const tmpMetaPath = path.join(dir, `${META_FILENAME}.tmp`);

    // 1. Append bytes and fsync — durable before any metadata says this chunk is folded.
    const fh = await fs.promises.open(assembledPath, 'a');
    try {
      await fh.appendFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }

    // 2. Commit the new progress atomically (tmp write + rename), mirroring
    //    LocalStorageAdapter.putChunk's write strategy.
    const newState: AssemblyState = {
      lastAppendedSequence: sequenceNumber,
      byteLength: state.byteLength + bytes.length,
    };
    await fs.promises.writeFile(tmpMetaPath, JSON.stringify(newState));
    await fs.promises.rename(tmpMetaPath, metaPath);

    return newState;
  }
}
