-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('INITIALIZED', 'RECORDING', 'WAITING_FOR_CHUNKS', 'PROCESSING', 'READY', 'INCOMPLETE', 'FAILED');

-- CreateEnum
CREATE TYPE "VideoStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "StorageProvider" AS ENUM ('LOCAL', 'CLOUD');

-- CreateTable
CREATE TABLE "recording_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "sourceTabUrl" TEXT,
    "status" "SessionStatus" NOT NULL DEFAULT 'INITIALIZED',
    "totalChunksExpected" INTEGER,
    "totalChunksReceived" INTEGER NOT NULL DEFAULT 0,
    "gracePeriodEndsAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recording_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recording_chunks" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequenceNumber" INTEGER NOT NULL,
    "checksumSha256" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recording_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "videos" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "VideoStatus" NOT NULL DEFAULT 'PENDING',
    "storageProvider" "StorageProvider" NOT NULL DEFAULT 'LOCAL',
    "storageKey" TEXT,
    "fileName" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "durationMs" INTEGER,
    "processingAttempts" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "videos_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recording_sessions_userId_idx" ON "recording_sessions"("userId");

-- CreateIndex
CREATE INDEX "recording_sessions_status_gracePeriodEndsAt_idx" ON "recording_sessions"("status", "gracePeriodEndsAt");

-- CreateIndex
CREATE UNIQUE INDEX "recording_chunks_sessionId_sequenceNumber_key" ON "recording_chunks"("sessionId", "sequenceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "videos_sessionId_key" ON "videos"("sessionId");

-- AddForeignKey
ALTER TABLE "recording_chunks" ADD CONSTRAINT "recording_chunks_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "recording_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "videos" ADD CONSTRAINT "videos_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "recording_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
