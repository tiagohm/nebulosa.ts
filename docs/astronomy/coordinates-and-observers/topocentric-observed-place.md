---
title: Topocentric Observed Place
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 110
description: Converts ICRS or CIRS star directions to observed azimuth, altitude, hour angle, and equatorial coordinates.

doc_kind: topic

sources:
    - src/astronomy/coordinates/astrometry.ts
    - src/astronomy/coordinates/erfa/erfa.ts

api:
    - icrsToCirs
    - cirsToIcrs
    - cirsToObserved
    - observedToCirs
    - icrsToObserved
    - Observed
    - RefractionParameters
    - DEFAULT_REFRACTION_PARAMETERS
    - EraAstrom
---

# Topocentric Observed Place

Use these transforms to take a stellar ICRS or CIRS direction to the sky coordinates an observer would measure at a geodetic site. The chain applies the relevant Earth orientation, aberration, and optional atmospheric refraction; `icrsToObserved` provides the direct ICRS-to-observed call.

## Basic usage

```ts
import { cirsToObserved, icrsToCirs, icrsToObserved, observedToCirs } from '../src/astronomy/coordinates/astrometry';
import { eraEpv00 } from '../src/astronomy/coordinates/erfa/earth';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { tdb, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { deg } from '../src/math/units/angle';
import { meter } from '../src/math/units/distance';

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400), Ellipsoid.WGS84);
time.location = site;

const earthTime = tdb(time);
const [barycentricEarth, heliocentricEarth] = eraEpv00(earthTime.day, earthTime.fraction);
const icrs = [deg(120), deg(-30)] as const;

const direct = icrsToObserved(icrs, time, barycentricEarth, heliocentricEarth[0], false, site);
const cirs = icrsToCirs(icrs, time, barycentricEarth, heliocentricEarth[0]);
const observed = cirsToObserved(cirs, time, false, site);
const recoveredCirs = observedToCirs(observed.azimuth, observed.altitude, time, false, site);

console.log(direct.azimuth, direct.altitude, recoveredCirs);
```

The example disables refraction with `false` so the forward and inverse CIRS steps can be compared in vacuum. `eraEpv00` supplies an illustrative Earth state; for measured orientation, load Earth-orientation data before making the `Time` conversions. The direct ICRS path uses a topocentric astrometry context, while `icrsToCirs` first forms a geocentric CIRS place and `cirsToObserved` applies site effects afterward. They agree closely for the illustrated stellar input, but they are separate computation paths.

## Inputs and frames

`icrsToCirs` and `cirsToIcrs` accept either an ICRS/CIRS `[rightAscension, declination]` pair in radians or a Cartesian direction vector. Their returned pair is CIRS/ICRS right ascension and declination in radians. These paths assume **zero parallax and zero proper motion** for the source. The ICRS→CIRS path includes solar light deflection, aberration, and bias–precession–nutation; the inverse removes those effects through the ERFA-style inverse. Use star-parameter routines for catalog objects whose parallax or proper motion matters, or a finite-target pipeline for Solar System bodies.

`ebpv` is Earth's barycentric `[position, velocity]` in AU and AU/day. `ehp` is Earth's **heliocentric** position in AU. Both should describe the reception epoch and use ICRS/BCRS axes. If `ehp` is omitted, the code uses `ebpv[0]` as its value; supply a distinct heliocentric position when its difference matters. The wrappers convert `time` to TT for the astrometry model. `cirsToObserved`, `observedToCirs`, and `icrsToObserved` also convert it to UT1 and read polar motion through the configured time providers.

For observed-place functions, `location` is a geodetic longitude (east-positive), latitude (north-positive), and ellipsoidal elevation in AU. It defaults to `time.location`; provide one of these when the wrapper builds its context. `cirsToObserved` converts a CIRS direction to an `Observed` result. `observedToCirs(azimuth, altitude, ...)` reverses that step and returns a CIRS angle pair. `icrsToObserved` accepts ICRS input and the Earth states as well as the site.

{: .important }
As implemented, `icrsToObserved` selects its ellipsoid from `time.location?.ellipsoid`, falling back to IERS 2010. An explicit `location` argument supplies longitude, latitude, and elevation, but does not change that ellipsoid selection. Set `time.location` to the same site when using a nondefault ellipsoid. The CIRS↔observed context uses ERFA's WGS84 site model for its diurnal-aberration term.

## Observed result and refraction

| `Observed` field                | Meaning                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `azimuth`                       | Radians from north through east, normalized to `[0, 2π)`.                                            |
| `altitude`                      | Radians above the local geodetic horizon plane; calculated as `π/2 − observed zenith distance`.      |
| `hourAngle`                     | Signed radians from the meridian, positive westward.                                                 |
| `rightAscension`, `declination` | Observed equatorial angles in radians; right ascension is **CIO-based** and normalized to `[0, 2π)`. |
| `equationOfOrigins`             | Equation of the origins in radians, calculated from the IAU 2006/2000A orientation model.            |

The CIRS right ascension is also CIO-based. To express either returned CIO-based right ascension against the true equinox of date, subtract the matching equation of the origins and normalize the angle. Do not interpret the raw CIO value as equinox-based apparent right ascension.

`refraction` defaults to `DEFAULT_REFRACTION_PARAMETERS`: pressure `1013.25` hPa, temperature `15` °C, relative humidity `0.5`, and wavelength `0.55` µm. A partial `RefractionParameters` object fills missing fields from those defaults. Pass `false` to set pressure to zero and disable atmospheric refraction. The ERFA two-constant model bounds the correction near the horizon; atmospheric predictions there remain sensitive to local conditions.

## Accuracy and reuse

The transformations depend on the supplied Earth state, site, and orientation data. The shared IERS tables initially contain no measured values, so default DUT1 and polar motion can be zero fallbacks until bulletin data is loaded. Reuse a suitable precomputed `EraAstrom` through the optional `astrom` argument for repeated calls at the same epoch and site. Use a geocentric `eraApci13` context for ICRS↔CIRS, an `eraApio13` context for CIRS↔observed, or an `eraApco13` context for direct ICRS→observed. With a supplied context, its prepared values govern the transform instead of rebuilding them from the other arguments. For `cirsToObserved`, a caller-supplied context must also contain the intended `eo`; the wrapper calculates `eo` only when it builds the context itself.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains the TT and UT1 conversions.
- [Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) supplies measured DUT1 and polar motion.
- [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) handles finite target light time separately from this stellar observed-place chain.
- [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) gives the altitude lift at a selected wavelength.

## References

- [ERFA `eraAtco13` routine notes](https://github.com/liberfa/erfa/blob/master/src/atco13.c) define observed azimuth, CIO-based right ascension, and the refraction model.
- [ERFA `eraAtci13` routine notes](https://github.com/liberfa/erfa/blob/master/src/atci13.c) give the CIO-to-equinox right-ascension conversion.
