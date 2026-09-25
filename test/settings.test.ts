import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS,
  normalizeEscapeSequenceTimeoutMs,
  normalizeEscapeSequences,
  readPiVimBooleanSetting,
  readPiVimClipboardMirrorSetting,
  readPiVimEscapeSequence,
  readPiVimEscapeSequenceTimeoutMs,
  readPiVimModeChange,
  readPiVimModeColors,
} from "../settings.js";

describe("piVim mode color settings reader", () => {
  it("returns undefined when mode colors are missing", () => {
    assert.equal(readPiVimModeColors(undefined, undefined), undefined);
    assert.equal(readPiVimModeColors({ piVim: {} }, { piVim: {} }), undefined);
  });

  it("reads partial mode color settings", () => {
    assert.deepEqual(
      readPiVimModeColors(
        { piVim: { modeColors: { insert: " borderMuted " } } },
        {},
      ),
      { insert: "borderMuted" },
    );
  });

  it("reads all three mode color settings", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "muted",
              normal: "primary",
              ex: "warning",
            },
          },
        },
        {},
      ),
      { insert: "muted", normal: "primary", ex: "warning" },
    );
  });

  it("drops non-string mode color leaves", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: { modeColors: { insert: "muted", normal: 42, ex: "warning" } },
        },
        {},
      ),
      { insert: "muted", ex: "warning" },
    );
  });

  it("drops malformed mode color tokens", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "red;evil",
              normal: "_bad",
              ex: "warn-ing_1",
            },
          },
        },
        {},
      ),
      { ex: "warn-ing_1" },
    );
  });

  it("lets project modeColors override global as a setting", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "globalInsert",
              normal: "globalNormal",
              ex: "globalEx",
            },
          },
        },
        { piVim: { modeColors: { ex: "projectEx" } } },
      ),
      { ex: "projectEx" },
    );
  });

  it("does not fall back to global modeColors when project leaves are invalid", () => {
    assert.deepEqual(
      readPiVimModeColors(
        {
          piVim: {
            modeColors: {
              insert: "globalInsert",
              normal: "globalNormal",
              ex: "globalEx",
            },
          },
        },
        {
          piVim: {
            modeColors: {
              insert: "projectInsert",
              normal: 42,
              ex: "red;evil",
            },
          },
        },
      ),
      { insert: "projectInsert" },
    );
  });

  it("treats malformed project modeColors as an override", () => {
    assert.equal(
      readPiVimModeColors(
        { piVim: { modeColors: { insert: "globalInsert" } } },
        { piVim: { modeColors: null } },
      ),
      undefined,
    );
  });
});

describe("piVim boolean settings reader", () => {
  it("returns undefined when boolean setting is missing", () => {
    assert.equal(
      readPiVimBooleanSetting(undefined, undefined, "syncBorderColorWithMode"),
      undefined,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: {} },
        { piVim: {} },
        "syncBorderColorWithMode",
      ),
      undefined,
    );
  });

  it("reads true and false boolean settings", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: true } },
        {},
        "syncBorderColorWithMode",
      ),
      true,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: false } },
        {},
        "syncBorderColorWithMode",
      ),
      false,
    );
  });

  it("ignores invalid boolean settings", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: "true" } },
        {},
        "syncBorderColorWithMode",
      ),
      undefined,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: 1 } },
        {},
        "syncBorderColorWithMode",
      ),
      undefined,
    );
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: null } },
        {},
        "syncBorderColorWithMode",
      ),
      undefined,
    );
  });

  it("lets project boolean settings override global", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: false } },
        "syncBorderColorWithMode",
      ),
      false,
    );
  });

  it("treats invalid project boolean settings as an override", () => {
    assert.equal(
      readPiVimBooleanSetting(
        { piVim: { syncBorderColorWithMode: true } },
        { piVim: { syncBorderColorWithMode: "false" } },
        "syncBorderColorWithMode",
      ),
      undefined,
    );
  });
});

