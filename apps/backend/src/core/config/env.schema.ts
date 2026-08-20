import { config as loadDotenv } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve .env relative to this file's location (apps/backend/), not process.cwd() — the
// monorepo's root `npm test`/`npm run typecheck` scripts run from the repo root, which
// would otherwise silently look for a .env that doesn't exist there. Two candidates cover
// both running directly against TS source (src/core/config/...) and the compiled output
// (dist/src/core/config/...), which sit one directory level apart from apps/backend/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const candidate of ['../../../.env', '../../../../.env']) {
  loadDotenv({ path: path.resolve(__dirname, candidate) });
}

export interface EnvironmentVariables {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  STORAGE_LOCAL_DIR: string;
  SESSION_GRACE_PERIOD_MINUTES: number;
  MAX_CHUNK_SIZE_BYTES: number;
  DEFAULT_DEV_USER_ID: string;
  DATABASE_URL: string;
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required (see apps/backend/.env)');
}

export const env: EnvironmentVariables = {
  NODE_ENV: (process.env.NODE_ENV as EnvironmentVariables['NODE_ENV']) || 'development',
  PORT: process.env.PORT ? parseInt(process.env.PORT, 10) : 4000,
  STORAGE_LOCAL_DIR: process.env.STORAGE_LOCAL_DIR || './storage_local',
  SESSION_GRACE_PERIOD_MINUTES: process.env.SESSION_GRACE_PERIOD_MINUTES
    ? parseInt(process.env.SESSION_GRACE_PERIOD_MINUTES, 10)
    : 5,
  MAX_CHUNK_SIZE_BYTES: process.env.MAX_CHUNK_SIZE_BYTES
    ? parseInt(process.env.MAX_CHUNK_SIZE_BYTES, 10)
    : 10485760, // 10MB
  DEFAULT_DEV_USER_ID: process.env.DEFAULT_DEV_USER_ID || 'dev-user-1',
  DATABASE_URL: process.env.DATABASE_URL,
};
