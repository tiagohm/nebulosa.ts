---
title: Observing Visibility Windows
layout: default
parent: Astronomy
nav_order: 400
description: Intersects target altitude, airmass, solar-altitude, and Moon-separation limits over time.

doc_kind: topic

sources:
    - src/astronomy/events/visibility.ts

api:
    - visibilityWindows
    - VisibilityInterval
    - VisibilityConstraints
    - VisibilitySources
---

# Observing Visibility Windows

`visibilityWindows` finds stretches when a target satisfies several observing limits at once. Use it to combine target altitude or airmass with a dark-sky solar threshold and distance from the Moon in a chosen time span.

## Basic usage

```ts
import { icrs } from '../src/astronomy/coordinates/icrs';
import { earth, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { visibilityWindows } from '../src/astronomy/events/visibility';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { timeShift, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { deg, hms } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const site = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84);
const target = icrs(hms(16, 29, 24), deg(-26.43)); // Approximate direction of Antares.
const start = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const sunAt = (time: typeof start) => vecMinus(sun(time)[0], earth(time)[0]);
const windows = visibilityWindows(() => target, site, start, timeShift(start, 1), { minimumAltitude: deg(30), maximumAirmass: 2, maximumSunAltitude: deg(-18) }, { sunAt });
console.log(windows.length); // 2
```

The target, optional Sun, and optional Moon callbacks supply **geocentric J2000/ICRS-oriented direction vectors** at each `Time`. The observer's longitude is east-positive. Each result has `start` and `end` `Time` values clipped to the requested `[start, end]`; a UTC day can contain pieces of two observing nights.

## Constraints

The optional fields of `VisibilityConstraints` are applied together:

| Field                   | Meaning                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `minimumAltitude`       | Target geometric altitude at least this angle, in radians.                   |
| `maximumAirmass`        | Target Kasten–Young airmass at most this dimensionless value.                |
| `maximumSunAltitude`    | Sun geometric altitude at most this angle, in radians.                       |
| `minimumMoonSeparation` | Great-circle target–Moon angular separation at least this angle, in radians. |

`maximumAirmass` is converted to a minimum target altitude and combined with `minimumAltitude` by keeping the higher altitude. An airmass ceiling below **1** yields no windows. The Moon separation compares the supplied geometric vectors; it does not include topocentric lunar parallax. Omitted constraints impose no limit, so an empty constraint object returns the whole positive-length search window as one interval.

Supply `sources.sunAt` when setting `maximumSunAltitude`, and `sources.moonAt` when setting `minimumMoonSeparation`. Either missing required callback throws `RangeError` for a positive-length window. `sources.step` and `sources.tolerance` are in **days**, defaulting to a **1-hour** coarse step and **10⁻⁶-day** root refinement tolerance. If `end` is at or before `start`, the result is empty.

## Accuracy and related topics

The solar and target altitudes use geocentric directions, precession and nutation, and apparent sidereal time. The search evaluates a combined margin and refines sampled sign changes; a coarse step can miss a narrow visibility stretch or a grazing contact. The API does not model refraction, terrain, lunar parallax, extinction, or sky brightness. Its result depends on the supplied direction models and the limits chosen by the caller.

Use [Twilight and Darkness Windows]({% link astronomy/twilight-and-darkness-windows.md %}) for solar-depression intervals with optional lunar altitude or illumination limits. [Rise, Transit, and Set]({% link astronomy/rise-transit-and-set.md %}) supplies individual altitude crossings, while [Hour-angle Windows]({% link astronomy/hour-angle-windows.md %}) handles a fixed target's meridian offset.
