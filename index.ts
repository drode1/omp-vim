import { spawn, spawnSync } from "node:child_process";

import {
  CustomEditor,
  type ExtensionAPI,
} from "@oh-my-pi/pi-coding-agent";
import { copyToClipboard } from "@oh-my-pi/pi-natives";
import {
  CURSOR_MARKER,
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@oh-my-pi/pi-tui";
import {
  type ClipboardMirrorPolicy,
  DEFAULT_CLIPBOARD_MIRROR_POLICY,
  type RegisterWriteSource,
  resolveClipboardMirrorPolicy,
} from "./clipboard-policy.js";
import {
  findCharMotionTarget,
  findFirstNonWhitespaceColumn,
  findParagraphMotionTarget,
  getLineGraphemes,
  reverseCharMotion,
  type WordMotionClass,
} from "./motions.js";
import {
  DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS,
  type ModeChangeSettings,
  type ModeColorSettings,
  readPiVimSettings,
} from "./settings.js";
import {
  resolveDelimitedTextObjectRange,
  resolveMatchingPairMotionTarget,
  resolveWordTextObjectRange,
  type TextObjectKind,
  type TextObjectRange,
  type WordTextObjectClass,
} from "./text-objects.js";
import type {
  CharMotion,
  LastCharMotion,
  Mode,
  PendingMotion,
  PendingOperator,
} from "./types.js";
import {
  CHAR_MOTION_KEYS,
  CTRL_A,
  CTRL_E,
  CTRL_K,
  CTRL_R,
  CTRL_UNDERSCORE,
  ESC_DOWN,
  ESC_LEFT,
  ESC_RIGHT,
  ESC_UP,
  NEWLINE,
  NORMAL_KEYS,
} from "./types.js";
import {
  WordBoundaryCache,
  type WordMotionDirection,
  type WordMotionTarget,
} from "./word-boundary-cache.js";

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const BRACKETED_PASTE_END_TAIL = BRACKETED_PASTE_END.slice(1);
const MAX_COUNT = 9999;
const PI_NATIVE_CLIPBOARD_TIMEOUT_MS = 5000;
const INSERT_CURSOR_SHAPE = "\x1b[5 q";
const BLOCK_CURSOR_SHAPE = "\x1b[1 q";
const RESET_CURSOR_SHAPE = "\x1b[0 q";
const SHOW_HARDWARE_CURSOR = "\x1b[?25h";
const CLIPBOARD_WRITE_TIMEOUT_MS = PI_NATIVE_CLIPBOARD_TIMEOUT_MS + 500;
const CLIPBOARD_SPAWN_FAILURE_LIMIT = 3;
const CLIPBOARD_READ_TIMEOUT_MS = 750;
const CLIPBOARD_READ_MAX_BUFFER_BYTES = 1024 * 1024;
const MODE_CHANGE_COMMAND_TIMEOUT_MS = 2000;
const MODE_COLORS = {
  insert: "borderMuted",
  normal: "borderAccent",
  ex: "warning",
} as const;
const TOKEN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
type ListItemPrefix = {
  prefix: string;
  continuationIndent: string;
};

type ListItemContext = ListItemPrefix & { line: number };

function parseListItemPrefix(line: string): ListItemPrefix | null {
  const match = /^([ \t]*)(?:[-+*]|\d+[.)])[ \t]+/.exec(line);
  if (!match) return null;

  const prefix = match[0];
  const leadingIndent = match[1] ?? "";
  return {
    prefix,
    continuationIndent:
      leadingIndent +
      " ".repeat(visibleWidth(prefix.slice(leadingIndent.length))),
  };
}

