# Openplan Screen & Meeting Recorder â€” Product Requirements Document

**Version:** 1.0 â€” Draft
**Status:** Draft
**Document Owner:** Product Team
**Contributors:** Engineering, Core Platform Team
**Created:** 2026-08-13
**Classification:** Internal | Confidential

**Intended Audience:**
| Reader | Sections of Primary Interest |
|--------|------------------------------|
| Engineering | 6, 7, 8, 9, 10, 11, 12 |
| Product / Design | 2, 3, 4, 5, 7, 8, 9 |
| Executive / Stakeholder | 1, 2, 3, 5, 13 |
| QA / Testing | 8, 9, 10 |

---

## 1. EXECUTIVE SUMMARY

The Openplan Screen & Meeting Recorder is a custom-built Google Chrome extension coupled with a cloud-processing backend, designed exclusively for internal team collaboration. It seamlessly captures entire screens, system audio, and microphone inputs without requiring third-party subscriptions like Google Meet recordings. 

By building this internally, the organization eliminates recurring SaaS costs, gains absolute control over proprietary data privacy, and solves critical network-drop issues. The system achieves high reliability by chunking recorded media every 5 seconds, caching them locally during offline periods, and automatically syncing them to an internal cloud backend for stitching and domain-restricted viewing.

---

## 2. PROBLEM STATEMENT

### 2.1 The Problem
Recording internal meetings and communications currently relies on expensive third-party subscriptions (e.g., Google Meet premium plans). Furthermore, traditional recording tools process large monolithic files, which are highly susceptible to total data loss if a user experiences a network drop mid-recording. 

### 2.2 Current Workarounds
The team uses either expensive Google Meet integrated recordings or separate unintegrated desktop apps. This fragments workflows, increases costs, and creates security overhead in managing who has access to which recording link.

### 2.3 The Consequence of Inaction
Continuing with third-party subscriptions limits budget allocation for other critical infrastructure. Relying on local desktop recorders risks data loss and introduces friction when sharing videos internally.

### 2.4 The Opportunity
By deploying an internal Chrome extension linked to the existing 'Openplan' ecosystem, we can enable one-click, highly resilient recording that is instantly available on our internal platform with strict domain-level access control.

---

## 3. GOALS & SUCCESS METRICS

### 3.1 Product Goals
| ID | Goal | Type | Description |
|----|------|------|-------------|
| G-01 | Cost Reduction | Business | Replace Google Meet recording subscriptions. |
| G-02 | Reliability | Quality | Zero data loss on network failure up to 30 mins using 5s chunking. |
| G-03 | Privacy | Compliance | Recordings accessible strictly from the Openplan domain. |

### 3.2 Key Results & Success Metrics
| Metric | Target | Timeframe | Measurement Method |
|--------|--------|-----------|-------------------|
| Network failure recovery rate | 99% | 30 days post-launch | Telemetry on chunk sync |
| Memory usage in browser | < 300MB | Per session | Performance profiling |

### 3.3 Non-Goals
| Non-Goal | Rationale | Planned For |
|----------|-----------|-------------|
| Video editing/trimming | Unnecessary complexity for MVP | Future |
| Cross-browser support | Team standardizes on Chrome | Never |

---

## 4. TARGET USERS

### 4.1 User Types & Roles
| User Type | Description | Primary Goal | Technical Level |
|-----------|-------------|--------------|-----------------|
| Internal Team Member | Standard employee | Record a sync/meeting | Low / Med |

### 4.2 Roles, Permissions & Access Control
| Role | Resource | Create | Read | Update | Delete | Notes |
|------|----------|--------|------|--------|--------|-------|
| Member | Video | âœ… | âœ… | âŒ | âŒ | Can view if link is shared |
| Admin | Video | âœ… | âœ… | âœ… | âœ… | Backend control |

---

## 5. MARKET & BUSINESS CONTEXT

### 5.1 Target Market
Internal usage only. Bound to the Openplan internal ecosystem.

### 5.2 Monetization Model
N/A - Internal cost-saving tool.

---

## 6. SCOPE

