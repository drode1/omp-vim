# Insert-mode escape sequences

## Motivation

Let users leave Insert mode with familiar two-key sequences such as `jk` and `jj`, while keeping `Esc` and `Ctrl+[` available. Reference: [opencode-vim PR #190](https://github.com/leohenon/opencode-vim/pull/190).

## Config

- Read `escapeSequence` and `escapeSequenceTimeoutMs` under `ompVim` (legacy `piVim`) from `~/.omp/agent/settings.json` and project `.omp/settings.json`. For each key, an explicitly present project value overrides the global value, including `null` or an empty sequence list.
- `escapeSequence`: string, string array, `null`, or omitted. Each sequence must be exactly two printable ASCII letters (`[A-Za-z]{2}`); reject invalid entries. Omitted, `null`, `""`, or `[]` disables the feature. Support multiple sequences with the same first letter, including `["jk", "jj"]`.
- `escapeSequenceTimeoutMs`: optional finite number of milliseconds; default `300`, clamp valid numeric values to `50..2000`. Invalid values use the default.

Example:

```json
{
  "ompVim": {
    "escapeSequence": ["jk", "jj"],
    "escapeSequenceTimeoutMs": 300
  }
}
```

## Behavior

- Apply only in Insert mode and only to individual, unmodified ASCII letter inputs. Insert a configured first letter normally and start a pending timer.
- If the next eligible letter completes any configured sequence before the timeout, remove only that inserted first letter, consume the second letter, then follow the existing Insert-to-Normal `Esc` path: clear paste state, call `setMode("normal")`, and call `moveCursorBy(-1)` when the resulting column is greater than zero.
- On a nonmatching next letter or timeout, keep the first letter as ordinary input and clear pending state; process the nonmatching letter normally.
- `Esc` or `Ctrl+[` clears pending state and follows its existing behavior. The first letter remains in the buffer exactly once.
- Multibyte input, nonprintable keys, modified keys, paste chunks, and insert shortcuts such as `Shift+Alt+A` clear pending state, then follow existing handling. A modified second key cannot complete a sequence.
- Clear pending timer on every mode exit and editor teardown. Never delete text if the pending character is no longer at its recorded insertion position.

## Implementation plan (files)

- `settings.ts`: extend `PiVimSettings` and the existing per-key project/global reader with validation, disabled values, and timeout normalization.
- `index.ts`: pass settings into `ModalEditor`; add pending first-letter/timer handling in the Insert branch of `handleInput`. Reuse the existing escape transition and public `Editor` buffer/cursor API for character removal; preserve shortcut and paste routing.
- `README.md`: document both settings in `configure` and the configured sequence in the mode switching table.
- `test/omp-features.test.ts`: add focused behavior and settings tests. CI already runs this file with Bun.

## Test plan

- With `jk`, typing `jk` exits Insert and removes the typed `j`.
- With `["jk", "jj"]`, both `jk` and `jj` exit Insert and remove the typed `j`.
- `jx` stays in Insert and leaves `jx`; `j` followed by timeout stays as `j` in Insert.
- `j` then `Esc` enters Normal, leaves exactly one `j`, and cannot trigger a stale timer.
- With unset or empty configuration, `jk` remains text in Insert.
- Check project override and legacy `piVim`, timeout default/clamping, and a modified second key plus insert shortcut preserving normal behavior.
- Run `bunx tsc --noEmit`, `bun test test/omp-features.test.ts`, and `git diff --check` after implementation.

## Non-goals

- No Normal, Visual, or EX mappings; no general keymap engine or configurable sequence lengths.
- No changes to legacy upstream tests or automated npm publishing.

## Acceptance criteria

- Configured sequences work in Insert mode with the stated timeout and buffer cleanup; `Esc`/`Ctrl+[` and existing insert shortcuts retain their behavior.
- Global and project settings resolve as specified, including an explicit project disable.
- README documents configuration and mode switching; focused tests and shipped-source typecheck pass.
