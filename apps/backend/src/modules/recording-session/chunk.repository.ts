export interface DbVideoChunk {
  id: string;
  sessionId: string;
  sequenceNumber: number;
  checksumSha256: string;
  byteSize: number;
  storageKey: string;
  createdAt: Date;
}

export class ChunkRepository {
  private chunks: Map<string, DbVideoChunk> = new Map(); // Key: `${sessionId}:${sequenceNumber}`

  private makeKey(sessionId: string, sequenceNumber: number): string {
    return `${sessionId}:${sequenceNumber}`;
  }

  public async findBySessionAndSequence(
    sessionId: string,
    sequenceNumber: number
  ): Promise<DbVideoChunk | undefined> {
    return this.chunks.get(this.makeKey(sessionId, sequenceNumber));
  }

  public async findBySessionId(sessionId: string): Promise<DbVideoChunk[]> {
    const results: DbVideoChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.sessionId === sessionId) {
        results.push(chunk);
      }
    }
    return results.sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  public async save(chunk: DbVideoChunk): Promise<DbVideoChunk> {
    const key = this.makeKey(chunk.sessionId, chunk.sequenceNumber);
    this.chunks.set(key, { ...chunk });
    return chunk;
  }

  public async clear(): Promise<void> {
    this.chunks.clear();
  }
}

export const chunkRepository = new ChunkRepository();
