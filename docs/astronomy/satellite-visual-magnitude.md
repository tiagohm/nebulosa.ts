---
title: Satellite Visual Magnitude
layout: default
parent: Astronomy
nav_order: 520
description: Estimates visual magnitude from a supplied standard magnitude, phase angle, and observer range.

doc_kind: topic

sources:
    - src/astronomy/events/satellite.ts

api:
    - satelliteMagnitude
    - SatelliteMagnitude
---

# Satellite Visual Magnitude

`satelliteMagnitude` estimates a satellite's visual magnitude from its SGP4 position, Sun–satellite–observer phase, range, and a caller-supplied standard magnitude. Use it to rank candidate passes when a standard magnitude for that satellite is available.

## Basic usage

```ts
import { earth, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { satelliteMagnitude } from '../src/astronomy/events/satellite';
import { geodeticLocation } from '../src/astronomy/observer/location';
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4';
import { timeShift } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { deg, toDeg } from '../src/math/units/angle';

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS');
const site = geodeticLocation(deg(-46.6361), deg(-23.5475));
const sunAt = (time: typeof tle.epoch) => vecMinus(sun(time)[0], earth(time)[0]);
const result = satelliteMagnitude(recordFromTLE(tle), site, sunAt, timeShift(tle.epoch, 55 / 1440), -1.8);
console.log(result.magnitude.toFixed(2), toDeg(result.phaseAngle).toFixed(1), result.illuminated); // -1.91 108.6 true
```

The `SatRec` is propagated at `time`; `site` is geographic, and `sunAt(time)` supplies the **geocentric Earth-to-Sun position in AU** with ICRS-oriented axes. The last argument is an empirical **standard visual magnitude** for the particular satellite, defined at **1000 km range and 90° phase**. The example uses an archived ISS TLE at its 2020 epoch and an illustrative standard magnitude of −1.8.

## Interpreting the estimate

`SatelliteMagnitude.magnitude` is a visual magnitude, so smaller values are brighter. `phaseAngle` is the **Sun–satellite–observer angle in radians**, from 0 at full phase to π at zero modeled illuminated fraction. `range` is observer-to-satellite slant distance in **AU**. The model uses a diffuse-sphere illuminated fraction `f = (1 + cos(phaseAngle)) / 2` and computes `standardMagnitude − 15.75 + 2.5 log10(rangeKm² / f)`; at `f = 0`, the computed magnitude is `Infinity`.

`illuminated` is false in Earth's **umbra** and true in both full sunlight and **penumbra**. The numeric `magnitude` is still computed in umbra but is not a usable brightness estimate there. In penumbra, the formula does not reduce brightness for the portion of the solar disk blocked by Earth; check [Satellite Eclipses]({% link astronomy/satellite-eclipses.md %}) when full sunlight is required. In particular, `isSatelliteSunlit` is stricter than this result's `illuminated` flag: it returns false in penumbra.

The model does not include atmospheric extinction, refraction, specular flares, attitude-dependent reflectance, or a detailed shape. Accuracy depends on the supplied standard magnitude, orbital elements, Sun position, and those omitted effects. [Satellite Look Angles]({% link astronomy/satellite-look-angles.md %}) supplies geometric pointing and range without a brightness model.