function findContainingListItem(
  lines: readonly string[],
  fromLine: number,
  barriers?: readonly boolean[],
): ListItemContext | null {
  for (let line = fromLine; line >= 0; line--) {
    const text = lines[line] ?? "";
    if (
      text.trim().length === 0 ||
      /^\s*```/.test(text) ||
      barriers?.[line] === true
    ) {
      return null;
    }

    const item = parseListItemPrefix(text);
    if (item) return { line, ...item };
  }
  return null;
}

type EditorSnapshot = {
  text: string;
  cursor: { line: number; col: number };
};

type TransitionState = "none" | "undo" | "redo";

type ModalEditorInternals = {
  state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
  preferredVisualCol?: number | null;
  lastAction?: string | null;
  historyIndex?: number;
  onChange?: (text: string) => void;
  tui?: { requestRender?: () => void };
  pushUndoSnapshot?: () => void;
  setCursorCol?: (col: number) => void;
};

type CustomEditorConstructorArgs = ConstructorParameters<typeof CustomEditor>;
type ClipboardWriteFn = (text: string, signal: AbortSignal) => Promise<void>;
type ClipboardReadFn = () => string | null;
type ModeChangeCommandRunner = (command: string) => void;
type RunningModeChangeCommand = {
  child: ReturnType<typeof spawn>;
  timeout: ReturnType<typeof setTimeout>;
};
type ModeChangeEvent = { mode: Mode; previousMode: Mode };
type SurroundState =
  | { op: "d" }
  | { op: "c"; target: string | null }
  | { op: "y"; stage: "motion" }
  | { op: "y"; stage: "textobject"; kind: TextObjectKind }
  | { op: "y"; stage: "char"; startAbs: number; endAbs: number };

type ModeColorKey = keyof typeof MODE_COLORS;
type ModeColorizers = Record<ModeColorKey, (s: string) => string>;
type ModalEditorOptions = {
  labelColorizers?: ModeColorizers | null;
  borderColorizers?: ModeColorizers | null;
  escapeSequence?: string[];
  escapeSequenceTimeoutMs?: number;
};

type EscapeSequencePending = {
  char: string;
  abs: number;
  timer: ReturnType<typeof setTimeout>;
};
type ThemeLike = { fg(token: string, text: string): string };

type CursorShapeSequence =
  | typeof INSERT_CURSOR_SHAPE
  | typeof BLOCK_CURSOR_SHAPE
  | typeof RESET_CURSOR_SHAPE
  | typeof SHOW_HARDWARE_CURSOR;

type CursorShapeRuntime = {
  writeCursorShape: (sequence: CursorShapeSequence) => void;
  setShowHardwareCursor: (show: boolean) => void;
  getShowHardwareCursor?: () => boolean | undefined;
};

type CursorShapeCleanup = (event?: { reason?: string }) => void;

function resolveModeColors(
  colors?: ModeColorSettings,
): Required<ModeColorSettings> {
  return {
    insert: colors?.insert ?? MODE_COLORS.insert,
    normal: colors?.normal ?? MODE_COLORS.normal,
    ex: colors?.ex ?? MODE_COLORS.ex,
  };
}
function colorizeWithTheme(
  theme: ThemeLike,
  token: string,
  fallback: string,
  text: string,
): string {
  const trimmedToken = token.trim();
  if (TOKEN.test(trimmedToken)) {
    try {
      return theme.fg(trimmedToken, text);
    } catch {
      return theme.fg(fallback, text);
    }
  }
  return theme.fg(fallback, text);
}
function buildModeColorizers(
  theme: ThemeLike,
  colors: Required<ModeColorSettings>,
  transform: (text: string) => string = (text) => text,
): ModeColorizers {
  const colorizer = (mode: ModeColorKey) => (text: string) =>
    colorizeWithTheme(theme, colors[mode], MODE_COLORS[mode], transform(text));
  return {
    insert: colorizer("insert"),
    normal: colorizer("normal"),
    ex: colorizer("ex"),
  };
}

type CursorShapeTuiCandidate = {
  terminal?: { write?: unknown };
  setShowHardwareCursor?: unknown;
  getShowHardwareCursor?: unknown;
};

function getCursorShapeRuntime(tui: unknown): CursorShapeRuntime | null {
  if (typeof tui !== "object" || tui === null) return null;

  const candidate = tui as CursorShapeTuiCandidate;
  const terminal = candidate.terminal;
  if (typeof terminal !== "object" || terminal === null) return null;

  const write = terminal.write;
  const setShowHardwareCursor = candidate.setShowHardwareCursor;
  if (
    typeof write !== "function" ||
    typeof setShowHardwareCursor !== "function"
  ) {
    return null;
  }

  const runtime: CursorShapeRuntime = {
    writeCursorShape(sequence: CursorShapeSequence): void {
      write.call(terminal, sequence);
    },
    setShowHardwareCursor(show: boolean): void {
      setShowHardwareCursor.call(candidate, show);
    },
  };

  if (typeof candidate.getShowHardwareCursor === "function") {
    const getShowHardwareCursor = candidate.getShowHardwareCursor;
    runtime.getShowHardwareCursor = () => {
      const value = getShowHardwareCursor.call(candidate);
      return typeof value === "boolean" ? value : undefined;
    };
  }

  return runtime;
}

function enableCursorShapeSupport(tui: unknown): CursorShapeCleanup | null {
  const runtime = getCursorShapeRuntime(tui);
  if (!runtime) return null;

  const previousShowHardwareCursor = runtime.getShowHardwareCursor?.();
  runtime.setShowHardwareCursor(true);

  return (event) => {
    runtime.writeCursorShape(RESET_CURSOR_SHAPE);
    if (event?.reason === "quit") {
      runtime.writeCursorShape(SHOW_HARDWARE_CURSOR);
    } else if (previousShowHardwareCursor !== undefined) {
      runtime.setShowHardwareCursor(previousShowHardwareCursor);
    }
  };
}

type ClipboardCircuitBreaker = {
  consecutiveEnvironmentFailures: number;
  disabled: boolean;
};

const processClipboardCircuitBreaker: ClipboardCircuitBreaker = {
  consecutiveEnvironmentFailures: 0,
  disabled: false,
};

function resetClipboardCircuitBreaker(): void {
  processClipboardCircuitBreaker.consecutiveEnvironmentFailures = 0;
  processClipboardCircuitBreaker.disabled = false;
}

class ClipboardSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClipboardSpawnError";
  }
}

type SpawnErrnoLike = Error & { code?: unknown; syscall?: unknown };

function isNodeSpawnErrno(error: unknown): boolean {
  if (!(error instanceof Error)) return false;

  const candidate = error as SpawnErrnoLike;
  return (
    typeof candidate.code === "string" &&
    candidate.code.length > 0 &&
    typeof candidate.syscall === "string" &&
    candidate.syscall.startsWith("spawn")
  );
}

function isClipboardEnvironmentFailure(error: unknown): boolean {
  return error instanceof ClipboardSpawnError || isNodeSpawnErrno(error);
}

function readSystemClipboard(): string | null {
  let commands: Array<[string, string[]]>;
  if (process.platform === "darwin") {
    commands = [["pbpaste", []]];
  } else if (process.platform === "win32") {
    commands = [["powershell", ["-NoProfile", "-Command", "Get-Clipboard"]]];
  } else {
    commands = [
      ["wl-paste", ["--no-newline"]],
      ["xclip", ["-selection", "clipboard", "-o"]],
      ["xsel", ["--clipboard", "--output"]],
    ];
  }
  for (const [command, args] of commands) {
    try {
      const result = spawnSync(command, args, {
        encoding: "utf8",
        maxBuffer: CLIPBOARD_READ_MAX_BUFFER_BYTES,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: CLIPBOARD_READ_TIMEOUT_MS,
        windowsHide: true,
      });
      if (result.error || result.status !== 0 || result.signal) continue;
      return result.stdout ?? "";
    } catch {
      // Try the next clipboard backend.
    }
  }
  return null;
}

function createClipboardAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function getAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : createClipboardAbortError("clipboard write aborted");
}

async function writeSystemClipboard(
  text: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw getAbortError(signal);
  }
  try {
    await Promise.resolve(copyToClipboard(text));
  } catch (error) {
    if (signal.aborted) {
      throw getAbortError(signal);
    }
    throw new ClipboardSpawnError("clipboard write failed", { cause: error });
  }
}

class ClipboardMirror {
  private activeController: AbortController | null = null;
  private activeText: string | null = null;
  private draining = false;
  private pendingText: string | null = null;

  constructor(
    private writeFn: ClipboardWriteFn,
    private timeoutMs: number = CLIPBOARD_WRITE_TIMEOUT_MS,
    private readonly circuitBreaker: ClipboardCircuitBreaker = processClipboardCircuitBreaker,
  ) {}

  setWriteFn(writeFn: ClipboardWriteFn): void {
    this.activeController?.abort(
      createClipboardAbortError("clipboard writer replaced"),
    );
    this.writeFn = writeFn;
    resetClipboardCircuitBreaker();
  }

  setTimeoutMs(timeoutMs: number): void {
    this.timeoutMs = Math.max(0, timeoutMs);
  }

  hasPendingWrite(): boolean {
    return (
      this.activeText !== null || this.pendingText !== null || this.draining
    );
  }

  mirror(text: string): void {
    if (this.circuitBreaker.disabled) return;

    this.pendingText = text;

    if (!this.draining) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;

    try {
      while (this.pendingText !== null && !this.circuitBreaker.disabled) {
        const text = this.pendingText;
        this.pendingText = null;
        const controller = new AbortController();
        this.activeController = controller;
        this.activeText = text;

        try {
          await this.writeWithTimeout(text, controller);
          this.circuitBreaker.consecutiveEnvironmentFailures = 0;
        } catch (error) {
          this.recordWriteFailure(error);
        } finally {
          if (this.activeController === controller) {
            this.activeController = null;
          }
          this.activeText = null;
        }
      }

      if (this.circuitBreaker.disabled) {
        this.pendingText = null;
      }
    } finally {
      this.draining = false;
      if (this.pendingText !== null && !this.circuitBreaker.disabled) {
        void this.drain();
      }
    }
  }

  private recordWriteFailure(error: unknown): void {
    if (!isClipboardEnvironmentFailure(error)) {
      this.circuitBreaker.consecutiveEnvironmentFailures = 0;
      return;
    }

    this.circuitBreaker.consecutiveEnvironmentFailures += 1;
    if (
      this.circuitBreaker.consecutiveEnvironmentFailures >=
      CLIPBOARD_SPAWN_FAILURE_LIMIT
    ) {
      this.circuitBreaker.disabled = true;
      this.pendingText = null;
    }
  }

  private async writeWithTimeout(
    text: string,
    controller: AbortController,
  ): Promise<void> {
    const timeoutError = createClipboardAbortError("clipboard write timed out");
    const timeoutId = setTimeout(() => {
      controller.abort(timeoutError);
    }, this.timeoutMs);

    try {
      await this.writeFn(text, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) {
        throw getAbortError(controller.signal);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

export class ModalEditor extends CustomEditor {
  private mode: Mode = "insert";
  private pendingMotion: PendingMotion = null;
  private pendingTextObject: TextObjectKind | null = null;
  private pendingOperator: PendingOperator = null;
  private prefixCount: string = "";
  private operatorCount: string = "";
  private pendingG: boolean = false;
  private pendingGCount: string = "";
  private pendingReplace: boolean = false;
  private pendingExCommand: string | null = null;
  private acceptingBracketedPasteInExCommand: boolean = false;
  private pendingEscWhileAcceptingBracketedPasteInExCommand: boolean = false;
  private visualAnchor: number | null = null;
  private visualReplacePending: boolean = false;
  private surround: SurroundState | null = null;
  private textWidth: number = 120;
  private formatOptions: string = "at";
  private effectiveTextWidth: number = 0;
  private lastRenderWidth: number | null = null;
  private lastCharMotion: LastCharMotion | null = null;
  private discardingBracketedPasteInNormalMode: boolean = false;
  private pendingEscWhileDiscardingBracketedPasteInNormalMode: boolean = false;
  private wordBoundaryCache = new WordBoundaryCache();
  private readonly redoStack: EditorSnapshot[] = [];
  private readonly undoStack: EditorSnapshot[] = [];
  private currentTransition: TransitionState = "none";
  private onChangeHooked: boolean = false;
  private readonly labelColorizers: ModeColorizers | null;
  private readonly borderColorizers: ModeColorizers | null;
  private readonly cursorShapeRuntime: CursorShapeRuntime | null;
  private lastCursorShapeSequence: CursorShapeSequence | null = null;
  private lastLineCache = { l: "", w: 0, label: "", result: "" };

  private unnamedRegister: string = "";
  private preferRegisterForPut = false;
  private clipboardMirrorPolicy: ClipboardMirrorPolicy =
    DEFAULT_CLIPBOARD_MIRROR_POLICY;
  private readonly clipboardMirror = new ClipboardMirror(
    writeSystemClipboard,
  );
  private clipboardReadFn: ClipboardReadFn = readSystemClipboard;
  private quitFn: () => void = () => {};
  private notifyFn: (message: string) => void = () => {};
  private modeChangeFn: (mode: Mode, prevMode: Mode) => void = () => {};
  private escapeSequences: string[] = [];
  private escapeSequenceTimeoutMs = DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS;
  private escapeSecondsByFirst = new Map<string, Set<string>>();
  private escapePending: EscapeSequencePending | null = null;

  constructor(
    tui: unknown,
    theme: CustomEditorConstructorArgs[0],
    _kb: unknown,
    opts?: ModalEditorOptions,
  ) {
    super(theme);
    this.cursorShapeRuntime = getCursorShapeRuntime(tui);
    this.labelColorizers = opts?.labelColorizers ?? null;
    this.borderColorizers = opts?.borderColorizers ?? null;
    this.setEscapeSequenceConfig(
      opts?.escapeSequence ?? [],
      opts?.escapeSequenceTimeoutMs ?? DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS,
    );
    this.installModeBorderColorizer();
  }

  setClipboardFn(fn: (text: string, signal?: AbortSignal) => unknown): void {
    this.clipboardMirror.setWriteFn(
      async (text: string, signal: AbortSignal) => {
        await fn(text, signal);
      },
    );
  }
  setClipboardWriteTimeoutMs(timeoutMs: number): void {
    this.clipboardMirror.setTimeoutMs(timeoutMs);
  }
  setClipboardReadFn(fn: ClipboardReadFn): void {
    this.clipboardReadFn = fn;
  }
  setClipboardMirrorPolicy(policy: ClipboardMirrorPolicy): void {
    this.clipboardMirrorPolicy = policy;
  }
  getClipboardMirrorPolicy(): ClipboardMirrorPolicy {
    return this.clipboardMirrorPolicy;
  }
  setQuitFn(fn: () => void): void {
    this.quitFn = fn;
  }
  setNotifyFn(fn: (message: string) => void): void {
    this.notifyFn = fn;
  }
  setModeChangeFn(fn: (mode: Mode, prevMode: Mode) => void): void {
    this.modeChangeFn = fn;
  }
  setEscapeSequenceConfig(
    sequences: string[] | undefined,
    timeoutMs: number | undefined = DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS,
  ): void {
    this.clearEscapeSequencePending();
    const cleaned = (sequences ?? []).filter(
      (s) => typeof s === "string" && /^[A-Za-z]{2}$/.test(s),
    );
    this.escapeSequences = [...new Set(cleaned)];
    this.escapeSequenceTimeoutMs =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
        ? Math.min(2000, Math.max(50, Math.trunc(timeoutMs)))
        : DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS;
    this.escapeSecondsByFirst = new Map();
    for (const seq of this.escapeSequences) {
      const first = seq[0]!;
      const second = seq[1]!;
      let set = this.escapeSecondsByFirst.get(first);
      if (!set) {
        set = new Set();
        this.escapeSecondsByFirst.set(first, set);
      }
      set.add(second);
    }
  }
  getRegister(): string {
    return this.unnamedRegister;
  }
  setRegister(text: string): void {
    this.unnamedRegister = text;
    this.preferRegisterForPut = false;
  }
  getMode(): Mode {
    return this.mode;
  }
  getText(): string {
    return this.getLines().join("\n");
  }

  private getActiveMode(): ModeColorKey {
    if (this.pendingExCommand !== null) return "ex";
    if (this.mode === "visual" || this.mode === "visualLine") return "normal";
    return this.mode;
  }

  private installModeBorderColorizer(): void {
    if (!this.borderColorizers) return;
    let base = this.borderColor;
    const modeBorderColor = (text: string) =>
      (this.borderColorizers?.[this.getActiveMode()] ?? base)(text);
    // Pi assigns its default border color after extension editor construction.
    // Keep a mode-aware getter installed and treat later assignments as the
    // fallback/base color, otherwise syncBorderColorWithMode is overwritten in
    // real sessions even though direct editor tests pass.
    Object.defineProperty(this, "borderColor", {
      get: () => modeBorderColor,
      set(next: unknown) {
        if (typeof next === "function") base = next as typeof base;
      },
    });
  }

  private setMode(mode: Mode = "insert"): void {
    const prev = this.mode;
    if (
      mode === "insert" &&
      prev !== "insert" &&
      this.currentTransition === "none"
    ) {
      this.undoStack.push(this.captureSnapshot());
      this.clearRedoStack();
    }
    if (prev === "insert" && mode !== "insert") {
      this.clearEscapeSequencePending();
    }
    this.mode = mode;
    if (prev !== mode) {
      try {
        this.modeChangeFn(mode, prev);
      } catch {
        // mode-change side effects must never break editing
      }
    }
  }

  override setText(text: string): void {
    this.clearRedoStack();
    super.setText(text);
  }

  override submit(): void {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    super.submit();
  }

  private captureSnapshot(): EditorSnapshot {
    const cursor = this.getCursor();
    return {
      text: this.getText(),
      cursor: { line: cursor.line, col: cursor.col },
    };
  }

  private restoreSnapshot(snapshot: EditorSnapshot): void {
    super.setText(snapshot.text);
    this.moveCursorToAbsoluteIndex(
      this.getAbsoluteIndex(snapshot.cursor.line, snapshot.cursor.col),
    );
    this.invalidateWordBoundaryCache();
  }

  private snapshotChanged(a: EditorSnapshot, b: EditorSnapshot): boolean {
    return (
      a.text !== b.text ||
      a.cursor.line !== b.cursor.line ||
      a.cursor.col !== b.cursor.col
    );
  }

  private withTransition<T>(
    transition: Exclude<TransitionState, "none">,
    action: () => T,
  ): T {
    const previousTransition = this.currentTransition;
    this.currentTransition = transition;
    try {
      return action();
    } finally {
      this.currentTransition = previousTransition;
    }
  }

  private performUndo(count: number = this.takeTotalCount(1)): void {
    const maxSteps = Math.max(1, Math.min(MAX_COUNT, count));
    for (let i = 0; i < maxSteps; i++) {
      const snapshot = this.undoStack.pop();
      if (!snapshot) break;
      this.withTransition("undo", () => {
        this.redoStack.push(this.captureSnapshot());
        this.restoreSnapshot(snapshot);
      });
    }
  }

  private performRedo(count: number = this.takeTotalCount(1)): void {
    const maxSteps = Math.max(1, Math.min(MAX_COUNT, count));
    for (let i = 0; i < maxSteps; i++) {
      const snapshot = this.redoStack.pop();
      if (!snapshot) break;
      this.withTransition("redo", () => {
        this.undoStack.push(this.captureSnapshot());
        this.restoreSnapshot(snapshot);
      });
    }
  }

  private clearRedoStack(): void {
    this.redoStack.length = 0;
  }

  private invalidateWordBoundaryCache(): void {
    this.wordBoundaryCache = new WordBoundaryCache();
  }

  private ensureOnChangeHook(): void {
    if (this.onChangeHooked) return;

    const editor = this as unknown as ModalEditorInternals;
    const originalOnChange = editor.onChange;

    editor.onChange = (text: string) => {
      originalOnChange?.(text);
      this.centralInvalidationCheck();
    };

    this.onChangeHooked = true;
  }

  private centralInvalidationCheck(): void {
    if (this.redoStack.length === 0) return;
    if (this.currentTransition !== "none") return;
    this.clearRedoStack();
  }

  private startPendingExCommand(): void {
    this.pendingExCommand = ":";
    this.acceptingBracketedPasteInExCommand = false;
    this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;
  }

  private clearPendingExCommand(): void {
    const shouldDiscardBracketedPasteTail =
      this.acceptingBracketedPasteInExCommand ||
      this.pendingEscWhileAcceptingBracketedPasteInExCommand;

    this.pendingExCommand = null;
    this.acceptingBracketedPasteInExCommand = false;
    this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;

    if (shouldDiscardBracketedPasteTail) {
      this.discardingBracketedPasteInNormalMode = true;
      this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
    }
  }

  private clearPendingState(): void {
    this.pendingMotion = null;
    this.pendingTextObject = null;
    this.pendingOperator = null;
    this.prefixCount = "";
    this.operatorCount = "";
    this.pendingG = false;
    this.pendingGCount = "";
    this.pendingReplace = false;
    this.clearPendingExCommand();
  }

  private isEscapeLikeInput(data: string): boolean {
    return matchesKey(data, "escape") || matchesKey(data, "ctrl+[");
  }

  private normalizePendingExCommandInput(data: string): string | null {
    let chunk = data;
    let normalized = "";

    while (true) {
      if (this.acceptingBracketedPasteInExCommand) {
        if (this.pendingEscWhileAcceptingBracketedPasteInExCommand) {
          if (chunk.startsWith(BRACKETED_PASTE_END_TAIL)) {
            this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;
            this.acceptingBracketedPasteInExCommand = false;
            chunk = chunk.slice(BRACKETED_PASTE_END_TAIL.length);
            if (chunk.length === 0) {
              return normalized.length > 0 ? normalized : null;
            }
            continue;
          }

          normalized += "\x1b";
          this.pendingEscWhileAcceptingBracketedPasteInExCommand = false;
        }

        const end = chunk.indexOf(BRACKETED_PASTE_END);
        if (end !== -1) {
          normalized += chunk.slice(0, end);
          this.acceptingBracketedPasteInExCommand = false;
          chunk = chunk.slice(end + BRACKETED_PASTE_END.length);
          if (chunk.length === 0) {
            return normalized.length > 0 ? normalized : null;
          }
          continue;
        }

        if (this.isEscapeLikeInput(chunk)) {
          this.pendingEscWhileAcceptingBracketedPasteInExCommand = true;
          return normalized.length > 0 ? normalized : null;
        }

        normalized += chunk;
        return normalized.length > 0 ? normalized : null;
      }

      const start = chunk.indexOf(BRACKETED_PASTE_START);
      if (start === -1) {
        normalized += chunk;
        return normalized.length > 0 ? normalized : null;
      }

      normalized += chunk.slice(0, start);
      chunk = chunk.slice(start + BRACKETED_PASTE_START.length);
      this.acceptingBracketedPasteInExCommand = true;
      if (chunk.length === 0) {
        return normalized.length > 0 ? normalized : null;
      }
    }
  }

  private stripBracketedPasteInNormalMode(data: string): {
    filtered: string | null;
    stripped: boolean;
  } {
    let chunk = data;
    let stripped = false;

    while (true) {
      if (this.discardingBracketedPasteInNormalMode) {
        stripped = true;
        const end = chunk.indexOf(BRACKETED_PASTE_END);
        if (end === -1) {
          return { filtered: null, stripped };
        }
        this.discardingBracketedPasteInNormalMode = false;
        this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
        chunk = chunk.slice(end + BRACKETED_PASTE_END.length);
        if (!chunk) return { filtered: null, stripped };
      }

      const start = chunk.indexOf(BRACKETED_PASTE_START);
      if (start === -1) {
        return { filtered: chunk, stripped };
      }

      stripped = true;
      const end = chunk.indexOf(
        BRACKETED_PASTE_END,
        start + BRACKETED_PASTE_START.length,
      );
      if (end === -1) {
        this.discardingBracketedPasteInNormalMode = true;
        const leading = chunk.slice(0, start);
        return { filtered: leading.length > 0 ? leading : null, stripped };
      }

      chunk =
        chunk.slice(0, start) + chunk.slice(end + BRACKETED_PASTE_END.length);
      if (!chunk) return { filtered: null, stripped };
    }
  }

  handleInput(data: string): void {
    this.ensureOnChangeHook();

    if (this.pendingExCommand !== null) {
      const normalized = this.normalizePendingExCommandInput(data);
      if (normalized === null) return;
      data = normalized;
    } else if (this.mode !== "insert") {
      if (this.discardingBracketedPasteInNormalMode) {
        if (this.isEscapeLikeInput(data)) {
          if (this.pendingEscWhileDiscardingBracketedPasteInNormalMode) {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
            this.discardingBracketedPasteInNormalMode = false;
            this.clearPendingState();
            return;
          } else {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = true;
            this.clearPendingState();
            return;
          }
        } else if (this.pendingEscWhileDiscardingBracketedPasteInNormalMode) {
          if (data.startsWith(BRACKETED_PASTE_END_TAIL)) {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
            this.discardingBracketedPasteInNormalMode = false;
            data = data.slice(BRACKETED_PASTE_END_TAIL.length);
            if (data.length === 0) {
              this.clearPendingState();
              return;
            }
          } else {
            this.pendingEscWhileDiscardingBracketedPasteInNormalMode = false;
          }
        }
      }

      const { filtered, stripped } = this.stripBracketedPasteInNormalMode(data);
      if (stripped) {
        this.clearPendingState();
      }
      if (filtered === null) return;
      data = filtered;
    }

    if (this.isEscapeLikeInput(data)) {
      this.handleEscape();
      return;
    }

    if ("insert" === this.mode) {
      if (matchesKey(data, Key.shiftAlt("a")) || data === "\x1bA") {
        this.clearEscapeSequencePending();
        super.handleInput(CTRL_E);
        return;
      }
      if (matchesKey(data, Key.shiftAlt("i")) || data === "\x1bI") {
        this.clearEscapeSequencePending();
        super.handleInput(CTRL_A);
        return;
      }
      if (matchesKey(data, Key.alt("o")) || data === "\x1bo") {
        this.clearEscapeSequencePending();
        this.openLineBelow();
        return;
      }
      if (matchesKey(data, Key.shiftAlt("o")) || data === "\x1bO") {
        this.clearEscapeSequencePending();
        this.openLineAbove();
        return;
      }
      if (this.tryHandleInsertEscapeSequence(data)) {
        return;
      }
      const printableInsertion = this.isPrintableChunk(data);
      super.handleInput(data);
      if (printableInsertion) this.wrapAfterInsertion(/\s$/.test(data));
      return;
    }

    if (this.pendingReplace) {
      this.pendingReplace = false;
      if (!this.isPrintableInput(data)) {
        this.prefixCount = "";
        this.operatorCount = "";
        return;
      }

      const count = this.takeTotalCount(1);
      const cursor = this.getCursor();
      const line = this.getLines()[cursor.line] ?? "";
      const range = this.getGraphemeRangeAtCol(line, cursor.col, count);
      if (!range) return;

      const before = line.slice(0, range.start);
      const after = line.slice(range.end);
      const replacement = data.repeat(count);
      const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
      const text = this.getText();
      const newText =
        text.slice(0, lineStartAbs) +
        before +
        replacement +
        after +
        text.slice(lineStartAbs + line.length);
      const newCursorAbs =
        lineStartAbs + before.length + data.length * (count - 1);
      this.replaceTextInBuffer(newText, newCursorAbs);
      return;
    }

    if (this.pendingExCommand !== null) {
      this.handlePendingExCommand(data);
      return;
    }

    if (this.pendingTextObject) {
      this.handlePendingTextObject(data);
      return;
    }

    if (this.pendingMotion) {
      this.handlePendingMotion(data);
      return;
    }

    if (this.pendingOperator === "d") {
      this.handlePendingDelete(data);
      return;
    }

    if (this.pendingOperator === "c") {
      this.handlePendingChange(data);
      return;
    }

    if (this.pendingOperator === "y") {
      this.handlePendingYank(data);
      return;
    }

    if (this.surround !== null) {
      this.handleSurroundInput(data);
      return;
    }
    const horizontalMotion =
      data === "h" || data === "l" || data === ESC_LEFT || data === ESC_RIGHT;
    if (this.mode === "visual" || this.mode === "visualLine") {
      if (horizontalMotion) this.clampCursorToChar();
      this.handleVisualMode(data);
      if (horizontalMotion) this.clampCursorToChar();
      return;
    }
    if (horizontalMotion) this.clampCursorToChar();
    this.handleNormalMode(data);
    if (horizontalMotion) this.clampCursorToChar();
  }

  private clearUnderlyingPasteStateIfActive(): void {
    const editor = this as unknown as {
      isInPaste?: boolean;
      pasteBuffer?: string;
      pasteCounter?: number;
    };

    if (!editor.isInPaste) return;

    editor.isInPaste = false;
    if (typeof editor.pasteBuffer === "string") {
      editor.pasteBuffer = "";
    }
    if (typeof editor.pasteCounter === "number") {
      editor.pasteCounter = 0;
    }
  }

  private handleEscape(): void {
    this.clearEscapeSequencePending();
    if (this.pendingExCommand !== null) {
      this.clearPendingExCommand();
      return;
    }

    if (
      this.pendingMotion ||
      this.pendingTextObject ||
      this.pendingOperator ||
      this.prefixCount ||
      this.operatorCount ||
      this.pendingG ||
      this.pendingGCount ||
      this.pendingReplace
    ) {
      this.clearPendingState();
      return;
    }
    if (this.surround !== null) {
      this.surround = null;
      return;
    }
    if (this.mode === "visual" || this.mode === "visualLine") {
      this.exitVisualToNormal();
      return;
    }
    if ("insert" === this.mode) {
      this.clearUnderlyingPasteStateIfActive();
      this.setMode("normal");
      if (this.getCursor().col > 0) this.moveCursorBy(-1);
    } else {
      super.handleInput("\x1b"); // pass escape to abort agent
    }
  }

  private isEnterLikeInput(data: string): boolean {
    return (
      data === "\r" ||
      data === "\n" ||
      matchesKey(data, "enter") ||
      matchesKey(data, "return")
    );
  }

  private isBackspaceLikeInput(data: string): boolean {
    return (
      data === "\x7f" ||
      data === "\x08" ||
      matchesKey(data, "backspace") ||
      matchesKey(data, "ctrl+h")
    );
  }

  private deleteLastPendingExCommandGrapheme(): void {
    const current = this.pendingExCommand ?? "";
    const graphemes = getLineGraphemes(current);

    if (graphemes.length <= 1) {
      this.clearPendingExCommand();
      return;
    }

    const previousGrapheme = graphemes[graphemes.length - 2];
    if (!previousGrapheme) {
      this.clearPendingExCommand();
      return;
    }

    this.pendingExCommand = current.slice(0, previousGrapheme.end);
  }

  private handlePendingExCommandControlChunk(data: string): boolean {
    if (
      !data.includes("\r") &&
      !data.includes("\n") &&
      !data.includes("\x7f") &&
      !data.includes("\x08")
    ) {
      return false;
    }

    let printable = "";
    const flushPrintable = () => {
      if (!printable) return;
      this.pendingExCommand += printable;
      printable = "";
    };

    for (const char of data) {
      if (char === "\r" || char === "\n") {
        flushPrintable();
        this.submitPendingExCommand();
        return true;
      }

      if (char === "\x7f" || char === "\x08") {
        flushPrintable();
        this.deleteLastPendingExCommandGrapheme();
        if (this.pendingExCommand === null) {
          return true;
        }
        continue;
      }

      const codePoint = char.codePointAt(0);
      if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
        this.clearPendingExCommand();
        return true;
      }

      printable += char;
    }

    flushPrintable();
    return true;
  }

  private handlePendingExCommand(data: string): void {
    if (this.isEnterLikeInput(data)) {
      this.submitPendingExCommand();
      return;
    }

    if (this.isBackspaceLikeInput(data)) {
      this.deleteLastPendingExCommandGrapheme();
      return;
    }

    if (this.handlePendingExCommandControlChunk(data)) {
      return;
    }

    if (!this.isPrintableChunk(data)) {
      this.clearPendingExCommand();
      this.handleInput(data);
      return;
    }

    this.pendingExCommand += data;
  }

  private hasNonEmptyPrompt(): boolean {
    return this.getText().trim().length > 0;
  }

  private recomputeEffectiveTextWidth(): void {
    if (this.textWidth <= 0) {
      this.effectiveTextWidth = 0;
      return;
    }
    const width = this.lastRenderWidth ?? this.textWidth;
    let etw = Math.min(this.textWidth, Math.max(0, width - 6));
    if (etw < 40) etw = 0;
    this.effectiveTextWidth = etw;
  }

  private wrapCurrentLineIfNeeded(): void {
    for (let guard = 0; guard < 64; guard++) {
      const lines = this.getLines();
      const cursor = this.getCursor();
      const line = lines[cursor.line] ?? "";
      const graphemes = getLineGraphemes(line);

      let lineWidth = 0;
      let overflowIdx = -1;
      for (let i = 0; i < graphemes.length; i++) {
        const seg = graphemes[i] ?? { start: 0, end: 0 };
        const w = visibleWidth(line.slice(seg.start, seg.end));
        if (lineWidth + w > this.effectiveTextWidth) {
          overflowIdx = i;
          break;
        }
        lineWidth += w;
      }
      if (overflowIdx === -1) return;

      let breakIdx = -1;
      for (let i = overflowIdx; i > 0; i--) {
        const prevSeg = graphemes[i - 1] ?? { start: 0, end: 0 };
        const curSeg = graphemes[i] ?? { start: 0, end: 0 };
        if (
          /\s/.test(line.slice(prevSeg.start, prevSeg.end)) &&
          !/\s/.test(line.slice(curSeg.start, curSeg.end))
        ) {
          breakIdx = i;
          break;
        }
      }
      if (breakIdx === -1) breakIdx = overflowIdx;

      const breakChar = (graphemes[breakIdx] ?? { start: 0, end: 0 }).start;
      const head = line.slice(0, breakChar).replace(/[ \t]+$/, "");
      const listItem = findContainingListItem(lines, cursor.line);
      const continuationIndent = listItem?.continuationIndent ?? "";
      const tail = continuationIndent + line.slice(breakChar);
      const nextLines = [
        ...lines.slice(0, cursor.line),
        head,
        tail,
        ...lines.slice(cursor.line + 1),
      ];
      const nextCursor =
        cursor.col >= breakChar
          ? {
              line: cursor.line + 1,
              col: continuationIndent.length + cursor.col - breakChar,
            }
          : { line: cursor.line, col: Math.min(cursor.col, head.length) };
      let cursorAbs = 0;
      for (let i = 0; i < nextCursor.line; i++) {
        cursorAbs += (nextLines[i] ?? "").length + 1;
      }
      cursorAbs += nextCursor.col;
      this.replaceTextInBuffer(nextLines.join("\n"), cursorAbs);
    }
  }

  private wrapAfterInsertion(endedWithWhitespace: boolean): void {
    if (this.isInsideCodeFence()) return;
    if (this.effectiveTextWidth <= 0) return;
    const hasT = this.formatOptions.includes("t");
    const hasA = this.formatOptions.includes("a");
    if (!hasT && !hasA) return;
    if (hasA) {
      // `a` rearranges the whole paragraph whenever it overflows — for
      // mid-line edits and for insertions at/past the margin alike. The
      // reflow is deferred while the inserted chunk ends in whitespace so a
      // word boundary the user is still typing at is not eaten mid-flow;
      // the next non-whitespace insertion triggers it.
      if (!endedWithWhitespace) {
        this.reflowParagraphAroundCursor();
      }
      return;
    }
    if (this.cursorDisplayCol() >= this.effectiveTextWidth) {
      // `t` alone: plain word wrap when the insertion point is at/past the
      // wrap margin (display columns).
      this.wrapCurrentLineIfNeeded();
    }
  }

  private cursorDisplayCol(): number {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    let displayCol = 0;
    for (const g of getLineGraphemes(line)) {
      if (g.start >= cursor.col) break;
      displayCol += visibleWidth(line.slice(g.start, g.end));
    }
    return displayCol;
  }

  private isInsideCodeFence(): boolean {
    const lines = this.getLines();
    const cursor = this.getCursor();
    let inside = false;
    for (let i = 0; i < cursor.line; i++) {
      if (/^\s*```/.test(lines[i] ?? "")) inside = !inside;
    }
    return inside || /^\s*```/.test(lines[cursor.line] ?? "");
  }

  private reflowParagraphAroundCursor(): void {
    const lines = this.getLines();
    const cursor = this.getCursor();
    // Fence delimiters and fenced lines are hard barriers: a paragraph
    // never spans across them, so code blocks are never reflowed.
    const barrierLines: boolean[] = [];
    let open = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      barrierLines[i] = open || /^\s*```/.test(line);
      if (/^\s*```/.test(line)) open = !open;
    }

    const listItem = findContainingListItem(lines, cursor.line, barrierLines);
    let start = listItem?.line ?? cursor.line;
    if (!listItem) {
      while (
        start > 0 &&
        (lines[start - 1] ?? "").trim().length > 0 &&
        barrierLines[start - 1] !== true &&
        !parseListItemPrefix(lines[start - 1] ?? "")
      ) {
        start--;
      }
    }

    let end = cursor.line;
    while (
      end < lines.length - 1 &&
      (lines[end + 1] ?? "").trim().length > 0 &&
      barrierLines[end + 1] !== true &&
      !parseListItemPrefix(lines[end + 1] ?? "")
    ) {
      end++;
    }

    const paraLines = lines.slice(start, end + 1);
    const paraStartAbs = this.getAbsoluteIndex(start, 0);
    const firstLinePrefix = listItem?.prefix ?? "";
    const continuationIndent = listItem?.continuationIndent ?? "";
    const words: { word: string; startAbs: number }[] = [];
    for (let lineIndex = start; lineIndex <= end; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      const contentStart = lineIndex === start ? firstLinePrefix.length : 0;
      const lineStartAbs = this.getAbsoluteIndex(lineIndex, 0);
      for (const match of line.matchAll(/\S+/g)) {
        if (match.index < contentStart) continue;
        words.push({
          word: match[0],
          startAbs: lineStartAbs + match.index,
        });
      }
    }
    if (words.length === 0) return;

    // Reflow only when the paragraph actually overflows the width budget;
    // otherwise whitespace typed mid-line (including trailing spaces) must
    // be left untouched.
    const overflows = paraLines.some(
      (line) => visibleWidth(line) > this.effectiveTextWidth,
    );
    if (!overflows) return;
    // A whitespace-free overflowing edited line is a hard-split word
    // mid-typing: break that line only (the paragraph fill would re-parse
    // the neighboring chunks as words and glue them with spaces). The
    // single-line mapper preserves the cursor via its own line-local walk.
    const editedLine = lines[cursor.line] ?? "";
    if (
      visibleWidth(editedLine) > this.effectiveTextWidth &&
      !/\s/.test(editedLine)
    ) {
      this.wrapCurrentLineIfNeeded();
      return;
    }

    // Cursor maps word-wise: the fill preserves word order, so locating the
    // word under the cursor (and the offset inside it) is whitespace-
    // immune — a count-based mapping drifts when earlier lines re-pack.
    const cursorAbs = this.getAbsoluteIndex(cursor.line, cursor.col);
    let wordIdx = 0;
    for (let i = 0; i < words.length; i++) {
      if (cursorAbs >= (words[i] ?? { startAbs: 0 }).startAbs) wordIdx = i;
    }
    const anchorWord = words[wordIdx] ?? { word: "", startAbs: 0 };
    const offInWord = Math.max(
      0,
      Math.min(cursorAbs - anchorWord.startAbs, anchorWord.word.length),
    );

    // Greedy fill measured in display columns; words wider than the content
    // budget are hard-split at grapheme boundaries. List markers stay on the
    // first line and continuation lines use a hanging indent.
    const indentWidth = Math.max(
      visibleWidth(firstLinePrefix),
      visibleWidth(continuationIndent),
    );
    const contentWidth = Math.max(1, this.effectiveTextWidth - indentWidth);
    type Piece = { text: string; joinsPrev: boolean };
    const pieces: Piece[] = [];
    const wordFirstPiece: number[] = [];
    for (const { word } of words) {
      wordFirstPiece.push(pieces.length);
      if (visibleWidth(word) <= contentWidth) {
        pieces.push({ text: word, joinsPrev: false });
        continue;
      }
      let chunk = "";
      let chunkWidth = 0;
      for (const grapheme of getLineGraphemes(word)) {
        const text = word.slice(grapheme.start, grapheme.end);
        const width = visibleWidth(text);
        if (chunkWidth + width > contentWidth && chunk.length > 0) {
          pieces.push({ text: chunk, joinsPrev: false });
          chunk = "";
          chunkWidth = 0;
        }
        chunk += text;
        chunkWidth += width;
      }
      if (chunk.length > 0) pieces.push({ text: chunk, joinsPrev: false });
      for (
        let pieceIndex = (wordFirstPiece.at(-1) ?? 0) + 1;
        pieceIndex < pieces.length;
        pieceIndex++
      ) {
        pieces[pieceIndex].joinsPrev = true;
      }
    }

    const out: string[] = [];
    const pieceStarts: number[] = [];
    let current = firstLinePrefix;
    let currentWidth = visibleWidth(current);
    let hasContent = false;
    let currentLineStartAbs = paraStartAbs;
    for (const piece of pieces) {
      const pieceWidth = visibleWidth(piece.text);
      const separator = hasContent && !piece.joinsPrev ? " " : "";
      if (
        !hasContent ||
        currentWidth + visibleWidth(separator) + pieceWidth <=
          this.effectiveTextWidth
      ) {
        pieceStarts.push(
          currentLineStartAbs + current.length + separator.length,
        );
        current += separator + piece.text;
        currentWidth += visibleWidth(separator) + pieceWidth;
        hasContent = true;
      } else {
        out.push(current);
        currentLineStartAbs += current.length + 1;
        current = continuationIndent + piece.text;
        currentWidth = visibleWidth(continuationIndent) + pieceWidth;
        hasContent = true;
        pieceStarts.push(currentLineStartAbs + continuationIndent.length);
      }
    }
    out.push(current);

    const firstPiece =
      wordFirstPiece[Math.min(wordIdx, wordFirstPiece.length - 1)] ?? 0;
    const lastPiece = (wordFirstPiece[wordIdx + 1] ?? pieceStarts.length) - 1;
    let targetPiece = firstPiece;
    let remaining = offInWord;
    for (let pieceIndex = firstPiece; pieceIndex < lastPiece; pieceIndex++) {
      const pieceLength = pieces[pieceIndex].text.length;
      if (remaining <= pieceLength) break;
      remaining -= pieceLength;
      targetPiece = pieceIndex + 1;
    }
    // Anchor at the target piece's actual start (pieceStarts accounts for
    // line breaks and hanging indents) plus the remaining offset.
    const newParaEndAbs = paraStartAbs + out.join("\n").length;
    const newCursorAbs = Math.min(
      (pieceStarts[targetPiece] ?? newParaEndAbs) + remaining,
      newParaEndAbs,
    );
    this.replaceTextInBuffer(
      [...lines.slice(0, start), ...out, ...lines.slice(end + 1)].join("\n"),
      newCursorAbs,
    );
  }

  private applyExSet(body: string): void {
    if (body.length === 0) {
      this.notifyFn(
        "Usage: set tw=N | set fo=at | set fo= | set tw? | set fo? | set etw?",
      );
      return;
    }
    for (const part of body.split(/\s+/)) {
      this.applyExSetPart(part);
    }
  }

  private applyExSetPart(part: string): void {
    if (part.endsWith("?")) {
      this.exSetQuery(part.slice(0, -1));
      return;
    }

    let key: string;
    let op: "=" | "+=" | "-=";
    let value: string;
    const addIdx = part.indexOf("+=");
    const removeIdx = part.indexOf("-=");
    const eqIdx = part.indexOf("=");
    if (addIdx !== -1) {
      key = part.slice(0, addIdx);
      op = "+=";
      value = part.slice(addIdx + 2);
    } else if (removeIdx !== -1) {
      key = part.slice(0, removeIdx);
      op = "-=";
      value = part.slice(removeIdx + 2);
    } else if (eqIdx !== -1) {
      key = part.slice(0, eqIdx);
      op = "=";
      value = part.slice(eqIdx + 1);
    } else {
      this.notifyFn(`Unsupported :set syntax: ${part}`);
      return;
    }

    if (key === "tw" || key === "textwidth") {
      if (op !== "=") {
        this.notifyFn("textwidth supports only set tw=N");
        return;
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        this.notifyFn(`Invalid textwidth: ${value}`);
        return;
      }
      this.textWidth = parsed;
      this.recomputeEffectiveTextWidth();
      return;
    }

    if (key === "fo" || key === "formatoptions") {
      const allowed = [...value].filter((c) => c === "a" || c === "t");
      if (value.length > 0 && allowed.length < value.length) {
        this.notifyFn(
          "Only the a and t formatoptions flags are supported; others ignored",
        );
      }
      const flags = allowed.join("");
      if (op === "=") {
        this.formatOptions = flags;
      } else if (op === "+=") {
        for (const c of flags) {
          if (!this.formatOptions.includes(c)) this.formatOptions += c;
        }
      } else if (op === "-=") {
        this.formatOptions = [...this.formatOptions]
          .filter((c) => !flags.includes(c))
          .join("");
      }
      return;
    }

    this.notifyFn(`Unsupported :set option: ${key}`);
  }

  private exSetQuery(key: string): void {
    if (key === "tw" || key === "textwidth") {
      this.notifyFn(`textwidth=${this.textWidth}`);
      return;
    }
    if (key === "fo" || key === "formatoptions") {
      this.notifyFn(`formatoptions=${this.formatOptions}`);
      return;
    }
    if (key === "etw" || key === "effectivetextwidth") {
      this.notifyFn(`effectivetextwidth=${this.effectiveTextWidth}`);
      return;
    }
    this.notifyFn(`Unsupported :set option: ${key}`);
  }

  private submitPendingExCommand(): void {
    const command = this.pendingExCommand?.slice(1).trim() ?? "";
    this.clearPendingExCommand();

    if (command === "q" || command === "qa") {
      if (this.hasNonEmptyPrompt()) {
        this.notifyFn(`Prompt is not empty; use :${command}! to quit anyway`);
        return;
      }

      this.quitFn();
      return;
    }

    if (command === "q!" || command === "qa!") {
      this.quitFn();
      return;
    }
    if (command === "set" || command.startsWith("set ")) {
      this.applyExSet(command.slice(3).trim());
      return;
    }

    if (command) {
      this.notifyFn(`Unsupported ex command: :${command}`);
    }
  }

  private isAsciiLetterInput(data: string): boolean {
    return data.length === 1 && /^[A-Za-z]$/.test(data);
  }

  private clearEscapeSequencePending(): void {
    if (!this.escapePending) return;
    clearTimeout(this.escapePending.timer);
    this.escapePending = null;
  }

  private startEscapeSequencePending(char: string, abs: number): void {
    this.clearEscapeSequencePending();
    const timer = setTimeout(() => {
      if (this.escapePending?.timer === timer) {
        this.escapePending = null;
      }
    }, this.escapeSequenceTimeoutMs);
    timer.unref?.();
    this.escapePending = { char, abs, timer };
  }

  private removeEscapeSequencePendingChar(): boolean {
    const pending = this.escapePending;
    if (!pending) return false;
    const text = this.getText();
    if (text[pending.abs] !== pending.char) {
      this.clearEscapeSequencePending();
      return false;
    }
    this.clearEscapeSequencePending();
    this.replaceTextInBuffer(
      text.slice(0, pending.abs) + text.slice(pending.abs + 1),
      pending.abs,
    );
    return true;
  }

  private completeEscapeSequence(): void {
    this.removeEscapeSequencePendingChar();
    this.clearUnderlyingPasteStateIfActive();
    this.setMode("normal");
    if (this.getCursor().col > 0) this.moveCursorBy(-1);
  }

  /** Returns true when the key was fully handled (including no-op consume). */
  private tryHandleInsertEscapeSequence(data: string): boolean {
    if (this.escapeSecondsByFirst.size === 0) return false;

    if (this.escapePending) {
      if (this.isAsciiLetterInput(data)) {
        const seconds = this.escapeSecondsByFirst.get(this.escapePending.char);
        if (seconds?.has(data)) {
          this.completeEscapeSequence();
          return true;
        }
      }
      // Non-matching / non-eligible second key: keep first letter, continue.
      this.clearEscapeSequencePending();
      return false;
    }

    if (!this.isAsciiLetterInput(data)) return false;
    if (!this.escapeSecondsByFirst.has(data)) return false;

    const printableInsertion = this.isPrintableChunk(data);
    super.handleInput(data);
    if (printableInsertion) this.wrapAfterInsertion(/\s$/.test(data));
    const abs = this.getAbsoluteIndexFromCursor() - data.length;
    this.startEscapeSequencePending(data, Math.max(0, abs));
    return true;
  }

  private isPrintableChunk(data: string): boolean {
    if (data.length === 0) return false;
    for (const char of data) {
      const codePoint = char.codePointAt(0);
      if (codePoint === undefined || codePoint < 32 || codePoint === 127)
        return false;
    }
    return true;
  }

  private isPrintableInput(data: string): boolean {
    return this.isPrintableChunk(data) && getLineGraphemes(data).length === 1;
  }

  private isDigit(data: string): boolean {
    return data.length === 1 && data >= "0" && data <= "9";
  }

  private isCountStarter(data: string): boolean {
    return data.length === 1 && data >= "1" && data <= "9";
  }

  private takeTotalCount(defaultValue: number = 1): number {
    const prefixRaw = this.prefixCount;
    const operatorRaw = this.operatorCount;
    this.prefixCount = "";
    this.operatorCount = "";

    if (!prefixRaw && !operatorRaw) return defaultValue;

    const parse = (raw: string): number | null => {
      if (!raw) return null;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return null;
      return parsed;
    };

    const prefix = parse(prefixRaw);
    const operator = parse(operatorRaw);

    if (prefix === null && operator === null) return defaultValue;

    const total =
      prefix !== null && operator !== null
        ? prefix * operator
        : (prefix ?? operator ?? defaultValue);

    if (!Number.isFinite(total) || total <= 0) return defaultValue;
    return Math.min(MAX_COUNT, total);
  }

  private hasPendingCount(): boolean {
    return this.prefixCount.length > 0 || this.operatorCount.length > 0;
  }

  private opDigit(data: string): boolean {
    if (!this.isDigit(data) || (data === "0" && !this.operatorCount))
      return false;
    this.operatorCount += data;
    return true;
  }

  private cancelPendingOperator(data: string): void {
    this.pendingOperator = null;
    this.prefixCount = "";
    this.operatorCount = "";
    if (!this.isPrintableChunk(data)) {
      super.handleInput(data);
    }
  }

  private handlePendingMotion(data: string): void {
    if (!this.isPrintableInput(data)) {
      this.pendingMotion = null;
      this.cancelPendingOperator(data);
      return;
    }

    const pendingMotion = this.pendingMotion;
    if (!pendingMotion) return;

    if (this.pendingOperator === "d") {
      this.deleteWithCharMotion(pendingMotion, data);
      this.pendingOperator = null;
    } else if (this.pendingOperator === "c") {
      this.deleteWithCharMotion(pendingMotion, data);
      this.pendingOperator = null;
      this.setMode();
    } else if (this.pendingOperator === "y") {
      this.yankWithCharMotion(pendingMotion, data);
      this.pendingOperator = null;
    } else {
      this.executeCharMotion(pendingMotion, data);
    }

    this.pendingMotion = null;
  }

  private handlePendingTextObject(data: string): void {
    const pendingTextObject = this.pendingTextObject;
    this.pendingTextObject = null;
    if (!pendingTextObject) {
      this.pendingOperator = null;
      return;
    }

    const hasCount = this.hasPendingCount();

    if (this.pendingOperator === "y" && hasCount) {
      this.cancelPendingOperator(data);
      return;
    }

    if (data === "w" || data === "W") {
      const semanticClass: WordTextObjectClass = data === "W" ? "WORD" : "word";
      const count = this.takeTotalCount(1);
      const range = this.getWordObjectRange(
        pendingTextObject,
        count,
        semanticClass,
      );
      if (!range) {
        this.pendingOperator = null;
        return;
      }

      this.applyResolvedTextObjectRange(range);
      return;
    }

    if (hasCount) {
      this.cancelPendingOperator(data);
      return;
    }

    const range = resolveDelimitedTextObjectRange(
      this.getText(),
      this.getDelimitedTextObjectCursorAbs(),
      pendingTextObject,
      data,
    );
    if (!range) {
      this.cancelPendingOperator(data);
      return;
    }

    this.applyResolvedTextObjectRange(range);
  }

  private applyResolvedTextObjectRange(range: TextObjectRange): void {
    const pendingOperator = this.pendingOperator;
    this.pendingOperator = null;
    if (this.mode === "visual" || this.mode === "visualLine") {
      this.setVisualSelectionRange(range);
      return;
    }

    if (!pendingOperator || range.endAbs < range.startAbs) return;

    if (range.endAbs === range.startAbs) {
      if (pendingOperator === "c") {
        this.moveCursorToAbsoluteIndex(range.startAbs);
        this.setMode();
      }
      return;
    }

    if (pendingOperator === "d") {
      this.deleteRangeByAbsolute(range.startAbs, range.endAbs);
      return;
    }

    if (pendingOperator === "c") {
      this.deleteRangeByAbsolute(range.startAbs, range.endAbs);
      this.setMode();
      return;
    }

    if (pendingOperator === "y") {
      this.yankRangeByAbsolute(range.startAbs, range.endAbs);
    }
  }

  private handlePendingDelete(data: string): void {
    if (this.opDigit(data)) return;
    if (data === "s") {
      this.pendingOperator = null;
      this.surround = { op: "d" };
      return;
    }

    if (data === "%") {
      this.applyPercentOp();
      return;
    }

    if (data === "d") {
      const count = this.takeTotalCount(1);
      this.deleteLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      const hasDualCount =
        this.prefixCount.length > 0 && this.operatorCount.length > 0;
      const count = this.takeTotalCount(1);
      const delta = hasDualCount ? Math.max(0, count - 1) : count;
      this.deleteLinewiseByDelta(data === "j" ? delta : -delta);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.deleteToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      this.deleteLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    const hasCount = this.hasPendingCount();
    const supportsCountedWordMotion =
      data === "w" ||
      data === "e" ||
      data === "b" ||
      data === "W" ||
      data === "E" ||
      data === "B";
    const supportsCountedTextObject = data === "i" || data === "a";

    if (hasCount && !supportsCountedWordMotion && !supportsCountedTextObject) {
      this.cancelPendingOperator(data);
      return;
    }

    if (supportsCountedTextObject) {
      this.pendingTextObject = data;
      return;
    }

    const motionCount = supportsCountedWordMotion ? this.takeTotalCount(1) : 1;
    if (this.deleteWithMotion(data, motionCount)) {
      this.pendingOperator = null;
      return;
    }

    this.cancelPendingOperator(data);
  }

  private handlePendingChange(data: string): void {
    if (this.opDigit(data)) return;
    if (data === "s") {
      this.pendingOperator = null;
      this.surround = { op: "c", target: null };
      return;
    }

    if (data === "%") {
      this.applyPercentOp();
      return;
    }

    if (data === "c") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.cutLine();
      this.pendingOperator = null;
      this.setMode();
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      if (count <= 1) {
        this.cutLine();
      } else {
        const currentLine = this.getCursor().line;
        const lines = this.getLines();
        const clampedEnd = Math.min(currentLine + count - 1, lines.length - 1);
        this.writeToRegister(this.getLinewisePayload(currentLine, clampedEnd));
        const before = lines.slice(0, currentLine);
        const after = lines.slice(clampedEnd + 1);
        const newLines = [...before, "", ...after];
        const newText = newLines.join("\n");
        const cursorAbs = before.reduce((acc, l) => acc + l.length + 1, 0);
        this.replaceTextInBuffer(newText, cursorAbs);
      }
      this.pendingOperator = null;
      this.setMode();
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    const hasCount = this.hasPendingCount();
    const supportsCountedWordMotion =
      data === "w" ||
      data === "e" ||
      data === "b" ||
      data === "W" ||
      data === "E" ||
      data === "B";
    const supportsCountedTextObject = data === "i" || data === "a";

    if (hasCount && !supportsCountedWordMotion && !supportsCountedTextObject) {
      this.cancelPendingOperator(data);
      return;
    }

    if (supportsCountedTextObject) {
      this.pendingTextObject = data;
      return;
    }

    const motionCount = supportsCountedWordMotion ? this.takeTotalCount(1) : 1;
    const effectiveMotion =
      data === "W" && this.isCursorOnNonWhitespace() ? "E" : data;
    if (this.deleteWithMotion(effectiveMotion, motionCount)) {
      this.pendingOperator = null;
      this.setMode();
      return;
    }

    this.cancelPendingOperator(data);
  }

  private handleNormalMode(data: string): void {
    if (this.pendingG) {
      if (this.isDigit(data)) {
        this.pendingGCount += data;
        return;
      }

      this.pendingG = false;
      const hadGCount = this.pendingGCount.length > 0;
      this.pendingGCount = "";

      if (!hadGCount) {
        if (data === "g") {
          const count = this.takeTotalCount(1);
          this.moveCursorToLineStart(count - 1);
          return;
        }

        if (data === "J") {
          this.joinLines(false);
          return;
        }
      }

      this.clearPendingState();
      return;
    }

    if (this.prefixCount.length > 0) {
      if (this.isDigit(data)) {
        this.prefixCount += data;
        return;
      }

      if (data === "%") {
        this.prefixCount = "";
        this.operatorCount = "";
        return;
      }

      if (data === "d" || data === "y") {
        this.pendingOperator = data;
        return;
      }

      if (data === "c") {
        this.pendingOperator = "c";
        return;
      }

      if (data === "g") {
        this.pendingGCount = "";
        this.pendingG = true;
        return;
      }

      if (data === "G") {
        const count = this.takeTotalCount(1);
        this.moveCursorToLineStart(count - 1);
        return;
      }

      const supportsCountedStandaloneEdit =
        data === "x" ||
        data === "r" ||
        data === "s" ||
        data === "S" ||
        data === "D" ||
        data === "C" ||
        data === "p" ||
        data === "P" ||
        data === "Y" ||
        data === "J" ||
        data === "u" ||
        data === CTRL_UNDERSCORE ||
        matchesKey(data, "ctrl+_") ||
        data === CTRL_R ||
        data === "U" ||
        matchesKey(data, "ctrl+r");
      const supportsCountedCharMotion =
        CHAR_MOTION_KEYS.has(data) || data === ";" || data === ",";
      const supportsCountedWordMotion =
        data === "w" ||
        data === "e" ||
        data === "b" ||
        data === "W" ||
        data === "E" ||
        data === "B";
      const supportsCountedParagraphMotion = data === "{" || data === "}";
      const supportsCountedNav =
        data === "h" || data === "j" || data === "k" || data === "l";
      const supportsCountedUnderscore = data === "_";

      if (supportsCountedNav) {
        const count = this.takeTotalCount(1);
        const clamped = Math.min(count, MAX_COUNT);
        if (data === "h") {
          this.moveCursorBy(-clamped);
        } else if (data === "l") {
          this.moveCursorBy(clamped);
        } else {
          const delta = data === "j" ? clamped : -clamped;
          this.moveCursorVertically(delta);
        }
        return;
      }

      if (supportsCountedParagraphMotion) {
        this.executeParagraphMotion(data === "}" ? "forward" : "backward");
        return;
      }

      if (
        !supportsCountedStandaloneEdit &&
        !supportsCountedCharMotion &&
        !supportsCountedWordMotion &&
        !supportsCountedParagraphMotion &&
        !supportsCountedUnderscore
      ) {
        this.prefixCount = "";
        this.operatorCount = "";
      }
    } else if (this.isCountStarter(data)) {
      this.prefixCount = data;
      return;
    }

    if (data === "J") {
      this.joinLines(true);
      return;
    }

    if (data === "g") {
      this.pendingGCount = "";
      this.pendingG = true;
      return;
    }

    if (data === ":") {
      this.startPendingExCommand();
      return;
    }

    if (data === "G") {
      this.moveCursorToBufferEnd();
      return;
    }

    if (data === "r") {
      this.pendingReplace = true;
      return;
    }

    if (data === "v") {
      this.enterVisual("visual");
      return;
    }

    if (data === "V") {
      this.enterVisual("visualLine");
      return;
    }

    if (data === "d") {
      this.pendingOperator = "d";
      return;
    }

    if (data === "c") {
      this.pendingOperator = "c";
      return;
    }

    if (data === "y") {
      this.pendingOperator = "y";
      return;
    }

    if (data === "p") {
      this.putAfter();
      return;
    }

    if (data === "P") {
      this.putBefore();
      return;
    }

    if (data === "Y") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (data === ";" && this.lastCharMotion) {
      this.executeCharMotion(
        this.lastCharMotion.motion,
        this.lastCharMotion.char,
        false,
      );
      return;
    }
    if (data === "," && this.lastCharMotion) {
      this.executeCharMotion(
        reverseCharMotion(this.lastCharMotion.motion),
        this.lastCharMotion.char,
        false,
      );
      return;
    }

    if (
      data === "u" ||
      data === CTRL_UNDERSCORE ||
      matchesKey(data, "ctrl+_")
    ) {
      this.performUndo();
      return;
    }

    if (data === CTRL_R || matchesKey(data, "ctrl+r") || data === "U") {
      this.performRedo();
      return;
    }

    if (data === "}" || data === "{") {
      this.executeParagraphMotion(data === "}" ? "forward" : "backward");
      return;
    }

    if (data === "^") {
      this.moveCursorToFirstNonWhitespace();
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      if (count > 1) {
        this.moveCursorVertically(count - 1);
      }
      this.moveCursorToFirstNonWhitespace();
      return;
    }

    if (data === "w") {
      const count = this.takeTotalCount(1);
      this.moveWord("forward", "start", count, "word");
      return;
    }
    if (data === "b") {
      this.moveWord("backward", "start", this.takeTotalCount(1), "word");
      return;
    }
    if (data === "e") {
      this.moveWord("forward", "end", this.takeTotalCount(1), "word");
      return;
    }
    if (data === "W") {
      this.moveWord("forward", "start", this.takeTotalCount(1), "WORD");
      return;
    }
    if (data === "%") {
      this.moveToMatchingPairTarget();
      return;
    }
    if (data === "B") {
      this.moveWord("backward", "start", this.takeTotalCount(1), "WORD");
      return;
    }
    if (data === "E") {
      this.moveWord("forward", "end", this.takeTotalCount(1), "WORD");
      return;
    }

    if (Object.hasOwn(NORMAL_KEYS, data)) {
      this.handleMappedKey(data);
      return;
    }

    if (this.isPrintableChunk(data)) return;
    super.handleInput(data);
  }

  private enterVisual(target: "visual" | "visualLine"): void {
    this.clampCursorToChar();
    this.visualAnchor = this.getAbsoluteIndexFromCursor();
    this.setMode(target);
  }

  private clampCursorToChar(): void {
    if (this.mode === "insert") return;
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";
    if (line.length === 0 || cursor.col < line.length) return;
    // From the EOL caret, one grapheme-aware left lands on the last
    // grapheme — code-unit-counted rights would overshoot on wide chars.
    super.handleInput(ESC_LEFT);
  }

  private exitVisualToNormal(): void {
    this.visualAnchor = null;
    this.visualReplacePending = false;
    this.setMode("normal");
  }

  private getVisualRange(): { startAbs: number; endAbs: number } {
    const lines = this.getLines();
    const text = this.getText();
    // Normalize each endpoint to the grapheme interval it represents: the
    // grapheme containing col, or the last grapheme for an EOL caret. This
    // keeps the anchor char selected from either direction and never splits
    // a multi-code-unit grapheme at the range edges.
    const side = (line: number, col: number): { s: number; e: number } => {
      const lineText = lines[line] ?? "";
      const lineStart = this.getAbsoluteIndex(line, 0);
      const graphemes = getLineGraphemes(lineText);
      if (graphemes.length === 0) {
        return { s: lineStart, e: lineStart };
      }
      let seg = graphemes[graphemes.length - 1] ?? { start: 0, end: 0 };
      for (const g of graphemes) {
        if (col >= g.start && col < g.end) {
          seg = g;
          break;
        }
      }
      return { s: lineStart + seg.start, e: lineStart + seg.end };
    };
    const cursor = this.getCursor();
    const a = side(cursor.line, cursor.col);
    const anchorPos = this.getCursorFromAbsoluteIndex(
      text,
      this.visualAnchor ?? this.getAbsoluteIndexFromCursor(),
    );
    const b = side(anchorPos.line, anchorPos.col);
    return { startAbs: Math.min(a.s, b.s), endAbs: Math.max(a.e, b.e) };
  }

  private getVisualLineRange(): { startLine: number; endLine: number } {
    const text = this.getText();
    const cursorAbs = this.getAbsoluteIndexFromCursor();
    const anchor = this.visualAnchor ?? cursorAbs;
    const a = this.getCursorFromAbsoluteIndex(text, Math.min(anchor, cursorAbs));
    const b = this.getCursorFromAbsoluteIndex(text, Math.max(anchor, cursorAbs));
    return { startLine: a.line, endLine: b.line };
  }

  private visualLineAbsRange(): { startAbs: number; endAbs: number } {
    const { startLine, endLine } = this.getVisualLineRange();
    const lines = this.getLines();
    return {
      startAbs: this.getAbsoluteIndex(startLine, 0),
      endAbs: this.getAbsoluteIndex(endLine, (lines[endLine] ?? "").length),
    };
  }

  private setVisualSelectionRange(range: TextObjectRange): void {
    if (range.endAbs <= range.startAbs) {
      this.moveCursorToAbsoluteIndex(range.startAbs);
      return;
    }
    this.visualAnchor = range.startAbs;
    this.moveCursorToAbsoluteIndex(range.endAbs - 1);
  }

  private swapVisualEnds(): void {
    if (this.visualAnchor === null) return;
    const cursorAbs = this.getAbsoluteIndexFromCursor();
    this.moveCursorToAbsoluteIndex(this.visualAnchor);
    this.visualAnchor = cursorAbs;
  }

  private deleteVisualSelection(): void {
    if (this.mode === "visualLine") {
      const { startLine, endLine } = this.getVisualLineRange();
      this.exitVisualToNormal();
      this.deleteLineRange(startLine, endLine);
      return;
    }
    const { startAbs, endAbs } = this.getVisualRange();
    this.exitVisualToNormal();
    this.deleteRangeByAbsolute(startAbs, endAbs, false);
  }

  private yankVisualSelection(): void {
    if (this.mode === "visualLine") {
      const { startLine, endLine } = this.getVisualLineRange();
      const startAbs = this.getAbsoluteIndex(startLine, 0);
      this.exitVisualToNormal();
      this.yankLineRange(startLine, endLine);
      this.moveCursorToAbsoluteIndex(startAbs);
      return;
    }
    const { startAbs, endAbs } = this.getVisualRange();
    this.exitVisualToNormal();
    this.yankRangeByAbsolute(startAbs, endAbs);
    this.moveCursorToAbsoluteIndex(startAbs);
  }

  private changeVisualSelection(): void {
    if (this.mode === "visualLine") {
      const { startLine, endLine } = this.getVisualLineRange();
      const lines = this.getLines();
      const before = lines.slice(0, startLine);
      const after = lines.slice(endLine + 1);
      this.writeToRegister(this.getLinewisePayload(startLine, endLine));
      const cursorAbs = this.getAbsoluteIndex(before.length, 0);
      this.exitVisualToNormal();
      this.replaceTextInBuffer([...before, "", ...after].join("\n"), cursorAbs);
      this.setMode("insert");
      return;
    }
    const { startAbs, endAbs } = this.getVisualRange();
    this.exitVisualToNormal();
    this.deleteRangeByAbsolute(startAbs, endAbs, false);
    this.setMode("insert");
  }

  private putOverVisualSelection(): void {
    const register = this.getPasteRegisterText();
    if (this.mode === "visualLine") {
      const { startLine, endLine } = this.getVisualLineRange();
      const lines = this.getLines();
      const before = lines.slice(0, startLine);
      const after = lines.slice(endLine + 1);
      this.writeToRegister(this.getLinewisePayload(startLine, endLine));
      const body = register.endsWith("\n") ? register.slice(0, -1) : register;
      const regLines = body.length === 0 ? [""] : body.split("\n");
      const cursorAbs = this.getAbsoluteIndex(before.length, 0);
      this.exitVisualToNormal();
      this.replaceTextInBuffer(
        [...before, ...regLines, ...after].join("\n"),
        cursorAbs,
      );
      return;
    }
    const { startAbs, endAbs } = this.getVisualRange();
    const text = this.getText();
    this.writeToRegister(text.slice(startAbs, endAbs));
    const insertText = register.endsWith("\n") ? register.slice(0, -1) : register;
    const cursorAbs = startAbs + Math.max(0, insertText.length - 1);
    this.exitVisualToNormal();
    this.replaceTextInBuffer(
      text.slice(0, startAbs) + insertText + text.slice(endAbs),
      cursorAbs,
    );
  }

  private replaceVisualSelection(char: string): void {
    const { startAbs, endAbs } = this.getVisualRange();
    const text = this.getText();
    const replaced = text.slice(startAbs, endAbs).replace(/[^\n]/g, char);
    this.exitVisualToNormal();
    this.replaceTextInBuffer(
      text.slice(0, startAbs) + replaced + text.slice(endAbs),
      startAbs,
    );
  }

  private beginVisualSurround(): void {
    const range =
      this.mode === "visualLine"
        ? this.visualLineAbsRange()
        : this.getVisualRange();
    this.exitVisualToNormal();
    this.surround = {
      op: "y",
      stage: "char",
      startAbs: range.startAbs,
      endAbs: range.endAbs,
    };
  }

  private handleVisualMode(data: string): void {
    if (this.visualReplacePending) {
      this.visualReplacePending = false;
      if (this.isPrintableInput(data)) this.replaceVisualSelection(data);
      return;
    }

    if (data === CTRL_R || matchesKey(data, "ctrl+r")) {
      this.exitVisualToNormal();
      this.performRedo();
      return;
    }

    switch (data) {
      case "v":
        if (this.mode === "visual") this.exitVisualToNormal();
        else this.setMode("visual");
        return;
      case "V":
        if (this.mode === "visualLine") this.exitVisualToNormal();
        else this.setMode("visualLine");
        return;
      case "o":
      case "O":
        this.swapVisualEnds();
        return;
      case "d":
      case "x":
      case "X":
      case "D":
        this.deleteVisualSelection();
        return;
      case "c":
      case "s":
      case "C":
      case "R":
        this.changeVisualSelection();
        return;
      case "y":
      case "Y":
        this.yankVisualSelection();
        return;
      case "p":
      case "P":
        this.putOverVisualSelection();
        return;
      case "r":
        this.visualReplacePending = true;
        return;
      case "S":
        this.beginVisualSurround();
        return;
      case "i":
      case "a":
        this.pendingTextObject = data;
        return;
      case "A":
      case "I":
        return;
      case "u":
        this.exitVisualToNormal();
        this.performUndo();
        return;
      case "U":
        this.exitVisualToNormal();
        this.performRedo();
        return;
    }

    this.handleNormalMode(data);
  }

  private surroundPair(ch: string): [string, string] | null {
    switch (ch) {
      case "(":
      case ")":
      case "b":
        return ["(", ")"];
      case "{":
      case "}":
      case "B":
        return ["{", "}"];
      case "[":
      case "]":
      case "r":
        return ["[", "]"];
      case "<":
      case ">":
      case "a":
        return ["<", ">"];
      case '"':
        return ['"', '"'];
      case "'":
        return ["'", "'"];
      case "`":
        return ["`", "`"];
      default:
        return null;
    }
  }

  private surroundOpenPadding(ch: string): string {
    return ch === "(" || ch === "[" || ch === "{" || ch === "<" ? " " : "";
  }

  private resolveSurroundTarget(
    target: string,
  ): { aStart: number; aEnd: number; iStart: number; iEnd: number } | null {
    const text = this.getText();
    const cursorAbs = this.getDelimitedTextObjectCursorAbs();
    const outer = resolveDelimitedTextObjectRange(text, cursorAbs, "a", target);
    const inner = resolveDelimitedTextObjectRange(text, cursorAbs, "i", target);
    if (!outer || !inner) return null;
    return {
      aStart: outer.startAbs,
      aEnd: outer.endAbs,
      iStart: inner.startAbs,
      iEnd: inner.endAbs,
    };
  }

  private applySurroundDelete(target: string): void {
    const r = this.resolveSurroundTarget(target);
    if (!r) return;
    const text = this.getText();
    const inner = text.slice(r.iStart, r.iEnd);
    this.replaceTextInBuffer(
      text.slice(0, r.aStart) + inner + text.slice(r.aEnd),
      r.aStart,
    );
  }

  private applySurroundChange(target: string, replacement: string): void {
    const pair = this.surroundPair(replacement);
    if (!pair) return;
    const r = this.resolveSurroundTarget(target);
    if (!r) return;
    const text = this.getText();
    const inner = text.slice(r.iStart, r.iEnd);
    const pad = this.surroundOpenPadding(replacement);
    this.replaceTextInBuffer(
      text.slice(0, r.aStart) +
        pair[0] +
        pad +
        inner +
        pad +
        pair[1] +
        text.slice(r.aEnd),
      r.aStart,
    );
  }

  private applySurroundAdd(
    startAbs: number,
    endAbs: number,
    char: string,
  ): void {
    const pair = this.surroundPair(char);
    if (!pair) return;
    const text = this.getText();
    const content = text.slice(startAbs, endAbs);
    const pad = this.surroundOpenPadding(char);
    this.replaceTextInBuffer(
      text.slice(0, startAbs) +
        pair[0] +
        pad +
        content +
        pad +
        pair[1] +
        text.slice(endAbs),
      startAbs + pair[0].length + pad.length,
    );
  }

  private resolveSurroundObjectRange(
    kind: TextObjectKind,
    key: string,
  ): { startAbs: number; endAbs: number } | null {
    if (key === "w" || key === "W") {
      const range = this.getWordObjectRange(
        kind,
        1,
        key === "W" ? "WORD" : "word",
      );
      return range ? { startAbs: range.startAbs, endAbs: range.endAbs } : null;
    }
    const range = resolveDelimitedTextObjectRange(
      this.getText(),
      this.getDelimitedTextObjectCursorAbs(),
      kind,
      key,
    );
    return range ? { startAbs: range.startAbs, endAbs: range.endAbs } : null;
  }

  private handleSurroundInput(data: string): void {
    const state = this.surround;
    if (!state) return;

    if (state.op === "d") {
      this.surround = null;
      this.applySurroundDelete(data);
      return;
    }

    if (state.op === "c") {
      if (state.target === null) {
        state.target = data;
        return;
      }
      this.surround = null;
      this.applySurroundChange(state.target, data);
      return;
    }

    if (state.stage === "char") {
      this.surround = null;
      this.applySurroundAdd(state.startAbs, state.endAbs, data);
      return;
    }

    if (state.stage === "textobject") {
      const range = this.resolveSurroundObjectRange(state.kind, data);
      this.surround = range
        ? {
            op: "y",
            stage: "char",
            startAbs: range.startAbs,
            endAbs: range.endAbs,
          }
        : null;
      return;
    }

    if (data === "s") {
      const line = this.getCursor().line;
      this.surround = {
        op: "y",
        stage: "char",
        startAbs: this.getAbsoluteIndex(line, 0),
        endAbs: this.getAbsoluteIndex(
          line,
          (this.getLines()[line] ?? "").length,
        ),
      };
      return;
    }
    if (data === "i" || data === "a") {
      this.surround = { op: "y", stage: "textobject", kind: data };
      return;
    }
    if (data === "$") {
      const cursor = this.getCursor();
      this.surround = {
        op: "y",
        stage: "char",
        startAbs: this.getAbsoluteIndexFromCursor(),
        endAbs: this.getAbsoluteIndex(
          cursor.line,
          (this.getLines()[cursor.line] ?? "").length,
        ),
      };
      return;
    }
    this.surround = null;
  }

  private openLineBelow(): void {
    super.handleInput(CTRL_E);
    super.handleInput(NEWLINE);
  }

  private openLineAbove(): void {
    super.handleInput(CTRL_A);
    super.handleInput(NEWLINE);
    super.handleInput(ESC_UP);
  }

  private handleMappedKey(key: string): void {
    const seq = NORMAL_KEYS[key];
    switch (key) {
      case "i":
        this.setMode();
        break;
      case "a":
        this.setMode();
        if (!this.isCursorAtOrPastEol()) {
          super.handleInput(ESC_RIGHT);
        }
        break;
      case "A":
        this.setMode();
        super.handleInput(CTRL_E);
        break;
      case "I":
        this.setMode();
        this.moveCursorToFirstNonWhitespace();
        break;
      case "$": {
        const { line } = this.getCurrentLineAndCol();
        const graphemes = getLineGraphemes(line);
        this.moveCursorToCol(graphemes[graphemes.length - 1]?.start ?? 0);
        break;
      }
      case "o":
        this.openLineBelow();
        this.setMode();
        break;
      case "O":
        this.openLineAbove();
        this.setMode();
        break;
      case "D":
        this.takeTotalCount(1);
        this.cutToEndOfLine();
        break;
      case "C":
        this.takeTotalCount(1);
        this.cutToEndOfLine();
        this.setMode();
        break;
      case "S":
        this.takeTotalCount(1);
        this.cutCurrentLineContent();
        this.setMode();
        break;
      case "s":
        this.cutCharUnderCursor();
        this.setMode();
        break;
      case "x":
        this.cutCharUnderCursor(true);
        break;
      case "j":
        this.moveCursorVertically(1);
        break;
      case "k":
        this.moveCursorVertically(-1);
        break;
      default:
        if (seq) super.handleInput(seq);
    }
  }

  private executeCharMotion(
    motion: CharMotion,
    targetChar: string,
    saveMotion: boolean = true,
  ): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(
      line,
      col,
      motion,
      targetChar,
      !saveMotion,
      count,
    );

    if (targetCol !== null && saveMotion) {
      this.lastCharMotion = { motion, char: targetChar };
    }

    if (targetCol !== null && targetCol !== col) {
      this.moveCursorToCol(targetCol);
    }
  }

  private executeParagraphMotion(direction: "forward" | "backward"): void {
    const lines = this.getLines();
    const fromLine = this.getCursor().line;
    const count = this.takeTotalCount(1);
    const targetLine = findParagraphMotionTarget(
      lines,
      fromLine,
      direction,
      count,
    );
    this.moveCursorToLineStart(targetLine);
  }

  private tryMoveCursorByState(delta: number): boolean {
    if (delta === 0) return true;

    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines)) return false;
    if (
      !Number.isInteger(state.cursorLine) ||
      !Number.isInteger(state.cursorCol)
    )
      return false;

    const cursorLine = state.cursorLine as number;
    const cursorCol = state.cursorCol as number;
    const line = state.lines[cursorLine] ?? "";
    if (this.hasMultiCodeUnitGraphemes(line)) return false;

    const target = cursorCol + delta;

    if (target < 0 || target > line.length) return false;

    state.cursorCol = target;
    editor.preferredVisualCol = target;
    editor.tui?.requestRender?.();
    return true;
  }

  private moveCursorBy(delta: number): void {
    if (delta === 0) return;

    if (this.tryMoveCursorByState(delta)) return;

    const seq = delta > 0 ? ESC_RIGHT : ESC_LEFT;
    for (let i = 0; i < Math.abs(delta); i++) {
      super.handleInput(seq);
    }
  }

  private moveCursorVertically(delta: number): void {
    if (delta === 0) return;

    const editor = this as unknown as {
      state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
      preferredVisualCol?: number | null;
      lastAction?: string | null;
      tui?: { requestRender?: () => void };
    };

    const state = editor.state;
    if (!state || !Array.isArray(state.lines) || state.lines.length === 0) {
      const seq = delta > 0 ? ESC_DOWN : ESC_UP;
      for (let i = 0; i < Math.abs(delta); i++) {
        super.handleInput(seq);
      }
      return;
    }

    const currentLine = state.cursorLine ?? 0;
    const targetLine = Math.max(
      0,
      Math.min(currentLine + delta, state.lines.length - 1),
    );
    if (targetLine === currentLine) return;

    const preferredCol = editor.preferredVisualCol ?? state.cursorCol ?? 0;
    const targetLineText = state.lines[targetLine] ?? "";
    editor.lastAction = null;
    state.cursorLine = targetLine;
    state.cursorCol = Math.min(preferredCol, targetLineText.length);
    editor.preferredVisualCol = preferredCol;
    editor.tui?.requestRender?.();
  }

  private moveCursorToCol(col: number): void {
    const cursor = this.getCursor();
    this.moveCursorToAbsoluteIndex(this.getAbsoluteIndex(cursor.line, col));
  }

  private moveCursorToAbsoluteIndex(abs: number): void {
    const text = this.getText();
    const { line, col } = this.getCursorFromAbsoluteIndex(text, abs);
    const lineText = this.getLines()[line] ?? "";
    // Arrows advance one grapheme, so the press count is the number of
    // graphemes fully before the target column — not the code-unit offset.
    let presses = 0;
    for (const g of getLineGraphemes(lineText)) {
      if (g.end <= col) presses++;
    }
    this.moveToMessageStart();
    for (let i = 0; i < line; i++) super.handleInput(ESC_DOWN);
    this.moveToLineStart();
    for (let i = 0; i < presses; i++) super.handleInput(ESC_RIGHT);
  }

  private moveCursorToLineStart(lineIndex: number): void {
    this.moveCursorToAbsoluteIndex(this.getAbsoluteIndex(lineIndex, 0));
  }

  private moveCursorToFirstNonWhitespace(): void {
    const { line } = this.getCurrentLineAndCol();
    const targetCol = findFirstNonWhitespaceColumn(line);
    this.moveCursorToCol(targetCol);
  }

  private moveCursorToBufferEnd(): void {
    const lines = this.getLines();
    this.moveCursorToLineStart(Math.max(0, lines.length - 1));
  }

  private joinLines(normalize: boolean): void {
    const count = this.takeTotalCount(2);
    const steps = Math.max(0, count - 1);
    if (steps === 0) return;

    const working = this.getLines().slice();
    const currentLine = this.getCursor().line;
    let joinPoint = this.getCursor().col;

    for (let i = 0; i < steps; i++) {
      if (currentLine >= working.length - 1) break;

      const left = working[currentLine] ?? "";
      const right = working[currentLine + 1] ?? "";
      let joined: string;

      if (normalize) {
        const trimmedRight = right.trimStart();
        const leftLastChar = left[left.length - 1];
        const leftEndsWithSpace =
          leftLastChar !== undefined && /\s/.test(leftLastChar);
        const needsSeparator = !leftEndsWithSpace && trimmedRight.length > 0;
        joined = needsSeparator
          ? `${left} ${trimmedRight}`
          : left + trimmedRight;
        joinPoint = left.length;
      } else {
        joined = left + right;
        joinPoint = left.length;
      }

      working.splice(currentLine, 2, joined);
    }

    this.replaceTextInBuffer(
      working.join("\n"),
      this.getAbsoluteIndex(currentLine, joinPoint),
    );
  }

  private isWordChar(ch: string): boolean {
    return /\w/.test(ch);
  }

  private charType(
    ch: string | undefined,
    semanticClass: WordMotionClass = "word",
  ): "space" | "word" | "other" {
    if (!ch || /\s/.test(ch)) return "space";
    if (semanticClass === "WORD") return "word";
    if (this.isWordChar(ch)) return "word";
    return "other";
  }

  private resolveWordMotion(
    motion: string,
  ): { motion: "w" | "e" | "b"; semanticClass: WordMotionClass } | null {
    if (motion === "w" || motion === "e" || motion === "b") {
      return { motion, semanticClass: "word" };
    }

    if (motion === "W" || motion === "E" || motion === "B") {
      const normalizedMotion = motion.toLowerCase() as "w" | "e" | "b";
      return { motion: normalizedMotion, semanticClass: "WORD" };
    }

    return null;
  }

  private getAbsoluteIndex(line: number, col: number): number {
    const lines = this.getLines();
    let idx = 0;
    for (let i = 0; i < line; i++) {
      idx += (lines[i] ?? "").length + 1;
    }
    return idx + col;
  }

  private getAbsoluteIndexFromCursor(): number {
    const cursor = this.getCursor();
    return this.getAbsoluteIndex(cursor.line, cursor.col);
  }

  private getMatchingPairMotionTarget() {
    const cursor = this.getCursor();
    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
    return resolveMatchingPairMotionTarget(
      this.getText(),
      this.getAbsoluteIndexFromCursor(),
      lineStartAbs,
      lineStartAbs + (this.getLines()[cursor.line] ?? "").length,
    );
  }

  private moveToMatchingPairTarget(): void {
    const target = this.getMatchingPairMotionTarget();
    if (target) this.moveCursorToAbsoluteIndex(target.targetAbs);
  }

  private applyPercentOp(): void {
    const op = this.pendingOperator;
    const counted = this.hasPendingCount();
    this.clearPendingState();
    if (!op || counted) return;

    const t = this.getMatchingPairMotionTarget();
    if (!t) return;

    if (op === "y") {
      this.yankRangeByAbsolute(t.rangeAnchorAbs, t.targetAbs, true);
      return;
    }

    this.deleteRangeByAbsolute(t.rangeAnchorAbs, t.targetAbs, true);
    if (op === "c") this.setMode("insert");
  }

  private getDelimitedTextObjectCursorAbs(): number {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";

    if (line.length > 0 && cursor.col >= line.length) {
      return this.getAbsoluteIndex(cursor.line, line.length - 1);
    }

    return this.getAbsoluteIndex(cursor.line, cursor.col);
  }

  private findWordTargetInText(
    text: string,
    abs: number,
    direction: "forward" | "backward",
    target: "start" | "end",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): number {
    const len = text.length;
    if (len === 0) return 0;

    const steps = Math.max(1, Math.min(MAX_COUNT, count));
    let i = Math.max(0, Math.min(abs, len));

    for (let step = 0; step < steps; step++) {
      let next = i;

      if (direction === "forward") {
        if (next >= len) {
          next = len;
        } else if (target === "start") {
          const startType = this.charType(text[next], semanticClass);
          if (startType !== "space") {
            while (
              next < len &&
              this.charType(text[next], semanticClass) === startType
            )
              next++;
          }
          while (
            next < len &&
            this.charType(text[next], semanticClass) === "space"
          )
            next++;
        } else {
          if (next < len - 1) next++;
          while (
            next < len &&
            this.charType(text[next], semanticClass) === "space"
          )
            next++;
          if (next >= len) {
            next = len;
          } else {
            const t = this.charType(text[next], semanticClass);
            while (
              next < len - 1 &&
              this.charType(text[next + 1], semanticClass) === t
            )
              next++;
          }
        }
      } else {
        if (next >= len) next = len - 1;
        if (next > 0) next--;
        while (next > 0 && this.charType(text[next], semanticClass) === "space")
          next--;
        const t = this.charType(text[next], semanticClass);
        while (next > 0 && this.charType(text[next - 1], semanticClass) === t)
          next--;
      }

      if (next === i) break;
      i = next;
    }

    return i;
  }

  private tryFindWordTargetInLine(
    line: string,
    col: number,
    direction: WordMotionDirection,
    target: WordMotionTarget,
    allowSameColumn: boolean = false,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    if (line.length === 0) return null;
    if (col < 0 || col > line.length) return null;

    if (direction === "forward") {
      if (col >= line.length) return null;
    } else {
      if (col <= 0) return null;
      if (!/\S/.test(line.slice(0, col))) return null;
    }

    const targetCol = this.wordBoundaryCache.tryFindTarget(
      line,
      col,
      direction,
      target,
      semanticClass,
    );
    if (targetCol === null) return null;

    if (direction === "forward") {
      if (targetCol >= line.length) return null;
      if (allowSameColumn) {
        if (targetCol < col) return null;
      } else if (targetCol <= col) {
        return null;
      }
      return targetCol;
    }

    if (allowSameColumn) {
      if (targetCol > col) return null;
    } else if (targetCol >= col) {
      return null;
    }

    return targetCol;
  }

  private tryFindWordTargetLineLocal(
    direction: WordMotionDirection,
    target: WordMotionTarget,
    semanticClass: WordMotionClass = "word",
  ): number | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";

    const targetCol = this.tryFindWordTargetInLine(
      lineSnapshot,
      col,
      direction,
      target,
      false,
      semanticClass,
    );
    if (targetCol === null) return null;

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    return targetCol;
  }

  private tryMoveWordLineLocal(
    direction: "forward" | "backward",
    target: "start" | "end",
    semanticClass: WordMotionClass = "word",
  ): boolean {
    const col = this.getCursor().col;
    const targetCol = this.tryFindWordTargetLineLocal(
      direction,
      target,
      semanticClass,
    );
    if (targetCol === null || targetCol === col) return false;

    this.moveCursorToCol(targetCol);
    return true;
  }

  private tryWordMotionLineLocalRange(
    motion: "w" | "e" | "b",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): { col: number; targetCol: number; inclusive: boolean } | null {
    const cursor = this.getCursor();
    const lineIndex = cursor.line;
    const col = cursor.col;
    const lineSnapshot = this.getLines()[lineIndex] ?? "";
    const direction: WordMotionDirection =
      motion === "b" ? "backward" : "forward";
    const target: WordMotionTarget = motion === "e" ? "end" : "start";
    const steps = Math.max(1, Math.min(MAX_COUNT, count));

    let currentCol = col;
    for (let step = 0; step < steps; step++) {
      const nextCol = this.tryFindWordTargetInLine(
        lineSnapshot,
        currentCol,
        direction,
        target,
        motion === "e",
        semanticClass,
      );
      if (nextCol === null) return null;
      if (nextCol === currentCol && step < steps - 1) return null;
      currentCol = nextCol;
    }

    const liveLine = this.getLines()[lineIndex] ?? "";
    const liveCol = this.getCursor().col;
    if (liveLine !== lineSnapshot || liveCol !== col) return null;

    return {
      col,
      targetCol: currentCol,
      inclusive: motion === "e",
    };
  }

  private moveWord(
    direction: "forward" | "backward",
    target: "start" | "end",
    count: number = 1,
    semanticClass: WordMotionClass = "word",
  ): void {
    let remaining = Math.max(1, Math.min(MAX_COUNT, count));

    while (remaining > 0) {
      if (this.tryMoveWordLineLocal(direction, target, semanticClass)) {
        remaining--;
        continue;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        direction,
        target,
        remaining,
        semanticClass,
      );
      if (targetAbs !== currentAbs) {
        this.moveCursorToAbsoluteIndex(targetAbs);
      }
      return;
    }
  }

  private shouldMirrorRegisterWrite(source: RegisterWriteSource): boolean {
    if (this.clipboardMirrorPolicy === "never") return false;
    if (this.clipboardMirrorPolicy === "yank") return source === "yank";
    return true;
  }

  private writeToRegister(
    text: string,
    source: RegisterWriteSource = "mutation",
  ): void {
    this.unnamedRegister = text;
    const shouldMirror = text !== "" && this.shouldMirrorRegisterWrite(source);
    this.preferRegisterForPut = text !== "" && !shouldMirror;
    if (!shouldMirror) return;

    this.clipboardMirror.mirror(text);
  }

  private getCurrentLineAndCol(): { line: string; col: number } {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    return { line, col };
  }

  private hasMultiCodeUnitGraphemes(line: string): boolean {
    return getLineGraphemes(line).some(
      (segment) => segment.end - segment.start > 1,
    );
  }

  private getGraphemeRangeAtCol(
    line: string,
    col: number,
    count: number,
    clampToLine: boolean = false,
  ): { start: number; end: number } | null {
    const clampedCol = Math.max(0, Math.min(col, line.length));
    const segments = getLineGraphemes(line);
    const startIndex = segments.findIndex(
      (segment) => clampedCol < segment.end,
    );
    if (startIndex === -1) return null;

    let endIndex = startIndex + Math.max(1, count) - 1;
    if (endIndex >= segments.length) {
      if (!clampToLine) return null;
      endIndex = segments.length - 1;
    }

    const startSegment = segments[startIndex];
    const endSegment = segments[endIndex];
    if (!startSegment || !endSegment) return null;

    return {
      start: startSegment.start,
      end: endSegment.end,
    };
  }

  private isCursorOnNonWhitespace(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    const ch = line[col];
    return ch !== undefined && !/\s/.test(ch);
  }

  private isCursorAtOrPastEol(): boolean {
    const { line, col } = this.getCurrentLineAndCol();
    return col >= line.length;
  }

  private cutCharUnderCursor(normal: boolean = false): void {
    const count = Math.max(1, Math.min(MAX_COUNT, this.takeTotalCount(1)));
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const range = this.getGraphemeRangeAtCol(line, cursor.col, count, true);
    if (!range) return;

    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
    const text = this.getText();
    this.writeToRegister(line.slice(range.start, range.end));
    this.replaceTextInBuffer(
      text.slice(0, lineStartAbs + range.start) +
        text.slice(lineStartAbs + range.end),
      lineStartAbs + range.start,
    );
    if (normal) {
      const { line, col } = this.getCurrentLineAndCol();
      if (line && col >= line.length) this.moveCursorBy(-1);
    }
  }

  private cutToEndOfLine(): void {
    const lines = this.getLines();
    const cursorLine = this.getCursor().line;
    const { line, col } = this.getCurrentLineAndCol();

    const hasNextLine = cursorLine < lines.length - 1;
    const deleted =
      col < line.length ? line.slice(col) : hasNextLine ? "\n" : "";

    this.writeToRegister(deleted);
    super.handleInput(CTRL_K);
  }

  private cutCurrentLineContent(): void {
    const lines = this.getLines();
    const cursorLine = this.getCursor().line;
    const { line } = this.getCurrentLineAndCol();

    const hasNextLine = cursorLine < lines.length - 1;
    const deleted = line.length > 0 ? line : hasNextLine ? "\n" : "";

    this.writeToRegister(deleted);
    super.handleInput(CTRL_A);
    super.handleInput(CTRL_K);
  }

  private cutLine(): void {
    this.cutCurrentLineContent();
  }

  private getNormalizedLineRange(
    startLine: number,
    endLine: number,
  ): { start: number; end: number } {
    const lines = this.getLines();
    const last = Math.max(0, lines.length - 1);
    const clampedStart = Math.max(0, Math.min(startLine, last));
    const clampedEnd = Math.max(0, Math.min(endLine, last));
    return {
      start: Math.min(clampedStart, clampedEnd),
      end: Math.max(clampedStart, clampedEnd),
    };
  }

  private getLinewisePayload(startLine: number, endLine: number): string {
    const lines = this.getLines();
    const { start, end } = this.getNormalizedLineRange(startLine, endLine);
    return `${lines.slice(start, end + 1).join("\n")}\n`;
  }

  private getLineDeleteAbsoluteRange(
    startLine: number,
    endLine: number,
  ): { startAbs: number; endAbs: number } {
    const lines = this.getLines();
    const text = this.getText();
    const { start, end } = this.getNormalizedLineRange(startLine, endLine);
    const lastLine = Math.max(0, lines.length - 1);

    let startAbs = this.getAbsoluteIndex(start, 0);
    let endAbs: number;

    if (end < lastLine) {
      const endLineText = lines[end] ?? "";
      endAbs = this.getAbsoluteIndex(end, endLineText.length) + 1;
    } else {
      endAbs = text.length;
      if (start > 0) {
        startAbs = Math.max(0, startAbs - 1);
      }
    }

    return { startAbs, endAbs };
  }

  private deleteLineRange(startLine: number, endLine: number): void {
    const lines = this.getLines();
    if (lines.length === 0) return;

    const payload = this.getLinewisePayload(startLine, endLine);
    const { startAbs, endAbs } = this.getLineDeleteAbsoluteRange(
      startLine,
      endLine,
    );

    this.writeToRegister(payload);

    if (endAbs > startAbs) {
      const text = this.getText();
      const newText = text.slice(0, startAbs) + text.slice(endAbs);
      this.replaceTextInBuffer(newText, startAbs);

      super.handleInput(CTRL_A);
    }
  }

  private yankLineRange(startLine: number, endLine: number): void {
    if (this.getLines().length === 0) return;
    this.writeToRegister(this.getLinewisePayload(startLine, endLine), "yank");
  }

  private deleteLinewiseByDelta(delta: number): void {
    const currentLine = this.getCursor().line;
    this.deleteLineRange(currentLine, currentLine + delta);
  }

  private yankLinewiseByDelta(delta: number): void {
    const currentLine = this.getCursor().line;
    this.yankLineRange(currentLine, currentLine + delta);
  }

  private deleteToBufferEndLinewise(): void {
    this.deleteLineRange(this.getCursor().line, this.getLines().length - 1);
  }

  private yankToBufferEndLinewise(): void {
    this.yankLineRange(this.getCursor().line, this.getLines().length - 1);
  }

  private deleteWithMotion(motion: string, count: number = 1): boolean {
    const cursor = this.getCursor();
    const col = cursor.col;

    if (motion === "$") {
      this.cutToEndOfLine();
      return true;
    }

    if (motion === "0") {
      this.deleteRange(col, 0, false);
      return true;
    }

    if (motion === "^") {
      this.deleteRange(
        col,
        findFirstNonWhitespaceColumn(this.getLines()[cursor.line] ?? ""),
        false,
      );
      return true;
    }

    const wordMotion = this.resolveWordMotion(motion);
    if (wordMotion) {
      const lineLocalRange = this.tryWordMotionLineLocalRange(
        wordMotion.motion,
        count,
        wordMotion.semanticClass,
      );
      if (lineLocalRange) {
        this.deleteRange(
          lineLocalRange.col,
          lineLocalRange.targetCol,
          lineLocalRange.inclusive,
        );
        return true;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        wordMotion.motion === "b" ? "backward" : "forward",
        wordMotion.motion === "e" ? "end" : "start",
        count,
        wordMotion.semanticClass,
      );
      this.deleteRangeByAbsolute(
        currentAbs,
        targetAbs,
        wordMotion.motion === "e",
      );
      return true;
    }

    return false;
  }

  private deleteWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(
      line,
      col,
      motion,
      targetChar,
      false,
      count,
    );

    if (targetCol === null) return;

    this.lastCharMotion = { motion, char: targetChar };
    this.deleteRange(col, targetCol, true);
  }

  private handlePendingYank(data: string): void {
    if (this.opDigit(data)) return;
    if (data === "s") {
      this.pendingOperator = null;
      this.surround = { op: "y", stage: "motion" };
      return;
    }

    if (data === "%") {
      this.applyPercentOp();
      return;
    }

    if (data === "y") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (data === "j" || data === "k") {
      const hasDualCount =
        this.prefixCount.length > 0 && this.operatorCount.length > 0;
      const count = this.takeTotalCount(1);
      const delta = hasDualCount ? Math.max(0, count - 1) : count;
      this.yankLinewiseByDelta(data === "j" ? delta : -delta);
      this.pendingOperator = null;
      return;
    }

    if (data === "G") {
      if (this.prefixCount.length > 0 || this.operatorCount.length > 0) {
        this.cancelPendingOperator(data);
        return;
      }

      this.yankToBufferEndLinewise();
      this.pendingOperator = null;
      return;
    }

    if (data === "_") {
      const count = this.takeTotalCount(1);
      this.yankLinewiseByDelta(count - 1);
      this.pendingOperator = null;
      return;
    }

    if (CHAR_MOTION_KEYS.has(data)) {
      this.pendingMotion = data as PendingMotion;
      return;
    }

    if (data === "i" || data === "a") {
      this.pendingTextObject = data;
      return;
    }

    if (this.hasPendingCount()) {
      this.cancelPendingOperator(data);
      return;
    }

    if (this.yankWithMotion(data)) {
      this.pendingOperator = null;
    } else {
      this.cancelPendingOperator(data); // cancel on unrecognised motion
    }
  }

  private yankWithMotion(motion: string): boolean {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const col = cursor.col;

    if (motion === "$") {
      this.yankRange(col, line.length, false);
      return true;
    }

    if (motion === "0") {
      this.yankRange(col, 0, false);
      return true;
    }

    if (motion === "^") {
      this.yankRange(col, findFirstNonWhitespaceColumn(line), false);
      return true;
    }

    const wordMotion = this.resolveWordMotion(motion);
    if (wordMotion) {
      const lineLocalRange = this.tryWordMotionLineLocalRange(
        wordMotion.motion,
        1,
        wordMotion.semanticClass,
      );
      if (lineLocalRange) {
        this.yankRange(
          lineLocalRange.col,
          lineLocalRange.targetCol,
          lineLocalRange.inclusive,
        );
        return true;
      }

      const text = this.getText();
      const currentAbs = this.getAbsoluteIndexFromCursor();
      const targetAbs = this.findWordTargetInText(
        text,
        currentAbs,
        wordMotion.motion === "b" ? "backward" : "forward",
        wordMotion.motion === "e" ? "end" : "start",
        1,
        wordMotion.semanticClass,
      );
      this.yankRangeByAbsolute(
        currentAbs,
        targetAbs,
        wordMotion.motion === "e",
      );
      return true;
    }

    return false;
  }

  private yankWithCharMotion(motion: CharMotion, targetChar: string): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const col = this.getCursor().col;
    const count = this.takeTotalCount(1);
    const targetCol = findCharMotionTarget(
      line,
      col,
      motion,
      targetChar,
      false,
      count,
    );

    if (targetCol === null) return;

    this.lastCharMotion = { motion, char: targetChar };
    this.yankRange(col, targetCol, true);
  }

  private yankRange(col: number, targetCol: number, inclusive: boolean): void {
    const line = this.getLines()[this.getCursor().line] ?? "";
    const start = Math.min(col, targetCol);
    const rawEnd = Math.max(col, targetCol) + (inclusive ? 1 : 0);
    let end = Math.min(rawEnd, line.length);

    if (inclusive) {
      const targetRange = this.getGraphemeRangeAtCol(
        line,
        Math.max(col, targetCol),
        1,
      );
      end = targetRange?.end ?? end;
    }

    if (end <= start) return;

    this.writeToRegister(line.slice(start, end), "yank");
  }

  private yankRangeByAbsolute(
    currentAbs: number,
    targetAbs: number,
    inclusive: boolean = false,
  ): void {
    const text = this.getText();
    const start = Math.min(currentAbs, targetAbs);
    const rawEnd = Math.max(currentAbs, targetAbs) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, text.length);
    if (end <= start) return;
    this.writeToRegister(text.slice(start, end), "yank");
  }

  private getCursorFromAbsoluteIndex(
    text: string,
    abs: number,
  ): { line: number; col: number } {
    const lines = text.length === 0 ? [""] : text.split("\n");
    let remaining = Math.max(0, Math.min(abs, text.length));
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex] ?? "";
      if (remaining <= line.length) return { line: lineIndex, col: remaining };
      remaining -= line.length + 1;
    }
    const lastLine = Math.max(0, lines.length - 1);
    return { line: lastLine, col: (lines[lastLine] ?? "").length };
  }

  private replaceTextInBuffer(text: string, cursorAbs: number): void {
    if (this.getText() !== text) {
      if (this.currentTransition === "none") {
        this.undoStack.push(this.captureSnapshot());
      }
      this.setText(text);
    }
    this.moveCursorToAbsoluteIndex(cursorAbs);
  }

  private deleteRangeByAbsolute(
    currentAbs: number,
    targetAbs: number,
    inclusive: boolean = false,
  ): void {
    const text = this.getText();
    const start = Math.min(currentAbs, targetAbs);
    const rawEnd = Math.max(currentAbs, targetAbs) + (inclusive ? 1 : 0);
    const end = Math.min(rawEnd, text.length);

    if (end <= start) return;

    this.writeToRegister(text.slice(start, end));

    this.replaceTextInBuffer(text.slice(0, start) + text.slice(end), start);
  }

  private getWordObjectRange(
    kind: TextObjectKind,
    count: number = 1,
    semanticClass: WordTextObjectClass = "word",
  ): TextObjectRange | null {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const line = lines[cursor.line] ?? "";
    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);

    return resolveWordTextObjectRange(
      line,
      lineStartAbs,
      cursor.col,
      kind,
      count,
      semanticClass,
    );
  }

  private static readonly PUT_SIZE_LIMIT = 512 * 1024; // 512 KB safety cap

  private getPasteRegisterText(): string {
    if (this.preferRegisterForPut || this.clipboardMirror.hasPendingWrite()) {
      return this.unnamedRegister;
    }

    try {
      const clipboardText = this.clipboardReadFn();
      return clipboardText ?? this.unnamedRegister;
    } catch {
      return this.unnamedRegister;
    }
  }

  private putAfter(): void {
    const count = this.takeTotalCount(1);
    const text = this.getPasteRegisterText();
    if (!text) return;
    const safeCount = Math.min(
      count,
      Math.max(1, Math.floor(ModalEditor.PUT_SIZE_LIMIT / text.length)),
    );

    if (text.endsWith("\n")) {
      const content = text.slice(0, -1);
      for (let i = 0; i < safeCount; i++) {
        super.handleInput(CTRL_E);
        super.handleInput(NEWLINE);
        for (const char of content) {
          super.handleInput(char === "\n" ? NEWLINE : char);
        }
      }
      return;
    }

    if (!this.isCursorAtOrPastEol()) {
      super.handleInput(ESC_RIGHT);
    }
    for (let i = 0; i < safeCount; i++) {
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
  }

  private putBefore(): void {
    const count = this.takeTotalCount(1);
    const text = this.getPasteRegisterText();
    if (!text) return;
    const safeCount = Math.min(
      count,
      Math.max(1, Math.floor(ModalEditor.PUT_SIZE_LIMIT / text.length)),
    );

    if (text.endsWith("\n")) {
      const content = text.slice(0, -1);
      for (let i = 0; i < safeCount; i++) {
        super.handleInput(CTRL_A);
        super.handleInput(NEWLINE);
        super.handleInput(ESC_UP);
        for (const char of content) {
          super.handleInput(char === "\n" ? NEWLINE : char);
        }
      }
      return;
    }

    for (let i = 0; i < safeCount; i++) {
      for (const char of text) {
        super.handleInput(char === "\n" ? NEWLINE : char);
      }
    }
  }

  private deleteRange(
    col: number,
    targetCol: number,
    inclusive: boolean,
  ): void {
    const cursor = this.getCursor();
    const line = this.getLines()[cursor.line] ?? "";
    const lineStartAbs = this.getAbsoluteIndex(cursor.line, 0);
    const start = Math.min(col, targetCol);
    const rawEnd = Math.max(col, targetCol) + (inclusive ? 1 : 0);
    let end = Math.min(rawEnd, line.length);

    if (inclusive) {
      const targetRange = this.getGraphemeRangeAtCol(
        line,
        Math.max(col, targetCol),
        1,
      );
      end = targetRange?.end ?? end;
    }

    this.deleteRangeByAbsolute(lineStartAbs + start, lineStartAbs + end);
  }

  private takeModeLabelSuffix(rawLabel: string, width: number): string {
    if (width <= 0) return "";

    const graphemes = getLineGraphemes(rawLabel);
    const suffix: string[] = [];
    let usedWidth = 0;

    for (let i = graphemes.length - 1; i >= 0; i--) {
      const grapheme = graphemes[i];
      if (!grapheme) continue;

      const segment = rawLabel.slice(grapheme.start, grapheme.end);
      const segmentWidth = visibleWidth(segment);
      if (usedWidth + segmentWidth > width) break;
      suffix.push(segment);
      usedWidth += segmentWidth;
    }

    return suffix.reverse().join("");
  }

  private fitModeLabel(rawLabel: string, width: number): string {
    if (visibleWidth(rawLabel) <= width) return rawLabel;

    const prefix = rawLabel.startsWith(" INSERT ")
      ? " INSERT "
      : rawLabel.startsWith(" NORMAL ")
        ? " NORMAL "
        : rawLabel.startsWith(" EX ")
          ? " EX "
          : "";

    if (!prefix || visibleWidth(prefix) >= width) {
      return truncateToWidth(rawLabel, width, "");
    }

    const suffixWidth = width - visibleWidth(prefix) - 1;
    if (suffixWidth <= 0) return `${prefix}…`;
    return `${prefix}…${this.takeModeLabelSuffix(rawLabel, suffixWidth)}`;
  }

  private getDesiredCursorShapeSequence(): CursorShapeSequence {
    return "insert" === this.mode && this.pendingExCommand === null
      ? INSERT_CURSOR_SHAPE
      : BLOCK_CURSOR_SHAPE;
  }

  private hasPromptCursorMarker(lines: string[]): boolean {
    return lines.some((line) => line.includes(CURSOR_MARKER));
  }

  private syncCursorShapeForRender(lines: string[]): void {
    if (!this.cursorShapeRuntime) return;
    if (!this.hasPromptCursorMarker(lines)) return;

    if (this.cursorShapeRuntime.getShowHardwareCursor?.() === false) {
      this.lastCursorShapeSequence = null;
      return;
    }


    const sequence = this.getDesiredCursorShapeSequence();
    if (sequence === this.lastCursorShapeSequence) return;

    this.cursorShapeRuntime.writeCursorShape(sequence);
    this.lastCursorShapeSequence = sequence;
  }

  render(width: number): string[] {
    this.lastRenderWidth = width;
    this.recomputeEffectiveTextWidth();
    const lines = this.renderContentLines(width);
    this.syncCursorShapeForRender(lines);
    if (lines.length === 0) return lines;
    if (this.mode === "insert") return lines;

    const rawLabel = this.fitModeLabel(this.getModeLabel(), width);
    const colorize = this.getModeLabelColorizer();
    const label = colorize ? colorize(rawLabel) : rawLabel;
    const last = lines.length - 1;
    const lastLine = lines[last];
    if (lastLine && visibleWidth(lastLine) >= visibleWidth(rawLabel)) {
      const contentWidth = width - visibleWidth(rawLabel);
      const c = this.lastLineCache;
      if (lastLine !== c.l || contentWidth !== c.w || label !== c.label) {
        c.l = lastLine;
        c.w = contentWidth;
        c.label = label;
        c.result = truncateToWidth(lastLine, contentWidth, "") + label;
      }
      lines[last] = c.result;
    } else {
      lines[last] = label;
    }
    return lines;
  }

  private renderContentLines(width: number): string[] {
    const range =
      this.mode === "visual" || this.mode === "visualLine"
        ? this.getSelectionHighlightRange()
        : null;
    if (!range) return [...super.render(width)];

    const text = this.getText();
    const cursorPos = this.getCursor();
    const cursorLineText = this.getLines()[cursorPos.line] ?? "";
    // The terminal-cursor path keeps the cursor grapheme in the post-marker
    // segment; only the software-cursor path displaces a char (an EOL caret
    // renders after the last char in both paths).
    const useTerminalCursor = this.getUseTerminalCursor();
    const cursorAbs = useTerminalCursor
      ? -1
      : cursorPos.col < cursorLineText.length
        ? this.getAbsoluteIndex(cursorPos.line, cursorPos.col)
        : -1;
    const previous = this.decorateText;
    let abs = 0;
    type DecoratePos = { line: number; startCol: number; endCol: number };
    const decorate = (segment: string, pos?: DecoratePos): string => {
      // OMP 18 passes the segment's logical line and source columns
      // directly; 16.x passes unpositioned segments in document order.
      let start: number;
      if (pos) {
        start = this.getAbsoluteIndex(pos.line, pos.startCol);
      } else {
        while (
          abs < text.length &&
          (text[abs] === "\n" || abs === cursorAbs)
        ) {
          abs++;
        }
        if (text.slice(abs, abs + segment.length) !== segment) {
          return segment;
        }
        start = abs;
        abs += segment.length;
      }
      const hs = Math.max(start, range.start) - start;
      const he = Math.min(start + segment.length, range.end) - start;
      if (he <= hs) return segment;
      return (
        segment.slice(0, hs) +
        "\x1b[7m" +
        segment.slice(hs, he) +
        "\x1b[27m" +
        segment.slice(he)
      );
    };
    // OMP 18 hands decorateText a column-info second argument that the
    // pinned @oh-my-pi type does not declare yet.
    this.decorateText = decorate as (segment: string) => string;
    try {
      return [...super.render(width)];
    } finally {
      this.decorateText = previous;
    }
  }

  private getSelectionHighlightRange(): { start: number; end: number } | null {
    if (this.visualAnchor === null) return null;
    if (this.mode === "visualLine") {
      const r = this.visualLineAbsRange();
      return { start: r.startAbs, end: r.endAbs };
    }
    const r = this.getVisualRange();
    return { start: r.startAbs, end: r.endAbs };
  }

  private getModeLabelColorizer(): ((s: string) => string) | null {
    return this.labelColorizers?.[this.getActiveMode()] ?? null;
  }

  private getModeLabel(): string {
    if ("insert" === this.mode) return " INSERT ";
    if (this.mode === "visual") return " VISUAL ";
    if (this.mode === "visualLine") return " V-LINE ";
    if (this.pendingExCommand !== null) return ` EX ${this.pendingExCommand}_ `;

    const prefixCount = this.prefixCount;
    const operatorCount = this.operatorCount;

    if (this.pendingReplace) {
      return prefixCount ? ` NORMAL ${prefixCount}r_ ` : " NORMAL r_ ";
    }
    if (this.pendingOperator && this.pendingMotion) {
      return ` NORMAL ${prefixCount}${this.pendingOperator}${operatorCount}${this.pendingMotion}_ `;
    }
    if (this.pendingOperator) {
      return ` NORMAL ${prefixCount}${this.pendingOperator}${operatorCount}_ `;
    }
    if (this.pendingMotion) return ` NORMAL ${this.pendingMotion}_ `;
    if (this.pendingG) {
      return this.pendingGCount
        ? ` NORMAL g${this.pendingGCount}_ `
        : " NORMAL g_ ";
    }

    const count = `${prefixCount}${operatorCount}`;
    if (count) return ` NORMAL ${count}_ `;
    return " NORMAL ";
  }
}

