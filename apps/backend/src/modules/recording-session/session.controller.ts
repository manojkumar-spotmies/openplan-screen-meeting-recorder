import { Router, Response } from 'express';
import multer from 'multer';
import { AuthenticatedRequest } from '../../core/middleware/auth.middleware.js';
import { sessionService, SessionServiceError } from './session.service.js';
import { ApiResponse, ApiErrorResponse } from '@openplan/contracts';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10485760 }, // 10MB limit
});

export const sessionRouter = Router();

// Helper to build success envelope
function sendSuccess<T>(res: Response, data: T, statusCode: number = 200) {
  const envelope: ApiResponse<T> = {
    success: true,
    data,
    meta: {
      timestamp: new Date().toISOString(),
      requestId: `req-${crypto.randomUUID()}`,
    },
  };
  return res.status(statusCode).json(envelope);
}

// Helper to build error envelope
function sendError(res: Response, code: string, message: string, statusCode: number = 400) {
  const envelope: ApiErrorResponse = {
    success: false,
    error: {
      code,
      message,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: `req-${crypto.randomUUID()}`,
    },
  };
  return res.status(statusCode).json(envelope);
}

// POST /api/v1/sessions/init
sessionRouter.post('/init', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId, title, sourceTabUrl } = req.body || {};
    const userId = req.userId || 'dev-user-1';

    const session = await sessionService.initSession({
      sessionId,
      userId,
      title,
      sourceTabUrl,
    });

    return sendSuccess(res, {
      sessionId: session.id,
      userId: session.userId,
      title: session.title,
      status: session.status,
      createdAt: session.createdAt.toISOString(),
    });
  } catch (err) {
    if (err instanceof SessionServiceError) {
      return sendError(res, err.code, err.message, err.statusCode);
    }
    return sendError(res, 'ERR_INTERNAL_SERVER_ERROR', err instanceof Error ? err.message : String(err), 500);
  }
});

// POST /api/v1/sessions/:sessionId/chunks
sessionRouter.post('/:sessionId/chunks', upload.single('chunk'), async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.userId || 'dev-user-1';
    const { sequenceNumber, checksumSha256 } = req.body || {};
    const file = req.file;

    if (!sequenceNumber) {
      return sendError(res, 'ERR_INVALID_PAYLOAD', 'sequenceNumber is required', 400);
    }
    if (!checksumSha256) {
      return sendError(res, 'ERR_CHECKSUM_MISMATCH', 'checksumSha256 is required', 400);
    }
    if (!file || !file.buffer) {
      return sendError(res, 'ERR_INVALID_PAYLOAD', 'chunk binary payload is required', 400);
    }

    const parsedSeq = parseInt(sequenceNumber, 10);
    if (isNaN(parsedSeq) || parsedSeq < 1) {
      return sendError(res, 'ERR_INVALID_PAYLOAD', 'sequenceNumber must be a positive 1-indexed integer', 400);
    }

    const result = await sessionService.ingestChunk({
      sessionId,
      userId,
      sequenceNumber: parsedSeq,
      checksumSha256,
      buffer: file.buffer,
      mimeType: file.mimetype || 'video/webm',
    });

    return sendSuccess(res, result, 200);
  } catch (err) {
    if (err instanceof SessionServiceError) {
      return sendError(res, err.code, err.message, err.statusCode);
    }
    return sendError(res, 'ERR_INTERNAL_SERVER_ERROR', err instanceof Error ? err.message : String(err), 500);
  }
});

// POST /api/v1/sessions/:sessionId/stop
sessionRouter.post('/:sessionId/stop', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { sessionId } = req.params;
    const userId = req.userId || 'dev-user-1';
    const manifest = req.body;

    if (typeof manifest?.totalChunks !== 'number') {
      return sendError(res, 'ERR_INVALID_PAYLOAD', 'manifest.totalChunks is required', 400);
    }

    const result = await sessionService.stopSession({
      sessionId,
      userId,
      manifest: {
        sessionId,
        totalChunks: manifest.totalChunks,
        sequenceChecksums: manifest.sequenceChecksums || {},
        finalChunkTimestamp: manifest.finalChunkTimestamp || new Date().toISOString(),
      },
    });

    return sendSuccess(res, result, 200);
  } catch (err) {
    if (err instanceof SessionServiceError) {
      return sendError(res, err.code, err.message, err.statusCode);
    }
    return sendError(res, 'ERR_INTERNAL_SERVER_ERROR', err instanceof Error ? err.message : String(err), 500);
  }
});
