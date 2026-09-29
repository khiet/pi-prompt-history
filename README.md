# pi-prompt-history

**Development only - not a release.** A Pi extension that records the prompts you type to a local JSONL file and searches them with Ctrl+R or `/history`. Deletion is not built yet; it arrives with [#8](https://github.com/khiet/pi-prompt-history/issues/8). [The PRD](https://github.com/khiet/pi-prompt-history/issues/1) is the full contract. The package is `private` and must not be published.

## Usage

Press Ctrl+R (or your [configured shortcut](#shortcut)) or type `/history` in Pi's interactive TUI. Both open the same picker. It opens with an empty query, listing prompts recorded in the current directory (the exact cwd string, not the Git root), newest first. Every opening starts this way; neither the draft nor the last query carries over.

- Typing searches every recorded prompt for the query as a literal substring, after lowercasing both with JavaScript's `toLowerCase()`. Punctuation has no special meaning. Case folding is simple and locale-independent: `CAFÉ` matches `café`, but `ß` does not match `ss`, and a composed `é` does not match `e` plus a combining accent.
- At most the newest 100 matches are listed, and the picker says when there are more. Type more of the query to reach older prompts; there is no paging.
- Tab switches between this directory and all directories, keeping the query. In all directories, each prompt shows the directory it was typed in.
- Up/Down selects. Below the list, a preview shows the selected prompt's local time and its first lines.
- Enter puts the selected prompt in the editor without sending it. It **replaces the whole draft**. If the draft contains an image (Pi keeps a pasted or dropped image as a `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, or `.bmp` file path in the text), you are asked to confirm first, because the image is replaced too. The check looks only for such paths in the draft text, so it also asks when you merely typed a name like `logo.png`, and it cannot see an image Pi holds any other way. Images from the recalled prompt were never stored and are not restored.
- Escape closes the picker and leaves the draft, including any image, unchanged.

Restored text is the stored text as Pi's editor normalizes it: tabs become spaces and CR/CRLF become LF. The stored record itself is never changed. The list shows each prompt on one line and the preview up to eight of its lines, both with terminal control characters drawn as visible symbols; the restored text keeps them.

The picker distinguishes no prompts recorded in the scope from no prompts matching the query. Each search reads the history file. If it cannot be read, the picker shows it as unavailable with the file and error code instead of any earlier results, and leaves the file untouched. The shortcut and `/history` do nothing outside the TUI, and only one picker opens at a time.

## Pause

`/history pause` stops recording new prompts; `/history resume` starts again. Any other argument to `/history` shows usage and does nothing.

- While paused, the footer shows `history paused`. Saved history stays searchable and restorable with Ctrl+R and `/history`.
- The pause lasts for the whole Pi process: it survives `/reload`, `/new`, `/resume`, and `/fork`, and the indicator comes back after each. Only `/history resume` or restarting Pi turns recording back on. It is never saved to disk, so a new Pi process always starts recording.
- It affects this extension only. It does not stop Pi from saving its own session files, and it does not remove prompts already recorded.
- Prompts typed while paused are never recorded later; resuming does not backfill them.

## Shortcut

The search shortcut defaults to `ctrl+r`. Pi binds Ctrl+R to session rename (`app.session.rename`); this extension deliberately shadows it while the editor is focused, because history search is the more familiar use of that key. Pi shows a shortcut-conflict warning at startup saying so.

To keep both actions, move rename to another key in `<agent dir>/keybindings.json` yourself, for example:

```json
{ "app.session.rename": "alt+r" }
```

Check `/hotkeys` first for a free key, then run `/reload`. The extension never edits `keybindings.json`.

To use a different key for search instead, create `<agent dir>/prompt-history/config.json`:

```json
{ "shortcut": "alt+h" }
```

- `shortcut` is the only setting. Retention, storage location, project overrides, and ephemeral-session recording are not configurable.
- The key uses the key format in Pi's `docs/keybindings.md` and must include `ctrl`, `alt`, or `super`, or be a function key (`f1`-`f12`, optionally with `shift`), so it cannot take over typing or editing.
- Changes apply after `/reload` or a restart; a running session keeps the key it started with.
- A missing file means `ctrl+r`. If the file cannot be read, is not valid JSON, has any other setting, or has an invalid `shortcut`, the whole file is ignored, `ctrl+r` is used, and a warning names the file, the problem, and the fix. The warning never quotes the file's contents.
- If the key is bound to one of Pi's reserved actions (such as `app.clear` or `app.interrupt`), Pi skips the shortcut and warns; use `/history` or choose another key.

`/history` always works, whatever the shortcut's state.

## Privacy: what loading this extension changes

Loading the extension adds a **second, plain-text copy** of your typed prompts, separate from Pi's own session files, at:

```
<agent dir>/prompt-history/history.jsonl
```

`<agent dir>` is Pi's `getAgentDir()`: `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set. Anything you type, including secrets pasted into a prompt, is kept there until you remove it. Use [`/history pause`](#pause) before typing something you do not want kept. There is no delete yet, so the only way to remove entries is to edit or delete that file yourself. Deleting it does not touch Pi's sessions and does not guarantee erasure from backups or disk.

- The directory is created with mode `0700` and the file with `0600` where the platform supports it. Existing permissions are not changed.
- History is never exposed to the model: no tool, no context injection.
- Warnings and errors never include prompt text.

## What gets recorded

Unless [paused](#pause), a prompt is recorded when Pi's `input` hook sees it with `source: "interactive"`, in TUI mode (`ctx.mode === "tui"`), in a session that has a session file. That includes prompts typed while the agent is streaming (steering and follow-up).

Never recorded:

- ephemeral sessions (`--no-session`, or any session where `getSessionFile()` returns nothing)
- print, JSON, and RPC modes, and RPC-origin input
- input from other extensions (`pi.sendUserMessage()`)
- assistant and tool output
- attachment contents: for a mixed text and image prompt only the text is stored
- whitespace-only prompts
- prompts over 32,768 UTF-8 bytes, which are skipped with a warning rather than truncated

What "the text" means:

- It is the text the hook observes, stored exactly: whitespace, tabs, CR/CRLF, and Unicode are not normalized. Pi's editor already trims outer whitespace before the hook runs, so this is not a record of raw keystrokes.
- An input-transform extension that runs earlier can change the text before this extension sees it.
- `/skill:name` and prompt-template input is stored as typed, before expansion.
- Extension commands (`/cmd`) and Pi's built-in commands never reach the hook and are not recorded, so this is not a command history.
- Each submission is its own record; repeats are kept.
- On Pi 0.86.0 and later, other extensions that call the SDK's `steer()`/`followUp()` without a `source` look like typed input and are recorded. On 0.85.1, prompts queued during compaction are missed except the first.

Session files are never read to backfill history.

## Record format

One JSON object per line, appended with one write per record:

```json
{"v":1,"id":"<uuid>","text":"explain this diff","cwd":"/work/project","session":"<session id>","ts":1790000000000}
```

`ts` is epoch milliseconds and `session` is Pi's session ID. Readers ignore unknown fields and skip lines they cannot parse. Reading never rewrites the file.

## Failures

Capture never blocks or changes prompt processing. If a write fails (for example, the file is not writable), the prompt continues normally and a warning names the file and error code, at most once a minute per kind of problem. An existing history file that cannot be read or written is left alone: it is never erased or replaced. If the file is missing, including one deleted while Pi runs, the next prompt starts a new one.

## Development

Requires Node 22.22.0 (the only version tested) and npm.

```sh
npm ci --ignore-scripts
npm run lint:fix    # Biome lint and format, with fixes
npm run typecheck   # strict TypeScript, no emit
npm test            # node:test against real temporary files
```

To try it locally, load it for one run, or add the checkout to your Pi packages:

```sh
pi -e ./src/index.ts
pi install /absolute/path/to/pi-prompt-history
```

Layout:

- `src/index.ts`: the one extension entry point. Pi registration, the capture policy, the `/history` command and search shortcut, lifecycle, and warnings.
- `src/history.ts`: the JSONL store. File I/O only; knows nothing about Pi.
- `src/picker.ts`: the search picker, composed from Pi's `Input` and `SelectList`. No file I/O.
- `src/config.ts`: store and config paths from `getAgentDir()`, and the validated shortcut setting.
- `test/`: behavior tests. `harness.ts` is a minimal host that records registered handlers and fires events at them; it is not a Pi runtime.
- `spike/` and `docs/research/`: the compatibility spike (`npm run spike`) and research that shaped the design. `spike/shortcut.py` drives the real extension in real Pi to check the shortcut, its config, reload, and `/history`. `spike/pause.py` does the same for pause, with `spike/driver.ts` swallowing prompts so no model is called.

The extension registers handlers and reads `config.json` once to register the shortcut; it opens the history file only at the first eligible prompt or search. Each Pi session runtime (startup, `/reload`, `/new`, `/resume`, `/fork`) gets a fresh extension instance, and `session_shutdown` stops capture, waits for pending writes, and closes the store, so a replaced runtime never records, and a picker still open when its session shuts down restores nothing. The pause flag is the one thing kept across runtimes: it lives on `globalThis` under `Symbol.for("pi-prompt-history/process-state")`, because Pi documents no process-lifetime state. This relies on Pi reusing one Node realm for every runtime in a process, which Pi does not promise, so `spike/pause.py` must pass on every supported Pi release.

Only `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are imported at runtime, both as `*` peer dependencies; there are no other runtime dependencies. The published-files allowlist is in `package.json`.

## Tested compatibility

| | Tested |
| --- | --- |
| Pi | 0.85.1 (locked) and 0.87.1 |
| Node | 22.22.0 |
| Platform | macOS arm64 |

On both Pi versions, typecheck and `npm test` pass, and Pi's own extension loader loads the package from its manifest with no errors and no history-file I/O; loading reads only `config.json`. The `*` peer range is packaging convention, not a claim of wider support.

On both Pi versions, `python3 spike/shortcut.py` passes in a real TUI (PTY, `TERM=xterm-256color`): Ctrl+R opens the picker instead of rename, with Pi's conflict warning; a configured Alt+H opens it and Ctrl+R then does not; an invalid config warns and falls back to Ctrl+R; with `app.clear` bound to Ctrl+R, Pi skips the shortcut and `/history` still opens; and after editing the config, the old key keeps working until `/reload`, then only the new key does.

On both Pi versions, `python3 spike/pause.py` passes in the same real TUI: `/history pause` stops recording and shows `history paused`; the pause and the indicator survive Pi's own `/reload`, `/new`, `/resume`, and `/fork`; `/history resume` clears the indicator and records again; the pause command changes no file under the agent directory; and a restarted process records with no indicator.

The tests use a minimal host harness. They do not prove real-TUI streaming, replay, or lifecycle behavior. The input-hook fields, exclusions, and session transitions the capture relies on were observed in the real TUI and SDK by the [compatibility spike](docs/research/compatibility-spike.md).

## Remaining gates

Not verified, and required before any release:

- Capture in the real TUI with a real provider: streaming, steering and follow-up keystrokes, replay and retry paths, and prompts queued during compaction.
- Exclusion of input from real print, JSON, and RPC frontends.
- Lifecycle races in real Pi: repeated shutdown delivery and writes still pending during session replacement.
- Real attachments: clipboard and drag-and-drop images alongside text, and the image warning before `/history` replaces such a draft.
- The search shortcut in terminals other than the PTY check above: other terminal emulators, `super` and `ctrl+shift` keys (which need the Kitty keyboard protocol), tmux/screen, and reserved actions other than `app.clear`.
- The picker in the real TUI: restoration and editor normalization, cancellation, IME composition, themes, resizing, and narrow terminals.
- Concurrent appends from several Pi processes (owned by [#7](https://github.com/khiet/pi-prompt-history/issues/7)).
- Any Pi release other than 0.85.1 and 0.87.1, and any other Node version or platform.
