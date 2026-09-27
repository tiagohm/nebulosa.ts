---
title: Trailing and Smear Limits
layout: default
parent: Imaging
nav_order: 40
description: Estimates pixel displacement from sidereal or supplied angular motion and the exposure allowed by a blur budget.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - starTrailLength
    - maxExposureBeforeTrail
    - exposureSmearPixels
    - maxExposureForSmear
---

# Trailing and Smear Limits

These scalar formulas turn an angular motion rate into displacement on a camera sensor or solve for an exposure that stays within a pixel budget. Use the sidereal pair to estimate trailing with a fixed camera, or supply a measured or predicted relative angular rate for a moving target. The calculations do not model guided field rotation or polar-alignment residuals.

## Basic usage

```ts
import { exposureSmearPixels, maxExposureBeforeTrail, maxExposureForSmear, starTrailLength } from '../src/astronomy/formulas';
import { deg } from '../src/math/units/angle';

const imageScaleArcsecPerPixel = 1.2;
const siderealTrailPixels = starTrailLength(deg(30), 10, imageScaleArcsecPerPixel);
const siderealLimitSeconds = maxExposureBeforeTrail(2, imageScaleArcsecPerPixel, deg(30));
const relativeSmearPixels = exposureSmearPixels(-3, 5, imageScaleArcsecPerPixel);
const relativeLimitSeconds = maxExposureForSmear(-3, 2, imageScaleArcsecPerPixel);
console.log({ siderealTrailPixels, siderealLimitSeconds, relativeSmearPixels, relativeLimitSeconds });
```

Declination is in **radians**, exposure and limit durations in **seconds**, angular rates in **arcseconds per SI second**, and camera image scale in **arcseconds per pixel**. Results ending in `Pixels` are displacement lengths on the sensor; results ending in `Seconds` are exposure durations. A negative supplied angular rate produces the same smear length as its positive magnitude.

## Sidereal star trailing

`starTrailLength(declination, exposureSeconds, imageScaleArcsecPerPixel)` evaluates `SIDEREAL_RATE × cos(declination) × exposureSeconds / imageScaleArcsecPerPixel`. `SIDEREAL_RATE` is the sky's nominal sidereal angular rate in arcseconds per second. `maxExposureBeforeTrail(trailLimitPixels, imageScaleArcsecPerPixel, declination)` solves the same relation for the exposure duration allowed by a nonnegative pixel limit.

The inverse throws `RangeError` very close to either celestial pole, where `cos(declination)` is too small for a stable division. Elsewhere, use declination in `[-π/2, π/2]` and a positive image scale. These formulas represent nominal sidereal displacement relative to a fixed sensor; a tracking mount's residual motion requires a different supplied rate or model.

## Supplied angular motion

`exposureSmearPixels(angularRateArcsecPerSecond, exposureSeconds, arcsecPerPixel)` returns `|rate| × exposureSeconds / imageScale`. `maxExposureForSmear(angularRateArcsecPerSecond, smearLimitPixels, arcsecPerPixel)` returns `smearLimitPixels × imageScale / |rate|` for a nonzero rate. At exactly zero rate it returns `Infinity`, since this scalar model predicts no motion blur from that rate.

Use a rate that represents motion **relative to the camera** for the planned tracking mode. A single scalar rate cannot describe direction changes, field rotation, differential refraction, or a curved trail over the exposure.

## Related topics

- [Image Scale and Sampling]({% link imaging/image-scale-and-sampling.md %}) estimates the required arcseconds-per-pixel scale.
- [Exposure and Noise Estimates]({% link imaging/exposure-and-noise-estimates.md %}) evaluates electron budget and stacking once a subexposure is chosen.
