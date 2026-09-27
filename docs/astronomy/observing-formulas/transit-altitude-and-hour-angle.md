---
title: Transit Altitude and Hour Angle
layout: default
parent: Observing Formulas
grand_parent: Astronomy
nav_order: 30
description: Estimates meridian transit altitude and the hour angle at which a fixed-declination target reaches a selected altitude.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - altitudeAtTransit
    - hourAngleAtAltitude
---

# Transit Altitude and Hour Angle

Use these geometric formulas to check how high a fixed-declination target culminates and where its daily circle crosses a chosen altitude. They operate on angles alone: the caller supplies the target declination and site latitude, and no ephemeris or clock is consulted.

## Basic usage

```ts
import { altitudeAtTransit, hourAngleAtAltitude } from '../src/astronomy/formulas';
import { deg, toDeg } from '../src/math/units/angle';

const latitude = deg(-23);
const declination = deg(-5);
const culminationAltitude = altitudeAtTransit(latitude, declination);
const horizonHourAngle = hourAngleAtAltitude(declination, latitude, deg(0));

console.log(toDeg(culminationAltitude)); // 72 degrees
console.log(horizonHourAngle === undefined ? 'no crossing' : toDeg(horizonHourAngle));
```

All input and output angles are **radians**. Latitude and declination are in `[-π/2, π/2]`. `altitudeAtTransit(latitude, declination)` evaluates `π/2 − |latitude − declination|` for the upper meridian transit. The result can be negative when the target culminates below the horizon.

`hourAngleAtAltitude(declination, latitude, targetAltitude)` solves

```text
cos(H) = [sin(targetAltitude) − sin(latitude) sin(declination)]
         / [cos(latitude) cos(declination)]
```

and returns the non-negative hour angle `H` in `[0, π]`. Hour angle is west-positive: the target reaches that altitude at `−H` on the rising side of the meridian and at `+H` on the setting side. At an exact tangent, both sides coincide. The function returns `undefined` if the target never crosses the requested altitude because it stays above or below it, or when the latitude or declination is at a pole and the denominator is degenerate. This result does not distinguish an always-above target from an always-below one.

## Choosing an altitude

Use a target altitude of zero for a geometric horizon crossing. A chosen negative altitude can incorporate a planning correction for refraction or apparent limb size, but these functions do not calculate either correction. They hold declination fixed and return no UTC instant or observing window. For an altitude and azimuth at a particular instant, use [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) with an appropriate sidereal time and target direction.
