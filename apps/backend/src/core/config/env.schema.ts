export interface EnvironmentVariables {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  STORAGE_LOCAL_DIR: string;
  SESSION_GRACE_PERIOD_MINUTES: number;
  MAX_CHUNK_SIZE_BYTES: number;
  DEFAULT_DEV_USER_ID: string;
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
};
