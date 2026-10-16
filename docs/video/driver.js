// In-page gesture driver for the emulated headset and hands (IWER). Runs on the recording clock
// (window.__clock, seconds), so every gesture lands on exact frames. One call per gesture.
window.__drv = (() => {
  const D = () => window.IWER_DEVICE;
  const C = () => window.__clock;
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const ease = (u) => 0.5 - 0.5 * Math.cos(Math.PI * u);
  const delta = { left: [0, 0, 0], right: [0, 0, 0] };
  let head = { pitch: 0, yaw: 0 };
  const quat = (pitch, yaw) => {
    const p = (pitch * Math.PI) / 180, y = (yaw * Math.PI) / 180;
    const cy = Math.cos(y / 2), sy = Math.sin(y / 2), cp = Math.cos(p / 2), sp = Math.sin(p / 2);
    return [cy * sp, sy * cp, -sy * sp, cy * cp];
  };
  const setHead = (pitch, yaw) => {
    const q = quat(pitch, yaw);
    D().quaternion.set(q[0], q[1], q[2], q[3]);
    head = { pitch, yaw };
  };
  async function tween(sec, fn) {
    const t0 = C().t;
    for (;;) {
      await C().next();
      const u = Math.min(1, (C().t - t0) / Math.max(1e-6, sec));
      fn(ease(u), u);
      if (u >= 1) break;
    }
  }
  const handPos = (h) => { const p = D().hands[h].position; return [p.x, p.y, p.z]; };
  const setHand = (h, p) => D().hands[h].position.set(p[0], p[1], p[2]);
  const pt = (h, key) => window.__dayspan.handPoint(h)[key];
  return {
    setHead,
    async look(pitch, yaw, sec) {
      const a = { ...head };
      await tween(sec, (e) => setHead(a.pitch + (pitch - a.pitch) * e, a.yaw + (yaw - a.yaw) * e));
    },
    async calibrate(h) {
      const hand = D().hands[h];
      const settle = async () => { for (let i = 0; i < 4; i++) await raf(); };
      hand.updatePinchValue(0); await settle();
      const a = pt(h, 'p');
      hand.updatePinchValue(1); await settle();
      const b = pt(h, 'p');
      hand.updatePinchValue(0); await settle();
      delta[h] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      return delta[h];
    },
    async glide(h, target, sec, key = 'p') {
      const cur = pt(h, key), hp = handPos(h);
      const goal = [0, 1, 2].map((i) => target[i] - (cur[i] - hp[i]));
      await tween(sec, (e) => setHand(h, [0, 1, 2].map((i) => hp[i] + (goal[i] - hp[i]) * e)));
    },
    async squeeze(h, on, sec) {
      const hp = handPos(h), dl = delta[h];
      const base = on ? hp : [0, 1, 2].map((i) => hp[i] + dl[i]);
      await tween(sec, (_, u) => {
        const v = on ? u : 1 - u;
        setHand(h, [0, 1, 2].map((i) => base[i] - dl[i] * v));
        D().hands[h].updatePinchValue(v);
      });
      await C().next();
    },
    async pull(h, dx, dz, sec) {
      const hp = handPos(h);
      await tween(sec, (e) => setHand(h, [hp[0] + dx * e, hp[1], hp[2] + dz * e]));
    },
  };
})();
