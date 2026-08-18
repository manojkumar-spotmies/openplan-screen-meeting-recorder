import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.schema.js';

export interface AuthenticatedRequest extends Request {
  userId?: string;
}

export function devAuthMiddleware(req: AuthenticatedRequest, _res: Response, next: NextFunction): void {
  const headerUserId = req.headers['x-user-id'];

  if (typeof headerUserId === 'string' && headerUserId.trim().length > 0) {
    req.userId = headerUserId.trim();
  } else {
    // Development default per specification
    req.userId = env.DEFAULT_DEV_USER_ID;
  }

  next();
}
