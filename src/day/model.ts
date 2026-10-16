/**
 * Dayspan data model: tasks, the packed day, history rings, and localStorage persistence.
 * Pure logic, no three.js, so it can be reasoned about (and tested) on its own.
 */

export type Kind = 'focus' | 'meet' | 'admin' | 'life';

export interface Task {
  id: string;
  title: string;
  minutes: number;
  kind: Kind;
  /** How many mornings this task was left unscheduled or unfinished. */
  carried: number;
  done: boolean;
}

export interface DayRecord {
  date: string; // YYYY-MM-DD
  plannedMin: number;
  capacityMin: number;
  doneMin: number;
}

export interface State {
  version: 1;
  date: string;
  dayStart: number; // minutes after midnight
  dayEnd: number;
  tasks: Task[];
  /** Ordered ids on the span. Everything else is in the tray. */
  span: string[];
  locked: boolean;
  history: DayRecord[];
}

export const STEP_MIN = 15;
export const MIN_BLOCK = 15;
export const MAX_BLOCK = 240;

const KEY = 'dayspan.v1';

export const SAMPLE_TASKS = `Write project proposal 90m
Team standup 15m
Client call 45m
Inbox zero 30m
Lunch walk 45m
Review pull requests 60m
Expense report 30m
Design review 60m
Gym 60m
Prep slides 90m`;

const MEET = /\b(call|meet|meeting|standup|stand-up|sync|1:1|review|interview|demo)\b/i;
const ADMIN = /\b(inbox|email|e-mail|expense|invoice|admin|report|tax|forms?|bills?)\b/i;
const LIFE = /\b(lunch|walk|gym|run|break|coffee|yoga|kids|doctor|groceries)\b/i;

export function guessKind(title: string): Kind {
  if (/\bdesign review|code review|review pull/i.test(title)) {
    return /pull|code/i.test(title) ? 'focus' : 'meet';
  }
  if (LIFE.test(title)) return 'life';
  if (MEET.test(title)) return 'meet';
  if (ADMIN.test(title)) return 'admin';
  return 'focus';
}

export function snap(minutes: number): number {
  const s = Math.round(minutes / STEP_MIN) * STEP_MIN;
  return Math.max(MIN_BLOCK, Math.min(MAX_BLOCK, s));
}

let idSeq = 0;
function newId(): string {
  idSeq += 1;
  return `t${Date.now().toString(36)}${idSeq}`;
}

/**
 * Parse one task per line. Accepts "Title 90m", "Title 1h30", "Title 1.5h",
 * "Title 45 min" and an optional #focus/#meet/#admin/#life tag.
 */
export function parseTasks(text: string): Task[] {
  const out: Task[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) continue;
    let kind: Kind | null = null;
    const tag = line.match(/#(focus|meet|admin|life)\b/i);
    if (tag) {
      kind = tag[1].toLowerCase() as Kind;
      line = line.replace(tag[0], '').trim();
    }
    let minutes = 30;
    const hm = line.match(/(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?\s*(\d+)?\s*(?:m|min)?\s*$/i);
    const m = line.match(/(\d+)\s*(?:m|min|mins|minutes)\s*$/i);
    if (hm) {
      minutes = parseFloat(hm[1]) * 60 + (hm[2] ? parseInt(hm[2], 10) : 0);
      line = line.slice(0, hm.index).trim();
    } else if (m) {
      minutes = parseInt(m[1], 10);
      line = line.slice(0, m.index).trim();
    }
    line = line.replace(/[,;:\-]+$/, '').trim();
    if (!line) continue;
    const title = line.slice(0, 48);
    out.push({
      id: newId(),
      title,
      minutes: snap(minutes),
      kind: kind ?? guessKind(title),
      carried: 0,
      done: false,
    });
  }
  return out.slice(0, 16);
}

export function tasksToText(tasks: Task[]): string {
  return tasks
    .filter((t) => !t.done)
    .map((t) => `${t.title} ${t.minutes}m`)
    .join('\n');
}

export function today(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function freshState(text = SAMPLE_TASKS): State {
  return {
    version: 1,
    date: today(),
    dayStart: 9 * 60,
    dayEnd: 17 * 60,
    tasks: parseTasks(text),
    span: [],
    locked: false,
    history: [],
  };
}

export function load(): State | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as State;
    if (s.version !== 1 || !Array.isArray(s.tasks)) return null;
    return s;
  } catch {
    return null;
  }
}

export function save(s: State): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* private mode: the session still works, it just will not persist */
  }
}

export interface Placed {
  task: Task;
  start: number; // minutes after midnight
  end: number;
  overflow: boolean; // starts or ends past dayEnd
}

export function pack(s: State): Placed[] {
  const byId = new Map(s.tasks.map((t) => [t.id, t]));
  let cursor = s.dayStart;
  const out: Placed[] = [];
  for (const id of s.span) {
    const task = byId.get(id);
    if (!task) continue;
    const start = cursor;
    const end = cursor + task.minutes;
    out.push({ task, start, end, overflow: end > s.dayEnd });
    cursor = end;
  }
  return out;
}

export interface Totals {
  capacity: number;
  planned: number;
  overflow: number;
  done: number;
  inTray: number;
}

export function totals(s: State): Totals {
  const placed = pack(s);
  const planned = placed.reduce((a, p) => a + p.task.minutes, 0);
  const capacity = s.dayEnd - s.dayStart;
  const done = placed.filter((p) => p.task.done).reduce((a, p) => a + p.task.minutes, 0);
  const inTray = s.tasks.filter((t) => !s.span.includes(t.id) && !t.done).length;
  return { capacity, planned, overflow: Math.max(0, planned - capacity), done, inTray };
}

/** Lock today's plan: writes (or rewrites) today's ring. */
export function lockDay(s: State): void {
  const t = totals(s);
  s.locked = true;
  const rec: DayRecord = {
    date: s.date,
    plannedMin: t.planned,
    capacityMin: t.capacity,
    doneMin: t.done,
  };
  const i = s.history.findIndex((h) => h.date === s.date);
  if (i >= 0) s.history[i] = rec;
  else s.history.push(rec);
  s.history = s.history.slice(-30);
}

export function refreshRing(s: State): void {
  if (!s.locked) return;
  const i = s.history.findIndex((h) => h.date === s.date);
  if (i >= 0) s.history[i].doneMin = totals(s).done;
}

/**
 * Roll over to the next morning: done tasks leave, everything unfinished goes back to the
 * tray with one more carry notch. Used both on a real new date and by the demo control.
 */
export function rollOver(s: State, date: string): void {
  refreshRing(s);
  s.tasks = s.tasks
    .filter((t) => !t.done)
    .map((t) => ({ ...t, carried: Math.min(5, t.carried + 1) }));
  s.span = [];
  s.locked = false;
  s.date = date;
}

export function nextDate(date: string): string {
  const [y, m, d] = date.split('-').map((x) => parseInt(x, 10));
  return today(new Date(y, m - 1, d + 1));
}

export function fmtDur(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function fmtClock(min: number): string {
  const h = Math.floor(min / 60) % 24;
  const m = Math.round(min % 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
