---
title: Martian Satellite Theory (MARSSAT)
layout: default
parent: Astronomy
nav_order: 170
description: Evaluates Mars-centered analytical states for Phobos and Deimos.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/marssat.ts

api:
    - phobos
    - deimos
    - marssat
---

# Martian Satellite Theory (MARSSAT)

MARSSAT computes **Mars-centered geometric** positions and velocities for Phobos and Deimos. Use it to place either natural satellite when an analytical state is sufficient. Each call returns `[position, velocity]` in **AU** and **AU/day**, expressed on J2000 equatorial axes.

## Basic usage

```ts
import { deimos, phobos } from '../src/astronomy/ephemeris/models/analytical/marssat';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT);
const [phobosPositionAu, phobosVelocityAuPerDay] = phobos(instant);
const [deimosPositionAu] = deimos(instant);
console.log(phobosPositionAu, phobosVelocityAuPerDay, deimosPositionAu);
```

The named functions call `marssat(time, index)`: **0 selects Phobos** and **1 selects Deimos**. The function converts the input `Time` to **TT** and evaluates the periodic series using days since JD **2445053.5**. Each call allocates a new state.

## Model and origin

The model adds periodic terms and secular mean-longitude terms to equinoctial orbital elements. It converts the elements to rectangular position and velocity, then rotates both vectors from the model's slowly changing Laplace plane to equatorial axes. This rotation leaves the origin at **Mars's center**.

To form a barycentric satellite state, combine the result with a Mars-center state expressed on compatible axes and in the same units. The returned state has no observing site, light-time correction, aberration, or atmospheric refraction. MARSSAT describes these two natural satellites; use a suitable spacecraft ephemeris to locate a Mars orbiter.

## Accuracy and limits

The local tests check one state for each moon. They do not establish a uniform error bound or validity interval. Use a satellite SPK when its coverage and precision are required, and match origins, axes, epochs, and observation corrections before comparing states.

## Related topics

- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) composes center-relative states and applies observation stages.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates covered numerical states.
