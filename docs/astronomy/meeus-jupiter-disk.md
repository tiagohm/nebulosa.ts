---
title: Meeus Jupiter Disk
layout: default
parent: Astronomy
nav_order: 480
description: Computes the Meeus physical ephemeris of Jupiter with System I and II central meridians and disk-pole orientation.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Jupiter
---

# Meeus Jupiter Disk

`Jupiter` calculates the chapter 43 orientation of Jupiter's apparent disk at a numeric **TT Julian ephemeris day (JDE)**. Use its System I and II central meridians and pole angle for a Meeus-style disk drawing. The full method evaluates VSOP87E-based geometry; a shorter analytic approximation is available when the pole angle is not needed.

## Basic usage

```ts
import { Jupiter } from '../src/astronomy/ephemeris/meeus';
import { toDeg } from '../src/math/units/angle';

const jde = 2448972.50068;
const [sunLatitude, earthLatitude, systemI, systemII, poleAngle] = Jupiter.physical(jde);
const approximate = Jupiter.physical2(jde);
console.log([sunLatitude, earthLatitude, systemI, systemII, poleAngle].map(toDeg));
console.log(approximate.map(toDeg));
```

For the chapter test instant, `physical` gives approximately `[−2.2°, −2.48°, 268.06°, 72.74°, 24.8°]`; `physical2` gives about `[−2.194°, −2.5°, 268.12°, 72.79°]`. All returned quantities are **angles in radians** before the display conversion.

## Result contracts

| Function         | Result order                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `physical(jde)`  | Fresh `[solar declination, Earth declination, System I central meridian, System II central meridian, north-pole position angle]` |
| `physical2(jde)` | Fresh `[solar declination, Earth declination, System I central meridian, System II central meridian]`                            |

The first two values are the planetocentric latitudes of the Sun and Earth relative to Jupiter's equator. The two meridians use **different Jovian rotation systems** and are normalized to `[0, 2π)` radians. The final value from `physical` is the apparent position angle of Jupiter's north pole on the sky, also normalized to `[0, 2π)`. `physical2` does not return that pole angle.

## Model and limits

`physical` combines VSOP87E Earth and Jupiter positions in the ecliptic of the reception date, with **two light-time refinements** for Jupiter. It applies the chapter's rotation rates, FK5 correction, nutation, and aberration terms. `physical2` uses chapter 43's shorter analytic formulas for the four values it returns; it does not evaluate the VSOP87E position path. The two methods can give slightly different angles, and neither publishes an accuracy bound for arbitrary epochs.

These are geocentric disk quantities; they do not include a terrestrial observing site or atmospheric effects. They do not locate the Great Red Spot or any moon. The `JupiterMoons` namespace calculates a separate satellite-position model, and an IAU body-fixed orientation workflow uses different rotation conventions.

## Related topics

- [Meeus Mars Disk]({% link astronomy/meeus-mars-disk.md %}) documents the neighboring chapter's disk tuple.
- [Meeus Geocentric Planet Positions]({% link astronomy/meeus-geocentric-planet-positions.md %}) describes the planetary series behind the full reduction.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) covers numeric TT JDE and calendar labels.
