---
title: Affine Origin Frames
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 20
description: Rotates absolute positions and states while shifting their position and velocity origins.

doc_kind: topic

sources:
    - src/astronomy/coordinates/affine.ts
    - src/astronomy/coordinates/frame.ts

api:
    - AffineFrame
    - affineFromBase
    - affineToBase
    - affineToAffine
    - BARYCENTRIC_ECLIPTIC
    - heliocentricEclipticFrame
---

# Affine Origin Frames

An `AffineFrame` adds an origin position and, for a moving origin, an origin velocity to a [reference-frame rotation]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}). Use it for an **absolute position** or `[position, velocity]` state when the requested frame has a different origin. For example, a barycentric state can be expressed relative to the Sun in J2000 ecliptic axes.

{: .important }
An origin shift needs a real distance. A normalized direction cannot be translated into a heliocentric or Galactocentric position. Supply base-frame positions in AU and state velocities in AU/day.

## Basic usage

```ts
import { affineFromBase, affineToBase, heliocentricEclipticFrame } from '../src/astronomy/coordinates/affine';
import { timeYMDHMS, Timescale, type Time } from '../src/astronomy/time/time';
import type { Vec3 } from '../src/math/linear-algebra/vec3';

// Illustration only: replace this constant state with the Sun's barycentric
// position and velocity from an ephemeris at the requested Time.
const sunAt = (_time: Time): readonly [Vec3, Vec3] => [
	[0.1, -0.9, 0.4], // AU, base axes
	[0.001, 0.017, 0.0005], // AU/day, base axes
];

const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC);
const barycentricState: readonly [Vec3, Vec3] = [
	[1.2, 0.3, -0.5], // AU
	[0.002, -0.001, 0.0008], // AU/day
];
const heliocentric = heliocentricEclipticFrame(sunAt);
const sunRelative = affineFromBase(barycentricState, heliocentric, instant);
const restored = affineToBase(sunRelative, heliocentric, instant);
```

`sunRelative` has a heliocentric origin and J2000 ecliptic axes. The callback must return the Sun's **barycentric** state on the same base axes as `barycentricState`; a geocentric or heliocentric Sun state would shift the wrong origin. The constant callback above demonstrates the API and is not an astronomical ephemeris.

## Transform contract

An `AffineFrame` extends `Frame` with optional `originAt(time)` and `originVelocityAt(time)`. Both return vectors expressed on the GCRS/ICRS-oriented base axes, in AU and AU/day respectively. An absent origin position means zero translation; an absent origin velocity means zero velocity offset. The library does not derive the origin velocity from changes in `originAt`, so provide both for a moving origin when transforming a state. The rotation's `dRdtTimesRtAt`, when present, contributes the same per-day transport term as in a rotation-only `Frame`.

Let `R` be the base-to-frame rotation, `O` the origin position, `Ȯ` its velocity, and `W = (dR/dt) · Rᵀ` when supplied. `affineFromBase` computes:

```text
p_frame = R (p_base − O)
v_frame = R (v_base − Ȯ) + W p_frame
```

For a position-only input, only the first equation applies. `affineToBase` undoes both operations: `p_base = Rᵀ p_frame + O` and `v_base = Rᵀ (v_frame − W p_frame) + Ȯ`. `affineToAffine(value, from, to, time, out?)` composes the source-to-base and base-to-destination paths. A plain rotation `Frame` is accepted as either endpoint, with zero origin offsets.

The optional `out` buffer is returned and may alias the input, including for a state. Without `out`, the functions allocate a new output. If a custom frame's rotation changes with time, provide the rate operator needed for its state velocities, just as for a rotation-only frame.

## Built-in ecliptic origins

| API                                | Origin and orientation                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `BARYCENTRIC_ECLIPTIC`             | The same fixed orientation as `ECLIPTIC_J2000`; it has no origin or velocity offset. A barycentric input remains barycentric. |
| `heliocentricEclipticFrame(sunAt)` | The same J2000 ecliptic orientation, with the Sun's barycentric position and velocity supplied by `sunAt(time)`.              |

`heliocentricEclipticFrame` calls `sunAt` separately for position and velocity during a full-state transform. Supply a repeatable ephemeris result for a given instant, and cache it if evaluating the Sun is costly. The function does not fetch or select an ephemeris itself.

## Related topics

- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) covers the orientation and velocity-rate terms without origin shifts.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) defines the `Time` passed to a frame and to `sunAt`.
