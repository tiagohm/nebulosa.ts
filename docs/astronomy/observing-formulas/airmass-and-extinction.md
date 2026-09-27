---
title: Airmass and Extinction
layout: default
parent: Observing Formulas
grand_parent: Astronomy
nav_order: 10
description: Estimates line-of-sight airmass, atmospheric magnitude loss, and a simple true-altitude refraction correction.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - airmass
    - airmassKastenYoung
    - atmosphericExtinction
    - atmosphericRefraction
---

# Airmass and Extinction

These formulas provide quick atmospheric planning quantities from a target's sky geometry. Use `airmass` or `airmassKastenYoung` to estimate the optical path relative to the zenith, then apply an extinction coefficient if one is available. `atmosphericRefraction` is a separate simple altitude correction; it is not the refraction model used by the observed-place conversion.

## Basic usage

```ts
import { airmass, airmassKastenYoung, atmosphericExtinction, atmosphericRefraction } from '../src/astronomy/formulas';
import { deg } from '../src/math/units/angle';

const zenithDistanceAirmass = airmass(deg(45));
const lowAltitudeAirmass = airmassKastenYoung(deg(30));
const magnitudeLoss = atmosphericExtinction(0.2, lowAltitudeAirmass);
const refractionArcmin = atmosphericRefraction(deg(30));
console.log({ zenithDistanceAirmass, lowAltitudeAirmass, magnitudeLoss, refractionArcmin });
```

Angles are **radians**. `airmass(zenithDistance)` uses `sec(z) = 1 / cos(z)` for zenith distance in `[0, π/2)`, returning a dimensionless value. It diverges toward the horizon, so use `airmassKastenYoung(altitude)` for a positive altitude near the horizon. The Kasten–Young approximation internally converts altitude to degrees for its fitted constants and clamps the result to at least `1`, correcting its slight zenith undershoot. The two functions accept different angles: `z` is measured **from** zenith, whereas altitude is measured **above** the horizon.

`atmosphericExtinction(extinctionCoefficientMagPerAirmass, airmass)` returns `coefficient × airmass` in **magnitudes**. A positive result is a magnitude increase, meaning the target appears dimmer. The coefficient is magnitudes per airmass; provide a local value appropriate for the band and observing conditions. The function throws `RangeError` when supplied airmass is below `1` or unordered.

`atmosphericRefraction(trueAltitude)` evaluates the Sæmundsson planning formula from a positive **true geometric altitude**, returning a correction in **arcminutes**. Add that correction to true altitude to estimate apparent altitude, converting arcminutes to radians first if the result will be combined with a radian angle. This function has no pressure, temperature, humidity, or wavelength input and is separate from the ERFA-based [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) and observed-place chain.

## Model and limits

These are first-order planning estimates. Plane-parallel `sec(z)` grows without bound near the horizon, and the Kasten–Young and Sæmundsson approximations have restricted physical domains. Neither the airmass nor refraction result represents a full atmospheric profile. Use a current site, time, and appropriately reduced altitude when preparing an observing plan.

## Related topics

- [Observation Scores]({% link observation/observation-scores.md %}) derives Kasten–Young airmass from a positive supplied target altitude when no airmass is given.
- [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) calculates an atmospheric altitude shift at a wavelength with supplied conditions.
