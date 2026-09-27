---
title: Meeus Precession
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 70
description: Precesses chapter-style equatorial, ecliptic, and orbital-element coordinates between Julian epochs.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Precession
    - ElementEquinox
    - EquinoxOrbitalElements
---

# Meeus Precession

`Precession` applies the Meeus chapter 21 polynomial rotations between **Julian epochs**. Use it to reproduce a chapter calculation for equatorial or ecliptic angles, optionally including supplied proper motion. `ElementEquinox` provides the chapter 24 reductions of orbital-plane elements from B1950 to J2000. These are angle calculations, not a `Time` or Cartesian-frame transformation.

## Basic usage

```ts
import { ElementEquinox, Precession } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const equatorial = new Precession.Precessor(2000, 2050);
const [ra2050, dec2050] = equatorial.precess(deg(120), deg(20));
const ecliptic = new Precession.EclipticPrecessor(2000, 2050);
const [longitude2050, latitude2050] = ecliptic.precess(deg(120), deg(5));
const [inclination, node, perihelionArgument] = ElementEquinox.reduceB1950ToJ2000([deg(11.93911), deg(334.04096), deg(186.24444)]);
console.log(ra2050, dec2050, longitude2050, latitude2050, inclination, node, perihelionArgument);
```

Constructor epochs are **Julian years**, such as `2000` and `2050`, rather than Julian day numbers. Use `Base.jdeToJulianYear(jde)` when starting from a Julian ephemeris day. Input and output sky angles are **radians**. `Precessor.precess(RA, Dec)` rotates equatorial coordinates between the constructor epochs; `EclipticPrecessor.precess(longitude, latitude)` rotates ecliptic coordinates. They allocate new angle arrays and do **not** normalize the returned RA or longitude to `[0, 2π)`.

## Proper motion and orbital elements

`Precession.position(precessor, RA, Dec, pmRA, pmDEC)` first advances the angles by `epochTo − epochFrom` times the supplied proper motions, then applies the precession rotation. `pmRA` and `pmDEC` are **radians per Julian year**; `pmRA` is a change in the RA coordinate, without a `cos(Dec)` factor. `eclipticPosition` similarly supports equatorial proper-motion rates, converting them to ecliptic angular rates at the source epoch before precessing. Its rates default to zero.

`properMotion3D(RA, Dec, epochFrom, epochTo, distance, radialRate, pmRA, pmDEC)` propagates a three-dimensional position using **parsecs** for distance and **parsecs per year** for radial rate. It returns new equatorial angles after that motion, without applying a precession rotation. The caller must keep the position and rate in a consistent reference frame; distance must be nonzero for the radial term.

`EclipticPrecessor.reduceElements([inclination, node, perihelionArgument])` rotates orbital elements between its constructor epochs. `ElementEquinox.reduceB1950ToJ2000` and `reduceB1950FK4ToJ2000FK5` apply their specific B1950-to-J2000 reductions. Each accepts and returns `[inclination, ascendingNodeLongitude, perihelionArgument]` in **radians**, allocating a new tuple. The two named reductions normalize node and perihelion argument to `[0, 2π)` and return inclination in `[0, π]`. The FK4-to-FK5 variant includes the reference-system change named in its API.

## Accuracy and limits

`approxAnnualPrecession` and `approxPosition` are first-order shortcuts for epochs within a few hundred years and directions away from the equatorial poles; the former returns annual RA and Dec changes in **radians per year**. Their tangent-based RA term becomes unsuitable near a pole. The full `Precessor` and `EclipticPrecessor` evaluate polynomial rotations and keep declination or latitude finite near the poles, but the corresponding longitude or RA is geometrically undefined exactly at a pole. `Precession.properMotion` also divides by the cosine of ecliptic latitude and should not be used at an ecliptic pole.

The Meeus polynomial path has no verified implementation-level error bound for arbitrary epochs. For reference-frame work that needs the library's current IAU model and time providers, use the celestial frame functions instead.

## Related topics

- [Precession, Nutation, and Obliquity]({% link astronomy/time-and-earth-orientation/precession-nutation-and-obliquity.md %}) describes the library's date-dependent celestial orientation.
- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) rotates Cartesian vectors and states between reference frames.
- [Meeus Coordinate Transforms]({% link astronomy/meeus-algorithms/coordinate-transforms.md %}) converts spherical angles within a supplied equator or ecliptic.
