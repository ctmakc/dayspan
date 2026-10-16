/**
 * DaySystem: builds the span, tray, panel and rings, and runs the hands-first interaction:
 * pinch to pick up a tile, drop it on the span, pull with two hands to resize,
 * pinch-tap to mark done, poke the panel buttons. Controllers and the mouse map onto the
 * same "hand" model so the whole experience works without any of them being required.
 */
import {
  createSystem,
  VisibilityState,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  CylinderGeometry,
  BoxGeometry,
  RingGeometry,
  CircleGeometry,
  ExtrudeGeometry,
  Shape,
  Vector3,
  Quaternion,
  Euler,
  Matrix4,
  Raycaster,
  Vector2,
  DoubleSide,
  CanvasTexture,
  Object3D,
  BufferGeometry,
  AmbientLight,
  DirectionalLight,
} from '@iwsdk/core';
import {
  type State,
  type Task,
  pack,
  totals,
  snap,
  save,
  lockDay,
  refreshRing,
  rollOver,
  nextDate,
  fmtClock,
  fmtDur,
  freshState,
  MIN_BLOCK,
  MAX_BLOCK,
} from './model.js';
import { T, G, KIND_COLOR } from './tokens.js';
import { drawTile, drawRule, drawPanel, drawText, makeTexture, PANEL_W, PANEL_H, PX_PER_M, type PanelView } from './labels.js';
import { tok, lift, chord, thud } from './sound.js';

type HandId = 'left' | 'right' | 'mouse';

interface Hand {
  id: HandId;
  present: boolean;
  pinching: boolean;
  point: Vector3; // root-local pinch point
  tip: Vector3; // root-local index fingertip (for poke)
  tipValid: boolean;
  pinchStartT: number;
  pinchStartPoint: Vector3;
  held: string | null; // tile id
  offset: Vector3; // tile pos - pinch point, root-local
  pokeArmed: Map<string, boolean>;
}

interface Tile {
  id: string;
  group: Group;
  body: Mesh;
  face: Mesh;
  border: Mesh;
  canvas: HTMLCanvasElement;
  tex: CanvasTexture;
  widthM: number;
  lookKey: string;
  tPos: Vector3;
  tQuat: Quaternion;
  tScale: number;
  moveAt: number;
  pendPos: Vector3;
  pendQuat: Quaternion;
  where: 'tray' | 'span' | 'held';
  fromSpan: boolean;
}

interface Button {
  id: string;
  mesh: Mesh;
  rect: [number, number, number, number]; // normalized x,y,w,h on panel (top-left origin)
  press: number; // animation 0..1
  disabled: boolean;
}

// ?clock=8:20 pins the needle to a given time (used for the demo recording)
const CLOCK = new URLSearchParams(location.search).get('clock');
const CLOCK_BASE = CLOCK && /^\d{1,2}:\d{2}$/.test(CLOCK) ? parseInt(CLOCK.split(':')[0], 10) * 60 + parseInt(CLOCK.split(':')[1], 10) : null;
const LOAD_T = performance.now();
// ?timescale=0.5 slows Dayspan's own animations (used to record smooth demo footage, then sped up)
const VCLOCK = new URLSearchParams(location.search).has('vclock');
const TS = Math.min(1, Math.max(0.1, parseFloat(new URLSearchParams(location.search).get('timescale') ?? '1') || 1));
function nowMinutes(): number {
  if (CLOCK_BASE != null) return CLOCK_BASE + (performance.now() - LOAD_T) / 60000;
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
}

const tmpV = new Vector3();
const tmpV2 = new Vector3();
const tmpQ = new Quaternion();
const tmpM = new Matrix4();
const UP = new Vector3(0, 1, 0);

function bodyGeometry(w: number, h: number, d: number, c: number): BufferGeometry {
  const s = new Shape();
  const x = -w / 2;
  const y = -h / 2;
  s.moveTo(x + c, y);
  s.lineTo(x + w - c, y);
  s.lineTo(x + w, y + c);
  s.lineTo(x + w, y + h - c);
  s.lineTo(x + w - c, y + h);
  s.lineTo(x + c, y + h);
  s.lineTo(x, y + h - c);
  s.lineTo(x, y + c);
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth: d, bevelEnabled: false });
  g.translate(0, 0, -d);
  return g;
}

export class DaySystem extends createSystem({}) {
  state!: State;
  root!: Group;
  tray!: Group;
  tiles = new Map<string, Tile>();
  hands: Record<HandId, Hand> = {
    left: this.mkHand('left'),
    right: this.mkHand('right'),
    mouse: this.mkHand('mouse'),
  };
  buttons: Button[] = [];
  panel!: Group;
  panelCanvas = document.createElement('canvas');
  panelTex!: CanvasTexture;
  panelKey = '';
  rings!: Group;
  ringsKey = '';
  ringLabelCanvas = document.createElement('canvas');
  ringLabelTex!: CanvasTexture;
  needle!: Group;
  needleLabelCanvas = document.createElement('canvas');
  needleLabelTex!: CanvasTexture;
  needleKey = '';
  ribbon!: Mesh;
  ribbonBase!: Float32Array;
  stretch: { tile: string; a: HandId; b: HandId; d0: number; m0: number } | null = null;
  anchored = false;
  anchorTries = 0;
  time = 0;
  preview: { tile: string; index: number } | null = null;
  firstPlaced = false;
  firstStretched = false;
  ruleMinutesTotal = 0;
  raycaster = new Raycaster();
  mouseNdc = new Vector2();
  mouseDist = 0.6;
  onChange: (() => void) | null = null;
  lastEvent = '';
  invRoot = new Matrix4();
  deskY = -G.deskDrop;
  deskFound = false;
  lastDeskScan = -10;
  studio!: Group;
  deskMesh!: Mesh;
  mode: 'preview' | 'vr' | 'ar' = 'preview';
  planeSummary: { label: string; center: number[]; min: number[]; max: number[] }[] = [];

  mkHand(id: HandId): Hand {
    return {
      id,
      present: false,
      pinching: false,
      point: new Vector3(),
      tip: new Vector3(),
      tipValid: false,
      pinchStartT: 0,
      pinchStartPoint: new Vector3(),
      held: null,
      offset: new Vector3(),
      pokeArmed: new Map(),
    };
  }

  // ---------- geometry helpers ----------
  get perMinM(): number {
    return (G.spanRadius * 2 * G.spanHalfAngle) / (this.state.dayEnd - this.state.dayStart);
  }

  angleAt(minFromStart: number): number {
    const cap = this.state.dayEnd - this.state.dayStart;
    return -G.spanHalfAngle + (minFromStart / cap) * 2 * G.spanHalfAngle;
  }

  arcPoint(theta: number, r: number, y: number, out: Vector3): Vector3 {
    return out.set(r * Math.sin(theta), y, -r * Math.cos(theta));
  }

