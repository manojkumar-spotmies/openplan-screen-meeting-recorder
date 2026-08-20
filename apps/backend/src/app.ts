import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { devAuthMiddleware } from './core/middleware/auth.middleware.js';
import { sessionRouter } from './modules/recording-session/session.controller.js';
import { env } from './core/config/env.schema.js';
import { ApiErrorResponse } from '@openplan/contracts';

export function createApp(): Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Minimal request logging — there was none before, which made silent failures (like a
  // fetch() from the extension failing before ever reaching a route) invisible in the
  // terminal. Skipped under tests to keep vitest output clean.
  if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`);
      });
      next();
    });
  }

  app.use(devAuthMiddleware);

  // Mount API V1 session routes
  app.use('/api/v1/sessions', sessionRouter);

  // Global 404 handler
  app.use((_req: Request, res: Response) => {
    const errorResponse: ApiErrorResponse = {
      success: false,
      error: {
        code: 'ERR_NOT_FOUND',
        message: 'Endpoint not found',
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: `req-${crypto.randomUUID()}`,
      },
    };
    res.status(404).json(errorResponse);
  });

  // Global Error Handler
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    const errorResponse: ApiErrorResponse = {
      success: false,
      error: {
        code: 'ERR_INTERNAL_SERVER_ERROR',
        message: err.message || 'An unexpected error occurred',
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: `req-${crypto.randomUUID()}`,
      },
    };
    res.status(500).json(errorResponse);
  });

  return app;
}

export const app = createApp();

if (process.env.NODE_ENV !== 'test' && !process.env.VITEST) {
  const port = env.PORT;
  app.listen(port, () => {
    console.log(`OpenPlan Backend running on port ${port}`);
  });
}
