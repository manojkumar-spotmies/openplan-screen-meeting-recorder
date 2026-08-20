import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { IStorageProvider } from './storage.interface.js';
import { env } from '../config/env.schema.js';

export class LocalStorageAdapter implements IStorageProvider {
  private baseDir: string;

  constructor(baseDir: string = env.STORAGE_LOCAL_DIR) {
    this.baseDir = path.resolve(baseDir);
  }

  public async putChunk(sessionId: string, sequenceNumber: number, data: Buffer): Promise<string> {
    const sessionDir = path.join(this.baseDir, 'sessions', sessionId);
    await fs.promises.mkdir(sessionDir, { recursive: true });

    const zeroPaddedSeq = String(sequenceNumber).padStart(6, '0');
    const fileName = `chunk-${zeroPaddedSeq}.webm`;
    const tmpPath = path.join(sessionDir, `${fileName}.tmp`);
    const finalPath = path.join(sessionDir, fileName);

    // 1. Write binary bytes to .tmp file
    await fs.promises.writeFile(tmpPath, data);

    try {
      // 2. Verify byte length
      const stats = await fs.promises.stat(tmpPath);
      if (stats.size !== data.length) {
        throw new Error(`Byte size mismatch on disk: wrote ${data.length}, stat is ${stats.size}`);
      }

      // 3. Recalculate SHA-256
      const fileBuffer = await fs.promises.readFile(tmpPath);
      const computedSha256 = crypto.createHash('sha256').update(fileBuffer).digest('hex');
      const expectedSha256 = crypto.createHash('sha256').update(data).digest('hex');

      if (computedSha256 !== expectedSha256) {
        throw new Error('Temp file checksum verification failed during atomic write');
      }

      // 4. Atomic rename .tmp -> .webm
      await fs.promises.rename(tmpPath, finalPath);

      // Return relative storage key
      return path.join('sessions', sessionId, fileName).replace(/\\/g, '/');
    } catch (err) {
      // Cleanup .tmp on error
      if (fs.existsSync(tmpPath)) {
        await fs.promises.unlink(tmpPath).catch(() => {});
      }
      throw err;
    }
  }

  public async getChunk(storageKey: string): Promise<Buffer> {
    const fullPath = path.join(this.baseDir, storageKey);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Storage file not found: ${storageKey}`);
    }
    return fs.promises.readFile(fullPath);
  }

  public getChunkPath(storageKey: string): string {
    return path.join(this.baseDir, storageKey);
  }

  public async getProcessingScratchDir(sessionId: string): Promise<string> {
    const scratchDir = path.join(this.baseDir, 'sessions', sessionId, 'processing');
    await fs.promises.mkdir(scratchDir, { recursive: true });
    return scratchDir;
  }

  public async saveFinalVideo(sessionId: string, sourceFilePath: string, fileName: string): Promise<string> {
    const finalDir = path.join(this.baseDir, 'sessions', sessionId, 'final');
    await fs.promises.mkdir(finalDir, { recursive: true });

    const finalPath = path.join(finalDir, fileName);
    // Atomic on the same filesystem — source lives under the same session directory.
    await fs.promises.rename(sourceFilePath, finalPath);

    return path.join('sessions', sessionId, 'final', fileName).replace(/\\/g, '/');
  }

  public getFinalVideoPath(storageKey: string): string {
    return path.join(this.baseDir, storageKey);
  }

  public async finalVideoExists(sessionId: string): Promise<boolean> {
    const finalPath = path.join(this.baseDir, 'sessions', sessionId, 'final', 'meeting.webm');
    return fs.existsSync(finalPath);
  }

  public async deleteSession(sessionId: string): Promise<void> {
    const sessionDir = path.join(this.baseDir, 'sessions', sessionId);
    if (fs.existsSync(sessionDir)) {
      await fs.promises.rm(sessionDir, { recursive: true, force: true });
    }
  }
}
