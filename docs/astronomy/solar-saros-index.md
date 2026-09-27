---
title: Solar Saros Index
layout: default
parent: Astronomy
nav_order: 260
description: Assigns the van den Bergh solar Saros series index to a modeled lunation.

doc_kind: topic

sources:
    - src/astronomy/bodies/sun.ts

api:
    - solarSaros
---

# Solar Saros Index

`solarSaros(time)` returns the **van den Bergh solar Saros series number** associated with the modeled lunation containing a supplied `Time`. Use it to label a known solar-eclipse lunation or to group lunations by series. It returns a number from **1 through 223**; it does not determine whether that lunation produces a solar eclipse.

## Basic usage

```ts
import { solarSaros } from '../src/astronomy/bodies/sun';
import { timeYMD } from '../src/astronomy/time/time';

const eclipseDay = timeYMD(2013, 11, 3);
console.log(solarSaros(eclipseDay)); // 143
```

The input is an astronomical `Time`, not a Saros cycle count or a civil date string. The example is a date within a known eclipse lunation; the returned `143` is its series label, not an eclipse magnitude, instant, or ground track.

## How the index is assigned

The helper first calls `lunation(time, 'MEEUS')` to estimate a new-moon lunation number from the stored Julian day. It applies the solar-series arithmetic to that number and wraps the result into `[1, 223]` with nonnegative modulo, including for dates before the reference epoch. The resulting index repeats across separated lunations belonging to the same Saros series.

The lunation step uses a mean synodic period and reads `time.day` and `time.fraction` directly. It does not search for the actual new Moon or convert the input to another timescale. Near a modeled lunation boundary, the assigned number can therefore depend on the time representation and the approximation. For an actual eclipse's event time and classification, use `nearestSolarEclipse`; its search is a separate operation.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains the day and fraction stored by `Time`.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) covers numeric Julian days and calendar labels used in chapter calculations.
