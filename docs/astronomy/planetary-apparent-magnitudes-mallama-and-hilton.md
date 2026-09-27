---
title: Planetary Apparent Magnitudes (Mallama and Hilton)
layout: default
parent: Astronomy
nav_order: 350
description: Estimates apparent visual magnitudes of the eight planets from consistent geometric Sun, planet, and observer vectors.

doc_kind: topic

sources:
    - src/astronomy/bodies/photometry.ts

api:
    - planetMagnitude
    - Planet
    - PlanetMagnitudeOptions
---

# Planetary Apparent Magnitudes (Mallama and Hilton)

`planetMagnitude` estimates a planet's **apparent visual magnitude** using the Mallama and Hilton (2018) Astronomical Almanac relations. Use it when you have consistent Sun-to-planet and observer-to-planet vectors and need a visual-brightness estimate for an almanac or chart. It evaluates a photometric model; it does not retrieve an ephemeris or model atmospheric extinction.

## Basic usage

```ts
import { planetMagnitude } from '../src/astronomy/bodies/photometry';

const sunToJupiter = [5, 0, 0] as const; // AU
const observerToJupiter = [4, 0, 0] as const; // AU, same axes
console.log(planetMagnitude('jupiter', sunToJupiter, observerToJupiter).toFixed(3)); // -2.890
```

The example places the observer 1 AU from the Sun on the line to Jupiter. The two vectors point **toward the planet**; their lengths are 5 AU and 4 AU, and their phase angle is zero. A smaller visual magnitude means a brighter modeled object.

## Inputs and model

`planet` is one of `'mercury'`, `'venus'`, `'earth'`, `'mars'`, `'jupiter'`, `'saturn'`, `'uranus'`, or `'neptune'`. Supply both vectors in **AU** and in one consistent orientation. For **Saturn and Uranus**, use J2000 ICRF/BCRS-oriented axes because their pole vectors are fixed in those axes. `sunToPlanet` runs from Sun to planet and `observerToPlanet` from observer to planet. The function obtains heliocentric distance `r`, observer distance `Δ`, and phase angle from these vectors; internally it converts the angle to **degrees** for the published polynomials. The shared distance term is `5 log₁₀(r Δ)`.

The vectors represent the geometry you supply. The function does not perform light-time correction, precession, or ephemeris lookup. When building them from states, subtract the Sun or observer position from the planet position at consistent epochs and in the same frame. The result is a **magnitude number**, with no explicit status object.

| Option  | Used for | Default | Meaning                                                                                   |
| ------- | -------- | ------- | ----------------------------------------------------------------------------------------- |
| `rings` | Saturn   | `true`  | Includes the ring-brightness term; `false` selects the globe-only relation where defined. |
| `year`  | Neptune  | `2000`  | Julian year used in the secular brightness term and phase-model branch.                   |

Saturn's ring term uses fixed J2000 ICRF pole directions to calculate sub-solar and sub-observer latitudes. Uranus uses a similar fixed-pole calculation for its polar-aspect term. This function does not evaluate a time-dependent IAU body-orientation model or the Meeus Saturn ring geometry. Earth is included as a photometric case; Pluto is outside the `Planet` type.

## Validity and limitations

The ringed Saturn relation returns `NaN` when the phase angle exceeds **6.5°** or the modeled ring-latitude measure exceeds **27°**. With `rings: false`, the globe-only high-phase branch is available beyond 6.5°, while geometry outside the low-phase latitude bound can still return `NaN`. Neptune returns `NaN` when the phase angle exceeds **1.9°** and `year` is before **2000**. These are model-domain outcomes, so check `Number.isNaN(...)` if such geometries are possible in your data.

The source follows the Mallama and Hilton empirical visual-magnitude model, including phase terms for each planet. It omits the Mars rotation and season correction. The tests compare selected vector geometries with a reference implementation, but they do not establish a uniform accuracy bound for arbitrary geometry or epoch.

- [Meeus Planetary Magnitudes]({% link astronomy/meeus-algorithms/planetary-magnitudes.md %}) offers separate historical magnitude formulas with different input contracts.
- [IAU Body Orientation]({% link astronomy/iau-body-orientation.md %}) handles time-dependent cartographic pole and rotation models for a different purpose.
