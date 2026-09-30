# Behavior reference

[README](../README.md) | [Development and verification](verification.md)

Detailed behavior and limitations for pi-prompt-history. [The PRD](https://github.com/khiet/pi-prompt-history/issues/1) is the full contract.

## Install

Requires a [tested Pi and Node](verification.md#tested-compatibility). Clone the repository, then add the checkout to Pi:

```sh
git clone https://github.com/khiet/pi-prompt-history.git
pi install /absolute/path/to/pi-prompt-history
```

`pi install` records the path in `<agent dir>/settings.json`, and Pi loads the extension from the checkout on its next start, or after `/reload`. No `npm install` is needed to run it: the extension uses only Node built-ins and Pi's own packages, has no runtime dependencies, and runs no install scripts. To try it for one run instead, use `pi -e /absolute/path/to/pi-prompt-history`. To remove it, run `pi remove /absolute/path/to/pi-prompt-history`; your recorded history stays in place until you delete it (see [Privacy](#privacy-what-loading-this-extension-changes)).

`pi install git:github.com/khiet/pi-prompt-history` should also work, since Pi clones the repository and runs `npm install --omit=dev`, but that route has not been tested.

## Usage

Press Ctrl+R (or your [configured shortcut](#shortcut)) or type `/history` in Pi's interactive TUI. Both open the same picker. It opens scoped to the current directory (the exact cwd string, not the Git root), newest first. When the draft is a single non-empty line, the picker opens with it as the query, already filtered, and you edit it like any typed query; the draft itself is untouched. An empty, blank, or multiline draft opens with an empty query, listing recent prompts. The last query and scope never carry over.

- Typing splits the query on whitespace into terms and lists every recorded prompt that contains all of them, in any order: `migrate test` finds both `test the migrate script` and `migrate the test db`. Each term is a literal substring match after lowercasing both sides with JavaScript's `toLowerCase()`. Punctuation has no special meaning, and a query of only whitespace matches everything. There is no fuzzy scoring or relevance ranking; matches stay newest first. Case folding is simple and locale-independent: `CAFÉ` matches `café`, but `ß` does not match `ss`, and a composed `é` does not match `e` plus a combining accent.
- A prompt text is listed once per scope, however many times it was submitted, and shows its newest submission: that time and, in all directories, that directory. Only byte-identical texts are merged; no trimming, case folding, or normalization. Rows are ordered by that newest submission.
- At most the newest 100 distinct prompts are listed, and the picker says when there are more. Type more of the query to reach older prompts; there is no paging.
- Tab switches between this directory and all directories, keeping the query. In all directories, each prompt shows the directory it was typed in.
- Up/Down selects. Below the list, a preview shows the selected prompt's local time and its first lines.
- Enter puts the selected prompt in the editor without sending it. It **replaces the whole draft**. If the draft contains an image (Pi keeps a pasted or dropped image as a `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, or `.bmp` file path in the text), you are asked to confirm first, because the image is replaced too. The check looks only for such paths in the draft text, so it also asks when you merely typed a name like `logo.png`, and it cannot see an image Pi holds any other way. Images from the recalled prompt were never stored and are not restored.
- Ctrl+D asks before deleting every copy of the selected prompt in the current scope; see [Delete and clear](#delete-and-clear).
- Escape closes the picker and leaves the draft, including any image, unchanged.

Restored text is the stored text as Pi's editor normalizes it: tabs become spaces and CR/CRLF become LF. The stored record itself is never changed. The list shows each prompt on one line and the preview up to eight of its lines, both with terminal control characters drawn as visible symbols; the restored text keeps them.

The picker distinguishes no prompts recorded in the scope from no prompts matching the query. Before each search the extension checks whether the history file changed (size, modification time, inode, or status change) and rereads it if so, so prompts recorded by other Pi processes appear on the next keystroke. If it cannot be read, the picker shows it as unavailable with the file and error code instead of any earlier results, and leaves the file untouched. The shortcut and `/history` do nothing outside the TUI, and only one picker opens at a time.

## Delete and clear

In the picker, Ctrl+D asks `Delete this prompt?`, or `Delete this prompt (3 copies)?` when the row stands for more than one submission. `y` deletes every record with that exact text in the picker's scope: in this directory, only this directory's copies go and other directories keep theirs; in all directories, every copy goes. Otherwise an older copy would reappear straight after the deletion. Any other key, Escape included, keeps them and leaves the picker open. There is no undo. Ctrl+D pressed while a search is still loading does nothing. After a deletion the picker searches again with the same query and scope, selects the result that took the deleted one's place (or the new last result when the last one was deleted), and refills the newest-100 list, so a prompt that was just past the cap appears. When nothing is left it says `No prompts match.` or `No prompts recorded in this directory yet.`

`/history clear cwd` clears the current directory's prompts, matched by the exact cwd string like the picker's scope, so other directories and subdirectories keep theirs. `/history clear all` clears every prompt this extension recorded. Bare `/history clear` or any other scope shows usage and clears nothing. Both ask for confirmation, naming the scope and how many prompts it holds; cancelling changes nothing, and an empty scope says there is nothing to clear without asking. Both work only in the TUI. Any other argument to `/history` also shows usage and does nothing.

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

`<agent dir>` is Pi's `getAgentDir()`: `~/.pi/agent` by default, or `PI_CODING_AGENT_DIR` when set. Anything you type, including secrets pasted into a prompt, is kept there until you remove it. Remove entries with [Ctrl+D in the picker or `/history clear`](#delete-and-clear), or by deleting that file yourself. None of these touch Pi's sessions or guarantee erasure from backups or disk.

- The directory is created with mode `0700` and the file with `0600` where the platform supports it. Existing permissions are not changed.
- History is not automatically exposed to the model: no tool, no context injection. A recalled prompt is sent only when you submit it.
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
- Each submission is its own record; repeats are kept, and the picker lists them as one row.
- On Pi 0.86.0 and later, other extensions that call the SDK's `steer()`/`followUp()` without a `source` look like typed input and are recorded. On 0.85.1, prompts queued during compaction are missed except the first.

Session files are never read to backfill history.

## Compared with Pi's built-in history

Pi already keeps your prompts: in its session files, which `/resume` and `/tree` search, and in the editor's Up/Down history. Checked in the real TUI on both [tested releases](verification.md#tested-compatibility), with sessions written by Pi's own agent loop driving a scripted model (`spike/scripted.ts`) rather than a real provider:

- In a new Pi process with a new session, Up recalls nothing. After `/resume`, Up recalls that session's prompts. After `/new`, Up still recalls the prompts typed earlier in the same process.
- This extension's picker finds a prompt typed in an earlier Pi process straight away, without resuming its session.

What the extension adds is one prompt-only index shared by every Pi process and session, searched by substring, scoped to the current directory or all directories, with per-prompt deletion and clearing. It does not replace Pi's session storage or search it, and removing a prompt here leaves it in Pi's session files.

## Record format

One JSON object per line, appended with one write per record:

```json
{"v":1,"id":"<uuid>","text":"explain this diff","cwd":"/work/project","session":"<session id>","ts":1790000000000}
```

`ts` is epoch milliseconds and `session` is Pi's session ID. Readers ignore unknown fields and skip lines they cannot parse, such as a line torn by an interrupted write; the first search that meets them warns once per session with their count, never their content. Reading never rewrites the file.

## Limits

These are fixed, not configurable:

- **Retention:** the newest 10,000 records, by the search order (newest `ts` first, then `id`). Appends stay cheap: each Pi process counts the records it last loaded plus its own appends, and only when an append takes that count past 11,000 does it rewrite the file down to the newest 10,000. Other processes' appends join the count when this process next searches, so with several writers the file can briefly grow past 11,000. Unreadable lines are dropped by that rewrite.
- **Results:** at most the newest 100 distinct prompt texts per search, over every retained record.
- **Prompt size:** 32,768 UTF-8 bytes; larger prompts are skipped.

Compaction, deletion, and clearing all rewrite the file the same way, and every rewrite keeps at most the newest 10,000 records and drops unreadable lines. A rewrite writes a private (`0600`) temporary file in the same directory and renames it over the history file. If preparing it fails, the temporary file is removed, the original stays as it was, and a warning names the file, its directory, and the error code; for compaction, the next append past the threshold tries again. An unreadable history file is never rewritten. A deletion of a prompt that is already gone rewrites nothing.

## Several Pi processes

Every Pi process with this extension appends to the same file. Each record is one write in append mode, which keeps lines whole on a local filesystem; network filesystems are not supported and may interleave or lose lines. Repeated prompts from different processes are all kept.

There is no locking. The one known loss is a rewrite (compaction, deletion, or clearing): another process's append that lands between the rewrite reading the file and renaming over it, or that opened the old file before the rename, is lost. The window is short and is accepted for the MVP; rewrites are not lossless under concurrency.

## Failures

Capture never blocks or changes prompt processing. If a write fails (for example, the file is not writable), the prompt continues normally and a warning names the file and error code, at most once a minute per kind of problem. An existing history file that cannot be read or written is left alone: it is never erased or replaced. If the file is missing, including one deleted while Pi runs, the next prompt starts a new one.
