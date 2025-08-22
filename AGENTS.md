# Agent Instructions

- Run `npm test` inside the `mylab` directory to execute the Vitest suite before committing.
- No additional lint steps are required.
- If you modify files, ensure formatting via existing project configuration.
- The TransT tracking server is available at `http://localhost:7000`.

## Project Layout and Roadmap

### Frontend (`mylab`)

- **Entry & Root**
  - `src/main.tsx` (lines 1-10) – React entry point.
  - `src/App.tsx` (lines 9-174) – Root component handling projects and tasks.
    - Project creation handler (lines 18-26)
    - Task creation handler (lines 28-68)
    - Project deletion handler (lines 78-87)
    - Task deletion handler (lines 89-95)

- **SequenceLabeler**
  - `src/SequenceLabeler/SequenceLabeler.tsx` (lines 51-400+) – Main labeling UI.
    - Track management (`applyTracks`, `undo`, `redo`) (lines 99-128)
    - Directory import (`loadFromDir`) (lines 213-255)
    - Index loading effect (lines 283-339)
    - Autosave effect (lines 383-400)
  - `src/SequenceLabeler/SLTopBar.tsx` (lines 24-79) – TopBar and frame controls.
  - `src/SequenceLabeler/SLTimelineSection.tsx` (lines 31-105) – Timeline and keyframe section.
  - `src/SequenceLabeler/SLRightPanel.tsx` (lines 27-224) – Right-side panel for label sets and tracks.

- **Shared Components**
  - `src/components/Timeline.tsx` (lines 21-223) – Timeline visualization.
  - `src/components/TrackPanel.tsx` (lines 14-129) – Track list and editing UI.
  - `src/components/ShortcutModal.tsx` (lines 36-100) – Shortcut configuration modal.
  - `src/components/ErrorBoundary.tsx` (lines 5-29) – Error boundary wrapper.

- **Libraries & Utilities**
  - `src/lib/ProjectManager.ts` (lines 1-79) – Manage projects and tasks via localStorage.
  - `src/lib/LRUFrames.ts` (lines 1-21) – LRU cache for frame bitmaps.
  - `src/utils/geom.ts` (lines 1-65) – Geometry helpers and keyframe interpolation.
  - `src/utils/handles.ts` (lines 1-50) – IndexedDB storage for directory handles.
  - `src/utils/keys.ts` (lines 1-21) – Key string parsing and normalization.
  - `src/utils/debug.ts` (lines 1-13) – Error injection utility.

### Backend (`Docker`)

- `Docker/main.py` (lines 1-197) – FastAPI endpoints: frame counting, TransT server startup, YOLO export.
- `Docker/transt_server.py` (lines 1-108) – TransT tracking API server.
   - `GET /health` – debug-only endpoint returning `{\"status\": \"ok\"}`; the app should never call this.
   - `POST /session/create` – create session; body: `{session_id?, device?}` → `{session_id}`.
   - `POST /track/init` – initialize target with image and bbox; body: `{session_id, image_b64, bbox_xywh, target_id?}` → `{ok, elapsed_ms, target_id}`.
   - `POST /track/update` – update target with new frame; body: `{session_id, target_id, image_b64}` → `{bbox_xywh, score?, elapsed_ms}`.
    - `POST /track/drop_target` – remove target from session; body: `{session_id, target_id}` → `{ok: True}`.
    - `POST /session/drop` – close session; body: `{session_id}` → `{ok: True}`.
   - Except for `/health`, all TransT endpoints above require `POST` requests.
- `Docker/transt_wrapper.py` (lines 1-150) – Transt tracking wrapper and session service.

### UI Layout Hierarchy

- **Workspace** (`SequenceLabeler.tsx`)
  - Includes **TopBar**, **Viewport**, **RightPanel**, and **Timeline**.
    - **Timeline** contains **TimelineTopBar**, **TimelineResizer**, and **TimelineView**.

