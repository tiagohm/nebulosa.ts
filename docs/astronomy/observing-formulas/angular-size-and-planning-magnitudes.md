---
title: Angular Size and Planning Magnitudes
layout: default
parent: Observing Formulas
grand_parent: Astronomy
nav_order: 40
description: Estimates apparent angular diameter, mean surface brightness, and simple comet and asteroid magnitudes.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - objectAngularDiameter
    - surfaceBrightness
    - cometMagnitudeEstimate
    - asteroidMagnitudeEstimate
---

# Angular Size and Planning Magnitudes

These compact formulas help size a target in the sky and sketch its brightness from supplied physical and photometric parameters. They do not fetch a body position, calculate a phase correction, or model a detailed brightness distribution.

## Basic usage

```ts
import { asteroidMagnitudeEstimate, cometMagnitudeEstimate, objectAngularDiameter, surfaceBrightness } from '../src/astronomy/formulas';
import { toDeg } from '../src/math/units/angle';

// Diameter and distance are both in kilometers in this example.
const diameterRadians = objectAngularDiameter(1_391_400, 149_597_870.7);
const diameterArcmin = toDeg(diameterRadians) * 60;

const meanSurfaceBrightness = surfaceBrightness(10, 3_600);
const cometMagnitude = cometMagnitudeEstimate(8, 0.5, 1.2, 10);
const asteroidMagnitude = asteroidMagnitudeEstimate(12, 1.5, 0.8, 0.3);
console.log({ diameterArcmin, meanSurfaceBrightness, cometMagnitude, asteroidMagnitude });
```

| Function                                                  | Supplied quantities                                                                                                                               | Result                                                                   |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `objectAngularDiameter(diameter, distance)`               | Positive physical diameter and observer distance in the **same length unit**                                                                      | Full angular diameter `2 atan(diameter / (2 distance))` in **radians**   |
| `surfaceBrightness(magnitude, areaArcsecSquared)`         | Integrated magnitude and positive angular area in **square arcseconds**                                                                           | Mean surface brightness `magnitude + 2.5 log10(area)` in **mag/arcsec²** |
| `cometMagnitudeEstimate(H, delta, r, k)`                  | Supplied absolute magnitude `H`, observer distance `delta` in **AU**, heliocentric distance `r` in **AU**, and activity coefficient `k`           | Estimated apparent magnitude `H + 5 log10(delta) + k log10(r)`           |
| `asteroidMagnitudeEstimate(H, r, delta, phaseCorrection)` | Supplied absolute magnitude `H`, heliocentric distance `r` in **AU**, observer distance `delta` in **AU**, and phase correction in **magnitudes** | Estimated apparent magnitude `H + 5 log10(r × delta) + phaseCorrection`  |

The area in `surfaceBrightness` is the angular area used to spread the integrated flux; the result is an average, not a per-pixel value or a radial brightness profile. The two magnitude functions use positive distances and supplied photometric parameters. In particular, `asteroidMagnitudeEstimate` adds the caller's phase correction; it does not derive one from a phase angle. These are planning expressions rather than the separate body-specific planetary magnitude models.

## Related topics

- [Telescope Optical Estimates]({% link imaging/telescope-optical-estimates.md %}) covers visual field of view and related telescope quantities.
- [Image Scale and Sampling]({% link imaging/image-scale-and-sampling.md %}) relates an angular size to sensor pixels.
