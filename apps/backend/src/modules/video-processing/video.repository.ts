import type { Video, Prisma } from '@prisma/client';
import { prisma } from '../../core/db/prisma.js';

export type DbVideo = Video;

export class VideoRepository {
  /**
   * Idempotent claim: creates a PENDING row if none exists for this session, otherwise
   * returns the existing row untouched. `sessionId` is UNIQUE at the schema level, so this
   * can never create a second Video row for the same session — retries always land here.
   */
  public async claim(sessionId: string, userId: string): Promise<DbVideo> {
    return prisma.video.upsert({
      where: { sessionId },
      create: { sessionId, userId, status: 'PENDING' },
      update: {},
    });
  }

  public async findBySessionId(sessionId: string): Promise<DbVideo | undefined> {
    const video = await prisma.video.findUnique({ where: { sessionId } });
    return video ?? undefined;
  }

  public async update(sessionId: string, updates: Prisma.VideoUpdateInput): Promise<DbVideo> {
    return prisma.video.update({ where: { sessionId }, data: updates });
  }

  public async clear(): Promise<void> {
    await prisma.video.deleteMany({});
  }
}

export const videoRepository = new VideoRepository();
