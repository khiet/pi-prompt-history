"""Release checks for the real extension in the real Pi TUI (POSIX PTY,
TERM=xterm-256color). spike/scripted.ts is the model: Pi's own agent loop
streams, queues, compacts, and writes sessions, but replies are synthetic and
nothing leaves the machine. Run on every supported Pi release.

A PTY shows what Pi draws and accepts, not how it looks: visual quality, a
physical IME's candidate window, and other terminal emulators stay unverified.
"""

import shutil
import sys
import tempfile
from pathlib import Path

from harness import (
    ALT_ENTER,
    CTRL_D,
    CTRL_R,
    ENTER,
    ESC,
    PI_ROOT,
    REPO,
    TAB,
    UP,
    Pi,
    pi_version,
    record,
)

SCRIPTED = REPO / "spike/scripted.ts"
MODEL = ["--model", "scripted/synthetic"]
PICKER = "Prompt history: this directory"
VERSION = tuple(int(part) for part in pi_version().split("."))

failed = []


def scenario(name):
    def run(check):
        root = Path(tempfile.mkdtemp(prefix="pph-accept-")).resolve()
        pis = []

        def start(**kwargs):
            pi = Pi(
                root,
                extensions=[SCRIPTED, *kwargs.pop("extensions", ())],
                args=MODEL,
                **kwargs,
            )
            pis.append(pi)
            return pi

        try:
            check(root, start)
            print(f"PASS {name}")
        # Any error fails only this scenario, so the rest still run.
        except Exception as error:
            failed.append(name)
            screen = pis[-1].text()[-2500:] if pis else ""
            print(f"FAIL {name}: {error}\n--- screen ---\n{screen}")
        finally:
            for pi in pis:
                try:
                    pi.close()
                except Exception as error:
                    print(f"WARN {name}: close failed: {error!r}")
            shutil.rmtree(root, ignore_errors=True)
        return check

    return run


def inputs(pi):
    return [
        (e["text"], e["source"], e["streamingBehavior"]) for e in pi.events("input")
    ]


@scenario("idle, steering, and follow-up input are each recorded once")
def streaming(root, start):
    pi = start()
    pi.type("idle-one")
    pi.wait("turn", 1)
    pi.type("steer-one")
    pi.type("follow-one", submit=ALT_ENTER)
    for turn in (1, 2, 3, 4):
        pi.open_gate(f"turn-{turn}")
    turns = pi.wait("turn", 3)
    pi.drain(1)
    assert inputs(pi) == [
        ("idle-one", "interactive", None),
        ("steer-one", "interactive", "steer"),
        ("follow-one", "interactive", "followUp"),
    ], inputs(pi)
    # Delivery of queued prompts is not another input, so nothing repeats.
    assert turns[-1]["users"] == ["idle-one", "steer-one", "follow-one"], turns
    assert pi.recorded() == ["idle-one", "steer-one", "follow-one"], pi.recorded()


@scenario("prompts queued during compaction")
def compaction(root, start):
    pi = start(settings={"compaction": {"keepRecentTokens": 1}})
    pi.open_gate("turn-1")
    pi.open_gate("turn-2")
    pi.type("seed-one")
    pi.wait("turn", 1)
    pi.type("seed-two")
    pi.wait("turn", 2)
    pi.drain(1)
    pi.type("/compact")
    pi.wait("compact")
    pi.type("queued-a")
    pi.type("queued-b")
    pi.type("queued-c", submit=ALT_ENTER)
    for turn in range(3, 9):
        pi.open_gate(f"turn-{turn}")
    pi.open_gate("compact")
    turns = pi.wait("turn", 4)
    pi.drain(1)
    delivered = [u for u in turns[-1]["users"] if u.startswith("queued")]
    assert delivered == ["queued-a", "queued-b", "queued-c"], turns
    # 0.86.0 routed the queue's steer/followUp flush through input handlers.
    queued = (
        ["queued-a", "queued-b", "queued-c"] if VERSION >= (0, 86, 0) else ["queued-a"]
    )
    assert pi.recorded() == ["seed-one", "seed-two", *queued], pi.recorded()


