"""Render narration clips with edge-tts (gTTS fallback) and write durations.json."""
import json, pathlib, subprocess, sys
HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "out" / "tts"; OUT.mkdir(parents=True, exist_ok=True)
cfg = json.loads((HERE / "narration.json").read_text())
EDGE = "/data/venvs/edge-tts/bin/edge-tts"
dur = {}
for key, text in cfg["lines"].items():
    mp3 = OUT / f"{key}.mp3"; vtt = OUT / f"{key}.vtt"
    if not mp3.exists() or mp3.stat().st_size == 0:
        r = subprocess.run([EDGE, "--voice", cfg["voice"], f"--rate={cfg['rate']}", "--text", text,
                            "--write-media", str(mp3), "--write-subtitles", str(vtt)], capture_output=True, text=True)
        if r.returncode != 0:
            print("edge-tts failed", key, r.stderr[-300:]); sys.exit(1)
    d = float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(mp3)],
                             capture_output=True, text=True).stdout.strip())
    dur[key] = round(d, 3)
(HERE / "out" / "durations.json").write_text(json.dumps(dur, indent=1))
print(dur, sum(dur.values()))
