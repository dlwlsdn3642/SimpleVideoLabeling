import React from "react";
import type { KeyMap } from "../types";

type Props = {
  open: boolean;
  keymap: KeyMap;
  setKeymap: (updater: (m: KeyMap) => KeyMap) => void;
  indexUrl: string;
  recordingAction: string | null;
  setRecordingAction: (a: string | null) => void;
  onClose: () => void;
};

const ShortcutModal: React.FC<Props> = ({
  open, keymap, setKeymap, indexUrl, recordingAction, setRecordingAction, onClose
}) => {
  if (!open) return null;
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center" }}>
      <div style={{ background: "#161616", border: "1px solid #333", padding: 16, width: 520 }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Shortcut Settings</div>
        <table style={{ width: "100%", fontSize: 13 }}>
          <tbody>
            {Object.entries(keymap).map(([action, key]) => (
              <tr key={action}>
                <td style={{ padding: "6px 4px", width: 180 }}>{action}</td>
                <td style={{ padding: "6px 4px" }}>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input
                      value={key}
                      onChange={e => setKeymap(m => ({ ...m, [action]: e.target.value }))}
                      style={{ flex: 1 }}
                    />
                    <button onClick={() => setRecordingAction(action)}>
                      {recordingAction === action ? "Recording…" : "Record"}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => setKeymap(() => ({
            "frame_prev": "ArrowLeft",
            "frame_next": "ArrowRight",
            "frame_prev10": "a",
            "frame_next10": "d",
            "frame_prev100": "s",
            "frame_next100": "w",
            "toggle_play": "Space",
            "kf_add": "k",
            "kf_del": "Shift+k",
            "kf_prev": ",",
            "kf_next": ".",
            "toggle_interpolate": "i",
            "toggle_presence": "n",
            "copy_tracks": "Ctrl+c",
            "paste_tracks": "Ctrl+v"
          }))}>Reset</button>
          <button
            onClick={() => { localStorage.setItem(`${indexUrl}::keymap_v2`, JSON.stringify(keymap)); onClose(); }}
          >
            Save
          </button>
          <button onClick={onClose}>Close</button>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          예: <code>ArrowLeft</code>, <code>a</code>, <code>Shift+k</code>, <code>Ctrl+Alt+.</code>, <code>Space</code>
        </div>
      </div>
    </div>
  );
};

export default ShortcutModal;