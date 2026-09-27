---
title: Meeus Illuminated Fraction
layout: default
parent: Astronomy
nav_order: 440
description: Computes a planet's phase angle and illuminated disk fraction from distances or positions, with a date-only Venus approximation.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Illuminated
---

# Meeus Illuminated Fraction

`Illuminated` calculates the Sun–planet–Earth phase angle and the fraction of a planet's apparent disk that is lit. Use its distance or coordinate forms when those quantities are already available, or its date-only Venus approximation for a chapter-style estimate. The angles are **radians**, distances are **AU**, and disk fractions are dimensionless values from `0` to `1`.

## Basic usage

```ts
import { Base, Illuminated } from '../src/astronomy/ephemeris/meeus';

const planetSunAU = 0.724604;
const planetEarthAU = 0.910947;
const sunEarthAU = 0.983824;
const phase = Illuminated.phaseAngle(planetSunAU, planetEarthAU, sunEarthAU);
const litFraction = Illuminated.fraction(planetSunAU, planetEarthAU, sunEarthAU);
const sameFractionFromPhase = Base.illuminated(phase);
console.log(phase, litFraction, sameFractionFromPhase);
```

For this Meeus chapter 41 example, `cos(phase)` is about `0.29312` and the lit fraction is about `0.64656`. A phase angle of `0` means the observer sees the fully lit face; `π` means the dark face. `Base.illuminated(i)` implements `(1 + cos(i)) / 2` for a phase angle in radians. `Illuminated.fraction` calculates the same physical fraction directly from the three side lengths and clamps the numeric result to `[0, 1]`.

## Inputs for the phase angle

| Function                              | Inputs                                                                                                                                                                                               | Result                          |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `phaseAngle(r, delta, R)`             | Planet–Sun distance `r`, planet–Earth distance `delta`, Sun–Earth distance `R`; all AU                                                                                                               | Phase angle in `[0, π]` radians |
| `phaseAngle2(L, B, R, L0, R0, delta)` | Planet heliocentric ecliptic longitude and latitude `L`, `B` in radians, its radius `R` in AU; Earth heliocentric longitude `L0` in radians and radius `R0` in AU; geocentric distance `delta` in AU | Phase angle in `[0, π]` radians |
| `phaseAngle3(L, B, x, y, z, delta)`   | Planet heliocentric ecliptic angles `L`, `B` in radians; geocentric Cartesian vector `(x, y, z)` and its norm `delta` in AU, in the same ecliptic frame                                              | Phase angle in `[0, π]` radians |

The coordinate forms use the supplied geometric quantities; they do not fetch an ephemeris. Keep heliocentric and geocentric inputs at a consistent epoch and in a common ecliptic frame. The inverse-cosine arguments are clamped to `[-1, 1]` to absorb alignment roundoff. The distance form and direct fraction require nonzero positive planet–Sun and planet–Earth distances.

## Venus estimate and illuminated limb

`Illuminated.fractionVenus(jde)` returns a Venus lit fraction using a chapter approximation from a numeric **TT Julian ephemeris day**. It derives a simplified Sun–Earth–Venus triangle from time-dependent angles and fixed constants; it does not use a caller-supplied Venus position. The chapter test gives about `0.64` at JDE `2448976.5`. Use a consistent ephemeris and the distance or coordinate forms when its modeled geometry matters.

`Base.limb(bodyRA, bodyDec, sunRA, sunDec)` returns the **position angle of the midpoint of the bright limb**, normalized to `[0, 2π)` radians. All four arguments are equatorial angles in radians in the same frame. The angle points from the body's disk center toward the Sun's projected direction: for a body at `(RA, Dec) = (0, 0)` and a Sun a little farther in right ascension on the equator, it is `+π/2`. If the two apparent directions coincide, the bright-limb direction is geometrically undefined.

## Accuracy and limits

These formulas describe geometric illumination from supplied directions or distances. They do not model atmosphere, surface scattering, limb darkening, or an observer's local horizon. `fractionVenus` is a date-only approximation, and the implementation provides no accuracy bound for it. The apparent visual magnitude of a planet is a separate calculation with additional empirical terms.

## Related topics

- [Meeus Numerical Helpers]({% link astronomy/meeus-numerical-helpers.md %}) introduces the shared `Base.illuminated` and `Base.limb` helpers.
- [Meeus Geocentric Planet Positions]({% link astronomy/meeus-geocentric-planet-positions.md %}) describes a source of heliocentric planetary coordinates.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) covers numeric TT JDE and calendar labels.
