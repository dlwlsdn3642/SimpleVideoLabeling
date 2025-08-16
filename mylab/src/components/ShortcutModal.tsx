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
                      value={recordingAction === action ? "Press any key…" : key}
                      readOnly
                      onClick={() => setRecordingAction(action)}
                      style={{ flex: 1, cursor: "pointer" }}
                    />
                    <button onClick={() => setKeymap(m => ({ ...m, [action]: "" }))}>Clear</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={() => { setRecordingAction(null); setKeymap(() => ({
            "frame_prev": "ArrowLeft",
            "frame_next": "ArrowRight",
            "frame_prev10": "Shift+ArrowLeft",
            "frame_next10": "Shift+ArrowRight",
            "frame_prev100": "Ctrl+ArrowLeft",
            "frame_next100": "Ctrl+ArrowRight",
            "toggle_play": "Space",
            "kf_add": "k",
            "kf_del": "Shift+k",
            "kf_prev": ",",
            "kf_next": ".",
            "toggle_interpolate": "i",
            "toggle_presence": "n",
            "copy_tracks": "Ctrl+c",
            "paste_tracks": "Ctrl+v"
          })); }}>Reset</button>
          <button
            onClick={() => { localStorage.setItem(`${indexUrl}::keymap_v2`, JSON.stringify(keymap)); setRecordingAction(null); onClose(); }}
          >
            Save
          </button>
          <button onClick={() => { setRecordingAction(null); onClose(); }}>Close</button>
        </div>
        <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
          예: <code>ArrowLeft</code>, <code>Shift+ArrowLeft</code>, <code>Shift+k</code>, <code>Ctrl+Alt+.</code>, <code>Space</code>
        </div>
      </div>
    </div>
  );
};

export default ShortcutModal;
