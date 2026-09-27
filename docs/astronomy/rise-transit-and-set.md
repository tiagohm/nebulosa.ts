---
title: Rise, Transit, and Set
layout: default
parent: Astronomy
nav_order: 360
description: Finds horizon crossings and the upper altitude culmination of a geocentric direction over a chosen time window.

doc_kind: topic

sources:
    - src/astronomy/events/horizon.ts

api:
    - riseTransitSet
    - altitudeOf
    - RiseTransitSet
    - RiseTransitSetOptions
    - STANDARD_HORIZON
    - SUN_HORIZON
    - CIVIL_TWILIGHT
    - NAUTICAL_TWILIGHT
    - ASTRONOMICAL_TWILIGHT
---

# Rise, Transit, and Set

`riseTransitSet` searches a time window for a direction's rise above a selected geometric altitude, upper culmination, and set below that altitude. Use it for the Sun, Moon, planets, or a fixed star when a geocentric direction is available at each time. `altitudeOf` evaluates the same geometric altitude at one instant.

## Basic usage

```ts
import { earth, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { riseTransitSet, SUN_HORIZON } from '../src/astronomy/events/horizon';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { timeToDate, timeYMDHMS, Timescale, utc } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { deg } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const site = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84);
const start = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const sunDirection = (time: typeof start) => vecMinus(sun(time)[0], earth(time)[0]);
const events = riseTransitSet(sunDirection, site, start, { horizon: SUN_HORIZON });
console.log(events.rise && timeToDate(utc(events.rise)).slice(0, 5)); // [2026, 6, 29, 9, 49]
console.log(events.transit && timeToDate(utc(events.transit)).slice(0, 5)); // [2026, 6, 29, 15, 10]
console.log(events.set && timeToDate(utc(events.set)).slice(0, 5)); // [2026, 6, 29, 20, 31]
```

The callback returns a **geocentric J2000/ICRS-oriented vector toward the body**; its length is ignored. The location uses **east-positive longitude** and north-positive latitude in radians. `start` marks the beginning of the search window, not necessarily local midnight. Returned event fields are `Time` values and can be converted to UTC for display as above.

## Horizon choice and options

The function precesses and nutates the J2000 direction to the true equator of date, combines it with apparent sidereal time, and searches crossings of the resulting **geometric geocentric altitude**. The horizon threshold carries any approximate refraction, limb, or parallax allowance desired by the caller:

| Constant                | Altitude | Typical interpretation                                                |
| ----------------------- | -------- | --------------------------------------------------------------------- |
| `STANDARD_HORIZON`      | −34′     | Point-source center with standard horizon refraction.                 |
| `SUN_HORIZON`           | −50′     | Solar upper limb with standard refraction and about 16′ semidiameter. |
| `CIVIL_TWILIGHT`        | −6°      | Solar-center civil-twilight crossing.                                 |
| `NAUTICAL_TWILIGHT`     | −12°     | Solar-center nautical-twilight crossing.                              |
| `ASTRONOMICAL_TWILIGHT` | −18°     | Solar-center astronomical-twilight crossing.                          |

`RiseTransitSetOptions.horizon` defaults to `STANDARD_HORIZON`. `window` defaults to **1 day** starting at `start`. The inherited `step` is a coarse sample spacing in **days**, defaulting to **1 hour**; `tolerance` is a root or extremum refinement tolerance in **days**, defaulting to about `10⁻⁶` day. Use a smaller step for rapidly changing or grazing geometry. The search can refine crossings around sampled extrema when a grazing pair is missed by the coarse sign-change scan, but adequate sampling remains the caller's responsibility.

For lunar rise or set, the Moon's large parallax needs a different center-altitude threshold. A conventional approximation is `0.7275 × moonParallax(distance) − 34′`, with parallax in radians and distance in AU. This remains a geocentric-horizon estimate; use an observer-specific topocentric calculation when finer lunar timing is needed.

## Reading the result

`rise` and `set` are `Time | undefined`; a short window may contain one crossing but not the other. `transit` is the **highest local altitude maximum inside the window**, when such a culmination is found. It can be present even when the body stays below the selected horizon. If the window contains no upper culmination, `transit` is `undefined` and `transitAltitude` remains a finite altitude from the searched window; it is not necessarily a transit value in that case.

`transitAltitude` is in radians. With no detected horizon crossing, `alwaysUp` is true when the lowest altitude considered by the search is strictly above the horizon; `alwaysDown` is true when the highest considered altitude is strictly below. Then rise and set are `undefined`. A boundary contact or short window can leave both flags false, so check the optional event fields directly.

`altitudeOf(direction, time, location)` returns the geometric geocentric center altitude in radians for a single J2000/ICRS-oriented vector. It does not apply the selected `horizon` threshold or atmospheric refraction.

## Accuracy and related topics

This search uses a geocentric direction, precession–nutation, and apparent sidereal time. It does not calculate annual aberration, light deflection, topocentric parallax, atmospheric refraction, local terrain obstruction, or a body's apparent limb. The threshold constants approximate some of those effects for conventional almanac use. Timing depends on the direction callback, Earth-orientation data, step size, and horizon assumption; the implementation gives no uniform accuracy bound.

- [Meeus Approximate Rise, Transit, and Set]({% link astronomy/meeus-algorithms/approximate-rise-transit-and-set.md %}) uses a separate UT1-day, three-sample method and west-positive longitude.
- [Lunar Parallax and Semidiameter]({% link astronomy/lunar-parallax-and-semidiameter.md %}) supplies the lunar horizontal parallax used in a standard threshold.
