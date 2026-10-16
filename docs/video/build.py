#!/usr/bin/env python3
"""Assemble the Dayspan demo: setup still + captured emulator frames + narration + UI sounds.

Inputs (docs/video/out): setup.png, frames/*.jpg, events.json, durations.json, tts/*.mp3|vtt
Output: out/dayspan-demo.mp4 (1920x1080, H.264, AAC), out/dayspan-demo.en.srt
"""
from __future__ import annotations

import json
import pathlib
import re
import subprocess
import wave

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "out"
FPS = 25
SR = 48000
INTRO = 10.3
FONT_DIR = OUT / "fonts"

ev_vr = json.loads((OUT / "events_vr.json").read_text())
ev_mr = json.loads((OUT / "events_mr.json").read_text())
fr_vr = sorted((OUT / "frames_vr").glob("*.jpg"))
fr_mr = sorted((OUT / "frames_mr").glob("*.jpg"))
frames = fr_vr + fr_mr


def seg_bounds(evs, name):
    a = next(e["t"] for e in evs if e["kind"] == "seg_start" and e.get("seg") == name)
    b = next(e["t"] for e in evs if e["kind"] == "seg_stop" and e.get("seg") == name)
    return a, b


vr0, vr1 = seg_bounds(ev_vr, "vr")
mr0, mr1 = seg_bounds(ev_mr, "mr")
n_vr = len(fr_vr)
vr_len = n_vr / FPS
# events mapped onto the final timeline
ev = []
for e in ev_vr:
    if vr0 - 0.01 <= e["t"] <= vr1 + 0.01:
        ev.append({**e, "T": INTRO + (e["t"] - vr0)})
for e in ev_mr:
    if mr0 - 0.01 <= e["t"] <= mr1 + 0.01:
        ev.append({**e, "T": INTRO + vr_len + (e["t"] - mr0)})


total = INTRO + len(frames) / FPS
print(f"frames {len(frames)}  vr {vr_len:.1f}s  mr {(len(frames) - n_vr) / FPS:.1f}s  total {total:.1f}s")

# ---------- video: intro still (slow push-in) + frames ----------
lst = OUT / "frames.txt"
with lst.open("w") as f:
    for fr in frames:
        f.write(f"file '{fr}'\nduration {1 / FPS:.5f}\n")
    f.write(f"file '{frames[-1]}'\n")
subprocess.run(["ffmpeg", "-y", "-v", "error", "-loop", "1", "-framerate", str(FPS), "-t", str(INTRO), "-i", str(OUT / "setup.png"),
                "-vf", f"scale=1920:1080,zoompan=z='1+0.035*on/({INTRO}*{FPS})':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=1920x1080:fps={FPS},format=yuv420p",
                "-c:v", "libx264", "-crf", "16", "-preset", "medium", str(OUT / "intro.mp4")], check=True)
subprocess.run(["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst),
                "-vf", f"fps={FPS},scale=1920:1080:flags=lanczos,format=yuv420p", "-c:v", "libx264", "-crf", "16", "-preset", "medium",
                str(OUT / "xr.mp4")], check=True)

# ---------- audio: narration at scene starts + synthesized UI sounds ----------
dur = json.loads((OUT / "durations.json").read_text())
starts = {"intro": 0.35}
for e in ev:
    if e["kind"] == "scene" and e["key"] != "intro":
        starts[e["key"]] = e["T"] + 0.15
n = int((total + 1) * SR)
mix = np.zeros(n, dtype=np.float64)


def decode(mp3: pathlib.Path) -> np.ndarray:
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp3), "-f", "f32le", "-ac", "1", "-ar", str(SR), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).astype(np.float64)


def add(sig: np.ndarray, at: float, gain=1.0):
    i = int(at * SR)
    j = min(n, i + len(sig))
    if i < n:
        mix[i:j] += sig[: j - i] * gain


for key, at in starts.items():
    add(decode(OUT / "tts" / f"{key}.mp3"), at, 1.0)


def tone(f0, f1, length, gain, kind="tri"):
    t = np.arange(int(length * SR)) / SR
    f = f0 * (f1 / f0) ** (t / length)
    ph = 2 * np.pi * np.cumsum(f) / SR
    wave_ = (2 / np.pi) * np.arcsin(np.sin(ph)) if kind == "tri" else np.sin(ph)
    env = np.minimum(1, t / 0.004) * np.exp(-t / (length / 4))
    return wave_ * env * gain


