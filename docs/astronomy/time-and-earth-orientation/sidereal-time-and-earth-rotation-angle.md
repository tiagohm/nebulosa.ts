---
title: Sidereal Time and Earth Rotation Angle
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 15
description: Computes Greenwich sidereal angles, Earth rotation angle, and equinox-to-CIO orientation at an astronomical instant.

doc_kind: topic

sources:
    - src/astronomy/time/time.ts

api:
    - greenwichApparentSiderealTime
    - greenwichMeanSiderealTime
    - equationOfEquinoxes
    - earthRotationAngle
    - equationOfOrigins
---

# Sidereal Time and Earth Rotation Angle

These functions describe the Earth's rotation relative to the equinox or the celestial intermediate origin (CIO) at a `Time`. Use Greenwich sidereal angles for equinox-based pointing and the Earth rotation angle (ERA) with CIO-based coordinates. The angle results are radians, not civil clock timestamps; `equationOfOrigins` returns a matrix.

## Basic usage

```ts
import { earthRotationAngle, equationOfEquinoxes, greenwichApparentSiderealTime, greenwichMeanSiderealTime, timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);
const gast = greenwichApparentSiderealTime(instant);
const gmst = greenwichMeanSiderealTime(instant);
const era = earthRotationAngle(instant);
const equinoxOffset = equationOfEquinoxes(instant); // signed GAST − GMST
console.log({ gast, gmst, era, equinoxOffset });
```

With the default providers, `greenwichApparentSiderealTime` (GAST) refers to the true equinox, `greenwichMeanSiderealTime` (GMST) to the mean equinox, and `earthRotationAngle` to the CIO. Their default ERFA implementations use UT1 for Earth rotation and TT for the celestial model; the functions convert the supplied `Time` to the needed scales. An input on UTC therefore depends on the selected UT1 − UTC provider. Default GAST, GMST, and ERA values are wrapped to `[0, 2π)`; a custom provider may choose a different range.

`equationOfEquinoxes(time)` returns **GAST − GMST**, wrapped to `(−π, π]`. Add this signed offset to GMST to obtain GAST modulo a turn. `equationOfOrigins(time)` has a different return type: it returns the matrix `Rz(GAST − ERA) · precessionNutationMatrix(time)`, relating the equinox and CIO orientation used by the library. It is not an angle. Use the matching origin when combining sidereal rotation with a celestial direction or matrix.

## Providers and limits

The default GAST and GMST providers use the bundled IAU 2006/2000A ERFA routines `eraGst06a` and `eraGmst06`; ERA uses `eraEra00`. `Time.providers` can override these calculations for a particular instant. GAST, GMST, ERA, and the equation-of-origins matrix are cached on `Time` when evaluated, so use a fresh `Time` after changing an applicable provider or Earth-orientation input. `equationOfEquinoxes` computes from the selected GAST and GMST values and is not separately cached.

The astronomical orientation depends on the time scale conversions and Earth-orientation data available to the selected providers. A sidereal angle by itself does not include an observer's longitude, polar motion, or a complete GCRS-to-ITRS rotation.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) defines `Time`, UT1, TT, and provider overrides.
- [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) composes the terrestrial rotation and polar motion.