| Layout Name     | Component Path                                      | Identifier                                | Lines      | CSS (file:lines)                                   |
|-----------------|-----------------------------------------------------|-------------------------------------------|------------|----------------------------------------------------|
| Workspace       | `mylab/src/SequenceLabeler/SequenceLabeler.tsx`     | `<div className={styles.workspace}>`      | 1252-1258  | `SequenceLabeler.module.css` `.workspace` (24-29)  |
| Viewport        | `mylab/src/SequenceLabeler/SequenceLabeler.tsx`     | `<canvas className={styles.viewport}>`    | 1262-1285  | `SequenceLabeler.module.css` `.viewport` (48-56)   |
| TopBar          | `mylab/src/SequenceLabeler/SLTopBar.tsx`            | `<div className={styles.topBar}>`         | 48-77      | `SequenceLabeler.module.css` `.topBar` (10-22)     |
| RightPanel      | `mylab/src/SequenceLabeler/SLRightPanel.tsx`        | `<div className={styles.rightPanel}>`     | 52-224     | `SequenceLabeler.module.css` `.rightPanel` (95-104)|
| Timeline        | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`   | `<div data-testid="Timeline">`           | 60-105     | —                                                  |
| TimelineTopBar  | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`   | `<div className={styles.timelineTopBar}>` | 61-76      | `SequenceLabeler.module.css` `.timelineTopBar` (58-65) |
| TimelineResizer | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`   | `<div className={styles.timelineResizer}>`| 77-82      | `SequenceLabeler.module.css` `.timelineResizer` (67-76) |
| TimelineView    | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`   | `<div className={styles.timelineView}>`   | 84-104     | `SequenceLabeler.module.css` `.timelineView` (79-88) |
| ProjectPanel    | `mylab/src/App.tsx`                                 | `<div className={appStyles.sidebar}>`     | 104-109    | `App.module.css` `.sidebar` (8-16)                 |

### Components Index & Edit Roadmap

- `SequenceLabeler/SequenceLabeler.tsx` – Hosts Workspace with TopBar, Viewport, Timeline, and RightPanel (lines 1230-1360).
- `SequenceLabeler/SLTopBar.tsx` – TopBar with playback and file controls (lines 1-77).
- `SequenceLabeler/SLRightPanel.tsx` – RightPanel for label sets and tracks (lines 1-224).
- `SequenceLabeler/SLTimelineSection.tsx` – Timeline with TimelineTopBar, resizer, and view (lines 1-105).
- `App.tsx` – ProjectPanel managing projects and tasks (lines 102-120).

## Performance Notes (Scrubbing, FPS, Decode Pipeline)

- Rendering and input are decoupled. A persistent RAF loop drives canvas drawing at a fixed, user-selectable FPS (30/45/60).
- Image decode requests are also cadence-gated to match FPS, preventing bursts on long sequences (e.g., 1000+ frames).
- When the exact target frame is not yet decoded, the canvas draws the nearest cached frame or the last drawn frame to avoid blanks; it refreshes when the target becomes ready.
- Directional prefetch warms a small window ahead of the actually drawn frame.
- During fast scrubs, decode uses downscaled resolution and upgrades to full-res once stable to reduce QHD costs.
- LRU eviction no longer calls `ImageBitmap.close()` to keep a safe fallback; cache size increased for better hit rate.

Updated files:
- `mylab/src/SequenceLabeler/SequenceLabeler.tsx`: FPS option state, render/decode cadence, fallback, prefetch.
- `mylab/src/SequenceLabeler/SLTopBar.tsx`: Added FPS selector UI (30/45/60).
- `mylab/src/lib/LRUFrames.ts`: Safer eviction and helper.

How to test:
- Run `npm test` inside `mylab`.
- In the app, scrub quickly over 1000 frames at QHD; adjust FPS in the TopBar to balance smoothness vs performance.
