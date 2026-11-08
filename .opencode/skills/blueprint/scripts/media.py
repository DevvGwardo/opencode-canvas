#!/usr/bin/env python3
"""Blueprint media helpers: turn raw harness captures into compact, labelled page media.

  media.py web   IN.png OUT.jpg [--max 1600]                 screenshot -> compressed jpg
  media.py sheet OUT.jpg A.png B.png ... [--cols 3] [--h 900] [--labels "a|b|c"]
  media.py pair  OUT.jpg BEFORE.png AFTER.png [--labels "Before|After"]
  media.py strip OUT.jpg VIDEO.mp4 0.5 2 4 6 [--h 640]     frames of a video at given seconds
  media.py mp4   IN.mp4 OUT.mp4 [--w 540]                   web copy: h264, faststart, smaller

Inputs may be quoted globs ("blueprint-out/ui/run/*.png") or one space-separated list (zsh
doesn't split $FILES). Needs Pillow; strip/mp4 need ffmpeg on PATH.
"""
import glob, os, subprocess, sys, tempfile
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    sys.exit("media.py: needs Pillow (python3 -m pip install pillow)")

BG = (15, 17, 21)
INK = (232, 234, 240)

def fail(msg):
    sys.exit(f"media.py: {msg}")

def font(size):
    for f in ["/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/System/Library/Fonts/Helvetica.ttc",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]:
        try: return ImageFont.truetype(f, size)
        except OSError: pass
    return ImageFont.load_default()

def opt(args, name, default):
    if name in args:
        i = args.index(name)
        if i + 1 >= len(args): fail(f"{name} needs a value")
        v = args[i + 1]; del args[i:i + 2]; return v
    return default

def inputs(args):
    """Existing files, expanding quoted globs and a single space-joined list; never a silent empty list."""
    out = []
    for a in args:
        if os.path.exists(a): out.append(a)
        elif any(c in a for c in "*?["):
            hits = sorted(glob.glob(a))
            if not hits: fail(f"glob matched nothing: {a}")
            out += hits
        elif " " in a and all(os.path.exists(p) for p in a.split()): out += a.split()
        else: fail(f"not found: {a}")
    if not out: fail("no input files")
    return out

def outpath(p):
    Path(p).parent.mkdir(parents=True, exist_ok=True); return p

def grid(images, cols, h, labels, pad=12):
    ims = [im.convert("RGB").resize((round(im.width * h / im.height), h)) for im in images]
    lab = 40 if labels else 0
    rows = [ims[i:i + cols] for i in range(0, len(ims), cols)]
    W = max(sum(i.width for i in r) + pad * (len(r) - 1) for r in rows)
    H = len(rows) * (h + lab) + pad * (len(rows) - 1)
    out = Image.new("RGB", (W, H), BG); d = ImageDraw.Draw(out); k = 0
    tile = min(i.width for i in ims)
    def fit(text):  # largest font (<= 24px) whose label fits inside the narrowest tile
        for size in range(24, 9, -1):
            f = font(size)
            if d.textlength(text, font=f) <= tile - 8: return f
        return font(10)
    for ri, r in enumerate(rows):
        x, y = 0, ri * (h + lab + pad)
        for im in r:
            if labels: d.text((x + 4, y + 8), labels[k], fill=INK, font=fit(labels[k]))
            out.paste(im, (x, y + lab)); x += im.width + pad; k += 1
    return out

def save(im, path, maxw=1800):
    im.thumbnail((maxw, maxw * 4)); im.save(outpath(path), quality=84, optimize=True); print(path, im.size)

def duration(video):
    r = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
                       capture_output=True, text=True)
    try: return float(r.stdout.strip())
    except ValueError: fail(f"ffprobe can't read {video}: {r.stderr.strip()[:200]}")

def need(tool):
    if not any(os.access(os.path.join(d, tool), os.X_OK) for d in os.environ.get("PATH", "").split(os.pathsep)):
        fail(f"needs {tool} on PATH")

def main(a):
    if not a or a[0] not in ("web", "sheet", "pair", "strip", "mp4") or {"-h", "--help"} & set(a):
        print(__doc__); sys.exit(0 if {"-h", "--help"} & set(a) else 1)
    cmd = a.pop(0)
    if cmd == "web":
        m = int(opt(a, "--max", 1600))
        if len(a) != 2: fail("web takes IN.png OUT.jpg")
        im = Image.open(inputs(a[:1])[0]).convert("RGB"); im.thumbnail((m, m)); im.save(outpath(a[1]), quality=84, optimize=True); print(a[1], im.size)
    elif cmd in ("sheet", "pair"):
        labels = opt(a, "--labels", "Before|After" if cmd == "pair" else "")
        cols = int(opt(a, "--cols", 2 if cmd == "pair" else 3)); h = int(opt(a, "--h", 900))
        if len(a) < 2: fail(f"{cmd} takes OUT.jpg then the input images")
        out, files = a[0], inputs(a[1:])
        if cmd == "pair" and len(files) != 2: fail(f"pair takes exactly 2 images, got {len(files)}")
        labels = labels.split("|") if labels else None
        if labels and len(labels) != len(files): fail(f"{len(labels)} labels for {len(files)} images")
        save(grid([Image.open(p) for p in files], cols, h, labels), out)
    elif cmd == "strip":
        need("ffmpeg"); need("ffprobe")
        h = int(opt(a, "--h", 640))
        if len(a) < 3: fail("strip takes OUT.jpg VIDEO.mp4 then one or more times in seconds")
        out, video, times = a[0], inputs(a[1:2])[0], a[2:]
        length = duration(video)
        late = [t for t in times if float(t) >= length]
        if late: fail(f"{', '.join(late)}s past the end of {video} ({length:.2f}s long)")
        with tempfile.TemporaryDirectory() as tmp:
            frames = []
            for i, t in enumerate(times):
                p = os.path.join(tmp, f"{i}.png")
                subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", t, "-i", video, "-frames:v", "1", p], check=True)
                if not os.path.exists(p): fail(f"ffmpeg produced no frame at {t}s of {video}")
                frames.append(Image.open(p).copy())
            save(grid(frames, len(frames), h, [f"{t}s" for t in times]), out, maxw=2400)
    elif cmd == "mp4":
        need("ffmpeg")
        w = opt(a, "--w", "540")
        if len(a) != 2: fail("mp4 takes IN.mp4 OUT.mp4")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", inputs(a[:1])[0], "-vf", f"scale={w}:-2", "-c:v", "libx264", "-crf", "26", "-preset", "slow",
                        "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", outpath(a[1])], check=True); print(a[1])

if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except ValueError as e:  # a non-number for --h/--cols/--max or a strip time
        fail(f"bad number: {e}")
