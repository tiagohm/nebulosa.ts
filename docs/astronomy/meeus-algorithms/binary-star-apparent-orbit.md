---
title: Meeus Binary-star apparent orbit
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 370
description: Projects Meeus visual-binary orbital elements to a sky position angle, separation, and apparent eccentricity.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - BinaryStars
---

# Meeus Binary-star apparent orbit

`BinaryStars` projects the Keplerian orbit of a visual double star onto the sky using the geometry in Meeus chapter 57. Given orbital elements and an **eccentric anomaly**, it returns the companion's position angle and angular separation from the primary. Use it for a visual-binary ephemeris when the supplied elements already share the desired sky reference frame and epoch.

## Basic usage

```ts
import { BinaryStars, Kepler } from '../src/astronomy/ephemeris/meeus';
import { deg, toDeg } from '../src/math/units/angle';

const eccentricity = 0.2763;
const meanAnomaly = BinaryStars.meanAnomaly(1980, 1934.008, 41.623);
const eccentricAnomaly = Kepler.kepler1(eccentricity, meanAnomaly, 6);
const [positionAngle, separation] = BinaryStars.position(0.907, eccentricity, deg(59.025), deg(23.717), deg(219.907), eccentricAnomaly);
console.log(toDeg(positionAngle), separation);
```

For these chapter 57 elements, the result is about **318.4°** and **0.411″**. The supplied semimajor axis `0.907` is in arcseconds, so the separation has that unit too. `Kepler.kepler1` supplies the eccentric anomaly; passing the mean anomaly directly to `position` changes the projected orbit.

## Element and result conventions

| Input or result      | Meaning                                                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `year`, `T`, `P`     | Observation and periastron epochs as **decimal years**; period `P` in **mean solar years**.                                              |
| `a`                  | True-orbit angular semimajor axis; its unit is carried through to the returned separation.                                               |
| `e`                  | Dimensionless elliptic eccentricity, with `0 ≤ e < 1`.                                                                                   |
| `i`, `ascendingNode` | Orbital inclination and position angle of the ascending node, in **radians**.                                                            |
| `periastron`, `E`    | Argument of periastron and **eccentric anomaly**, in **radians**.                                                                        |
| `position()` result  | Fresh `[position angle, separation]`; angle in **radians** from north through east, separation in the same angular unit supplied as `a`. |

`meanAnomaly(year, T, P)` evaluates `2π(year − T)/P` and wraps it to `[0, 2π)`. `position` projects the orbital radius `a(1 − e cos E)` using the inclination and orbital angles. It adds `2π` if its calculated position angle is negative, but does not wrap a value above `2π`; normalize that result when a strict `[0, 2π)` output is needed. `apparentEccentricity(e, i, periastron)` returns the dimensionless eccentricity of the projected ellipse; it does not use `a` or the node angle.

## Model and limits

The projection uses the elements as supplied. It does not propagate the element frame by precession, account for light travel time, or fit an orbit from measured positions. It is an elliptic geometric model; the caller supplies suitable elements and solves Kepler's equation for each requested year. The `position` return is computed afresh as a two-element tuple.

## Related topics

- [Meeus Keplerian Elements]({% link astronomy/meeus-algorithms/keplerian-elements.md %}) covers eccentric-anomaly solvers used before projection.
- [Stellar magnitude arithmetic]({% link astronomy/meeus-algorithms/stellar-magnitude-arithmetic.md %}) combines brightness from unresolved visual companions.
