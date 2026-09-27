---
title: VSOP87E Planetary Theory
layout: default
parent: Astronomy
nav_order: 120
description: Evaluates barycentric analytical positions and velocities of the Sun and eight planets.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/vsop87e.ts
    - src/astronomy/ephemeris/models/analytical/vsop87e.data.ts

api:
    - sun
    - mercury
    - venus
    - earth
    - mars
    - jupiter
    - saturn
    - uranus
    - neptune
    - ReferenceFrame
---

# VSOP87E Planetary Theory

The VSOP87 version E series supplies geometric, **solar-system-barycentric** rectangular states for the Sun and eight planets. Use it for offline analytical planet states when a suitable numerical SPK kernel is not part of the workflow. Each body function returns `[position, velocity]` in **AU** and **AU/day**; it does not compute an observer-relative or apparent place.

## Basic usage

```ts
import { earth, mars, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TT);
const [earthPositionAu, earthVelocityAuPerDay] = earth(instant);
const [marsPositionAu] = mars(instant);
const [sunEclipticAu] = sun(instant, 'eclipticJ2000');
console.log(earthPositionAu, earthVelocityAuPerDay, marsPositionAu, sunEclipticAu);
```

The same `(time, frame?)` signature is available on `sun`, `mercury`, `venus`, `earth`, `mars`, `jupiter`, `saturn`, `uranus`, and `neptune`. The function converts the supplied `Time` to **TT** before evaluating the series. Its dimensionless series argument is Julian millennia since J2000: `(JD_TT − 2451545.0) / 365250`. Velocity is calculated from the analytical derivative of the position series and converted from AU per Julian millennium to AU/day. Each call returns fresh position and velocity vectors.

## Origin and axes

The native VSOP87E coefficients describe dynamical ecliptic and equinox of J2000 axes. Pass `'eclipticJ2000'` to retain those axes. By default, `'icrf'` rotates both position and velocity into ICRF-oriented equatorial axes using the implementation's fixed J2000 obliquity and small equinox frame tie. **Both choices retain the solar-system barycenter as origin.** `earth` is the Earth body in this analytical solution, not the Earth–Moon barycenter or a surface observer.

To get a same-epoch planet-to-planet state, subtract states with the same frame or wrap the functions in [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}). Light time, gravitational deflection, aberration, and an observer location are separate steps. Mixing an `'eclipticJ2000'` state with a default `'icrf'` state would combine different axes.

## Accuracy and limits

VSOP87E is an analytical planetary theory, so its residual against a numerical ephemeris depends on body and epoch. The repository tests compare native ecliptic states with published VSOP87 check values and sample ICRF states against JPL Horizons; they do not establish one accuracy bound over all dates. The series supplies no lunar state or body rotation. Use an SPK when the desired body, epoch, and required precision are covered by that kernel, and account for the kernel's own frame and origin.

## Related topics

- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates numerical center-to-target states from loaded kernels.
- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) combines barycentric states and applies observer-dependent corrections.
- [Low-Precision Earth Ephemeris]({% link astronomy/low-precision-earth-ephemeris.md %}) provides ERFA's separate analytical Earth state model.
