"""Runs the real Pi CLI in an isolated POSIX PTY for the release checks in
spike/acceptance.py. Everything lives under one temporary root: HOME, the agent
directory, gates, and logs. The user's own settings, credentials, keybindings,
and extensions are never read. No network: spike/scripted.ts is the only model.
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
import termios
import time
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PI_ROOT = REPO / "node_modules/@earendil-works/pi-coding-agent"
CLI = PI_ROOT / "dist/cli.js"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-_]")

ESC, ENTER, TAB, UP, DOWN = "\x1b", "\r", "\t", "\x1b[A", "\x1b[B"
CTRL_R, CTRL_D, CTRL_U, F9 = "\x12", "\x04", "\x15", "\x1b[20~"
ALT_ENTER = "\x1b\r"


def pi_version():
    return json.loads((PI_ROOT / "package.json").read_text())["version"]


def record(text, cwd, ts, id=None):
    return {
        "v": 1,
        "id": id or f"id-{ts}",
        "text": text,
        "cwd": str(cwd),
        "session": "s",
        "ts": ts,
    }


class Pi:
    def __init__(
        self,
        root,
        cwd=None,
        extensions=(),
        args=(),
        keybindings=None,
        settings=None,
        rows=30,
        cols=120,
        history=None,
    ):
        self.root = root
        self.cwd = cwd or root / "work"
        self.cwd.mkdir(parents=True, exist_ok=True)
        self.agent = root / "agent"
        self.gates = root / "gates"
        self.gates.mkdir(exist_ok=True)
        self.log = root / "scripted.jsonl"
        self.history = self.agent / "prompt-history/history.jsonl"
        self.rows, self.cols = rows, cols
        if history is not None:
            self.history.parent.mkdir(parents=True, exist_ok=True)
            self.history.write_text("".join(json.dumps(r) + "\n" for r in history))
        if keybindings is not None:
            self.agent.mkdir(parents=True, exist_ok=True)
            (self.agent / "keybindings.json").write_text(json.dumps(keybindings))
        if settings is not None:
            self.agent.mkdir(parents=True, exist_ok=True)
            (self.agent / "settings.json").write_text(json.dumps(settings))
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(root),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "PI_CODING_AGENT_DIR": str(self.agent),
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
            "SCRIPTED_LOG": str(self.log),
            "SCRIPTED_GATES": str(self.gates),
        }
        argv = [
            shutil.which("node"),
            str(CLI),
            "--offline",
            "--no-context-files",
            "--no-skills",
            "--no-prompt-templates",
            "--no-tools",
            "--no-approve",
            # The real extension loads first, so it sees input before any
            # companion reacts to it.
            "-e",
            str(REPO / "src/index.ts"),
        ]
        for extension in extensions:
            argv += ["-e", str(extension)]
        argv += list(args)
        self.fd, slave = pty.openpty()
        self._winsize(slave, cols)
        self.proc = subprocess.Popen(
            argv,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=self.cwd,
            env=env,
            start_new_session=True,
        )
        os.close(slave)
        self.out = b""
        self.drain(4)

    def _winsize(self, fd, cols):
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", self.rows, cols, 0, 0))

    def resize(self, cols):
        self._winsize(self.fd, cols)
        os.kill(self.proc.pid, signal.SIGWINCH)
        self.drain(1)

    def drain(self, duration=0.4):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.out += os.read(self.fd, 65536)
                except OSError:
                    break

    def alive(self):
        return self.proc.poll() is None

    def text(self, since=0):
        return ANSI.sub(b"", self.out[since:]).decode("utf8", "replace")

    def press(self, data, wait=0.8):
        """Sends keys and returns the text Pi drew in response."""
        mark = len(self.out)
        os.write(self.fd, data.encode())
        self.drain(wait)
        return self.text(mark)

    def type(self, text, submit=ENTER, wait=0.8):
        # Keys and Enter go separately, so Pi never reads them as one paste.
        self.press(text, 0.3)
        return self.press(submit, wait)

    def events(self, kind):
        if not self.log.exists():
            return []
        lines = self.log.read_text().splitlines()
        return [e for e in map(json.loads, lines) if e["kind"] == kind]

    def wait(self, kind, count=1, timeout=15):
        deadline = time.monotonic() + timeout
        while len(self.events(kind)) < count:
            assert self.alive(), f"Pi exited {self.proc.returncode}"
            assert time.monotonic() < deadline, f"timed out waiting for {count} {kind}"
            self.drain(0.1)
        self.drain()
        return self.events(kind)

    def open_gate(self, name):
        (self.gates / name).touch()

    def editor(self):
        """The draft, read through the companion's shortcut without changing it."""
        count = len(self.events("editor")) + 1
        self.press(F9, 0.3)
        return self.wait("editor", count)[-1]["text"]

    def recorded(self):
        if not self.history.exists():
            return []
        return [
            json.loads(line)["text"] for line in self.history.read_text().splitlines()
        ]

    def close(self):
        """Idempotent, so a check may end a process the runner also closes."""
        if self.fd < 0:
            return
        if self.alive():
            os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc.wait(timeout=5)
        os.close(self.fd)
        self.fd = -1
