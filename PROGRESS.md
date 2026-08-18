# PROGRESS — OpenPlan Screen & Meeting Recorder

## Feature F-001 Status: COMPLETE (Milestone 1)
## Feature F-002 Status: IMPLEMENTED (Milestone 2)
## Feature F-005 Status: IMPLEMENTED (Manual Recording Controls / Floating Widget)

---

## Feature F-005 — Manual Recording Controls (Floating Widget)

- [x] Extended `packages/contracts` (`entities.ts`, `messages.ts`) with `isPaused` / `microphoneEnabled` / `systemAudioEnabled` / `hasMicrophone` / `hasSystemAudio` on `LocalVideoSession`, four new `ExtensionAction`s (`PAUSE_RECORDING`, `RESUME_RECORDING`, `SET_MICROPHONE_ENABLED`, `SET_SYSTEM_AUDIO_ENABLED`), and matching payload/response types.
- [x] Extended `RecorderService` (`recorder.service.ts`) with `pauseRecording()` / `resumeRecording()` (native `MediaRecorder.pause()`/`resume()`) and `setMicrophoneEnabled()` / `setSystemAudioEnabled()` (mute via `MediaStreamTrack.enabled`, same composite stream/audio graph — no second `AudioContext` or pipeline).
- [x] Extended `offscreen.ts` and `service-worker.ts` to route the four new actions through the existing message pipeline and broadcast updated state via the existing `RECORDING_STATE_CHANGED` channel.
- [x] Added `src/content/recording-widget.tsx`: a small floating control injected into `meet.google.com` tabs (shadow-DOM isolated), collapsed-icon → expanded-panel UI, reading RecorderService state as the single source of truth (no independent UI state).
- [x] Added `"type": "module"` to the `meet.google.com` content_scripts entry in `manifest.json` (required for the widget's ES-module bundle; also fixes a latent load failure in the pre-existing `meet-detector.js`, which already emitted `import` statements without this flag).
- [x] Superseded AC-M2-17 (see `FEATURE-SPEC-F-002` Section 10 and `PRD.md` Section 8, Feature F-005). F-002's chunking/sync/stop-finalization logic is unchanged; F-005 only adds a UI entry point calling the same pipeline.
- [x] Tests: `recorder.service.test.ts` (pause/resume, mic/system-audio toggle, independence from stop) and new `recording-widget.test.tsx` (collapse/expand, outside-click collapse, stop/pause/resume/mic/system-audio wiring, live state sync, non-blocking error toast).

---

## Feature F-002 Tasks Breakdown (Milestone 2)

- [x] **Task 1: F-002 Shared Contracts & API Envelopes**
  - Updated `packages/contracts/src/entities.ts` (`LocalVideoChunk`, `VideoSession`, `VideoChunk`, `SessionManifest`).
  - Updated `packages/contracts/src/api.ts` (REST payload/response interfaces for `/init`, `/chunks`, `/stop`).
  - Updated `packages/contracts/src/messages.ts` (`ExternalStartRecordingMessage`).

- [x] **Task 2: Backend Application Bootstrap & Infrastructure (`apps/backend`)**
  - Created `apps/backend` package layout, `package.json`, and `tsconfig.json`.
  - Configured `env.schema.ts` (`STORAGE_LOCAL_DIR`, `SESSION_GRACE_PERIOD_MINUTES`, `MAX_CHUNK_SIZE_BYTES`).
  - Implemented `devAuthMiddleware` (`x-user-id: dev-user-1`).
  - Implemented `IStorageProvider` and `LocalStorageAdapter` with atomic two-step write protocol (`.tmp` → SHA-256 hash & size verification → `.webm` zero-padded 6-digit sequence).

- [x] **Task 3: Backend Recording Session Module & REST Ingestion**
  - Implemented state machine (`session-state.machine.ts`) enforcing `INITIALIZED` → `RECORDING` → `STOPPED` → `PROCESSING` / `WAITING_FOR_CHUNKS` → `PROCESSING` / `INCOMPLETE`.
  - Implemented `SessionRepository` and `ChunkRepository`.
  - Implemented `SessionService`:
    - `POST /api/v1/sessions/init`: Idempotent session initialization.
    - `POST /api/v1/sessions/:sessionId/chunks`: SHA-256 verification (rejecting `ERR_CHECKSUM_MISMATCH`), 10MB size limit (`ERR_CHUNK_SIZE_EXCEEDED`), MIME validation (`ERR_INVALID_MIME_TYPE`), duplicate same-hash ACK (`isDuplicate: true`), duplicate conflicting-hash rejection (`ERR_DUPLICATE_SEQUENCE_CONFLICT`), out-of-order & concurrent uploads.
    - `POST /api/v1/sessions/:sessionId/stop`: Manifest validation, 5-minute grace period (`WAITING_FOR_CHUNKS`), zero-chunk stop (`INCOMPLETE`), late chunk rejection (`ERR_SESSION_EXPIRED`).
  - Express controller (`session.controller.ts`) and app bootstrapper (`app.ts`).

- [x] **Task 4: Chrome Extension Sync Worker & IDB Upgrade**
  - Upgraded IndexedDB schema in `idb-store.ts` to `DB_VERSION = 2` with `synced` index.
  - Added `computeSha256`, `getUnsyncedChunks`, and `markChunkSyncedAndPurgeBlob`.
  - Implemented `SyncWorker` (`sync-worker.ts`) with max concurrency 2, exponential backoff (1s, 2s, 4s, 8s, 16s ±200ms jitter), max 5 retries, offline pause/resume, and safe IDB blob purging post-ACK.

- [x] **Task 5: External Web Trigger & Meeting End Integration**
  - Updated `manifest.json` with `externally_connectable` allowed origins (`https://*.openplan.ai/*`, `http://localhost/*`).
  - Implemented `chrome.runtime.onMessageExternal` in `service-worker.ts` with origin security validation (`ERR_UNAUTHORIZED_ORIGIN`).
  - Integrated REST `/init` & `/stop` handshakes and sync worker backlog queue drain with recording lifecycle.
  - Added Google Meet call-end DOM screen observer in `meet-detector.ts`.

- [x] **Task 6: Automated Test Suites**
  - Backend unit and integration test suite (`session.test.ts` covering 20 test cases).
  - Extension sync worker test suite (`sync-worker.test.ts` covering concurrency limit, safe purge, retry backoff, and offline handling).

---

## Acceptance Criteria Verification Matrix (AC-M2-01 to AC-M2-17)

| AC # | Description | Status | Verification Type | Notes / Results |
|---|---|---|---|---|
| **AC-M2-01** | External `START_RECORDING` message validates origin security, calls `/init`, and starts recording | **PASSED** | CODE & AUTOMATED VERIFIED | Handled in `service-worker.ts` & `messages.ts` |
| **AC-M2-02** | Unauthorized web domain rejects message with `ERR_UNAUTHORIZED_ORIGIN` | **PASSED** | CODE & AUTOMATED VERIFIED | Verified origin check in `service-worker.ts` |
| **AC-M2-03** | 5s WebM chunks persisted to IDB with 64-char SHA-256 checksums and sequence numbers 1..N | **PASSED** | AUTOMATED VERIFIED | Verified in `idb-store.ts` & unit tests |
| **AC-M2-04** | `sync-worker.ts` uploads pending chunks to `/chunks` with concurrency limit max 2 | **PASSED** | AUTOMATED VERIFIED | Verified in `sync-worker.test.ts` |
| **AC-M2-05** | Backend recalculates SHA-256 hash from raw binary data, rejecting mismatches with HTTP 400 `ERR_CHECKSUM_MISMATCH` | **PASSED** | AUTOMATED VERIFIED | Verified in `session.test.ts` |
| **AC-M2-06** | `LocalStorageAdapter` writes chunk to `.tmp`, verifies length & SHA-256, and atomically renames to zero-padded `.webm` | **PASSED** | AUTOMATED VERIFIED | Verified in `local-storage.adapter.ts` & unit tests |
| **AC-M2-07** | Duplicate chunk with identical sequence & SHA-256 returns HTTP 200 `isDuplicate: true` without rewriting storage | **PASSED** | AUTOMATED VERIFIED | Verified in `session.test.ts` |
| **AC-M2-08** | Duplicate sequence with conflicting SHA-256 returns HTTP 409 `ERR_DUPLICATE_SEQUENCE_CONFLICT` without overwriting | **PASSED** | AUTOMATED VERIFIED | Verified in `session.test.ts` |
| **AC-M2-09** | Successful HTTP 200 ACK sets `synced = true` and purges binary `blob = undefined` while retaining audit metadata | **PASSED** | AUTOMATED VERIFIED | Verified in `sync-worker.test.ts` |
| **AC-M2-10** | Synced IDB record skips re-uploading chunk payload if sync pass re-executes | **PASSED** | AUTOMATED VERIFIED | Verified in `idb-store.ts` & `sync-worker.ts` |
| **AC-M2-11** | Failed upload retries using exponential backoff (1s..16s ±200ms jitter) up to 5 attempts | **PASSED** | AUTOMATED VERIFIED | Verified in `sync-worker.test.ts` |
| **AC-M2-12** | Network disconnection pauses uploads; resumes uploading IndexedDB backlog when connectivity returns | **PASSED** | AUTOMATED VERIFIED | Verified in `sync-worker.ts` |
| **AC-M2-13** | Automatic meeting end flushes final chunk and submits `/stop` manifest | **PASSED** | CODE VERIFIED | Verified in `service-worker.ts` & `meet-detector.ts` |
| **AC-M2-14** | Complete stop manifest with all sequences 1..N transitions status from `STOPPED` to `PROCESSING` | **PASSED** | AUTOMATED VERIFIED | Verified in `session.test.ts` |
| **AC-M2-15** | Stop manifest with missing sequence numbers transitions to `WAITING_FOR_CHUNKS` with 5m grace period | **PASSED** | AUTOMATED VERIFIED | Verified in `session.test.ts` |
| **AC-M2-16** | Missing chunk arriving before grace period transitions to `PROCESSING`; late chunk after grace returns `ERR_SESSION_EXPIRED` | **PASSED** | AUTOMATED VERIFIED | Verified in `session.test.ts` |
| **AC-M2-17** | *(Superseded by F-005 — see below)* No participant-facing Stop/Pause/Resume controls exposed; Chrome native stop-sharing bar remains browser-level security UI | **SUPERSEDED** | DESIGN & CODE VERIFIED | Original constraint retained for history; see `FEATURE-SPEC-F-002` Section 10 AC-M2-17/AC-M2-17a |

---

## Edge Case Matrix (E-01 to E-29 Status)

| Edge Case | Description | Status | Verification Type |
|---|---|---|---|
| **E-01** | Unauthorized web origin calls `START_RECORDING` | **PASSED** | CODE & AUTOMATED VERIFIED |
| **E-02** | `START_RECORDING` called when session already active | **PASSED** | CODE & AUTOMATED VERIFIED |
| **E-03** | Microphone permission denied by user | **PASSED** | CODE VERIFIED (F-001 intact) |
| **E-04** | System audio unavailable | **PASSED** | CODE VERIFIED (F-001 intact) |
| **E-05** | Native Chrome "Stop sharing" bar clicked | **PASSED** | CODE VERIFIED (F-001 intact) |
| **E-06** | Monitored Google Meet tab closed | **PASSED** | CODE VERIFIED (F-001 intact) |
| **E-07** | Meet tab navigated to non-Meet URL | **PASSED** | CODE VERIFIED (F-001 intact) |
| **E-08** | Network connection lost mid-recording | **PASSED** | AUTOMATED VERIFIED |
| **E-09** | Network connection restored after drop | **PASSED** | AUTOMATED VERIFIED |
| **E-10** | Duplicate chunk upload with identical checksum | **PASSED** | AUTOMATED VERIFIED |
| **E-11** | Duplicate sequence upload with conflicting checksum | **PASSED** | AUTOMATED VERIFIED |
| **E-12** | SHA-256 checksum mismatch | **PASSED** | AUTOMATED VERIFIED |
| **E-13** | Chunk file size exceeds 10MB | **PASSED** | AUTOMATED VERIFIED |
| **E-14** | Invalid MIME type uploaded | **PASSED** | AUTOMATED VERIFIED |
| **E-15** | Out-of-order chunk uploads | **PASSED** | AUTOMATED VERIFIED |
| **E-16** | Concurrent chunk uploads | **PASSED** | AUTOMATED VERIFIED |
| **E-17** | Backend REST server unavailable | **PASSED** | AUTOMATED VERIFIED |
| **E-18** | IDB purge failure post-ACK | **PASSED** | AUTOMATED VERIFIED |
| **E-19** | Backend disk write failure | **PASSED** | CODE VERIFIED |
| **E-20** | `/stop` called before any chunks arrive | **PASSED** | AUTOMATED VERIFIED |
| **E-21** | `/stop` called with missing sequence numbers | **PASSED** | AUTOMATED VERIFIED |
| **E-22** | Missing chunk arrives during 5m grace period | **PASSED** | AUTOMATED VERIFIED |
| **E-23** | Missing chunk arrives after 5m grace period expires | **PASSED** | AUTOMATED VERIFIED |
| **E-24** | Repeated `/stop` request submitted | **PASSED** | AUTOMATED VERIFIED |
| **E-25** | Service Worker suspended mid-recording | **PASSED** | CODE VERIFIED (F-001 intact) |
| **E-26** | `POST /init` repeated for active session | **PASSED** | AUTOMATED VERIFIED |
| **E-27** | Chunk upload attempted on session in `PROCESSING` | **PASSED** | AUTOMATED VERIFIED |
| **E-28** | Chunk upload attempted on session in `INCOMPLETE` | **PASSED** | AUTOMATED VERIFIED |
| **E-29** | Missing `x-user-id` header | **PASSED** | CODE VERIFIED (Defaulted to `dev-user-1`) |
