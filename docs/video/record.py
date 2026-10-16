#!/usr/bin/env python3
"""Record the Dayspan demo inside the IWER emulator (Meta Quest 3 profile) with scripted hands.

Real app, real input path: the script only moves the emulated headset and hands and changes the
emulated pinch value; Dayspan's own hand-joint pinch detection, snapping and layout do the rest.

Frame-exact capture: the page runs with ?vclock, so Dayspan reads time from window.__clock. A
capture loop advances that clock by 1/FPS, lets the emulator render, and grabs a screenshot. The
gesture driver (driver.js) also runs on that clock. The result is smooth footage even on a
heavily loaded machine; nothing is sped up or interpolated.

Usage: python3 docs/video/record.py <base-url>   (e.g. http://127.0.0.1:18321/)
Output: docs/video/out/{setup.png, frames/*.jpg, events.json}
"""
from __future__ import annotations

import asyncio
import base64
import json
import pathlib
import shutil
import sys

from playwright.async_api import async_playwright

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "out"
DUR = json.loads((OUT / "durations.json").read_text())
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18321/"
URL = BASE + "?clock=8:20&vclock=1"
W, H = 1920, 1080
FPS = 25
SCALE = 1600 / 1920  # capture at 1600x900
HEAD = [0.0, 1.25, 0.0]
PART = (sys.argv[2] if len(sys.argv) > 2 else "vr")  # "vr" or "mr": recorded by separate runs
FR = OUT / f"frames_{PART}"

CLOCK_JS = """
window.__clock = (() => {
  const c = { t: 0, waiters: [] };
  const xrFrame = () => new Promise((r) => {
    const s = window.IWER_DEVICE && window.IWER_DEVICE.activeSession;
    if (s) s.requestAnimationFrame(() => r()); else requestAnimationFrame(() => r());
  });
  c.next = () => new Promise((r) => c.waiters.push({ until: -1, r }));
  c.sleep = (s) => new Promise((r) => c.waiters.push({ until: c.t + s, r }));
  c.step = async (dt) => {
    c.t += dt;
    const keep = [];
    for (const w of c.waiters) { if (w.until < 0 || c.t >= w.until - 1e-9) w.r(); else keep.push(w); }
    c.waiters = keep;
    await new Promise((r) => setTimeout(r, 0));   // let gesture code apply this step's poses
    await xrFrame(); await xrFrame();              // render with them
    return c.t;
  };
  return c;
})();
"""


class Rec:
    def __init__(self, pg):
        self.pg = pg
        self.events: list[dict] = []
        self.capturing = False

    async def js(self, code, arg=None):
        return await self.pg.evaluate(code, arg)

    async def now(self):
        return await self.js("()=>__clock.t")

    async def ev(self, kind, **kw):
        self.events.append({"t": await self.now(), "kind": kind, **kw})
        (OUT / f"events_{PART}.json").write_text(json.dumps(self.events, indent=0))

    async def wait(self, s):
        await self.js("(s)=>__clock.sleep(s)", s)

    async def drv(self, call, *args):
        return await self.pg.evaluate(f"(a)=>window.__drv.{call}(...a)", list(args))

    async def look(self, pitch, yaw, dur=0.7):
        await self.drv("look", pitch, yaw, dur)

    async def glide(self, h, target, dur=0.7):
        await self.drv("glide", h, target, dur, "p")

    async def glide_tip(self, h, target, dur=0.6):
        await self.drv("glide", h, target, dur, "tip")

    async def squeeze(self, h, on, dur=0.22):
        await self.drv("squeeze", h, on, dur)

    async def pull(self, h, dx, dz, dur):
        await self.drv("pull", h, dx, dz, dur)

    async def park(self, h, dur=0.5):
        x = 0.2 if h == "right" else -0.2
        p = await self.js("([x])=>__dayspan.worldOfRoot(x,-0.4,-0.22)", [x])
        await self.glide(h, p, dur)

    async def tile(self, title):
        return await self.js("(t)=>__dayspan.worldOfTile(t)", title)

    async def span_at(self, minute):
        return await self.js("(m)=>__dayspan.worldOfSpan(m, 0, -0.03)", minute)

    async def planned(self):
        return await self.js("()=>__dayspan.totals().planned")

    async def reach(self, h, title, dur):
        """Glide to a tile, then home in again in case the tray reflowed while the hand moved."""
        await self.glide(h, await self.tile(title), dur)
        for _ in range(3):
            tgt = await self.tile(title)
            cur = (await self.js("(h)=>__dayspan.handPoint(h)", h))["p"]
            if sum((tgt[i] - cur[i]) ** 2 for i in range(3)) < 0.006 ** 2:
                break
            await self.glide(h, tgt, 0.15)

    async def move_tile(self, title, minute=None, dest=None, h="right", t_reach=0.6, t_carry=0.7):
        await self.wait(0.25)
        await self.reach(h, title, t_reach)
        await self.squeeze(h, True)
        held = (await self.js("(h)=>__dayspan.handPoint(h)", h))["held"]
        if not held:
            print("MISSED pick", title, flush=True)
        await self.ev("lift")
        if dest is None:
            dest = await self.span_at((await self.planned()) + 8 if minute is None else minute)
        await self.glide(h, dest, t_carry)
        await self.wait(0.1)
        await self.squeeze(h, False)
        await self.ev("tok")
        await self.wait(0.15)

    async def poke(self, h, button):
        front = await self.js("(b)=>__dayspan.worldOfButton(b, 0.04)", button)
        back = await self.js("(b)=>__dayspan.worldOfButton(b, -0.012)", button)
        await self.glide_tip(h, front, 0.6)
        await self.wait(0.1)
        await self.glide_tip(h, back, 0.2)
        await self.ev("tok")
        await self.wait(0.12)
        await self.glide_tip(h, front, 0.25)

    async def enter(self, sel):
        await self.pg.click(sel)
        for _ in range(200):
            await asyncio.sleep(0.1)
            if await self.js("()=>!!(window.__dayspan && __dayspan.anchored())"):
                break
        await self.js("()=>{IWER_DEVICE.controlMode='programmatic'; IWER_DEVICE.primaryInputMode='hand'; IWER_DEVICE.fovy=1.2;}")
        await self.js("""()=>{const hide=()=>{const walk=(r)=>{for(const el of r.querySelectorAll('*')){if(el.shadowRoot)walk(el.shadowRoot);
          const st=el.getAttribute&&(el.getAttribute('style')||''); if(/59, 130, 246/.test(st)) el.style.display='none';}}; walk(document);};
          hide(); setInterval(hide,200);}""")


