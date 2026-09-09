# pi-prompt-history

**Compatibility spike only — not an installable history extension.**

This repository records the bounded investigation for [issue #2](https://github.com/khiet/pi-prompt-history/issues/2), against the guarantees in [the parent PRD](https://github.com/khiet/pi-prompt-history/issues/1). No prompt store, MVP, or release is implemented.

**Result: blocked guarantees and incomplete verification.** Several public integration seams work, but exact arbitrary-text restoration fails, image-path replacement loses the draft reference, and factory-local pause does not survive runtime replacement. No guarantee has been relaxed. Issue #2 should not be marked fully verified.

## Tested environment

Recorded on **2026-09-09 (UTC)**:

| Target | Resolved/tested version | Evidence |
| --- | --- | --- |
| Minimum Pi | `@earendil-works/pi-coding-agent@0.85.1` | Fresh locked npm install; SDK and real CLI/TUI probes |
| Current npm stable | `0.85.1` | `npm view @earendil-works/pi-coding-agent@latest version dist-tags.latest gitHead engines --json` returned version/latest `0.85.1` |
| Node | **22.22.0** | All probes; no other Node version tested |
| Pi TUI / agent-core / AI | `0.85.1` each | Dependencies from the installed Pi package |
| Platform | macOS **26.6.2**, build **25G83**, arm64 | POSIX PTY, `TERM=xterm-256color`, regular TUI |
| Probe tooling | npm **10.9.4**, Python **3.12.13**, Biome **2.4.8**, Ruff **0.15.14** | Lint/format and tests |

Minimum and latest resolve to **one identical release**, not two independent compatibility tests. npm reports Pi's Node engine as `>=22.19.0`; that is an upstream requirement, **not** evidence that this spike tested all those versions. No release support range is declared here. Pi's npm `gitHead` was `d981de1229ef899957bbe968bc8dcda02a21f477`.

## Reproduce

Requires Node and npm, plus Python 3 on a POSIX system with PTYs. No API key or paid model call is needed.

```sh
npm ci --ignore-scripts
npm run lint:fix
npm test
# Python lint/format, if Ruff is installed (tested with 0.15.14):
ruff check --fix spike/tui.py
ruff format spike/tui.py
```

The private package and lockfile are **test tooling**, not a Pi package manifest. `npm test` runs:

- [`spike/sdk.mjs`](spike/sdk.mjs): public SDK calls, assertions for paths, ephemeral detection, input ordering and non-TUI mode/source filtering.
- [`spike/tui.py`](spike/tui.py): launches the real installed Pi CLI in isolated temporary homes, agent directories and working directories; sends PTY keystrokes, resizes the terminal, and asserts public-hook/editor observations.
- [`spike/probe.ts`](spike/probe.ts): a disposable diagnostic extension copied into those temporary agent directories. Composes Pi's `Input` and `SelectList`, observes input, and exposes test commands. A final `handled` input handler consumes every prompt **before any model turn**. The observer itself returns `continue`.

**Do not install the probe in your normal Pi environment. It consumes prompts and logs synthetic text.** The runners do not copy credentials, use the real clipboard, alter user keybindings/settings, or discover user extensions/context files. Environment variables are allowlisted, startup networking is disabled, and no agent turns occurred. Tests remove successful temporary runs; a failed TUI run retains only its synthetic diagnostic files and prints their location. The scripts do not use Pi private fields or patch internals. Static source inspection below is separate from runtime testing.

Expected result: one `SDK PASS` and two `TUI PASS` lines, with exit status 0. Negative compatibility results are deliberate assertions, not test failures.

## Findings by acceptance area

**D** = documented public contract, **S** = static implementation inspection, **SDK** = actual SDK runtime (not a real RPC/print frontend), **TUI** = actual CLI in a PTY. PTY results do not establish visual quality or physical IME behavior.

| Area | Evidence and result |
| --- | --- |
| Agent directory | **D + SDK + TUI:** `getAgentDir()` honors `PI_CODING_AGENT_DIR`; SDK verifies unset default under isolated HOME, absolute override, and `~/` expansion. TUI reports the supplied agent directory. No hardcoded user path is needed. Relative overrides untested. |
| Idle input fields | **D + TUI:** typed input has `source: "interactive"`, `ctx.mode: "tui"`, and absent `streamingBehavior` (logged as `null`). Eligible-origin observations continue unchanged. |
| Raw skills/templates | **D + TUI:** loaded `/skill:probe-skill arg` and `/probe-template arg` reach the input observer literally. **S:** expansion follows the hook. The test sink stops before expansion; expanded model delivery is unverified. |
| Earlier transforms | **D + SDK + TUI:** an earlier registered handler changes `transform-me` to `transformed\ttext`; the observer sees the transformed string, not keystrokes. Separate-extension ordering was not independently exercised. |
| Whitespace | **SDK:** hook text retains leading/trailing whitespace, LF, Unicode and tabs. **TUI + S:** the normal submit handler trims outer whitespace before the input hook. A multiline bracketed paste reaches the observer without its outer spaces. The contract can store hook observations, not exact original keystrokes. |
| Commands bypass hook | **D + SDK + TUI:** registered commands execute without an input observation. Pi's own interactive commands are also outside the general prompt path. Do not advertise complete slash-command history. |
| Non-TUI / extension origin | **D + SDK:** all nine combinations of print/json/rpc mode bindings and interactive/rpc/extension sources are rejected by the eligibility predicate. These are SDK bindings, not real RPC/print/JSON frontend tests. **TUI:** `pi.sendUserMessage()` reaches the hook with source `extension` and is excluded. |
| Ephemeral sessions | **D + SDK + TUI:** `getSessionFile()` is undefined with `SessionManager.inMemory()` and real `--no-session`; ephemeral input is excluded. A new persistent session already has a file path before messages are written, so file existence is not the right test. |
| Steering, follow-up, replay | **D + S only:** hook supports `steer`/`followUp`; `prompt()` emits it before queueing and the queue helpers do not emit it again. The inspected agent continuation path calls `agent.continue()`, not the input hook. **Unverified at runtime:** streaming, delivery, dequeue/resubmit, retry/compaction replay, and absence of replay-induced duplicate capture. No model execution was simulated or paid for. |
| Session transitions / backfill | **D + TUI:** reload, new, resume and fork issue shutdown then a fresh factory's start with corresponding reasons. No input observations occur from restoring the synthetic session. A recorder need not read/backfill session entries. The fixture reads the branch only to choose an entry for the fork test, not for capture. |
| Ctrl+R | **TUI:** with the default editor focused, extension shortcut opens the picker, not rename. Pi emits its built-in conflict warning. **S:** extension shortcuts precede app actions; rename is not reserved. This is not unconditional ownership against custom keybindings or editors. |
| Alternative shortcut / command | **TUI:** `/history` opens; a separately configured `alt+h` opens alongside Pi's bundled `modal-editor.ts` example. The fixture's environment selector is test configuration, not MVP config implementation. |
| Native history | **TUI:** a new process opening a persisted synthetic session via `--session` recalls its user prompt with Up. Resuming in-process also repopulates history. A subsequent `/new` **retains previous prompts and commands in that process's editor history**. A fresh process with a fresh session recalls nothing, even with a saved fixture in its agent session directory. See the delta below. |
| Editor restore / cancel | **TUI:** selecting an LF multiline string with outer spaces, accents, Japanese and emoji restores it exactly without input observation/submission. Escape leaves the draft unchanged. **Negative:** CR/CRLF and tabs normalize; see blocker 1. |
| Images | **S + negative TUI reference test:** replacing text removes the image path embedded in the draft. Cancellation preserves that path. This is **not** a real clipboard/payload-preservation test; see blocker 2. Historical attachment restoration is not implemented. |
| Process-local pause | **D + negative TUI:** a factory-local boolean resets on reload/new/resume/fork, and on process restart. The paused status is emitted to terminal output; new instances restore ACTIVE, not PAUSED. No compliant process-lifetime mechanism has been demonstrated; see blocker 3. |
| Cleanup / duplicates | **TUI:** one shutdown per observed factory across the tested transitions and quit, no duplicate idle observations/command registrations after reload, and no backfill inputs. The fixture uses idempotent shutdown and avoids using a closed context on picker completion. **Unverified:** repeated shutdown delivery, concurrent/overlapping pickers, delayed stale results during replacement, and resource cleanup under failure/retry. No storage resources exist in this spike. |
| Custom UI | **TUI:** public `custom()`, composed Input/SelectList, injected theme/keybinding manager, propagated input focus, filtering, Down/Enter/Escape, and resize from 100 to 24 columns execute without crash. The component truncates lines and invalidates its children. **Unverified:** physical IME candidates/composition, visual theme changes, all terminal widths/heights, all picker controls (Tab/scope, Ctrl+D/confirmation), terminal-control display safety, and broader editor-extension coexistence. This fixture is not the product picker. |

## Blocked guarantees — owner decisions required

### 1. Exact restoration of arbitrary hook text

**Observed:** public `ctx.ui.setEditorText("a\tb\r\nc\rd")`, followed by `getEditorText()`, returns `"a    b\nc\nd"`. Pi's editor normalizes tabs and carriage returns. An earlier input transform can introduce a tab after normal editor processing, so this matters even if ordinary typing already normalizes text.

A selected LF/Unicode example does round-trip, but that cannot justify the PRD's exact-text guarantee for every hook observation. Affected restoration work is stopped. Options for the owner: request upstream exact-text support, or explicitly revise the guarantee to documented normalization. Neither alternative is approved or implemented here; do not silently normalize stored history as a workaround.

### 2. Existing image attachments

**Static finding:** Pi 0.85.1's clipboard handler writes the image into a temporary file and inserts its file path into editor text. `setEditorText()` simply calls `editor.setText()`. There is no documented separate draft-attachment get/set/preserve facility in the reviewed extension API.

**Runtime scope:** the PTY types a synthetic PNG path into the draft, opens/cancels the picker (path remains), then selects replacement text (path disappears). This proves reference loss for that text representation, **not** loss of every possible attachment route. Real clipboard paste, drag/drop, initial CLI image inputs, mixed text/image submission, and attachment identity remain unverified. The test never touches the user's clipboard and never sends an image to a provider.

Do not promise attached-image preservation. Affected work is stopped. Owner options: seek upstream attachment-preserving text replacement, or explicitly approve a narrower product contract. Parsing/reinserting paths would change the exact replacement text and is **not** implemented or assumed acceptable.

### 3. Pause for the lifetime of the process

**Observed:** `let paused = false` inside the extension factory loses pause on every tested new/resume/fork/reload. Restoring `setStatus()` on `session_start` is supported, but it does not recover the lost boolean. This disproves factory-local pause, not every conceivable process-state technique.

The reviewed docs explain session-persisted `appendEntry()`, factories/lifecycle hooks, and an inter-extension event bus. They do **not** document a process-lifetime state facility surviving all replacements. Static inspection also shows event-bus subscriptions are removed when an extension runtime is invalidated; leaving a listener alive is not a justified solution. `appendEntry()` would persist to disk and violate the approved pause semantics.

Owner options: request a documented upstream process-state facility; explicitly approve and separately verify a namespaced `globalThis` process-state technique (not an approved documented Pi API here); or revise pause lifetime/persistence requirements. **No `globalThis`, environment-state workaround, disk-backed pause, or changed semantics have been implemented.** The diagnostic log records synthetic outcomes only; it is never read to restore pause.

## The actual extension delta

Pi already persists sessions and offers `/resume`, searchable `/tree`, and (in experimental fullscreen mode) transcript search. Native Up/Down editor history is not universally ephemeral: it can be populated from a resumed session and survives `/new` within the tested process. The saved-session probe uses the documented JSONL format with synthetic user content; it does not test model-backed session writing or every compaction/branch case.

The proposed extension would add a **dedicated, cross-process prompt-only search index**, directory scoping, deletion/clear controls, and predictable recall independent of which session is resumed. It would not add Pi's first persistence or transcript search. Pause/deletion would affect only that future index, not Pi's session files, backups, or forensic erasure. No index or capture persistence exists yet.

## Shortcut guidance for the future MVP

The tested default `ctrl+r` deliberately shadows session rename **while the compatible editor is focused**. Pi warns about the conflict. To retain both actions, a user could manually move rename in `<getAgentDir()>/keybindings.json`, for example:

```json
{ "app.session.rename": "alt+r" }
```

Check `/hotkeys` and other extensions before choosing a key, then `/reload`. The example is documentation, not an edit performed by this spike. If a reserved action is also bound to Ctrl+R, static inspection says Pi skips the extension shortcut; `/history` and a user-configured alternative should remain available. The conditional reserved-key conflict scenario was not exercised here. Never rewrite user keybindings automatically or patch Pi's dispatcher.

## Evidence sources and remaining gates

Reviewed completely: Pi's README, `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`, and relevant `session-format.md`, `keybindings.md`, `environment-variables.md`, `skills.md`, `prompt-templates.md`; also the input-transform, streaming-input-transform, event-bus, Q&A, modal-editor and SDK extension examples. Installed and freshly downloaded extension/TUI/SDK docs had matching SHA-256 hashes.

Version-pinned source: [Pi npm gitHead](https://github.com/earendil-works/pi-mono/tree/d981de1229ef899957bbe968bc8dcda02a21f477). Reproducible static anchors under `node_modules/@earendil-works/pi-coding-agent/`:

- `dist/modes/interactive/interactive-mode.js`: `setEditorText` (1920), clipboard path insertion (2334–2346), submit trim (2361 onward), session-message `populateHistory` (2971–2972).
- `node_modules/@earendil-works/pi-tui/dist/components/editor.js`: `setText` (917), `normalizeText` (949–950).
- `dist/core/agent-session.js`: `prompt` (821–874), queue helpers (`_queueSteer`, `_queueFollowUp`), `_runAgentPrompt` (772 onward).
- `dist/core/extensions/loader.js`: runtime invalidation/listener cleanup (135–186), module loading (409 onward).
- `dist/core/extensions/runner.js`: reserved shortcut list and conflict diagnostics; `dist/modes/interactive/components/custom-editor.js`: extension shortcut precedence.

**Before proceeding with the affected MVP slices:** obtain owner decisions on all three blockers. **Before claiming complete compatibility:** run the unverified matrix items, especially streaming/replay, real attachments, a compliant pause mechanism, lifecycle races, physical IME/theme/resize checks and wider coexistence. Re-resolve npm stable and repeat against any newer release plus each explicitly supported Node version. A passing spike test run is evidence for these bounded observations only, not release approval.
