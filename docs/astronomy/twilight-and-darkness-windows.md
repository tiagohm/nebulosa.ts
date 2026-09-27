---
title: Twilight and Darkness Windows
layout: default
parent: Astronomy
nav_order: 370
description: Finds civil, nautical, and astronomical darkness intervals with optional lunar limits.

doc_kind: topic

sources:
    - src/astronomy/events/darkness.ts

api:
    - darknessWindows
    - DarknessInterval
    - DarknessWindows
    - DarknessOptions
---

# Twilight and Darkness Windows

`darknessWindows` finds the parts of a chosen time span when the Sun is below the civil, nautical, and astronomical twilight thresholds. Use its `dark` result to narrow astronomical night by lunar altitude or illuminated fraction when planning observations.

## Basic usage

```ts
import { earth, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { darknessWindows } from '../src/astronomy/events/darkness';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { timeShift, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { deg } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const site = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84);
const start = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const sunAt = (time: typeof start) => vecMinus(sun(time)[0], earth(time)[0]);
const windows = darknessWindows(sunAt, site, start, timeShift(start, 1));
console.log(windows.astronomical.length, windows.dark.length); // 2 2
```

The callback supplies a **geocentric J2000/ICRS-oriented direction toward the Sun** at each `Time`; its magnitude does not determine the altitude. `site` uses east-positive longitude and north-positive latitude in radians. Both bounds are `Time` values, and every returned interval is clipped to `[start, end]`. A UTC day at this São Paulo site contains a pre-dawn and an evening astronomical interval, so a result can contain several intervals.

## Thresholds and lunar limits

Each `DarknessInterval` has `start` and `end` instants. The result separates intervals by the Sun's **geometric geocentric center altitude**:

| Result         | Solar altitude between crossings                           |
| -------------- | ---------------------------------------------------------- |
| `civil`        | Below −6°                                                  |
| `nautical`     | Below −12°                                                 |
| `astronomical` | Below −18°                                                 |
| `dark`         | Astronomical darkness satisfying any supplied lunar limits |

Without lunar limits, `dark` is the astronomical interval array. Supplying `moonAt(time)` adds a geometric lunar-altitude ceiling of **0 radians** by default; `maximumMoonAltitude` changes that ceiling in radians. The lunar direction has the same geocentric J2000 convention as the solar direction. To constrain illuminated fraction, supply both `moonIlluminationAt(time)` (a fraction from 0 to 1) and `maximumMoonIllumination`. This fraction limit can be used without `moonAt`; the callback alone, without a ceiling, adds no constraint. The limits intersect with astronomical darkness and can split an interval.

A lunar-altitude ceiling without `moonAt`, or an illumination ceiling without `moonIlluminationAt`, throws `RangeError`. With `end` at or before `start`, the four interval arrays are empty when the options are otherwise valid.

## Accuracy and limitations

The altitude calculation uses the supplied geocentric directions, precession and nutation, and apparent sidereal time. It does not evaluate atmospheric refraction, topocentric lunar parallax, terrain obstruction, or sky brightness. The illuminated fraction is provided by the caller; it is not inferred from the directions.

Crossings are found by sampling and refining sign changes. `step` is the coarse spacing in **days** (default **1 hour**), and `tolerance` is the crossing refinement tolerance in **days** (default `10⁻⁶` day). Closely spaced crossings or a grazing touch can be missed at a coarse step; choose a step appropriate to the motion being supplied. No uniform timing accuracy is guaranteed independently of the direction callbacks and Earth-orientation inputs.

See [Rise, Transit, and Set]({% link astronomy/rise-transit-and-set.md %}) for individual horizon crossings and the altitude convention used here.
