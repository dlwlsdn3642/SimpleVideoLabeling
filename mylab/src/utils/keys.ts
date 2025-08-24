export function eventToKeyString(e: KeyboardEvent): string | null {
  if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let base = e.key;
  if (base === " ") base = "Space";
  return [...mods, base].join("+");
}
export function normalizeKeyString(s: string): string {
  const parts = s.split("+").map(x => x.trim()).filter(Boolean);
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map(p => p.toLowerCase()));
  const normMods = [
    mods.has("ctrl") ? "Ctrl" : "",
    mods.has("alt") ? "Alt" : "",
    mods.has("shift") ? "Shift" : ""
  ].filter(Boolean);
  return [...normMods, key].join("+");
}