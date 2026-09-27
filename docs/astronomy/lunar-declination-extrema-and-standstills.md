---
title: Lunar Declination Extrema and Standstills
layout: default
parent: Astronomy
nav_order: 320
description: Estimates monthly northern or southern lunar declination extrema and the major or minor standstill of a nodal cycle.

doc_kind: topic

sources:
    - src/astronomy/bodies/moon.ts

api:
    - nearestMaxDeclination
    - LunarDeclination
    - nearestLunarStandstill
    - LunarStandstill
---

# Lunar Declination Extrema and Standstills

The Moon reaches a northern and southern **declination extremum** during each draconic month. Over the roughly 18.6-year nodal cycle, the amplitude of those monthly extrema reaches a **major** or **minor standstill**. Use `nearestMaxDeclination` for a nearby monthly peak and `nearestLunarStandstill` for the most extreme monthly peak of a standstill cycle.

## Basic usage

```ts
import { nearestLunarStandstill, nearestMaxDeclination } from '../src/astronomy/bodies/moon';
import { timeToDate, timeYMD } from '../src/astronomy/time/time';
import { toDeg } from '../src/math/units/angle';

const [monthlyTime, monthlyDeclination] = nearestMaxDeclination(timeYMD(2025, 3, 1), 'NORTH', true);
const [standstillTime, standstillDeclination] = nearestLunarStandstill(timeYMD(2024, 1, 1), 'MAJOR', 'NORTH', true);
console.log(timeToDate(monthlyTime).slice(0, 3), toDeg(monthlyDeclination).toFixed(2)); // [2025, 3, 7] 28.71
console.log(timeToDate(standstillTime).slice(0, 3), toDeg(standstillDeclination).toFixed(2)); // [2025, 3, 7] 28.71
```

The two searches pick the same northern monthly maximum in this example because it is the maximum selected for the 2025 major standstill. Both return a tuple of `[Time, Angle]`: the modeled event instant tagged **TT**, then signed **geocentric declination in radians**. Convert the time to UTC for a civil UTC label; use `toDeg` for degrees.

## Choosing an event

`nearestMaxDeclination(time, declination, next)` accepts `'NORTH'` or `'SOUTH'` and finds one monthly extremum of that hemisphere. A northern result has positive declination; a southern result has negative declination. `next: true` selects an event strictly after the input; `next: false` selects one at or before it.

`nearestLunarStandstill(time, standstill, declination, next)` additionally accepts `'MAJOR'` or `'MINOR'`. A major standstill selects the largest absolute monthly declination within the cycle, while a minor standstill selects the smallest. Choose the hemisphere separately: northern and southern standstill extrema occur at different instants. Its `next: true` search selects a standstill instant strictly after the input. For an input exactly at the selected instant, `next: false` steps to the preceding standstill cycle; otherwise it selects the earlier side of the input.

The standstill search anchors a cycle near the mean ascending-node longitude of 0° for a major standstill or 180° for a minor one. It evaluates same-hemisphere monthly extrema within 150 days on either side of that anchor and picks the largest or smallest absolute declination. The result is a selected **monthly extremum**, not the instant when the node longitude equals the anchor angle.

## Model and limits

The monthly extrema use Meeus chapter 52's truncated northern and southern series. The returned angle represents the mean geocentric declination of that series. The calculation does not apply nutation, topocentric parallax, or a site's horizon, so it is not a prediction of the highest observed altitude. Tests near modern epochs compare the series with an ephemeris, but they do not establish a uniform accuracy bound for all dates.

- [Lunar Apsides and Nodes]({% link astronomy/lunar-apsides-and-nodes.md %}) covers node passages and the mean ascending-node longitude.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains TT and UTC conversion.
