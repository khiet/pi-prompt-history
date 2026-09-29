# Existing prompt-history options for Pi

Researched 2026-09-29 against primary sources only: the installed Pi 0.85.1 package, the upstream `earendil-works/pi` repository, the npm registry, published package tarballs, and first-party GitHub repositories. Judged against the guarantees in the parent PRD (khiet/pi-prompt-history#1), read without modification.

## Conclusion

The core user need is already served. At least eight published or public packages give cross-session prompt recall with a Ctrl+R-style search picker that restores text into the editor without submitting, and several of them add current-directory versus all-directories scoping (for example `@light4/pi-prompt-history`, `vedang/pi-prompt-history`, `ravshansbox/pi-prompt-history`; see the table). The most-used one, `pi-input-history`, had 607 npm downloads in the last week. None of the candidates reviewed meets the whole PRD contract. Every one misses at least one of: literal case-insensitive substring matching, per-entry deletion with confirmation, scoped clear, process-lifetime pause, unconditional ephemeral-session exclusion, and separate records for repeated submissions. Building `pi-prompt-history` is therefore worth it only for those privacy and management controls, or for the PRD's stated second goal: a small codebase the owner maintains as an example for future Pi plugins. It is not worth building just to get searchable cross-session history. Before investing further, try `@light4/pi-prompt-history` or `@sagmans/pi-history` for a week to see whether the missing controls actually matter. Also note that the spike's own blockers (exact-text restoration, pause lifetime; [compatibility-spike.md](compatibility-spike.md), Blockers section) are unsolved by every candidate reviewed.

## Built-in Pi behavior

Versions: installed `@earendil-works/pi-coding-agent@0.85.1` with bundled `@earendil-works/pi-tui@0.85.1`. npm `latest` is now **0.87.1** (published 2026-09-22), not 0.85.1 (`npm view @earendil-works/pi-coding-agent dist-tags`).

| Behavior | Finding | Source |
| --- | --- | --- |
| Up/Down editor history | In-memory array on the editor instance, newest first, consecutive duplicates dropped, text trimmed, capped at 100 entries. | `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui/dist/components/editor.js` lines 236-239, 300-316 |
| Browsing | Up at an empty editor, at column 0, or while already browsing goes to older entries. The draft is cloned and restored when you return past the newest entry. | same file lines 330-360, 741-758 |
| Dedicated bindings | `tui.editor.historyPrevious` / `historyNext` exist but are unbound by default (opt-in, for example Ctrl+P/Ctrl+N). Added in 0.84.0. | `docs/keybindings.md` lines 33-34, 46, 202-203; `CHANGELOG.md` line 385 (0.84.0, 2026-08-06) |
| Persistence | There is no history file. The editor is refilled with user messages from the loaded session's context when it renders initial messages (`populateHistory: true`), so `--session`, `/resume` and `/reload` recall that session's prompts. | `dist/modes/interactive/interactive-mode.js` lines 2971-2972, 3157-3162 |
| Cross-session | A fresh process with a fresh session recalls nothing. `/new` keeps the previous prompts only inside the same process. | This repo's spike, [compatibility-spike.md](compatibility-spike.md), Native history row (real TUI probe) |
| Origin | Added in 0.12.12 as "session-scoped and stores up to 100 entries". | `CHANGELOG.md` line 5413; upstream PR #121 |
| Search over prompts | Pi has no prompt search. The nearest features: the `/resume` picker searches sessions by typing; `/tree` searches entries and has a `user-only` filter mode (Ctrl+O); fullscreen mode has transcript search. None of these restores a prompt into the editor. | `docs/sessions.md` lines 38-47, 98-100; `README.md` lines 185, 258-263; spike [compatibility-spike.md](compatibility-spike.md), extension delta section |
| Package discovery | The official gallery at `https://pi.dev/packages` lists npm packages that have the `pi-package` keyword. | `docs/packages.md` lines 118-137; `README.md` line 410 |

Roadmap: the upstream changelog from 0.85.1 through `[Unreleased]` (last changelog commit `da19b63c77`, 2026-09-29) has no prompt-history feature entries. Maintainers point users to packages for features like this: "Features that other tools bake in can be built with extensions ... or installed from third-party pi packages" (`README.md` line 497).

## Ecosystem candidates

The npm "last publish" date is `time.modified` from `npm view`. All candidates are MIT unless noted. The feature columns come from each package's README, confirmed by grepping the published source (tarball fetched with `npm pack`) where marked (src).

| Package | Version / last publish | Capture and storage | Recall UI | Scope | Delete / clear / pause |
| --- | --- | --- | --- | --- | --- |
| [pi-input-history](https://github.com/ouzhenkun/pi-input-history) | 1.1.3 / 2026-09-24 | Reads the user's own Pi sessions via `SessionManager.list(cwd)` (src); last 100, deduplicated | Up/Down seeded; Ctrl+R fuzzy overlay (configurable); Enter accepts | Sessions for the current cwd only | None |
| [@signalridge/pi-input-history](https://github.com/signalridge/pi-extensions) | 1.2.6 / 2026-09-09 | Fork of the above; same `SessionManager.list(cwd)` read (src) | Ctrl+R two-pane fzf-style popup with preview, narrow-terminal fallback | Current cwd | None |
| [@light4/pi-prompt-history](https://github.com/light4/pi-prompt-history) | 0.3.0 / 2026-09-28 | Reads session files plus a cache at `~/.pi/agent/pi-prompt-history-history.json`; the cache includes ephemeral sessions | Ctrl+R (configurable) or `/history`; fuzzy; Enter restores without submit; Esc dismisses | Tab cycles session, workspace (cwd), global | None; Ctrl+G rebuilds the cache |
| [@sagmans/pi-history](https://github.com/sagmans/pi-history) | 0.1.8 / 2026-09-10 | Own store under `<agentDir>/pi-history/`, 0700/0600; skips `source === "extension"` (src); duplicates move to newest | Ctrl+R fuzzy; Enter replaces buffer; Esc restores draft; ghost completion | `project` or `global`, set in config (no live toggle) | `/pi-history clear` with confirm; no per-entry delete or pause documented |
| [proper-base](https://github.com/sharaf-nassar/proper-pi-extensions) (bundle) | 0.7.0 / 2026-09-21 | Per-cwd JSONL under `~/.pi/agent/proper-history/`; `source === "interactive"` (src); >4096 chars skipped | Up/Down across sessions; Ctrl+R readline-style, case-sensitive substring; Enter **submits** | Current cwd only | Delete the files by hand; no pause |
| [pi-atuin](https://github.com/RealAlexandreAI/pi-atuin) | 0.1.17 / 2026-09-25 | `~/.pi/agent/pi-history.jsonl` (0600, max 1000) plus optional atuin DB sync; `source === "interactive"` (src) | Up on an empty editor opens a fuzzy search | Global | None for prompts |
| [@stagefright5/pi-prompt-history-search](https://github.com/stagefright5/pi-agent-extensions) (Unlicense) | 0.1.2 / 2026-09-25 | JSON index built from the last 30 days of session files, then appended | Alt+R or `/prompt-history`; token substring or fuzzy, best match first; Enter restores; Esc keeps draft | Global; results show cwd | None; 30-day retention |
| [@jasonish/pi-prompt-history](https://www.npmjs.com/package/@jasonish/pi-prompt-history) | 0.1.0 / 2026-02-10 | Indexes session files; peer is the old `@mariozechner/pi-coding-agent` | Ctrl+Alt+R fuzzy; newest first | Global | None |
| [@janvitos/pi-better-prompt](https://github.com/janvitos/pi-better-prompt) | 0.6.0 / 2026-08-27 | Global JSONL, newest 100, locked atomic writes; interactive only | Up/Down only, no search | Global | None |
| [@tenchi4u/pi-session-history](https://github.com/the-matt-moo/pi-session-history) | 0.4.0 / 2026-09-21 | Rolling `~/.pi/agent/session-history/prompts.jsonl` (5 MiB) | `/history`, `/prompts [query]` case-insensitive filter; also session search and pins | Global | Pins; session archive; no prompt delete |
| [pi-prompt-storage](https://github.com/luan/agents) | 0.3.3 / 2026-09-12 | SQLite index of session files; per-directory stash | `/prompt-history` fuzzy overlay | Current directory | Stash drop only |
| [vedang/pi-prompt-history](https://github.com/vedang/pi-prompt-history) (GitHub only; license NOASSERTION) | pushed 2026-07-19 | Indexes session JSONL | Ctrl+R overlay, seeded from the draft | Local (exact cwd) and Global | Not documented |
| [ravshansbox/pi-prompt-history](https://github.com/ravshansbox/pi-prompt-history) (GitHub only) | pushed 2026-08-18 | `SessionManager.list(cwd)` / `listAll()` | Up/Down; Ctrl+R fuzzy picker | Current folder and All folders tabs | Not documented |
| [neenaoffline/pi-prompt-history-search](https://github.com/neenaoffline/pi-prompt-history-search) (GitHub only) | pushed 2026-08-22 | `~/.pi/agent/prompt-history-index.jsonl`, bootstrapped from sessions | Ctrl+R inline substring search | All sessions or current session | Not documented |

Narrower packages reviewed and set aside, each for the reason given:

- `pi-command-history` 0.2.2 and `@oipsanthony/pi-command-history` 0.2.3: per-folder Shift+Up/Down recall, no search.
- `@pi-lab/input-history` 1.0.3: project-level Up recall, no search.
- `@hfalconer/pi-history` 0.6.0: seeds the native editor with the 1000 newest prompts from other sessions, no picker.
- `@zigai/pi-prompt-history` 0.1.16: current session only.
- `@furbyhaxx/pi-prompt-history` 0.1.0: stores history per session.
- `@vcsoc/pi-prompt-history` 0.1.0: stores user and assistant messages in project `.pi/history/data.json`.
- `pi-autosuggestions` 0.8.13: ghost completion.
- `pi-draft-history` 0.1.2: keeps unsent drafts.
- `mrshu/pi-readline-search`: branch-local only, old `@mariozechner` peer.
- `mfirdausazizi/pi-prompt-history` and `lucacorbucci/pi-prompt-history`: Up/Down persistence only.

Adoption signal: npm downloads for the week ending 2026-09-28 were 607 for `pi-input-history`, 407 for `pi-atuin`, 268 for `proper-base`, 20 for `@sagmans/pi-history`, and 4 for `@light4/pi-prompt-history` (`api.npmjs.org/downloads/point/last-week`). All six top candidates checked have gallery pages (`https://pi.dev/packages/<name>` returned HTTP 200).

Adjacent tools outside Pi: `@pratikgajjar/pi-recall` 0.7.1 wraps an external `recall` CLI to search chat history across Cursor, Claude Code, Codex and Pi. `@vshulcz/deja-vu` 0.21.3 builds agent memory from session files. Neither restores a prompt into the Pi editor, so neither was analyzed further.

## Gap analysis against the PRD

Legend: Y = meets, P = partial, N = does not meet, ? = not documented and not verified. "Records" means the PRD rule that repeated submissions stay as separate records.

| PRD guarantee | pi-input-history | @light4 | @sagmans | proper-base | @stagefright5 | vedang / ravshansbox |
| --- | --- | --- | --- | --- | --- | --- |
| Cross-session persistence | Y (reads sessions) | Y | Y | Y | Y (30 days) | Y |
| Ctrl+R default, configurable, plus `/history` command | P (no command) | Y | P (no picker command) | N (not configurable) | P (Alt+R) | P |
| Literal, case-insensitive substring | N (fuzzy) | N (fuzzy) | N (fuzzy) | N (case-sensitive) | P (substring or fuzzy) | N / N |
| Newest first; empty query shows recent | Y | P (dedup, ranked) | ? | Y | P (best match first) | ? |
| cwd default with a live toggle to all | N (cwd only) | Y (3-way Tab) | N (config) | N (cwd only) | N (global) | Y / Y |
| Enter restores without submit; Esc keeps draft | Y | Y | Y | N (Enter submits) | Y | Y |
| Delete one entry with confirmation | N | N | N | N | N | ? |
| Clear cwd or all with confirmation | N | N | P (clear all) | N (manual) | N | ? |
| Pause/resume with status indicator | N | N | N | N | N | ? |
| Exclude ephemeral, extension-origin and non-TUI input | P (reads saved sessions only) | N (caches ephemeral) | P (extension excluded) | P (interactive only) | P (`getSessionFile` used) | ? |
| Repeated submissions kept as separate records | N (dedup) | N (dedup) | N (move to newest) | N (dedup) | ? | ? |
| Independent of Pi session files (own store) | N | P (cache plus sessions) | Y | Y | P (index bootstrapped from sessions) | N / N |
| Never exposed to the LLM | Y (no `registerTool` in src) | Y | Y | Y | Y | ? |

The two closest fits are `@light4/pi-prompt-history` (matching UX: Ctrl+R plus `/history`, Tab scope toggle, restore without submit) and `@sagmans/pi-history` (matching storage: own private store with 0700/0600 permissions, extension-origin input excluded, confirmed clear). Neither offers per-entry delete, scoped clear, or pause, and both use fuzzy matching and deduplication.

## Open questions

1. Does the owner still value the "exemplary, understandable codebase" goal on its own? If not, adopting or contributing to `@light4/pi-prompt-history` or `@sagmans/pi-history` covers most user stories. Delete, pause and scoped clear could be proposed upstream to those projects.
2. Are per-entry delete, pause and literal matching must-haves in practice? This research did not test any candidate in a real TUI. All findings come from READMEs and static grep of the published source.
3. Would `vedang/pi-prompt-history` or `ravshansbox/pi-prompt-history` meet the need if published to npm? Their deletion, pause and exclusion behavior is undocumented and was not inspected in source.
4. The `/resume` and `/tree` search semantics (what text is matched) were taken from the docs only.

## Sources and queries run (2026-09-29)

Local sources (paths relative to `node_modules/@earendil-works/pi-coding-agent/`): `package.json` (0.85.1), `CHANGELOG.md`, `README.md`, `docs/keybindings.md`, `docs/sessions.md`, `docs/packages.md`, `dist/modes/interactive/interactive-mode.js`, `node_modules/@earendil-works/pi-tui/dist/components/editor.js`. The PRD and spike issue were read with `gh issue view 1|2 -R khiet/pi-prompt-history`. The spike results are in [compatibility-spike.md](compatibility-spike.md).

Registry and upstream:

- `npm view @earendil-works/pi-coding-agent dist-tags` returned `latest: 0.87.1`.
- Upstream changelog: `gh api repos/earendil-works/pi/contents/packages/coding-agent/CHANGELOG.md`. It has no prompt-history feature after 0.85.1.
- Each candidate was checked with `npm view <pkg> version time.modified license repository.url`. Tarballs were fetched with `npm pack` and grepped for `getSessionFile`, `source ===`, `registerTool`, `SessionManager.list`, file modes, shortcuts and commands.

npm searches. Each is marked relevant hits or none:

- `pi-coding-agent history`: relevant hits.
- `pi prompt history`: relevant hits.
- `keywords:pi-package prompt history`: relevant hits.
- `keywords:pi-package history`: relevant hits.
- `keywords:pi-extension history`: relevant hits.
- `pi history search`: relevant hits.
- `pi ctrl+r`: relevant hits (surfaced `@signalridge/pi-input-history`).
- `pi reverse search prompts`: only `pi-input-history`.
- `pi-package history`: nothing new.
- `pi-extension history`, `pi-mono history`, `pi prompt recall`, `pi-package prompt`, `pi-prompt-history`, `pi input history`, `pi prompts recall`: no additional relevant packages beyond the table.

Gallery: `https://pi.dev/packages?q=history` and `?search=prompt+history` returned the same server-rendered default list of 57 packages, with no history package on it. Search appears to run client-side. `https://pi.dev/api/packages` returned HTTP 501. The gallery lists the same `pi-package`-keyword npm set searched above, so npm keyword search was used as its proxy.

GitHub:

- `gh search repos` for `pi prompt history` found the GitHub-only repos in the table and the owner's own repo.
- `gh search repos` for `pi readline search` found `mrshu/pi-readline-search`.
- `gh search repos` for `pi-coding-agent history` and `pi extension history search`: nothing.
- `gh search code "registerShortcut ctrl+r history"`: nothing.
- The upstream README has no awesome-list link. A third-party `shaftoe/awesome-pi-coding-agent` exists but is not linked from the official repo, so it was not used.

Upstream issues and PRs in `earendil-works/pi`. No open issue or PR asks for built-in persistent or searchable prompt history.

- `prompt history`: the only open hits are #9656 (wheel scroll bug) and #9411 (unrelated). Closed hits are bug fixes: #8672, #8798, #7997, #9283, #3667, #5494.
- `input history`: #6066 (closed bug) and #5466, "Expose addToHistory on ExtensionUIContext", closed COMPLETED 2026-06-07. It was an auto-close for a new contributor, not a merged feature.
- `persistent history`, `cross-session history`, `reverse search`, `history across sessions`: no results.
- `ctrl+r`: only keybinding bugs.
- PRs for `prompt history`: #121 (the original feature), #5789 and #3669 (fixes).
