import type React from "react";
import type { KeyMap } from "../types";

// 사용자가 보기 쉬운 이름으로 표시하기 위한 매핑
const ACTION_LABELS: Record<string, string> = {
  "frame_prev": "이전 프레임",
  "frame_next": "다음 프레임",
  "frame_prev10": "이전 10프레임",
  "frame_next10": "다음 10프레임",
  "frame_prev100": "이전 100프레임",
  "frame_next100": "다음 100프레임",
  "toggle_play": "재생/일시정지",
  "kf_add": "키프레임 추가",
  "kf_del": "키프레임 삭제",
  "kf_prev": "이전 키프레임",
  "kf_next": "다음 키프레임",
  "toggle_interpolate": "보간 전환",
  "toggle_ghosts": "유령 박스 전환",
  "toggle_presence": "존재 전환",
  "copy_tracks": "트랙 복사",
  "paste_tracks": "트랙 붙여넣기",
  "undo": "되돌리기",
  "redo": "다시 실행"
};

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
    <div className="overlay">
      <div className="overlayContent">
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Shortcut Settings</div>
        <table style={{ width: "100%", fontSize: 13 }}>
          <tbody>
            {Object.entries(keymap).map(([action, key]) => (
              <tr key={action}>
                <td style={{ padding: "6px 4px", width: 180 }}>{ACTION_LABELS[action] ?? action}</td>
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
            "toggle_ghosts": "g",
            "toggle_presence": "n",
            "copy_tracks": "Ctrl+c",
            "paste_tracks": "Ctrl+v",
            "undo": "Ctrl+z",
            "redo": "Ctrl+y"
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