class Scene:
    def __init__(self, rec: Rec, key: str, pad: float = 0.5):
        self.rec, self.key, self.pad = rec, key, pad

    async def __aenter__(self):
        self.t0 = await self.rec.now()
        await self.rec.ev("scene", key=self.key)
        return self

    async def __aexit__(self, *a):
        need = DUR.get(self.key, 0) + self.pad
        left = need - (await self.rec.now() - self.t0)
        if left > 0:
            await self.rec.wait(left)
        print(f"scene {self.key}: {await self.rec.now() - self.t0:.1f}s (voice {DUR.get(self.key, 0):.1f}s)", flush=True)


async def capture_loop(rec: Rec, cdp, stop: asyncio.Event):
    n = 0
    while not stop.is_set():
        await rec.js("(dt)=>__clock.step(dt)", 1 / FPS)
        if rec.capturing:
            shot = await cdp.send("Page.captureScreenshot", {"format": "jpeg", "quality": 88,
                                "clip": {"x": 0, "y": 0, "width": W, "height": H, "scale": SCALE}})
            n += 1
            (FR / f"{n:06d}.jpg").write_bytes(base64.b64decode(shot["data"]))
            if n % 300 == 0:
                print(f"  {n} frames ({n / FPS:.0f}s)", flush=True)
    return n


async def script(rec: Rec, pg):
    r = rec
    async with Scene(r, "intro", 0.6):
        await pg.screenshot(path=str(OUT / "setup.png"))
    await r.enter("#enter-vr")
    await r.drv("setHead", -6, 0)
    await r.js("()=>{IWER_DEVICE.hands.right.position.set(0.24,0.8,-0.2);IWER_DEVICE.hands.left.position.set(-0.24,0.8,-0.2);}")
    await r.wait(0.2)
    await r.drv("calibrate", "right")
    await r.drv("calibrate", "left")
    rec.capturing = True
    await r.ev("seg_start", seg="vr")

    async with Scene(r, "enter", 0.3):
        await r.look(-27, 0, 2.2)
        await r.park("right", 0.6)
        await r.park("left", 0.6)

    async with Scene(r, "place", 0.3):
        for t in ["Write project proposal", "Team standup", "Client call"]:
            await r.move_tile(t, t_reach=0.5, t_carry=0.6)
        await r.park("right", 0.4)

    async with Scene(r, "stretch", 0.5):
        await r.reach("right", "Review pull requests", 0.5)
        await r.squeeze("right", True)
        await r.ev("lift")
        await r.glide("right", await r.js("()=>__dayspan.worldOfRoot(0.07,-0.3,-0.42)"), 0.6)
        await r.wait(0.3)
        await r.glide("left", await r.js("()=>__dayspan.worldOfTileEdge('Review pull requests',-1)"), 0.6)
        await r.squeeze("left", True)
        await r.ev("lift")
        await r.pull("left", -0.072, 0.012, 1.6)
        await r.ev("tick")
        await r.wait(0.5)
        await r.squeeze("left", False)
        await r.park("left", 0.4)
        await r.glide("right", await r.span_at((await r.planned()) + 8), 0.7)
        await r.squeeze("right", False)
        await r.ev("tok")
        await r.park("right", 0.4)

    async with Scene(r, "fill", 0.4):
        for t in ["Lunch walk", "Design review", "Prep slides", "Gym"]:
            await r.move_tile(t, t_reach=0.45, t_carry=0.55)
        await r.park("right", 0.4)
        await r.look(-22, -24, 0.9)
        await r.wait(1.2)

    async with Scene(r, "putback", 0.6):
        await r.move_tile("Gym", dest=await r.js("()=>__dayspan.worldOfRoot(0.12,-0.47,-0.36)"), t_reach=0.7, t_carry=0.8)
        await r.ev("thud")
        await r.park("right", 0.4)
        await r.look(-27, 0, 0.8)

    async with Scene(r, "lock", 0.6):
        await r.look(-30, 22, 0.7)
        await r.poke("left", "lock")
        await r.ev("chord")
        await r.park("left", 0.4)
        await r.look(-30, -24, 0.9)

    async with Scene(r, "done", 0.4):
        await r.look(-25, 6, 0.6)
        await r.reach("right", "Write project proposal", 0.6)
        await r.squeeze("right", True, 0.12)
        await r.squeeze("right", False, 0.12)
        await r.ev("chord")
        await r.park("right", 0.5)

    async with Scene(r, "next", 0.6):
        await r.look(-30, 22, 0.6)
        await r.poke("left", "next")
        await r.park("left", 0.4)
        await r.look(-33, 0, 0.8)
        await r.wait(0.6)
    rec.capturing = False
    await r.ev("seg_stop", seg="vr")


