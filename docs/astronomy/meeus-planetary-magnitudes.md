---
title: Meeus Planetary Magnitudes
layout: default
parent: Astronomy
nav_order: 450
description: Estimates visual planetary magnitudes from scalar distances, phase angle, and optional Saturn-ring geometry using Meeus chapter formulas.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Illuminated
---

# Meeus Planetary Magnitudes

The magnitude functions on `Illuminated` estimate a planet's **visual magnitude** from scalar geometry using the formulas collected in Meeus chapter 41. Use them when heliocentric and geocentric distances, and any required phase or ring angles, are already available. These are empirical brightness formulas; a smaller magnitude means a brighter modeled object.

## Basic usage

```ts
import { Illuminated } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const venusMagnitude = Illuminated.venus(0.724604, 0.910947, deg(72.96));
const venusMagnitude84 = Illuminated.venus84(0.724604, 0.910947, deg(72.96));
const saturnMagnitude = Illuminated.saturn(9.867882, 10.464606, deg(16.442), deg(4.198));
console.log(venusMagnitude, venusMagnitude84, saturnMagnitude);
```

The Venus inputs produce about `−3.8` with `venus` and `−4.2` with `venus84`; the Saturn example produces about `+0.9`. These are different formula families, so the outputs need not agree. The functions return a numeric magnitude, not a flux, color, or magnitude uncertainty.

## Inputs and formula families

All functions take `r`, the **planet–Sun distance in AU**, followed by `delta`, the **planet–Earth distance in AU**. Both must be positive because every formula includes `5 log₁₀(r × delta)`. The remaining inputs are angles in **radians**; the implementations convert phase and longitude difference to degrees inside their empirical polynomials.

| Inputs after `r, delta`                                    | Earlier Meeus functions        | 1984 Astronomical Almanac functions           |
| ---------------------------------------------------------- | ------------------------------ | --------------------------------------------- |
| Phase angle `i`                                            | `mercury`, `venus`, `mars`     | `mercury84`, `venus84`, `mars84`, `jupiter84` |
| Saturn ring latitude `B` and longitude difference `deltaU` | `saturn`                       | `saturn84`                                    |
| None                                                       | `jupiter`, `uranus`, `neptune` | `uranus84`, `neptune84`, `pluto84`            |

The earlier functions implement the G. Müller formulas identified in the code. The `*84` functions use the formulas adopted in the **1984 Astronomical Almanac**. Jupiter's earlier formula has no phase term, whereas `jupiter84` accepts and uses `i`. Both Saturn formulas use the Earth latitude `B` relative to the ring plane and the Sun–Earth Saturnicentric longitude difference `deltaU`; they do not take the Sun's ring-plane latitude. `pluto84` is present in the later family even though there is no earlier `pluto` function.

For Saturn, `SaturnRing.ring(jde)` supplies `B` and `deltaU` as the **first and third** elements of its result at a numeric TT JDE. Its `ub(jde)` helper returns `[deltaU, B]`, in that order, so pass those values to `saturn` or `saturn84` as `B, deltaU`. The magnitude functions themselves evaluate only their scalar arguments; they do not call `SaturnRing` or an ephemeris. Supply distances and ring geometry for a consistent event time.

## Accuracy and limits

These are historical empirical visual-magnitude relations. The implementation does not provide an accuracy interval, observational error model, or wavelength-specific flux. The older and `*84` formulas have different coefficients and, for Jupiter, different input contracts. They are a separate model from the vector-based **Mallama and Hilton** planetary apparent-magnitude calculations elsewhere in the library; do not mix their outputs as if they shared one calibration.

For a phase angle or illuminated fraction from scalar geometry, see [Meeus Illuminated Fraction]({% link astronomy/meeus-illuminated-fraction.md %}). The phase angle is in radians when passed here; its illuminated fraction is a different, dimensionless quantity.

## Related topics

- [Meeus Illuminated Fraction]({% link astronomy/meeus-illuminated-fraction.md %}) supplies the phase angle used by several magnitude formulas.
- [Meeus Geocentric Planet Positions]({% link astronomy/meeus-geocentric-planet-positions.md %}) describes one source of heliocentric planetary coordinates.
