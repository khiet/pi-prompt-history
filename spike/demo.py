"""Capture the real picker in an isolated PTY and render the README GIF.

Setup (outside the repo):
    python3 -m venv /tmp/pi-demo-venv
    /tmp/pi-demo-venv/bin/pip install Pillow==12.3.0 pyte==0.8.2
Run from the repo after npm ci --ignore-scripts:
    /tmp/pi-demo-venv/bin/python spike/demo.py

Uses the release-check harness: no personal history, credentials, or network.
Only the picker/editor region is shown; Pi's status footer is cropped out.
Requires a POSIX PTY and Menlo (macOS) or DejaVu Sans Mono (Linux).
"""

import argparse
import tempfile
from datetime import datetime
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

from harness import CTRL_R, DOWN, ENTER, REPO, Pi, record

COLS, ROWS = 96, 24
# Layout is drawn in 1120x704 points at SCALE pixels each, so text stays
# sharp on high-density screens where the README shows the GIF downscaled.
SCALE = 2
WIDTH, HEIGHT = 1120 * SCALE, 704 * SCALE
BG, FG = "#111820", "#dce6ef"
MUTED, ACCENT = "#90a1b5", "#79dcca"
PROMPT = (
    "Implement webhook retry with exponential backoff.\n"
    "Retry 429 and 5xx responses; respect Retry-After.\n"
    "Stop after 5 attempts and log the delivery ID."
)
PROMPTS = [
    "Add pagination to the customer activity endpoint.",
    "Fix the timezone offset in invoice CSV exports.",
    "Document the webhook signing-secret rotation steps.",
    "Add a health check for the background job worker.",
    PROMPT,
    "Add tests for webhook retry backoff and jitter.",
    "Return a useful error when an API token has expired.",
]
COLORS = {
    "black": "#111820",
    "red": "#ef8585",
    "green": "#93d9a3",
    "brown": "#e9c785",
    "blue": "#85b4ef",
    "magenta": "#bd9ee9",
    "cyan": "#79dcca",
    "white": "#dce6ef",
    "brightblack": "#708197",
    "brightred": "#ffa0a0",
    "brightgreen": "#aff0bf",
    "brightbrown": "#ffe0a0",
    "brightblue": "#a1c9ff",
    "brightmagenta": "#d7baff",
    "brightcyan": "#a0f5e6",
    "brightwhite": "#ffffff",
}


def color(value, default):
    if value == "default":
        return default
    return COLORS.get(value, f"#{value}")


