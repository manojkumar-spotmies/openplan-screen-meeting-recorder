import { SessionStatus } from '@openplan/contracts';

export interface DbVideoSession {
  id: string;
  userId: string;
  title: string;
  sourceTabUrl: string | null;
  status: SessionStatus;
  totalChunksExpected: number | null;
  totalChunksReceived: number;
  gracePeriodEndsAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class SessionRepository {
  private sessions: Map<string, DbVideoSession> = new Map();

  public async findById(id: string): Promise<DbVideoSession | undefined> {
    return this.sessions.get(id);
  }

  public async save(session: DbVideoSession): Promise<DbVideoSession> {
    this.sessions.set(session.id, { ...session });
    return session;
  }

  public async update(id: string, updates: Partial<DbVideoSession>): Promise<DbVideoSession> {
    const existing = this.sessions.get(id);
    if (!existing) {
      throw new Error(`Session ${id} not found`);
    }
    const updated: DbVideoSession = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.sessions.set(id, updated);
    return updated;
  }

  public async clear(): Promise<void> {
    this.sessions.clear();
  }
}

export const sessionRepository = new SessionRepository();
