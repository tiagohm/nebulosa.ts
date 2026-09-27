---
title: Saturnian Satellite Theory (TASS1.7)
layout: default
parent: Astronomy
nav_order: 150
description: Evaluates Saturn-centered analytical states for eight major satellites, including Hyperion.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/models/analytical/tass17.ts

api:
    - mimas
    - enceladus
    - tethys
    - dione
    - rhea
    - titan
    - iapetus
    - hyperion
    - tass17
---

# Saturnian Satellite Theory (TASS1.7)

TASS1.7 gives **Saturn-centered geometric** positions and velocities for Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus, and Hyperion. Use these analytical states when a suitable satellite SPK is not loaded. The result is `[position, velocity]` in **AU** and **AU/day**, on J2000 equatorial axes.

## Basic usage

```ts
import { dione, hyperion, titan } from '../src/astronomy/ephemeris/models/analytical/tass17';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const instant = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TT);
const [titanPositionAu, titanVelocityAuPerDay] = titan(instant);
const [dionePositionAu] = dione(instant);
const [hyperionPositionAu] = hyperion(instant);
console.log(titanPositionAu, titanVelocityAuPerDay, dionePositionAu, hyperionPositionAu);
```

All eight named functions call `tass17(time, index)`. Indices `0` through `7` select Mimas, Enceladus, Tethys, Dione, Rhea, Titan, Iapetus, and Hyperion, respectively. The function converts `Time` to **TT** and uses days from JD 2444240.0 for its series argument. Each evaluation returns new position and velocity vectors.

## Model and origin

TASS1.7 evaluates shared satellite-longitude terms, then each body's series of equinoctial elements. It converts those elements into a rectangular state and rotates it from the theory's Saturnicentric frame into J2000 equatorial axes. Hyperion has its own series and is included as index `7`; it is not inferred from one of the other seven states.

The origin remains **Saturn's center**. Add a compatible barycentric Saturn-center state if a barycentric satellite state is needed. A direct TASS1.7 state does not include Earth, an observing site, light-time delay, aberration, or atmospheric refraction. Saturn's ring orientation and ring-view geometry are separate calculations.

## Accuracy and limits

The local tests assert sample states for all eight moons at one TT epoch. They do not establish a single error bound over the model's date range. This implementation is the TASS1.7 analytical theory, distinct from the shorter Dourneau/Meeus Saturnian-satellite approximation. Use a numerical SPK when its satellite coverage and required precision are appropriate.

## Related topics

- [Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) composes a body-center state and applies observation stages.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) evaluates covered numerical states.
