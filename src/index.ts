/**
 * Dayspan: a hands-first morning planning ritual for Meta Quest, built with IWSDK (WebXR).
 */
import { World, VisibilityState, SessionMode } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { DaySystem } from './day/day-system.js';
import { loadFonts } from './day/labels.js';
import { load, freshState, rollOver, today, save, type State } from './day/model.js';
import { mountSetup } from './day/setup.js';
import { unlockAudio } from './day/sound.js';

async function main() {
  await loadFonts();
  let state: State = load() ?? freshState();
  if (state.date !== today()) {
    // a real new morning: unfinished work comes back to the tray with a carry notch
    rollOver(state, today());
  }
  save(state);
  (window as unknown as { __dayspanState: State }).__dayspanState = state;

  const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, projectOptions);
  world.registerSystem(DaySystem);
  const sys = world.getSystem(DaySystem)!;

  const setup = mountSetup(state, {
    onEnterXR: (mode) => {
      unlockAudio();
      setup.hide();
      world.launchXR({ sessionMode: mode === 'vr' ? SessionMode.ImmersiveVR : SessionMode.ImmersiveAR });
    },
    onPreview: () => {
      unlockAudio();
      setup.hide();
      document.body.classList.add('preview');
    },
    onTasksChanged: () => sys.rebuild(),
  });

  document.getElementById('back')?.addEventListener('click', () => {
    document.body.classList.remove('preview');
    setup.show();
  });

  world.visibilityState.subscribe((v) => {
    if (v === VisibilityState.NonImmersive) {
      if (!document.body.classList.contains('preview')) setup.show();
    } else {
      setup.hide();
    }
  });
  if (new URLSearchParams(location.search).has('preview')) {
    setup.hide();
    document.body.classList.add('preview');
  }
}

void main();
