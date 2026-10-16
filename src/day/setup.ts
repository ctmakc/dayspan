/** The 2D setup card shown before entering XR (and after exiting). */
import { type State, parseTasks, tasksToText, save, fmtDur, SAMPLE_TASKS } from './model.js';

export interface SetupHooks {
  onEnterXR: (mode: 'ar' | 'vr') => void;
  onPreview: () => void;
  onTasksChanged: () => void;
}

const HOURS = Array.from({ length: 17 }, (_, i) => i + 5); // 5:00 .. 21:00

export function mountSetup(state: State, hooks: SetupHooks): { show: () => void; hide: () => void } {
  const root = document.getElementById('setup')!;
  const ta = root.querySelector<HTMLTextAreaElement>('#tasks')!;
  const start = root.querySelector<HTMLSelectElement>('#start')!;
  const end = root.querySelector<HTMLSelectElement>('#end')!;
  const sum = root.querySelector<HTMLElement>('#sum')!;
  const enter = root.querySelector<HTMLButtonElement>('#enter')!;
  const preview = root.querySelector<HTMLButtonElement>('#preview')!;
  const enterVR = root.querySelector<HTMLButtonElement>('#enter-vr')!;
  const sample = root.querySelector<HTMLButtonElement>('#sample')!;
  const status = root.querySelector<HTMLElement>('#xr-status')!;

  for (const sel of [start, end]) {
    sel.innerHTML = HOURS.map((h) => `<option value="${h * 60}">${h}:00</option>`).join('');
  }
  start.value = String(state.dayStart);
  end.value = String(state.dayEnd);
  let shownText = tasksToText(state.tasks);
  ta.value = shownText;

  const refreshSum = () => {
    const tasks = parseTasks(ta.value);
    const total = tasks.reduce((a, t) => a + t.minutes, 0);
    const cap = parseInt(end.value, 10) - parseInt(start.value, 10);
    const over = total - cap;
    sum.innerHTML =
      `<b>${tasks.length}</b> tasks · <b>${fmtDur(total)}</b> of work for a <b>${fmtDur(Math.max(0, cap))}</b> day` +
      (over > 0 ? ` · <em>${fmtDur(over)} will not fit</em>` : '');
  };

  const apply = () => {
    let changed = false;
    if (ta.value !== shownText) {
      const parsed = parseTasks(ta.value);
      const oldByTitle = new Map(state.tasks.map((t) => [t.title.toLowerCase(), t]));
      const keepDone = state.tasks.filter((t) => t.done);
      state.tasks = [
        ...keepDone,
        ...parsed.map((t) => {
          const old = oldByTitle.get(t.title.toLowerCase());
          return old && !old.done ? { ...old, minutes: t.minutes } : t;
        }),
      ];
      const ids = new Set(state.tasks.map((t) => t.id));
      state.span = state.span.filter((id) => ids.has(id));
      shownText = ta.value;
      changed = true;
    }
    const s0 = parseInt(start.value, 10);
    const e0 = parseInt(end.value, 10);
    if (e0 > s0 && (e0 !== state.dayEnd || s0 !== state.dayStart)) {
      state.dayStart = s0;
      state.dayEnd = e0;
      changed = true;
    }
    save(state);
    if (changed) hooks.onTasksChanged();
  };

  ta.addEventListener('input', refreshSum);
  start.addEventListener('change', refreshSum);
  end.addEventListener('change', refreshSum);
  sample.addEventListener('click', () => {
    ta.value = SAMPLE_TASKS;
    refreshSum();
  });
  enter.addEventListener('click', () => {
    apply();
    hooks.onEnterXR('ar');
  });
  enterVR.addEventListener('click', () => {
    apply();
    hooks.onEnterXR('vr');
  });
  preview.addEventListener('click', () => {
    apply();
    hooks.onPreview();
  });
  refreshSum();

  void (async () => {
    try {
      const ar = await navigator.xr?.isSessionSupported('immersive-ar');
      const vr = await navigator.xr?.isSessionSupported('immersive-vr');
      enter.disabled = !ar;
      enterVR.disabled = !vr;
      const emu = !!(window as unknown as { IWER_DEVICE?: unknown }).IWER_DEVICE;
      status.textContent = ar
        ? emu
          ? 'No headset found, so this page runs the IWER emulator (an emulated Quest 3 with hands).'
          : 'Headset ready. Hands work from the first second; controllers are optional.'
        : 'This browser has no WebXR. Use "Preview on this screen", or open the page on a Quest.';
    } catch {
      status.textContent = '';
    }
  })();

  return {
    show: () => {
      shownText = tasksToText(state.tasks);
      ta.value = shownText;
      refreshSum();
      root.hidden = false;
    },
    hide: () => {
      root.hidden = true;
    },
  };
}
