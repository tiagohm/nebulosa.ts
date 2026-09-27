---
title: Meeus Solar Day Clock
layout: default
parent: Astronomy
nav_order: 340
description: Estimates solar noon, limb crossings, twilight, and golden-hour boundaries for a UT1 calendar day.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Sunrise
---

# Meeus Solar Day Clock

`Sunrise.Sunrise` calculates a chapter-style solar-day timetable for one observing site. It provides upper- and lower-limb events, civil and nautical twilight, astronomical night, golden-hour boundaries, and solar noon. Use it when a Meeus approximation and **Gregorian UT1 calendar labels** suit the task.

## Basic usage

```ts
import { Julian, Sunrise } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const day = new Sunrise.Sunrise(new Julian.CalendarGregorian(2026, 6, 21), deg(-23.55), deg(46.63));
const noon = day.noon();
const rise = day.rise();
const dusk = day.dusk();
console.log(noon.getDate(), noon.getTime());
if (rise !== undefined) console.log(rise.getDate(), rise.getTime());
if (dusk !== undefined) console.log(dusk.getDate(), dusk.getTime());
```

The constructor takes a `Julian.Calendar` whose labels select the **UT1 day**, north-positive geodetic latitude, and **west-positive longitude**, both angles in radians. It copies the selected midnight and normalizes longitude; later changes to the input calendar do not change the instance. `noon()` and each resolved event allocate a fresh `Julian.CalendarGregorian`. Its date and time are **UT1 labels**, even if converted to a JavaScript `Date` with a `Z` suffix; no UT1 − UTC correction is applied by these event methods.

## Event thresholds

| Methods                                | Solar-center threshold | Event interpretation                                                                                       |
| -------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `rise()`, `set()`                      | −50′ by default        | First appearance and final disappearance of the **upper limb**, including a 34′ mean refraction allowance. |
| `riseEnd()`, `setStart()`              | −18′ by default        | Entire disk first visible and disk first beginning to disappear, using the **lower limb**.                 |
| `dawn()`, `dusk()`                     | −6°                    | Civil dawn begins and civil dusk ends.                                                                     |
| `nauticalDawn()`, `nauticalDusk()`     | −12°                   | Nautical twilight boundaries.                                                                              |
| `nightEnd()`, `nightStart()`           | −18°                   | Astronomical night ends and begins.                                                                        |
| `goldenHourEnd()`, `goldenHourStart()` | +6°                    | Morning golden hour ends and evening golden hour starts.                                                   |

The twilight and golden-hour thresholds are **geometric solar-center altitudes**. The limb thresholds combine an approximate 16′ solar semidiameter with mean refraction. An optional fourth constructor argument replaces the default **positive 34′ refraction angle** for the limb events; passing `0` removes that refraction. It does not change `noon()`, twilight, or golden-hour boundaries.

## Polar days and limits

`noon()` returns the formal upper solar transit. Each crossing method returns `undefined` if a grazing or nearby crossing cannot be resolved. When the Sun stays above the **selected threshold**, the search returns the previous rising and next setting events; when it stays below, it returns the next rising and previous setting events. Each direction searches at most **366 adjacent days**, so a result may lie outside the input date or remain `undefined`, particularly within about **0.4°** of a geographic pole. Antimeridian geometry can also place an ordinary event on the adjacent UT1 date; the returned calendar keeps that date rather than wrapping the clock to the requested day.

The implementation evaluates the Meeus low-order solar position and equation of time twice for ordinary events. It estimates solar geometry rather than searching a high-precision vector ephemeris, and no uniform timing error bound is established. For more general rise/set or twilight calculations involving a specific ephemeris or horizon model, use the corresponding event-search APIs.

## Related topics

- [Meeus Approximate Rise, Transit, and Set]({% link astronomy/meeus-approximate-rise-transit-and-set.md %}) explains the chapter's standard horizons and crossing states.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) explains the UT1, TT, and JavaScript `Date` label conventions.
