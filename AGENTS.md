# Agent Instructions

- Run `npm test` inside the `mylab` directory to execute the Vitest suite before committing.
- No additional lint steps are required.
- If you modify files, ensure formatting via existing project configuration.

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
  - `src/SequenceLabeler/SLTopBar.tsx` (lines 24-79) – Toolbar and frame controls.
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
- `Docker/transt_wrapper.py` (lines 1-150) – Transt tracking wrapper and session service.

### UI Layout NameMap

| Layout Name      | File Path                                          | Identifier                               | Lines       |
|------------------|-----------------------------------------------------|-------------------------------------------|-------------|
| Workspace        | `mylab/src/SequenceLabeler/SequenceLabeler.tsx`    | `<div className={styles.workspace}>`      | 1252-1258   |
| Viewport         | `mylab/src/SequenceLabeler/SequenceLabeler.tsx`    | `<canvas className={styles.viewport}>`    | 1261-1285   |
| Toolbar          | `mylab/src/SequenceLabeler/SLTopBar.tsx`           | `<div className={styles.toolbar}>`        | 48-77       |
| Inspector        | `mylab/src/SequenceLabeler/SLRightPanel.tsx`       | `<div className={styles.inspector}>`      | 52-120      |
| Timeline         | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`  | `<div data-testid="Timeline">`           | 60-105      |
| TimelineToolbar  | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`  | `<div className={styles.timelineToolbar}>`| 61-76       |
| TimelineResizer  | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`  | `<div className={styles.timelineResizer}>`| 77-82       |
| TimelineView     | `mylab/src/SequenceLabeler/SLTimelineSection.tsx`  | `<div className={styles.timelineView}>`   | 84-104      |
| ProjectPanel     | `mylab/src/App.tsx`                                | `<div className={appStyles.sidebar}>`     | 104-109     |

### Components Index & Edit Roadmap

- `SequenceLabeler/SequenceLabeler.tsx` – Hosts Workspace, Viewport, and embeds Timeline & Inspector (lines 1230-1303).
- `SequenceLabeler/SLTopBar.tsx` – Toolbar with playback and file controls (lines 1-77).
- `SequenceLabeler/SLRightPanel.tsx` – Inspector for label sets and tracks (lines 1-120).
- `SequenceLabeler/SLTimelineSection.tsx` – Timeline with toolbar, resizer, and view (lines 1-105).
- `App.tsx` – ProjectPanel managing projects and tasks (lines 102-120).
