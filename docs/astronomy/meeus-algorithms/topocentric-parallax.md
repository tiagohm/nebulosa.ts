---
title: Meeus Topocentric Parallax
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 110
description: Converts a geocentric Meeus body position to an observer-centered position using Earth parallax factors.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Parallax
---

# Meeus Topocentric Parallax

`Parallax` applies the Meeus chapter 40 shift from an Earth-centered direction to a surface observer's direction. Use it for a nearby body such as the Moon or a planet when its geocentric coordinates, distance, and observing site are already available. The formulas use the chapter's reference equatorial solar horizontal parallax of **8.794 arcseconds** (`HOR_PAR`).

## Basic usage

```ts
import { Globe, Parallax } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const jd = 2451545.0; // numeric UT Julian day for the Meeus sidereal formula
const [rhoSinPhiPrime, rhoCosPhiPrime] = Globe.EARTH76.parallaxConstants(deg(30), 0);
const [ra, dec] = Parallax.topocentric(deg(120), deg(10), 0.4, rhoSinPhiPrime, rhoCosPhiPrime, deg(70), jd);
console.log(ra, dec);
```

The example uses **west-positive** observer longitude and north-positive geodetic latitude. `Globe.EARTH76.parallaxConstants(latitude, height)` supplies the dimensionless geocentric observer components `[ρ sin φ′, ρ cos φ′]`; the height is in **AU** above that ellipsoid. Supply both factors, not the latitude alone, to the equatorial functions. Their body distance is in **AU**, and all angular inputs and outputs are in **radians**.

## Equatorial results

| Function                                                               | Result                                                                                                                                             |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `horizontal(distance)`                                                 | Equatorial horizontal parallax `asin(sin(HOR_PAR) / distance)` in radians.                                                                         |
| `topocentric(ra, dec, distance, rhoSinPhi, rhoCosPhi, longitude, jd)`  | Fresh `[topocentric RA, topocentric Dec]` in radians. RA follows the input branch plus its correction; it is not wrapped by this function.         |
| `topocentric2(ra, dec, distance, rhoSinPhi, rhoCosPhi, longitude, jd)` | Fresh approximate `[ΔRA, ΔDec]` in radians, to add to the geocentric coordinates. This returns **corrections**, rather than corrected coordinates. |
| `topocentric3(ra, dec, distance, rhoSinPhi, rhoCosPhi, longitude, jd)` | Fresh `[topocentric hour angle, topocentric Dec]` in radians; its first component is **not RA**.                                                   |

These functions form local hour angle from the chapter's **Greenwich apparent sidereal time**: `H = apparent sidereal angle − west longitude − geocentric RA`. The `jd` argument is the numeric **UT Julian day** used by `Sidereal.apparent`; that routine evaluates its nutation term at the same numeric JD rather than converting it separately to TT. Supply geocentric coordinates for the corresponding epoch and apparent sidereal convention. `topocentric2` uses the chapter's small-parallax approximation, while `topocentric` and `topocentric3` use the trigonometric shift.

## Ecliptic position and semidiameter

`topocentricEcliptical(longitude, latitude, semidiameter, phi, height, epsilon, theta, pi)` returns fresh `[topocentric ecliptic longitude, latitude, semidiameter]` in radians. The input ecliptic longitude and latitude and the geocentric semidiameter refer to the body; `phi` is geodetic latitude, `height` is AU above `Globe.EARTH76`, `epsilon` is ecliptic obliquity, `theta` is the local sidereal **angle** in radians, and `pi` is the body's equatorial horizontal parallax in radians. This function obtains the observer factors from `Globe.EARTH76` internally. Its returned longitude is wrapped to `[0, 2π)`.

## Accuracy and limits

The equatorial path uses the supplied observer factors and chapter sidereal formula; the ecliptic path calculates its factors from `EARTH76`. `topocentric2` is a first-order correction and divides its RA term by cos(declination), so it is unsuitable near the celestial poles. These formulas shift a supplied geocentric place by parallax; they do not themselves calculate a body's ephemeris or atmospheric refraction. `horizontal` requires a distance for which its inverse-sine argument is in the real domain. The implementation does not establish a uniform positional error bound.

For a `Time`-based observer and frame-aware observed coordinates, use [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) and [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}).

## Related topics

- [Meeus Globe Ellipsoid]({% link astronomy/meeus-algorithms/globe-ellipsoid.md %}) defines `EARTH76` and the dimensionless parallax factors.
- [Meeus Sidereal Time]({% link astronomy/meeus-algorithms/sidereal-time.md %}) defines the numeric-JD sidereal angle used here.
