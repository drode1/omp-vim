# omp-vim

Modal vim-like editing for [Oh My Pi](https://github.com/can1357/oh-my-pi)'s input prompt. Covers the high-frequency 90% command surface.

This is an Oh My Pi port of [`pi-vim`](https://github.com/lajarre/pi-vim) by lajarre. See [Oh My Pi port](#oh-my-pi-port) for what changed and current limitations.

## install

From a local checkout:

```bash
git clone https://github.com/boazy/omp-vim
omp plugin install ./omp-vim
```

Or directly from git:

```bash
omp plugin install git+https://github.com/boazy/omp-vim
```

Restart Oh My Pi after install. Only one prompt-editor extension can be active at a time.

## Oh My Pi port

Changes from upstream `pi-vim` required to run on Oh My Pi's compiled binary and current `@oh-my-pi/*` API:

- Imports target `@oh-my-pi/pi-coding-agent`, `@oh-my-pi/pi-tui`, and `@oh-my-pi/pi-natives`; the manifest uses the `omp.extensions` key.
- System-clipboard mirroring is in-process: `copyToClipboard` from `@oh-my-pi/pi-natives` for writes, and platform binaries (`pbpaste` / `wl-paste` / `xclip` / `xsel` / PowerShell) for reads. Upstream's `import.meta.resolve` + `process.execPath` subprocess helpers are removed — they cannot work inside a compiled binary.
- The buffer/cursor engine is rerouted onto Oh My Pi's public `Editor` API (`setText`, `insertText`, `moveTo*`, arrow-key navigation) because Oh My Pi keeps editor state private. Cursor positioning is O(n) in prompt length, which is fine for short prompts.
- Undo/redo is a self-contained snapshot stack (Oh My Pi does not expose the host undo hook).

Known limitations: initial insert-mode typing (before the first `Esc`) is not undoable (wrap/normal-mode edits are); `cw` includes the trailing space; the inherited test suite still targets the upstream API and is not yet ported.

## Additions beyond pi-vim

Features this fork adds on top of upstream pi-vim:

### Visual mode

- `v` charwise, `V` linewise. The selection is highlighted and the block cursor marks the active end.
- Motions extend the selection in both directions (`h/j/k/l`, `w/b/e/W/B/E`, `0/$/^`, `gg/G`, `f/t/;/,`, `%`, `{/}`); `o` swaps the active end. Horizontal motions (`h`/`l`/arrows) never rest past the last character (vim parity), so backward selections always include the anchor char. Vertical `j`/`k` keep the base editor's sticky-column behavior and may rest at a short line's end — selection math still includes that line's last char.
- Text objects select their range: `iw/aw/iW/aW` and quote/bracket objects (`i"`, `a(`, `ab`, `aB`, …).
- Operators act on the selection: `d`/`x` delete, `c`/`s` change, `y` yank, `p`/`P` replace with the register, `r{char}` replace every selected char, `S{char}` surround the selection. `Esc` returns to normal mode.

### surround.vim (subset)

- `ds{target}` — delete the surrounding pair (e.g. `ds"` on `"hello"` → `hello`).
- `cs{target}{replacement}` — change the surrounding pair (e.g. `cs'"` on `'hello'` → `"hello"`).
- `ys{textobject}{char}` — add a surrounding pair around a text object (e.g. `ysiw)` wraps the word in parens; `yss"` wraps the whole line).

Targets/replacements: `( ) b`, `{ } B`, `[ ] r`, `< >`, `"`, `'`, `` ` ``. Opening brackets (`( [ { <`) add inner spaces (`( x )`); closing forms and letters are tight (`(x)`). `ys` supports text objects (`iw`/`aw`/`i"`/…), `yss` (whole line), and `$`.

### Redo

`U` is a redo alias alongside `Ctrl-R`.

### Word wrapping

Autowrap is on by default with `textwidth` (`tw`) 120 and `formatoptions` (`fo`) `at` — set via the ex mini-mode:

- `:set tw=80` / `:set textwidth=80` — set the wrap column (`0` disables).
- `:set fo=at` / `:set fo=` / `:set fo+=a` / `:set fo-=a` … — supported flags are `t` and `a` (others are ignored with a warning).
- `:set tw?`, `:set fo?` — query values.
- `:set etw?` — query the read-only `effectivetextwidth` (`etw`): the actual wrap width, `min(textwidth, prompt_width - 6)`, recomputed as the prompt widget resizes. When `etw` drops below 40 it is automatically forced to `0`, disabling autowrap on narrow prompts.

Flag semantics:

- `t` — wraps while you type **at/past the wrap margin** (the insertion point crosses `etw`). Mid-line edits on a fitting line never wrap; the line is allowed to exceed `etw`.
- `a` — additionally **reflows the whole paragraph** (contiguous non-blank lines) when a mid-line edit pushes it past the margin: the paragraph is greedily re-filled to `etw` in display columns (wide chars and emoji never split), and whitespace at the reflow breaks is normalized. One exception: if the edited line itself is whitespace-free (a hard-split word mid-typing), the overflow is handled by the plain line break instead of the paragraph fill — refilling would re-parse the neighboring chunks as words and glue them with spaces. Enabled by default together with `t`.
- Inside fenced code blocks (``` fences, with or without a language) autowrap is fully disabled — both flags — wherever the cursor is within the fence's line range, which is why `a` is safe to enable by default. Fence delimiters and fenced lines are also hard barriers: a paragraph reflow outside the fence never pulls fence lines or code-block content in.
List item markers (`-`, `*`, `+`, `1.`, and `1)`) are paragraph boundaries. Reflow preserves the marker and uses a hanging indent for wrapped continuation lines.

While typing in insert mode with autowrap enabled, the current line breaks at the last word boundary at or before `etw` (the break consumes one space, like vim). Wraps are undoable steps.

### Mode label

The mode label is shown in normal, visual, and EX modes. In insert mode it is hidden entirely so it can never cover the end of a long line.

## configure

Settings are read from `~/.omp/agent/settings.json` and project `.omp/settings.json` under the `ompVim` key (the legacy `piVim` key is still accepted).

Default-equivalent `settings.json`:

```json
{
  "ompVim": {
    "clipboardMirror": "all",
    "modeColors": {
      "insert": "borderMuted",
      "normal": "borderAccent",
      "ex": "warning"
    },
    "syncBorderColorWithMode": false
  }
}
```

Optional insert-escape example (feature is off unless set):

```json
{
  "ompVim": {
    "escapeSequence": ["jk", "jj"],
    "escapeSequenceTimeoutMs": 300
  }
}
```

All keys are optional; omitting `ompVim` is equivalent. Project overrides global for non-executing settings; project `modeColors` replaces global `modeColors` whole, with missing modes defaulting above. `modeChange` is intentionally absent from the default and is read only from the global settings file because it executes shell commands.

`clipboardMirror`: `all` mirrors unnamed writes; `yank` mirrors yanks; `never` keeps writes internal. Non-mirrored writes stay local for `p` / `P`.

`syncBorderColorWithMode`: `false` keeps the thinking border; `true` follows mode colors.

`escapeSequence`: optional two-letter Insert→Normal sequences such as `"jk"` or `["jk", "jj"]`. Each entry must be exactly two ASCII letters. Omitted, `null`, `""`, or `[]` leaves only `Esc` / `Ctrl+[`. Inspired by [opencode-vim's `vim_escape_sequence`](https://github.com/leohenon/opencode-vim/pull/190).

`escapeSequenceTimeoutMs`: how long to wait for the second key after a configured first letter (default `300`, clamped to `50..2000`).

`modeChange`: user-global shell command to run on every transition into the named mode. Both keys are optional. The command runs asynchronously via the system shell, stdio is discarded, failures are silenced, and a hung command is timed out so editing never blocks or breaks. If mode changes happen while a hook command is still running, omp-vim keeps only the latest pending command. Hooks fire only on actual transitions: not on the initial mode, not on EX entry/exit (EX is a sub-state of normal), and not on no-op `Esc` from normal. Because this is arbitrary shell, project `.omp/settings.json` values are ignored. omp-vim also emits `omp-vim:mode-change` on `pi.events` with `{ mode, previousMode }` for other extensions. Typical use is IME auto-switching via the third-party [`im-select`](https://github.com/daipeihust/im-select) CLI (cross-platform: macOS / Windows / Linux). Install per its README, then run `im-select` with no args to print your current IME id and plug those ids into the global config:

macOS example
```json
{
  "ompVim": {
    "modeChange": {
      "insert": "im-select im.rime.inputmethod.Squirrel.Hans",
      "normal": "im-select com.apple.keylayout.ABC"
    }
  }
}
```

omp-vim does not bundle `im-select` and does not care which tool you use — any shell command works.

### mode colors

`ompVim.modeColors` accepts Oh My Pi theme foreground tokens. Missing, invalid, or unknown tokens use defaults above.

Usual/safest: `accent`, `border`, `borderAccent`, `borderMuted`, `success`, `error`, `warning`, `muted`, `dim`, `text`, `thinkingText`.

## wrapping pi-vim

Supported: `pi-vim` first, `@jordyvd/pi-image-attachments` second. pi-vim does not wrap previous editors; wrappers decorate in place or forward the CustomEditor surface: lifecycle (`handleInput`, `render`, `invalidate`), text (`getText`, `setText`, `insertTextAtCursor`, `getExpandedText`), callbacks, `actionHandlers`, flags, reads (`getLines`, `getCursor`, `getMode()`). Inverse order, insert delegates, and generic composition are unsupported.

Smoke:

```bash
omp -e ./index.ts -e ../pi-image-attachments/index.ts
omp -e ./index.ts -e ../../../pi-image-attachments/index.ts
```

Check: insert text; add/paste image path; see `[Image #1]`; submit text+image stripped; switch INSERT/NORMAL.

## contributor setup

Hooks install with `npm install` after cloning. To wire them explicitly:

```bash
npm run hooks:install
```

## stats

- **192 commands**: motions, operators, counts, text objects, undo/redo, ex quit
- **sub-µs word motions** via precomputed boundary cache (~4ms startup, ~150KB memory)
- **0 dependencies**

## 30-second quickstart

Try on multi-line input:

```text
Esc        # NORMAL mode
3gg        # jump to absolute line 3
2dw        # delete two words
u          # undo
<C-r>      # redo last undone edit (safe no-op when empty)
2}         # jump two paragraphs forward
```

Mode indicator (`INSERT` / `NORMAL` / `EX`) appears bottom-right, theme-colored and configurable.

Requires `@earendil-works/pi-tui >= 0.74.0`. With DECSCUSR support, cursor shape follows mode; otherwise software cursor remains.

## why pi-vim

- Fast modal editing without leaving Pi.
- Count-aware motions/operators (`2dw`, `3G`, `d2j`, `2}`).
- REPL-focused defaults; out-of-scope boundaries documented.
- Clipboard/register behavior is explicit and tested.

Use pi-vim for Vim muscle-memory in Pi prompts. Skip it if you need full Vim parity (visual mode, macros, search, extended ex-commands, …).

## common recipes

| goal | keys |
|---|---|
| Jump to exact line 25 | `25gg` (or `25G`) |
| Delete two words | `2dw` |
| Change current whitespace-delimited WORD | `ciW` |
| Delete WORD plus adjacent whitespace | `daW` |
| Change inside double quotes | `ci"` |
| Delete inside parentheses | `di(` |
| Yank braces with contents | `ya{` |
| Change to end of line | `C` |
| Delete current + 2 lines below | `d2j` |
| Yank 3 lines | `3yy` |
| Join 3 lines with spacing | `3J` |
| Jump 2 paragraphs forward | `2}` |
| Undo last edit | `u` |
| Redo last undone edit | `<C-r>` |

---

## full reference

### mode switching

| key | action |
|---|---|
| `Esc` / `Ctrl+[` | Insert → Normal mode |
| configured `escapeSequence` (e.g. `jk` / `jj`) | Insert → Normal mode (optional; removes the pending first letter) |
| `Esc` / `Ctrl+[` | Normal mode → pass to Pi (aborts the agent under default Pi keybindings) |
| `:` | Normal → EX mini-mode |
| `i` | Normal → Insert at cursor |
| `a` | Normal → Insert after cursor |
| `I` | Normal → Insert at first non-whitespace |
| `A` | Normal → Insert at line end |
| `o` | Normal → open line below + Insert |
| `O` | Normal → open line above + Insert |

Optional: move Oh My Pi's escape/interrupt binding off bare `escape` in `~/.omp/agent/keybindings.yml` if it overlaps with Insert→Normal; user config wins.

#### ex mini-mode

Quit-only ex flows.

| key / command | action |
|---------------|--------|
| `:` | Enter EX mini-mode |
| `Enter` | Execute pending ex command |
| `Esc` | Cancel EX mini-mode |
| `Backspace` / `Ctrl+h` | Delete one ex-command character; on bare `:` exits EX mode |
| `:q` | Quit the current Pi session only when the prompt is empty or whitespace-only; otherwise show a warning |
| `:q!` | Force quit the current Pi session even when the prompt has text |
| `:qa` | Same safe quit policy as `:q` |
| `:qa!` | Same force quit policy as `:q!` |
| unsupported `:{cmd}` | Show warning notification; no quit |

Insert-mode shortcuts (stay in Insert mode):

| key | action |
|---|---|
| `Shift+Alt+A` | Go to end of line |
| `Shift+Alt+I` | Go to start of line |
| `Alt+o` | Open line below |
| `Alt+Shift+O` | Open line above |

---

### navigation (normal mode)

Most navigation keys accept a `{count}` prefix (max: `9999`); `%` intentionally does not.

| key | action |
|---|---|
| `h` / `l` / `j` / `k`; `{count}h/l/j/k` | Move left/right/down/up; line moves clamp to the buffer |
| `0` / `^` / `_` / `$` | Line start / first non-whitespace / counted first non-whitespace / line end |
| `gg` / `G`; `{count}gg` / `{count}G` | Buffer start/end or absolute 1-indexed line |
| `w` / `b` / `e`; `{count}w/b/e` | `word` start/back/end motions |
| `W` / `B` / `E`; `{count}W/B/E` | whitespace-delimited `WORD` motions |
| `{` / `}`; `{count}{` / `{count}}` | Previous/next paragraph start |
| `%` | Jump to the matching `()`, `[]`, or `{}` partner |

`word` splits punctuation from keyword chars; `WORD` treats any non-whitespace run as one token (`foo-bar`, `path/to`). Paragraph starts are non-blank lines at BOF or after blank lines (`^\s*$`). `{` / `}` are navigation-only; brace operator forms (`d{`, `c}`, `y{`, …) are out of scope.

`%` uses a delimiter under the cursor or scans forward on the current logical line. It matches `()`, `[]`, `{}` buffer-wide with lexical, nested, same-delimiter, parser-unaware matching; quotes/comments and mixed delimiters are not special. Missing/unmatched sources no-op. Counts are unsupported: `{count}%` consumes the count and no-ops; counted `d%` / `y%` / `c%` cancel without writes.

---

### character-find motions (normal mode)

A `{count}` prefix finds the Nth occurrence of `{char}` on the line.

| key | action |
|---|---|
| `f{char}` | Jump forward to `char` (inclusive) |
| `F{char}` | Jump backward to `char` (inclusive) |
| `t{char}` | Jump forward to one before `char` (exclusive) |
| `T{char}` | Jump backward to one after `char` (exclusive) |
| `{count}f{char}` | Jump to Nth occurrence of `char` forward |
| `;` | Repeat last `f/F/t/T` motion |
| `,` | Repeat last motion in reverse direction |

Char-find motions compose with operators: `df{char}`, `ct{char}`, `d{count}t{char}`, etc.

---

### edit operators (normal mode)

Register-writing edits write to the unnamed register. With the default clipboard mirror policy, they also mirror to the system clipboard best-effort (clipboard failure never breaks editing).

#### text objects

Text objects compose as `d`/`c`/`y` + `i`/`a` + object. `i` means inner; `a` means around.

| object | keys | range |
|---|---|---|
| word | `iw` / `aw` | Keyword word; `aw` includes spaces |
| WORD | `iW` / `aW` | Line-local whitespace-delimited WORD; `aW` includes adjacent whitespace |
| quotes | `i"` / `a"`, `i'` / `a'`, <code>i`</code> / <code>a`</code> | Smallest containing quote pair on the line |
| parentheses | `i(` / `a(`; aliases `i)` / `a)`, `ib` / `ab` | Smallest containing pair |
| brackets | `i[` / `a[`; aliases `i]` / `a]` | Smallest containing pair |
| braces | `i{` / `a{`; aliases `i}` / `a}`, `iB` / `aB` | Smallest containing pair |

Semantics:
- WORD objects are line-local and whitespace-delimited.
- Quote objects are line-local; odd-backslash escapes are ignored; `a` includes delimiters only, not surrounding whitespace.
- Bracket objects are buffer-aware, nested, lexical, and not parser-aware; brackets inside strings/comments still count.
- Empty inner delimiter objects no-op for delete/yank; change enters Insert at the inner start without writing the register.
- Delimited counts cancel (`d2i"`, `2ci(`, `y2a{`). Counted word/WORD text objects work for delete/change only; counted yank text objects cancel.

#### delete `d{motion}` / `dd`

A `{count}` or dual-count prefix (`{pfx}d{op}{motion}`) is supported for word,
WORD, char-find, and linewise motions. Maximum total count: `9999`.

| command | deletes |
|---|---|
| `dw` / `de` / `db`; `dW` / `dE` / `dB` | word/WORD motion ranges; `{count}` repeats |
| `d$` / `d0` / `d^` | To EOL / BOL / first non-whitespace |
| `d_` / `dd`; `d{count}_` / `{count}dd` | Current or counted whole lines |
| `d{count}j` / `d{count}k` / `dG` | Linewise down/up/to EOF |
| `df{c}` / `dt{c}` / `dF{c}` / `dT{c}`; `d{count}f{c}` | Char-find ranges |
| `d%` | Inclusive range through the matching pair target |
| `diw` / `daw`; `diW` / `daW` | Inner/around word or WORD |
| `d{count}iw` / `d{count}iW`; `d{count}aw` / `d{count}aW` | Counted word/WORD text objects |
| `di"` / `da"` (`'`, <code>`</code>) | Inside/around quotes |
| `di(` / `da(`, `di[` / `da[`, `di{` / `da{` | Inside/around brackets; aliases `)`, `]`, `}`, `b`, `B` |

#### change `c{motion}` / `cc`

Same motion and count set as `d`. Deletes text then enters Insert mode.

| command | action |
|---|---|
| `cw` / `ce` / `cb`; `cW` / `cE` / `cB` | Change word/WORD motion ranges + Insert |
| `c{count}w/e/b`; `c{count}W/E/B` | Change counted word/WORD motions + Insert |
| `ciw` / `caw`; `ciW` / `caW` | Change word/WORD text objects + Insert |
| `c{count}iw` / `c{count}iW`; `c{count}aw` / `c{count}aW` | Change counted word/WORD text objects + Insert |
| `ci"` / `ca"` (`'`, <code>`</code>) | Change inside/around quotes + Insert |
| `ci(` / `ca(`, `ci[` / `ca[`, `ci{` / `ca{` | Change inside/around brackets + Insert |
| `cc` / `c_`; `c{count}_` | Change current or counted whole lines + Insert |
| `c$` / `c0` / `c^` | Delete to EOL / BOL / first non-whitespace + Insert |
| `c%` | Change inclusive range through the matching pair target + Insert |
| … | All `d` motions apply |

#### single-key edits

A `{count}` prefix is supported for `x`, `p`, `P`. Maximum: `9999`.

| key | action |
|---|---|
| `x` | Delete char under cursor (no-op at/past EOL) |
| `{count}x` | Delete `{count}` chars |
| `s` | Delete char under cursor + Insert mode |
| `S` | Delete line content + Insert mode |
| `D` | Delete cursor to EOL (captures `\n` if at EOL with next line) |
| `C` | Delete cursor to EOL + Insert mode |
| `r{char}` | Replace char under cursor with `{char}` (stays in Normal) |
| `{count}r{char}` | Replace next `{count}` chars with `{char}` |

---

### yank `y{motion}` / `yy`

Same motion set as `d`. Writes to register, **no text mutation**.

| command | yanks |
|---|---|
| `yy` / `Y`; `{count}yy` / `{count}Y` | Whole line(s) + trailing `\n` |
| `y{count}j` / `y{count}k` / `yG`; `y_` / `y{count}_` | Linewise ranges |
| `yw` / `ye` / `yb`; `yW` / `yE` / `yB` | word/WORD motion ranges |
| `y$` / `y0` / `y^`; `yf{c}` | EOL / BOL / first non-whitespace / char-find |
| `y%` | Inclusive range through the matching pair target |
| `yiw` / `yaw`; `yiW` / `yaW` | Inner/around word or WORD |
| `yi"` / `ya"` (`'`, <code>`</code>) | Inside/around quotes |
| `yi(` / `ya(`, `yi[` / `ya[`, `yi{` / `ya{` | Inside/around brackets; aliases `)`, `]`, `}`, `b`, `B` |

Counted `word`/`WORD` yank motions and counted yank text objects (`y2w`,
`2yw`, `y2W`, `2yW`, `y2aw`, `2yaw`, `y2aW`, `y2a{`, …) are intentionally not
implemented and cancel the pending operator. Linewise counted yank (`{count}yy`,
`y{count}j/k`) is supported.

---

### put / paste

| key | action |
|---|---|
| `p` | Put after cursor (char-wise) / new line below (line-wise) |
| `P` | Put before cursor (char-wise) / new line above (line-wise) |
| `{count}p` | Put `{count}` times after cursor |
| `{count}P` | Put `{count}` times before cursor |

Put reads the OS clipboard first unless the last local register write was not mirrored. Paste text ending in `\n` is line-wise.

---

### undo / redo

| key | action |
|-----|--------|
| `u` | Undo one change in normal mode |
| `{count}u` | Undo up to `{count}` changes in normal mode; clamps at available history |
| `Ctrl+_` | Undo in normal mode (alias for `u`) |
| `<C-r>` | Redo one undone change in normal mode; safe no-op when redo history is empty |
| `{count}<C-r>` | Redo up to `{count}` undone changes in order; clamps at available history and consumes count state (no leak to the next command) |

---

## register and clipboard policy

- `ompVim.clipboardMirror = "all"` is the default: every unnamed-register write mirrors to the OS clipboard best-effort.
- `ompVim.clipboardMirror = "yank"` mirrors yanks only; deletes and changes update only omp-vim's internal shadow.
- `ompVim.clipboardMirror = "never"` disables write mirroring while keeping internal register writes synchronous.
- Rapid mirrored writes coalesce: only the latest pending value is guaranteed to be mirrored.
- `p` / `P` read the OS clipboard first when no local write was skipped by policy, falling back to the shadow on read failure/timeout.
- If policy skipped the last local write, `p` / `P` use the shadow so delete/yank → put works without touching the OS clipboard.
- While a mirror is in flight, `p` / `P` use the shadow so immediate yank/delete → put stays ordered.
- Pi owns the terminal clipboard backends; on Wayland external state may lag while the shadow stays authoritative for immediate puts.

---

## known differences from full Vim

| area | this extension | full Vim |
|---|---|---|
| `$` motion | Moves past the last char (readline `Ctrl+E`) | Moves to the last char |
| `w` / `e` / `b` + `W` / `E` / `B` | Cross-line for both `word` and `WORD` motions | Cross-line |
| `0` / `$` operators | Exclusive of the anchor col | `0` is inclusive of col 0 |
| Undo / redo | Delegates undo to readline; normal-mode `<C-r>` redo is supported | Full per-change undo tree |
| Visual mode | Not implemented | `v`, `V`, `<C-v>` |
| Text objects | `iw` / `aw`, `iW` / `aW`, quote objects, and paren/bracket/brace objects; delimited counts cancel | Full text-object set |
| `%` matching | `()`, `[]`, `{}` only; lexical same-delimiter matching with no counts, quote/angle matching, parser/matchit logic, mixed-delimiter validation, or Visual `%` yet | Also supports percentage jumps and broader matching |
| Count prefix | Operators, motions, navigation, `x`, `r`, `p`, `P`; capped at `MAX_COUNT=9999` | Full support |
| Registers / macros / search | Not implemented | Supported |
| Ex commands | Quit-only EX mini-mode (`:q`, `:q!`, `:qa`, `:qa!`) | Full ex command-line surface |
| Multi-line operators | `d/c/y` with `w/e/b`, `W/E/B`, `j/k`, and `G`; not the full Vim motion matrix | Rich cross-line semantics |

---

## out of scope

Explicitly deferred:

- Visual modes (`v`, `V`, block visual), including Visual `%`
- Tag text objects (`it`, `at`)
- Paragraph/sentence text objects (`ip`, `ap`, `is`, `as`)
- Angle bracket text objects (`i<`, `a<`) or angle-bracket `%` matching
- Visual-mode text-object selection
- Quote matching via `%`, parser-aware delimiter matching, matchit-style matching, and mixed-delimiter structural validation
- Delimited-object counts (`d2i"`, `2ci(`, `y2a{`)
- Named registers (`"a`, `"b`, …), macros (`q{char}`, `@{char}`)
- Ex surface beyond quit (`:s`, `:g`, `:w`, `:r`, …)
- Search (`/`, `?`, `n`, `N`), repeat (`.`)
- Replace mode (`R`) — only `r{char}` is supported
- Count prefix beyond currently supported motions, including `{count}%` percent-of-file jumps
- No insert-mode `<C-r>` expansion, no cross-session redo persistence
- No upstream `pi-tui` redo prerequisite
- Window / tab / buffer management, plugin ecosystem compatibility

---

## architecture notes

- `index.ts` handles modal keys; `motions.ts` and `text-objects.ts` hold pure range logic; `types.ts` holds shared types/constants; `test/` uses Node's runner.

Run checks with `npm run check`.
