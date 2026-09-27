---
title: Solar disk physical ephemeris
layout: default
parent: Astronomy
nav_order: 460
description: Computes Meeus solar-disk orientation and approximate Carrington rotation start times from TT Julian ephemeris days.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - SolarDisk
---

# Solar disk physical ephemeris

`SolarDisk` supplies the Meeus chapter 29 orientation of the Sun's visible disk and an approximate start time for a numbered Carrington rotation. Use it to label solar-disk drawings or chapter-style heliographic coordinates. Its input and output instants are numeric **TT Julian ephemeris days (JDE)**; its orientation angles are **radians**.

## Basic usage

```ts
import { SolarDisk } from '../src/astronomy/ephemeris/meeus';
import { toDeg } from '../src/math/units/angle';

const [poleAngle, centerLatitude, centerLongitude] = SolarDisk.ephemeris(2448908.50068);
const rotation1699StartJde = SolarDisk.cycle(1699);
console.log(toDeg(poleAngle), toDeg(centerLatitude), toDeg(centerLongitude), rotation1699StartJde);
```

The chapter example yields approximately `P = +26.27°`, `B0 = +5.99°`, and `L0 = 238.63°`. `cycle(1699)` yields about `2444480.723` TT JDE. Convert a returned JDE through the required time-scale path before presenting a civil date.

## Disk orientation

`ephemeris(jde)` returns a fresh `[P, B0, L0]` tuple:

| Value | Meaning                                                                                                                                                                             |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P`   | Apparent position angle of the Sun's north pole, measured **eastward from celestial north** in the equatorial frame of date. A positive angle tilts the pole toward celestial east. |
| `B0`  | Heliographic latitude of the visible disk center; positive when the observer sees the Sun's northern hemisphere tilted toward Earth.                                                |
| `L0`  | Carrington heliographic longitude of the disk center, wrapped to `[0, 2π)` radians.                                                                                                 |

The implementation combines the chapter's fixed solar-axis inclination and rotation terms with the VSOP87E-based geocentric solar longitude, nutation, true obliquity, and low-order solar aberration. The explicit rotation term is subtracted from `L0`: with the viewing geometry held fixed, the central-meridian Carrington longitude decreases as the Sun rotates, modulo a full turn. `P` is a sky-plane orientation, while `L0` is a solar-surface longitude; neither is the IAU prime-meridian angle `W`.

## Carrington rotation starts

`cycle(c)` takes an **integer Carrington rotation number** and returns its estimated start as a TT JDE. It uses the chapter's mean synodic period of `27.2752316` days plus periodic terms. It does not search a solar ephemeris for an observed crossing. The neighboring `carringtonRotationNumber(time)` function in `src/astronomy/bodies/sun.ts` takes a `Time` and returns a rounded rotation index from a simpler synodic-period expression; it is a different operation and uses a different epoch constant.

## Accuracy and limits

This is a Meeus disk-orientation model for a geocentric solar direction. It does not include a terrestrial observer's parallax or atmospheric effects, and it does not provide an accuracy bound across arbitrary epochs. The IAU cartographic `SUN_ROTATION` pole and prime-meridian model supplies a different orientation convention; choose that model when an IAU body-fixed frame is required. Solar angular semidiameter and parallax are separate distance-scaled quantities, not components of `[P, B0, L0]`.

## Related topics

- [Meeus Solar Coordinates]({% link astronomy/meeus-solar-coordinates.md %}) describes the VSOP87E solar longitude and aberration used here.
- [Meeus Nutation and Obliquity]({% link astronomy/meeus-nutation-and-obliquity.md %}) covers the nutation and obliquity inputs.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) covers numeric TT JDE and calendar labels.
