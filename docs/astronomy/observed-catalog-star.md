---
title: Observed Catalog Star
layout: default
parent: Astronomy
nav_order: 340
description: Reduces catalog star astrometry to observed equatorial and horizon angles for a terrestrial site.

doc_kind: topic

sources:
    - src/astronomy/bodies/star.ts

api:
    - observeStar
    - ObservedStar
---

# Observed Catalog Star

`observeStar` takes a star's catalog position and motion, an observing instant and site, and Earth's ephemeris to calculate where the star appears in the local sky. It combines the ERFA catalog-to-observed reduction with Earth orientation and optional atmospheric refraction. Use it when proper motion or parallax matters for a site-specific direction.

## Basic usage

```ts
import { observeStar, star } from '../src/astronomy/bodies/star';
import { eraEpv00 } from '../src/astronomy/coordinates/erfa/earth';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { tdb, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { deg, mas, toDeg } from '../src/math/units/angle';
import { meter } from '../src/math/units/distance';
import { kilometerPerSecond } from '../src/math/units/velocity';

const observation = timeYMDHMS(2026, 1, 1, 3, 0, 0, Timescale.UTC);
observation.location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84);
const earthTime = tdb(observation);
const [barycentricEarth, heliocentricEarth] = eraEpv00(earthTime.day, earthTime.fraction);

const dec = deg(-16.7225);
const catalog = star(deg(101.27724), dec, mas(-415.12) / Math.cos(dec), mas(-1163.79), mas(378.932), kilometerPerSecond(-10));
const observed = observeStar(catalog, observation, barycentricEarth, heliocentricEarth[0], false);
console.log(toDeg(observed.azimuth).toFixed(2), toDeg(observed.altitude).toFixed(2)); // 68.64 62.67
```

This example disables refraction and uses `eraEpv00` for an illustrative Earth state. Its result also depends on the DUT1 and polar-motion providers attached to `observation`; load measured Earth-orientation data when that accuracy matters.

## Required inputs

| Input        | Unit / convention                   | Meaning                                                                                                                                   |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `star`       | `Star` or `StarPositionAndVelocity` | ICRS catalog RA/Dec and motion at its catalog epoch. A plain `Star` is treated as J2000.0.                                                |
| `time`       | `Time` with `location`              | Observation instant; the attached location supplies east-positive geodetic longitude, north-positive latitude, and ellipsoidal elevation. |
| `ebpv`       | `[position AU, velocity AU/day]`    | Earth's barycentric state in ICRS/BCRS axes at the observation epoch.                                                                     |
| `ehp`        | position in AU                      | Earth's heliocentric position in the same axes and at the same epoch.                                                                     |
| `refraction` | `RefractionParameters` or `false`   | Atmospheric conditions; omitted uses defaults, `false` disables refraction.                                                               |

The site must be attached as `time.location`; otherwise the function throws `Error('time.location is required')`. `ehp` is optional in the TypeScript signature and then defaults to `ebpv[0]`. Supply the actual heliocentric Earth position when available: the fallback substitutes a barycentric position for the heliocentric vector used in the solar-deflection geometry. Earth's barycentric **velocity** from `ebpv` drives the aberration calculation.

The function converts `time` to TT for the celestial reduction and UT1 for Earth rotation, reads polar motion through its time providers, and uses the site's selected ellipsoid. If the input is a `StarPositionAndVelocity` with a nondefault catalog epoch, it first propagates its catalog data to J2000.0 TT because the observed-place model measures proper motion from J2000.0. If that propagation cannot produce catalog parameters, the code continues with the original fields. [Stellar Space Motion]({% link astronomy/stellar-space-motion.md %}) describes the catalog units and state.

## Reading the observed place

The returned `ObservedStar` has `azimuth` in radians **from north through east**, `altitude` in radians **above the local horizon**, and local `hourAngle` in radians **positive westward**. Its `rightAscension` and `declination` are observed equatorial angles in radians; right ascension uses the **CIO origin** and is normalized to `[0, 2π)`. `equationOfOrigins` is the CIO-to-equinox offset in radians; subtract it from the returned right ascension and normalize when an equinox-based value is needed. `observed.star` refers to the original input star object.

`altitude` is calculated as `π/2 − observed zenith distance`. By default, refraction uses **1013.25 hPa**, **15 °C**, **0.5** relative humidity, and **0.55 µm** wavelength; a partial parameter object fills missing fields from these defaults. With `false`, pressure is set to zero and the atmospheric correction is disabled. The output still contains the remaining astrometric and site reductions.

## Accuracy and related topics

The result depends on catalog data, the Earth state, UT1 and polar motion, site coordinates, and local atmospheric conditions. Default Earth-orientation readers can provide zero fallbacks until measured data is loaded. The ERFA refraction model bounds its correction near the horizon; local conditions and horizon obstruction remain outside this calculation. No uniform accuracy bound is specified for arbitrary inputs.

- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) covers direction-only ICRS and CIRS transforms and the shared observed-angle conventions.
- [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) explains DUT1 and polar-motion data.
- [Meeus Apparent Place of a Star]({% link astronomy/meeus-algorithms/apparent-place-of-a-star.md %}) gives a separate chapter-style apparent-place calculation without this site-specific chain.