### 6.1 In Scope â€” This Version
| ID | Item | Rationale |
|----|------|-----------|
| IS-01 | Chrome Extension UI | Start/Stop recording controls |
| IS-02 | 5-sec Chunking Engine | Resiliency against network drops |
| IS-03 | Offline Caching (IndexedDB) | Store chunks if network drops |
| IS-04 | Backend Video Stitching | Merge chunks into playable file |
| IS-05 | Auto-Auth Integration | Seamless identity via Openplan session |

### 6.2 Out of Scope â€” This Version
| Feature | Reason Deferred |
|---------|----------------|
| Firefox/Safari support | Team uses Chrome exclusively |
| In-browser Video Editor | Too complex for v1.0 |

---

## 7. USER STORIES

| ID | User Story | Priority | Linked Feature |
|----|-----------|----------|----------------|
| US-001 | As a user, I want to click one button to start recording my screen, mic, and system audio. | ðŸ”´ P0 | F-001 |
| US-002 | As a user on a bad connection, I want my recording to sync in small chunks so I don't lose the whole video. | ðŸ”´ P0 | F-002 |
| US-003 | As a user without mic permissions, I want to be warned but still be able to record the screen. | ðŸŸ  P1 | F-001 |
| US-004 | As a user, I want the recording to auto-stop if I close or leave the Google Meet tab. | ðŸŸ¡ P2 | F-004 |
| US-005 | As a user, I want a small floating control while recording so I can stop, pause/resume, or mute my mic/system audio without opening the extension popup. | ðŸŸ¡ P2 | F-005 |

---

## 8. FEATURE REQUIREMENTS

### Feature F-001 â€” Core Recording Engine
**Priority:** ðŸ”´ P0
**Summary:** Capture screen, system audio, and mic via Chrome WebRTC APIs.

#### Functional Requirements
| Req ID | Requirement | Priority |
|--------|-------------|----------|
| F-001-R01 | The system **must** capture the full screen at 720p default resolution. | ðŸ”´ P0 |
| F-001-R02 | The system **must** request Mic permissions. If denied, show a toast warning and fallback to screen-only if user confirms. | ðŸŸ  P1 |
| F-001-R03 | The system **must** record indefinitely (no hard time limit). | ðŸ”´ P0 |

#### Acceptance Criteria
- [ ] User can select screen to share.
- [ ] Output includes both system audio and microphone.
- [ ] If mic is denied, warning toast appears: "Mic not enabled. Continue without audio?"

### Feature F-002 â€” Resilient Chunking & Upload
**Priority:** ðŸ”´ P0
**Summary:** Slice recording into 5-second blobs and upload immediately to clear RAM.

#### Functional Requirements
| Req ID | Requirement | Priority |
|--------|-------------|----------|
| F-002-R01 | The system **must** output data in 5-second chunks using `MediaRecorder.start(5000)`. | ðŸ”´ P0 |
| F-002-R02 | The system **must** clear uploaded chunks from browser memory (Garbage Collection) immediately upon successful upload API 200 response. | ðŸ”´ P0 |
| F-002-R03 | The system **must** save chunks to IndexedDB if network is offline, and sync when online. | ðŸ”´ P0 |

### Feature F-003 â€” Backend Video Stitching
**Priority:** ðŸ”´ P0
**Summary:** Cloud backend receives chunks and stitches them into a final MP4/WebM file.

#### Functional Requirements
| Req ID | Requirement | Priority |
|--------|-------------|----------|
| F-003-R01 | The backend **must** order incoming chunks securely using sequence IDs. | ðŸ”´ P0 |
| F-003-R02 | The backend **must** trigger an FFmpeg stitching job upon receiving the "STOP" event. | ðŸ”´ P0 |

### Feature F-004 â€” Auto-Stop Monitor
**Priority:** ðŸŸ¡ P2
**Summary:** Detect when a Google Meet tab is closed or disconnected to stop recording.

#### Functional Requirements
| Req ID | Requirement | Priority |
|--------|-------------|----------|
| F-004-R01 | The extension **will** monitor the DOM or tab state of `meet.google.com`. | ðŸŸ¡ P2 |