@scenario("native history delta against a model-written session")
def native(root, start):
    first = start()
    first.open_gate("turn-1")
    first.type("native-alpha")
    first.wait("turn", 1)
    first.drain(1)
    first.close()
    sessions = [p for p in (root / "agent/sessions").rglob("*.jsonl")]
    written = "".join(p.read_text() for p in sessions)
    assert "native-alpha" in written and "scripted reply 1" in written, (
        "no session written"
    )

    second = start()
    assert second.editor() == "", "draft not empty at start"
    second.press(UP)
    assert second.editor() == "", "Up recalled a prompt in a fresh process"
    second.press(ESC, 0.3)
    assert "native-alpha" in second.press(CTRL_R), "picker missed the earlier process"
    second.press(ESC)
    count = len(second.events("start")) + 1
    second.type("/resume", wait=1.5)
    second.press(ENTER, 1.5)
    second.wait("start", count)
    second.press(UP)
    assert second.editor() == "native-alpha", "Up did not recall after /resume"
    second.press("\x03")  # Ctrl+C, Pi's app.clear, empties the draft.
    count = len(second.events("start")) + 1
    second.type("/new", wait=1.5)
    second.wait("start", count)
    second.press(UP)
    assert second.editor() == "native-alpha", "Up forgot the prompt after /new"


@scenario("capture and the picker work after reload, new, resume, and fork")
def transitions(root, start):
    pi = start()
    for turn in range(1, 10):
        pi.open_gate(f"turn-{turn}")
    pi.type("first-session")
    pi.wait("turn", 1)
    expected = ["first-session"]
    for reason, command, picks in [
        ("reload", "/reload", []),
        ("new", "/new", []),
        # The query picks the first session over the current one.
        ("resume", "/resume", ["first-session", ENTER]),
        ("fork", "/fork", [ENTER]),
    ]:
        count = len(pi.events("start")) + 1
        pi.type(command, wait=1.5)
        for keys in picks:
            pi.press(keys, 1.5)
        assert pi.wait("start", count)[-1]["reason"] == reason, reason
        # Forking puts the chosen prompt back in the editor. Ctrl+C clears it;
        # on an empty draft it would start Pi's double-press exit instead.
        if pi.editor():
            pi.press("\x03")
        turns = len(pi.events("turn")) + 1
        pi.type(f"after-{reason}")
        pi.wait("turn", turns)
        expected.append(f"after-{reason}")
        assert pi.recorded() == expected, f"{reason}: {pi.recorded()}"
        assert f"after-{reason}" in pi.press(CTRL_R), f"no picker after {reason}"
        pi.press(ESC)


@scenario("restore replaces the draft with normalized text and never submits")
def restore(root, start):
    stored = "alpha\tbeta\r\ngamma\rdelta"
    pi = start(history=[record(stored, root / "work", 1)])
    before = pi.history.read_bytes()
    pi.press("draft text")
    pi.press(CTRL_R)
    pi.press(ESC)
    assert pi.editor() == "draft text", "cancel changed the draft"
    pi.press(CTRL_R)
    pi.press(ENTER)
    assert pi.editor() == "alpha    beta\ngamma\ndelta", repr(pi.editor())
    assert pi.events("input") == [], "restore submitted the prompt"
    assert pi.history.read_bytes() == before, "restore changed the stored record"


@scenario("an image in the draft asks before it is replaced")
def image(root, start):
    pi = start(history=[record("recalled prompt", root / "work", 1)])
    draft = "look at /tmp/shot.png please"
    pi.press(draft)
    pi.press(CTRL_R)
    assert "Replace draft?" in pi.press(ENTER), "no image warning"
    pi.press(ESC)
    assert pi.editor() == draft, "declining changed the draft"
    pi.press(CTRL_R)
    assert "Replace draft?" in pi.press(ENTER), "no image warning on retry"
    pi.press(ENTER)
    assert pi.editor() == "recalled prompt", repr(pi.editor())


@scenario("scope toggle and ctrl+d deletion with its confirmation")
def delete(root, start):
    here, there = root / "work", root / "elsewhere"
    pi = start(
        history=[
            record("other-dir prompt", there, 1, "b"),
            record("this-dir prompt", here, 2, "a"),
        ]
    )
    shown = pi.press(CTRL_R)
    assert "this-dir prompt" in shown and "other-dir prompt" not in shown, shown
    assert "other-dir prompt" in pi.press(TAB), (
        "all directories missed the other directory"
    )
    pi.press(TAB)
    assert "Delete this prompt?" in pi.press(CTRL_D), "no delete confirmation"
    pi.press("n")
    assert pi.recorded() == ["other-dir prompt", "this-dir prompt"], (
        "declined delete removed"
    )
    pi.press(CTRL_D)
    after = pi.press("y", 1.5)
    assert pi.recorded() == ["other-dir prompt"], pi.recorded()
    assert "No prompts recorded in this directory yet." in after, after
    pi.press(ESC)


