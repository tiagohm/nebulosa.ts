---
title: Mount Tracking Rates
layout: default
parent: Observation
nav_order: 30
description: Returns nominal sidereal, solar, lunar, and King equatorial drive rates and converts their units.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts
    - src/core/constants.ts
    - src/devices/indi/device.ts

api:
    - TrackingRateUnit
    - TrackingRate
    - trackingRate
    - convertTrackingRate
---

# Mount Tracking Rates

`trackingRate` provides four nominal equatorial drive rates in three units. Use `convertTrackingRate` when a controller expresses a rate as a sidereal multiplier, radians per second, or arcseconds per second. These functions calculate values; they do not command a mount or account for a target's instantaneous apparent motion.

## Basic usage

```ts
import { convertTrackingRate, trackingRate } from '../src/astronomy/formulas';

const sidereal = trackingRate('SIDEREAL');
const lunar = trackingRate('LUNAR');
const halfSiderealRadiansPerSecond = convertTrackingRate(0.5, 'siderealMultiplier', 'radiansPerSecond');
console.log({ sidereal, lunar, halfSiderealRadiansPerSecond });
```

`trackingRate(mode)` accepts `'SIDEREAL'`, `'SOLAR'`, `'LUNAR'`, or `'KING'`. Its type excludes the INDI `TrackMode` value `'CUSTOM'`; a custom rate is a value for the caller to supply to `convertTrackingRate`, not a fifth nominal rate. Each returned `TrackingRate` contains `radiansPerSecond`, `arcsecPerSecond`, and `siderealMultiplier`. Seconds are **SI seconds**; an arcsecond-per-second value is numerically equal to degrees per hour. A sidereal multiplier of `1` represents the nominal sidereal drive rate.

| Mode       | Rate used                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------- |
| `SIDEREAL` | One turn per `86164.0905` SI seconds, about `15.04106865` arcsec/s.                                        |
| `SOLAR`    | One turn per `86400` SI seconds, exactly `15` arcsec/s.                                                    |
| `LUNAR`    | Sidereal rate minus mean lunar motion from a `27.321661`-day sidereal month, about `14.49205371` arcsec/s. |
| `KING`     | Sidereal rate multiplied by `1 − 1/3600`, about `15.03689057` arcsec/s.                                    |

`convertTrackingRate(value, from, to)` accepts the unit names `'radiansPerSecond'`, `'arcsecPerSecond'`, and `'siderealMultiplier'`. It converts through radians per second and returns a number in the requested unit. It has no mode selection or mount side effect. The lunar rate is a mean drive constant, not a topocentric ephemeris rate; the King value is the fixed equatorial drive factor, not an hour-angle-dependent tracking calculation. For a moving target's actual angular rate, calculate the motion from positions at the relevant time and observer.

## Related topics

- [Angular Motion]({% link astronomy/coordinates-and-observers/angular-motion.md %}) derives angular and differential tracking rates from supplied position samples.
- [Alt-Az Field Rotation]({% link astronomy/coordinates-and-observers/alt-az-field-rotation.md %}) uses the sidereal angular rate to estimate field rotation.