describe("piVim modeChange settings reader", () => {
  it("returns undefined when modeChange is missing", () => {
    assert.equal(readPiVimModeChange(undefined, undefined), undefined);
    assert.equal(readPiVimModeChange({ piVim: {} }, { piVim: {} }), undefined);
  });

  it("reads partial modeChange settings and trims values", () => {
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "  im-select Squirrel  " } } },
        {},
      ),
      { insert: "im-select Squirrel" },
    );
  });

  it("reads both insert and normal commands", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: {
            modeChange: {
              insert: "im-select im.rime.inputmethod.Squirrel.Hans",
              normal: "im-select com.apple.keylayout.ABC",
            },
          },
        },
        {},
      ),
      {
        insert: "im-select im.rime.inputmethod.Squirrel.Hans",
        normal: "im-select com.apple.keylayout.ABC",
      },
    );
  });

  it("drops non-string and empty modeChange leaves", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: { modeChange: { insert: 42, normal: "  " } },
        },
        {},
      ),
      undefined,
    );
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "ok", normal: 42 } } },
        {},
      ),
      { insert: "ok" },
    );
  });

  it("ignores project modeChange settings because commands are global-only", () => {
    assert.deepEqual(
      readPiVimModeChange(
        {
          piVim: {
            modeChange: { insert: "global-insert", normal: "global-normal" },
          },
        },
        { piVim: { modeChange: { normal: "project-normal" } } },
      ),
      { insert: "global-insert", normal: "global-normal" },
    );
    assert.deepEqual(
      readPiVimModeChange(
        {},
        { piVim: { modeChange: { insert: "project-insert" } } },
      ),
      undefined,
    );
  });

  it("does not let invalid project modeChange suppress global commands", () => {
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { insert: "global-insert" } } },
        { piVim: { modeChange: null } },
      ),
      { insert: "global-insert" },
    );
    assert.deepEqual(
      readPiVimModeChange(
        { piVim: { modeChange: { normal: "global-normal" } } },
        { piVim: { modeChange: { insert: "   " } } },
      ),
      { normal: "global-normal" },
    );
  });
});

describe("piVim clipboard mirror settings reader", () => {
  it("returns undefined when global and project settings are missing", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(undefined, undefined),
      undefined,
    );
    assert.equal(readPiVimClipboardMirrorSetting(null, null), undefined);
    assert.equal(readPiVimClipboardMirrorSetting("bad", 42), undefined);
  });

  it("reads global piVim clipboardMirror when project setting is missing", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        {},
      ),
      "yank",
    );
  });

  it("lets project piVim clipboardMirror override global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "never" } },
        { piVim: { clipboardMirror: "all" } },
      ),
      "all",
    );
  });

  it("treats invalid project clipboardMirror as an override instead of falling back to global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        { piVim: { clipboardMirror: null } },
      ),
      null,
    );
  });

  it("treats malformed project piVim settings as an override instead of falling back to global", () => {
    assert.equal(
      readPiVimClipboardMirrorSetting(
        { piVim: { clipboardMirror: "yank" } },
        { piVim: "bad" },
      ),
      "bad",
    );
  });
});


describe("escapeSequence settings", () => {
  it("normalizes string and array sequences and drops invalids", () => {
    assert.deepEqual(normalizeEscapeSequences("jk"), ["jk"]);
    assert.deepEqual(normalizeEscapeSequences(["jk", "jj", "jk"]), ["jk", "jj"]);
    assert.deepEqual(normalizeEscapeSequences(["j", "jkk", "1k", 42, null]), []);
    assert.deepEqual(normalizeEscapeSequences(null), []);
    assert.deepEqual(normalizeEscapeSequences(""), []);
  });

  it("reads project override including explicit disable", () => {
    assert.deepEqual(
      readPiVimEscapeSequence(
        { ompVim: { escapeSequence: ["jk"] } },
        { ompVim: { escapeSequence: null } },
      ),
      [],
    );
    assert.deepEqual(
      readPiVimEscapeSequence(
        { piVim: { escapeSequence: "jk" } },
        { ompVim: { escapeSequence: ["jj"] } },
      ),
      ["jj"],
    );
  });

  it("clamps timeout and defaults invalid values", () => {
    assert.equal(normalizeEscapeSequenceTimeoutMs(undefined), DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS);
    assert.equal(normalizeEscapeSequenceTimeoutMs(10), 50);
    assert.equal(normalizeEscapeSequenceTimeoutMs(5000), 2000);
    assert.equal(normalizeEscapeSequenceTimeoutMs(250.9), 250);
    assert.equal(
      readPiVimEscapeSequenceTimeoutMs(
        { ompVim: { escapeSequenceTimeoutMs: 120 } },
        { ompVim: { escapeSequenceTimeoutMs: "nope" } },
      ),
      DEFAULT_ESCAPE_SEQUENCE_TIMEOUT_MS,
    );
  });
});
