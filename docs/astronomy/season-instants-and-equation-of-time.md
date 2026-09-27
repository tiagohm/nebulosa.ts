---
title: Season Instants and Equation of Time
layout: default
parent: Astronomy
nav_order: 250
description: Estimates TT equinox and solstice instants and computes apparent-minus-mean solar time from an apparent Sun position.

doc_kind: topic

sources:
    - src/astronomy/bodies/sun.ts

api:
    - Season
    - season
    - equationOfTime
---

# Season Instants and Equation of Time

`season` estimates a named equinox or solstice and returns it as a **TT `Time`**. `equationOfTime` computes the angle between apparent and mean solar time at a supplied instant, using an apparent solar right ascension. Use these helpers when a workflow already uses the library's `Time` representation and needs a season marker or a sundial-to-clock correction.

## Basic usage

```ts
import { equationOfTime, season } from '../src/astronomy/bodies/sun';
import { Solar } from '../src/astronomy/ephemeris/meeus';
import { timeYMDHMS, Timescale, toJulianDay, tt } from '../src/astronomy/time/time';
import { toDeg } from '../src/math/units/angle';

const spring = season(2026, 'spring');
const instant = timeYMDHMS(2026, 11, 3, 12, 0, 0, Timescale.UTC);
const [apparentSunRa] = Solar.apparentEquatorialVSOP87(toJulianDay(tt(instant)));
const apparentMinusMeanMinutes = toDeg(equationOfTime(instant, apparentSunRa)) * 4;
console.log(spring.scale === Timescale.TT, toJulianDay(spring), apparentMinusMeanMinutes);
```

With the current models, the spring estimate is about **TT JDE `2461120.1158`**, and the example equation of time is about **+16.45 minutes**. The positive sign means apparent solar time is ahead of mean solar time. The example uses the Meeus VSOP87E-based apparent solar right ascension, referred to the true equator and equinox of date.

## Season instants

`season(year, name)` accepts an integer year and `name` equal to `'spring'`, `'summer'`, `'autumn'`, or `'winter'`. It evaluates a season-specific Meeus polynomial in `(year − 2000) / 1000`, then applies the chapter's periodic correction. The returned `Time` is tagged **TT**; convert it to UTC before displaying a civil timestamp. The table coefficients used here are intended for years **1000–3000**. The function has no year guard, so evaluating outside that span does not establish an accuracy guarantee.

The result is a modeled global season instant. It does not depend on the observer's longitude, latitude, time zone, or local horizon.

## Equation-of-time sign and frame

`equationOfTime(time, apparentSunRightAscension)` returns a signed angle in **radians**, wrapped to `(−π, π]`. The input right ascension must be the Sun's **apparent geocentric RA in the true equator and equinox of date**, also in radians. A J2000 or mean-of-date RA introduces a frame mismatch. Convert the returned angle to minutes of solar time with `toDeg(result) × 4`.

The signed relationship is:

`apparent solar time − mean solar time = GAST − apparentSunRightAscension − 2π · UT1_day_fraction`.

`GAST` is Greenwich apparent sidereal time at `time`; the UT1 day fraction supplies the mean Sun's hour-angle reference. The function obtains GAST and UT1 through the `Time` conversion path, so configured time and sidereal providers affect the result. It uses the caller's supplied solar RA rather than fetching a Sun ephemeris. The equation is a time **offset**, not a local clock reading; a civil clock comparison also requires longitude and time-zone conventions.

## Model and limits

The season calculation is a chapter-style polynomial estimate with periodic terms, rather than a root search on a selected solar ephemeris. The equation of time inherits the accuracy and frame convention of the supplied apparent RA and the selected time providers. Neither function computes a local sunrise or sunset.

The Meeus `Solstice` and `EquationOfTime` namespaces are separate numeric-JDE chapter interfaces. Their inputs, return representations, and calculation paths differ from these `Time`-based helpers; use the related topics when reproducing those chapter formulas.

## Related topics

- [Meeus Equinoxes and Solstices]({% link astronomy/meeus-algorithms/equinoxes-and-solstices.md %}) provides numeric TT JDE season estimates and a solar-longitude refinement.
- [Meeus Equation of Time]({% link astronomy/meeus-algorithms/equation-of-time.md %}) evaluates the chapter's direct and short equation-of-time formulas.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains TT, UT1, and UTC conversions.
