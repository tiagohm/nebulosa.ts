---
title: Radial Velocity Correction
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 250
description: Projects barycentric or heliocentric observer velocity onto an ICRS stellar direction for a first-order radial-velocity correction.

doc_kind: topic

sources:
    - src/astronomy/coordinates/correction.ts
    - src/astronomy/coordinates/itrs.ts

api:
    - observerState
    - radialVelocityCorrection
---

# Radial Velocity Correction

`radialVelocityCorrection` provides the observer-motion term to add to a measured radial velocity when referring it to a solar-system origin. Supply an Earth position and velocity relative to the **solar-system barycenter** for a barycentric correction, or relative to the **Sun** for a heliocentric correction. An optional geographic site adds the observer's diurnal motion.

## Basic usage

```ts
import { radialVelocityCorrection } from '../src/astronomy/coordinates/correction';
import { eraEpv00 } from '../src/astronomy/coordinates/erfa/earth';
import { geodeticLocation } from '../src/astronomy/observer/location';
import { tdb, Timescale, timeYMDHMS } from '../src/astronomy/time/time';
import { deg, hour } from '../src/math/units/angle';
import { meter } from '../src/math/units/distance';
import { toKilometerPerSecond } from '../src/math/units/velocity';

const time = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC);
const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2_400));
const date = tdb(time);
const [, barycentricEarth] = eraEpv00(date.day, date.fraction);
const correctionAuPerDay = radialVelocityCorrection(hour(5.5), deg(-5), time, barycentricEarth, site);
const correctionKmPerSecond = toKilometerPerSecond(correctionAuPerDay);
console.log(correctionKmPerSecond);
```

Right ascension and declination are the source direction in **ICRS radians**; `hour` and `deg` convert the example inputs. The supplied Earth state is `[position, velocity]` in ICRS/BCRS-oriented axes, with position in **AU** and velocity in **AU/day**. Use an Earth state evaluated for the same observation instant. The result is **AU/day**; `toKilometerPerSecond` converts it for comparison with a spectrum's measured velocity.

The correction is the dot product `observer velocity · unit vector toward source`. A positive value means the observer moves toward the source; that motion makes its measured radial velocity more blue-shifted. In the same velocity units, use `referred radial velocity = measured radial velocity + correction`. The sign follows this directed relationship: a source aligned with the observer's velocity receives a positive correction; the opposite direction receives a negative one.

## Observer position and limits

`observerState(time, earth, location?)` starts from the supplied Earth state. When a site is present, it adds the site's ITRS position rotated into GCRS-oriented axes and a diurnal velocity from Earth's rotation; it returns a new position-and-velocity pair. The `location` argument defaults to `time.location`. With neither an explicit site nor `time.location`, it returns the supplied Earth state itself and the correction is geocentric. An explicit site overrides `time.location`.

This is a first-order velocity projection. It uses the supplied ICRS source direction and Earth state; it does not derive stellar motion, gravitational redshift, or a fully relativistic spectroscopic correction. Use a barycentric Earth state when the required reference is the barycenter and a heliocentric one when it is the Sun.

## Related topics

- [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) constructs the observing site.
- [Annual Aberration]({% link astronomy/coordinates-and-observers/annual-aberration.md %}) applies observer motion to an apparent direction rather than a spectral velocity.
