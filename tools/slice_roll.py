#!/usr/bin/env python3
"""Slice the Roll sprite sheet into per-expression PNGs with transparent bg.

Usage:
    pip3 install Pillow
    python3 tools/slice_roll.py assets/roll/sheet.png

This first dumps EVERY grid cell to assets/roll/_cells/cell_<r>_<c>.png and a
labeled contact sheet (_contact.png) so we can eyeball which cell is which
expression. Then the MAP below copies chosen cells to the names the app loads
(neutral/happy/surprised/worried/sad/wink/talk).

Grid params are auto-guessed from the teal background but can be overridden.
"""
import sys, os
from PIL import Image

SHEET = sys.argv[1] if len(sys.argv) > 1 else "assets/roll/sheet.png"
OUT = os.path.dirname(SHEET) or "assets/roll"
CELLS = os.path.join(OUT, "_cells")

# Background color to knock out to transparent (the teal). Auto-sampled from (0,0).
BG_TOLERANCE = 40

# --- grid: filled in after we measure the real sheet (cols, rows) ---
COLS = int(os.environ.get("COLS", "0"))
ROWS = int(os.environ.get("ROWS", "0"))

# cell (row, col) -> expression name. Finalized after viewing the contact sheet.
MAP = {
    # "neutral":   (0, 0),
    # "happy":     (0, 1),
    # "surprised": (1, 0),
    # "worried":   (1, 1),
    # "sad":       (2, 0),
    # "wink":      (2, 1),
    # "talk":      (0, 2),
}


def knockout_bg(img, bg):
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    br, bgc, bb, _ = bg
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if abs(r - br) <= BG_TOLERANCE and abs(g - bgc) <= BG_TOLERANCE and abs(b - bb) <= BG_TOLERANCE:
                px[x, y] = (r, g, b, 0)
    return img


def main():
    sheet = Image.open(SHEET).convert("RGBA")
    W, H = sheet.size
    print(f"sheet: {W}x{H}")
    bg = sheet.getpixel((0, 0))
    print(f"bg sample @0,0: {bg}")

    if not (COLS and ROWS):
        print("Set COLS and ROWS env vars (measure from the contact sheet) and re-run.")
        print("e.g.  COLS=8 ROWS=9 python3 tools/slice_roll.py", SHEET)
        return

    cw, ch = W // COLS, H // ROWS
    os.makedirs(CELLS, exist_ok=True)
    contact = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    for r in range(ROWS):
        for c in range(COLS):
            box = (c * cw, r * ch, (c + 1) * cw, (r + 1) * ch)
            cell = knockout_bg(sheet.crop(box), bg)
            cell.save(os.path.join(CELLS, f"cell_{r}_{c}.png"))
            contact.paste(cell, (c * cw, r * ch), cell)
    contact.save(os.path.join(OUT, "_contact.png"))
    print(f"wrote {ROWS*COLS} cells -> {CELLS}, contact -> {OUT}/_contact.png")

    for name, (r, c) in MAP.items():
        Image.open(os.path.join(CELLS, f"cell_{r}_{c}.png")).save(os.path.join(OUT, f"{name}.png"))
        print(f"  {name}.png  <- cell_{r}_{c}")


if __name__ == "__main__":
    main()