async def script_mr(rec: Rec, pg):
    """Passthrough: sit at a table in the emulator's synthetic room and enter AR."""
    r = rec
    await r.js("()=>{IWER_DEVICE.controlMode='programmatic'; IWER_DEVICE.position.set(-0.80,1.25,0.15);}")
    await r.drv("setHead", -28, 90)
    await r.enter("#enter")
    # the session start can reset the emulated pose: re-apply it and re-anchor Dayspan to it
    await r.js("()=>{IWER_DEVICE.position.set(-0.80,1.25,0.15);}")
    await r.drv("setHead", -28, 90)
    await r.wait(0.2)
    await r.js("()=>__dayspan.recenter()")
    for _ in range(100):
        await asyncio.sleep(0.1)
        if await r.js("()=>__dayspan.anchored()"):
            break
    await r.wait(1.5)
    await r.js("()=>{IWER_DEVICE.hands.right.position.set(-0.55,0.8,0.0);IWER_DEVICE.hands.left.position.set(-0.55,0.8,0.4);}")
    await r.drv("calibrate", "right")
    await r.drv("calibrate", "left")
    rec.capturing = True
    await r.ev("seg_start", seg="mr")
    async with Scene(r, "mr", 0.5):
        await r.wait(2.0)
        print("desk", await r.js("()=>__dayspan.desk()"), await r.js("()=>__dayspan.mode()"), flush=True)
        await r.park("right", 0.6)
        await r.wait(0.8)
        await r.move_tile("Write project proposal", minute=10, t_reach=0.7, t_carry=0.8)
        await r.park("right", 0.5)

    async with Scene(r, "outro", 1.2):
        await r.look(-20, 90, 1.5)
        await r.wait(2.0)
    await r.ev("seg_stop", seg="mr")
    rec.capturing = False


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    if FR.exists():
        shutil.rmtree(FR)
    FR.mkdir(parents=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, args=["--use-angle=vulkan", "--enable-features=Vulkan", "--ignore-gpu-blocklist"])
        ctx = await b.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
        pg = await ctx.new_page()
        pg.on("pageerror", lambda e: print("PAGEERROR", str(e)[:300]))
        await pg.goto(URL)
        await pg.wait_for_timeout(3000)
        await pg.evaluate("()=>localStorage.clear()")
        await pg.reload()
        await pg.wait_for_timeout(4000)
        await pg.evaluate(CLOCK_JS)
        await pg.evaluate((HERE / "driver.js").read_text())
        rec = Rec(pg)
        await rec.js("(h)=>IWER_DEVICE.position.set(h[0],h[1],h[2])", HEAD)
        cdp = await ctx.new_cdp_session(pg)
        stop = asyncio.Event()
        cap = asyncio.create_task(capture_loop(rec, cdp, stop))
        try:
            await (script(rec, pg) if PART == "vr" else script_mr(rec, pg))
        finally:
            stop.set()
            n = await cap
            await b.close()
            (OUT / f"events_{PART}.json").write_text(json.dumps(rec.events, indent=0))
    print("frames", n, f"= {n / FPS:.1f}s at {FPS} fps")


if __name__ == "__main__":
    asyncio.run(main())
