---
title: Meeus Saturn ring geometry
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 310
description: Computes the geocentric opening, pole orientation, and apparent outer-ring dimensions of Saturn's rings.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - SaturnRing
---

# Meeus Saturn ring geometry

`SaturnRing` calculates the Meeus chapter 45 orientation and angular size of Saturn's rings for a geocentric view. Use its tuple to draw the projected outer ring or to supply ring-plane angles to the Meeus Saturn magnitude formulas. The input is a numeric **TT Julian ephemeris day (JDE)**, and all returned angles are **radians**.

## Basic usage

```ts
import { SaturnRing } from '../src/astronomy/ephemeris/meeus';
import { toArcsec, toDeg } from '../src/math/units/angle';

const [earthLatitude, sunLatitude, longitudeDifference, poleAngle, majorDiameter, minorDiameter] = SaturnRing.ring(2448972.50068);
console.log(toDeg(earthLatitude), toDeg(sunLatitude), toDeg(longitudeDifference), toDeg(poleAngle));
console.log(toArcsec(majorDiameter), toArcsec(minorDiameter));
```

At this chapter example epoch, the first four values are about `[+16.442°, +14.679°, 4.198°, 6.741°]`; the outer-ring major and minor diameters are about `35.87″` and `10.15″`.

## Returned geometry

| Index | Meaning                                                                                                                 |
| ----- | ----------------------------------------------------------------------------------------------------------------------- |
| 0     | Saturnicentric latitude `B` of **Earth** relative to the ring plane; its sign distinguishes the two sides of the plane. |
| 1     | Saturnicentric latitude `B′` of the **Sun** relative to the ring plane.                                                 |
| 2     | Absolute Saturnicentric longitude difference `deltaU` between Sun and Earth measured in the ring plane, in `[0, π]`.    |
| 3     | Apparent position angle `P` of Saturn's north pole on the sky, in `[-π, π]`.                                            |
| 4     | Apparent **major diameter of the outer ring**, in radians.                                                              |
| 5     | Apparent **minor diameter of the outer ring**, in radians.                                                              |

The outer-ring major diameter is `375.35″ / distanceAU`, where `distanceAU` is the modeled Earth–Saturn distance. The minor diameter is the major diameter multiplied by `|sin(B)|`, so it approaches zero when Earth views the ring edge-on. `B` is ring-plane latitude, not the planetographic latitude of a point on Saturn. The longitude difference is wrapped before its absolute value is taken, keeping an antimeridian crossing from appearing as a nearly full-turn separation.

## Saturn magnitude inputs

`SaturnRing.ub(jde)` returns a fresh **`[deltaU, B]`** pair from `ring(jde)`. `Illuminated.saturn` and `saturn84` expect those quantities in the reverse argument order, **`(r, delta, B, deltaU)`**, after the Sun–Saturn and Earth–Saturn distances in AU. In particular, the magnitude formulas use the Earth latitude and longitude difference; they do not take the returned solar latitude `B′`.

## Model and limits

The calculation uses VSOP87E Earth and Saturn positions, FK5 conversion, **two Saturn light-time iterations**, nutation, and low-order aberration for the apparent pole direction. Its output is geocentric: it does not include a terrestrial observing site, topocentric parallax, or atmosphere. The ring dimensions describe the modeled **outer ring**; they are not the planet's angular diameter or a resolved ring-edge shape. The implementation does not publish a uniform error bound across epochs.

## Related topics

- [Meeus Planetary Magnitudes]({% link astronomy/meeus-algorithms/planetary-magnitudes.md %}) uses `B` and `deltaU` in its Saturn formulas.
- [Meeus Saturnian Satellite Positions]({% link astronomy/meeus-algorithms/saturnian-satellite-positions.md %}) places moons on a related geocentric disk view.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) covers numeric TT JDE and calendar labels.
