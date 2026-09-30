# pi-prompt-history

Ctrl+R prompt search for [Pi](https://pi.dev). Records the prompts you type to a local JSONL file, then searches, restores, and deletes them across sessions and processes.

> **MVP, not production-ready or on npm.** Stores prompts in plain text. Read [Caveats](#caveats) before installing.

## Install

```sh
git clone https://github.com/khiet/pi-prompt-history.git
pi install "$PWD/pi-prompt-history"
```

Loads on next start or `/reload`. No runtime dependencies, no install scripts. Try once with `pi -e <path>`; remove with `pi remove <path>` (history is kept).

## Picker

| Key | Action |
| --- | --- |
| `ctrl+r` or `/history` | Open. Lists this directory's prompts, newest first, filtered by a single-line draft |
| _type_ | Show prompts containing every typed word, in any order (case-insensitive, literal); newest 100 distinct prompts shown |
| `tab` | Toggle this directory / all directories |
| `up` / `down` | Select and preview a prompt |
| `enter` | Replace the whole draft with the prompt (not sent) |
| `ctrl+d` | Delete every copy of the selected prompt in the current scope (`y` to confirm) |
| `esc` | Close, draft unchanged |

A prompt typed more than once is listed once, at its newest use; each submission is still stored. Directory scope uses the exact cwd, not the Git root. Attachments from recalled prompts are not restored.

## Commands

| Command | Effect |
| --- | --- |
| `/history clear cwd` | Delete this directory's prompts (exact cwd), after confirmation |
| `/history clear all` | Delete every recorded prompt, after confirmation |

## Config

`<agent dir>/prompt-history/config.json`, applied on `/reload`:

```json
{ "shortcut": "alt+h" }
```

| Setting | Default | Rule |
| --- | --- | --- |
| `shortcut` | `ctrl+r` | Needs `ctrl`, `alt`, or `super`, or `f1`-`f12`. Invalid file is ignored with a warning |

`ctrl+r` shadows Pi's session rename and triggers a conflict warning. To keep both, rebind rename in `<agent dir>/keybindings.json`: `{ "app.session.rename": "alt+r" }`. Check `/hotkeys` for a free key, then `/reload`. `/history` works independently of the shortcut.

## Storage

`<agent dir>/prompt-history/history.jsonl`. Agent dir is `~/.pi/agent` or `$PI_CODING_AGENT_DIR`. New files use mode `0600` where supported; existing permissions are unchanged.

| Limit | Value |
| --- | --- |
| Retention target | newest 10,000 records after compaction |
| Results | 100 per search |
| Prompt size | 32,768 UTF-8 bytes (larger is skipped) |

Compaction runs when an append takes the process's record count past 11,000; 10,000 is not a hard record-count cap.

**Recorded:** interactive TUI prompts in saved sessions, including steering and follow-ups.
**Not recorded:** `--no-session`, print/JSON/RPC modes, built-in and extension commands, `pi.sendUserMessage()` input, attachment contents, whitespace-only input.
History is not automatically exposed to the model. Recalled prompts can still be submitted. See [capture details](docs/behavior.md#what-gets-recorded) for version-specific exceptions.

## Caveats

- A second, plain-text copy of recorded prompts, secrets included.
- Delete and clear do not touch Pi's session files or guarantee erasure from disk or backups.
- No locking: a rewrite can drop another process's concurrent append. Local filesystems only.

Full behavior and record format: [docs/behavior.md](docs/behavior.md).

## Compatibility

Tested: Pi 0.85.1, 0.87.1, 0.99.1; Node 22.22.0, 24.21.0; macOS arm64 locally, Ubuntu CI. Untested: Windows, git install, real IME. See [docs/verification.md](docs/verification.md).

## Development

```sh
npm ci --ignore-scripts
npm run lint && npm run typecheck && npm test
npm run acceptance   # real-TUI checks, needs Python 3 and POSIX PTYs
```

[Full checks and contributing](docs/verification.md#development). Never include prompt history or secrets in issues.

## License

[MIT](LICENSE). Report vulnerabilities per [SECURITY.md](SECURITY.md).
