---
title: Local Standard of Rest Frames
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 40
description: Applies conventional solar-motion velocity offsets in ICRS or Galactic axes without moving the position origin.

doc_kind: topic

sources:
    - src/astronomy/coordinates/affine.ts

api:
    - LSR_DEFAULT_SOLAR_VELOCITY
    - lsrFrame
    - LSRK_SOLAR_VELOCITY_ICRS
    - lsrkFrame
    - LSRD_SOLAR_VELOCITY
    - lsrdFrame
    - galacticLsrFrame
---

# Local Standard of Rest Frames

These [affine frames]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) change a Cartesian state's **velocity zero point** by a chosen conventional solar motion. `lsrFrame`, `lsrkFrame`, and `lsrdFrame` keep ICRS-oriented positions and velocities; `galacticLsrFrame` rotates both onto Galactic axes as it adds the velocity offset. None translates the position origin.

## Basic usage

```ts
import { affineFromBase, galacticLsrFrame } from '../src/astronomy/coordinates/affine';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import type { Vec3 } from '../src/math/linear-algebra/vec3';
import { toKilometerPerSecond } from '../src/math/units/velocity';

const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC);
const restState: readonly [Vec3, Vec3] = [
	[0, 0, 0],
	[0, 0, 0],
];
const [galacticPosition, galacticVelocity] = affineFromBase(restState, galacticLsrFrame(), instant);
const uvwKilometersPerSecond = galacticVelocity.map(toKilometerPerSecond);
```

The zero input velocity becomes approximately `[+11.1, +12.24, +7.25]` km/s in Galactic Cartesian U/V/W. The positive sign follows the implementation's convention: it **adds** the adopted solar motion to the input velocity. `galacticPosition` remains at the origin because the example starts there. For a nonzero position, this frame rotates it but keeps the same spatial origin.

## Variants and units

Galactic U points toward the Galactic center, V toward Galactic longitude 90° in the plane, and W toward the north Galactic pole. The configurable `solarVelocity` argument and the exported velocity constants are **AU/day**, even though the conventional values below are commonly quoted in km/s. Convert a custom km/s component with `kilometerPerSecond` before passing it to `lsrFrame` or `galacticLsrFrame`.

| Frame                              | Axes and added velocity                                                                                                  | Default solar motion                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| `lsrFrame(solarVelocity?)`         | ICRS axes; converts the supplied Galactic U/V/W vector to ICRS and adds it to the input velocity. Position is unchanged. | `(11.1, 12.24, 7.25)` km/s U/V/W from Schönrich, Binney & Dehnen (2010). |
| `lsrkFrame()`                      | ICRS axes; adds the fixed ICRS vector `LSRK_SOLAR_VELOCITY_ICRS`. Position is unchanged.                                 | Approximately 20 km/s solar-apex convention.                             |
| `lsrdFrame()`                      | ICRS axes; converts and adds `LSRD_SOLAR_VELOCITY`. Position is unchanged.                                               | `(9, 12, 7)` km/s U/V/W from the Delhaye dynamical convention.           |
| `galacticLsrFrame(solarVelocity?)` | Galactic axes; rotates the position and input velocity, then adds the supplied U/V/W vector in those axes.               | The same `(11.1, 12.24, 7.25)` km/s as `lsrFrame`.                       |

Each function returns an `AffineFrame` whose `originAt` is absent and whose `originVelocityAt` encodes the **negative** of the solar-motion vector on the base axes. The affine transform subtracts that origin velocity, yielding the positive offset shown above. These are velocity conventions applied at the existing spatial origin; they do not model the Galactic center as the origin or add the Sun's full Galactic orbital speed.

{: .important }
Use an absolute `[position, velocity]` state with position in AU and velocity in AU/day. A position-only input receives no solar-motion correction. The result is a Cartesian velocity; calculating a line-of-sight radial velocity still requires projecting it onto the desired direction.

## Related topics

- [Affine Origin Frames]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) explains the velocity-offset sign and the inverse transform.
- [Galactocentric Frame]({% link astronomy/coordinates-and-observers/galactocentric-frame.md %}) changes the position origin to the Galactic center but supplies no solar-motion velocity by default.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) covers the ICRS and Galactic axis rotations.

## References

- [Schönrich, Binney & Dehnen (2010)](https://arxiv.org/abs/0912.3693) reports the `(11.1, 12.24, 7.25)` km/s solar peculiar motion used by the default LSR variants.
- [Astropy velocity-frame definitions](https://docs.astropy.org/en/stable/coordinates/spectralcoord.html#common-velocity-frames) describes the distinct LSR, LSRK, and LSRD conventions.
