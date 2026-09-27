---
title: ELP/MPP02 Lunar Theory
layout: default
parent: Astronomy
nav_order: 130
description: Evaluates the Moon's geocentric analytical position and velocity in ICRF-oriented axes.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/elpmpp02.ts
    - src/astronomy/ephemeris/models/analytical/elpmpp02.data.ts

api:
    - moon
---

# ELP/MPP02 Lunar Theory

`moon(time)` evaluates the Moon's **geocentric geometric** state from the ELP/MPP02 analytical lunar theory. It returns `[position, velocity]` in **AU** and **AU/day**, expressed on ICRF-oriented equatorial axes. Use it when a lunar state is needed without loading a numerical ephemeris; an observing site, light time, and apparent-place corrections are separate calculations.

## Basic usage

```ts
import { moon } from '../src/astronomy/ephemeris/models/analytical/elpmpp02';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { vecLength } from '../src/math/linear-algebra/vec3';
import { toKilometer } from '../src/math/units/distance';

const instant = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TT);
const [geocentricPositionAu, geocentricVelocityAuPerDay] = moon(instant);
const distanceKm = toKilometer(vecLength(geocentricPositionAu));
console.log(geocentricPositionAu, geocentricVelocityAuPerDay, distanceKm);
```

The function converts the supplied `Time` to **TT** and uses Julian centuries since J2000 as its series argument. It sums main-problem and perturbation terms for lunar ecliptic longitude, latitude, and distance; applies secular Moon-angle terms and the ELP reference-distance ratio; then rotates the resulting Cartesian state through Laskar precession and a fixed tie to equatorial ICRF-oriented axes. Velocity is the corresponding analytical time derivative, including the time-dependent rotation. Each call returns fresh vectors.

## Origin and use with other states

The output is centered on the **Earth body**, not the Earth–Moon barycenter or a ground site. To form a barycentric Moon state, add a barycentric Earth state with compatible axes and units. To observe the Moon from a site, first include the site's geocentric offset and velocity, then apply the desired light-time and apparent-place workflow. The function supplies the Moon's translational state; it does not supply lunar body orientation or libration.

This model is distinct from [Low-Precision Lunar Ephemeris]({% link astronomy/low-precision-lunar-ephemeris.md %}), which documents ERFA `eraMoon98`. It is also distinct from the truncated Meeus lunar-position formulas. Select the model deliberately when comparing results or combining states.

## Accuracy and limits

The implementation includes ELP/MPP02 constants described as fitted to DE405 over **1950–2060**. It does not enforce that interval or publish a single error bound for the returned state. Accuracy depends on epoch and reference ephemeris; the local tests check a sample state and compare combined analytical states with DE421 at selected epochs. Use an SPK with suitable coverage when its numerical model and accuracy are required. There is no topocentric parallax, gravitational deflection, aberration, or atmospheric refraction in `moon(time)` itself.

## Related topics

- [VSOP87E Planetary Theory]({% link astronomy/vsop87e-planetary-theory.md %}) supplies an analytical barycentric Earth state for composition.
- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) combines centers and applies observation stages.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) reads numerical kernel states when available.