let activeModeChangeCommand: RunningModeChangeCommand | null = null;
let pendingModeChangeCommand: string | null = null;
let modeChangeCommandRunner: ModeChangeCommandRunner = spawnModeChangeCommand;

export function setModeChangeCommandRunnerForTests(
  next: ModeChangeCommandRunner,
): () => void {
  const prev = modeChangeCommandRunner;
  modeChangeCommandRunner = next;
  return () => {
    modeChangeCommandRunner = prev;
  };
}

function spawnModeChangeCommand(command: string): void {
  if (!command) return;
  if (activeModeChangeCommand) {
    pendingModeChangeCommand = command;
    return;
  }

  startModeChangeCommand(command);
}

function startModeChangeCommand(command: string): void {
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(command, {
      shell: true,
      stdio: "ignore",
      windowsHide: true,
    });
  } catch {
    // spawn rejected synchronously (e.g., EMFILE) — never break the editor
    runPendingModeChangeCommand();
    return;
  }

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (activeModeChangeCommand?.child !== child) return;
    activeModeChangeCommand = null;
    runPendingModeChangeCommand();
  };
  const timeout = setTimeout(() => {
    try {
      child.kill();
    } catch {
      // best effort timeout cleanup
    }
    finish();
  }, MODE_CHANGE_COMMAND_TIMEOUT_MS);
  timeout.unref?.();

  activeModeChangeCommand = { child, timeout };
  child.once("error", finish);
  child.once("close", finish);
}