@scenario("/history clear cwd and all through Pi's confirmation dialog")
def clear(root, start):
    here, there = root / "work", root / "elsewhere"
    pi = start(
        history=[
            record("keep elsewhere", there, 1),
            record("here one", here, 2),
            record("here two", here, 3),
        ]
    )
    shown = pi.type("/history clear cwd", wait=1.5)
    assert "Delete 2 prompts" in shown, shown
    pi.press(ESC, 1)
    assert len(pi.recorded()) == 3, "cancel cleared"
    pi.type("/history clear cwd", wait=1.5)
    assert "Cleared 2 prompts" in pi.press(ENTER, 1.5), "no cleared notice"
    assert pi.recorded() == ["keep elsewhere"], pi.recorded()
    assert "Delete 1 prompt" in pi.type("/history clear all", wait=1.5)
    pi.press(ENTER, 1.5)
    assert pi.recorded() == [], pi.recorded()
    assert "nothing to clear" in pi.type("/history clear all", wait=1.5)


@scenario("narrow terminals and resizing with the picker open")
def resize(root, start):
    long = "wide " * 60 + "\nsecond line 日本語 🙂"
    pi = start(history=[record(long, root / "work", 1)])
    pi.press(CTRL_R)
    for cols in (24, 10, 200, 60):
        pi.resize(cols)
        assert pi.alive(), f"Pi exited at {cols} columns"
    pi.press(ENTER)
    assert pi.editor() == long, "restore after resizing differs"


@scenario("Unicode typed through the PTY is recorded and found")
def unicode(root, start):
    pi = start()
    for turn in (1, 2):
        pi.open_gate(f"turn-{turn}")
    text = "日本語の入力 café 🙂 (a+b)*"
    pi.type(text)
    pi.wait("turn", 1)
    assert pi.recorded() == [text], pi.recorded()
    # A restore proves the query matched: a non-match lists nothing to select.
    for query in ("入力 CAFÉ", "🙂 (a+b)*"):
        pi.press(CTRL_R)
        pi.press(query)
        pi.press(ENTER)
        assert pi.editor() == text, f"{query!r} restored {pi.editor()!r}"
        pi.press("\x15")  # Ctrl+U empties the draft for the next query.
    pi.press(CTRL_R)
    assert "No prompts match." in pi.press("ss"), "a non-matching query listed prompts"
    pi.press(ESC)


@scenario("light theme")
def theme(root, start):
    pi = start(
        settings={"theme": "light"}, history=[record("themed prompt", root / "work", 1)]
    )
    assert PICKER in pi.press(CTRL_R), "picker did not open"
    pi.press(ENTER)
    assert pi.editor() == "themed prompt", repr(pi.editor())


@scenario("coexists with Pi's modal-editor example extension")
def modal(root, start):
    pi = start(
        extensions=[PI_ROOT / "examples/extensions/modal-editor.ts"],
        history=[record("modal prompt", root / "work", 1)],
    )
    assert PICKER in pi.type("/history"), "/history did not open over the modal editor"
    pi.press(ESC)
    assert PICKER in pi.press(CTRL_R), "ctrl+r did not open over the modal editor"
    pi.press(ENTER)
    assert pi.editor() == "modal prompt", repr(pi.editor())


@scenario("overlapping openings show one picker")
def overlap(root, start):
    pi = start(history=[record("only prompt", root / "work", 1)])
    pi.press(CTRL_R + CTRL_R, 1.5)
    pi.press(ESC)
    # With no second picker left open, typing reaches the editor.
    pi.press("x")
    assert pi.editor() == "x", repr(pi.editor())


@scenario("a picker open across session replacement restores nothing")
def stale(root, start):
    pi = start(history=[record("stale prompt", root / "work", 1)])
    pi.type("/scripted-new-later")
    assert PICKER in pi.press(CTRL_R), "picker did not open"
    pi.wait("start", 2)
    pi.press(ENTER, 1)
    assert pi.alive(), "Pi exited"
    assert pi.editor() == "", "a replaced session restored into the new one"
    assert pi.events("new-failed") == [], pi.events("new-failed")
    assert PICKER in pi.press(CTRL_R), "the new session cannot open the picker"
    pi.press(ESC)


print(f"Pi {pi_version()}")
sys.exit(1 if failed else 0)
