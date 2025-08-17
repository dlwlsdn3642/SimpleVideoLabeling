import React from "react";
import type { LabelSet, Track } from "../types";

type Props = {
  labelSet: LabelSet;
  tracks: Track[];
  selectedIds: Set<string>;
  setSelectedIds: (s: Set<string>) => void;
  setTracks: (updater: (ts: Track[]) => Track[], record?: boolean) => void;
};

const TrackPanel: React.FC<Props> = ({ labelSet, tracks, selectedIds, setSelectedIds, setTracks }) => {
  const grouped: Record<number, Track[]> = {};
  for (const t of tracks) {
    (grouped[t.class_id] = grouped[t.class_id] ?? []).push(t);
  }

  const renderTrack = (t: Track) => {
    const isSel = selectedIds.has(t.track_id);
    return (
      <div key={t.track_id} style={{ padding: 6, border: "1px solid #333", background: isSel ? "#1b2a33" : "#121212" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={!t.hidden}
            onChange={e => setTracks(ts => ts.map(x => x.track_id === t.track_id ? { ...x, hidden: !e.target.checked } : x))}
            title="show/hide"
          />
          <input
            type="checkbox"
            checked={isSel}
            onChange={e => setSelectedIds(prev => {
              const n = new Set(prev);
              if (e.target.checked) n.add(t.track_id); else n.delete(t.track_id);
              return n;
            })}
            title="select for multi"
          />
          <div style={{ width: 12, height: 12, background: labelSet.colors[t.class_id], border: "1px solid #333" }} />
          <div
            onClick={() => setSelectedIds(new Set([t.track_id]))}
            style={{ cursor: "pointer", flex: 1 }}
            title={`Keyframes: ${t.keyframes.length}`}
          >
            <div style={{ fontWeight: 600 }}>{t.name ?? t.track_id}</div>
            <div style={{ fontSize: 12, opacity: 0.8 }}>KFs: {t.keyframes.length}</div>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
          <select
            value={t.class_id}
            onChange={e => setTracks(ts => ts.map(x => x.track_id === t.track_id ? { ...x, class_id: parseInt(e.target.value) } : x), true)}
          >
            {labelSet.classes.map((c, i) => <option key={i} value={i}>{i + 1}. {c}</option>)}
          </select>
          <button onClick={() => {
            const name = prompt("Rename track:", t.name ?? "");
            if (name !== null) setTracks(ts => ts.map(x => x.track_id === t.track_id ? { ...x, name } : x), true);
          }}>Rename</button>
          <button onClick={() => setTracks(ts => ts.filter(x => x.track_id !== t.track_id), true)}>Delete</button>
        </div>
        <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>
          Absent after: {t.keyframes.filter(k => k.absent).map(k => k.frame).join(", ") || "(none)"}
        </div>
      </div>
    );
  };

  const rendered: JSX.Element[] = [];
  labelSet.classes.forEach((name, classId) => {
    const clsTracks = grouped[classId];
    if (!clsTracks) return;
    rendered.push(
      <details key={classId} open>
        <summary style={{ fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 12, height: 12, background: labelSet.colors[classId], border: "1px solid #333" }}></span>
          {classId + 1}. {name} ({clsTracks.length})
        </summary>
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginLeft: 12, marginTop: 6 }}>
          {clsTracks.map(renderTrack)}
        </div>
      </details>
    );
  });

  // Handle tracks with unknown class ids
  Object.entries(grouped)
    .filter(([cid]) => parseInt(cid) >= labelSet.classes.length)
    .forEach(([cid, clsTracks]) => {
      rendered.push(
        <details key={cid} open>
          <summary style={{ fontWeight: 600, cursor: "pointer" }}>
            {cid}. Unknown ({clsTracks.length})
          </summary>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginLeft: 12, marginTop: 6 }}>
            {clsTracks.map(renderTrack)}
          </div>
        </details>
      );
    });

  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
      {rendered}
      {!tracks.length && (
        <div style={{ opacity: 0.7, fontSize: 12 }}>
          캔버스를 드래그해 새 트랙을 만드세요. Alt+드래그=다중 이동(선택된 트랙)
        </div>
      )}
    </div>
  );
};

export default TrackPanel;