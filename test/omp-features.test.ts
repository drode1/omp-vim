// Durable behavior tests for the shipped omp-vim extension.
// The legacy test/ suite still targets the upstream @earendil-works API and is
// not ported; CI runs only this file plus the shipped-source typecheck.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getEditorTheme } from "@oh-my-pi/pi-coding-agent";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { ModalEditor } from "../index.ts";

const ESC = "\x1b";

function makeEditor() {
  const ed = new ModalEditor(undefined, getEditorTheme(), undefined, {});
  const notes: string[] = [];
  ed.setNotifyFn((m: string) => notes.push(m));
  const keys = (s: string) => {
    for (const c of s) ed.handleInput(c);
  };
  return { ed, notes, keys };
}

function runEx(ed: ModalEditor, keys: (s: string) => void, cmd: string) {
  keys(`${ESC}:`);
  keys(cmd);
  ed.handleInput("\r");
}

test("mode label is hidden in insert mode and shown in normal mode", () => {
  const { ed, keys } = makeEditor();
  keys("hello world this is a fairly long line of text here");
  const insertLines = ed.render(40);
  assert.ok(!insertLines.some((l) => l.includes("INSERT")));
  assert.ok(insertLines.some((l) => l.includes("text here")));
  keys(ESC);
  assert.ok(ed.render(40).some((l) => l.includes("NORMAL")));
});

test("autowrap breaks at the last word boundary and consumes one space", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = min(120, 60-6) = 54
  const long = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ll mm";
  keys(long);
  assert.ok(ed.getLines().length > 1);
  assert.equal(ed.getLines().join(" "), long);
  assert.ok(visibleWidth(ed.getLines()[0] ?? "") <= 54);
});

test("wrapping measures display columns: CJK and emoji stay intact", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  const cjk = "你".repeat(30); // 60 display columns
  keys(cjk);
  const lines = ed.getLines();
  assert.equal(lines.join(""), cjk);
  assert.ok(visibleWidth(lines[0] ?? "") <= 54);

  const emojiText = "a".repeat(53) + "👍".repeat(3);
  const ed2 = makeEditor().ed;
  ed2.render(60);
  for (const c of emojiText) ed2.handleInput(c);
  const lines2 = ed2.getLines();
  assert.equal(lines2.join(""), emojiText);
  assert.equal(lines2[1], "👍👍👍");
});

test("cursor lands at the mapped position for mid-tail wraps", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  ed.setText(`short\n${"a".repeat(49)} ${"c".repeat(12)}`);
  keys(`${ESC}ggj55l`); // normal mode, cursor to (1, 55) — inside the c-run

  type WrapProbe = { wrapCurrentLineIfNeeded(): void };
  // White-box seam: the mid-tail wrap cursor path is not reachable by
  // keystrokes alone because typing always overflows at end-of-line.
  const probe = ed as unknown as WrapProbe;
  probe.wrapCurrentLineIfNeeded();

  assert.equal(
    ed.getText(),
    `short\n${"a".repeat(49)}\n${"c".repeat(12)}`,
  );
  assert.deepEqual(ed.getCursor(), { line: 2, col: 5 });
});

test(":set tw / fo mutate wrap state; etw is a read-only derived query", () => {
  const { ed, notes, keys } = makeEditor();
  ed.render(60);
  runEx(ed, keys, "set tw=60");
  keys("i");
  const long = "aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ll mm";
  keys(long);
  assert.ok(ed.getLines().length > 1);
  assert.equal(ed.getLines().join(" "), long);

  runEx(ed, keys, "set etw?");
  assert.ok(notes.includes("effectivetextwidth=54"));
  runEx(ed, keys, "set tw?");
  assert.ok(notes.includes("textwidth=60"));

  runEx(ed, keys, "set fo=");
  keys("i");
  const before = ed.getLines().length;
  keys(" nn oo pp qq rr ss tt");
  assert.equal(ed.getLines().length, before);
  runEx(ed, keys, "set fo+=t");
  keys("a");
  keys(" uu vv ww xx yy zz 00 11 22 33 44 55");
  assert.ok(ed.getLines().length > before);
});

test("etw below 40 disables wrapping and reports 0", () => {
  const { ed, notes, keys } = makeEditor();
  ed.render(44); // 44 - 6 = 38 < 40 -> etw 0
  keys("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ll mm nn");
  assert.equal(ed.getLines().length, 1);
  runEx(ed, keys, "set etw?");
  assert.ok(notes.includes("effectivetextwidth=0"));
});

