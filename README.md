# pi-prompt-history

A Pi extension that records the prompts you type to a local JSONL file and searches them with Ctrl+R or `/history`. [The PRD](https://github.com/khiet/pi-prompt-history/issues/1) is the full contract.

**Open-source MVP, not an npm release.** The code is [MIT licensed](LICENSE), but the package is `private` and is not published to npm; install it from a checkout. It is not production-ready: it stores your prompts in [plain text](#privacy-what-loading-this-extension-changes), a rewrite can [lose another process's prompt](#several-pi-processes), and several platforms and integrations are [unverified](#unverified).

## Install

Requires a [tested Pi and Node](#tested-compatibility). Clone the repository, then add the checkout to Pi:

```sh
git clone https://github.com/khiet/pi-prompt-history.git
pi install /absolute/path/to/pi-prompt-history
```

`pi install` records the path in `<agent dir>/settings.json`, and Pi loads the extension from the checkout on its next start, or after `/reload`. No `npm install` is needed to run it: the extension uses only Node built-ins and Pi's own packages, has no runtime dependencies, and runs no install scripts. To try it for one run instead, use `pi -e /absolute/path/to/pi-prompt-history`. To remove it, run `pi remove /absolute/path/to/pi-prompt-history`; your recorded history stays in place until you delete it (see [Privacy](#privacy-what-loading-this-extension-changes)).

`pi install git:github.com/khiet/pi-prompt-history` should also work, since Pi clones the repository and runs `npm install --omit=dev`, but that route has not been tested.

## Usage

Press Ctrl+R (or your [configured shortcut](#shortcut)) or type `/history` in Pi's interactive TUI. Both open the same picker. It opens with an empty query, listing prompts recorded in the current directory (the exact cwd string, not the Git root), newest first. Every opening starts this way; neither the draft nor the last query carries over.

- Typing searches every recorded prompt for the query as a literal substring, after lowercasing both with JavaScript's `toLowerCase()`. Punctuation has no special meaning. Case folding is simple and locale-independent: `CAFÉ` matches `café`, but `ß` does not match `ss`, and a composed `é` does not match `e` plus a combining accent.
- At most the newest 100 matches are listed, and the picker says when there are more. Type more of the query to reach older prompts; there is no paging.
- Tab switches between this directory and all directories, keeping the query. In all directories, each prompt shows the directory it was typed in.
- Up/Down selects. Below the list, a preview shows the selected prompt's local time and its first lines.
- Enter puts the selected prompt in the editor without sending it. It **replaces the whole draft**. If the draft contains an image (Pi keeps a pasted or dropped image as a `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, or `.bmp` file path in the text), you are asked to confirm first, because the image is replaced too. The check looks only for such paths in the draft text, so it also asks when you merely typed a name like `logo.png`, and it cannot see an image Pi holds any other way. Images from the recalled prompt were never stored and are not restored.
- Ctrl+D asks before deleting the selected prompt; see [Delete and clear](#delete-and-clear).
- Escape closes the picker and leaves the draft, including any image, unchanged.

Restored text is the stored text as Pi's editor normalizes it: tabs become spaces and CR/CRLF become LF. The stored record itself is never changed. The list shows each prompt on one line and the preview up to eight of its lines, both with terminal control characters drawn as visible symbols; the restored text keeps them.

The picker distinguishes no prompts recorded in the scope from no prompts matching the query. Before each search the extension checks whether the history file changed (size, modification time, inode, or status change) and rereads it if so, so prompts recorded by other Pi processes appear on the next keystroke. If it cannot be read, the picker shows it as unavailable with the file and error code instead of any earlier results, and leaves the file untouched. The shortcut and `/history` do nothing outside the TUI, and only one picker opens at a time.

## Pause

`/history pause` stops recording new prompts; `/history resume` starts again. Any argument to `/history` other than these and the [clear scopes](#delete-and-clear) shows usage and does nothing.

- While paused, the footer shows `history paused`. Saved history stays searchable and restorable with Ctrl+R and `/history`.
- The pause lasts for the whole Pi process: it survives `/reload`, `/new`, `/resume`, and `/fork`, and the indicator comes back after each. Only `/history resume` or restarting Pi turns recording back on. It is never saved to disk, so a new Pi process always starts recording.
- It affects this extension only. It does not stop Pi from saving its own session files, and it does not remove prompts already recorded.
- Prompts typed while paused are never recorded later; resuming does not backfill them.
- Keeping the pause across `/reload`, `/new`, `/resume`, and `/fork` relies on an undocumented technique: a flag on `globalThis`, which works because Pi reuses one Node realm for every session runtime in a process. Pi does not promise this; `spike/pause.py` checks it on each [tested release](#tested-compatibility).

## Delete and clear

In the picker, Ctrl+D asks `Delete this prompt?`. `y` deletes the selected record; any other key, Escape included, keeps it and leaves the picker open. Only that one record goes: other submissions of the same text are separate records and stay. There is no undo. Ctrl+D pressed while a search is still loading does nothing. After a deletion the picker searches again with the same query and scope, selects the result that took the deleted one's place (or the new last result when the last one was deleted), and refills the newest-100 list, so a prompt that was just past the cap appears. When nothing is left it says `No prompts match.` or `No prompts recorded in this directory yet.`

`/history clear cwd` clears the current directory's prompts, matched by the exact cwd string like the picker's scope, so other directories and subdirectories keep theirs. `/history clear all` clears every prompt this extension recorded. Bare `/history clear` or any other scope shows usage and clears nothing. Both ask for confirmation, naming the scope and how many prompts it holds; cancelling changes nothing, and an empty scope says there is nothing to clear without asking. Both work only in the TUI.

The count in the confirmation is the count when it was shown. Clearing removes whatever is in scope when it runs, so prompts recorded by other Pi processes while the dialog was open are cleared too, and the notice after it reports the count actually cleared. Neither count includes unreadable lines, which `/history clear all` also removes.

- Deleting and clearing affect only this extension's history file. They never change Pi's session files, where the same prompts remain.
- They rewrite the file (see [Limits](#limits)); this does not guarantee forensic erasure from the disk, filesystem snapshots, or backups.
- If the file cannot be read or rewritten, nothing is deleted or cleared, and the picker or a warning names the file, its directory, and the error code. The draft is untouched and prompting continues.
- A picker or confirmation left open by a session that has since shut down deletes nothing.

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

`<agent dir>` is Pi's `getAgentDir()`: `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set. Anything you type, including secrets pasted into a prompt, is kept there until you remove it. Use [`/history pause`](#pause) before typing something you do not want kept. Remove entries with [Ctrl+D in the picker or `/history clear`](#delete-and-clear), or by deleting that file yourself. None of these touch Pi's sessions or guarantee erasure from backups or disk.

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

## Compared with Pi's built-in history

Pi already keeps your prompts: in its session files, which `/resume` and `/tree` search, and in the editor's Up/Down history. Checked in the real TUI on both [tested releases](#tested-compatibility), with sessions written by Pi's own agent loop driving a scripted model (`spike/scripted.ts`) rather than a real provider:

- In a new Pi process with a new session, Up recalls nothing. After `/resume`, Up recalls that session's prompts. After `/new`, Up still recalls the prompts typed earlier in the same process.
- This extension's picker finds a prompt typed in an earlier Pi process straight away, without resuming its session.

What the extension adds is one prompt-only index shared by every Pi process and session, searched by substring, scoped to the current directory or all directories, with per-prompt deletion, clearing, and pause. It does not replace Pi's session storage or search it, and removing a prompt here leaves it in Pi's session files.

## Record format

One JSON object per line, appended with one write per record:

```json
{"v":1,"id":"<uuid>","text":"explain this diff","cwd":"/work/project","session":"<session id>","ts":1790000000000}
```

`ts` is epoch milliseconds and `session` is Pi's session ID. Readers ignore unknown fields and skip lines they cannot parse, such as a line torn by an interrupted write; the first search that meets them warns once per session with their count, never their content. Reading never rewrites the file.

## Limits

These are fixed, not configurable:

- **Retention:** the newest 10,000 records, by the search order (newest `ts` first, then `id`). Appends stay cheap: each Pi process counts the records it last loaded plus its own appends, and only when an append takes that count past 11,000 does it rewrite the file down to the newest 10,000. Other processes' appends join the count when this process next searches, so with several writers the file can briefly grow past 11,000. Unreadable lines are dropped by that rewrite.
- **Results:** at most the newest 100 matches per search, over every retained record.
- **Prompt size:** 32,768 UTF-8 bytes; larger prompts are skipped.

Compaction, deletion, and clearing all rewrite the file the same way, and every rewrite keeps at most the newest 10,000 records and drops unreadable lines. A rewrite writes a private (`0600`) temporary file in the same directory and renames it over the history file. If preparing it fails, the temporary file is removed, the original stays as it was, and a warning names the file, its directory, and the error code; for compaction, the next append past the threshold tries again. An unreadable history file is never rewritten. A deletion of a record that is already gone rewrites nothing.

## Several Pi processes

Every Pi process with this extension appends to the same file. Each record is one write in append mode, which keeps lines whole on a local filesystem; network filesystems are not supported and may interleave or lose lines. Repeated prompts from different processes are all kept.

There is no locking. The one known loss is a rewrite (compaction, deletion, or clearing): another process's append that lands between the rewrite reading the file and renaming over it, or that opened the old file before the rename, is lost. The window is short and is accepted for the MVP; rewrites are not lossless under concurrency.

## Failures

Capture never blocks or changes prompt processing. If a write fails (for example, the file is not writable), the prompt continues normally and a warning names the file and error code, at most once a minute per kind of problem. An existing history file that cannot be read or written is left alone: it is never erased or replaced. If the file is missing, including one deleted while Pi runs, the next prompt starts a new one.

## Development

Requires Node and npm from the [tested matrix](#tested-compatibility); the real-TUI checks also need Python 3 and a POSIX system with PTYs.

```sh
npm ci --ignore-scripts
npm run lint:fix                # Biome lint and format, with fixes
npm run typecheck               # strict TypeScript, no emit
npm test                        # node:test against real temporary files
npm run check:package           # the packed files and package.json rules below
npm run smoke:install -- 0.87.1 # install the packed package, load it in real Pi
npm run acceptance              # real-TUI release checks (spike/acceptance.py)
npm run spike                   # compatibility spike, shortcut, and pause checks
```

To check another Pi release, install it over the lockfile, run the checks, then restore the lock:

```sh
npm install --no-save --ignore-scripts @earendil-works/pi-coding-agent@0.87.1 @earendil-works/pi-tui@0.87.1 @earendil-works/pi-ai@0.87.1
npm ci --ignore-scripts
```

Lint Python changes with Ruff (`ruff check --fix spike && ruff format spike`) if it is installed.

Layout:

- `src/index.ts`: the one extension entry point. Pi registration, the capture policy, the `/history` command and search shortcut, lifecycle, and warnings.
- `src/history.ts`: the JSONL store. File I/O only; knows nothing about Pi.
- `src/picker.ts`: the search picker, composed from Pi's `Input` and `SelectList`. No file I/O.
- `src/config.ts`: store and config paths from `getAgentDir()`, and the validated shortcut setting.
- `test/`: behavior tests. `delete.test.ts` and `clear.test.ts` cover deletion through the picker and `/history clear`. `concurrency.test.ts` runs the store in several Node processes at once. `harness.ts` is a minimal host that records registered handlers and fires events at them; it is not a Pi runtime.
- `scripts/`: packaging checks. `check-package.mjs` asserts the rules below against `npm pack`. `smoke-install.mjs` packs the extension and unpacks it where no `node_modules` can reach it, installs the given Pi release with `--omit=dev --ignore-scripts`, adds the extension with `pi install`, and checks that Pi loads `/history` from it and that print, JSON, and RPC prompts reach the input hook but are never recorded.
- `spike/`: real-Pi checks and the compatibility spike. `acceptance.py` drives the real extension in the real TUI through `harness.py`, with `scripted.ts` as an in-process model whose replies and compactions wait for the script, so it can type while Pi streams or compacts. `shortcut.py` covers the shortcut, its config, reload, and every reserved-action conflict. `pause.py` covers pause, with `driver.ts` swallowing prompts so no model is called. `sdk.mjs`, `streaming.mjs`, `tui.py`, and `probe.ts` are the original spike; `docs/research/` records its findings.

The extension registers handlers and reads `config.json` once to register the shortcut; it opens the history file only at the first eligible prompt or search. Each Pi session runtime (startup, `/reload`, `/new`, `/resume`, `/fork`) gets a fresh extension instance, and `session_shutdown` stops capture, waits for pending writes, and closes the store, so a replaced runtime never records, and a picker still open when its session shuts down restores nothing. The pause flag is the one thing kept across runtimes: it lives on `globalThis` under `Symbol.for("pi-prompt-history/process-state")`, because Pi documents no process-lifetime state. This relies on Pi reusing one Node realm for every runtime in a process, which Pi does not promise, so `spike/pause.py` must pass on every supported Pi release.

Package rules, checked by `npm run check:package`:

- One extension entry point, `./src/index.ts`, declared under `pi.extensions`.
- An explicit `files` allowlist of the four modules; npm adds `package.json`, `README.md`, and `LICENSE`, and nothing else is packed, so no local history, tests, or spike files ship.
- The package stays `private`, and `package.json`, the lockfile, and `LICENSE` all say MIT.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are `*` peer dependencies, as Pi's package docs require, and are never bundled. Runtime imports are limited to them and Node built-ins. There are no `dependencies` and no install or `prepare` scripts.
- `package-lock.json` is committed; CI installs with `npm ci --ignore-scripts`.

## Tested compatibility

| | Tested |
| --- | --- |
| Pi | 0.85.1 (locked) and 0.87.1, the current stable release on 2026-09-29 |
| Node | 22.22.0 and 24.21.0 |
| Platform | macOS arm64 locally; Ubuntu in CI |

CI runs lint, typecheck, `npm test`, `check:package`, and `smoke:install` for each Pi and Node pair above. The `*` peer range is packaging convention, not a claim of wider support. Pi's own engine range (`>=22.19.0`) is not evidence either: other Node versions have not been tested.

## Verification

Recorded on 2026-09-29 on macOS arm64. Real-TUI checks run the real CLI in a PTY with `TERM=xterm-256color`, in isolated temporary home and agent directories, with no network.

On both Pi releases, with Node 22.22.0:

- `npm run lint`, `npm run typecheck`, `npm test` (157 tests), `npm run check:package`, and `npm run smoke:install` pass. All of these also pass with Node 24.21.0.
- `spike/acceptance.py` passes: idle, steering (Enter while streaming), and follow-up (Alt+Enter) prompts are each recorded once, and delivering them records nothing more; prompts queued during `/compact` are recorded as described in [What gets recorded](#what-gets-recorded) (only the first on 0.85.1, each once on 0.87.1); the [built-in history comparison](#compared-with-pis-built-in-history); capture and the picker after `/reload`, `/new`, `/resume`, and `/fork`, with each prompt recorded once; restore with normalization and without submitting, and Escape keeping the draft; the image warning, declined and accepted; Tab scope and Ctrl+D with its confirmation; `/history clear cwd` and `clear all` through Pi's confirmation dialog, cancelled and accepted; resizing to 24, 10, 200, and 60 columns with the picker open, without Pi exiting and with restore still exact afterwards (not how it renders); Japanese, accented, and emoji text typed and found with case-folded and punctuation queries; the picker opening and restoring under the light theme; Pi's `modal-editor.ts` example loaded alongside; two Ctrl+R presses leaving one picker; and a picker open while the session is replaced restoring nothing into the new one.
- `spike/shortcut.py` passes, including Ctrl+R bound to each of Pi's 18 reserved actions: Pi warns and skips the shortcut, and `/history` still opens. For `app.exit`, `app.suspend`, and `app.editor.external`, Ctrl+R itself was not pressed.
- `spike/pause.py` and `npm run spike` pass.

After the MIT license change, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check:package`, and `npm run smoke:install` were rerun and pass on both Pi releases with Node 22.22.0, and CI reran them with Node 24.21.0 (see below). The documented install was also checked from a fresh clone, with isolated home and agent directories: `pi install` on the checkout, with no `node_modules`, records it in `settings.json` and `pi list` shows it. That check does not load the extension; `smoke:install` covers loading, for the packed package.

The automated tests cover capture, search, storage, and lifecycle; Unicode and punctuation matching; the 32,768-byte boundary; retention and compaction; rereading a file other processes changed; the newest-100 cap over all retained records; confirmations; config fallback and reload; and the unavailable state without stale results. They use a [minimal host harness](#development), not a Pi runtime.

### Unverified

Not checked, so not claimed:

- `npm run spike` and `spike/acceptance.py` on Ubuntu: they run only locally, on macOS with Node 22.22.0. CI on Ubuntu runs lint, typecheck, `npm test`, `check:package`, and `smoke:install` for each Pi and Node pair; it last passed on 2026-09-29 at commit `6e141e1`, after the license change.
- Physical IME composition and candidate windows; the PTY sends committed text only. How themes look, and switching themes while Pi runs. Terminal emulators, tmux or screen, and keys that need the Kitty keyboard protocol (`super`, `ctrl+shift`).
- Real images: clipboard paste, drag and drop, and CLI image arguments. The warning was checked with an image path typed into the draft.
- Real model providers. The scripted model drives Pi's real agent loop, queues, and compaction, but not HTTP, retries in the TUI, or automatic (threshold or overflow) compaction in the TUI.
- Pi delivering `session_shutdown` twice to one runtime; only the host harness tests a repeated shutdown.
- Several real Pi processes appending at once; `test/concurrency.test.ts` uses several Node processes.
- Other editor extensions than `modal-editor.ts`, installing from git, Windows, and any Pi release, Node version, or platform not in the table above.

## Contributing and support

This is a small personal project maintained on a best-effort basis, with no support commitment or response time. Bug reports and pull requests are welcome through GitHub issues; include your Pi, Node, and platform versions. Never paste prompt history, `history.jsonl` contents, or secrets into an issue. Pull requests should pass the [development checks](#development) and keep the README's claims matched to what was verified.

## Security

Report vulnerabilities privately, not in a public issue; see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
