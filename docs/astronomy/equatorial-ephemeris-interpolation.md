---
title: Equatorial Ephemeris Interpolation
layout: default
parent: Astronomy
nav_order: 190
description: Interpolates sampled right ascension and declination over time.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/interpolation/ephemeris.ts

api:
    - EphemerisPoint
    - EphemerisInterpolationOptions
    - EphemerisInterpolationDiagnostics
    - EphemerisInterpolator
    - UpdatableEphemerisInterpolator
    - linearInterpolator
    - splineInterpolator
    - chebyshevInterpolator
    - LinearEphemerisInterpolator
    - SplineEphemerisInterpolator
    - ChebyshevEphemerisInterpolator
---

# Equatorial Ephemeris Interpolation

These interpolators turn a series of sampled equatorial directions into right ascension and declination at intermediate instants. Use them for dense pointing or chart positions from an existing ephemeris sample table. They interpolate the **angles supplied by the caller**; they do not integrate an orbit, compute distance, or apply observation corrections.

## Basic usage

```ts
import { linearInterpolator } from '../src/astronomy/ephemeris/interpolation/ephemeris';
import { time, Timescale } from '../src/astronomy/time/time';

const points = [
	{ time: time(2460000, 0, Timescale.TT), rightAscension: 1.0, declination: 0.2 },
	{ time: time(2460000, 1, Timescale.TT), rightAscension: 1.2, declination: 0.3 },
];
const interpolator = linearInterpolator(points);
const middle = time(2460000, 0.5, Timescale.TT);
const [rightAscensionRad, declinationRad] = interpolator.compute(middle);
console.log(rightAscensionRad, declinationRad);
```

Each `EphemerisPoint` has a `Time`, `rightAscension`, and `declination`; both angles are in **radians**. Sample and query times are converted to **TT** internally. The input points are sorted by instant and fitted using time in **days relative to the first sample**. `startTime` and `endTime` are the endpoint Julian Dates in TT, and `sampleCount` counts unique sample instants.

## Choosing a fit

| Entry point                                        | Fit                                              | Minimum samples |
| -------------------------------------------------- | ------------------------------------------------ | --------------: |
| `linearInterpolator(points, options?)`             | Piecewise linear                                 |               2 |
| `splineInterpolator(points, type?, options?)`      | Piecewise cubic; `naturalCubic` by default       |               3 |
| `chebyshevInterpolator(points, degree?, options?)` | Least-squares polynomial over the whole interval |      Degree + 1 |

Spline types are `naturalCubic`, `cubicHermite`, `pchip`, `akima`, and `catmullRom`. The default Chebyshev degree is the smaller of 12 and one less than the number of input points. The corresponding `LinearEphemerisInterpolator`, `SplineEphemerisInterpolator`, and `ChebyshevEphemerisInterpolator` classes expose the same behavior and can be constructed directly.

Right ascension is unwrapped across the 0/2π seam before fitting and normalized to **[0, 2π)** in the result. Declination is fitted as supplied. A sequence whose true RA changes by more than π between adjacent samples can be unwrapped along the wrong branch; sample it more densely. The interpolated direction retains the frame, observer, and apparent or geometric meaning of the input angles.

## Queries, updates, and limits

`compute(time)` allocates `[RA, Dec]`. `computeInto(time, out)` writes the caller's two-element buffer and returns that same buffer. `resample(times)` returns new points with the requested `Time` objects and fitted angles. The class instances implement `UpdatableEphemerisInterpolator.update(points)`, which rebuilds the fit from a replacement series.

The `outOfRange` option defaults to `clamp`, evaluating at the nearest endpoint. Choose `throw` for a `RangeError` outside the sample interval or `extrapolate` to extend the fit; extrapolation can be unreliable, especially for a polynomial. With `computeRmsError: true`, `diagnostics` reports RMS and maximum absolute fit residuals for RA and Dec in **radians** at the sample times. These are fit residuals, not errors against the true sky position.

Construction requires enough unique instants for the selected fit and finite sample times and angles. Duplicate instants throw unless `allowDuplicateTimes: true` is supplied; then the later input point at that instant replaces the earlier one. A Chebyshev degree must be a positive integer. Interpolating angular samples alone can miss rapid motion or distance changes near a close approach; resample the underlying ephemeris sufficiently densely for the intended accuracy.

## Related topics

- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) explains how geometric states become observed directions.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates numerical Cartesian states rather than fitting sampled angles.
