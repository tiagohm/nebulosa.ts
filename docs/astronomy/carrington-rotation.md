---
title: Carrington Rotation
layout: default
parent: Astronomy
nav_order: 240
description: Estimates a Carrington solar-rotation index from a Julian day using a mean synodic period.

doc_kind: topic

sources:
    - src/astronomy/bodies/sun.ts

api:
    - carringtonRotationNumber
---

# Carrington Rotation

`carringtonRotationNumber(time)` gives an integer index for the Sun's approximately 27-day synodic rotation cycle. Use it to label a solar image or group observations by rotation. It is a **rotation number**, not a heliographic longitude or a solar-disk orientation.

## Basic usage

```ts
import { carringtonRotationNumber } from '../src/astronomy/bodies/sun';
import { time } from '../src/astronomy/time/time';

const observation = time(2442439, 0.5);
console.log(carringtonRotationNumber(observation)); // 1624
```

The example uses a split Julian day: `2442439 + 0.5 = 2442439.5`. The function returns the plain number `1624` for that input.

## Model and time convention

The implementation evaluates `round((JD − 2398140.10155) / 27.2752316 − 0.5)`, where `JD = time.day + time.fraction` and the period is in **days**. It uses a fixed mean synodic period and epoch constant; it does not evaluate a solar ephemeris or locate an observed meridian crossing. The result is an integer label, with a transition near each mean-period boundary.

The function reads the stored day and fraction directly and does **not** convert the input `Time` to another timescale. For the same physical instant, a UTC, TT, or TDB representation can therefore put a value near a rotation boundary on different sides of that boundary. Select and keep a consistent time-scale convention for a sequence of labels.

`SolarDisk.cycle(c)` in the Meeus solar-disk topic works in the opposite direction: it estimates the **TT Julian ephemeris day** when a numbered Carrington rotation begins, using the chapter's mean period plus periodic corrections. It has a different epoch constant from `carringtonRotationNumber`, so the two are not inverse functions at every boundary. Neither helper returns the disk-center Carrington longitude `L0`; obtain that from `SolarDisk.ephemeris(jde)` when an orientation angle is needed.

## Related topics

- [Meeus Solar Disk Physical Ephemeris]({% link astronomy/meeus-algorithms/solar-disk-physical-ephemeris.md %}) gives disk-center heliographic coordinates and estimated rotation starts.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) explains how a `Time` represents one instant on different scales.