test("textwidth=0 disables wrapping", () => {
  const { ed, keys } = makeEditor();
  ed.render(100);
  runEx(ed, keys, "set textwidth=0");
  keys("i");
  keys("x".repeat(200));
  assert.equal(ed.getLines().length, 1);
});

test("visual forward selection, surround, and U redo keep working", () => {
  const { ed, keys } = makeEditor();
  keys("hello world");
  keys(`${ESC}0`);
  keys("vlllld");
  assert.equal(ed.getText(), " world");

  const ed2 = makeEditor().ed;
  const keys2 = (s: string) => {
    for (const c of s) ed2.handleInput(c);
  };
  keys2("'hello'");
  keys2(`${ESC}0l`);
  keys2("cs'\"");
  assert.equal(ed2.getText(), '"hello"');

  const ed3 = makeEditor().ed;
  const keys3 = (s: string) => {
    for (const c of s) ed3.handleInput(c);
  };
  keys3("hello");
  keys3(`${ESC}0`);
  keys3("ysiw\"");
  assert.equal(ed3.getText(), '"hello"');

  const ed4 = makeEditor().ed;
  const keys4 = (s: string) => {
    for (const c of s) ed4.handleInput(c);
  };
  keys4("hello");
  keys4(`${ESC}0x`);
  keys4("u");
  assert.equal(ed4.getText(), "hello");
  keys4("U");
  assert.equal(ed4.getText(), "ello");
});

test("visual backward selection: from the last char, across the anchor", () => {
  const { ed, keys } = makeEditor();
  // v on 'f', h -> on 'e': selection "ef"
  keys("abcdef");
  keys(`${ESC}vhd`);
  assert.equal(ed.getText(), "abcd");

  // v on 'f', hh -> on 'd': selection "def" (anchor char included)
  const ed2 = makeEditor().ed;
  const keys2 = (s: string) => {
    for (const c of s) ed2.handleInput(c);
  };
  keys2("abcdef");
  keys2(`${ESC}vhh`);
  keys2("d");
  assert.equal(ed2.getText(), "abc");
});

test("normal-mode l never rests on the EOL caret (regression)", () => {
  const { ed, keys } = makeEditor();
  // Historically: ESC l put the caret one past the last char, so v anchored
  // at a phantom position and backward selects covered the wrong span.
  keys("abcdef");
  keys(`${ESC}l`); // vim: stays on 'f'
  keys("v");
  keys("hh");
  keys("d");
  assert.equal(ed.getText(), "abc");

  // yank registers the same span backwards
  const ed2 = makeEditor().ed;
  const keys2 = (s: string) => {
    for (const c of s) ed2.handleInput(c);
  };
  keys2("abcdef");
  keys2(`${ESC}lvhy`);
  assert.equal(ed2.getRegister(), "ef");
});

test("backward selection renders the highlight on the left span", () => {
  const { ed, keys } = makeEditor();
  keys("abcdef");
  keys(`${ESC}vhh`); // cursor on 'd', anchor 'f': selection "def"
  const lines = ed.render(44);
  const rendered = lines.at(-1) ?? "";
  assert.ok(rendered.includes("\x1b[7mef\x1b[27m"));
  assert.ok(!rendered.includes("\x1b[7mab"));
});

test("linewise backward selection (V then k) deletes both lines", () => {
  const { ed, keys } = makeEditor();
  keys("one");
  keys(`${ESC}o`);
  keys("two");
  keys(`${ESC}Vkd`);
  assert.equal(ed.getText(), "");
});

test("j/k keep the preferred column across shorter lines", () => {
  const { ed, keys } = makeEditor();
  keys("a".repeat(60));
  keys(`${ESC}o`);
  keys("ab" + ESC + "o");
  keys("c".repeat(60) + ESC);
  keys("gg50l");
  assert.deepEqual(ed.getCursor(), { line: 0, col: 50 });
  keys("j");
  assert.deepEqual(ed.getCursor(), { line: 1, col: 2 }); // base EOL caret, clamp skipped for vertical
  keys("1j"); // digit arrives while the caret rests at EOL: sticky must survive
  assert.deepEqual(ed.getCursor(), { line: 2, col: 50 }); // sticky restored
  keys("1k");
  assert.deepEqual(ed.getCursor(), { line: 1, col: 2 });
});