### Feature F-005 â€” Manual Recording Controls (Floating Widget)
**Priority:** ðŸŸ¡ P2
**Summary:** A small floating control, injected into the Google Meet tab while a recording is active, giving the user direct control over Stop, Pause/Resume, Microphone, and System Audio without opening the extension popup. Supersedes the original AC-M2-17 restriction (see FEATURE-SPEC-F-002 Section 10 and PROGRESS.md) which assumed no participant-facing controls would ever be exposed.

#### Functional Requirements
| Req ID | Requirement | Priority |
|--------|-------------|----------|
| F-005-R01 | The extension **must** show a compact, unobtrusive recording indicator while a recording is active, without blocking the Meet UI or Chrome's native "Stop sharing" bar. | ðŸŸ¡ P2 |
| F-005-R02 | Clicking the indicator **must** expand a small panel with Stop Recording, Microphone toggle, System Audio toggle, and Pause/Resume Recording. | ðŸŸ¡ P2 |
| F-005-R03 | Stop **must** invoke the existing F-001/F-002 stop-and-finalize flow (final chunk flush, sync drain, `/stop` manifest) unmodified. | ðŸ”´ P0 |
| F-005-R04 | Pause/Resume **must** only pause/resume the `MediaRecorder`; it must never call `/stop` or discard the session. | ðŸ”´ P0 |
| F-005-R05 | Microphone/System Audio toggles **must** mute/unmute the existing track(s) in place (no new `AudioContext`, no second recording pipeline) and act independently of each other and of Pause/Stop. | ðŸ”´ P0 |
| F-005-R06 | Automatic meeting-end detection (tab close, navigation, Meet DOM "left the call", `beforeunload`, native stop bar) **must** continue to stop/finalize the session regardless of paused/muted state. | ðŸ”´ P0 |

---

## 9. USER FLOWS

### Flow UF-001 â€” Happy Path Recording
1. User clicks Extension icon.
2. System auto-authenticates using Openplan cookies.
3. User clicks "Start". Chrome prompts for Screen/Mic.
4. User approves. Recording starts.
5. System slices data every 5s and uploads to Backend.
6. User clicks "Stop". 
7. System sends final chunk and "STOP" signal.
8. Backend processes video. Extension opens a new tab to Openplan Video URL.

---

## 10. NON-FUNCTIONAL REQUIREMENTS

### 10.1 Performance & Memory Constraints
| Requirement | Target | Priority |
|-------------|--------|----------|
| Browser RAM Usage | Must not grow linearly. Old chunks MUST be purged from `Blob` arrays after upload. | ðŸ”´ P0 |
| Backend processing time | Final video ready within 2 minutes of stopping. | ðŸŸ  P1 |

### 10.2 Security & Compliance
| Requirement | Standard | Enforcement |
|-------------|----------|-------------|
| Domain Restriction | Video links only resolve inside `openplan` domain | CORS & Signed S3 URLs |
| Data Retention | Videos deleted after 30 days | S3 / Railway Lifecycle Policy |
| Auth Seamlessness | No explicit login required | Validate domain cookies |

---

## 11. INTEGRATIONS

| Integration | Purpose | Direction |
|-------------|---------|-----------|
| Openplan API | User Authentication / Session | Inbound |
| Railway / S3 | Blob storage for chunks and final video | Outbound |

---

## 12. DATA REQUIREMENTS

### 12.1 Core Entities
- **VideoSession:** `session_id`, `user_id`, `start_time`, `status`
- **VideoChunk:** `chunk_id`, `session_id`, `sequence_number`, `s3_key`

---

## 13. OPEN QUESTIONS
| ID | Question | Impact | Owner | Status |
|----|---------|--------|-------|--------|
| Q-01 | Can we reliably read Google Meet's DOM to detect "Call Ended" without violating Chrome store policies? | Affects Auto-stop feature | Engineering | Open |

---

## 14. RISKS & MITIGATIONS
| Risk | Impact | Mitigation |
|------|--------|------------|
| Browser Memory Leak on long calls | Critical | Strict code reviews on Blob array clearing and IndexedDB limits. |
