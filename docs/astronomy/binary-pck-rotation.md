---
title: Binary PCK Rotation
layout: default
parent: Astronomy
nav_order: 80
description: Evaluates a body-fixed rotation and its rate from a NAIF binary PCK.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/kernels/pck.ts

api:
    - readPck
    - Pck
    - PckSegment
---

# Binary PCK Rotation

`readPck` turns a parsed NAIF binary Planetary Constants Kernel (PCK) into time-dependent body-fixed frames. Use it when a kernel supplies the orientation of the body or satellite of interest. The evaluated orientation follows the kernel's coefficients and coverage, rather than the library's built-in IAU analytical orientation tables.

## Basic usage

```ts
import fs from 'fs/promises';
import { readDaf } from '../src/astronomy/ephemeris/kernels/daf';
import { readPck } from '../src/astronomy/ephemeris/kernels/pck';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { fileHandleSource } from '../src/io/io';

// Run from a repository checkout containing the lunar PCK fixture.
await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'));
const pck = readPck(await readDaf(source));
const frame = pck.segment(31006); // MOON_PA_DE421 frame class ID
if (frame === undefined) throw new Error('lunar PCK frame is absent');
if (frame.inertialFrameId !== 1) throw new Error('expected J2000 inertial axes');

await frame.initialize();
const instant = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB);
const inertialToBodyFixed = frame.rotationAt(instant);
const ratePerDay = frame.dRdtTimesRtAt(instant);
console.log(inertialToBodyFixed, ratePerDay);
```

`readPck` accepts a `Daf` parsed by `readDaf`; it reads the segment summaries and returns a `Pck`. `pck.segment(id)` looks up a **PCK frame class ID**, which can differ from a body's NAIF ID. An unknown ID returns `undefined`. Call `await frame.initialize()` before evaluating that frame, or `await pck.initialize()` to initialize every segment. Initialization reads each segment's record directory; coefficient records are loaded and cached when an epoch first needs them.

## Rotation and rate

For a Type 2 segment, the kernel stores Chebyshev series for three Euler angles. `rotationAt(time)` returns a 3 × 3 matrix that maps vectors from the segment's `inertialFrameId` axes into its body-fixed axes. The example kernel uses inertial frame ID `1` (J2000). Other inertial frame IDs need an appropriate frame conversion before combining their matrices with J2000-oriented vectors. The rotation changes axes; it does not translate a position to the body center.

`dRdtTimesRtAt(time)` returns the angular-rate operator **W = (dR/dt) Rᵀ**, with entries in radians per day. Use it when transporting velocity between the rotating and inertial frames. Both methods convert the supplied `Time` to **TDB**; the segment's `start` and `end` coverage fields are TDB seconds past J2000. Each returned matrix is a fresh copy, so changing it does not change later evaluations.

If several segments have the same frame class ID and cover the requested instant, the last covering segment in file order takes precedence. Coverage includes both endpoints. An epoch outside coverage throws; evaluating before initialization also throws.

## Accuracy and limitations

This reader supports binary PCK **Type 2** segments. Encountering another PCK segment type throws while reading the kernel. The orientation's precision and useful date range depend on the supplied kernel; the reader does not extrapolate beyond its segment coverage. Evaluation reads coefficient records synchronously, so the DAF byte source must support `readSync` and remain open until evaluations finish.

## Related topics

- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) explains the common DAF container and translational SPK states.
- [Planetary Surface Locations]({% link astronomy/coordinates-and-observers/planetary-surface-locations.md %}) accepts a rotating frame to locate a point on a body's surface.
