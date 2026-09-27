---
title: Meeus Apsis and Node Passages
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 200
description: Estimates planetary perihelion and aphelion times and computes orbital-node passage times from fixed elements.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Perihelion
    - Node
---

# Meeus Apsis and Node Passages

`Perihelion` dates a planet's closest or farthest **heliocentric** passage using a Meeus chapter 38 estimate, with an optional bounded VSOP87E distance refinement. `Node` computes where a fixed elliptic or parabolic solar orbit crosses its reference ecliptic plane. Use these for chapter-style orbital events; the returned times are numeric **TT Julian ephemeris days (JDE)**.

## Basic usage

```ts
import { Julian, Node, Perihelion } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const earthEstimateJde = Perihelion.perihelion('earth', 2026);
const earthRefined = Perihelion.perihelion2('earth', 2026);
const timeP = Julian.calendarGregorianToJD(1986, 2, 9.45891); // TT perihelion label
const [nodeJde, nodeRadiusAU] = Node.ellipticAscending(17.9400782, 0.96727426, deg(111.84644), timeP);
console.log(earthEstimateJde, earthRefined, nodeJde, nodeRadiusAU);
```

`Perihelion.perihelion(planet, decimalYear)` and `aphelion` return a **single estimated TT JDE** from chapter polynomials near the supplied decimal year. They accept Mercury through Neptune or `'embary'`, the **Earth–Moon barycenter**. For the `'earth'` estimate, the code adds lunar perturbation terms; the `'embary'` estimate omits them. These estimates are intended for roughly **1600–2400**; outer-planet polynomial estimates can be months or years from the actual apsis, so use a refined method when its modeled distance extremum matters.

## Refined perihelion and aphelion

`perihelion2(planet, decimalYear, precision = 0.01)` and `aphelion2` return a fresh `[TT JDE, heliocentric distance in AU]`, or `undefined` when the bounded search cannot find and refine an interior extremum. Their `planet` accepts Mercury through Neptune, including Earth, but **not `'embary'`**. `precision` is a positive **time tolerance in days** for the minimizer, not an accuracy guarantee against an external ephemeris.

The refinement samples the VSOP87E-derived Sun–planet distance around the polynomial estimate, brackets local distance extrema, and runs at most **100 minimizer iterations** per bracket. Its sample window extends one eighth of that planet's nominal orbital period on either side, except Neptune's window is **±5000 days** to cover its broad double extrema. Of the bracketed candidates, it selects the smallest radius for perihelion or largest for aphelion. It examines **128 intervals** across that finite window; it is not a general search for every perturbation-driven local extremum. Differences between analytical models or a very flat extremum can affect the returned event time even when the radius changes little.

## Orbital-node geometry

`Node.ellipticAscending(axis, ecc, argP, timeP)` and `ellipticDescending` take semimajor axis in **AU**, dimensionless eccentricity in `[0, 1)`, argument of perihelion in **radians**, and perihelion **TT JDE**. They return fresh `[node-passage TT JDE, heliocentric radius in AU]`. Ascending passage uses true anomaly `−argP`; descending passage uses `π − argP`. The corresponding `Node.elliptic(nu, axis, ecc, timeP)` accepts the true anomaly directly.

`Node.parabolicAscending(q, argP, timeP)` and `parabolicDescending` use perihelion distance `q > 0` in AU in place of the semimajor axis and eccentricity. `Node.parabolic(nu, q, timeP)` accepts a true anomaly directly. These functions apply the chapter's parabolic time-of-flight expression and return the same `[TT JDE, heliocentric radius in AU]` shape. A node passage is the body's crossing of its orbit's reference plane; these functions do not compute a lunar node, Earth-observer event, or atmospheric effect.

## Limits

The node helpers use fixed orbital elements and do not model perturbations or search an ephemeris for a plane crossing. Their time can precede the supplied perihelion time, depending on the node anomaly. The apsis methods are chapter estimates or a bounded search of the selected VSOP87E analytical distance, not an unlimited root search. Convert a returned TT JDE through the appropriate time-scale path before presenting a UTC date.

## Related topics

- [Meeus Keplerian Elements]({% link astronomy/meeus-algorithms/keplerian-elements.md %}) defines the fixed elliptic and parabolic orbit conventions.
- [Meeus Geocentric Planet Positions]({% link astronomy/meeus-algorithms/geocentric-planet-positions.md %}) describes the heliocentric planet distance evaluated by the refinement.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) explains TT JDE and calendar labels.
