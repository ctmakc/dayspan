# Dayspan

**Hold your day in your hands.** Dayspan is a seated, ten-minute morning planning ritual for
Meta Quest. Today's tasks are physical tiles, each as long as the time it takes. You pinch them
out of a tray on your desk and drop them onto the *span*, a curved timeline of your work hours
that floats in front of you. Whatever does not fit hangs past a pink flag at the end of the day,
where you can see it, before 9 a.m. instead of at 6 p.m.

Try it: **https://ctmakc.github.io/dayspan/** (Meta Quest Browser, or any desktop browser with the
built-in IWER emulator).

Built with [IWSDK](https://iwsdk.dev) (Immersive Web SDK, WebXR) for the Meta VR Start Developer
Competition 2026, Productivity track, New Experience division. Conceived and built from scratch in
October 2026.

## The ritual

1. **Write the list** on the 2D page (one task per line, `Write proposal 90m`, `Client call 45 min`,
   `Deep work 1h30`). On a Quest you can type it with the system keyboard before entering.
2. **Enter mixed reality.** The span appears at eye level, the tray rests on your desk. In passthrough
   Dayspan looks for a real table under the tray (WebXR plane detection) and sets the tray on it.
3. **Pinch a tile, drop it on the span.** Tiles snap into order and the ones after ripple aside.
4. **Pull a tile with both hands to resize it.** The tile's length is the rule's scale: on a 9-to-5
   span, pulling your hands 3.4 cm further apart adds exactly 15 minutes.
5. **Overtime is visible.** Tiles past the flagging-tape flag at the end of the day tip over and get a
   pink edge; the panel says how much is over. Trim, or put tiles back in the tray.
6. **Poke "Lock day".** The plan is saved and today's ring appears in the growth rings.
7. **Through the day, pinch-tap a tile when it is done.** The ring thickens with completed hours.
8. **Next morning**, unfinished tiles come back to the tray with one notch for each day they were
   pushed. Rings stay pink for days that were planned over capacity and green for days that fit.

Everything works with hands alone. Controllers work too (trigger or grip = pinch). In the desktop
preview, drag tiles with the mouse and scroll over a tile to resize it.

## Hands-first details

- Pinch detection uses thumb-tip and index-tip joints with hysteresis (start below 1.8 cm, release
  above 3.5 cm), so tiles do not slip out of a relaxed pinch.
- Panel buttons react to a poke (index fingertip passing through the button face) or a pinch.
- Seated and FoV-aware: the span sits 0.7 m away across ±44°, the tray and controls live within a
  2-foot reach, and everything is anchored to where your head is when the session starts
  ("Recenter" re-anchors).
- Sounds are synthesized with WebAudio: a wooden "tok" when a tile lands, a two-note chord on lock.

## Run locally

```bash
npm install
npm run dev:runtime   # Vite dev server on https://localhost:8081 with the IWER emulator
npm run build         # static build in dist/ (the emulator is injected for non-Quest browsers)
```

`?clock=8:20` pins the "now" needle to a time of day (used for the demo recording).

## Project layout

```
src/index.ts            World.create() + system registration, setup page wiring
src/day/day-system.ts   the span, tray, panel, rings; hand/controller/mouse input; desk detection
src/day/model.ts        tasks, packing, totals, history rings, localStorage
src/day/labels.ts       canvas-drawn tile faces, rule ticks, panel
src/day/setup.ts        the 2D task list page
src/day/sound.ts        procedural sounds
DESIGN.md               the locked design direction and tokens
```

Privacy: tasks and history stay in your browser's localStorage. Nothing is sent anywhere.

## Credits

Fonts: [Lexend](https://fonts.google.com/specimen/Lexend) and
[Spline Sans Mono](https://fonts.google.com/specimen/Spline+Sans+Mono), SIL Open Font License 1.1.
Code: MIT, see `LICENSE`.
