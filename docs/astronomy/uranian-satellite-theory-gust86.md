---
title: Uranian Satellite Theory (GUST86)
layout: default
parent: Astronomy
nav_order: 160
description: Evaluates Uranus-centered analytical states for five major satellites.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/gust86.ts

api:
    - miranda
    - ariel
    - umbriel
    - titania
    - oberon
    - gust86
---

# Uranian Satellite Theory (GUST86)

GUST86 computes **Uranus-centered geometric** positions and velocities for Miranda, Ariel, Umbriel, Titania, and Oberon. Use it to place one of these five major moons without a numerical satellite kernel. Each call returns `[position, velocity]` in **AU** and **AU/day**, expressed on J2000 equatorial axes.

## Basic usage

```ts
import { ariel, miranda, oberon, titania, umbriel } from '../src/astronomy/ephemeris/models/analytical/gust86';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TT);
const [mirandaPositionAu, mirandaVelocityAuPerDay] = miranda(instant);
const [arielPositionAu] = ariel(instant);
const [umbrielPositionAu] = umbriel(instant);
const [titaniaPositionAu] = titania(instant);
const [oberonPositionAu] = oberon(instant);
console.log(mirandaPositionAu, mirandaVelocityAuPerDay, arielPositionAu, umbrielPositionAu, titaniaPositionAu, oberonPositionAu);
```

The named wrappers call `gust86(time, index)`. Its index order is **0 Ariel, 1 Umbriel, 2 Titania, 3 Oberon, 4 Miranda**. The function converts the input `Time` to **TT** and evaluates the series in days since JD 2444239.5. Each evaluation returns new vectors.

## Model and origin

The model forms five shared mean-longitude, eccentricity, and inclination arguments, then evaluates the selected satellite's equinoctial elements. It converts those elements to a rectangular state and rotates from the theory's Uranicentric frame into J2000 equatorial axes. The origin remains **Uranus's center** through that rotation.

Add a Uranus-center state with compatible axes and units for a barycentric satellite state. A direct GUST86 output has no observing site, light-time correction, aberration, or atmospheric refraction. The API covers the five named moons; it does not provide states for Uranus's irregular outer satellites.

## Accuracy and limits

The local tests assert one sample state for each moon. They do not establish a uniform accuracy bound over time. Use a satellite SPK when its coverage and precision are required, and compare outputs only after matching origins, axes, epochs, and observation corrections.

## Related topics

- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) composes center-relative states and applies observation stages.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates covered numerical states.
