"""Drive the real Pi CLI with this extension in an isolated POSIX PTY: pause must
survive Pi's own /reload, /new, /resume, and /fork with its status shown, and
reset when the process restarts. Synthetic prompts only; spike/driver.ts
swallows them so no model is called. This gates every supported Pi release, because the pause
relies on undocumented reuse of one Node realm across runtimes.
"""

import fcntl
import json
import os
import pty
import re
import select
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import termios
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"
STATUS = "history paused"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-_]")
ROWS, COLS = 30, 120


class Pi:
    def __init__(self, root):
        self.root = root
        self.agent = root / "agent"
        self.log = root / "driver.jsonl"
        self.history = self.agent / "prompt-history/history.jsonl"
        self.seed = self.agent / "sessions/synthetic/seed.jsonl"
        if not self.seed.exists():
            self.seed.parent.mkdir(parents=True)
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
                        "content": "seeded session prompt",
                        "timestamp": 1788912000000,
                    },
                },
            ]
            self.seed.write_text("".join(json.dumps(e) + "\n" for e in entries))
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(root),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "PI_CODING_AGENT_DIR": str(self.agent),
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
            "DRIVER_LOG": str(self.log),
        }
        args = [
            shutil.which("node"),
            str(CLI),
            "--offline",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-themes",
            "--no-tools",
            "--no-approve",
            # Order matters: the extension must see input before the driver
            # swallows it.
            "-e",
            str(REPO / "src/index.ts"),
            "-e",
            str(REPO / "spike/driver.ts"),
        ]
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))
        self.proc = subprocess.Popen(
            args,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=root,
            env=env,
            start_new_session=True,
        )
        os.close(slave)
        self.out = b""
        self.wait("start")

    def resize(self, cols):
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, cols, 0, 0))

    def events(self, kind):
        if not self.log.exists():
            return []
        lines = self.log.read_text().splitlines()
        return [e for e in map(json.loads, lines) if e["kind"] == kind]

    def drain(self, duration=0.3):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.out += os.read(self.fd, 65536)
                except OSError:
                    break

    def wait(self, kind, count=1):
        deadline = time.monotonic() + 15
        while len(self.events(kind)) < count:
            assert self.proc.poll() is None, f"Pi exited {self.proc.returncode}"
            assert time.monotonic() < deadline, f"timed out waiting for {kind}"
            self.drain(0.1)
        self.drain()

    def type(self, text):
        # Enter goes separately, so Pi never takes text and Enter for one paste.
        os.write(self.fd, text.encode())
        self.drain()
        os.write(self.fd, b"\r")

    def submit(self, text, kind):
        count = len(self.events(kind)) + 1
        self.type(text)
        self.wait(kind, count)

    def prompt(self, text):
        self.submit(text, "input")

    def command(self, text):
        self.type(text)
        self.drain(1)

    def transition(self, command, *picks):
        """Runs a session command, answers its selector, and waits for the start."""
        count = len(self.events("start")) + 1
        self.type(command)
        self.drain(1)
        for keys in picks:
            os.write(self.fd, keys.encode())
            self.drain(1)
        self.wait("start", count)

    def files(self):
        """Every file under the agent directory, with its contents."""
        return {
            path: path.read_bytes() for path in self.agent.rglob("*") if path.is_file()
        }

    def screen(self):
        """The whole screen, redrawn by width changes, without ANSI styling."""
        mark = len(self.out)
        for cols in (COLS - 20, COLS):
            self.resize(cols)
            os.kill(self.proc.pid, signal.SIGWINCH)
            self.drain(1)
        return ANSI.sub(b"", self.out[mark:]).decode("utf8", "replace")

    def recorded(self):
        if not self.history.exists():
            return []
        return [json.loads(line)["text"] for line in self.history.read_text().splitlines()]

    def close(self):
        os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc.wait(timeout=5)
        os.close(self.fd)


def run(root):
    pi = Pi(root)
    try:
        pi.prompt("before-pause")
        assert STATUS not in pi.screen(), "status shown before pause"
        before = pi.files()
        pi.command("/history pause")
        assert pi.files() == before, "pausing wrote to the agent directory"
        assert STATUS in pi.screen(), "no status after pause"
        pi.prompt("while-paused")
        for reason, command, picks in [
            ("reload", "/reload", []),
            ("new", "/new", []),
            # Tab lists every folder's sessions; the query picks the seed.
            ("resume", "/resume", ["\t", "seeded", "\r"]),
            ("fork", "/fork", ["\r"]),
        ]:
            pi.transition(command, *picks)
            assert pi.events("start")[-1]["reason"] == reason, reason
            assert STATUS in pi.screen(), f"status lost after {reason}"
            pi.prompt(f"after-{reason}")
        assert pi.recorded() == ["before-pause"], pi.recorded()
        pi.command("/history resume")
        assert STATUS not in pi.screen(), "status kept after resume"
        pi.prompt("after-resume")
        assert pi.recorded() == ["before-pause", "after-resume"], pi.recorded()
        pi.command("/history pause")
        assert STATUS in pi.screen(), "no status after second pause"
    finally:
        pi.close()

    # The store holds only history; a new process records again, with no status.
    files = sorted(p.name for p in (root / "agent/prompt-history").iterdir())
    assert files == ["history.jsonl"], files
    pi = Pi(root)
    try:
        assert STATUS not in pi.screen(), "status shown after restart"
        pi.prompt("after-restart")
        assert pi.recorded()[-1] == "after-restart", pi.recorded()
    finally:
        pi.close()


root = Path(tempfile.mkdtemp(prefix="pph-pause-")).resolve()
try:
    run(root)
    print("PASS pause survives reload/new/resume/fork and resets on restart")
except AssertionError as error:
    print(f"FAIL pause: {error}")
    sys.exit(1)
finally:
    shutil.rmtree(root, ignore_errors=True)
