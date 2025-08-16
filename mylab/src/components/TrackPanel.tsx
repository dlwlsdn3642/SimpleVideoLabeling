import React from "react";
import type { LabelSet, Track } from "../types";

type Props = {
  labelSet: LabelSet;
  tracks: Track[];
  selectedIds: Set<string>;
  setSelectedIds: (s: Set<string>) => void;
  setTracks: (updater: (ts: Track[]) => Track[]) => void;
};

const TrackPanel: React.FC<Props> = ({ labelSet, tracks, selectedIds, setSelectedIds, setTracks }) => {
  return (
    <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
      {tracks.map(t => {
        const isSel = selectedIds.has(t.track_id);
        const clsName = labelSet.classes[t.class_id] ?? t.class_id;
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
              <div
                onClick={() => setSelectedIds(new Set([t.track_id]))}
                style={{ cursor: "pointer", flex: 1 }}
                title={`Keyframes: ${t.keyframes.length}`}
              >
                <div style={{ fontWeight: 600 }}>{t.name ?? t.track_id}</div>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{clsName} · KFs: {t.keyframes.length}</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
              <select
                value={t.class_id}
                onChange={e => setTracks(ts => ts.map(x => x.track_id === t.track_id ? { ...x, class_id: parseInt(e.target.value) } : x))}
              >
                {labelSet.classes.map((c, i) => <option key={i} value={i}>{i + 1}. {c}</option>)}
              </select>
              <button onClick={() => {
                const name = prompt("Rename track:", t.name ?? "");
                if (name !== null) setTracks(ts => ts.map(x => x.track_id === t.track_id ? { ...x, name } : x));
              }}>Rename</button>
              <button onClick={() => setTracks(ts => ts.filter(x => x.track_id !== t.track_id))}>Delete</button>
            </div>
            <div style={{ marginTop: 4, fontSize: 11, opacity: 0.8 }}>
              Presence toggles: {t.presence_toggles.join(", ") || "(none)"}
            </div>
          </div>
        );
      })}
      {!tracks.length && <div style={{ opacity: 0.7, fontSize: 12 }}>캔버스를 드래그해 새 트랙을 만드세요. Alt+드래그=다중 이동(선택된 트랙)</div>}
    </div>
  );
};

export default TrackPanel;