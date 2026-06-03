#!/usr/bin/env python3
"""Generate Roll's Japanese "animalese" voice — one short clip per mora (kana syllable).

macOS `say` (voice Kyoko) speaks each kana, then ffmpeg pitches it up tape-style so it sits in
Roll's bright register (similar-ish to her synth blips, just intelligible), and trims the leading/
trailing silence so each blip is snappy enough to fire per-typed-character. Output: 44.1k mono WAV
under assets/roll/mora/<romaji>.wav. roll-face.js plays these when she's set to Japanese, and falls
back to the synth blip for anything without a clip (kanji, Latin, punctuation).

Usage:  python3 tools/gen_mora.py [--force] [--voice Kyoko] [--pitch 1.35]
Idempotent: skips clips that already exist unless --force.
"""
import os, sys, subprocess, tempfile, shutil

VOICE = "Kyoko"
PITCH = 1.55                      # tape-style pitch-up: bright, higher feminine register
SR = 44100
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "roll", "mora")

# romaji filename -> kana fed to `say`. Covers gojūon + dakuten/handakuten + yōon. Katakana and the
# long-vowel / geminate marks are handled at playback time (roll-face.js), not here.
MORA = {
    "a": "あ", "i": "い", "u": "う", "e": "え", "o": "お",
    "ka": "か", "ki": "き", "ku": "く", "ke": "け", "ko": "こ",
    "sa": "さ", "shi": "し", "su": "す", "se": "せ", "so": "そ",
    "ta": "た", "chi": "ち", "tsu": "つ", "te": "て", "to": "と",
    "na": "な", "ni": "に", "nu": "ぬ", "ne": "ね", "no": "の",
    "ha": "は", "hi": "ひ", "fu": "ふ", "he": "へ", "ho": "ほ",
    "ma": "ま", "mi": "み", "mu": "む", "me": "め", "mo": "も",
    "ya": "や", "yu": "ゆ", "yo": "よ",
    "ra": "ら", "ri": "り", "ru": "る", "re": "れ", "ro": "ろ",
    "wa": "わ", "wo": "を", "n": "ん",
    "ga": "が", "gi": "ぎ", "gu": "ぐ", "ge": "げ", "go": "ご",
    "za": "ざ", "ji": "じ", "zu": "ず", "ze": "ぜ", "zo": "ぞ",
    "da": "だ", "de": "で", "do": "ど",
    "ba": "ば", "bi": "び", "bu": "ぶ", "be": "べ", "bo": "ぼ",
    "pa": "ぱ", "pi": "ぴ", "pu": "ぷ", "pe": "ぺ", "po": "ぽ",
    "kya": "きゃ", "kyu": "きゅ", "kyo": "きょ",
    "sha": "しゃ", "shu": "しゅ", "sho": "しょ",
    "cha": "ちゃ", "chu": "ちゅ", "cho": "ちょ",
    "nya": "にゃ", "nyu": "にゅ", "nyo": "にょ",
    "hya": "ひゃ", "hyu": "ひゅ", "hyo": "ひょ",
    "mya": "みゃ", "myu": "みゅ", "myo": "みょ",
    "rya": "りゃ", "ryu": "りゅ", "ryo": "りょ",
    "gya": "ぎゃ", "gyu": "ぎゅ", "gyo": "ぎょ",
    "ja": "じゃ", "ju": "じゅ", "jo": "じょ",
    "bya": "びゃ", "byu": "びゅ", "byo": "びょ",
    "pya": "ぴゃ", "pyu": "ぴゅ", "pyo": "ぴょ",
}


def trimmed_pitch_filter():
    rate = int(round(SR * PITCH))
    # normalize rate -> pitch up (asetrate relabels, aresample restores) -> trim head, reverse +
    # trim head again (= trim tail) + reverse back -> lowpass to round off the harsh/sibilant edge
    # (cuter, less "gremlin") -> short fade in/out so the syllable can't click -> gentle normalize.
    fade = (
        "afade=t=in:st=0:d=0.009,"                # soft attack
        "areverse,afade=t=in:st=0:d=0.022,areverse"  # soft release (fade the reversed head = the tail)
    )
    return (
        f"aresample={SR},asetrate={rate},aresample={SR},"
        "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.004:detection=peak,"
        "areverse,"
        "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.004:detection=peak,"
        "areverse,"
        "lowpass=f=4300,"                         # round off the shrill/sibilant top so high != harsh
        f"{fade},"
        "dynaudnorm=p=0.65:m=5:g=15"              # gentle, no pumping
    )


def main():
    force = "--force" in sys.argv
    for i, a in enumerate(sys.argv):
        if a == "--voice" and i + 1 < len(sys.argv):
            globals()["VOICE"] = sys.argv[i + 1]
        if a == "--pitch" and i + 1 < len(sys.argv):
            globals()["PITCH"] = float(sys.argv[i + 1])
    if not shutil.which("say") or not shutil.which("ffmpeg"):
        sys.exit("need both `say` (macOS) and `ffmpeg` on PATH")
    os.makedirs(OUT, exist_ok=True)
    flt = trimmed_pitch_filter()
    made = skipped = 0
    with tempfile.TemporaryDirectory() as tmp:
        for romaji, kana in MORA.items():
            dst = os.path.join(OUT, romaji + ".wav")
            if os.path.exists(dst) and not force:
                skipped += 1
                continue
            aiff = os.path.join(tmp, romaji + ".aiff")
            subprocess.run(["say", "-v", VOICE, "-o", aiff, kana], check=True)
            subprocess.run(
                ["ffmpeg", "-y", "-loglevel", "error", "-i", aiff, "-ac", "1", "-ar", str(SR),
                 "-af", flt, dst], check=True)
            made += 1
            print(f"  {kana}\t-> {romaji}.wav")
    print(f"done: {made} generated, {skipped} skipped -> {os.path.relpath(OUT)}")


if __name__ == "__main__":
    main()
