import type { RecordingChunk } from '@prisma/client';
import { prisma } from '../../core/db/prisma.js';

export type DbVideoChunk = RecordingChunk;

export class ChunkRepository {
  public async findBySessionAndSequence(
    sessionId: string,
    sequenceNumber: number
  ): Promise<DbVideoChunk | undefined> {
    const chunk = await prisma.recordingChunk.findUnique({
      where: { sessionId_sequenceNumber: { sessionId, sequenceNumber } },
    });
    return chunk ?? undefined;
  }

  public async findBySessionId(sessionId: string): Promise<DbVideoChunk[]> {
    return prisma.recordingChunk.findMany({
      where: { sessionId },
      orderBy: { sequenceNumber: 'asc' },
    });
  }

  public async save(chunk: DbVideoChunk): Promise<DbVideoChunk> {
    return prisma.recordingChunk.create({ data: chunk });
  }

  public async clear(): Promise<void> {
    await prisma.recordingChunk.deleteMany({});
  }
}

export const chunkRepository = new ChunkRepository();