test("charwise visual selection across a short line stays in bounds", () => {
  const { ed, keys } = makeEditor();
  keys("a".repeat(60));
  keys(`${ESC}o`);
  keys("ab" + ESC + "o");
  keys("c".repeat(60) + ESC);
  keys("gg50l");
  keys("vjj"); // anchor (0,50) -> cursor (2,50) through the 2-char line
  keys("d");
  // The selection spans both newlines, so the delete joins the fragments.
  assert.equal(ed.getText(), `${"a".repeat(50)}${"c".repeat(9)}`);
});

test("$ anchors visual on the last char for backward yank", () => {
  const { ed, keys } = makeEditor();
  keys("abcdef");
  keys(`${ESC}$`);
  keys("vhh");
  keys("y");
  assert.equal(ed.getRegister(), "def");
});

test("backward visual k onto a short line keeps its last char", () => {
  const { ed, keys } = makeEditor();
  keys("ab" + ESC + "o");
  keys("c".repeat(60) + ESC);
  keys("ggj50l"); // (1, 50)
  keys("v");
  keys("k"); // cursor to the EOL caret of "ab"; interval math includes 'b'
  keys("d");
  assert.equal(ed.getText(), `a${"c".repeat(9)}`);
});

test("visual range never splits an emoji at the edge", () => {
  const { ed, keys } = makeEditor();
  keys("hi 👍");
  keys(`${ESC}ggv$d`);
  assert.equal(ed.getText(), "");
});

test("clamp handles wide graphemes: l rests on the last grapheme", () => {
  const { ed, keys } = makeEditor();
  keys("👍a");
  keys(`${ESC}l`); // must rest ON 'a', not the EOL caret past it
  keys("vhh");
  keys("d");
  assert.equal(ed.getText(), "");
});

test("one-step backward select with a wide char at the anchor", () => {
  const { ed, keys } = makeEditor();
  // After ESC l the caret must rest on 'b' (not the EOL caret), so a single
  // h selects "ab" — not just the anchor's neighbor.
  keys("👍ab");
  keys(`${ESC}l`);
  keys("vhd");
  assert.equal(ed.getText(), "👍");
});

test("x after l on a wide-char line deletes the last grapheme", () => {
  const { ed, keys } = makeEditor();
  keys("👍a");
  keys(`${ESC}lx`);
  assert.equal(ed.getText(), "👍");
});

test("backward selection decorates on the terminal-cursor path (OMP 18)", () => {
  const { ed, keys } = makeEditor();
  ed.focused = true; // focused prompt: the pre/post-marker seam exists
  ed.setUseTerminalCursor(true);
  keys("abcdef");
  keys(`${ESC}vhh`);
  const lines = ed.render(44);
  const rendered = lines.at(-1) ?? "";
  // Terminal-cursor path: the cursor grapheme stays in the post-marker
  // segment, so the inverted span includes the cursor char ("def").
  assert.ok(rendered.includes("\x1b[7mdef\x1b[27m"), rendered);
});
test("fo=t: mid-line edits never rewrap a fitting line", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  runEx(ed, keys, "set fo=t");
  keys("i");
  keys("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ll mm");
  assert.ok(ed.getLines().length > 1); // EOL typing wraps as usual
  keys(`${ESC}0lll`); // mid-line (col 3) on the wrapped head
  keys("iXX\x1b"); // mid-line insertion grows the overflow — no reflow
  assert.equal(ed.getLines().length, 2);
  assert.ok(ed.getText().includes("XX"));
});

test("fo=a (default) reflows the paragraph on mid-line edits", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  keys("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ll mm");
  keys(`${ESC}0`);
  keys("iXX "); // mid-line insertion (with space) pushes the overflow
  keys("\x1b");
  const lines = ed.getLines();
  assert.ok(lines.length > 1, JSON.stringify(lines));
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 54, JSON.stringify(lines));
  }
  const words = ed
    .getText()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join("|");
  assert.equal(
    words,
    ["XX", "aaaa", "bbbb", "cccc", "dddd", "eeee", "ffff", "gggg", "hhhh", "iiii", "jjjj", "kkkk", "ll", "mm"]
      .sort()
      .join("|"),
  );
});

