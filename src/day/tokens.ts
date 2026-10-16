/** Locked design tokens (see DESIGN.md). Everything visual references these names. */
export const T = {
  enamel: '#E6E8E4',
  ink: '#1C2228',
  slate: '#161B20',
  flag: '#FF4F8B',
  focus: '#2F6B6E',
  meet: '#B4533A',
  admin: '#5B6C93',
  life: '#6F8A4C',
  chalk: '#F2F3EF',
  spent: '#7F868C',
} as const;

export const KIND_COLOR = {
  focus: T.focus,
  meet: T.meet,
  admin: T.admin,
  life: T.life,
} as const;

export const KIND_LABEL = {
  focus: 'Focus',
  meet: 'Meeting',
  admin: 'Admin',
  life: 'Life',
} as const;

export const FONT_LABEL = '"Lexend", system-ui, sans-serif';
export const FONT_TIME = '"Spline Sans Mono", ui-monospace, monospace';

/** Geometry (meters). */
export const G = {
  spanRadius: 0.7,
  spanDrop: 0.22, // below the head anchor
  spanHalfAngle: (44 * Math.PI) / 180,
  overflowMaxAngle: (62 * Math.PI) / 180,
  ruleHeight: 0.05,
  tileHeight: 0.046,
  tileDepth: 0.016,
  chamfer: 0.004,
  trayDistance: 0.38,
  deskDrop: 0.56, // default desk surface below the head anchor when no real desk is found
  trayTilt: (26 * Math.PI) / 180,
  trayDepth: 0.25,
} as const;

export const EASE = {
  outBack: (t: number, s = 1.3) => 1 + (s + 1) * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2),
  outExpo: (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t)),
};
