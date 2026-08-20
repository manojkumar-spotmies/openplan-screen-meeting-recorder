import type { RecordingSession } from '@prisma/client';
import { prisma } from '../../core/db/prisma.js';

export type DbVideoSession = RecordingSession;

export class SessionRepository {
  public async findById(id: string): Promise<DbVideoSession | undefined> {
    const session = await prisma.recordingSession.findUnique({ where: { id } });
    return session ?? undefined;
  }

  public async save(session: DbVideoSession): Promise<DbVideoSession> {
    return prisma.recordingSession.create({ data: session });
  }

  public async update(id: string, updates: Partial<DbVideoSession>): Promise<DbVideoSession> {
    try {
      return await prisma.recordingSession.update({
        where: { id },
        data: updates,
      });
    } catch {
      throw new Error(`Session ${id} not found`);
    }
  }

  public async clear(): Promise<void> {
    await prisma.recordingSession.deleteMany({});
  }
}

export const sessionRepository = new SessionRepository();