SFX = {
    "tok": tone(820, 260, 0.13, 0.32),
    "lift": tone(1300, 420, 0.1, 0.12),
    "tick": tone(1150, 380, 0.1, 0.12),
    "thud": tone(450, 140, 0.16, 0.3),
    "chord": np.concatenate([tone(392, 392, 0.9, 0.16, "sin"), np.zeros(1)])
    + np.pad(tone(587.33, 587.33, 0.9, 0.16, "sin"), (int(0.09 * SR), 0))[: int(0.9 * SR) + 1],
}
for e in ev:
    if e["kind"] in SFX:
        add(SFX[e["kind"]], e["T"], 1.0)

mix = np.clip(mix, -1, 1)
with wave.open(str(OUT / "mix.wav"), "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())

# ---------- subtitles (sentence cues from edge-tts) ----------
def ts(s: str) -> float:
    h, m, rest = s.split(":")
    sec, ms = rest.replace(".", ",").split(",")
    return int(h) * 3600 + int(m) * 60 + int(sec) + int(ms) / 1000


cues = []
for key, at in starts.items():
    vtt = (OUT / "tts" / f"{key}.vtt").read_text()
    for m in re.finditer(r"(\d\d:\d\d:\d\d[,.]\d+) --> (\d\d:\d\d:\d\d[,.]\d+)\s*\n(.+?)(?:\n\n|\Z)", vtt, re.S):
        cues.append((at + ts(m.group(1)), at + ts(m.group(2)), " ".join(m.group(3).split())))
cues.sort()


def srt_t(x: float) -> str:
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f"{h:02d}:{m:02d}:{int(s):02d},{int(round((s - int(s)) * 1000)):03d}"


(OUT / "dayspan-demo.en.srt").write_text("".join(f"{i + 1}\n{srt_t(a)} --> {srt_t(b)}\n{t}\n\n" for i, (a, b, t) in enumerate(cues)))


def ass_t(x: float) -> str:
    h = int(x // 3600); m = int(x % 3600 // 60); s = x % 60
    return f"{h}:{m:02d}:{s:05.2f}"


ass = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "",
       "[V4+ Styles]",
       "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
       "Style: Sub,Lexend SemiBold,44,&H00EFF3F2,&H00EFF3F2,&H40201B16,&H40201B16,0,0,0,0,100,100,0,0,3,10,0,2,220,220,60,1",
       "Style: Tag,Lexend SemiBold,30,&H00EFF3F2,&H00EFF3F2,&H50201B16,&H50201B16,0,0,0,0,100,100,0,0,3,8,0,7,44,44,40,1",
       "Style: Card,Lexend SemiBold,72,&H00EFF3F2,&H00EFF3F2,&H20201B16,&H20201B16,0,0,0,0,100,100,0,0,3,26,0,5,80,80,80,1",
       "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text"]
for a, b, t in cues:
    ass.append(f"Dialogue: 0,{ass_t(a)},{ass_t(b)},Sub,,0,0,0,,{t}")
tag = "Recorded in the IWER emulator, Meta Quest 3 profile, hands only"
ass.append(f"Dialogue: 0,{ass_t(INTRO + 0.2)},{ass_t(INTRO + 7)},Tag,,0,0,0,,{tag}")
ass.append(f"Dialogue: 0,{ass_t(INTRO + vr_len + 0.2)},{ass_t(INTRO + vr_len + 7)},Tag,,0,0,0,,Passthrough mode in the emulator's synthetic room (stand-in for your real room)")
ass.append(f"Dialogue: 1,{ass_t(total - 3.6)},{ass_t(total)},Card,,0,0,0,,{{\\fad(300,0)}}Dayspan\\N{{\\fs36}}ctmakc.github.io/dayspan  ·  built with IWSDK")
(OUT / "subs.ass").write_text("\n".join(ass) + "\n")

subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(OUT / "intro.mp4"), "-i", str(OUT / "xr.mp4"), "-i", str(OUT / "mix.wav"),
                "-filter_complex", f"[0:v][1:v]concat=n=2:v=1:a=0[v];[v]subtitles={OUT / 'subs.ass'}:fontsdir={FONT_DIR}[vs];[2:a]loudnorm=I=-16:TP=-1.5:LRA=11[a]",
                "-map", "[vs]", "-map", "[a]", "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
                "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", "-movflags", "+faststart", str(OUT / "dayspan-demo.mp4")], check=True)
print("wrote", OUT / "dayspan-demo.mp4")
