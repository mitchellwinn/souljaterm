#!/usr/bin/env python3
"""Generate simple placeholder Roll faces (one PNG per expression) so the app's
sprite pipeline works before the real sprite sheet is sliced. Run with the venv:
    tools/venv/bin/python tools/gen_placeholder_faces.py
Replace these later with cells from tools/slice_roll.py on the real sheet."""
import os
from PIL import Image, ImageDraw

OUT = "assets/roll"
S = 48
SKIN = (255, 217, 168, 255)
HAIR = (244, 197, 66, 255)
EYE = (58, 110, 165, 255)
MOUTH = (181, 72, 93, 255)
BLUSH = (243, 166, 166, 255)
WHITE = (255, 255, 255, 255)
SWEAT = (130, 200, 230, 255)

EXPR = ["neutral", "happy", "surprised", "worried", "sad", "wink", "talk"]


def base():
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((9, 12, 39, 43), fill=SKIN)            # face
    d.pieslice((7, 4, 41, 34), 180, 360, fill=HAIR)  # bangs
    d.rectangle((7, 18, 11, 30), fill=HAIR)          # side hair L
    d.rectangle((37, 18, 41, 30), fill=HAIR)         # side hair R
    d.ellipse((13, 30, 18, 34), fill=BLUSH)          # blush L
    d.ellipse((30, 30, 35, 34), fill=BLUSH)          # blush R
    return img, d


def eyes_open(d, h=5):
    d.ellipse((16, 24, 21, 24 + h), fill=EYE)
    d.ellipse((27, 24, 32, 24 + h), fill=EYE)


def draw(name):
    img, d = base()
    if name == "neutral":
        eyes_open(d); d.arc((19, 33, 29, 39), 0, 180, fill=MOUTH, width=2)
    elif name == "happy":
        d.arc((15, 22, 21, 28), 180, 360, fill=EYE, width=2)
        d.arc((27, 22, 33, 28), 180, 360, fill=EYE, width=2)
        d.chord((18, 32, 30, 40), 0, 180, fill=MOUTH)
    elif name == "surprised":
        d.ellipse((15, 22, 21, 28), fill=EYE)
        d.ellipse((27, 22, 33, 28), fill=EYE)
        d.ellipse((22, 34, 26, 39), fill=MOUTH)
    elif name == "worried":
        eyes_open(d, 4); d.arc((19, 36, 29, 41), 180, 360, fill=MOUTH, width=2)
        d.ellipse((34, 16, 38, 22), fill=SWEAT)
    elif name == "sad":
        d.arc((15, 25, 21, 30), 0, 180, fill=EYE, width=2)
        d.arc((27, 25, 33, 30), 0, 180, fill=EYE, width=2)
        d.arc((19, 37, 29, 42), 180, 360, fill=MOUTH, width=2)
    elif name == "wink":
        d.ellipse((16, 24, 21, 29), fill=EYE)
        d.arc((27, 24, 33, 29), 180, 360, fill=EYE, width=2)
        d.arc((19, 33, 29, 39), 0, 180, fill=MOUTH, width=2)
    elif name == "talk":
        eyes_open(d); d.ellipse((20, 33, 28, 41), fill=MOUTH)  # open mouth
        d.ellipse((22, 35, 26, 39), fill=(120, 40, 55, 255))
    img.save(os.path.join(OUT, f"{name}.png"))


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for e in EXPR:
        draw(e)
    print("wrote", len(EXPR), "placeholder faces to", OUT)
