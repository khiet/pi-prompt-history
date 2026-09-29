"""Drive the real Pi CLI with this extension in an isolated POSIX PTY: the search
shortcut, its config, and /history. Synthetic history only; no model access.
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
MARKER = "seeded-history-marker"
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[@-_]")


class Pi:
    def __init__(self, root, config=None, keybindings=None):
        self.root = root
        self.agent = root / "agent"
        (self.agent / "prompt-history").mkdir(parents=True)
        (self.agent / "prompt-history/history.jsonl").write_text(
            json.dumps(
                {
                    "v": 1,
                    "id": "a",
                    "text": MARKER,
                    "cwd": str(root),
                    "session": "s",
                    "ts": 1,
                }
            )
            + "\n"
        )
        self.set_config(config)
        if keybindings:
            (self.agent / "keybindings.json").write_text(json.dumps(keybindings))
        env = {
            "PATH": os.environ["PATH"],
            "HOME": str(root),
            "TERM": "xterm-256color",
            "LANG": "en_US.UTF-8",
            "PI_CODING_AGENT_DIR": str(self.agent),
            "PI_OFFLINE": "1",
            "PI_TELEMETRY": "0",
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
            "-e",
            str(REPO / "src/index.ts"),
        ]
        self.fd, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 30, 120, 0, 0))
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
        self.drain(4)

    def set_config(self, config):
        path = self.agent / "prompt-history/config.json"
        if config is not None:
            path.write_text(config)

    def drain(self, duration=0.6):
        deadline = time.monotonic() + duration
        while time.monotonic() < deadline:
            if select.select([self.fd], [], [], 0.05)[0]:
                try:
                    self.out += os.read(self.fd, 65536)
                except OSError:
                    break

    def text(self, since=0):
        return ANSI.sub(b"", self.out[since:]).decode("utf8", "replace")

    def press(self, data, wait=0.8):
        mark = len(self.out)
        os.write(self.fd, data.encode())
        self.drain(wait)
        return self.text(mark)

    def opens(self, data):
        seen = MARKER in self.press(data)
        self.press("\x1b")  # Escape closes the picker, or a rename dialog.
        return seen

    def close(self):
        os.killpg(self.proc.pid, signal.SIGKILL)
        self.proc.wait(timeout=5)
        os.close(self.fd)


failed = []


def scenario(name, check, **kwargs):
    root = Path(tempfile.mkdtemp(prefix="pph-tui-")).resolve()
    pi = Pi(root, **kwargs)
    try:
        check(pi)
        print(f"PASS {name}")
    except AssertionError as error:
        failed.append(name)
        print(f"FAIL {name}: {error}\n--- screen ---\n{pi.text()[-3000:]}")
    finally:
        pi.close()
        shutil.rmtree(root, ignore_errors=True)


def default(pi):
    assert "Extension shortcut conflict: 'ctrl+r'" in pi.text(), "no conflict warning"
    assert pi.opens("\x12"), "ctrl+r did not open"
    assert pi.opens("/history\r"), "/history did not open"


def custom(pi):
    assert pi.opens("\x1bh"), "alt+h did not open"
    assert not pi.opens("\x12"), "ctrl+r still opened"


def invalid(pi):
    assert "Prompt history config" in pi.text(), "no config warning"
    assert pi.opens("\x12"), "ctrl+r fallback did not open"


def reserved(pi):
    assert "conflicts with built-in shortcut" in pi.text(), "no reserved warning"
    assert not pi.opens("\x12"), "ctrl+r opened despite reserved binding"
    assert pi.opens("/history\r"), "/history did not open"


def reload(pi):
    assert pi.opens("\x1bh"), "alt+h did not open"
    pi.set_config(json.dumps({"shortcut": "alt+j"}))
    assert pi.opens("\x1bh"), "running runtime rebound live"
    pi.press("/reload\r", wait=3)
    assert pi.opens("\x1bj"), "alt+j did not open after reload"
    assert not pi.opens("\x1bh"), "alt+h still opened after reload"


scenario("default ctrl+r shadows rename", default)
scenario("configured alt+h", custom, config=json.dumps({"shortcut": "alt+h"}))
scenario("invalid config falls back", invalid, config='{"shortcut": 7}')
scenario(
    "reserved ctrl+r keeps /history", reserved, keybindings={"app.clear": "ctrl+r"}
)
scenario("reload applies config", reload, config=json.dumps({"shortcut": "alt+h"}))

# Pi's reserved actions (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS in
# dist/core/extensions/runner.js, the same list on every tested release).
# For these three, pressing Ctrl+R would exit, suspend, or leave Pi for an
# external editor, so only the warning and /history are checked.
UNPRESSABLE = {"app.exit", "app.suspend", "app.editor.external"}
RESERVED = [
    "app.interrupt",
    "app.exit",
    "app.suspend",
    "app.thinking.cycle",
    "app.model.cycleForward",
    "app.model.cycleBackward",
    "app.model.select",
    "app.tools.expand",
    "app.thinking.toggle",
    "app.editor.external",
    "app.message.copy",
    "app.message.followUp",
    "tui.input.submit",
    "tui.select.confirm",
    "tui.select.cancel",
    "tui.input.copy",
    "tui.editor.deleteToLineEnd",
]


def reserved_by(action):
    def check(pi):
        assert "conflicts with built-in shortcut" in pi.text(), "no reserved warning"
        if action not in UNPRESSABLE:
            assert not pi.opens("\x12"), "ctrl+r opened despite reserved binding"
        # Rebinding submit moves it off Enter, so /history is sent with Ctrl+R.
        submit = "\x12" if action == "tui.input.submit" else "\r"
        assert pi.opens(f"/history{submit}"), "/history did not open"

    return check


for action in RESERVED:
    scenario(
        f"reserved {action} on ctrl+r keeps /history",
        reserved_by(action),
        keybindings={action: "ctrl+r"},
    )
sys.exit(1 if failed else 0)
