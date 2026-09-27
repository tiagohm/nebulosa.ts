---
title: Ephemeris Path Adapters
layout: default
parent: Astronomy
nav_order: 110
description: Builds labeled ephemeris paths from SPK segments, SGP4 orbits, and observer sites.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/path.adapter.ts

api:
    - spkEphemerisPath
    - sgp4EphemerisPath
    - earthObserverEphemerisPath
    - bodySurfaceEphemerisPath
---

# Ephemeris Path Adapters

These adapters turn prepared kernels, satellite elements, and surface locations into `EphemerisPath` values. Each path labels its center and target and supplies synchronous states in the library's ICRS/BCRS-oriented base axes, with position in **AU** and velocity in **AU/day**. Use them to compose paths before sampling a geometric state or, with SSB-centered paths, an observed direction.

## Basic usage

```ts
import fs from 'fs/promises';
import { readDaf } from '../src/astronomy/ephemeris/kernels/daf';
import { Naif } from '../src/astronomy/ephemeris/kernels/naif';
import { readSpk } from '../src/astronomy/ephemeris/kernels/spk';
import { composeEphemerisPaths, customEphemerisEndpoint } from '../src/astronomy/ephemeris/path';
import { earthObserverEphemerisPath, spkEphemerisPath } from '../src/astronomy/ephemeris/path.adapter';
import { ephemerisAt } from '../src/astronomy/ephemeris/position';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { fileHandleSource } from '../src/io/io';
import { deg } from '../src/math/units/angle';
import { meter } from '../src/math/units/distance';

// Run from a repository checkout containing the DE421 fixture.
await using source = fileHandleSource(await fs.open('data/de421.bsp'));
const spk = readSpk(await readDaf(source));
const emb = await spkEphemerisPath(spk, Naif.SSB, Naif.EMB);
const earthFromEmb = await spkEphemerisPath(spk, Naif.EMB, Naif.EARTH);
if (emb === undefined || earthFromEmb === undefined) throw new Error('Earth path is absent');

const earth = composeEphemerisPaths(emb, earthFromEmb);
const location = geodeticLocation(deg(-70), deg(-30), meter(2400), Ellipsoid.WGS84);
const site = earthObserverEphemerisPath(location, customEphemerisEndpoint('observatory'));
const barycentricSite = composeEphemerisPaths(earth, site);
const instant = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB);
console.log(ephemerisAt(barycentricSite, instant).position);
```

The two compositions are needed because this DE421 kernel has separate SSB-to-Earth–Moon-barycenter and Earth–Moon-barycenter-to-Earth segments, while `earthObserverEphemerisPath` is Earth-centered. A site path alone is not SSB-centered and cannot be passed directly to `observeEphemeris`.

## Adapter contracts

| Adapter                                            | Center and target                                        | State source                                                               |
| -------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `await spkEphemerisPath(spk, center, target)`      | NAIF IDs supplied by the caller                          | One initialized SPK segment, in its kernel coverage.                       |
| `sgp4EphemerisPath(tleOrOmmOrRecord, target?)`     | Earth center to `target`, or `norad:{satnum}` by default | SGP4 propagated state rotated from TEME into the library base axes.        |
| `earthObserverEphemerisPath(location, target)`     | Earth center to the supplied site endpoint               | Earth-site offset and diurnal velocity from the geodetic location.         |
| `bodySurfaceEphemerisPath(body, target, location)` | Supplied body center to surface endpoint                 | Body-relative position and rotational velocity from `BodySurfaceLocation`. |

`spkEphemerisPath` resolves and initializes its segment asynchronously. It returns `undefined` if the center-to-target pair is absent and throws if the segment's NAIF frame ID is not `1` (`J2000`); it does not rotate another SPK frame into the library base. Once prepared, `path.stateAt(time)` is synchronous, but a coefficient cache miss may perform synchronous reads from the SPK. Keep its DAF source open until evaluations finish. Segment coverage and overlap selection follow the SPK reader.

`sgp4EphemerisPath` accepts a parsed TLE, OMM, or prepared `SatRec`. TLE and OMM inputs are prepared once when the path is made. Its state is **Earth-centered geometric**, with TEME position and velocity transformed to ICRS/GCRS-oriented axes at each evaluation epoch. It is not an apparent place; light time and observer corrections require a separate workflow. A supplied `target` replaces the default `norad:{satnum}` custom endpoint.

The site adapters return offsets from the named body center. `earthObserverEphemerisPath` uses the supplied geographic location for the Earth's ITRS-to-GCRS state and includes the site's rotational velocity. `bodySurfaceEphemerisPath` uses the supplied body's shape and body-fixed frame through its `BodySurfaceLocation`; the frame determines the rotational velocity. Neither adapter chooses a body-center ephemeris. Compose the offset with a matching center path when a barycentric site is needed.

## Related topics

- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) explains composition and geometric versus observed sampling.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) covers SPK segment lookup, units, and supported types.
- [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) defines an Earth site and its geodetic units.
- [Planetary Surface Locations]({% link astronomy/coordinates-and-observers/planetary-surface-locations.md %}) defines a rotating surface location.
