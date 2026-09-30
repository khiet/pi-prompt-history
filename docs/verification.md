# Development and verification

[README](../README.md) | [Behavior reference](behavior.md)

The release results below were recorded on 2026-09-29 and preserved from the original README; this documentation reorganization does not constitute a new compatibility run. Paths and commands are relative to the repository root.

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
npm run spike                   # compatibility spike and shortcut checks
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
- `spike/`: real-Pi checks and the compatibility spike. `acceptance.py` drives the real extension in the real TUI through `harness.py`, with `scripted.ts` as an in-process model whose replies and compactions wait for the script, so it can type while Pi streams or compacts. `shortcut.py` covers the shortcut, its config, reload, and every reserved-action conflict. `driver.ts` swallows prompts for `scripts/smoke-install.mjs` so no model is called. `sdk.mjs`, `streaming.mjs`, `tui.py`, and `probe.ts` are the original spike; `docs/research/` records its findings.

The extension registers handlers and reads `config.json` once to register the shortcut; it opens the history file only at the first eligible prompt or search. Each Pi session runtime (startup, `/reload`, `/new`, `/resume`, `/fork`) gets a fresh extension instance, and `session_shutdown` stops capture, waits for pending writes, and closes the store, so a replaced runtime never records, and a picker still open when its session shuts down restores nothing.

Package rules, checked by `npm run check:package`:

- One extension entry point, `./src/index.ts`, declared under `pi.extensions`.
- An explicit `files` allowlist of the four modules; npm adds `package.json`, `README.md`, and `LICENSE`, and nothing else is packed, so no local history, tests, or spike files ship.
- The package is publishable: not `private`, a release version, the `pi-package` keyword, and `repository`, `homepage`, `bugs`, and `author` set. `package.json`, the lockfile, and `LICENSE` all say MIT.
- `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are `*` peer dependencies, as Pi's package docs require, and are never bundled. Runtime imports are limited to them and Node built-ins. There are no `dependencies` and no install or `prepare` scripts.
- `package-lock.json` is committed; CI installs with `npm ci --ignore-scripts`.

## Tested compatibility

| | Tested |
| --- | --- |
| Pi | 0.85.1 (locked), 0.87.1, and 0.99.1, the current stable release on 2026-09-30 |
| Node | 22.22.0 and 24.21.0 |
| Platform | macOS arm64 locally; Ubuntu in CI |

CI runs lint, typecheck, `npm test`, `check:package`, and `smoke:install` for each Pi and Node pair above. The `*` peer range is packaging convention, not a claim of wider support. Pi's own engine range (`>=22.19.0`) is not evidence either: other Node versions have not been tested.

## Verification

Recorded on 2026-09-29 on macOS arm64. Real-TUI checks run the real CLI in a PTY with `TERM=xterm-256color`, in isolated temporary home and agent directories, with no network.

On Pi 0.85.1 and 0.87.1, with Node 22.22.0:

- `npm run lint`, `npm run typecheck`, `npm test` (157 tests), `npm run check:package`, and `npm run smoke:install` pass. All of these also pass with Node 24.21.0.
- `spike/acceptance.py` passes: idle, steering (Enter while streaming), and follow-up (Alt+Enter) prompts are each recorded once, and delivering them records nothing more; prompts queued during `/compact` are recorded as described in [What gets recorded](behavior.md#what-gets-recorded) (only the first on 0.85.1, each once on 0.87.1); the [built-in history comparison](behavior.md#compared-with-pis-built-in-history); capture and the picker after `/reload`, `/new`, `/resume`, and `/fork`, with each prompt recorded once; restore with normalization and without submitting, and Escape keeping the draft; the image warning, declined and accepted; Tab scope and Ctrl+D with its confirmation; `/history clear cwd` and `clear all` through Pi's confirmation dialog, cancelled and accepted; resizing to 24, 10, 200, and 60 columns with the picker open, without Pi exiting and with restore still exact afterwards (not how it renders); Japanese, accented, and emoji text typed and found with case-folded and punctuation queries; the picker opening and restoring under the light theme; Pi's `modal-editor.ts` example loaded alongside; two Ctrl+R presses leaving one picker; and a picker open while the session is replaced restoring nothing into the new one.
- `spike/shortcut.py` passes, including Ctrl+R bound to each of Pi's 18 reserved actions: Pi warns and skips the shortcut, and `/history` still opens. For `app.exit`, `app.suspend`, and `app.editor.external`, Ctrl+R itself was not pressed.
- `spike/pause.py` and `npm run spike` pass.

Pi 0.99.1 was added on 2026-09-30 on macOS arm64 with Node 22.22.0: `npm run lint`, `npm run typecheck`, `npm test` (165 tests), `npm run check:package`, `npm run smoke:install -- 0.99.1`, and `spike/acceptance.py` pass, with prompts queued during `/compact` each recorded once, as on 0.87.1. `spike/shortcut.py`, `spike/pause.py`, and `npm run spike` were not rerun on 0.99.1.

After 0.1.0 was published on 2026-09-30, `pi install npm:pi-prompt-history` from the registry was checked on Pi 0.85.1 and 0.99.1 with Node 22.22.0, in isolated home and agent directories: the registry tarball's shasum matches the published one, and Pi's RPC `get_commands` reports `/history` loaded from the installed package (`origin: package`, `source: npm:pi-prompt-history`).

After the MIT license change, `npm run lint`, `npm run typecheck`, `npm test`, `npm run check:package`, and `npm run smoke:install` were rerun and pass on Pi 0.85.1 and 0.87.1 with Node 22.22.0, and CI reran them with Node 24.21.0 (see below). The clone install was also checked from a fresh clone, with isolated home and agent directories: `pi install` on the checkout, with no `node_modules`, records it in `settings.json` and `pi list` shows it. That check does not load the extension; `smoke:install` covers loading, for the packed package.

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

Report vulnerabilities privately, not in a public issue; see [SECURITY.md](../SECURITY.md).

## License

[MIT](../LICENSE)
