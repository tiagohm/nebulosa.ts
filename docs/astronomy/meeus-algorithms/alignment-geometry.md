---
title: Meeus Alignment Geometry
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 230
description: Evaluates angular separation, great-circle alignment, and a compact three-body enclosing circle from supplied directions.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - AngularSeparation
    - Line
    - Circle
---

# Meeus Alignment Geometry

`AngularSeparation`, `Line`, and `Circle` provide the chapter-style geometry for two or three supplied sky directions. Use them to measure a separation, date a sampled great-circle crossing, or estimate the angular circle enclosing a compact group. Coordinates are `[right ascension, declination]` or `[longitude, latitude]` pairs in **radians**; keep all inputs in the same spherical frame.

## Basic usage

```ts
import { AngularSeparation, Circle, Line } from '../src/astronomy/ephemeris/meeus';

const separation = AngularSeparation.sep([0, 0], [0.02, 0]);
const [diameter, longestSideDefinesDiameter] = Circle.smallest([0, 0], [0.01, 0], [0.02, 0]);
const crossingTime = Line.time(0, 0, 1, 0, [0.5, 0.5, 0.5, 0.5, 0.5], [-0.2, -0.1, 0, 0.1, 0.2], 0, 4);
console.log(separation, diameter, longestSideDefinesDiameter, crossingTime);
```

In this synthetic example, the separation and enclosing diameter are `0.02` radians, the longest side defines the diameter, and the moving point crosses the reference great circle at time `2` in the caller's time units.

## Separation and relative position

`AngularSeparation.sep(c1, c2)` returns the great-circle separation in **radians**, from `0` to `π`. It switches to a Pauwels form for very small separations to avoid cancellation. `sepPauwels` evaluates that form directly, while `sepHav` uses the haversine form. These use spherical coordinates and handle an ordinary longitude wrap. `relativePosition(c1, c2)` returns the signed position angle of `c1` relative to `c2`, in radians; at the equator, a small positive first-coordinate offset of `c1` from `c2` gives approximately `+π/2`.

For two moving tracks, `minSep(jd1, jd3, cs1, cs2)` takes **three equally spaced corresponding coordinate pairs per track** and returns the value at the extremum of a quadratic interpolation of their sampled separations. `minSepHav` and `minSepPauwels` choose the named separation formulas. The optional fifth argument to `minSep` supplies a custom separation function; its output units become the result units. The method returns the **separation value**, not the event time. The interpolated extremum must lie inside the sample interval; otherwise it throws. Choose samples around a local minimum, since the method does not distinguish a maximum from a minimum. `minSepRect` applies a separate rectangular approximation for close configurations and is not interchangeable with the spherical-separation variants.

## Straight-line configurations

`Line.time(r1, d1, r2, d2, r3, d3, t1, t5)` finds when a moving third direction lies on the great circle through two fixed directions. The fixed pairs and the **five** values in each moving-coordinate array are radians. The five moving rows must be equally spaced from `t1` to `t5`; the returned time uses the same units and scale as those endpoints. This is a five-point interpolation of a great-circle equation, not a search of an ephemeris. The crossing must lie inside the supplied table; the interpolation may throw when it cannot converge or finds a zero outside the interval.

For a fixed triple, `Line.error` returns the **signed angular distance** of the third point from the oriented great circle through the first two points. Reversing the first two points reverses the sign. `Line.angleError` returns a fresh `[angle between great-circle normals, signed middle-point error]` pair in radians; `Line.angle` returns the chapter's angle formed by the three directions. The defining points must give a unique great circle, so coincident or antipodal defining pairs are outside the useful domain.

## Smallest enclosing circle

`Circle.smallest(c1, c2, c3)` returns a fresh `[angular diameter in radians, typeI]`. When `typeI` is `true`, the longest pairwise separation is the diameter; otherwise the three points define the diameter through the chapter 20 formula. It uses spherical pairwise separations but then treats those lengths as a **planar triangle**, so use it for compact groups rather than a general minimum enclosing circle on the sphere.

## Accuracy and limits

The separation functions evaluate supplied directions; the three- and five-row helpers interpolate supplied samples and do not calculate positions between them from an orbital model. Their accuracy depends on sample spacing and the geometry between rows. These calculations do not establish an occultation, physical alignment in three-dimensional space, or an observer-specific event unless the input directions already carry the intended observer and time-scale conventions.

## Related topics

- [Meeus Conjunction Interpolation]({% link astronomy/meeus-algorithms/conjunction-interpolation.md %}) locates a coordinate crossing from five sampled pairs.
- [Meeus Coordinate Transforms]({% link astronomy/meeus-algorithms/coordinate-transforms.md %}) transforms directions between the coordinate systems used here.
- [Meeus Numerical Helpers]({% link astronomy/meeus-algorithms/numerical-helpers.md %}) describes the interpolation primitives.
