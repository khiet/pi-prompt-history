# pi-prompt-history

**Development only - not a release.** A Pi extension that records the prompts you type to a local JSONL file, as the storage and capture foundation for a searchable prompt history. There is no `/history` picker, shortcut, recall, pause, or deletion yet; those arrive with [#3](https://github.com/khiet/pi-prompt-history/issues/3), [#4](https://github.com/khiet/pi-prompt-history/issues/4), [#5](https://github.com/khiet/pi-prompt-history/issues/5), [#6](https://github.com/khiet/pi-prompt-history/issues/6), and [#8](https://github.com/khiet/pi-prompt-history/issues/8). [The PRD](https://github.com/khiet/pi-prompt-history/issues/1) is the full contract. The package is `private` and must not be published.

## Privacy: what loading this extension changes

Loading the extension adds a **second, plain-text copy** of your typed prompts, separate from Pi's own session files, at:

```
<agent dir>/prompt-history/history.jsonl
```

`<agent dir>` is Pi's `getAgentDir()`: `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set. Anything you type, including secrets pasted into a prompt, is kept there until you remove it. This slice has no pause and no delete, so the only way to remove entries is to edit or delete that file yourself. Deleting it does not touch Pi's sessions and does not guarantee erasure from backups or disk.

- The directory is created with mode `0700` and the file with `0600` where the platform supports it. Existing permissions are not changed.
- History is never exposed to the model: no tool, no context injection.
- Warnings and errors never include prompt text.

## What gets recorded

A prompt is recorded when Pi's `input` hook sees it with `source: "interactive"`, in TUI mode (`ctx.mode === "tui"`), in a session that has a session file. That includes prompts typed while the agent is streaming (steering and follow-up).

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

- `src/index.ts`: the one extension entry point. Pi registration, the capture policy, lifecycle, and warnings.
- `src/history.ts`: the JSONL store. File I/O only; knows nothing about Pi.
- `src/config.ts`: store paths from `getAgentDir()`.
- `test/`: behavior tests. `harness.ts` is a minimal host that records registered handlers and fires events at them; it is not a Pi runtime.
- `spike/` and `docs/research/`: the compatibility spike (`npm run spike`) and research that shaped the design.

The extension registers handlers only; it opens nothing until the first eligible prompt. Each Pi session runtime (startup, `/reload`, `/new`, `/resume`, `/fork`) gets a fresh extension instance, and `session_shutdown` stops capture, waits for pending writes, and closes the store, so a replaced runtime never records.

Only `@earendil-works/pi-coding-agent` is imported at runtime, as a `*` peer dependency; there are no other runtime dependencies. The published-files allowlist is in `package.json`.

## Tested compatibility

| | Tested |
| --- | --- |
| Pi | 0.85.1 (locked) and 0.87.1 |
| Node | 22.22.0 |
| Platform | macOS arm64 |

On both Pi versions, typecheck and `npm test` pass, and Pi's own extension loader loads the package from its manifest with no errors and no storage I/O. The `*` peer range is packaging convention, not a claim of wider support.

The tests use a minimal host harness. They do not prove real-TUI streaming, replay, or lifecycle behavior. The input-hook fields, exclusions, and session transitions the capture relies on were observed in the real TUI and SDK by the [compatibility spike](docs/research/compatibility-spike.md).

## Remaining gates

Not verified, and required before any release:

- Capture in the real TUI with a real provider: streaming, steering and follow-up keystrokes, replay and retry paths, and prompts queued during compaction.
- Exclusion of input from real print, JSON, and RPC frontends.
- Lifecycle races in real Pi: repeated shutdown delivery and writes still pending during session replacement.
- Real attachments: clipboard and drag-and-drop images alongside text.
- Concurrent appends from several Pi processes (owned by [#7](https://github.com/khiet/pi-prompt-history/issues/7)).
- Any Pi release other than 0.85.1 and 0.87.1, and any other Node version or platform.
