---
title: Celestial and Terrestrial Reference Frames
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 10
description: Rotates vectors and position–velocity states among ICRS, equator and ecliptic, CIRS, TEME, TIRS, ITRS, and other axes.

doc_kind: topic

sources:
    - src/astronomy/coordinates/frame.ts
    - src/astronomy/coordinates/fk5.ts
    - src/astronomy/coordinates/icrs.ts

api:
    - Frame
    - CoordinateFrame
    - frameAt
    - frameToBase
    - frameToFrame
    - frameRotationAt
    - precessionMatrixCapitaine
    - fk5Frame
    - ICRS
    - FK5
    - FK4
    - GALACTIC
    - SUPERGALACTIC
    - CIRS
    - TEME
    - TIRS
    - ITRS
    - ITRS_INSTANTANEOUS
    - temeToItrf
    - itrfToTeme
    - temeToItrfByGmst
    - itrfToTemeByGmst
    - icrsToFk5
    - fk5ToIcrs
    - precessFk5
    - precessFk5FromJ2000
    - precessFk5ToJ2000
    - icrs
    - fk5
---

# Celestial and Terrestrial Reference Frames

`frameToFrame` expresses a Cartesian vector or `[position, velocity]` state on different axes at one `Time`. The frames share a GCRS/ICRS-oriented base: `frameAt` rotates from that base into a chosen frame, and `frameToBase` reverses the rotation. The transform **does not move the origin**. A geocentric vector remains geocentric; a barycentric vector remains barycentric even when expressed on terrestrial axes. Use an origin-aware transformation when the origin must change.

## Basic usage

```ts
import { frameRotationAt, frameToFrame, ICRS, ITRS } from '../src/astronomy/coordinates/frame';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import type { Vec3 } from '../src/math/linear-algebra/vec3';

const instant = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);
const state: readonly [Vec3, Vec3] = [
	[0.00005, 0.00002, 0.00001], // geocentric position, AU
	[-0.004, 0.002, 0.001], // velocity, AU/day
];

const earthFixed = frameToFrame(state, ICRS, ITRS, instant);
const restored = frameToFrame(earthFixed, ITRS, ICRS, instant);
const positionRotation = frameRotationAt(ICRS, ITRS, instant);
```

The example's ICRS input means axes aligned with the library base, **not** an inferred solar-system-barycenter origin. `positionRotation` applies to positions and directions. Use `frameToFrame` for a state so that `earthFixed[1]` includes the rotating-frame velocity term. Load [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) before an Earth-fixed calculation that needs measured DUT1 and polar motion.

## Transform contract

`CoordinateFrame` is either a `Vec3` or a two-vector `[position, velocity]` state. For an ephemeris state, positions use AU and velocities AU/day. A direction or other vector can use any consistent distance scale; a state must pair that distance unit with **per-day velocity** because the frame-rate operators are per day. The orientation matrices preserve vector length to floating-point precision and do not apply light-time, aberration, deflection, parallax, or refraction.

| API                                         | Direction and result                                                                                        |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `frameAt(value, frame, time, out?)`         | Base axes → `frame`; rotates a vector or transports a full state.                                           |
| `frameToBase(value, frame, time, out?)`     | `frame` → base axes; reverses the rotation and its velocity transport.                                      |
| `frameToFrame(value, from, to, time, out?)` | Converts through the base, including the source and destination frame-rate terms for a state.               |
| `frameRotationAt(from, to, time, out?)`     | Returns a flat row-major 3 × 3 orientation matrix `R_to · R_fromᵀ`. It contains no velocity transport term. |

The optional mutable output is returned to the caller and may alias the input for an in-place transform. Without it, the transforms allocate an output vector or state. The named lowercase wrappers in `frame.ts` call `frameAt` for their corresponding uppercase `Frame` constants; fixed-frame wrappers need no time, while date-dependent wrappers take a `Time`. For repeated position-only transforms at one instant, compute `frameRotationAt` once and apply it with `matMulVec`.

A `Frame` supplies `rotationAt(time)`, a base-to-frame orientation. A custom frame must return an orthonormal 3 × 3 matrix because the inverse uses its transpose. For a moving frame used with states, it may also supply `dRdtTimesRtAt(time, rotation?)`: the velocity operator `W = (dR/dt) · Rᵀ`, in day⁻¹. The implementation uses `p_frame = R p_base` and `v_frame = R v_base + W p_frame`. If that operator is absent, velocity receives the orientation rotation alone. Custom frames that rotate over time need an appropriate operator to transport a physical state velocity.

## Choosing axes