test("reflow keeps adjacent list items separate with hanging indentation", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  runEx(ed, keys, "set fo=");
  const firstItem = "  - first item stays on its own line";
  const secondBody = Array<string>(12).fill("second").join(" ");
  ed.setText(`${firstItem}\n  2. ${secondBody}`);
  runEx(ed, keys, "set fo=at");

  keys("G$aX");
  keys(ESC);

  const lines = ed.getLines();
  assert.equal(lines[0], firstItem);
  assert.ok(lines.length > 2, JSON.stringify(lines));
  assert.ok(lines[1]?.startsWith("  2. "), JSON.stringify(lines));
  for (const line of lines.slice(2)) {
    assert.match(line, /^ {5}\S/, JSON.stringify(lines));
  }
  assert.equal(
    [
      (lines[1] ?? "").slice("  2. ".length),
      ...lines.slice(2).map((line) => line.slice("     ".length)),
    ].join(" "),
    `${secondBody}X`,
  );
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= 54, JSON.stringify(lines));
  }
});

test("fo=t wraps bullet continuations at the list content indentation", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  runEx(ed, keys, "set fo=t");
  keys("i");
  const body = Array<string>(18).fill("alpha").join(" ");
  keys(`  - ${body}`);

  const lines = ed.getLines();
  assert.ok(lines.length > 1, JSON.stringify(lines));
  assert.ok(lines[0]?.startsWith("  - "), JSON.stringify(lines));
  for (const line of lines.slice(1)) {
    assert.match(line, /^ {4}\S/, JSON.stringify(lines));
  }
  assert.equal(
    [
      (lines[0] ?? "").slice("  - ".length),
      ...lines.slice(1).map((line) => line.slice("    ".length)),
    ].join(" "),
    body,
  );
});

test("autowrap is fully disabled inside fenced code blocks", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54, fo=at default
  keys("```ts");
  keys(`${ESC}o`);
  keys("aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk ll mm nn oo pp qq");
  assert.equal(ed.getLines().length, 2); // fence line + unwrapped long line
  keys(`${ESC}o`);
  keys("```");
  keys(`${ESC}o`);
  keys("zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz zz");
  assert.ok(ed.getLines().length > 4, JSON.stringify(ed.getLines()));
});

test("formatoptions defaults to at and is queryable", () => {
  const { ed, notes, keys } = makeEditor();
  keys(`${ESC}:`);
  keys("set fo?");
  ed.handleInput("\r");
  assert.ok(notes.includes("formatoptions=at"), JSON.stringify(notes));
});
test("a reflow rebalances earlier lines for past-margin edits", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  runEx(ed, keys, "set fo="); // build the fixture without wrapping
  keys("i");
  keys("aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa aaaa");
  keys(`${ESC}o`);
  keys("bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb bbbb");
  keys(`${ESC}o`);
  keys("cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc cccc");
  runEx(ed, keys, "set fo=at"); // enable the feature under test
  keys(`${ESC}ggjj55l`); // (2, 55): insertion point at/past the margin
  keys("i ZZZZ \x1b"); // separated token; ends in whitespace -> deferred
  const lines = ed.getLines();
  for (const l of lines) {
    assert.ok(visibleWidth(l) <= 54, JSON.stringify(lines));
  }
  // The earlier underfilled line (49 cols) packed up to the margin: the
  // whole paragraph rebalanced, which the old dispatch could not do.
  assert.equal(visibleWidth(lines[0]), 54);
  const words = ed
    .getText()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join("|");
  assert.equal(
    words,
    [
      "ZZZZ",
      ...Array<string>(10).fill("aaaa"),
      ...Array<string>(10).fill("bbbb"),
      ...Array<string>(14).fill("cccc"),
    ]
      .sort()
      .join("|"),
  );
});

test("reflow cursor stays adjacent for an insertion inside a hard-split word", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  runEx(ed, keys, "set fo="); // build one long unsplit line
  keys("i");
  keys("w".repeat(140) + " end"); // prefix-free: the reflow's breaks must
  // reconstruct exactly this word when newlines are stripped
  runEx(ed, keys, "set fo=at"); // feature under test
  keys("0120l"); // col 120: offInWord ≈ 120, past the second hard-split
  // piece boundary — keeps Y below the width so no second reflow fires
  keys("iXY\x1b"); // "XY" must stay adjacent to each other and to the w's
  const text = ed.getText().replace(/\n/g, "");
  assert.equal(
    text,
    "w".repeat(120) + "XY" + "w".repeat(20) + " end",
  );
  for (const l of ed.getLines()) {
    assert.ok(visibleWidth(l) <= 54, JSON.stringify(ed.getLines()));
  }
});