def mono_font(path):
    candidates = [
        path,
        "/System/Library/Fonts/Menlo.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(str(candidate), 17 * SCALE)
    raise SystemExit("No monospace font found. Pass --font /path/to/font.ttf")


def px(*values):
    return tuple(v * SCALE for v in values)


def render(screen, font, step, key, caption, detail):
    image = Image.new("RGB", (WIDTH, HEIGHT), "#0b111b")
    draw = ImageDraw.Draw(image)
    title = ImageFont.load_default(size=34 * SCALE)
    label = ImageFont.load_default(size=20 * SCALE)
    small = ImageFont.load_default(size=15 * SCALE)
    strong = ImageFont.load_default(size=23 * SCALE)

    draw.text(px(34, 25), "pi-prompt-history", font=title, fill=FG)
    draw.text(px(35, 72), "Find it. Preview it. Keep working.", font=label, fill=MUTED)
    draw.rounded_rectangle(px(898, 35, 1086, 70), radius=17 * SCALE, fill="#173a38")
    draw.text(px(918, 43), "CTRL+R FOR PI", font=small, fill=ACCENT)

    draw.rounded_rectangle(px(32, 121, 1088, 584), radius=16 * SCALE, fill="#060b12")
    draw.rounded_rectangle(
        px(32, 115, 1088, 578),
        radius=16 * SCALE,
        fill=BG,
        outline="#2b394b",
        width=SCALE,
    )
    draw.line(px(33, 160, 1087, 160), fill="#2b394b", width=SCALE)
    for x, fill in [(56, "#f08b89"), (78, "#e6c17a"), (100, "#85cba0")]:
        draw.ellipse(px(x, 133, x + 10, 143), fill=fill)
    draw.text(px(138, 130), "pi / harbor-api", font=small, fill=MUTED)
    draw.text(px(831, 130), "REAL TUI / FICTIONAL DATA", font=small, fill=MUTED)

    # Crop at Pi's status footer, without altering any picker/editor cells.
    end = next(
        (i for i, line in enumerate(screen.display) if line.startswith("~/harbor-api")),
        None,
    )
    assert end is not None, "Pi's layout changed; review the capture crop"
    assert end <= 17, "Picker no longer fits the demo viewport"
    cell_width, cell_height = font.getlength("M"), 23 * SCALE
    assert COLS * cell_width <= 1010 * SCALE, "Choose a narrower monospace font"
    for row in range(1, end):
        for column in range(COLS):
            char = screen.buffer[row][column]
            fg, bg = color(char.fg, FG), color(char.bg, BG)
            if char.reverse:
                fg, bg = bg, fg
            x, y = (
                56 * SCALE + column * cell_width,
                178 * SCALE + (row - 1) * cell_height,
            )
            if bg != BG:
                draw.rectangle((x, y, x + cell_width, y + cell_height), fill=bg)
            if char.data.strip():
                draw.text((x, y), char.data, font=font, fill=fg)
            if char.underscore:
                draw.line(
                    (x, y + 21 * SCALE, x + cell_width, y + 21 * SCALE),
                    fill=fg,
                    width=SCALE,
                )

    draw.rounded_rectangle(
        px(34, 606, 169, 653),
        radius=10 * SCALE,
        fill="#173a38",
        outline="#2b625b",
        width=SCALE,
    )
    key_width = draw.textlength(key, font=label)
    draw.text((101 * SCALE - key_width / 2, 618 * SCALE), key, font=label, fill=ACCENT)
    draw.text(px(190, 603), caption, font=strong, fill=FG)
    draw.text(px(191, 638), detail, font=small, fill=MUTED)
    for index in range(4):
        x = 980 + index * 27
        draw.rounded_rectangle(
            px(x, 624, x + 16, 630),
            radius=3 * SCALE,
            fill=ACCENT if index == step - 1 else "#314154",
        )
    return image


def capture(font):
    frames, durations = [], []
    with tempfile.TemporaryDirectory(prefix="pi-demo-", dir="/tmp") as temporary:
        # macOS aliases /tmp to /private/tmp; scope matching uses the exact cwd.
        root = Path(temporary).resolve()
        cwd = root / "harbor-api"
        history = [
            record(
                text,
                cwd,
                int(datetime(2026, 9, 28, 9 + i, 15).timestamp() * 1000),
            )
            for i, text in enumerate(PROMPTS)
        ]
        pi = Pi(
            root,
            cwd=cwd,
            extensions=[REPO / "spike/scripted.ts"],
            args=["--provider", "scripted", "--model", "synthetic"],
            settings={"quietStartup": True, "theme": "dark"},
            keybindings={"app.session.rename": "alt+r"},
            history=history,
            rows=ROWS,
            cols=COLS,
        )
        try:
            screen = pyte.Screen(COLS, ROWS)
            stream = pyte.ByteStream(screen)
            consumed = 0

            def snapshot(duration, step, key, caption, detail):
                nonlocal consumed
                stream.feed(pi.out[consumed:])
                consumed = len(pi.out)
                frames.append(render(screen, font, step, key, caption, detail))
                durations.append(duration)

            pi.press(CTRL_R)
            snapshot(
                2200,
                1,
                "Ctrl + R",
                "A prompt worth reusing?",
                "Open this directory's history, even in a new session.",
            )
            assert "Prompt history: this directory" in "\n".join(screen.display)
            for char in "webhook retry":
                pi.press(char, wait=0.15)
                snapshot(
                    150 if char != " " else 650,
                    2,
                    "type",
                    "Find the words you remember.",
                    "Search: webhook retry. Results narrow as you type.",
                )
            durations[-1] = 2300
            display = "\n".join(screen.display)
            assert "> webhook retry" in display
            assert "Add tests for webhook retry" in display
            assert "Implement webhook retry" in display
            pi.press(DOWN)
            snapshot(
                3000,
                3,
                "Down",
                "Preview the whole idea.",
                "Select a result to read the original multiline prompt.",
            )
            assert "Stop after 5 attempts and log the delivery ID." in "\n".join(
                screen.display
            )
            pi.press(ENTER)
            # Read the restored draft before capturing; this also flushes Pi's UI.
            assert pi.editor() == PROMPT
            snapshot(
                3800,
                4,
                "Enter",
                "Back in your draft. Not sent.",
                "The complete prompt is restored, ready to edit before sending.",
            )
            assert "Stop after 5 attempts and log the delivery ID." in "\n".join(
                screen.display
            )
            assert not pi.events("turn"), "The demo must never send a model request"
            assert pi.recorded() == PROMPTS, "Recalling must not record a new prompt"
        finally:
            pi.close()
    return frames, durations


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font", type=Path, help="Monospace TTF/TTC font")
    parser.add_argument(
        "--output", type=Path, default=REPO / "docs/assets/prompt-history.gif"
    )
    parser.add_argument("--preview", type=Path, help="Optional preview contact sheet")
    args = parser.parse_args()
    frames, durations = capture(mono_font(args.font))
    # One shared palette avoids color flicker and lets GIF store changed regions.
    samples = Image.new("RGB", (WIDTH, HEIGHT * 4))
    for i, frame in enumerate([frames[0], frames[-3], frames[-2], frames[-1]]):
        samples.paste(frame, (0, HEIGHT * i))
    palette = samples.quantize(colors=128)
    indexed = [
        frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in frames
    ]
    args.output.parent.mkdir(parents=True, exist_ok=True)
    indexed[0].save(
        args.output,
        save_all=True,
        append_images=indexed[1:],
        duration=durations,
        loop=0,
        optimize=True,
        disposal=1,
    )
    if args.preview:
        args.preview.parent.mkdir(parents=True, exist_ok=True)
        samples.resize((WIDTH // 2 // SCALE, HEIGHT * 2 // SCALE)).save(args.preview)
    with Image.open(args.output) as gif:
        assert gif.n_frames == len(frames)
        assert gif.info["loop"] == 0
        for i, expected in enumerate(durations):
            gif.seek(i)
            assert gif.info["duration"] == expected
    print(
        f"{args.output}: {WIDTH}x{HEIGHT}, {sum(durations) / 1000:.1f}s, "
        f"{len(frames)} frames, {args.output.stat().st_size / 1024:.0f} KiB"
    )
    print("Verified: search, multiline preview, exact draft restore, no submission.")


if __name__ == "__main__":
    main()
