import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'happy-dom',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // Backend integration tests share one live Postgres database (by design — see the
    // M3 architecture review) and each clears its tables in beforeEach. Running test
    // files in parallel lets one file's cleanup wipe rows another file's test is
    // mid-way through using, causing spurious FK violations and 404s. Serializing file
    // execution trades some wall-clock time for correctness against shared state.
    fileParallelism: false,
    // Several backend tests shell out to real ffmpeg/ffprobe subprocesses (deliberately —
    // see video.test.ts) rather than mocking them; the 5s default is too tight for that.
    testTimeout: 30000,
  },
});
