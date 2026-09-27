---
title: Barycentric and Heliocentric Light-Time Correction
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 260
description: Projects observer position onto an ICRS source direction to shift an observed time toward a barycentric or heliocentric date.

doc_kind: topic

sources:
    - src/astronomy/coordinates/correction.ts
    - src/astronomy/time/time.ts

api:
    - observerState
    - lightTravelTime
    - timeShift
---

# Barycentric and Heliocentric Light-Time Correction

`lightTravelTime` gives the geometric time offset between an observation at Earth and the corresponding arrival at the solar-system barycenter or Sun. The origin depends on the Earth state supplied by the caller. Add the returned offset to a **TDB** instant with `timeShift` for a BJD or HJD style result.

## Basic usage

```ts
import { lightTravelTime } from '../src/astronomy/coordinates/correction';
import { eraEpv00 } from '../src/astronomy/coordinates/erfa/earth';
import { geodeticLocation } from '../src/astronomy/observer/location';
import { tdb, timeShift, Timescale, timeYMDHMS, toJulianDay } from '../src/astronomy/time/time';
import { deg, hour } from '../src/math/units/angle';
import { meter } from '../src/math/units/distance';

const observed = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC);
const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2_400));
const observedTdb = tdb(observed);
const [barycentricEarth] = eraEpv00(observedTdb.day, observedTdb.fraction);
const correctionDays = lightTravelTime(hour(5.5), deg(-5), observed, barycentricEarth, site);
const barycentricTdb = timeShift(observedTdb, correctionDays);
console.log(toJulianDay(barycentricTdb));
```

Right ascension and declination identify the source direction in **ICRS radians**. The supplied Earth state is `[position, velocity]` relative to the selected origin, in ICRS/BCRS-oriented axes, with position in **AU** and velocity in **AU/day**. Supply an Earth state for the observation instant: the barycentric member produces a barycentric correction, while a heliocentric state produces a heliocentric one. The correction is in **days**.

The formula is `observer position · unit vector toward source / speed of light`. Its sign is positive when the observer lies on the source-facing side of the reference origin: the light arrives at the observer before it reaches that origin, so the referred timestamp is later. An observer on the opposite side receives a negative offset. `timeShift` adds the offset in days and preserves the input time scale; convert the observed instant to TDB before shifting it when a BJD(TDB) or HJD(TDB) value is wanted.

## Site and model limits

`lightTravelTime` delegates to `observerState`. An explicit `location` adds the site's Earth-fixed position after rotation into GCRS-oriented axes. If the argument is omitted, `time.location` supplies the site; with neither, the calculation uses the geocenter. The same observer-state helper also computes velocity, but this light-time formula uses its **position**. The correction is geometric and first-order: it does not include a moving source, gravitational light delay, or a full relativistic timing model.

## Related topics

- [Radial Velocity Correction]({% link astronomy/coordinates-and-observers/radial-velocity-correction.md %}) projects the same observer state's velocity rather than position.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains the TDB scale used for the shifted date.
- [Light-Time Solution]({% link astronomy/coordinates-and-observers/light-time-solution.md %}) solves travel time for moving Solar System targets instead of this distant-source projection.
