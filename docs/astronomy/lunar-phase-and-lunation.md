---
title: Lunar Phase and Lunation
layout: default
parent: Astronomy
nav_order: 290
description: Numbers lunar cycles, estimates principal phase instants, and labels full-moon lunations with a lunar Saros series.

doc_kind: topic

sources:
    - src/astronomy/bodies/moon.ts

api:
    - lunation
    - LunationSystem
    - nearestLunarPhase
    - LunarPhase
    - lunarSaros
---

# Lunar Phase and Lunation

Use `lunation` to label a lunar cycle, `nearestLunarPhase` to find a modeled new Moon, quarter, or full Moon, and `lunarSaros` to label a full-moon lunation by eclipse series. The labels are not event searches: a phase can occur without an eclipse, and a Saros number alone does not establish eclipse circumstances.

## Basic usage

```ts
import { lunarSaros, lunation, nearestLunarPhase } from '../src/astronomy/bodies/moon';
import { timeToDate, timeYMD, utc } from '../src/astronomy/time/time';

const fullMoon = nearestLunarPhase(timeYMD(2025, 9, 17), 'FULL', true);
console.log(timeToDate(utc(fullMoon)).slice(0, 5)); // [2025, 10, 7, 3, 47]
console.log(lunation(fullMoon, 'MEEUS'), lunation(fullMoon), lunarSaros(fullMoon)); // 318 1271 166
```

The phase result is a `Time` tagged **TT**. Convert it to UTC before displaying a civil UTC date. `nearestLunarPhase(time, phase, next)` accepts a `Time` in any supported scale and converts it to TT for the search. `next: true` selects a modeled phase strictly after the input instant; `next: false` selects one at or before it.

## Phases and cycle numbers

The `LunarPhase` argument is one of `'NEW'`, `'FIRST_QUARTER'`, `'FULL'`, or `'LAST_QUARTER'`. The search uses Meeus's mean lunation and periodic correction series for the selected phase. It returns a fresh TT instant; it does not determine the Moon's illuminated fraction at an arbitrary time.

`lunation(time, system)` estimates the cycle number from the stored Julian day and a mean synodic month. The default `LunationSystem` is `'BROWN'`. All systems use the same estimated Meeus cycle number with a fixed offset:

| System      | Offset from `MEEUS` |
| ----------- | ------------------: |
| `MEEUS`     |                   0 |
| `BROWN`     |                +953 |
| `GOLDSTINE` |              +37105 |
| `HEBREW`    |              +71234 |
| `ISLAMIC`   |              +17038 |
| `THAI`      |              +16843 |

The Meeus index is zero for the modeled January 2000 reference new Moon. `lunation` reads `time.day` and `time.fraction` directly; it does not convert scales or solve for the actual new Moon. Near a modeled cycle boundary, the estimate can depend on the supplied time representation and the mean-month approximation. For a modeled phase instant, use `nearestLunarPhase`.

## Lunar Saros label

`lunarSaros(time)` returns a number from **1 through 223** for the modeled full-moon lunation containing the input. It advances the series by 38 per mean synodic month from the full-moon reference in January 2003, wrapping the result into that range even for earlier dates. Like `lunation`, it reads the stored Julian day directly and does not search for a phase or convert the time scale. Pass a known full-Moon instant when using the result as a full-moon series label; the function does not test whether an eclipse occurs.

## Accuracy and related topics

These are Meeus series estimates. The tests verify selected historical and future phase instants, but the implementation does not specify a uniform accuracy bound across all dates. The event search identifies a global phase instant, not local Moon visibility or an eclipse contact.

- [Meeus Lunar Illumination]({% link astronomy/meeus-algorithms/lunar-illumination.md %}) calculates geometric illuminated fraction instead of a phase time.
- [Solar Saros Index]({% link astronomy/solar-saros-index.md %}) labels solar new-moon lunations separately.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains TT and UTC.
