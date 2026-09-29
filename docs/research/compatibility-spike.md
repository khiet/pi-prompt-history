# Compatibility spike (#2)

This document records the bounded investigation for [issue #2](https://github.com/khiet/pi-prompt-history/issues/2), against the guarantees in [the parent PRD](https://github.com/khiet/pi-prompt-history/issues/1). It predates the storage/capture foundation (#10); see the [README](../../README.md) for what the package does now.

**Result: spike closed; owner decisions recorded.** Several public integration seams work, but exact arbitrary-text restoration fails and replacing the draft loses an attached image path; the owner revised both guarantees on 2026-09-29. Factory-local pause does not survive runtime replacement; the owner approved a process-global pause, which passes on both tested releases. Re-run on 2026-09-29 against the minimum (0.85.1) and the newer current stable (0.87.1); one queue-helper behavior changed in 0.86.0 (see [Version delta](#version-delta-0851-to-0871)). Issue #2 was closed on 2026-09-29 with the unverified checks below moved to the PRD's release gates, not treated as verified. Those gates were run against the finished extension in #9; the README's [Verification](../../README.md#verification) section records what passed and what remains unverified.

## Tested environment

First reproduced and extended on **2026-09-09 (UTC)**, following the owner's approval to extend verification without changing guarantees. Re-run on **2026-09-29 (UTC)** from fresh installs of both targets below.

| Target | Resolved/tested version | Evidence |
| --- | --- | --- |
| Minimum Pi | `@earendil-works/pi-coding-agent@0.85.1` | Fresh locked npm install (`npm ci`); SDK and real CLI/TUI probes |
| Current npm stable | `0.87.1` (published 2026-09-22) | `npm view @earendil-works/pi-coding-agent@latest version dist-tags.latest --json` returned `0.87.1` on 2026-09-29; exact-pinned install over the lockfile; SDK and real CLI/TUI probes |
| Node | **22.22.0** | All probes; no other Node version tested |
| Pi TUI / agent-core / AI | `0.85.1` or `0.87.1` each, matching the Pi under test | Dependencies from the installed Pi package; public AI stream utility also pinned as explicit test tooling |
| Platform | macOS **26.6.2**, build **25G83**, arm64 | POSIX PTY, `TERM=xterm-256color`, regular TUI |
| Probe tooling | npm **10.9.4**, Python **3.12.13**, Biome **2.4.8**, Ruff **0.15.14** | Lint/format and tests |

Minimum and current stable are now **two distinct releases**, each tested independently; intermediate releases (0.86.0, 0.86.1, 0.87.0) were not. npm reports Pi's Node engine as `>=22.19.0` for both; that is an upstream requirement, **not** evidence that this spike tested all those versions. No release support range is declared here. Pi's npm `gitHead` was `d981de1229ef899957bbe968bc8dcda02a21f477` for 0.85.1 and `f07218c4d4bbc12bef056a7058c3dd49dfe41abe` for 0.87.1.

## Reproduce

Requires Node and npm, plus Python 3 on a POSIX system with PTYs. No API key or paid model call is needed.

```sh
npm ci --ignore-scripts
npm run lint:fix
npm run spike
# Current stable: repeat against 0.87.1 without changing the lockfile
npm install --no-save --ignore-scripts --save-exact @earendil-works/pi-coding-agent@0.87.1 @earendil-works/pi-ai@0.87.1
npm run spike
npm ci --ignore-scripts  # restore the locked minimum
# Python lint/format, if Ruff is installed (tested with 0.15.14):
ruff check --fix spike/tui.py
ruff format spike/tui.py
```

The spike scripts are **test tooling**, separate from the extension package. `npm run spike` runs:

- [`spike/sdk.mjs`](../../spike/sdk.mjs): public SDK calls, assertions for paths, ephemeral detection, input ordering and non-TUI mode/source filtering; then invokes the streaming probe in the same isolated child process.
- [`spike/streaming.mjs`](../../spike/streaming.mjs): public provider registration and SDK calls, with a **scripted in-process provider**, not an HTTP server or real inference. Thirteen synthetic provider calls exercise streaming queue delivery, expansion, retry and overflow-compaction continuation. Input observers return `continue`; no input sink is installed in this probe.
- [`spike/tui.py`](../../spike/tui.py): launches the real installed Pi CLI in isolated temporary homes, agent directories and working directories; sends PTY keystrokes, resizes the terminal, and asserts public-hook/editor observations.
- [`spike/probe.ts`](../../spike/probe.ts): a disposable diagnostic extension copied into those temporary agent directories. Composes Pi's `Input` and `SelectList`, observes input, and exposes test commands. A final `handled` input handler consumes every prompt **before any model turn**. The observer itself returns `continue`.

**Do not install the probe in your normal Pi environment. It consumes prompts and logs synthetic text.** The runners do not copy credentials, use the real clipboard, alter user keybindings/settings, or discover user extensions/context files. Environment variables are allowlisted and startup networking is disabled. Only the streaming SDK probe runs agent turns, exclusively through its registered in-process script, using a dummy non-secret auth value and no HTTP client. TUI prompts are still consumed before agent turns. Synthetic keybinding fixtures are written only inside temporary agent directories. Tests remove successful temporary runs; a failed TUI run retains only its synthetic diagnostic files and prints their location. The scripts do not use Pi private fields or patch internals. Static source inspection below is separate from runtime testing.

Expected result per Pi version: one `SDK PASS`, one `SDK STREAM PASS` (naming the Pi version) and two `TUI PASS` lines, with exit status 0. The streaming probe branches on Pi's exported `VERSION` for the one behavior that differs between tested releases. Negative compatibility results are deliberate assertions, not test failures. Fresh `npm ci --ignore-scripts`, Biome auto-fix, Ruff check/format, and the full suite passed on the recorded environment. The explicit AI devDependency supports its public ESM import; this remains private test tooling, not extension packaging.

## Findings by acceptance area

**D** = documented public contract, **S** = static implementation inspection, **SDK** = actual SDK runtime (not a real frontend; streaming cases bind `mode: "tui"` but do not create a terminal), **TUI** = actual CLI in a PTY. PTY results do not establish visual quality or physical IME behavior.

| Area | Evidence and result |
| --- | --- |
| Agent directory | **D + SDK + TUI:** `getAgentDir()` honors `PI_CODING_AGENT_DIR`; SDK verifies unset default under isolated HOME, absolute override, and `~/` expansion. TUI reports the supplied agent directory. No hardcoded user path is needed. Relative overrides untested. |
| Idle input fields | **D + TUI:** typed input has `source: "interactive"`, `ctx.mode: "tui"`, and absent `streamingBehavior` (logged as `null`). Eligible-origin observations continue unchanged. |
| Raw skills/templates | **D + TUI:** loaded `/skill:probe-skill arg` and `/probe-template arg` reach the input observer literally; the TUI sink stops before expansion. **SDK:** a loaded skill reaches the hook literally, then its expanded content and argument reach the scripted provider. A template submitted during streaming reaches the hook literally with `followUp`, queues expanded text and delivers that text to the script. Real-provider/frontend expanded delivery remains unverified. |
| Earlier transforms | **D + SDK + TUI:** an earlier registered handler changes `transform-me` to `transformed\ttext`; the observer sees the transformed string, not keystrokes. **SDK:** separate inline extension factories also demonstrate an earlier transform introducing a tab into streaming steering input; the later observer, queue and scripted provider all see that transformed text. Separately discovered on-disk extension ordering remains unverified. |
| Whitespace | **SDK:** hook text retains leading/trailing whitespace, LF, Unicode and tabs. **TUI + S:** the normal submit handler trims outer whitespace before the input hook. A multiline bracketed paste reaches the observer without its outer spaces. The contract can store hook observations, not exact original keystrokes. |
| Commands bypass hook | **D + SDK + TUI:** registered commands execute without an input observation, including **SDK** execution while a scripted stream is held open. Pi's own interactive commands are also outside the general prompt path. Do not advertise complete slash-command history. |
| Non-TUI / extension origin | **D + SDK:** all nine combinations of print/json/rpc mode bindings and interactive/rpc/extension sources are rejected by the eligibility predicate. These are SDK bindings, not real RPC/print/JSON frontend tests. **TUI:** `pi.sendUserMessage()` reaches the hook with source `extension` and is excluded. |
| Ephemeral sessions | **D + SDK + TUI:** `getSessionFile()` is undefined with `SessionManager.inMemory()` and real `--no-session`; ephemeral input is excluded. A new persistent session already has a file path before messages are written, so file existence is not the right test. |
| Steering, follow-up, replay | **D + SDK:** while a scripted text stream is held open, `prompt()` emits interactive `steer`/`followUp` input before queueing. Both deliver in order without another input event. `clearQueue()` emits no input; explicit resubmission emits a second observation, while only one copy is delivered. Direct SDK `steer()`/`followUp()` helpers bypass the input hook on 0.85.1; on 0.87.1 each emits exactly one eligible `interactive` observation with its `streamingBehavior` (see [Version delta](#version-delta-0851-to-0871)). A scripted rate-limit failure retries once; a scripted overflow compacts using an extension-provided summary and continues once. Each recovery makes two provider calls but only one input observation. **Unverified:** real-TUI streaming/dequeue keystrokes, tool-boundary steering, actual providers, threshold/between-tool compaction, aborted/exhausted retries and broader replay paths. See the bounded matrix below. |
| Session transitions / backfill | **D + TUI:** reload, new, resume and fork issue shutdown then a fresh factory's start with corresponding reasons. No input observations occur from restoring the synthetic session. A recorder need not read/backfill session entries. The fixture reads the branch only to choose an entry for the fork test, not for capture. |
| Ctrl+R | **TUI:** with the default editor focused, extension shortcut opens the picker, not rename. Pi emits its built-in conflict warning. With synthetic `app.clear: "ctrl+r"` configuration, Pi warns and skips the extension shortcut: Ctrl+R clears a nonempty draft without opening, renaming or submitting. `/history` still works, as does configured Alt+H in another run with the same reserved binding. Ownership is conditional on keybindings and editor compatibility. |
| Alternative shortcut / command | **TUI:** `/history` opens; a separately configured `alt+h` opens alongside Pi's bundled `modal-editor.ts` example. The fixture's environment selector is test configuration, not MVP config implementation. |
| Native history | **TUI:** a new process opening a persisted synthetic session via `--session` recalls its user prompt with Up. Resuming in-process also repopulates history. A subsequent `/new` **retains previous prompts and commands in that process's editor history**. A fresh process with a fresh session recalls nothing, even with a saved fixture in its agent session directory. See the delta below. |
| Editor restore / cancel | **TUI:** selecting an LF multiline string with outer spaces, accents, Japanese and emoji restores it exactly without input observation/submission. Escape leaves the draft unchanged. **Negative:** CR/CRLF and tabs normalize; see decision 1. |
| Images | **S + negative TUI reference test:** replacing text removes the image path embedded in the draft. Cancellation preserves that path. This is **not** a real clipboard/payload-preservation test; see decision 2. Historical attachment restoration is not implemented. |
| Process-local pause | **TUI:** pause held in a `Symbol.for("pi-prompt-history/process-state")` slot on `globalThis` survives reload/new/resume/fork: each fresh factory starts paused, restores PAUSED via `setStatus()`, and logs later input as paused. Explicit unpause re-enables recording; every new process starts unpaused. The flag is never written to or read from disk. This is an owner-approved technique, **not** a documented Pi API; see decision 3. |
| Cleanup / duplicates | **TUI:** one shutdown per observed factory across the tested transitions and quit, no duplicate idle observations/command registrations after reload, and no backfill inputs. The fixture uses idempotent shutdown and avoids using a closed context on picker completion. **Unverified:** repeated shutdown delivery, concurrent/overlapping pickers, delayed stale results during replacement, and resource cleanup under failure/retry. No history-storage resources exist in this spike. |
| Custom UI | **TUI:** public `custom()`, composed Input/SelectList, injected theme/keybinding manager, propagated input focus, filtering, Down/Enter/Escape, and resize from 100 to 24 columns execute without crash. The component truncates lines and invalidates its children. **Unverified:** physical IME candidates/composition, visual theme changes, all terminal widths/heights, all picker controls (Tab/scope, Ctrl+D/confirmation), terminal-control display safety, and broader editor-extension coexistence. This fixture is not the product picker. |

## Follow-up: bounded streaming evidence

[`spike/streaming.mjs`](../../spike/streaming.mjs) registers three distinct inline extension factories (transform, observation/commands/compaction, provider). It runs the real Pi SDK/agent loop, not a recreated host. A promise-controlled stream emits a text delta; the test waits for Pi's public `message_update` event and asserts `isStreaming` before submitting queued input. Prompts, provider responses and the compaction summary are synthetic; Pi's queue and recovery machinery are real. No private state is set and no tool executes.

| Scenario | Scripted provider calls | Assertions |
| --- | ---: | --- |
| Idle seed, transformed steer, template follow-up | 3 | Exact observed fields; transformed/expanded queue text; successive provider contexts contain seed, then steer, then follow-up; no input on queue delivery; command executes during streaming without capture |
| Skill invocation | 1 | Raw hook text, expanded skill content and argument in provider context |
| Clear queues and explicitly resubmit | 2 | Both queues returned/cleared; no input from clearing; resubmitted text has two hook observations but one delivered user message; discarded follow-up never delivers |
| Direct SDK queue helpers | 3 | 0.85.1: `steer()` and `followUp()` deliver but do not emit input. 0.87.1: each emits one input observation (`source: "interactive"`, matching `streamingBehavior`, eligible) and delivery adds none |
| Rate-limit recovery | 2 | One `auto_retry_start`, successful `auto_retry_end`, unchanged user text across attempts, one input observation |
| Overflow recovery | 2 | One `session_before_compact` with `reason: "overflow"` and `willRetry: true`; replacement context contains synthetic summary and pending prompt; successful continuation, one input observation |

These are assertions about **hook observations**, not a guarantee that each observation is delivered: cleared input remains observed and an explicit resubmission is another observation. The script does not test HTTP serialization, server retries, inference, real steering/follow-up keystrokes, tools, or every compaction/retry path. It does not establish eligibility of an actual frontend merely by binding SDK mode to `tui`. No replay-induced duplicates occurred in these two recovery scenarios; the broader release gate remains open.

## Version delta: 0.85.1 to 0.87.1

**Changed (D + S + SDK):** Pi 0.86.0's changelog reports "Fixed direct RPC `steer` and `follow_up` commands bypassing extension `input` handlers (#8718)". In 0.87.1, `AgentSession.steer()`/`followUp()` route through input handlers with `source` defaulting to `"interactive"` (`dist/core/agent-session.js` 1415-1428); RPC mode passes `source: "rpc"`. The SDK probe confirms one observation per helper call and none on delivery.

**Impact (S):** the TUI queues prompts typed during compaction without running input handlers (`queueCompactionMessage`, `dist/modes/interactive/interactive-mode.js` 3781), then flushes the first through `prompt()` and the rest through `steer()`/`followUp()` (3809-3858). On 0.85.1 those later prompts are never observed, a missed-capture gap; on 0.87.1 each is observed once, eligible. Neither version double-captures them. This path is static-only; a real-TUI compaction queue remains unverified. A recorder must also not assume every eligible observation came from the editor: other extensions calling the SDK helpers without a `source` look like typed input.

**Unchanged:** every other SDK and TUI assertion, including the text and image blocker reproductions and the process-global pause check, passes identically on both releases. Static checks of 0.87.1 find no documented draft-attachment API or process-lifetime state facility in the extension docs or `ExtensionUIContext` types (`setEditorText`/`getEditorText` only), and `pi-tui`'s editor `setText` still calls `normalizeText`.

## Blockers and owner decisions (2026-09-29)

### 1. Exact restoration of arbitrary hook text

**Observed:** public `ctx.ui.setEditorText("a\tb\r\nc\rd")`, followed by `getEditorText()`, returns `"a    b\nc\nd"`. Pi's editor normalizes tabs and carriage returns. An earlier input transform can introduce a tab after normal editor processing, so this matters even if ordinary typing already normalizes text.

A selected LF/Unicode example does round-trip, but that cannot justify the PRD's exact-text guarantee for every hook observation.

**Decision:** revise the guarantee to documented normalization. History stores the hook text exactly; restoring it yields that text as Pi's editor normalizes it (tabs to spaces, CR/CRLF to LF). Stored text is never pre-normalized, so a future exact-text API needs no data migration.

### 2. Existing image attachments

**Static finding:** Pi 0.85.1's clipboard handler (unchanged in substance on 0.87.1) writes the image into a temporary file and inserts its file path into editor text. `setEditorText()` simply calls `editor.setText()`. There is no documented separate draft-attachment get/set/preserve facility in the reviewed extension API.

**Runtime scope:** the PTY types a synthetic PNG path into the draft, opens/cancels the picker (path remains), then selects replacement text (path disappears). This proves reference loss for that text representation, **not** loss of every possible attachment route. Real clipboard paste, drag/drop, initial CLI image inputs, mixed text/image submission, and attachment identity remain unverified. The test never touches the user's clipboard and never sends an image to a provider.

**Decision:** narrower contract. Selecting a history entry replaces the whole draft, including any attached image; the picker warns before replacing a draft that contains an image. Cancellation still preserves the draft. Parsing/reinserting paths is **not** adopted.

### 3. Pause for the lifetime of the process

**Observed:** `let paused = false` inside the extension factory loses pause on every tested new/resume/fork/reload. Restoring `setStatus()` on `session_start` is supported, but it does not recover the lost boolean. This disproves factory-local pause, not every conceivable process-state technique.

The reviewed docs explain session-persisted `appendEntry()`, factories/lifecycle hooks, and an inter-extension event bus. They do **not** document a process-lifetime state facility surviving all replacements. Static inspection also shows event-bus subscriptions are removed when an extension runtime is invalidated; leaving a listener alive is not a justified solution. `appendEntry()` would persist to disk and violate the approved pause semantics.

**Decision:** approve a namespaced `globalThis` process-state slot, keeping the PRD's pause semantics unchanged. The probe now demonstrates it (see the pause row above) on 0.85.1 and 0.87.1. Risk: this relies on Pi reusing one Node realm for replaced extension runtimes, which Pi does not document; the TUI test is the regression guard and must pass on every supported Pi release. No environment-state workaround or disk-backed pause is used; the diagnostic log records synthetic outcomes only and is never read to restore pause.

## The actual extension delta

Pi already persists sessions and offers `/resume`, searchable `/tree`, and (in experimental fullscreen mode) transcript search. Native Up/Down editor history is not universally ephemeral: it can be populated from a resumed session and survives `/new` within the tested process. The saved-session probe uses the documented JSONL format with synthetic user content; it does not test model-backed session writing or every compaction/branch case.

The proposed extension would add a **dedicated, cross-process prompt-only search index**, directory scoping, deletion/clear controls, and predictable recall independent of which session is resumed. It would not add Pi's first persistence or transcript search. Pause/deletion would affect only that future index, not Pi's session files, backups, or forensic erasure. No index or capture persistence exists yet.

## Shortcut guidance for the future MVP

The tested default `ctrl+r` deliberately shadows session rename **while the compatible editor is focused**. Pi warns about the conflict. To retain both actions, a user could manually move rename in `<getAgentDir()>/keybindings.json`, for example:

```json
{ "app.session.rename": "alt+r" }
```

Check `/hotkeys` and other extensions before choosing a key, then `/reload`. The example is documentation, not an edit performed by this spike. The synthetic reserved-action test binds `app.clear` to Ctrl+R inside an isolated agent directory: Pi skips the extension shortcut and warns, while `/history` and separately configured Alt+H remain usable. Other reserved bindings were not individually tested. Never rewrite user keybindings automatically or patch Pi's dispatcher.

## Evidence sources and remaining gates

Reviewed completely: Pi's README, `docs/extensions.md`, `docs/tui.md`, `docs/sdk.md`, and relevant `session-format.md`, `keybindings.md`, `environment-variables.md`, `skills.md`, `prompt-templates.md`; also the input-transform, streaming-input-transform, event-bus, Q&A, modal-editor and SDK extension examples. The follow-up re-read the core docs and additionally reviewed complete `custom-provider.md`, `compaction.md`, the custom Anthropic provider and custom-compaction examples, and SDK extension/template examples. The initial spike compared installed and freshly downloaded extension/TUI/SDK docs and recorded matching SHA-256 hashes; this follow-up used the freshly installed, version-pinned docs.

Version-pinned source: [Pi npm gitHead](https://github.com/earendil-works/pi-mono/tree/d981de1229ef899957bbe968bc8dcda02a21f477). Reproducible static anchors under `node_modules/@earendil-works/pi-coding-agent/`:

- `dist/modes/interactive/interactive-mode.js`: `setEditorText` (1920), clipboard path insertion (2334-2346), submit trim (2361 onward), session-message `populateHistory` (2971-2972).
- `node_modules/@earendil-works/pi-tui/dist/components/editor.js`: `setText` (917), `normalizeText` (949-950).
- `dist/core/agent-session.js`: `prompt` (821-874), queue helpers (`_queueSteer`, `_queueFollowUp`), `_runAgentPrompt` (772 onward).
- `dist/core/extensions/loader.js`: runtime invalidation/listener cleanup (135-186), module loading (409 onward).
- `dist/core/extensions/runner.js`: reserved shortcut list and conflict diagnostics; `dist/modes/interactive/components/custom-editor.js`: extension shortcut precedence.

Owner decisions on all three blockers are recorded above. The remaining items are release gates in the PRD. **Before claiming complete compatibility:** run the unverified matrix items, especially the remaining real-TUI/provider streaming/replay paths, the image-warning check with real attachments, lifecycle races, physical IME/theme/resize checks and wider coexistence. Re-resolve npm stable and repeat against any release newer than 0.87.1 plus each explicitly supported Node version. The static anchors above are for the locked 0.85.1 install unless a line names 0.87.1. A passing spike test run is evidence for these bounded observations only, not release approval.
