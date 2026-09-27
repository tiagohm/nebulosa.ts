---
title: Pluto Short Analytical Theory
layout: default
parent: Astronomy
nav_order: 180
description: Computes an approximate heliocentric Pluto position from Meeus's short periodic series.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/pluto.ts

api:
    - pluto
    - ReferenceFrame
---

# Pluto Short Analytical Theory

`pluto` estimates Pluto's **heliocentric geometric position** using the 43-term short series from chapter 37 of Meeus's _Astronomical Algorithms_. It is useful for a coarse Pluto position when a numerical ephemeris is unavailable. The result contains **position only**, with no velocity.

## Basic usage

```ts
import { pluto } from '../src/astronomy/ephemeris/models/analytical/pluto';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT);
const [xAu, yAu, zAu] = pluto(instant);
const [longitudeRad, latitudeRad, radiusAu] = pluto(instant, 'eclipticJ2000');
console.log(xAu, yAu, zAu, longitudeRad, latitudeRad, radiusAu);
```

By default, the function returns Cartesian `[x, y, z]` in **AU** on J2000 equatorial axes. Passing `'eclipticJ2000'` as the second argument returns **spherical** `[longitude, latitude, radius]` instead: angles in **radians** on J2000 ecliptic axes and radius in **AU**. The longitude is the series result and is not wrapped to a specified interval. Both forms have the **Sun** as origin; the option changes the coordinate representation as well as the axes.

The input `Time` is converted to **TT**. The model uses Julian centuries from JD 2451545.0 for the mean longitudes of Jupiter, Saturn, and Pluto, then adds periodic longitude, latitude, and radius terms. The default Cartesian result rotates the spherical ecliptic position by the J2000 obliquity. Each call returns a new array.

## Accuracy and limits

The source identifies this as Meeus's short model for **1885–2099** and quotes approximate errors of **0.07 arcsecond in longitude**, **0.02 arcsecond in latitude**, and **0.000006 AU in radius**. These are model estimates, not a verified bound for every date or for this implementation. The function has no date guard and still evaluates outside that interval, where its accuracy is unspecified. Local tests check the Meeus example and one modern Cartesian position.

This is a heliocentric analytical position, not a barycentric SPK state or a VSOP87E Pluto state. Match the origin, axes, epoch, and observation corrections before comparing it with another ephemeris. Use a covered SPK for a numerical Pluto state or when a velocity is needed.

## Related topics

- [VSOP87E Planetary Theory]({% link astronomy/vsop87e-planetary-theory.md %}) provides analytical barycentric states for the Sun and eight planets.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates covered numerical position and velocity states.