  init(): void {
    const w = window as unknown as { __dayspanState?: State };
    this.state = w.__dayspanState ?? freshState();
    this.root = new Group();
    this.root.name = 'dayspan-root';
    this.world.createTransformEntity(this.root);
    this.root.position.set(0, 1.25, 0);

    const amb = new AmbientLight('#ffffff', 1.4);
    const dir = new DirectionalLight('#ffffff', 1.6);
    dir.position.set(0.4, 1.2, 0.6);
    this.root.add(amb, dir);

    this.buildRule();
    this.buildTray();
    this.buildStudio();
    this.buildPanel();
    this.buildRings();
    this.buildNeedle();
    this.syncTiles(true);

    this.cleanupFuncs.push(
      this.world.visibilityState.subscribe((v) => {
        if (v === VisibilityState.NonImmersive) {
          this.anchored = false;
          this.root.position.set(0, 1.25, 0);
          this.root.rotation.set(0, 0, 0);
          this.placeDesktopCamera();
        } else {
          this.anchored = false;
          this.anchorTries = 0;
        }
        this.applyMode();
      }),
    );
    this.placeDesktopCamera();
    this.installMouse();
    this.exposeDebug();
  }

  /** Rebuild every object (used when work hours change). */
  rebuild(): void {
    for (const c of [...this.root.children]) this.root.remove(c);
    this.tiles.clear();
    this.buttons = [];
    this.panelKey = '';
    this.ringsKey = '';
    this.needleKey = '';
    const amb = new AmbientLight('#ffffff', 1.4);
    const dir = new DirectionalLight('#ffffff', 1.6);
    dir.position.set(0.4, 1.2, 0.6);
    this.root.add(amb, dir);
    this.buildRule();
    this.buildTray();
    this.buildStudio();
    this.buildPanel();
    this.buildRings();
    this.buildNeedle();
    this.syncTiles(true);
    this.applyMode();
  }

  applyMode(): void {
    const blend = this.world.xrSession?.environmentBlendMode;
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    this.mode = !immersive ? 'preview' : blend && blend !== 'opaque' ? 'ar' : 'vr';
    if (this.studio) this.studio.visible = this.mode !== 'ar';
    if (this.mode !== 'ar' && this.deskFound) {
      this.deskFound = false;
      this.deskY = -G.deskDrop;
      this.placeTray();
      this.layout();
    }
  }

  placeDesktopCamera(): void {
    // desktop preview sees roughly what a seated user sees: eye at the anchor, wide lens
    const cam = this.world.camera;
    cam.position.set(0, 1.27, 0.12);
    cam.lookAt(0, 0.93, -0.62);
    cam.fov = 74;
    cam.updateProjectionMatrix();
  }

  // ---------- builders ----------
  buildRule(): void {
    const s = this.state;
    const cap = s.dayEnd - s.dayStart;
    const extraAngle = G.overflowMaxAngle - G.spanHalfAngle;
    const extraMin = Math.round((extraAngle / (2 * G.spanHalfAngle)) * cap);
    this.ruleMinutesTotal = cap + extraMin;
    const theta0 = -G.spanHalfAngle;
    const thetaLen = G.spanHalfAngle + G.overflowMaxAngle;
    const numeralsH = 0.022;
    const ruleH = G.ruleHeight + numeralsH;
    const canvas = document.createElement('canvas');
    const arcLen = G.spanRadius * thetaLen;
    drawRule(canvas, {
      start: s.dayStart,
      end: s.dayEnd,
      minutesTotal: this.ruleMinutesTotal,
      widthPx: Math.round(arcLen * 2600),
      heightPx: Math.round(ruleH * 2600),
      numeralsPx: Math.round(numeralsH * 2600),
    });
    const tex = makeTexture(canvas);
    // CylinderGeometry: theta measured from +Z toward +X. Our theta is from -Z toward +X.
    // A point at cylinder angle a sits at (r sin a, y, r cos a); we need (r sin t, y, -r cos t) => a = PI - t.
    const geo = new CylinderGeometry(
      G.spanRadius,
      G.spanRadius,
      ruleH,
      96,
      1,
      true,
      Math.PI - (theta0 + thetaLen),
      thetaLen,
    );
    // flip U so the texture reads left-to-right from inside the cylinder
    const uv = geo.attributes.uv;
    for (let i = 0; i < uv.count; i++) uv.setX(i, 1 - uv.getX(i));
    const mat = new MeshBasicMaterial({ map: tex, transparent: true, side: DoubleSide, toneMapped: false });
    const rule = new Mesh(geo, mat);
    rule.position.y = -G.spanDrop + numeralsH / 2;
    rule.renderOrder = 1;
    this.root.add(rule);

    // flag: stake + flagging-tape ribbon at the end of the day
    const end = G.spanHalfAngle;
    const stake = new Mesh(
      new BoxGeometry(0.004, 0.16, 0.004),
      new MeshStandardMaterial({ color: T.ink, roughness: 0.6 }),
    );
    this.arcPoint(end, G.spanRadius - 0.004, -G.spanDrop + 0.02, stake.position);
    this.root.add(stake);
    const rg = new PlaneGeometry(0.1, 0.011, 24, 1);
    rg.translate(0.05, 0, 0);
    this.ribbonBase = Float32Array.from(rg.attributes.position.array as ArrayLike<number>);
    this.ribbon = new Mesh(
      rg,
      new MeshBasicMaterial({ color: T.flag, side: DoubleSide, toneMapped: false }),
    );
    this.ribbon.position.copy(stake.position).add(tmpV.set(0, 0.07, 0));
    this.ribbon.rotation.y = -end;
    this.root.add(this.ribbon);
    // label on the flag
    const lc = document.createElement('canvas');
    drawText(
      lc,
      [{ text: `END ${fmtClock(s.dayEnd)}`, font: 'time', color: T.flag, size: 44 }],
      300,
      64,
      'left',
    );
    const lbl = new Mesh(
      new PlaneGeometry(0.06, 0.0128),
      new MeshBasicMaterial({ map: makeTexture(lc), transparent: true, toneMapped: false }),
    );
    this.arcPoint(end + 0.012, G.spanRadius - 0.006, -G.spanDrop - 0.062, lbl.position);
    lbl.position.x += 0;
    lbl.rotation.y = -end;
    lbl.geometry.translate(0.03, 0, 0);
    this.root.add(lbl);
  }

  buildTray(): void {
    this.tray = new Group();
    this.root.add(this.tray);
    this.placeTray();
    const plate = new Mesh(
      bodyGeometry(0.52, 0.25, 0.008, 0.01),
      new MeshStandardMaterial({ color: '#20262C', roughness: 0.85, metalness: 0.05 }),
    );
    plate.position.set(0, -0.005, -0.002);
    this.tray.add(plate);
    const c = document.createElement('canvas');
    drawText(c, [{ text: 'TRAY', font: 'time', color: '#8B949C', size: 40 }], 200, 56, 'left');
    const lbl = new Mesh(
      new PlaneGeometry(0.04, 0.0112),
      new MeshBasicMaterial({ map: makeTexture(c), transparent: true, toneMapped: false }),
    );
    lbl.position.set(-0.24 + 0.02, 0.112, 0.0005);
    this.tray.add(lbl);
    this.tray.updateMatrix();
  }

