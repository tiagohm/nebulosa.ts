---
title: Meeus Equinoxes and Solstices
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 160
description: Estimates TT season boundaries from Meeus tables or a VSOP87E solar-longitude refinement.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Solstice
---

# Meeus Equinoxes and Solstices

`Solstice` estimates when the apparent geocentric Sun reaches a seasonal ecliptic longitude. Use the table formulas for a quick chapter-style date, or the `*2` functions to refine the event against the library's VSOP87E-based solar longitude. Results are numeric **TT Julian ephemeris days (JDE)**, not UTC timestamps.

## Basic usage

```ts
import { Solstice } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const marchEstimateJde = Solstice.march(2026);
const marchRefinedJde = Solstice.march2(2026);
const fortyFiveDegreesJde = Solstice.longitude(2026, deg(45));
console.log(marchEstimateJde, marchRefinedJde, fortyFiveDegreesJde);
```

The named events correspond to solar longitudes **0°** (March equinox), **90°** (June solstice), **180°** (September equinox), and **270°** (December solstice). `year` is an integer calendar year. The returned JDE is on **TT**; convert it through an appropriate time-scale path before presenting a UTC instant.

## Table estimate and series refinement

`march`, `june`, `september`, and `december` evaluate Meeus table 27.A or 27.B season polynomials, then add the chapter's periodic correction. The early table covers years **−1000 through 999** and the later table years **1000 through 3000**. These functions return a number without an iterative convergence step. The local tests compare selected years with chapter and reference season values; they do not establish one timing-error bound across the whole tabulated interval.

`march2`, `june2`, `september2`, and `december2` call `longitude(year, targetLongitude)`. This routine normalizes the target angle in radians to `[0, 2π)`, starts from the matching season polynomial, and iteratively evaluates `Solar.apparentVSOP87` until the step is below **0.000005 day** (about **0.432 seconds**). It returns `undefined` if it has not met that step criterion after **32 iterations**. The threshold controls the iteration, not the absolute error against a measured season instant; that also depends on the solar model.

`longitude(year, longitude)` starts a **solar year at the March equinox of `year`**. A target after 270°, such as 300°, can therefore occur in January of the next calendar year. Equivalent angles outside `[0, 2π)` are normalized before selection. The returned longitude event uses the apparent geocentric solar longitude in the true equinox of date, rather than a local observer's solar altitude.

## Accuracy and limits

The tabulated season polynomials are defined for the stated −1000 to 3000 year span. The VSOP87E refinement can evaluate other years, but its starting polynomial and solar model do not carry a documented uniform accuracy guarantee outside that interval. Neither path applies a terrestrial observing site or atmospheric refraction. For a `Time`-valued season instant in a higher-level workflow, use the library's `season` function; its representation and reduction contract are separate from these numeric JDE helpers.

## Related topics

- [Meeus Solar Coordinates]({% link astronomy/meeus-algorithms/solar-coordinates.md %}) describes the apparent longitude used by the refinement.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) explains TT JDE and calendar conversions.
- [VSOP87E Planetary Theory]({% link astronomy/vsop87e-planetary-theory.md %}) describes the underlying analytical series.
