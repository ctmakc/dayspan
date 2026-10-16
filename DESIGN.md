# Dayspan — design decision (locked)

**Subject.** A seated, ten-minute morning planning ritual in mixed reality. The user sorts
today's tasks onto a physical, curved timeline (the *span*) that floats over their real desk.
The single job: make it impossible to ignore that the day has a fixed size.

**World it borrows from.** Surveying and site layout: an enamel measuring rule, survey stakes,
and the fluorescent flagging tape surveyors tie at a boundary. Task blocks are painted wood
tiles, sized to their duration on the same scale as the rule.

## Directions considered

1. **Surveyor's Span (chosen).** Cool enamel rule with ink ticks, painted tiles in four muted
   lacquers, one fluorescent flagging-tape pink that marks the end of the day and everything
   that spills past it. Lexend for labels, Spline Sans Mono for times. Motion: blocks settle
   into the rule and later blocks ripple aside; blocks past the flag droop.
2. Felt-and-cork planner: pastel felt tiles pinned to a cork ribbon, rounded type, springy
   motion. Rejected: reads as a toy, and the overflow message gets lost in softness.
3. Light table: the day as a backlit film strip with frames per hour. Rejected: frames imply
   equal slots, which hides duration, the one quantity we need to show.

## Tokens (code: `src/day/tokens.ts`)

| token | value | use |
|---|---|---|
| `enamel` | `#E6E8E4` | the rule body (cool off-white, never on a page background) |
| `ink` | `#1C2228` | ticks, hour numerals, text on light |
| `slate` | `#161B20` | non-immersive backdrop, setup page, panel ink |
| `flag` | `#FF4F8B` | flagging tape: end-of-day flag, overflow, now-needle. At most 3 uses in view |
| `focus` | `#2F6B6E` | deep-work tiles |
| `meet` | `#B4533A` | meeting / call tiles |
| `admin` | `#5B6C93` | admin / inbox tiles |
| `life` | `#6F8A4C` | lunch, walk, gym tiles |
| `chalk` | `#F2F3EF` | text on tiles |
| `spent` | `#7F868C` | done tiles |

Type: **Lexend** 600/700 (labels, designed for reading ease — matters on a headset) +
**Spline Sans Mono** 500/600 (all times and durations, tabular). Both OFL, self-hosted.
Radius language: tiles chamfered 4 mm, nothing rounder.

## Layout (seated, 2 ft radius)

- Span: arc radius 0.70 m around the user's head anchor, 0.22 m below eye height, work hours
  across ±44°. Overflow continues past the flag up to +62° — literally out of comfortable view.
- Tray: tilted plate 0.38 m ahead at desk height, inside ±25° (hands rest there).
- Control panel: left at -38°, growth rings: right at +36°. Essential controls stay in ±40°.

## Signature

The flagging-tape flag at the end of the work day, and overflow tiles that hang past it,
tinted pink and drooping. Second: growth rings, one ring per locked day.

## Motion

- settle: tile eases into its slot 220 ms `easeOutBack(1.3)`; later tiles ripple aside with
  35 ms stagger.
- droop: overflow tiles rotate 9° down over 400 ms.
- pick-up: tile lifts 8 mm and scales 1.04 while held.
- Sound: a short wooden "tok" on snap (WebAudio, no assets), a low two-note on lock.