  /** The tray is a lectern-like plate whose near edge rests on the desk surface. */
  placeTray(): void {
    const halfRise = (G.trayDepth / 2) * Math.sin(G.trayTilt);
    this.tray.position.set(0, this.deskY + halfRise + 0.012, -G.trayDistance);
    this.tray.rotation.set(-(Math.PI / 2 - G.trayTilt), 0, 0);
    this.tray.updateMatrix();
    if (this.deskMesh) this.deskMesh.position.set(0, this.deskY - 0.015, -G.trayDistance - 0.05);
  }

  /** Virtual studio for VR and the desktop preview: floor, a desk slab. Hidden in passthrough. */
  buildStudio(): void {
    this.studio = new Group();
    this.root.add(this.studio);
    this.deskMesh = new Mesh(
      new BoxGeometry(1.25, 0.03, 0.62),
      new MeshStandardMaterial({ color: '#262C32', roughness: 0.8, metalness: 0.02 }),
    );
    this.studio.add(this.deskMesh);
    const edge = new Mesh(
      new BoxGeometry(1.25, 0.004, 0.004),
      new MeshBasicMaterial({ color: '#3A434B', toneMapped: false }),
    );
    edge.position.set(0, 0.015, 0.31);
    this.deskMesh.add(edge);
    const floor = new Mesh(
      new CircleGeometry(3.2, 64),
      new MeshStandardMaterial({ color: '#111519', roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.18;
    this.studio.add(floor);
    // a few survey stakes in the distance give the room scale without clutter
    for (let i = 0; i < 7; i++) {
      const a = -1.1 + i * 0.37;
      const stake = new Mesh(
        new BoxGeometry(0.02, 0.9, 0.02),
        new MeshStandardMaterial({ color: '#2B3238', roughness: 0.9 }),
      );
      this.arcPoint(a, 2.6, -0.73, stake.position);
      this.studio.add(stake);
      if (i === 5) {
        const tape = new Mesh(new BoxGeometry(0.06, 0.012, 0.021), new MeshBasicMaterial({ color: T.flag, toneMapped: false }));
        tape.position.copy(stake.position).add(tmpV.set(0.02, 0.38, 0));
        this.studio.add(tape);
      }
    }
    this.placeTray();
  }

  /** In passthrough, look for a real table under the tray and rest the tray on it. */
  findDesk(): void {
    const frame = this.world.xrFrame as (XRFrame & { detectedPlanes?: Set<XRPlane> }) | null;
    const ref = this.world.xrReferenceSpace;
    if (!frame || !ref || !frame.detectedPlanes || this.time - this.lastDeskScan < 1) return;
    this.lastDeskScan = this.time;
    this.root.updateMatrixWorld();
    const inv = new Matrix4().copy(this.root.matrixWorld).invert();
    const playerM = this.world.player.matrixWorld;
    let best: number | null = null;
    let bestScore = Infinity;
    this.planeSummary = [];
    for (const plane of frame.detectedPlanes) {
      if (plane.orientation !== 'horizontal') continue;
      const label = (plane as XRPlane & { semanticLabel?: string }).semanticLabel;
      {
        const pz = frame.getPose(plane.planeSpace, ref);
        if (pz) {
          const wm = new Matrix4().multiplyMatrices(playerM, new Matrix4().fromArray(pz.transform.matrix));
          const pts = plane.polygon.map((q) => new Vector3(q.x, q.y, q.z).applyMatrix4(wm));
          const c = pts.reduce((a, b) => a.add(b), new Vector3()).multiplyScalar(1 / Math.max(1, pts.length));
          this.planeSummary.push({
            label: label ?? '',
            center: [c.x, c.y, c.z],
            min: [Math.min(...pts.map((q) => q.x)), Math.min(...pts.map((q) => q.z))],
            max: [Math.max(...pts.map((q) => q.x)), Math.max(...pts.map((q) => q.z))],
          });
        }
      }
      if (label && !/table|desk/i.test(label)) continue;
      const pose = frame.getPose(plane.planeSpace, ref);
      if (!pose) continue;
      const pm = new Matrix4().fromArray(pose.transform.matrix);
      const worldM = new Matrix4().multiplyMatrices(playerM, pm);
      const localM = new Matrix4().multiplyMatrices(inv, worldM);
      const origin = new Vector3().setFromMatrixPosition(localM);
      if (origin.y > -0.25 || origin.y < -0.95) continue;
      // is the spot under the tray inside the plane polygon?
      const probe = new Vector3(0, origin.y, -G.trayDistance).applyMatrix4(new Matrix4().copy(localM).invert());
      const poly = plane.polygon;
      let inside = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
        if (zi > probe.z !== zj > probe.z && probe.x < ((xj - xi) * (probe.z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      if (!inside) continue;
      const score = Math.abs(origin.y + G.deskDrop);
      if (score < bestScore) {
        bestScore = score;
        best = origin.y;
      }
    }
    if (best != null && (!this.deskFound || Math.abs(best - this.deskY) > 0.01)) {
      this.deskY = best;
      this.deskFound = true;
      this.placeTray();
      this.event(`desk:${best.toFixed(3)}`);
      tok(0.9, 0.15);
      this.layout();
    }
  }

  buildPanel(): void {
    this.panel = new Group();
    const th = -46 * (Math.PI / 180);
    this.arcPoint(th, 0.5, -G.deskDrop + 0.12, this.panel.position);
    this.panel.rotation.set(0, 0, 0);
    this.panel.rotation.y = -th;
    this.panel.rotateX(-0.8);
    this.root.add(this.panel);
    this.panelTex = makeTexture(this.panelCanvas);
    const face = new Mesh(
      bodyGeometry(PANEL_W, PANEL_H, 0.01, 0.006),
      [
        new MeshBasicMaterial({ map: this.panelTex, toneMapped: false }),
        new MeshStandardMaterial({ color: '#0F1317', roughness: 0.9 }),
      ],
    );
    // ExtrudeGeometry groups: 0 = caps (front/back), 1 = sides. Map planar UVs on the caps.
    const pos = face.geometry.attributes.position;
    const uv = face.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, pos.getX(i) / PANEL_W + 0.5, pos.getY(i) / PANEL_H + 0.5);
    }
    this.panel.add(face);

    const defs: { id: string; rect: [number, number, number, number] }[] = [
      { id: 'lock', rect: [0.06, 0.68, 0.42, 0.12] },
      { id: 'next', rect: [0.52, 0.68, 0.42, 0.12] },
      { id: 'recenter', rect: [0.06, 0.83, 0.42, 0.12] },
      { id: 'reset', rect: [0.52, 0.83, 0.42, 0.12] },
    ];
    for (const d of defs) {
      const [x, y, w, h] = d.rect;
      const mesh = new Mesh(
        new BoxGeometry(w * PANEL_W, h * PANEL_H, 0.008),
        new MeshBasicMaterial({ transparent: true, opacity: 0.0, depthWrite: false }),
      );
      mesh.position.set((x + w / 2 - 0.5) * PANEL_W, (0.5 - (y + h / 2)) * PANEL_H, 0.004);
      mesh.name = `btn-${d.id}`;
      this.panel.add(mesh);
      this.buttons.push({ id: d.id, mesh, rect: d.rect, press: 0, disabled: false });
    }
    this.redrawPanel(true);
  }

  buildRings(): void {
    this.rings = new Group();
    const th = 44 * (Math.PI / 180);
    this.arcPoint(th, 0.5, -G.deskDrop + 0.1, this.rings.position);
    this.rings.rotation.y = -th;
    this.rings.rotateX(-0.8);
    this.root.add(this.rings);
    this.ringLabelTex = makeTexture(this.ringLabelCanvas);
    this.redrawRings(true);
  }

  buildNeedle(): void {
    this.needle = new Group();
    const bar = new Mesh(
      new BoxGeometry(0.0025, 0.1, 0.0025),
      new MeshBasicMaterial({ color: T.flag, toneMapped: false }),
    );
    this.needle.add(bar);
    this.needleLabelTex = makeTexture(this.needleLabelCanvas);
    const lbl = new Mesh(
      new PlaneGeometry(0.05, 0.0107),
      new MeshBasicMaterial({ map: this.needleLabelTex, transparent: true, toneMapped: false }),
    );
    lbl.position.set(0, 0.066, 0);
    this.needle.add(lbl);
    this.root.add(this.needle);
  }

  // ---------- tiles ----------
  makeTile(task: Task): Tile {
    const canvas = document.createElement('canvas');
    const tex = makeTexture(canvas);
    const group = new Group();
    group.name = `tile-${task.id}`;
    const body = new Mesh(
      new BufferGeometry(),
      new MeshStandardMaterial({ color: KIND_COLOR[task.kind], roughness: 0.55, metalness: 0.0 }),
    );
    const face = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: tex, toneMapped: false }),
    );
    face.position.z = 0.0006;
    const border = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ color: T.flag, toneMapped: false }),
    );
    border.position.z = -G.tileDepth - 0.0008;
    border.visible = false;
    group.add(body, face, border);
    this.root.add(group);
    const tile: Tile = {
      id: task.id,
      group,
      body,
      face,
      border,
      canvas,
      tex,
      widthM: 0,
      lookKey: '',
      tPos: new Vector3(),
      tQuat: new Quaternion(),
      tScale: 1,
      moveAt: 0,
      pendPos: new Vector3(),
      pendQuat: new Quaternion(),
      where: 'tray',
      fromSpan: false,
    };
    this.tiles.set(task.id, tile);
    return tile;
  }

  task(id: string): Task | undefined {
    return this.state.tasks.find((t) => t.id === id);
  }

  refreshTileLook(tile: Tile, task: Task, overflow: boolean, start?: number): void {
    const w = Math.max(0.02, task.minutes * this.perMinM - 0.002);
    const stretching = this.stretch?.tile === tile.id;
    const key = `${task.title}|${task.minutes}|${task.kind}|${task.carried}|${task.done}|${overflow}|${start ?? ''}|${stretching}|${w.toFixed(4)}`;
    if (key === tile.lookKey) return;
    tile.lookKey = key;
    if (Math.abs(w - tile.widthM) > 1e-5) {
      tile.body.geometry.dispose();
      tile.body.geometry = bodyGeometry(w, G.tileHeight, G.tileDepth, G.chamfer);
      tile.face.scale.set(w - G.chamfer * 0.5, G.tileHeight - G.chamfer * 0.5, 1);
      tile.border.scale.set(w + 0.006, G.tileHeight + 0.006, 1);
      tile.widthM = w;
    }
    (tile.body.material as MeshStandardMaterial).color.set(task.done ? T.spent : KIND_COLOR[task.kind]);
    drawTile(tile.canvas, task, w, G.tileHeight, { overflow, done: task.done, start, stretching });
    tile.tex.dispose();
    const tex = makeTexture(tile.canvas);
    (tile.face.material as MeshBasicMaterial).map = tex;
    (tile.face.material as MeshBasicMaterial).needsUpdate = true;
    tile.tex = tex;
    tile.border.visible = overflow && !task.done;
  }

  /** Create/destroy tile objects to match state, then compute layout targets. */
  syncTiles(instant = false): void {
    const ids = new Set(this.state.tasks.map((t) => t.id));
    for (const [id, tile] of this.tiles) {
      if (!ids.has(id)) {
        this.root.remove(tile.group);
        tile.body.geometry.dispose();
        tile.tex.dispose();
        this.tiles.delete(id);
      }
    }
    for (const t of this.state.tasks) if (!this.tiles.has(t.id)) this.makeTile(t);
    this.layout(instant);
  }

  setTarget(tile: Tile, pos: Vector3, quat: Quaternion, delay: number, instant: boolean): void {
    if (instant) {
      tile.tPos.copy(pos);
      tile.tQuat.copy(quat);
      tile.pendPos.copy(pos);
      tile.pendQuat.copy(quat);
      tile.group.position.copy(pos);
      tile.group.quaternion.copy(quat);
      tile.moveAt = 0;
      return;
    }
    if (tile.pendPos.distanceToSquared(pos) > 1e-8 || Math.abs(tile.pendQuat.dot(quat)) < 0.99999) {
      tile.pendPos.copy(pos);
      tile.pendQuat.copy(quat);
      tile.moveAt = this.time + delay;
    }
  }

  layout(instant = false): void {
    const s = this.state;
    const heldIds = new Set<string>();
    for (const h of Object.values(this.hands)) if (h.held) heldIds.add(h.held);

    // span order, with an insertion gap for a hovering tile
    let order = s.span.filter((id) => !heldIds.has(id));
    if (this.preview) {
      order = order.slice();
      order.splice(Math.min(this.preview.index, order.length), 0, this.preview.tile);
    }
    let cursor = 0;
    const cap = s.dayEnd - s.dayStart;
    let overflowIdx = 0;
    order.forEach((id, i) => {
      const task = this.task(id);
      if (!task) return;
      const startMin = cursor;
      const endMin = cursor + task.minutes;
      cursor = endMin;
      if (this.preview && id === this.preview.tile) return; // ghost gap only
      const tile = this.tiles.get(id)!;
      const overflow = endMin > cap;
      const mid = (startMin + endMin) / 2;
      const theta = this.angleAt(mid);
      const droop = overflow ? 1 : 0;
      if (overflow) overflowIdx++;
      this.arcPoint(theta, G.spanRadius - 0.012, -G.spanDrop - 0.006 - droop * 0.006 * overflowIdx, tmpV);
      tmpQ.setFromEuler(new Euler(0, -theta, overflow ? -0.157 : 0, 'YXZ'));
      tile.where = 'span';
      this.refreshTileLook(tile, task, overflow, s.dayStart + startMin);
      this.setTarget(tile, tmpV, tmpQ, instant ? 0 : i * 0.035, instant);
      tile.tScale = 1;
    });

    // tray: rows, same scale as the span
    const trayTasks = s.tasks.filter((t) => !s.span.includes(t.id) && !heldIds.has(t.id) && !t.done);
    const maxW = 0.48;
    let x = -0.24;
    let row = 0;
    trayTasks.forEach((task, i) => {
      const tile = this.tiles.get(task.id)!;
      this.refreshTileLook(tile, task, false);
      const w = tile.widthM;
      if (x + w > -0.24 + maxW + 1e-6 && x > -0.24) {
        row++;
        x = -0.24;
      }
      const local = tmpV2.set(x + w / 2, 0.075 - row * 0.058, 0.0);
      x += w + 0.008;
      const world = local.applyMatrix4(this.tray.matrix);
      tmpQ.setFromRotationMatrix(tmpM.extractRotation(this.tray.matrix));
      tile.where = 'tray';
      this.setTarget(tile, world, tmpQ, instant ? 0 : i * 0.02, instant);
      tile.tScale = 1;
    });

    // done tiles that are not on the span (should not happen) are parked in the tray
    for (const t of s.tasks) {
      if (t.done && !s.span.includes(t.id)) {
        const tile = this.tiles.get(t.id)!;
        tile.group.visible = false;
      } else {
        const tile = this.tiles.get(t.id);
        if (tile) tile.group.visible = true;
      }
    }
    this.redrawPanel();
    this.redrawRings();
  }

  // ---------- panel & rings ----------
  coachLine(): string {
    const t = totals(this.state);
    if (this.stretch) return 'Pull apart to add time, push together to trim. 15 minute steps.';
    if (this.state.locked) {
      if (t.done >= t.planned && t.planned > 0) return 'Everything on the span is done. That ring is yours.';
      return 'Plan locked. Pinch-tap a tile when it is done.';
    }
    if (!this.firstPlaced && this.state.span.length === 0) return 'Pinch a tile in the tray and drop it on the span in front of you.';
    if (t.overflow > 0) return `Past the pink flag is overtime: ${fmtDur(t.overflow)}. Trim a tile or put one back.`;
    if (!this.firstStretched) return 'Hold a tile with both hands and pull to resize it.';
    if (t.inTray > 0) return `${t.inTray} left in the tray. Fit what matters, leave the rest.`;
    return 'It fits. Poke Lock day to commit.';
  }

  redrawPanel(force = false): void {
    const s = this.state;
    const t = totals(s);
    for (const b of this.buttons) {
      b.disabled =
        (b.id === 'lock' && (s.span.length === 0 || s.locked)) || (b.id === 'next' && !s.locked);
    }
    const view: PanelView = {
      title: 'Dayspan',
      date: s.date,
      planned: t.planned,
      capacity: t.capacity,
      overflow: t.overflow,
      inTray: t.inTray,
      done: t.done,
      locked: s.locked,
      desk: this.deskFound,
      coach: this.coachLine(),
      buttons: [
        { id: 'lock', label: s.locked ? 'Locked' : 'Lock day', primary: true, disabled: this.btn('lock').disabled },
        { id: 'next', label: 'Next morning', disabled: this.btn('next').disabled },
        { id: 'recenter', label: 'Recenter' },
        { id: 'reset', label: 'Reset' },
      ],
    };
    const key = JSON.stringify(view);
    if (!force && key === this.panelKey) return;
    this.panelKey = key;
    const rects = new Map(this.buttons.map((b) => [b.id, b.rect] as [string, [number, number, number, number]]));
    drawPanel(this.panelCanvas, view, rects);
    this.panelTex.needsUpdate = true;
    this.panelTex.dispose();
    const tex = makeTexture(this.panelCanvas);
    const mats = (this.panel.children[0] as Mesh).material as MeshBasicMaterial[];
    mats[0].map = tex;
    mats[0].needsUpdate = true;
    this.panelTex = tex;
    this.onChange?.();
  }

  btn(id: string): Button {
    return this.buttons.find((b) => b.id === id)!;
  }

  redrawRings(force = false): void {
    const hist = this.state.history;
    const key = JSON.stringify(hist) + this.state.date + this.state.locked;
    if (!force && key === this.ringsKey) return;
    this.ringsKey = key;
    for (const c of [...this.rings.children]) {
      this.rings.remove(c);
      (c as Mesh).geometry?.dispose();
    }
    const disc = new Mesh(
      new CircleGeometry(0.085, 64),
      new MeshStandardMaterial({ color: '#20262C', roughness: 0.9 }),
    );
    disc.position.z = -0.002;
    this.rings.add(disc);
    // pith
    const pith = new Mesh(new CircleGeometry(0.006, 24), new MeshBasicMaterial({ color: T.enamel, toneMapped: false }));
    this.rings.add(pith);
    let r = 0.012;
    const recent = hist.slice(-12);
    recent.forEach((h, i) => {
      const width = 0.004 + Math.min(1, h.doneMin / Math.max(1, h.capacityMin)) * 0.008;
      const over = h.plannedMin > h.capacityMin;
      const color = over ? T.flag : T.life;
      const ring = new Mesh(
        new RingGeometry(r, r + width, 72),
        new MeshBasicMaterial({ color, toneMapped: false }),
      );
      ring.position.z = 0.0004 + i * 0.00001;
      this.rings.add(ring);
      r += width + 0.0016;
    });
    const onBudget = hist.filter((h) => h.plannedMin <= h.capacityMin).length;
    drawText(
      this.ringLabelCanvas,
      [
        { text: hist.length ? `${hist.length} ${hist.length === 1 ? 'day' : 'days'} planned` : 'No rings yet', font: 'label', color: T.chalk, size: 40 },
        { text: hist.length ? `${onBudget} fit the day` : 'Lock a day to grow one', font: 'time', color: '#A3ABB2', size: 32 },
      ],
      420,
      100,
      'center',
    );
    this.ringLabelTex.dispose();
    this.ringLabelTex = makeTexture(this.ringLabelCanvas);
    const lbl = new Mesh(
      new PlaneGeometry(0.12, 0.0286),
      new MeshBasicMaterial({ map: this.ringLabelTex, transparent: true, toneMapped: false }),
    );
    lbl.position.set(0, -0.108, 0);
    this.rings.add(lbl);
  }

  // ---------- input ----------
  readXRHands(): void {
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    const session = this.world.xrSession;
    this.hands.left.present = false;
    this.hands.right.present = false;
    if (!frame || !ref || !session) return;
    this.root.updateMatrixWorld();
    const inv = this.invRoot.copy(this.root.matrixWorld).invert();
    const playerM = this.world.player.matrixWorld;
    for (const src of session.inputSources) {
      const hid = src.handedness === 'left' ? 'left' : src.handedness === 'right' ? 'right' : null;
      if (!hid) continue;
      const hand = this.hands[hid];
      if (src.hand) {
        const thumb = src.hand.get('thumb-tip');
        const index = src.hand.get('index-finger-tip');
        if (!thumb || !index || !frame.getJointPose) continue;
        const pt = frame.getJointPose(thumb, ref);
        const pi = frame.getJointPose(index, ref);
        if (!pt || !pi) continue;
        const a = tmpV.set(pt.transform.position.x, pt.transform.position.y, pt.transform.position.z).applyMatrix4(playerM);
        const b = tmpV2.set(pi.transform.position.x, pi.transform.position.y, pi.transform.position.z).applyMatrix4(playerM);
        const dist = a.distanceTo(b);
        const pinch = hand.pinching ? dist < 0.035 : dist < 0.018;
        hand.point.copy(a).add(b).multiplyScalar(0.5).applyMatrix4(inv);
        hand.tip.copy(b).applyMatrix4(inv);
        hand.tipValid = true;
        hand.present = true;
        this.setPinch(hand, pinch);
      } else if (src.gripSpace) {
        const p = frame.getPose(src.gripSpace, ref);
        if (!p) continue;
        const a = tmpV.set(p.transform.position.x, p.transform.position.y, p.transform.position.z).applyMatrix4(playerM);
        hand.point.copy(a).applyMatrix4(inv);
        hand.tip.copy(hand.point);
        hand.tipValid = false;
        hand.present = true;
        const gp = src.gamepad;
        const pressed = !!gp && ((gp.buttons[0]?.value ?? 0) > 0.5 || (gp.buttons[1]?.value ?? 0) > 0.5);
        this.setPinch(hand, pressed);
      }
    }
  }

  setPinch(hand: Hand, pinch: boolean): void {
    if (pinch && !hand.pinching) {
      hand.pinching = true;
      hand.pinchStartT = this.time;
      hand.pinchStartPoint.copy(hand.point);
      this.onPinchStart(hand);
    } else if (!pinch && hand.pinching) {
      hand.pinching = false;
      this.onPinchEnd(hand);
    }
  }

  hitTile(p: Vector3, exclude: string | null): Tile | null {
    let best: Tile | null = null;
    let bestD = Infinity;
    for (const tile of this.tiles.values()) {
      if (tile.id === exclude || !tile.group.visible) continue;
      tile.group.updateMatrix();
      const local = tmpV.copy(p).applyMatrix4(tmpM.copy(tile.group.matrix).invert());
      const hw = tile.widthM / 2 + 0.014;
      const hh = G.tileHeight / 2 + 0.014;
      if (Math.abs(local.x) <= hw && Math.abs(local.y) <= hh && local.z > -0.04 && local.z < 0.035) {
        const d = Math.abs(local.z) + Math.abs(local.y) * 0.3;
        if (d < bestD) {
          bestD = d;
          best = tile;
        }
      }
    }
    return best;
  }

  hitButton(p: Vector3): Button | null {
    this.panel.updateMatrixWorld();
    this.root.updateMatrixWorld();
    for (const b of this.buttons) {
      const wp = tmpV.copy(p).applyMatrix4(this.root.matrixWorld);
      const local = b.mesh.worldToLocal(wp);
      const hw = (b.rect[2] * PANEL_W) / 2 + 0.006;
      const hh = (b.rect[3] * PANEL_H) / 2 + 0.006;
      if (Math.abs(local.x) <= hw && Math.abs(local.y) <= hh && local.z > -0.02 && local.z < 0.03) return b;
    }
    return null;
  }

  onPinchStart(hand: Hand): void {
    // second hand on a tile that is already held -> stretch
    for (const other of Object.values(this.hands)) {
      if (other === hand || !other.held) continue;
      const tile = this.tiles.get(other.held)!;
      const local = tmpV.copy(hand.point).applyMatrix4(tmpM.copy(tile.group.matrix).invert());
      if (Math.abs(local.x) < tile.widthM / 2 + 0.06 && Math.abs(local.y) < 0.06 && Math.abs(local.z) < 0.06) {
        const task = this.task(tile.id)!;
        this.stretch = { tile: tile.id, a: other.id, b: hand.id, d0: hand.point.distanceTo(other.point), m0: task.minutes };
        this.firstStretched = true;
        lift();
        this.event(`stretch:${task.title}`);
        this.layout();
        return;
      }
    }
    const btn = this.hitButton(hand.point);
    if (btn) {
      this.pressButton(btn);
      return;
    }
    const tile = this.hitTile(hand.point, null);
    if (!tile) return;
    hand.held = tile.id;
    tile.fromSpan = this.state.span.includes(tile.id);
    tile.where = 'held';
    hand.offset.copy(tile.group.position).sub(hand.point);
    hand.offset.multiplyScalar(0.6);
    lift();
    this.event(`pick:${this.task(tile.id)?.title}`);
    this.layout();
  }

  onPinchEnd(hand: Hand): void {
    if (this.stretch && (this.stretch.a === hand.id || this.stretch.b === hand.id)) {
      const st = this.stretch;
      this.stretch = null;
      const remaining = st.a === hand.id ? this.hands[st.b] : this.hands[st.a];
      if (hand.held === st.tile) {
        // the holder let go: hand the tile over to the other hand
        hand.held = null;
        remaining.held = st.tile;
        const tile = this.tiles.get(st.tile)!;
        remaining.offset.copy(tile.group.position).sub(remaining.point).multiplyScalar(0.6);
      }
      save(this.state);
      this.event(`stretched:${this.task(st.tile)?.minutes}`);
      this.layout();
      return;
    }
    if (!hand.held) return;
    const id = hand.held;
    const tile = this.tiles.get(id)!;
    const task = this.task(id)!;
    hand.held = null;
    const moved = hand.point.distanceTo(hand.pinchStartPoint);
    const quick = this.time - hand.pinchStartT < 0.5;
    const s = this.state;
    if (moved < 0.02 && quick && tile.fromSpan) {
      // pinch-tap on a span tile
      this.preview = null;
      if (s.locked) {
        task.done = !task.done;
        refreshRing(s);
        if (task.done) chord();
        else tok(0.8);
        this.event(`${task.done ? 'done' : 'undone'}:${task.title}`);
      }
      save(s);
      this.layout();
      return;
    }
    const idx = this.spanIndexFor(hand.point, id);
    s.span = s.span.filter((x) => x !== id);
    if (idx >= 0) {
      s.span.splice(idx, 0, id);
      this.firstPlaced = true;
      tok(1);
      this.event(`place:${task.title}@${idx}`);
    } else {
      if (tile.fromSpan) thud();
      else tok(0.7, 0.2);
      this.event(`tray:${task.title}`);
    }
    if (s.locked) refreshRing(s);
    this.preview = null;
    save(s);
    this.layout();
  }

  /** Index in the span for a drop at point p, or -1 if p is not near the span. */
  spanIndexFor(p: Vector3, id: string): number {
    const rho = Math.hypot(p.x, p.z);
    const theta = Math.atan2(p.x, -p.z);
    const dy = p.y - -G.spanDrop;
    if (Math.abs(rho - G.spanRadius) > 0.13 || Math.abs(dy) > 0.11) return -1;
    if (theta < -G.spanHalfAngle - 0.2 || theta > G.overflowMaxAngle + 0.25) return -1;
    const cap = this.state.dayEnd - this.state.dayStart;
    const held = this.task(id);
    // compare the dropped tile's leading edge with the others' midpoints
    const mOff = ((theta + G.spanHalfAngle) / (2 * G.spanHalfAngle)) * cap - (held ? held.minutes / 2 : 0) + 1;
    let cursor = 0;
    let idx = 0;
    for (const sid of this.state.span) {
      if (sid === id) continue;
      const t = this.task(sid);
      if (!t) continue;
      const mid = cursor + t.minutes / 2;
      if (mid < mOff) idx++;
      cursor += t.minutes;
    }
    return idx;
  }

  pressButton(b: Button): void {
    if (b.disabled) {
      tok(0.5, 0.08);
      return;
    }
    b.press = 1;
    const s = this.state;
    this.event(`button:${b.id}`);
    if (b.id === 'lock') {
      lockDay(s);
      chord();
    } else if (b.id === 'next') {
      rollOver(s, nextDate(s.date));
      this.firstPlaced = true;
      tok(0.9);
    } else if (b.id === 'recenter') {
      this.anchored = false;
      this.anchorTries = 0;
      tok(1.2, 0.15);
    } else if (b.id === 'reset') {
      const fresh = freshState();
      Object.assign(s, fresh);
      this.firstPlaced = false;
      this.firstStretched = false;
      tok(0.6);
    }
    save(s);
    this.syncTiles();
  }

  updatePoke(hand: Hand): void {
    if (!hand.tipValid || !hand.present) return;
    this.root.updateMatrixWorld();
    for (const b of this.buttons) {
      const wp = tmpV.copy(hand.tip).applyMatrix4(this.root.matrixWorld);
      const local = b.mesh.worldToLocal(wp);
      const hw = (b.rect[2] * PANEL_W) / 2;
      const hh = (b.rect[3] * PANEL_H) / 2;
      const inside = Math.abs(local.x) <= hw && Math.abs(local.y) <= hh;
      const armed = hand.pokeArmed.get(b.id) ?? false;
      if (inside && local.z > 0.008 && local.z < 0.05) hand.pokeArmed.set(b.id, true);
      else if (!inside || local.z > 0.05) hand.pokeArmed.set(b.id, false);
      if (armed && inside && local.z < 0.002 && local.z > -0.03) {
        hand.pokeArmed.set(b.id, false);
        this.pressButton(b);
      }
    }
  }

  installMouse(): void {
    const el = this.world.renderer.domElement;
    const hand = this.hands.mouse;
    const toPoint = (e: PointerEvent, setDist: boolean): boolean => {
      const r = el.getBoundingClientRect();
      this.mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.mouseNdc, this.world.camera);
      this.root.updateMatrixWorld(true);
      if (setDist) {
        const targets: Object3D[] = [];
        for (const t of this.tiles.values()) if (t.group.visible) targets.push(t.body, t.face);
        for (const b of this.buttons) targets.push(b.mesh);
        const hit = this.raycaster.intersectObjects(targets, false)[0];
        if (!hit) return false;
        this.mouseDist = hit.distance;
      }
      const wp = this.raycaster.ray.at(this.mouseDist, tmpV);
      hand.point.copy(this.root.worldToLocal(wp));
      return true;
    };
    const down = (e: PointerEvent) => {
      if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) return;
      if (!toPoint(e, true)) return;
      hand.present = true;
      this.setPinch(hand, true);
    };
    const move = (e: PointerEvent) => {
      if (!hand.pinching) return;
      toPoint(e, false);
    };
    const up = () => {
      if (hand.pinching) this.setPinch(hand, false);
    };
    const wheel = (e: WheelEvent) => {
      if (this.world.visibilityState.peek() !== VisibilityState.NonImmersive) return;
      const r = el.getBoundingClientRect();
      this.mouseNdc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this.raycaster.setFromCamera(this.mouseNdc, this.world.camera);
      const targets: Object3D[] = [];
      for (const t of this.tiles.values()) if (t.group.visible) targets.push(t.body, t.face);
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      if (!hit) return;
      e.preventDefault();
      const tile = [...this.tiles.values()].find((t) => t.body === hit.object || t.face === hit.object);
      if (!tile) return;
      const task = this.task(tile.id)!;
      const m = snap(task.minutes + (e.deltaY < 0 ? 15 : -15));
      if (m !== task.minutes) {
        task.minutes = m;
        this.firstStretched = true;
        tok(1.3, 0.12);
        save(this.state);
        this.layout();
      }
    };
    el.addEventListener('pointerdown', down);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    el.addEventListener('wheel', wheel, { passive: false });
    this.cleanupFuncs.push(() => {
      el.removeEventListener('pointerdown', down);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      el.removeEventListener('wheel', wheel);
    });
  }

  // ---------- anchoring ----------
  tryAnchor(): void {
    if (this.anchored) return;
    const frame = this.world.xrFrame;
    const ref = this.world.xrReferenceSpace;
    if (!frame || !ref) return;
    const pose = frame.getViewerPose(ref);
    if (!pose) return;
    this.anchorTries++;
    if (this.anchorTries < 3) return; // let tracking settle for a couple of frames
    const p = pose.transform.position;
    const o = pose.transform.orientation;
    const head = tmpV.set(p.x, p.y, p.z).applyMatrix4(this.world.player.matrixWorld);
    const q = tmpQ.set(o.x, o.y, o.z, o.w);
    const fwd = tmpV2.set(0, 0, -1).applyQuaternion(q);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.root.position.copy(head);
    this.root.rotation.set(0, yaw, 0);
    this.root.updateMatrixWorld(true);
    this.anchored = true;
    this.event('anchored');
  }

  // ---------- frame ----------
  update(delta: number, time: number): void {
    // ?vclock: a recording harness owns time (window.__clock.t, seconds) for frame-exact capture
    const vclock = (window as unknown as { __clock?: { t: number } }).__clock;
    let dt: number;
    if (VCLOCK && vclock) {
      dt = Math.max(0, Math.min(0.05, vclock.t - this.time));
      this.time = vclock.t;
      time = vclock.t;
    } else {
      this.time = time * TS;
      dt = Math.min(0.05, delta) * TS;
    }
    const immersive = this.world.visibilityState.peek() !== VisibilityState.NonImmersive;
    if (immersive) {
      if (!this.anchored) this.applyMode();
      if (this.mode === 'ar') this.findDesk();
      this.tryAnchor();
      this.readXRHands();
      this.updatePoke(this.hands.left);
      this.updatePoke(this.hands.right);
    }

    // stretch
    if (this.stretch) {
      const st = this.stretch;
      const a = this.hands[st.a];
      const b = this.hands[st.b];
      const task = this.task(st.tile);
      if (task && a.present && b.present) {
        const d = a.point.distanceTo(b.point);
        const m = Math.max(MIN_BLOCK, Math.min(MAX_BLOCK, snap(st.m0 + (d - st.d0) / this.perMinM)));
        if (m !== task.minutes) {
          task.minutes = m;
          tok(m > st.m0 ? 1.4 : 1.1, 0.1);
          this.layout();
        }
        const tile = this.tiles.get(st.tile)!;
        tmpV.copy(a.point).add(b.point).multiplyScalar(0.5);
        tile.group.position.lerp(tmpV, 1 - Math.exp(-dt * 30));
        const dir = tmpV2.copy(b.point).sub(a.point);
        const theta = Math.atan2(tile.group.position.x, -tile.group.position.z);
        tmpQ.setFromEuler(new Euler(0, -theta, 0, 'YXZ'));
        if (dir.lengthSq() > 1e-6) tile.group.quaternion.slerp(tmpQ, 1 - Math.exp(-dt * 20));
      }
    }

    // held tiles follow their hands; preview insertion
    let newPreview: { tile: string; index: number } | null = null;
    for (const hand of Object.values(this.hands)) {
      if (!hand.held || this.stretch?.tile === hand.held) continue;
      const tile = this.tiles.get(hand.held)!;
      hand.offset.multiplyScalar(Math.exp(-dt * 6));
      tmpV.copy(hand.point).add(hand.offset);
      tile.group.position.lerp(tmpV, 1 - Math.exp(-dt * 32));
      const theta = Math.atan2(tile.group.position.x, -tile.group.position.z);
      tmpQ.setFromEuler(new Euler(-0.15, -theta, 0, 'YXZ'));
      tile.group.quaternion.slerp(tmpQ, 1 - Math.exp(-dt * 16));
      tile.group.scale.setScalar(1.04);
      const idx = this.spanIndexFor(hand.point, hand.held);
      if (idx >= 0) newPreview = { tile: hand.held, index: idx };
    }
    if (JSON.stringify(newPreview) !== JSON.stringify(this.preview)) {
      if (newPreview && (!this.preview || this.preview.index !== newPreview.index)) tok(1.8, 0.05);
      this.preview = newPreview;
      this.layout();
    }

    // animate tiles toward targets (ripple via per-tile delay)
    const kPos = 1 - Math.exp(-dt * 14);
    const kRot = 1 - Math.exp(-dt * 12);
    for (const tile of this.tiles.values()) {
      if (tile.where === 'held' && [...Object.values(this.hands)].some((h) => h.held === tile.id)) continue;
      if (this.stretch?.tile === tile.id) continue;
      if (this.time >= tile.moveAt) {
        tile.tPos.copy(tile.pendPos);
        tile.tQuat.copy(tile.pendQuat);
      }
      tile.group.position.lerp(tile.tPos, kPos);
      tile.group.quaternion.slerp(tile.tQuat, kRot);
      const sc = tile.group.scale.x + (tile.tScale - tile.group.scale.x) * kPos;
      tile.group.scale.setScalar(sc);
    }

    // ribbon wave
    const pos = this.ribbon.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = this.ribbonBase[i * 3];
      const y = this.ribbonBase[i * 3 + 1];
      const k = x / 0.1;
      pos.setXYZ(i, x, y - k * k * 0.014, Math.sin(this.time * 3.4 + x * 60) * 0.009 * k);
    }
    pos.needsUpdate = true;

    // buttons press animation
    for (const b of this.buttons) {
      if (b.press > 0) b.press = Math.max(0, b.press - dt * 5);
    }
    const face = this.panel.children[0];
    face.scale.setScalar(1 - Math.max(...this.buttons.map((b) => b.press)) * 0.01);

    this.updateNeedle();
  }

  updateNeedle(): void {
    const mins = nowMinutes();
    const s = this.state;
    const inside = mins >= s.dayStart && mins <= s.dayEnd;
    const key = `${inside}|${Math.floor(mins)}`;
    if (key === this.needleKey) return;
    this.needleKey = key;
    this.needle.visible = mins <= s.dayEnd;
    if (!inside) {
      // before the day: the needle waits at the start with a countdown
      const before = mins < s.dayStart;
      const theta = before ? -G.spanHalfAngle : G.spanHalfAngle;
      this.arcPoint(theta, G.spanRadius - 0.03, -G.spanDrop + 0.005, this.needle.position);
      this.needle.rotation.set(0, -theta, 0);
      const txt = before ? `in ${fmtDur(Math.round(s.dayStart - mins))}` : 'after hours';
      drawText(this.needleLabelCanvas, [{ text: txt, font: 'time', color: T.flag, size: 40 }], 240, 52, 'center');
    } else {
      const theta = this.angleAt(mins - s.dayStart);
      this.arcPoint(theta, G.spanRadius - 0.03, -G.spanDrop + 0.005, this.needle.position);
      this.needle.rotation.set(0, -theta, 0);
      drawText(this.needleLabelCanvas, [{ text: `now ${fmtClock(mins)}`, font: 'time', color: T.flag, size: 40 }], 240, 52, 'center');
    }
    this.needleLabelTex.dispose();
    this.needleLabelTex = makeTexture(this.needleLabelCanvas);
    const lbl = this.needle.children[1] as Mesh;
    (lbl.material as MeshBasicMaterial).map = this.needleLabelTex;
    (lbl.material as MeshBasicMaterial).needsUpdate = true;
  }

  event(e: string): void {
    this.lastEvent = e;
    const w = window as unknown as { __dayspanEvents?: { t: number; e: string }[] };
    (w.__dayspanEvents ??= []).push({ t: performance.now(), e });
  }

  /** Small read-only API used by the automated demo recording and tests. */
  exposeDebug(): void {
    const self = this;
    (window as unknown as Record<string, unknown>).__dayspan = {
      get state() {
        return self.state;
      },
      totals: () => totals(self.state),
      packed: () => pack(self.state).map((p) => ({ title: p.task.title, start: p.start, end: p.end, overflow: p.overflow })),
      worldOfTile(title: string) {
        const t = self.state.tasks.find((x) => x.title === title);
        if (!t) return null;
        const g = self.tiles.get(t.id)!.group;
        g.updateMatrixWorld(true);
        const v = g.getWorldPosition(new Vector3());
        return [v.x, v.y, v.z];
      },
      worldOfTileEdge(title: string, side: number) {
        const t = self.state.tasks.find((x) => x.title === title);
        if (!t) return null;
        const tile = self.tiles.get(t.id)!;
        tile.group.updateMatrixWorld(true);
        const v = tile.group.localToWorld(new Vector3((side * tile.widthM) / 2 - side * 0.012, 0, 0.004));
        return [v.x, v.y, v.z];
      },
      worldOfSpan(minFromStart: number, dy = 0, dr = -0.012) {
        const v = self.arcPoint(self.angleAt(minFromStart), G.spanRadius + dr, -G.spanDrop + dy, new Vector3());
        self.root.updateMatrixWorld(true);
        v.applyMatrix4(self.root.matrixWorld);
        return [v.x, v.y, v.z];
      },
      worldOfButton(id: string, dz = 0) {
        const b = self.buttons.find((x) => x.id === id);
        if (!b) return null;
        b.mesh.updateMatrixWorld(true);
        const v = b.mesh.localToWorld(new Vector3(0, 0, dz));
        return [v.x, v.y, v.z];
      },
      worldOfRoot(x: number, y: number, z: number) {
        self.root.updateMatrixWorld(true);
        const v = self.root.localToWorld(new Vector3(x, y, z));
        return [v.x, v.y, v.z];
      },
      handPoint(id: HandId) {
        const h = self.hands[id];
        self.root.updateMatrixWorld(true);
        const v = self.root.localToWorld(h.point.clone());
        const t = self.root.localToWorld(h.tip.clone());
        return { present: h.present, pinching: h.pinching, held: h.held, p: [v.x, v.y, v.z], tip: [t.x, t.y, t.z] };
      },
      anchored: () => self.anchored,
      planes: () => self.planeSummary,
      mode: () => self.mode,
      desk: () => ({ found: self.deskFound, y: self.deskY }),
      recenter: () => { self.anchored = false; self.anchorTries = 0; },
      coach: () => self.coachLine(),
      lastEvent: () => self.lastEvent,
      setState(s: State) {
        Object.assign(self.state, s);
        save(self.state);
        self.syncTiles(true);
      },
    };
    void PX_PER_M;
    void UP;
  }
}