test("second reflow during hard-split typing keeps adjacency (X then Y)", () => {
  const { ed, keys } = makeEditor();
  ed.render(60); // etw = 54
  runEx(ed, keys, "set fo=");
  keys("i");
  keys("w".repeat(140) + " end"); // prefix-free fixture
  runEx(ed, keys, "set fo=at"); // feature under test
  keys("084l"); // col 84: offInWord ≈ 84 — inside the second hard-split
  // chunk, so X forces the first reflow and Y (crossing etw at its new
  // position) forces the second; both must keep XY adjacent and ordered
  keys("iXY\x1b");
  const text = ed.getText().replace(/\n/g, "");
  // Exact content: the reflows consumed only break spaces; X and Y must
  // stay adjacent and in order at their insertion offset (col 84).
  assert.equal(text, "w".repeat(84) + "XY" + "w".repeat(56) + " end");
  for (const l of ed.getLines()) {
    assert.ok(visibleWidth(l) <= 54, JSON.stringify(ed.getLines()));
  }
});


// --- insert escape sequences (jk / jj) ---

function makeEditorWithEscape(
  sequences: string[],
  timeoutMs = 300,
) {
  const ed = new ModalEditor(undefined, getEditorTheme(), undefined, {
    escapeSequence: sequences,
    escapeSequenceTimeoutMs: timeoutMs,
  });
  const notes: string[] = [];
  ed.setNotifyFn((m: string) => notes.push(m));
  const keys = (s: string) => {
    for (const c of s) ed.handleInput(c);
  };
  return { ed, notes, keys };
}

test("jk exits insert and removes the typed j", () => {
  const { ed, keys } = makeEditorWithEscape(["jk"]);
  keys("hellojk");
  assert.equal(ed.getMode(), "normal");
  assert.equal(ed.getText(), "hello");
});

test("jj exits insert and removes the typed j when configured", () => {
  const { ed, keys } = makeEditorWithEscape(["jk", "jj"]);
  keys("abjj");
  assert.equal(ed.getMode(), "normal");
  assert.equal(ed.getText(), "ab");
});

test("both jk and jj work when configured together", () => {
  const a = makeEditorWithEscape(["jk", "jj"]);
  a.keys("xjk");
  assert.equal(a.ed.getMode(), "normal");
  assert.equal(a.ed.getText(), "x");

  const b = makeEditorWithEscape(["jk", "jj"]);
  b.keys("yjj");
  assert.equal(b.ed.getMode(), "normal");
  assert.equal(b.ed.getText(), "y");
});

test("jx stays in insert and keeps both chars", () => {
  const { ed, keys } = makeEditorWithEscape(["jk"]);
  keys("jx");
  assert.equal(ed.getMode(), "insert");
  assert.equal(ed.getText(), "jx");
});

test("j then timeout stays as normal input", async () => {
  const { ed, keys } = makeEditorWithEscape(["jk"], 50);
  keys("j");
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(ed.getMode(), "insert");
  assert.equal(ed.getText(), "j");
  keys("k");
  assert.equal(ed.getMode(), "insert");
  assert.equal(ed.getText(), "jk");
});

test("j then Esc enters normal and leaves exactly one j", () => {
  const { ed, keys } = makeEditorWithEscape(["jk"]);
  keys("j");
  keys(ESC);
  assert.equal(ed.getMode(), "normal");
  assert.equal(ed.getText(), "j");
});

test("unset escapeSequence keeps jk as text in insert", () => {
  const { ed, keys } = makeEditor();
  keys("jk");
  assert.equal(ed.getMode(), "insert");
  assert.equal(ed.getText(), "jk");
});

test("modified insert shortcut clears pending escape sequence", () => {
  const { ed, keys } = makeEditorWithEscape(["jk"]);
  keys("helloj");
  // Shift+Alt+A -> go to end of line; clears pending, stays insert
  ed.handleInput("\x1bA");
  assert.equal(ed.getMode(), "insert");
  keys("k");
  assert.equal(ed.getMode(), "insert");
  assert.equal(ed.getText(), "hellojk");
});
