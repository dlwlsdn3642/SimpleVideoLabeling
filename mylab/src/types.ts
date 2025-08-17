export type IndexMeta = {
  width: number;
  height: number;
  fps?: number;
  count: number;
  files?: string[];
  zeroPad?: number;
  ext?: string;
};

export type RectPX = { x: number; y: number; w: number; h: number };

export type Keyframe = {
  frame: number; // 0-based
  bbox_xywh: [number, number, number, number]; // px
  absent?: boolean; // if true, hidden after this frame until next keyframe
};

export type Track = {
  track_id: string;
  class_id: number;
  name?: string;
  keyframes: Keyframe[]; // sorted asc
  hidden?: boolean;      // UI on/off
};

export type LabelSet = {
  name: string;
  classes: string[];
  colors: string[];
};

export type KeyMap = Record<string, string>; // action -> key string

export type LocalFile = { name: string; handle: FileSystemFileHandle; url: string };

export type Handle = "none" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw" | "move";

export type Task = {
  id: string;
  name: string;
  workFolder: string; // path or display name for task workspace
  local?: boolean;    // true if using local directory via File System Access API
};

export type Project = {
  id: string;
  name: string;
  tasks: Task[];
};