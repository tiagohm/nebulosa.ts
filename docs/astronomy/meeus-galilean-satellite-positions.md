---
title: Meeus Galilean Satellite Positions
layout: default
parent: Astronomy
nav_order: 490
description: Projects Io, Europa, Ganymede, and Callisto around Jupiter with the Meeus chapter 44 approximation or E5 model.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - JupiterMoons
---

# Meeus Galilean Satellite Positions

`JupiterMoons` projects the four Galilean satellites into Jupiter-centered coordinates for a sky-plane drawing. It offers a short Meeus chapter 44 approximation and a more detailed **E5** path. Both accept a numeric **TT Julian ephemeris day (JDE)** and return four `[X, Y, Z]` vectors in **Jupiter equatorial radii**.

## Basic usage

```ts
import { JupiterMoons } from '../src/astronomy/ephemeris/meeus';

const jde = 2448972.50068;
const approximate = JupiterMoons.positions(jde);
const detailed = JupiterMoons.e5(jde);
console.log(approximate[JupiterMoons.IO], detailed[JupiterMoons.GANYMEDE]);
```

The results are ordered **Io, Europa, Ganymede, Callisto**. The exported index constants `IO`, `EUROPA`, `GANYMEDE`, and `CALLISTO` are respectively `0`, `1`, `2`, and `3`. At the example epoch, the approximate Io vector is about `[-3.44, +0.21, -4.82]`, while the E5 Ganymede vector is about `[+1.201, +0.590, -14.941]`, both in Jupiter radii.

## Axes and interpretation

The origin is Jupiter's center. `X` points **west** on the projected Jovian disk, `Y` points **north along Jupiter's projected rotation axis**, and `Z` points **away from Earth**. The first two components place a moon on a disk sketch; the third is its line-of-sight displacement in the model's Jupiter-centered view. The values are not J2000 Cartesian coordinates, AU, or a complete Earth-observed apparent ephemeris.

Neither method returns a transit, eclipse, or occultation classification. Those events require the relevant disk and shadow geometry, body sizes, and a time search in addition to these positions.

## Approximation and E5

`positions(jde)` evaluates the shorter chapter approximation: it uses analytic Earth–Jupiter geometry and satellite orbital angles, then projects the four positions onto the observer-facing axes. It allocates a new outer tuple and four new vectors on each call.

`e5(jde, pos?)` evaluates the chapter's E5 satellite terms. Its Jupiter viewing direction comes from a VSOP87E-based solar and planetary reduction with two Jupiter light-time refinements. The final projection includes differential light-time and perspective corrections for the moons. Without `pos`, it allocates a fresh outer tuple. With a `pos` tuple, it returns **that same outer tuple** and replaces each of its four vector entries with a new vector; previously held references to an inner vector do not receive the new coordinates.

These are distinct numerical approximations and can differ at the same epoch. The tests check Meeus chapter examples and selected conjunction exercises, but the implementation does not state a uniform error bound or a supported date interval. The separate [Galilean Satellite Theory (L1.2)]({% link astronomy/galilean-satellite-theory-l12.md %}) produces Jupiter-centered geometric position and velocity states in J2000 equatorial axes and AU/AU per day; use a consistent frame, unit, and observation model when comparing them.

## Related topics

- [Meeus Jupiter Disk]({% link astronomy/meeus-jupiter-disk.md %}) gives the Jovian pole and central meridians for a disk drawing.
- [Galilean Satellite Theory (L1.2)]({% link astronomy/galilean-satellite-theory-l12.md %}) provides a different analytical state model.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) covers numeric TT JDE and calendar labels.