function runPendingModeChangeCommand(): void {
  const pending = pendingModeChangeCommand;
  pendingModeChangeCommand = null;
  if (pending) startModeChangeCommand(pending);
}

function clearPendingModeChangeCommand(): void {
  pendingModeChangeCommand = null;
}

function cancelModeChangeCommands(): void {
  pendingModeChangeCommand = null;
  const active = activeModeChangeCommand;
  activeModeChangeCommand = null;
  if (!active) return;
  clearTimeout(active.timeout);
  try {
    active.child.kill();
  } catch {
    // best effort session cleanup
  }
}

function createModeChangeHandler(
  modeChange: ModeChangeSettings | undefined,
  emitModeChange: (event: ModeChangeEvent) => void,
): (mode: Mode, prevMode: Mode) => void {
  const insert = modeChange?.insert;
  const normal = modeChange?.normal;
  return (mode, previousMode) => {
    try {
      emitModeChange({ mode, previousMode });
    } catch {
      // Subscribers must not break editing or configured mode-change commands.
    }

    const command = mode === "insert" ? insert : normal;
    if (command) {
      modeChangeCommandRunner(command);
    } else {
      clearPendingModeChangeCommand();
    }
  };
}

export default function (pi: ExtensionAPI) {
  let cursorShapeCleanup: CursorShapeCleanup | null = null;

  pi.on("session_start", (_event, ctx) => {
    const piVimSettings = readPiVimSettings(ctx.cwd);
    const clipboardMirrorPolicy = resolveClipboardMirrorPolicy(
      piVimSettings.clipboardMirror,
    );
    if (clipboardMirrorPolicy.warning && ctx.hasUI) {
      ctx.ui.notify(clipboardMirrorPolicy.warning, "warning");
    }

    const t = ctx.ui.theme;
    const modeColors = resolveModeColors(piVimSettings.modeColors);
    const reverseVideo = (s: string) => `\x1b[7m${s}\x1b[27m`;
    const labelColorizers = t
      ? buildModeColorizers(t, modeColors, reverseVideo)
      : null;
    const borderColorizers =
      t && piVimSettings.syncBorderColorWithMode === true
        ? buildModeColorizers(t, modeColors)
        : null;
    const modeChangeHandler = createModeChangeHandler(
      piVimSettings.modeChange,
      (event) => pi.events.emit("omp-vim:mode-change", event),
    );
    ctx.ui.setEditorComponent((tui, theme, kb) => {
      cursorShapeCleanup = enableCursorShapeSupport(tui);
      const editor = new ModalEditor(tui, theme, kb, {
        labelColorizers,
        borderColorizers,
        escapeSequence: piVimSettings.escapeSequence,
        escapeSequenceTimeoutMs: piVimSettings.escapeSequenceTimeoutMs,
      });
      editor.setClipboardMirrorPolicy(clipboardMirrorPolicy.policy);
      editor.setQuitFn(() => ctx.shutdown());
      editor.setNotifyFn((message) => ctx.ui.notify(message, "warning"));
      editor.setModeChangeFn(modeChangeHandler);
      return editor;
    });
  });

  pi.on("session_shutdown", (_event) => {
    try {
      cursorShapeCleanup?.({ reason: "quit" });
    } finally {
      cancelModeChangeCommands();
      cursorShapeCleanup = null;
    }
  });
}
