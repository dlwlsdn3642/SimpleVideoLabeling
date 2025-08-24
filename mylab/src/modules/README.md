# Modules Overview

This directory hosts the large swappable modules that power the Sequence Labeler.
Each module exposes a minimal public contract and hides its internal state so that
React components can orchestrate them without owning business logic.

## Model

Pure reducers and history helpers for track editing. Example:

```ts
import { useHistory } from "./model/history";
import { Action } from "./model/tracks";

const history = useHistory([]);
history.dispatch({
  type: "ADD_KF",
  trackId: "1",
  f: 0,
  rect: { x: 0, y: 0, w: 10, h: 10 },
  meta: { record: true },
});
```

Additional subfolders will house media, rendering, interaction, timeline and
other subsystems as they are extracted from the legacy `SequenceLabeler`.
