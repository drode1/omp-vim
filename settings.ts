import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ModeColorSettings = {
  insert?: string;
  normal?: string;
  ex?: string;
};

export type ModeChangeSettings = {
  insert?: string;
  normal?: string;
};

export type PiVimSettings = {
  clipboardMirror?: unknown;
  modeColors?: ModeColorSettings;
  modeChange?: ModeChangeSettings;
  syncBorderColorWithMode?: boolean;
  /** Normalized two-letter sequences; empty disables the feature. */
  escapeSequence?: string[];
  /** Clamped timeout in ms; always present when settings are loaded from disk. */
  escapeSequenceTimeoutMs?: number;
};

export const DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS = 300;
export const MIN_ESCAPE_SEQUENCE_TIMEOUT_MS = 50;
export const MAX_ESCAPE_SEQUENCE_TIMEOUT_MS = 2000;

const M = Symbol(),
  C = ["insert", "normal", "ex"] as const,
  MC = ["insert", "normal"] as const,
  T = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SEQUENCE = /^[A-Za-z]{2}$/;
const rec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function get(s: unknown, k: keyof PiVimSettings): unknown {
  if (!rec(s)) return M;
  const hasOmp = Object.hasOwn(s, "ompVim");
  if (!hasOmp && !Object.hasOwn(s, "piVim")) return M;
  const p = hasOmp ? s.ompVim : s.piVim;
  if (!rec(p)) return p;
  return Object.hasOwn(p, k) ? p[k] : M;
}

function colors(v: unknown) {
  if (!rec(v)) return;
  const r: ModeColorSettings = {};
  for (const k of C) {
    const x = v[k],
      t = typeof x === "string" ? x.trim() : "";
    if (T.test(t)) r[k] = t;
  }
  return Object.keys(r)[0] ? r : undefined;
}

function modeChange(v: unknown): ModeChangeSettings | undefined {
  if (!rec(v)) return;
  const r: ModeChangeSettings = {};
  for (const k of MC) {
    const x = v[k];
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t.length > 0) r[k] = t;
  }
  return Object.keys(r)[0] ? r : undefined;
}

/** Normalize config into unique valid two-letter sequences; invalid entries dropped. */
export function normalizeEscapeSequences(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  const raw = typeof v === "string" ? [v] : Array.isArray(v) ? v : null;
  if (!raw) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    if (!SEQUENCE.test(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

export function normalizeEscapeSequenceTimeoutMs(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    return DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS;
  }
  return Math.min(
    MAX_ESCAPE_SEQUENCE_TIMEOUT_MS,
    Math.max(MIN_ESCAPE_SEQUENCE_TIMEOUT_MS, Math.trunc(v)),
  );
}

export function readPiVimClipboardMirrorSetting(g: unknown, p: unknown) {
  let v = get(p, "clipboardMirror");
  if (v !== M) return v;
  v = get(g, "clipboardMirror");
  return v === M ? undefined : v;
}

export function readPiVimModeColors(g: unknown, p: unknown) {
  const v = get(p, "modeColors");
  // Project settings are a whole-setting override. If a project checks in an
  // invalid modeColors value, fall back to pi-vim defaults instead of leaking a
  // developer's global colors into that project.
  if (v !== M) return colors(v);
  const w = get(g, "modeColors");
  return colors(w);
}

export function readPiVimModeChange(g: unknown, p: unknown) {
  void p;
  // modeChange executes a shell command, so only the user-global settings file
  // is trusted. Project settings may be checked into a repo; treating them as
  // executable hook config would let a checkout run arbitrary commands when the
  // editor changes mode.
  const v = get(g, "modeChange");
  return modeChange(v);
}

export function readPiVimBooleanSetting(
  g: unknown,
  p: unknown,
  k: "syncBorderColorWithMode",
) {
  const v = get(p, k);
  if (v !== M) return typeof v === "boolean" ? v : undefined;
  const w = get(g, k);
  return typeof w === "boolean" ? w : undefined;
}

export function readPiVimEscapeSequence(g: unknown, p: unknown): string[] {
  const v = get(p, "escapeSequence");
  if (v !== M) return normalizeEscapeSequences(v);
  const w = get(g, "escapeSequence");
  if (w !== M) return normalizeEscapeSequences(w);
  return [];
}

export function readPiVimEscapeSequenceTimeoutMs(
  g: unknown,
  p: unknown,
): number {
  const v = get(p, "escapeSequenceTimeoutMs");
  if (v !== M) return normalizeEscapeSequenceTimeoutMs(v);
  const w = get(g, "escapeSequenceTimeoutMs");
  if (w !== M) return normalizeEscapeSequenceTimeoutMs(w);
  return DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS;
}

function loadSettingsFile(path: string): unknown {
  try {
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function disk(cwd: string): PiVimSettings {
  const g = loadSettingsFile(join(homedir(), ".omp", "agent", "settings.json"));
  const p = loadSettingsFile(join(cwd, ".omp", "settings.json"));
  return {
    clipboardMirror: readPiVimClipboardMirrorSetting(g, p),
    modeColors: readPiVimModeColors(g, p),
    modeChange: readPiVimModeChange(g, p),
    syncBorderColorWithMode: readPiVimBooleanSetting(
      g,
      p,
      "syncBorderColorWithMode",
    ),
    escapeSequence: readPiVimEscapeSequence(g, p),
    escapeSequenceTimeoutMs: readPiVimEscapeSequenceTimeoutMs(g, p),
  };
}

let reader = disk;
export function readPiVimSettings(cwd: string) {
  return reader(cwd);
}
export function setPiVimSettingsReaderForTests(next: typeof disk) {
  const prev = reader;
  reader = next;
  return () => {
    reader = prev;
  };
}
