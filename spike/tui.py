"""Drive the real Pi CLI in an isolated POSIX PTY; no clipboard or model access.
Only synthetic data is logged. Raw terminal output stays in the temporary directory.
"""

import base64
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time

REPO = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")
CLI = REPO / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
EXACT = "  café 日本語 👋\nsecond line  "


class Pi:
    def __init__(
        self,
        root,
        *,
        ephemeral=False,
        shortcut="ctrl+r",
        resume=False,
        other_editor=False,
        reserved_conflict=False,
    ):
        self.root = root
        root.mkdir(parents=True)
        self.log = root / "events.jsonl"
        self.ansi = open(root / "terminal.log", "wb")
        self.agent = root / "agent"
        extensions = self.agent / "extensions"
        extensions.mkdir(parents=True)
        shutil.copy(REPO / "spike/probe.ts", extensions / "probe.ts")
        if reserved_conflict:
            # Synthetic configuration only, never the user's agent directory.
            (self.agent / "keybindings.json").write_text(
                json.dumps({"app.clear": "ctrl+r"})
            )
        if other_editor:
            package = REPO / "node_modules/@earendil-works/pi-coding-agent"
            shutil.copy(
                package / "examples/extensions/modal-editor.ts",
                extensions / "modal-editor.ts",
            )
        (root / "skill").mkdir()
        (root / "skill/SKILL.md").write_text(
            "---\nname: probe-skill\ndescription: Synthetic test\n---\nExpanded skill\n"
        )
        (root / "probe-template.md").write_text("Expanded template $1\n")
        self.session = self.agent / "sessions/synthetic-project/seed.jsonl"
        self.session.parent.mkdir(parents=True)
        stamp = "2026-09-09T00:00:00.000Z"
        entries = [
            {
                "type": "session",
                "version": 3,
                "id": "01234567-89ab-4cde-8fab-0123456789ab",
                "timestamp": stamp,
                "cwd": str(root),
            },
            {
                "type": "message",
                "id": "abcdef12",
                "parentId": None,
                "timestamp": stamp,
                "message": {
                    "role": "user",
                    "content": "persisted synthetic prompt",
                    "timestamp": 1788912000000,
                },
            },
        ]
        self.session.write_text("".join(json.dumps(e) + "\n" for e in entries))
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(root),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "PI_CODING_AGENT_DIR": str(self.agent),
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
            "SPIKE_LOG": str(self.log),
            "SPIKE_SESSION": str(self.session),
            "SPIKE_SHORTCUT": shortcut,
        }
        args = [
            NODE,
            str(CLI),
            "--offline",
            "--no-context-files",
            "--no-skills",
            "--skill",
            str(root / "skill/SKILL.md"),
            "--no-prompt-templates",
            "--prompt-template",
            str(root / "probe-template.md"),
            "--no-themes",
            "--no-tools",
            "--no-approve",
        ]
        if ephemeral:
            args.append("--no-session")
        if resume:
            args += ["--session", str(self.session)]
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 100, 0, 0))
        self.process = subprocess.Popen(
            args,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=root,
            env=env,
            start_new_session=True,
        )
        os.close(slave)
        try:
            self.wait("start")
            self.drain(0.4)
        except BaseException:
            if self.process.poll() is None:
                os.killpg(self.process.pid, signal.SIGTERM)
            self.process.wait(timeout=5)
            os.close(self.fd)
            self.ansi.close()
            raise

    def events(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def drain(self, duration=0.15):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], max(0, deadline - time.monotonic()))[0]:
                try:
                    data = os.read(self.fd, 65536)
                except OSError:
                    break
                if not data:
                    break
                self.ansi.write(data)
                self.ansi.flush()

    def send(self, text):
        os.write(self.fd, text.encode())
        self.drain()

    def wait(self, kind, after=0):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            found = [e for e in self.events()[after:] if e["kind"] == kind]
            if found:
                return found[-1]
            if self.process.poll() is not None:
                raise AssertionError(
                    f"Pi exited {self.process.returncode}; log: {self.root / 'terminal.log'}"
                )
            self.drain(0.1)
        raise AssertionError(
            f"Timed out waiting for {kind}; log: {self.root / 'terminal.log'}"
        )

    def command(self, text, expected="command"):
        count = len(self.events())
        self.send(
            "\x1bk"
        )  # Clear draft through the probe shortcut, without submission.
        self.send(text + "\r")
        return self.wait(expected, count)

    def draft(self):
        count = len(self.events())
        self.send("\x1bj")
        return self.wait("draft", count)["text"]

    def close(self):
        try:
            if self.process.poll() is None:
                self.command("/quit", "shutdown")
                self.process.wait(timeout=5)
            assert not any(e["kind"] == "unexpected-agent-start" for e in self.events())
        finally:
            if self.process.poll() is None:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.process.wait(timeout=5)
            os.close(self.fd)
            self.ansi.close()


