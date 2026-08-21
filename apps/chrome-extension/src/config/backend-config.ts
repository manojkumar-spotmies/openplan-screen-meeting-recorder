// Single source of truth for the recording backend's base URL. Every module that talks to
// the backend (sync-worker, service-worker, local-export, the dev Inspector) imports this
// instead of hardcoding its own default, so switching environments only ever requires a
// change here. Vite injects import.meta.env.PROD/DEV at build time based on the `--mode`
// the extension is built with (`vite build` = production, `vite dev`/test runs = development).
const PRODUCTION_BACKEND_BASE_URL = 'https://openplan-screen-meeting-recorder-production.up.railway.app';
const DEVELOPMENT_BACKEND_BASE_URL = 'http://localhost:4000';

export const BACKEND_BASE_URL: string = import.meta.env.PROD
  ? PRODUCTION_BACKEND_BASE_URL
  : DEVELOPMENT_BACKEND_BASE_URL;
