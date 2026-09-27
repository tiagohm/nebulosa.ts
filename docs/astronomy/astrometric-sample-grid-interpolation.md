---
title: Astrometric Sample-Grid Interpolation
layout: default
parent: Astronomy
nav_order: 200
description: Interpolates sky directions from a regular image-pixel sample grid.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/interpolation/astrometric.ts

api:
    - AstrometricInterpolator
    - AstrometricInterpolatorOptions
    - AstrometricInterpolationMethod
---

# Astrometric Sample-Grid Interpolation

`AstrometricInterpolator` converts an image pixel coordinate to right ascension and declination using a **regular grid of precomputed sky coordinates**. It suits cursor readout on a plate-solved image when the grid has already been sampled. This is spatial interpolation within one image, not interpolation through an ephemeris time series.

## Basic usage

```ts
import { AstrometricInterpolator } from '../src/astronomy/ephemeris/interpolation/astrometric';

// Two columns by two rows, in row-major order; angles are radians.
const ra = new Float64Array([1.0, 1.1, 1.0, 1.1]);
const dec = new Float64Array([0.2, 0.2, 0.3, 0.3]);
const grid = new AstrometricInterpolator(ra, dec, 2, 2, 100, 100, { interpolation: 'bilinear' });
const [rightAscensionRad, declinationRad] = grid.pixelToSky(50, 50);
console.log(rightAscensionRad, declinationRad);
```

`raGrid` and `decGrid` have `width × height` samples in **row-major** order: index `row × width + column`. Grid sample `(column, row)` corresponds to image pixel `(column × stepX, row × stepY)`. Pixel **x increases with column** and **y increases with row**; the grid starts at pixel `(0, 0)`. `stepX` and `stepY` are positive pixel spacings. The sampled extent includes `x = (width − 1) × stepX` and `y = (height − 1) × stepY`. Queries outside it are clamped to its edges, without extrapolation.

Input RA and Dec and returned `[RA, Dec]` are in **radians**. Output RA is normalized to **[0, 2π)**. `pixelToSky(x, y, out?)` allocates a new two-element result when `out` is omitted; otherwise it writes and returns the supplied buffer. It inherits the sky frame and observation meaning of the input samples.

## Interpolation method

`options.interpolation` selects `nearest`, `bilinear`, `catmullRom`, or `cubicConvolution`; the default is **`catmullRom`**. The cubic methods use neighboring grid samples in both directions and reuse edge samples at the boundary. `cubicConvolution` uses a Keys kernel with `options.cubicTension`, which defaults to **−0.5**, the Catmull–Rom kernel setting. These are the implemented methods; other spline method names are outside the public type.

The constructor converts each RA/Dec sample into a unit Cartesian vector, stored in three `Float64Array` grids. A query blends those components, normalizes the resulting vector, and converts it back to angles. This avoids an artificial jump at the RA 0/2π seam. If blending produces a vector too short to normalize reliably, the query uses the nearest grid sample instead. A new interpolator copies the angular samples into its Cartesian grids; later edits to the input arrays do not update the grid.

## Limits and failures

The grid must have positive integer dimensions and finite angular samples, with RA and Dec arrays of equal length matching `width × height`. Construction throws for mismatched lengths or non-finite samples, and a non-finite cubic tension also throws. The class interpolates supplied directions; it does not solve a plate, compute a WCS model, or infer accuracy between sparsely spaced samples. Use a denser grid where the pixel-to-sky mapping changes rapidly.

## Related topics

- [Equatorial Ephemeris Interpolation]({% link astronomy/equatorial-ephemeris-interpolation.md %}) interpolates RA/Dec through time rather than across pixels.
- [Sky Projections]({% link astronomy/coordinates-and-observers/sky-projections.md %}) maps directions onto projection planes.
