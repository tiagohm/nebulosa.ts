---
title: Meeus Conjunction Interpolation
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 220
description: Interpolates a longitude or right-ascension conjunction and signed latitude or declination difference from five sampled positions.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Conjunction
---

# Meeus Conjunction Interpolation

`Conjunction` interpolates the instant when two supplied directions have the same longitude or right ascension. It uses five position samples rather than querying an ephemeris. Use it when a caller already has a short, regularly sampled track around a conjunction. The result is a fresh pair containing the event time and the signed difference in the other angular coordinate.

## Basic usage

```ts
import { Conjunction } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const fixed = [0, 0] as const;
const moving = [359.7, 359.9, 0.1, 0.3, 0.5].map((longitude, i) => [deg(longitude), 0.01 * i] as const);
const [time, latitudeDifference] = Conjunction.stellar(0, 4, fixed, moving);
console.log(time, latitudeDifference); // about 1.5 and +0.015 radians
```

The example crosses the `0°/360°` boundary. The returned time is `1.5` in the input time units, and the second value is **moving latitude minus fixed latitude** in radians. `planetary(t1, t5, cs1, cs2)` accepts two five-row tracks and returns **second-body latitude/declination minus first-body latitude/declination** at their interpolated longitude/right-ascension equality. `stellar(t1, t5, c1, cs2)` uses one fixed first-body direction and a five-row second-body track. These names describe the sample pattern; neither method looks up a planet or star.

## Sample contract

Each coordinate is `[longitude, latitude]` or `[right ascension, declination]`, with **both angles in radians**. Use the same frame and angular convention for both bodies. Each moving track must have five rows at equally spaced times from `t1` through `t5`, inclusive; `planetary` requires corresponding rows in its two tracks. `t1` and `t5` may use any consistent numeric time unit or scale; the output time uses those same units and scale. For example, TT Julian days in yield a TT Julian day out.

The code subtracts the first body's angular coordinates from the second body's at each row. It unwraps the first-coordinate difference across adjacent samples, so an ordinary `2π` wrap does not interrupt interpolation; successive angular differences must change by less than `π` between rows. It then finds a zero of the five-point interpolation and interpolates the signed second-coordinate difference at that time. Input coordinates are not mutated.

## Accuracy and limitations

Supply rows that bracket the desired crossing: the interpolating factor must lie within the five-row table, including its endpoints. The method can throw for a missing or unequal row count, equal `t1` and `t5`, a zero outside the table, or failure of the interpolation iteration to converge. The finite samples and quartic interpolation determine accuracy; the API does not provide an error estimate or search outside the table.

This is **coordinate conjunction**, where one angular coordinate becomes equal. It does not minimize full angular separation or establish an occultation. For a year-based estimate without position samples, use [Meeus Planetary Phenomena]({% link astronomy/meeus-algorithms/planetary-phenomena.md %}); for a modeled event from a continuous ephemeris, use an event-search workflow with the intended geometry and time scale.

## Related topics

- [Meeus Planetary Phenomena]({% link astronomy/meeus-algorithms/planetary-phenomena.md %}) gives chapter 36 estimates from a decimal year.
- [Meeus Numerical Helpers]({% link astronomy/meeus-algorithms/numerical-helpers.md %}) documents the five-point interpolation used here.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) covers numeric TT JDE when the sample times use that scale.
