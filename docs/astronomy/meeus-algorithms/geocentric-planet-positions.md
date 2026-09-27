---
title: Meeus Geocentric Planet Positions
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 190
description: Explains the heliocentric PlanetPosition results used by Meeus geocentric planet reductions.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts
    - src/astronomy/ephemeris/models/analytical/vsop87e.ts

api:
    - PlanetPosition
---

# Meeus Geocentric Planet Positions

`PlanetPosition` supplies geometric **heliocentric** planet coordinates for Meeus-style calculations. Its `position` and `position2000` functions subtract the Sun's barycentric position from the planet's position, so their origin is the Sun. Use `Elliptic.position` for the corresponding chapter-style **apparent geocentric** place of a planet other than Earth.

## Basic usage

```ts
import { PlanetPosition } from '../src/astronomy/ephemeris/meeus';

const jde = 2460000.5; // numeric TT Julian ephemeris day
const j2000 = PlanetPosition.position2000('mars', jde);
const ofDate = PlanetPosition.position('mars', jde);
const fk5Angles = PlanetPosition.toFK5(ofDate[0], ofDate[1], jde);
console.log(j2000, ofDate, fk5Angles);
```

Both position functions accept a named planet from **Mercury through Neptune, including Earth**, and a numeric **TT JDE**. They return a fresh `[ecliptic longitude, ecliptic latitude, Sun–planet distance]` tuple. Longitude and latitude are **radians**, distance is **AU**, longitude is wrapped to `[0, 2π)`, and latitude represents a signed angle. The `earth` name denotes the Earth body in the series, rather than the Earth–Moon barycenter.

## Origin, axes, and corrections

`position2000(planet, jde)` evaluates the full repository VSOP87E planet and Sun series in their dynamical **ecliptic J2000** axes at the same TT instant, subtracts Sun from planet, and converts the heliocentric vector to spherical coordinates. It is not a separate truncated VSOP table. `position(planet, jde)` starts from that result and applies the Meeus chapter 21 ecliptic precession to the **mean dynamical ecliptic and equinox of date**. The precession rotates angles but retains the distance.

Both results are geometric: these functions do not apply light time, annual aberration, nutation, FK5 correction, an Earth observer, or atmospheric refraction. `toFK5(longitude, latitude, jde)` is a **separate** first-order dynamical-to-FK5 correction for ecliptic angles referred to the **mean equinox of that date**. It returns a fresh `[longitude, latitude]` pair in radians and wraps longitude. It changes the reference system, not the heliocentric origin or the equinox. Supply the of-date coordinates to it, as in the example; the correction contains `tan(latitude)` and is unsuitable near an ecliptic pole.

For an apparent geocentric planet, `Elliptic.position(planet, jde)` obtains a planet direction relative to reception-time Earth, refines light time, and applies the chapter's aberration, FK5, and nutation corrections. Its result is `[right ascension, declination]` in radians at the true equator and equinox of date. These are different coordinates and corrections from `PlanetPosition.position`.

## Accuracy and limits

The underlying VSOP87E series is analytical, and the of-date path adds a Meeus polynomial precession; the tests compare selected planets with VSOP87 reference positions and a chapter example, rather than establishing a universal error bound. Applying FK5 requires an explicit function call; neither position function accepts it as an option. For a state with a chosen kernel, center, epoch, and frame, use the SPK or ephemeris-path capabilities instead of interpreting these spherical heliocentric values as an observed place.

## Related topics

- [Meeus Keplerian Elements]({% link astronomy/meeus-algorithms/keplerian-elements.md %}) describes the `Elliptic.position` apparent geocentric result.
- [VSOP87E Planetary Theory]({% link astronomy/vsop87e-planetary-theory.md %}) exposes the barycentric analytical states used here.
- [Meeus Precession]({% link astronomy/meeus-algorithms/precession.md %}) explains the chapter's ecliptic epoch transformation.
