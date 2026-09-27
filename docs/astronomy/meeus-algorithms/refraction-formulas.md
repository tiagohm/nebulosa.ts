---
title: Meeus Refraction Formulas
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 120
description: Applies chapter-style scalar atmospheric-refraction corrections to true or apparent altitude.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Refraction
---

# Meeus Refraction Formulas

`Refraction` implements the scalar altitude corrections in Meeus chapter 16. Use these formulas for a quick chapter-style refraction estimate when an altitude is already known. They assume **1010 mbar**, **10 °C**, and yellow light; this namespace does not take weather or wavelength parameters. Inputs and returned corrections are **radians**.

## Basic usage

```ts
import { Refraction } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const apparentAltitude = deg(10);
const trueAltitudeEstimate = apparentAltitude - Refraction.bennett2(apparentAltitude);

const trueAltitude = deg(10);
const apparentAltitudeEstimate = trueAltitude + Refraction.saemundsson(trueAltitude);
console.log(trueAltitudeEstimate, apparentAltitudeEstimate);
```

Each function returns a **correction angle**, not the corrected altitude. The input's meaning determines the sign of the operation:

| Function          | Input altitude                      | Apply the returned correction                                              |
| ----------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| `bennett(h0)`     | Apparent                            | `true = apparent − correction`                                             |
| `bennett2(h0)`    | Apparent                            | `true = apparent − correction`; adds the chapter's adjustment to `bennett` |
| `gt15True(h0)`    | Apparent, above 15°                 | `true = apparent − correction`                                             |
| `saemundsson(h)`  | True, without refraction            | `apparent = true + correction`                                             |
| `gt15Apparent(h)` | True, without refraction, above 15° | `apparent = true + correction`                                             |

`gt15True` and `gt15Apparent` use short tangent polynomials for altitudes greater than **15°**. `bennett` and `bennett2` evaluate a tangent of an altitude-dependent expression; `saemundsson` uses a related expression for the opposite direction of conversion. These are separate approximations, so applying one forward and a different one backward is not an exact inverse operation.

## Accuracy and limits

The formulas are empirical chapter approximations for the stated standard atmosphere, not measurements of local conditions. The local test checks `bennett` near an apparent altitude of 0.5° and `bennett2` at the zenith; it does not establish a uniform error bound. The tangent expressions are not bounded for arbitrary input angles, and the implementations do not clamp output to zero at the zenith. Near and below the horizon, real refraction depends strongly on atmospheric structure; interpret these results as model corrections.

For configurable pressure, temperature, humidity, and wavelength, use [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}). For a complete observer-based stellar coordinate reduction, use [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}); that path uses a different refraction model.