def run(root):
    pi = Pi(root / "main")
    try:
        assert pi.events()[0]["agentDir"] == str(pi.agent)
        assert pi.events()[0]["file"] is not None
        for text in [
            "plain",
            "/skill:probe-skill arg",
            "/probe-template arg",
            "transform-me",
        ]:
            count = len(pi.events())
            pi.send(text + "\r")
            event = pi.wait("input", count)
            assert event["text"] == (
                "transformed\ttext" if text == "transform-me" else text
            )
            assert event["source"] == "interactive" and event["mode"] == "tui"
            assert event["streamingBehavior"] is None and event["eligible"]
            assert event["paused"] is False
        count = len(pi.events())
        pi.send("\x1b[200~  outer whitespace\ninner line  \x1b[201~\r")
        assert pi.wait("input", count)["text"] == "outer whitespace\ninner line"
        count = len([e for e in pi.events() if e["kind"] == "input"])
        pi.command("/probe pause", "pause")
        assert len([e for e in pi.events() if e["kind"] == "input"]) == count
        pi.command("/probe unpause", "unpause")
        event = pi.command("/probe inject", "input")
        assert event["source"] == "extension" and not event["eligible"]
        pi.command("/probe normalize", "normalize")
        normalized = [e for e in pi.events() if e["kind"] == "normalize"][-1]
        assert (
            normalized["actual"] == "a    b\nc\nd"
            and normalized["actual"] != normalized["requested"]
        )
        pi.send("\x1bk")
        image = pi.root / "synthetic.png"
        image.write_bytes(
            base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII="
            )
        )
        draft = "draft " + str(image)
        pi.send(draft)
        for selection in ["\x1b", "\r"]:
            count = len(pi.events())
            pi.send("\x12")  # Ctrl+R with editor focused.
            opened = pi.wait("open", count)
            assert opened["before"] == draft
            fcntl.ioctl(pi.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 24, 0, 0))
            os.kill(pi.process.pid, signal.SIGWINCH)
            pi.drain()
            pi.send(selection)
            result = pi.wait("close", count)
            assert result["after"] == (draft if selection == "\x1b" else EXACT)
            assert not any(e["kind"] == "input" for e in pi.events()[count:])
        assert str(image) not in pi.draft()  # Negative reference-preservation result.
        assert not any(e["kind"] == "renamed" for e in pi.events())
        pi.command("/history", "open")
        pi.send("Second\r")
        assert pi.draft() == "second"
        # Each transition creates a fresh factory; process-global pause survives
        # all of them and the fresh instance restores the PAUSED status.
        pi.command("/probe pause", "pause")
        for command, reason in [
            ("/reload", "reload"),
            ("/probe new", "new"),
            ("/probe resume", "resume"),
            ("/probe fork", "fork"),
        ]:
            count = len(pi.events())
            pi.command(command, "start")
            start = pi.wait("start", count)
            assert start["reason"] == reason and start["paused"] is True
            shutdown = pi.wait("shutdown", count)
            assert (
                shutdown["reason"] == reason
                and shutdown["instance"] != start["instance"]
            )
            assert not any(
                e["kind"] == "input" for e in pi.events()[count:]
            )  # No backfill observations.
            count = len(pi.events())
            pi.send("\x1bk")
            pi.send(f"after-{reason}\r")
            assert pi.wait("input", count)["paused"] is True
            assert len([e for e in pi.events()[count:] if e["kind"] == "input"]) == 1
        count = len(pi.events())
        pi.command("/probe unpause", "unpause")
        pi.send("\x1bk")
        pi.send("after-unpause\r")
        assert pi.wait("input", count)["paused"] is False
        pi.command("/probe resume", "start")
        pi.send("\x1bk")
        pi.send("\x1b[A")
        assert pi.draft() == "persisted synthetic prompt"
        pi.command("/probe new", "start")
        pi.send("\x1b[A")
        assert pi.draft() == "/probe new"
        pi.send("\x1b[A")
        assert (
            pi.draft() == "persisted synthetic prompt"
        )  # Same-process history survives /new.
    finally:
        pi.close()
    events = pi.events()
    for start in [e for e in events if e["kind"] == "start"]:
        assert (
            len(
                [
                    e
                    for e in events
                    if e["kind"] == "shutdown" and e["instance"] == start["instance"]
                ]
            )
            == 1
        )
    terminal = (pi.root / "terminal.log").read_text(errors="replace")
    assert "SPIKE ACTIVE" in terminal and "SPIKE PAUSED" in terminal
    starts = [e for e in events if e["kind"] == "start"]
    assert [e["reason"] for e in starts if e["paused"]] == [
        "reload",
        "new",
        "resume",
        "fork",
    ]
    assert "Extension shortcut conflict: 'ctrl+r'" in terminal
    assert any(e["kind"] == "focus" and e["value"] for e in events)
    print(
        "TUI PASS: idle hook fields/raw slash/transform/source; Ctrl+R and /history; cancel/select/24-column resize; negative image-path and CR/tab restoration; fresh factories and shutdown for reload/new/resume/fork; process-global pause survives them until unpause; native history scope."
    )
    for name, options in [
        ("restart", {"resume": True}),
        ("fresh", {}),
        ("ephemeral", {"ephemeral": True}),
        ("alternative", {"shortcut": "alt+h", "other_editor": True}),
        ("reserved", {"reserved_conflict": True}),
        ("reserved-alternative", {"reserved_conflict": True, "shortcut": "alt+h"}),
    ]:
        pi = Pi(root / name, **options)
        try:
            # A new process starts unpaused: pause is never restored from disk.
            assert pi.events()[0]["paused"] is False
            if name in ["restart", "fresh"]:
                pi.send("\x1b[A")
                assert pi.draft() == (
                    "persisted synthetic prompt" if name == "restart" else ""
                )
            if name == "ephemeral":
                assert pi.events()[0]["file"] is None
                pi.send("ephemeral input\r")
                assert not pi.wait("input")["eligible"]
            if name.startswith("reserved"):
                count = len(pi.events())
                pi.send("synthetic draft")
                assert pi.draft() == "synthetic draft"
                pi.send("\x12")
                assert pi.draft() == ""  # Reserved app.clear owns Ctrl+R.
                assert not any(
                    e["kind"] in ["open", "input", "renamed"]
                    for e in pi.events()[count:]
                )
                if name == "reserved":
                    terminal = (pi.root / "terminal.log").read_text(errors="replace")
                    assert "conflicts with built-in shortcut. Skipping." in terminal
                pi.command("/history", "open")
                pi.send("\r")
                assert pi.draft() == EXACT
            if name in ["alternative", "reserved-alternative"]:
                pi.send("\x1bh")
                pi.wait("open")
                pi.send("\x1b[B\r")
                assert pi.draft() == "second"
        finally:
            pi.close()
    print(
        "TUI PASS: restarted resumed/native and fresh history; pause resets per process; ephemeral exclusion; configured Alt+H with Pi example modal editor; reserved Ctrl+R conflict warns/skips, /history and configured Alt+H still work. No provider turns."
    )


if __name__ == "__main__":
    root = Path(tempfile.mkdtemp(prefix="pi-history-tui-"))
    try:
        run(root)
    except BaseException:
        print(f"FAILED: synthetic diagnostic artifacts retained at {root}")
        raise
    else:
        shutil.rmtree(root)
