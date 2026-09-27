---
title: Meeus Keplerian Elements
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 180
description: Solves chapter-style Kepler equations and evaluates elliptic, parabolic, and near-parabolic solar orbits.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Kepler
    - PlanetElements
    - Elliptic
    - Parabolic
    - NearParabolic
---

# Meeus Keplerian Elements

These Meeus namespaces solve Kepler's equation, evaluate mean planetary elements, and place bodies from fixed solar-orbit elements. Use them to reproduce chapter calculations for a planet, asteroid, or comet. They are separate from the library's general orbit propagation and numerical ephemeris paths.

## Basic usage

```ts
import { Elliptic, Julian, Kepler } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const eccentricAnomaly = Kepler.kepler2b(0.1, deg(5), 11);
const perihelionJde = Julian.calendarGregorianToJD(1990, 10, 28.54502); // TT label
const orbit = new Elliptic.Elements(2.2091404, 0.8502196, deg(11.94524), deg(186.23352), deg(334.75006), perihelionJde);
const jde = Julian.calendarGregorianToJD(1990, 10, 6); // TT label
const [ra, dec, solarElongation] = orbit.position(jde);
console.log(eccentricAnomaly, ra, dec, solarElongation);
```

`Elliptic.Elements(axis, ecc, inc, argP, node, timeP)` holds fixed **heliocentric** elements referred to the mean ecliptic and equinox **J2000**. The semimajor axis is in **AU**, eccentricity is dimensionless in `[0, 1)`, inclination, argument of perihelion, and ascending-node longitude are **radians**, and perihelion time is a **TT Julian ephemeris day**. `position(jde)` returns a fresh astrometric **geocentric** `[RA, Dec, solar elongation]` in **equatorial J2000** axes, all radians, with RA in `[0, 2π)`. It uses one geometric light-time refinement and does not add aberration, nutation, or gravitational deflection. The elements are fixed, so planetary perturbations are outside this model.

## Kepler's equation

`Kepler.kepler1`, `kepler2`, `kepler2a`, and `kepler2b` solve `M = E − e sin E` for eccentric anomaly `E`. Supply dimensionless eccentricity `e`, mean anomaly `M` in radians, and `places` as the desired decimal-place stopping threshold on the **radian** iterate. `kepler1` uses fixed-point iteration; `kepler2` uses an unclipped Newton-style step; `kepler2a` and `kepler2b` limit that step differently. They throw `Error('maximum iterations reached')` when their iteration budget is exhausted.

`kepler3(e, M)` uses 53 binary-search steps after normalizing `M`; it can return a **negative** eccentric anomaly for a normalized `M` in the second half of the circle. `kepler4(e, M)` is a small-eccentricity approximation. `trueAnomaly(E, e)` converts eccentric to true anomaly in radians, and `radius(E, e, a)` returns heliocentric distance in the **same unit as `a`**. The iterative and approximate methods have different convergence and accuracy behavior; no one error bound covers all eccentricities and mean anomalies.

## Mean planetary elements

`PlanetElements.mean(planet, jde, out?)` evaluates Meeus table 31.A for Mercury through Neptune, including Earth, at a numeric **TT JDE**. The elements refer to the **mean dynamical ecliptic and equinox of date**. The result contains mean longitude `L`, semimajor axis `a`, eccentricity `e`, inclination `i`, ascending-node longitude `omega`, and perihelion longitude `w`. Angles are radians, `a` is AU, and `e` is dimensionless. `L` is wrapped to `[0, 2π)`; Earth's `omega` is represented as zero. If `out` is supplied, the function fills and returns that same object; otherwise it allocates a new one. `inc` and `node` retrieve the corresponding angles individually. These are **mean elements**, not an apparent position or a set referred to J2000.

## Apparent planets and other conics

`Elliptic.position(planet, jde)` is a different path from `Elliptic.Elements.position`: it returns a fresh **apparent geocentric** `[RA, Dec]` of date for a named planet other than Earth. It obtains planetary positions from `PlanetPosition`, performs a light-time refinement, and adds the chapter's aberration, FK5, and nutation corrections. Supply a **TT JDE**; returned angles are radians and RA is wrapped to `[0, 2π)`.

`Parabolic.Elements(timeP, q).anomalyDistance(jde)` takes perihelion TT JDE and perihelion distance `q > 0` in AU. It returns fresh `[true anomaly, heliocentric distance]`, with anomaly in radians, negative on the inbound branch and positive outbound. `NearParabolic.Elements(timeP, q, e).anomalyDistance(jde)` handles eccentricities near one, including supported examples above one. Its successful result is `[true anomaly, distance]`, with anomaly wrapped to `[0, 2π)` and distance in AU. On a detected convergence failure it returns `[0, 0, 'no convergence']`; check the optional third element before interpreting the first two.

`Elliptic.astrometricJ2000(f, jde)` accepts a callback returning a heliocentric **equatorial J2000** position in AU at a TT JDE and applies the same geometric light-time and geocentric conversion used by `Elliptic.Elements.position`. The `Elliptic.velocity`, `vAphelion`, and `vPerihelion` helpers return **km/s** from distances in AU, rather than the library's usual AU/day velocity unit. `length1`, `length2`, and `length4` estimate ellipse circumference in the same unit as their semimajor-axis input; `length4` can return `undefined` after its bounded term count.

## Limits

The orbital and element functions encode Meeus chapter models, with fixed elements or mean tables where stated. Their output frames and correction stages differ, so select the routine that matches the intended astrometric or apparent place. A body at the observer makes its direction undefined, and the iterative conic routines may fail to converge outside their useful regimes. For a propagated state with perturbations or an externally supplied ephemeris, use the corresponding orbit or ephemeris-path capability.

## Related topics

- [Meeus Solar Coordinates]({% link astronomy/meeus-algorithms/solar-coordinates.md %}) provides the geocentric Sun vector used in the astrometric path.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) explains numeric TT JDE and calendar labels.
- [Meeus Precession]({% link astronomy/meeus-algorithms/precession.md %}) describes the chapter's equinox transformations.
