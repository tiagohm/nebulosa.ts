---
title: Satellite Eclipses
layout: default
parent: Astronomy
nav_order: 510
description: Classifies Earth-shadow illumination and finds umbral or penumbral intervals for an SGP4 satellite.

doc_kind: topic

sources:
    - src/astronomy/events/satellite.ts

api:
    - satelliteShadowState
    - isSatelliteSunlit
    - satelliteEclipses
    - SatelliteShadowState
    - SatelliteEclipse
    - SatelliteEclipseOptions
---

# Satellite Eclipses

These functions classify whether Earth obscures the Sun as seen from an SGP4 satellite, then locate shadow entry and exit intervals. Use them alongside geometric pass predictions when planning whether a satellite receives direct sunlight.

## Basic usage

```ts
import { earth, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { isSatelliteSunlit, satelliteEclipses, satelliteShadowState } from '../src/astronomy/events/satellite';
import { parseTLE, recordFromTLE } from '../src/astronomy/orbits/propagation/sgp4';
import { timeShift } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS');
const satellite = recordFromTLE(tle);
const sunAt = (time: typeof tle.epoch) => vecMinus(sun(time)[0], earth(time)[0]);
console.log(satelliteShadowState(satellite, sunAt, tle.epoch), isSatelliteSunlit(satellite, sunAt, tle.epoch)); // umbra false
const eclipses = satelliteEclipses(satellite, sunAt, tle.epoch, timeShift(tle.epoch, 1 / 24));
console.log(eclipses.length, eclipses[0]?.entry === undefined, eclipses[0]?.exit !== undefined); // 1 true true
```

`satellite` is a prepared SGP4 `SatRec`. The `sunAt(time)` callback must return the **geocentric Earth-to-Sun position** in **AU** and ICRS-oriented axes, not merely a unit direction: its distance sets the Sun's apparent size from the satellite. The example uses an archived ISS TLE at its own 2020 epoch.

## Shadow states and intervals

`satelliteShadowState` returns `'sunlit'` when the solar disk is unobscured, `'penumbra'` when it is partly obscured, and `'umbra'` when Earth fully covers it. At very distant geometry where Earth's disk is smaller than the Sun's, even a central overlap is classified as penumbra. `isSatelliteSunlit` is true **only** for the `'sunlit'` state; it returns false in penumbra and umbra.

`satelliteEclipses` returns chronological `SatelliteEclipse` intervals for a selected shadow boundary. `boundary: 'umbra'` is the default and covers full solar-disk obscuration; `boundary: 'penumbra'` covers any partial or full obscuration. Each interval has optional `entry` and `exit` `Time` values. An interval already underway at `start` has no `entry`; one still underway at `stop` has no `exit`. `duration` is the shadowed time **in seconds within the requested window**, including portions clipped by its bounds.

The model compares the apparent angular radii of a spherical Earth and the Sun with their separation at the satellite. The satellite position is propagated from TEME into geocentric ICRS axes; the Sun callback shares that Earth-centered origin. `step` is a coarse crossing-search spacing in **days**, defaulting to **30 seconds**, and `tolerance` is a root refinement tolerance in **days**, defaulting to **10⁻⁶ day**. A coarse step can miss a brief grazing shadow interval.

This is the satellite's eclipse by Earth. It does not describe a solar eclipse on the ground, local sky visibility, atmospheric attenuation, or satellite brightness. The results depend on the TLE or OMM, Sun position, spherical-Earth shadow model, and sampling. See [Satellite Passes]({% link astronomy/satellite-passes.md %}) for geometric rise and set and [Earth Occultation of a Finite Target]({% link astronomy/earth-occultation-of-a-finite-target.md %}) for a separate finite line-of-sight blockage test.