| Frame family                 | Available frames and distinction                                                                                                                                                                                                                                      |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fixed celestial              | `ICRS` is the identity base orientation. `FK5` is the J2000 frame bias; `FK4`, `MEAN_EQUATOR_AND_EQUINOX_AT_B1950`, `ECLIPTIC_B1950`, `ECLIPTIC_J2000`, `GALACTIC`, and `SUPERGALACTIC` use fixed matrices. `fk5Frame(equinox)` fixes FK5 axes at a supplied equinox. |
| Equator and ecliptic of date | `MEAN_EQUATOR_AND_EQUINOX_OF_DATE` and `MEAN_ECLIPTIC_OF_DATE` use IAU 2006 bias-precession and mean obliquity; `TRUE_EQUATOR_AND_EQUINOX_OF_DATE` and `ECLIPTIC` include nutation and use the true obliquity where appropriate. These are equinox-based axes.        |
| Celestial intermediate       | `CIRS` uses the CIO-based celestial-to-intermediate rotation. Its right-ascension origin differs from the true equinox. It is a geometric rotation, not an observed-place calculation.                                                                                |
| Earth rotating               | `TIRS` includes Earth rotation without the ITRS polar-motion matrix. `ITRS` adds polar motion. `ITRS_INSTANTANEOUS` has the same position rotation as `ITRS` but a different velocity operator.                                                                       |
| Satellite convention         | `TEME` uses the true equator and mean equinox of date. Its orientation changes with time, but its state transform omits celestial-axis velocity transport to follow the SGP4/TEME convention.                                                                         |

The five moving celestial frames (mean and true equator of date, mean and true ecliptic of date, and CIRS) derive `W` by a centered 60-second difference of their full orientation matrices. `TIRS` and `ITRS` use the constant nominal Earth-spin operator, based on `7.292115 × 10⁻⁵` rad/s. `ITRS_INSTANTANEOUS` instead uses a centered ±1-second difference of the GCRS-to-ITRS matrix for velocity transport. These choices affect a full state; `frameRotationAt` returns orientation alone.

## FK5, ICRS, and TEME helpers

`icrs(ra, dec, distance?)` from `icrs.ts` and `fk5(ra, dec, distance?)` from `fk5.ts` construct Cartesian vectors from spherical angles in radians. Distance is AU and defaults to one kiloparsec. Their names overlap with the lowercase rotation wrappers in `frame.ts`; import the intended function explicitly. `icrsToFk5` and `fk5ToIcrs` apply the fixed J2000 frame bias. For an FK5 coordinate at another equinox, precess it to J2000 with `precessFk5ToJ2000` before converting to ICRS. `precessionMatrixCapitaine(from, to)`, `precessFk5`, and the J2000 convenience wrappers use the IAU 2006 precession model with TT equinoxes.

`temeToItrf` and `itrfToTeme` use GMST from `Time`; their third argument includes polar motion by default and can disable its matrix with `false`. The `ByGmst` variants instead take an explicit GMST angle in radians and an optional polar-motion matrix. Their state velocity inputs must use distance per day: the Earth-spin correction has that unit. A vector-only call just rotates orientation. The generic `frameToFrame(state, TEME, ITRS, time)` provides the TEME-to-terrestrial path with the destination frame's velocity operator.

{: .warning }
For a general state with rotating source or destination axes, `frameRotationAt` omits the velocity transport; use `frameToFrame`. Likewise, rotating an ICRS vector into `CIRS` does not produce an apparent or topocentric observed place.

## Providers and cached orientation

Date-dependent frames use the time conversions and orientation providers selected by their call paths. For example, `ITRS` uses the precession-nutation, GAST, and polar-motion calculations associated with its `Time`. `CIRS` instead calls `cirsRotationMatrix`, which evaluates `eraC2i06a` on TT directly; overriding `Time.providers.pnm` does not replace that CIRS rotation. Derived orientation matrices may be cached on a `Time`. Construct a fresh `Time` after changing its providers or reloading the shared IERS tables.

## Related topics

- [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) defines the time-dependent orientation matrices and sidereal angles used here.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) describes `Time`, UTC, UT1, and TT.
- [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) supplies the measured DUT1 and polar motion needed by terrestrial axes.

## References

- [IERS Conventions (2010), chapters 2–5](https://www.iers.org/iers/en/publications/technicalnotes/tn36) describe the celestial and terrestrial reference systems and their transformation.
- The bundled ERFA `eraBp06`, `eraC2i06a`, and `eraC2teqx` routines provide the precession, CIRS, and terrestrial matrix paths used by these frames.
