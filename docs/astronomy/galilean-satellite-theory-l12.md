---
title: Galilean Satellite Theory (L1.2)
layout: default
parent: Astronomy
nav_order: 140
description: Evaluates jovicentric analytical states for Io, Europa, Ganymede, and Callisto.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/l12.ts

api:
    - io
    - europa
    - ganymede
    - callisto
    - compute
---

# Galilean Satellite Theory (L1.2)

The L1.2 analytical theory returns **Jupiter-centered geometric** positions and velocities for Io, Europa, Ganymede, and Callisto. Use it to place one of the four Galilean satellites when a suitable satellite SPK is not loaded. Each result is `[position, velocity]` in **AU** and **AU/day**, on J2000 equatorial axes.

## Basic usage

```ts
import { callisto, europa, ganymede, io } from '../src/astronomy/ephemeris/models/analytical/l12';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TT);
const [ioPositionAu, ioVelocityAuPerDay] = io(instant);
const [europaPositionAu] = europa(instant);
const [ganymedePositionAu] = ganymede(instant);
const [callistoPositionAu] = callisto(instant);
console.log(ioPositionAu, ioVelocityAuPerDay, europaPositionAu, ganymedePositionAu, callistoPositionAu);
```

The wrappers call `compute(time, index)` with `0` for Io, `1` for Europa, `2` for Ganymede, and `3` for Callisto. `compute` accepts those four indices. Each call converts the supplied `Time` to **TT** and measures days from JD 2433282.5. The returned vectors are new per call.

## Model and frame

L1.2 builds each satellite's equinoctial orbital elements from periodic series, adds long-period Chebyshev corrections to selected elements within the correction table's time window, solves the model's Kepler equation, and rotates the result into J2000 equatorial axes. Outside that Chebyshev window, the long-period correction is omitted while the remaining series is still evaluated. The code does not turn an out-of-window result into a flagged error, so use particular care with distant epochs.

The origin remains **Jupiter's center**. To obtain a barycentric satellite state, combine this state with a barycentric Jupiter-center state in compatible axes and units. A direct output is neither an Earth-centered sky direction nor a light-time-corrected or apparent position. Mutual-event contact geometry is a separate calculation after the relevant satellite and observer states have been assembled.

## Accuracy and limits

The local tests compare the four bodies at J2000 TT with the published L1.2 test vectors and check additional sample states. Those samples do not establish a uniform error bound over the model's date range. This is the L1.2 analytical theory, distinct from the shorter Galilean satellite formulas in the Meeus namespace; compare results using the same model, origin, frame, and epoch. Use a satellite SPK when its coverage and required precision are preferable.

## Related topics

- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) combines center-relative states and applies observation stages.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates covered numerical satellite states.
