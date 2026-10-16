/** Procedural sound: a short wooden "tok" and a two-note lock chord. No audio assets. */
let ctx: AudioContext | null = null;

function ac(): AudioContext | null {
  try {
    if (!ctx) ctx = new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

export function unlockAudio(): void {
  ac();
}

export function tok(pitch = 1, gain = 0.35): void {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(820 * pitch, t);
  osc.frequency.exponentialRampToValueAtTime(260 * pitch, t + 0.07);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
  osc.connect(g).connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.14);
}

export function lift(): void {
  tok(1.6, 0.12);
}

export function chord(): void {
  const c = ac();
  if (!c) return;
  const t = c.currentTime;
  [392, 587.33].forEach((f, i) => {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = f;
    const s = t + i * 0.09;
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(0.18, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.9);
    osc.connect(g).connect(c.destination);
    osc.start(s);
    osc.stop(s + 1);
  });
}

export function thud(): void {
  tok(0.55, 0.3);
}
