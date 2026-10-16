/** Canvas-drawn labels for tiles, the rule and the panel. Fonts are self-hosted (public/fonts). */
import { CanvasTexture, SRGBColorSpace, LinearFilter } from '@iwsdk/core';
import { FONT_LABEL, FONT_TIME, KIND_COLOR, T } from './tokens.js';
import { fmtClock, fmtDur, type Task } from './model.js';

export const PX_PER_M = 4200;

export async function loadFonts(): Promise<void> {
  const base = import.meta.env.BASE_URL;
  const faces = [
    new FontFace('Lexend', `url(${base}fonts/lexend-latin.woff2)`, { weight: '100 900' }),
    new FontFace('Spline Sans Mono', `url(${base}fonts/spline-sans-mono-latin.woff2)`, {
      weight: '300 700',
    }),
  ];
  await Promise.all(
    faces.map(async (f) => {
      try {
        await f.load();
        document.fonts.add(f);
      } catch {
        /* fall back to system fonts */
      }
    }),
  );
}

export function makeTexture(canvas: HTMLCanvasElement): CanvasTexture {
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.generateMipmaps = false;
  tex.anisotropy = 4;
  return tex;
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.length > 1 ? s.trimEnd() + '…' : '';
}

export interface TileLook {
  overflow: boolean;
  done: boolean;
  start?: number;
  stretching?: boolean;
}

/** Face of a tile: kind color, title, duration, carry notches. */
export function drawTile(
  canvas: HTMLCanvasElement,
  task: Task,
  widthM: number,
  heightM: number,
  look: TileLook,
): void {
  const w = Math.max(32, Math.round(widthM * PX_PER_M));
  const h = Math.round(heightM * PX_PER_M);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  const bg = look.done ? T.spent : KIND_COLOR[task.kind];
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // painted-wood grain: a few faint horizontal strokes, deterministic per task id
  let seed = 0;
  for (const c of task.id) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  ctx.globalAlpha = 0.07;
  ctx.strokeStyle = T.ink;
  for (let i = 0; i < 6; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const y = (seed % 1000) / 1000;
    ctx.lineWidth = 1 + (seed % 3);
    ctx.beginPath();
    ctx.moveTo(0, y * h);
    ctx.bezierCurveTo(w * 0.3, y * h + 6, w * 0.7, y * h - 6, w, y * h + 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  const pad = Math.round(h * 0.13);
  const textColor = T.chalk;
  ctx.fillStyle = textColor;
  ctx.textBaseline = 'alphabetic';

  const dur = fmtDur(task.minutes);
  const narrow = widthM < 0.05;
  if (narrow) {
    ctx.font = `600 ${Math.round(h * 0.3)}px ${FONT_TIME}`;
    ctx.textAlign = 'center';
    ctx.fillText(fitText(ctx, dur, w - 8), w / 2, h * 0.62);
    ctx.textAlign = 'left';
  } else {
    ctx.font = `600 ${Math.round(h * 0.29)}px ${FONT_LABEL}`;
    ctx.fillText(fitText(ctx, task.title, w - pad * 2 - (task.carried ? h * 0.35 : 0)), pad, h * 0.42);
    ctx.font = `500 ${Math.round(h * 0.22)}px ${FONT_TIME}`;
    ctx.globalAlpha = 0.86;
    const time = look.start != null ? `${fmtClock(look.start)}  ${dur}` : dur;
    ctx.fillText(fitText(ctx, time, w - pad * 2), pad, h * 0.8);
    ctx.globalAlpha = 1;
  }

  // carry notches: one short bar per morning this task was pushed
  if (task.carried > 0 && !narrow) {
    ctx.fillStyle = T.chalk;
    for (let i = 0; i < task.carried; i++) {
      ctx.fillRect(w - pad - i * h * 0.09 - h * 0.035, pad * 0.9, h * 0.035, h * 0.2);
    }
  }

  if (look.done) {
    ctx.strokeStyle = T.chalk;
    ctx.lineWidth = h * 0.05;
    ctx.beginPath();
    const cx = w - pad - h * 0.2;
    ctx.moveTo(cx - h * 0.12, h * 0.62);
    ctx.lineTo(cx - h * 0.03, h * 0.72);
    ctx.lineTo(cx + h * 0.14, h * 0.5);
    ctx.stroke();
  }

  if (look.overflow && !look.done) {
    // flagging tape along the bottom edge
    ctx.fillStyle = T.flag;
    ctx.fillRect(0, h - h * 0.11, w, h * 0.11);
  }
  if (look.stretching) {
    ctx.strokeStyle = T.chalk;
    ctx.lineWidth = h * 0.04;
    ctx.strokeRect(h * 0.02, h * 0.02, w - h * 0.04, h - h * 0.04);
  }
}

/**
 * The rule: hour numerals strip on top, ticks below. Drawn for the full arc including the
 * overflow zone so the texture maps 1:1 onto the band's angle range.
 */
export function drawRule(
  canvas: HTMLCanvasElement,
  opts: { start: number; end: number; minutesTotal: number; widthPx: number; heightPx: number; numeralsPx: number },
): void {
  const { start, end, minutesTotal, widthPx: w, heightPx: h, numeralsPx } = opts;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  const capacity = end - start;
  const endX = (capacity / minutesTotal) * w;
  ctx.clearRect(0, 0, w, h);
  // enamel body for the work day
  ctx.fillStyle = T.enamel;
  ctx.fillRect(0, numeralsPx, endX, h - numeralsPx);
  // overflow zone: dashed outline only
  ctx.strokeStyle = T.flag;
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 10]);
  ctx.strokeRect(endX + 2, numeralsPx + 2, w - endX - 4, h - numeralsPx - 4);
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;

  const pxPerMin = w / minutesTotal;
  for (let m = 0; m <= minutesTotal; m += 15) {
    const x = Math.round(m * pxPerMin);
    const abs = start + m;
    const isHour = abs % 60 === 0;
    const isHalf = abs % 30 === 0;
    const len = isHour ? (h - numeralsPx) * 0.5 : isHalf ? (h - numeralsPx) * 0.32 : (h - numeralsPx) * 0.18;
    ctx.fillStyle = m <= capacity ? T.ink : T.flag;
    ctx.fillRect(x - (isHour ? 2 : 1), numeralsPx, isHour ? 4 : 2, len);
    if (isHour) {
      ctx.font = `600 ${Math.round(numeralsPx * 0.62)}px ${FONT_TIME}`;
      ctx.textAlign = 'center';
      ctx.fillStyle = m <= capacity ? T.enamel : T.flag;
      ctx.fillText(fmtClock(abs), Math.min(w - 40, Math.max(40, x)), numeralsPx * 0.72);
    }
  }
}

