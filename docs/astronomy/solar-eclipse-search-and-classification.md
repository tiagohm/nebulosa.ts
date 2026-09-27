---
title: Solar Eclipse Search and Classification
layout: default
parent: Astronomy
nav_order: 270
description: Finds a previous or future solar eclipse and classifies its global shadow geometry with Meeus's lunation series.

doc_kind: topic

sources:
    - src/astronomy/bodies/sun.ts

api:
    - nearestSolarEclipse
    - SolarEclipse
    - SolarEclipseType
---

# Solar Eclipse Search and Classification

`nearestSolarEclipse(time, next)` searches new-moon lunations for a solar eclipse and returns its modeled greatest instant and global classification. Use it to select an eclipse for a catalog or as the starting event for a separate eclipse-map calculation.

## Basic usage

```ts
import { nearestSolarEclipse } from '../src/astronomy/bodies/sun';
import { timeToDate, timeYMD, utc } from '../src/astronomy/time/time';

const eclipse = nearestSolarEclipse(timeYMD(2024, 3, 1), true);
console.log(eclipse.type, eclipse.central); // total true
console.log(timeToDate(utc(eclipse.maximalTime)).slice(0, 3)); // [2024, 4, 8]
```

The input is a `Time` in any supported timescale. The search converts it to TT before comparing instants. Pass `true` for an eclipse whose modeled greatest instant is strictly after the input; pass `false` for one at or before it. The returned `maximalTime` is tagged **TT**. Convert it with `utc(...)` when a civil UTC date is needed.

## Reading the result

| Field         | Unit / convention      | Meaning                                                                                                                                                                                                              |
| ------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lunation`    | Meeus integer `k`      | New-moon lunation used for this eclipse.                                                                                                                                                                             |
| `maximalTime` | TT `Time`              | Modeled instant of greatest eclipse.                                                                                                                                                                                 |
| `gamma`       | Earth equatorial radii | Signed closest distance of the lunar shadow axis from Earth's center; the classification uses its absolute value.                                                                                                    |
| `u`           | Earth equatorial radii | Umbral or antumbral cone radius in the fundamental plane. Its sign helps distinguish total and annular geometry.                                                                                                     |
| `p`           | Earth equatorial radii | Penumbral radius in the fundamental plane; computed as `u + 0.5461`.                                                                                                                                                 |
| `central`     | boolean                | Whether the modeled shadow axis reaches Earth: `abs(gamma) < 0.9972`.                                                                                                                                                |
| `type`        | `SolarEclipseType`     | `'total'`, `'partial'`, `'annular'`, or `'hybrid'`.                                                                                                                                                                  |
| `magnitude`   | dimensionless          | For a central eclipse, the modeled Moon-to-Sun apparent-diameter ratio at greatest eclipse. For a noncentral eclipse, the fraction of the solar diameter covered at greatest eclipse according to the Meeus formula. |

`central` and `type` answer different questions. A polar eclipse can be **noncentral annular or total** when the umbral or antumbral cone grazes Earth even though its axis misses Earth. Thus `central === false` does not imply `type === 'partial'`. The meaning of `magnitude` follows `central`, including for these noncentral annular and total events.

## Model and limits

The search steps through Meeus lunations, applies the Moon's latitude and shadow-axis tests, then evaluates the series for greatest eclipse, `gamma`, and `u`. Its result is a global approximation. It supplies neither local contact times nor a ground track, central line, or rise/set curves. A map calculation uses this event as a starting point and refines its geometry separately; do not treat `maximalTime` as a map's final greatest-eclipse instant.

The model is useful for identifying and classifying candidate eclipses. It does not claim an accuracy bound for arbitrary historical dates or substitute for observer-specific circumstances. For an eclipse series label rather than an event search, use [Solar Saros Index]({% link astronomy/solar-saros-index.md %}).

## Related topics

- [Solar Parallax and Semidiameter]({% link astronomy/solar-parallax-and-semidiameter.md %}) gives apparent solar size at a supplied distance.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) covers TT and UTC conversion.
