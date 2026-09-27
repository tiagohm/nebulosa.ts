---
title: Heliacal Events
layout: default
parent: Astronomy
nav_order: 390
description: Finds classical first and last visibility transitions from an arc-of-vision criterion.

doc_kind: topic

sources:
    - src/astronomy/events/heliacal.ts

api:
    - heliacalPhases
    - HeliacalPhase
    - HeliacalPhaseKind
    - HeliacalPhaseOptions
---

# Heliacal Events

`heliacalPhases` searches for four classical visibility transitions of a star or planet from one observer. It tests how far the Sun is below the horizon when the object rises or sets, making it useful for calendar-scale events such as the heliacal rising of Sirius.

## Basic usage

```ts
import { icrs } from '../src/astronomy/coordinates/icrs';
import { earth, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { heliacalPhases } from '../src/astronomy/events/heliacal';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { timeToDate, timeYMDHMS, Timescale, utc } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { deg, hms } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const cairo = geodeticLocation(deg(31.2357), deg(30.0444), kilometer(0.023), Ellipsoid.WGS84);
const sirius = icrs(hms(6, 45, 8.917), deg(-16.716116));
const sunAt = (time: ReturnType<typeof timeYMDHMS>) => vecMinus(sun(time)[0], earth(time)[0]);
const start = timeYMDHMS(2026, 6, 1, 0, 0, 0, Timescale.UTC);
const stop = timeYMDHMS(2026, 9, 15, 0, 0, 0, Timescale.UTC);
const phases = heliacalPhases(() => sirius, sunAt, cairo, start, stop, { step: 1 / 6 });
const rising = phases.find((phase) => phase.kind === 'heliacalRising');
console.log(rising && timeToDate(utc(rising.time)).slice(0, 3)); // [2026, 8, 5]
```

`body(time)` and `sun(time)` supply **geocentric J2000/ICRS-oriented directions** toward the object and Sun. The observer's longitude is east-positive. A fixed star can use a constant direction as above; supply a time-dependent direction for a planet. The time window should bracket the desired transitions, preferably spanning about a year from near conjunction when seeking the full cycle.

## Four transitions

At each object's rise or set, the routine classifies the crossing as morning or evening from whether the Sun's geometric altitude is increasing or decreasing. It marks the crossing visible when the Sun's depression is at least `arcusVisionis`.

| `kind`             | Object crossing | Reported transition |
| ------------------ | --------------- | ------------------- |
| `heliacalRising`   | Morning rise    | First visible day   |
| `cosmicalSetting`  | Morning set     | First visible day   |
| `acronychalRising` | Evening rise    | Last visible day    |
| `heliacalSetting`  | Evening set     | Last visible day    |

Each `HeliacalPhase` has a `time` for the object's horizon crossing, `kind`, and `arcusVisionis`: the **actual solar depression in radians at that crossing**, which can exceed the requested threshold. The returned phases are sorted by time. A transition must have a neighboring scanned day that shows the change, so an already visible first day or a still visible final day does not establish a transition. A circumpolar or never-rising object has no rise/set crossings to report; a short or misplaced window can also return fewer than four phases.

`HeliacalPhaseOptions.arcusVisionis` is the required depression in radians, defaulting to **11°**. A larger threshold asks for a darker sky at the crossing. `horizon` is the object's geometric-altitude crossing threshold in radians, defaulting to `STANDARD_HORIZON` (−34 arcminutes). `step` and `tolerance` pass to the rise/set search in **days**; the default coarse step is **1 hour** and the default refinement tolerance is **10⁻⁶ day**. A nonpositive window returns an empty array.

## Accuracy and related topics

This arc-of-vision test is a geometric visibility proxy. It does not compute atmospheric extinction, object magnitude, integrated sky brightness, local terrain, or topocentric parallax. The chosen horizon approximates refraction for a point source, while the solar depression uses the geometric Sun altitude. The routine samples successive one-day windows from `start` and chooses a visible crossing on the transition day; it does not solve for the exact instant when the depression first equals the threshold. Dates depend on the direction models, observer, horizon, threshold, and sampling.

See [Rise, Transit, and Set]({% link astronomy/rise-transit-and-set.md %}) for the underlying horizon crossings and [Observed Catalog Star]({% link astronomy/observed-catalog-star.md %}) for a more detailed site-specific star reduction.