export interface PanelView {
  title: string;
  date: string;
  planned: number;
  capacity: number;
  overflow: number;
  inTray: number;
  done: number;
  locked: boolean;
  desk?: boolean;
  coach: string;
  buttons: { id: string; label: string; primary?: boolean; disabled?: boolean }[];
}

export const PANEL_W = 0.3;
export const PANEL_H = 0.25;

/** Panel face (buttons are separate meshes, but their labels are drawn here too). */
export function drawPanel(canvas: HTMLCanvasElement, v: PanelView, btnRects: Map<string, [number, number, number, number]>): void {
  const s = PX_PER_M * 0.6;
  const w = Math.round(PANEL_W * s);
  const h = Math.round(PANEL_H * s);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = T.slate;
  ctx.fillRect(0, 0, w, h);
  const pad = w * 0.06;
  ctx.textAlign = 'left';
  ctx.fillStyle = T.chalk;
  ctx.font = `700 ${Math.round(h * 0.075)}px ${FONT_LABEL}`;
  ctx.fillText(v.title, pad, pad + h * 0.06);
  ctx.font = `500 ${Math.round(h * 0.042)}px ${FONT_TIME}`;
  ctx.globalAlpha = 0.6;
  ctx.textAlign = 'right';
  ctx.fillText(v.date, w - pad, pad + h * 0.055);
  ctx.textAlign = 'left';
  ctx.globalAlpha = 1;

  // the meter: planned vs capacity, overflow in flag pink
  const my = pad + h * 0.14;
  const mw = w - pad * 2;
  const mh = h * 0.05;
  const scale = Math.max(v.capacity, v.planned);
  ctx.fillStyle = '#2A3138';
  ctx.fillRect(pad, my, (v.capacity / scale) * mw, mh);
  ctx.fillStyle = T.enamel;
  ctx.fillRect(pad, my, (Math.min(v.planned, v.capacity) / scale) * mw, mh);
  if (v.overflow > 0) {
    ctx.fillStyle = T.flag;
    ctx.fillRect(pad + (v.capacity / scale) * mw, my, (v.overflow / scale) * mw, mh);
  }
  if (v.done > 0) {
    ctx.fillStyle = T.life;
    ctx.fillRect(pad, my + mh + 4, (Math.min(v.done, scale) / scale) * mw, mh * 0.35);
  }

  const ly = my + mh + h * 0.09;
  ctx.font = `600 ${Math.round(h * 0.05)}px ${FONT_TIME}`;
  ctx.fillStyle = T.chalk;
  ctx.fillText(`${fmtDur(v.planned)} of ${fmtDur(v.capacity)}`, pad, ly);
  if (v.overflow > 0) {
    ctx.fillStyle = T.flag;
    ctx.textAlign = 'right';
    ctx.fillText(`+${fmtDur(v.overflow)} over`, w - pad, ly);
    ctx.textAlign = 'left';
  } else if (v.planned > 0) {
    ctx.globalAlpha = 0.6;
    ctx.textAlign = 'right';
    ctx.fillText(v.locked ? `${fmtDur(v.done)} done` : `${fmtDur(v.capacity - v.planned)} free`, w - pad, ly);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
  ctx.font = `400 ${Math.round(h * 0.044)}px ${FONT_LABEL}`;
  ctx.fillStyle = T.chalk;
  ctx.globalAlpha = 0.66;
  ctx.fillText(`${v.inTray} in tray${v.desk ? ', resting on your desk' : ''}${v.locked ? '  ·  plan locked' : ''}`, pad, ly + h * 0.065);
  ctx.globalAlpha = 1;

  // coach line, wrapped to two lines
  ctx.font = `600 ${Math.round(h * 0.05)}px ${FONT_LABEL}`;
  ctx.fillStyle = T.chalk;
  const words = v.coach.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const t = cur ? cur + ' ' + word : word;
    if (ctx.measureText(t).width > w - pad * 2) {
      lines.push(cur);
      cur = word;
    } else cur = t;
  }
  if (cur) lines.push(cur);
  const cy = ly + h * 0.16;
  ctx.fillStyle = T.flag;
  ctx.fillRect(pad, cy - h * 0.045, 4, h * 0.06 * Math.min(3, lines.length) + h * 0.01);
  ctx.fillStyle = T.chalk;
  lines.slice(0, 3).forEach((l, i) => ctx.fillText(l, pad + 14, cy + i * h * 0.062));

  // buttons
  for (const b of v.buttons) {
    const r = btnRects.get(b.id);
    if (!r) continue;
    const [bx, by, bw, bh] = r.map((x, i) => (i % 2 === 0 ? x * w : x * h)) as [number, number, number, number];
    ctx.globalAlpha = b.disabled ? 0.35 : 1;
    ctx.fillStyle = b.primary ? T.enamel : '#262D34';
    ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = b.primary ? T.ink : T.chalk;
    ctx.font = `700 ${Math.round(bh * 0.36)}px ${FONT_LABEL}`;
    ctx.textAlign = 'center';
    ctx.fillText(b.label, bx + bw / 2, by + bh * 0.63);
    ctx.textAlign = 'left';
    ctx.globalAlpha = 1;
  }
}

export function drawText(
  canvas: HTMLCanvasElement,
  lines: { text: string; font: string; color: string; size: number }[],
  w: number,
  h: number,
  align: CanvasTextAlign = 'left',
): void {
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  let y = 0;
  ctx.textAlign = align;
  for (const l of lines) {
    y += l.size * 1.15;
    ctx.font = `${l.font === 'time' ? `600 ${l.size}px ${FONT_TIME}` : `600 ${l.size}px ${FONT_LABEL}`}`;
    ctx.fillStyle = l.color;
    ctx.fillText(l.text, align === 'center' ? w / 2 : align === 'right' ? w : 0, y);
  }
}
