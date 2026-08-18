import { DBSchema, IDBPDatabase } from 'idb';
import { LocalVideoSession, LocalVideoChunk } from '@openplan/contracts';
export declare const DB_NAME = "openplan_recorder_db";
export declare const DB_VERSION = 1;
export interface RecorderDBSchema extends DBSchema {
    sessions: {
        key: string;
        value: LocalVideoSession;
        indexes: {
            createdAt: string;
            status: string;
        };
    };
    chunks: {
        key: [string, number];
        value: LocalVideoChunk;
        indexes: {
            sessionId: string;
            sequenceNumber: number;
        };
    };
}
export declare function getDB(): Promise<IDBPDatabase<RecorderDBSchema>>;
export declare function createSession(session: LocalVideoSession): Promise<void>;
export declare function getSession(sessionId: string): Promise<LocalVideoSession | undefined>;
export declare function updateSession(sessionId: string, updates: Partial<LocalVideoSession>): Promise<void>;
export declare function getAllSessions(): Promise<LocalVideoSession[]>;
export declare function deleteSession(sessionId: string): Promise<void>;
export declare function saveChunk(chunk: LocalVideoChunk): Promise<void>;
export declare function getChunksForSession(sessionId: string): Promise<LocalVideoChunk[]>;
export declare function getMissingSequences(sessionId: string): Promise<number[]>;
