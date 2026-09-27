---
title: Lunar Eclipse Search
layout: default
parent: Astronomy
nav_order: 300
description: Finds a nearby lunar eclipse and estimates its global TT contacts and shadow circumstances.

doc_kind: topic

sources:
    - src/astronomy/bodies/moon.ts

api:
    - nearestLunarEclipse
    - LunarEclipse
    - LunarEclipseType
---

# Lunar Eclipse Search

`nearestLunarEclipse(time, next)` finds the next or previous lunar eclipse in the Meeus full-moon series. It returns an estimated greatest-eclipse instant, penumbral and available umbral contacts, and global shadow geometry. Use it to choose an event for an almanac or a separate site-visibility calculation.

## Basic usage

```ts
import { nearestLunarEclipse } from '../src/astronomy/bodies/moon';
import { timeToDate, timeYMD, utc } from '../src/astronomy/time/time';

const eclipse = nearestLunarEclipse(timeYMD(1997, 7, 1), true);
console.log(eclipse.type); // TOTAL
console.log(timeToDate(utc(eclipse.maximalTime)).slice(0, 5)); // [1997, 9, 16, 18, 47]
console.log(timeToDate(utc(eclipse.firstContactUmbraTime)).slice(0, 5)); // [1997, 9, 16, 17, 9]
```

The input is a `Time` in any supported timescale. The search converts it to TT, then uses the modeled greatest-eclipse instant to choose direction: `next: true` means strictly after the input and `next: false` means at or before it. Returned event and contact instants are tagged **TT**; convert them before displaying UTC dates.

## Types, magnitude, and contacts

`LunarEclipseType` is `'TOTAL'`, `'PARTIAL'`, or `'PENUMBRAL'`. The returned `magnitude` is dimensionless. For total and partial eclipses it is the modeled **umbral magnitude**; for a penumbral eclipse it is the **penumbral magnitude**. A value at least one in the umbral calculation gives `TOTAL`, a positive value below one gives `PARTIAL`, and a candidate with no umbral entry can still be `PENUMBRAL` if its penumbral magnitude is nonnegative.

| Field                      | Contact             | Available for         |
| -------------------------- | ------------------- | --------------------- |
| `firstContactPenumbraTime` | P1, penumbral entry | All returned eclipses |
| `firstContactUmbraTime`    | U1, umbral entry    | Partial and total     |
| `totalBeginTime`           | U2, totality begins | Total                 |
| `maximalTime`              | Greatest eclipse    | All returned eclipses |
| `totalEndTime`             | U3, totality ends   | Total                 |
| `lastContactUmbraTime`     | U4, umbral exit     | Partial and total     |
| `lastContactPenumbraTime`  | P4, penumbral exit  | All returned eclipses |

An inapplicable contact field contains the sentinel `Time` with Julian day **0**, fraction **0**, and scale **TT**; it is not `undefined`. Check `type` before using U1/U4 or U2/U3. For example, a penumbral eclipse has no umbral contacts, while a partial eclipse has no totality contacts.

## Shadow geometry and durations

| Field        | Unit                   | Meaning                                                                                                        |
| ------------ | ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `lunation`   | Meeus integer          | Full-moon eclipse lunation index, derived from the half-integer phase index.                                   |
| `gamma`      | Earth equatorial radii | Signed closest distance from the Moon's center to Earth's shadow axis; classification uses its absolute value. |
| `sigma`      | Earth equatorial radii | Modeled umbral radius in the eclipse plane.                                                                    |
| `rho`        | Earth equatorial radii | Modeled penumbral radius in the eclipse plane.                                                                 |
| `u`          | Earth equatorial radii | Shadow-cone size correction used by the radius and magnitude formulas.                                         |
| `p`          | Earth equatorial radii | Umbral-contact threshold, `1.0128 - u`, for the Moon-center distance.                                          |
| `sdPenumbra` | days                   | Half-span from greatest eclipse to P1 or P4.                                                                   |
| `sdPartial`  | days                   | Half-span from greatest eclipse to U1 or U4.                                                                   |
| `sdTotal`    | days                   | Half-span from greatest eclipse to U2 or U3.                                                                   |

The `sd*` values are **half-durations in days**, not complete phase lengths. `sdPartial` is `NaN` when no umbral contacts exist; `sdTotal` is `NaN` when no totality exists. The contact fields above retain their sentinel values in those cases.

## Model and limits

The search tests successive full-moon lunations using Meeus's latitude, greatest-eclipse time, and shadow series, then estimates contacts symmetrically around greatest eclipse. These are global event circumstances. They do not establish whether the Moon is above the horizon at a particular site or which part of an event is visible there. A local-visibility calculation needs the observer's location and the Moon's position over the event.

The model does not specify a uniform timing accuracy for arbitrary dates. For principal phase times without an eclipse test, use [Lunar Phase and Lunation]({% link astronomy/lunar-phase-and-lunation.md %}); for solar eclipses, use [Solar Eclipse Search and Classification]({% link astronomy/solar-eclipse-search-and-classification.md %}).
