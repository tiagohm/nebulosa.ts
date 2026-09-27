---
title: Meeus Lunar Position
layout: default
parent: Astronomy
nav_order: 520
description: Evaluates the Moon's geocentric chapter 47 ecliptic coordinates, distance, and related orbital longitudes.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - MoonPosition
---

# Meeus Lunar Position

`MoonPosition` evaluates the Moon's geocentric ecliptic location using the periodic series in Meeus chapter 47. Use it for chapter-style lunar examples or as input to nearby Meeus disk formulas. It accepts a numeric **TT Julian ephemeris day (JDE)** and returns angles in **radians** and distance in **AU**.

## Basic usage

```ts
import { Julian, MoonPosition } from '../src/astronomy/ephemeris/meeus';
import { toDeg } from '../src/math/units/angle';
import { toKilometer } from '../src/math/units/distance';

const jde = Julian.calendarGregorianToJD(1992, 4, 12); // interpreted as TT
const [longitude, latitude, distanceAu] = MoonPosition.position(jde);
console.log(toDeg(longitude), toDeg(latitude), toKilometer(distanceAu));
```

The chapter test produces about `133.162655°` longitude, `−3.229126°` latitude, and `368409.7 km` distance after conversion. The returned distance itself is in **AU**, consistent with the library's distance convention.

## Coordinate contract

`position(jde)` returns a fresh `[geocentric ecliptic longitude, geocentric ecliptic latitude, Earth–Moon distance]` tuple. Its angular axes refer to the **mean ecliptic and equinox of date**; the longitude does **not** include nutation, and the function does not perform a topocentric reduction. The implementation sums tabulated periodic terms in lunar longitude, latitude, and radius, with the chapter's additional periodic corrections.

The code normalizes the mean longitude before adding the periodic longitude correction; it does not wrap the final sum again. Near a `0°/360°` crossing, a returned longitude may therefore lie slightly outside `[0, 2π)`. Normalize it at the presentation boundary if a wrapped display is required. Latitude remains signed.

## Perigee and node directions

`perigee(jde)` evaluates the chapter polynomial for the **longitude of lunar perigee** and returns it normalized to `[0, 2π)` radians. `trueNode(jde)` evaluates the **true ascending-node longitude** by adding chapter periodic corrections to the mean ascending node. The mean node comes from `moonMeanAscendingNode` at the supplied TT day, in the mean ecliptic and equinox of date. `trueNode` does not normalize after applying the periodic terms, so wrap it yourself if needed. These two helpers return **directions**, not the times of perigee or node passage.

## Accuracy and limits

This is the truncated Meeus chapter 47 lunar series, distinct from the [ELP/MPP02 Lunar Theory]({% link astronomy/elp-mpp02-lunar-theory.md %}) and numerical SPK states. The page's chapter test verifies one epoch, not a uniform accuracy bound over arbitrary dates. `MoonPosition.position` supplies a geocentric geometric lunar place in a mean ecliptic frame; apparent coordinates, an observer's position, parallax, light-time conventions, and atmospheric effects are separate reductions. For a dated lunar-phase event, `nearestLunarPhase` in `src/astronomy/bodies/moon.ts` is a different API.

## Related topics

- [ELP/MPP02 Lunar Theory]({% link astronomy/elp-mpp02-lunar-theory.md %}) provides a different geocentric state model with velocity.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) explains the numeric TT JDE input.
- [Meeus Coordinate Transforms]({% link astronomy/meeus-coordinate-transforms.md %}) converts between spherical coordinate systems when the matching frame is supplied.
