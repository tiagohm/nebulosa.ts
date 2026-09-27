---
title: Meeus Saturnian Satellite Positions
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 300
description: Projects eight Saturnian moons into Saturn-centered Earth-view offsets with the Meeus and Dourneau chapter 46 model.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - SaturnMoons
---

# Meeus Saturnian Satellite Positions

`SaturnMoons.positions(jde)` projects eight major Saturnian moons for a geocentric sky drawing. It implements the Dourneau theory as presented in Meeus chapter 46 and accepts a numeric **TT Julian ephemeris day (JDE)**. The result is a fresh, Saturn-centered tuple of eight `[X, Y, Z]` vectors in **Saturn equatorial radii**.

## Basic usage

```ts
import { SaturnMoons } from '../src/astronomy/ephemeris/meeus';

const moons = SaturnMoons.positions(2451439.50074);
const rhea = moons[SaturnMoons.RHEA];
const titan = moons[SaturnMoons.TITAN];
console.log(rhea, titan);
```

At this chapter example epoch, Rhea is about `[-0.972, -3.136, +8.080]` and Titan about `[+14.568, +4.738, -12.755]` in Saturn radii. Each call allocates a new outer tuple and eight new vectors.

## Moon order and axes

| Index | Satellite |
| ----- | --------- |
| 0     | Mimas     |
| 1     | Enceladus |
| 2     | Tethys    |
| 3     | Dione     |
| 4     | Rhea      |
| 5     | Titan     |
| 6     | Hyperion  |
| 7     | Iapetus   |

The exported uppercase constants have these same indices. The origin is Saturn's center: `X` points **west** on the projected disk, `Y` points **north along Saturn's projected rotation axis**, and `Z` points **away from Earth**. The first two components locate a moon on a disk drawing; `Z` gives model line-of-sight placement. These are dimensionless radius multiples, not AU or J2000 Cartesian states.

## Model and limits

The method evaluates the chapter's satellite orbital terms and derives an Earth-view projection from a VSOP87E-based Sun and Saturn geometry. It refines Saturn's light time twice, then applies differential light-time and perspective corrections to the projected moon positions. It includes no observing-site parallax or atmosphere, and it does not classify transits, occultations, eclipses, or mutual events.

The ring opening and apparent ring dimensions come from a separate `SaturnRing` calculation; the satellite tuple does not include them. The local tests check one Meeus example and finite outputs near several ring-plane crossings, but do not establish an accuracy bound or a supported epoch interval.

The separate [Saturnian Satellite Theory (TASS1.7)]({% link astronomy/saturnian-satellite-theory-tass17.md %}) returns Saturn-centered **geometric** position and velocity states in **AU and AU/day** on J2000 equatorial axes. Its index order places **Iapetus before Hyperion**, unlike `SaturnMoons.positions`. Convert units and frames and match satellites by name before comparing the models.

## Related topics

- [Saturnian Satellite Theory (TASS1.7)]({% link astronomy/saturnian-satellite-theory-tass17.md %}) documents the distinct dynamical model.
- [Meeus Galilean Satellite Positions]({% link astronomy/meeus-algorithms/galilean-satellite-positions.md %}) uses analogous Jupiter-centered sky axes.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) covers numeric TT JDE and calendar labels.
