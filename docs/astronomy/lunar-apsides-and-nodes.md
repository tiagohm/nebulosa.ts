---
title: Lunar Apsides and Nodes
layout: default
parent: Astronomy
nav_order: 310
description: Estimates lunar perigee, apogee, and ecliptic-node passage times and the mean ascending-node longitude.

doc_kind: topic

sources:
    - src/astronomy/bodies/moon.ts

api:
    - nearestLunarApsis
    - nearestMeanLunarApsis
    - LunarApsis
    - nearestLunarNode
    - LunarNode
    - moonMeanAscendingNode
---

# Lunar Apsides and Nodes

An **apsis** is a closest or farthest point in the Moon's orbit around Earth; a **node passage** is a crossing of the ecliptic plane. These Meeus helpers estimate the neighboring events or the mean ascending-node longitude. Use them for an observing calendar or to label orbital geometry near a lunar phase or eclipse.

## Basic usage

```ts
import { nearestLunarApsis, nearestLunarNode } from '../src/astronomy/bodies/moon';
import { timeToDate, timeYMD } from '../src/astronomy/time/time';
import { toArcsec } from '../src/math/units/angle';
import { toKilometer } from '../src/math/units/distance';

const start = timeYMD(2026, 1, 1);
const [perigee, distance, diameter] = nearestLunarApsis(start, 'PERIGEE', true);
console.log(timeToDate(perigee).slice(0, 5)); // [2026, 1, 1, 21, 44] in TT
console.log(Math.round(toKilometer(distance)), toArcsec(diameter).toFixed(2)); // 360347 1989.60
console.log(timeToDate(nearestLunarNode(start, 'ASCENDING', true)).slice(0, 3)); // [2026, 1, 22] in TT
```

The event functions accept a `Time` in any supported timescale and convert it to TT. They return **TT** instants. Convert an event with `utc(...)` before labeling it as a civil UTC time. For these searches, `next: true` selects the first modeled event strictly after the input; `next: false` selects the last event at or before it.

## Apsis choices and result

Pass `'PERIGEE'` for the Moon's closest point or `'APOGEE'` for its farthest point. `nearestLunarApsis(time, apsis, next)` returns a tuple:

| Position | Value                          | Unit / meaning |
| -------- | ------------------------------ | -------------- |
| `[0]`    | Event time                     | TT `Time`      |
| `[1]`    | Geocentric Earth–Moon distance | AU             |
| `[2]`    | Apparent **angular diameter**  | radians        |

The distance is derived from the Meeus apsis parallax series. The diameter is twice `moonSemidiameter(distance)`; it is not an angular radius. `nearestMeanLunarApsis(time, apsis, next)` returns just a TT `Time` from the mean apsis polynomial, omitting the periodic timing corrections. Its result can differ from the perturbed apsis time. Because each function independently selects the next or previous event relative to the input, near an event boundary they can select different cycles.

## Node passage and longitude

`nearestLunarNode(time, direction, next)` returns a TT `Time` for a lunar passage through the **mean ecliptic of date**. `'ASCENDING'` crosses south to north; `'DESCENDING'` crosses north to south. The event uses Meeus's node-passage series rather than an observer's topocentric Moon position.

`moonMeanAscendingNode(time)` returns the **mean ascending-node longitude** in the mean ecliptic and equinox of date, in radians normalized to `[0, 2π)`. It converts the input to TT, evaluates the mean regression polynomial, and omits periodic true-node corrections. This angle describes the node's direction at a time; it is not a passage instant. [Meeus Lunar Position]({% link astronomy/meeus-algorithms/lunar-position.md %}) also provides a separately corrected true-node longitude.

## Accuracy and limits

The apsis and node times are Meeus series estimates, with no uniform accuracy bound specified for arbitrary dates. They describe geocentric orbital events, not the apparent position or altitude for a site. The shared event selector checks neighboring series entries and throws `Error('Lunar event search did not converge')` if it cannot select an event within 32 evaluations.

- [Lunar Parallax and Semidiameter]({% link astronomy/lunar-parallax-and-semidiameter.md %}) explains the angular-radius helper used to form the apsis diameter.
- [Lunar Phase and Lunation]({% link astronomy/lunar-phase-and-lunation.md %}) finds phase instants on a different cycle.
