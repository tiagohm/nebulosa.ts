---
title: Telescope Optical Estimates
layout: default
parent: Imaging
nav_order: 10
description: Estimates magnification, resolving limits, light collection, exit pupil, and eyepiece field from telescope dimensions.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - EyepieceView
    - magnification
    - focalLength
    - focalRatio
    - dawesLimit
    - rayleighLimit
    - limitingMagnitude
    - lightGraspRatio
    - exitPupil
    - exitPupilFromApertureAndMagnification
    - exitPupilFromEyepieceAndFocalRatio
    - eyepieceTrueFovViaFieldStop
    - effectiveApertureWithObstruction
    - obstructionRatio
    - eyepieceView
---

# Telescope Optical Estimates

These first-order formulas compare telescope apertures, focal lengths, and eyepieces for visual planning. Use them to estimate magnification, nominal angular resolving limits, collecting area ratios, and exit pupil before choosing equipment. They do not simulate aberrations, atmospheric seeing, or throughput.

## Basic usage

```ts
import { dawesLimit, eyepieceView, focalRatio, rayleighLimit } from '../src/astronomy/formulas';

const apertureMm = 200;
const telescopeFocalLengthMm = 1000;
const fNumber = focalRatio(telescopeFocalLengthMm, apertureMm);
const visual = eyepieceView(telescopeFocalLengthMm, apertureMm, 10, 50);
const dawesArcsec = dawesLimit(apertureMm);
const rayleighArcsec = rayleighLimit(apertureMm);
console.log({ fNumber, visual, dawesArcsec, rayleighArcsec });
```

For this telescope and eyepiece, the code returns `fNumber = 5`, `visual = { magnification: 100, trueFieldOfViewDegrees: 0.5, exitPupilMm: 2 }`, `dawesArcsec = 0.58`, and `rayleighArcsec = 0.69`. These values are asserted in the current formula tests. The resolving limits are arcseconds; `trueFieldOfViewDegrees` is degrees. Other lengths in this example are millimeters.

## Formula contracts

| Function                                                                  | Formula and result                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `focalLength(apertureMm, focalRatio)`                                     | Aperture × f-number → focal length in millimeters.                              |
| `focalRatio(focalLengthMm, apertureMm)`                                   | Focal length / aperture → dimensionless f-number.                               |
| `magnification(telescopeFocalLengthMm, eyepieceFocalLengthMm)`            | Telescope / eyepiece focal length → dimensionless visual power.                 |
| `dawesLimit(apertureMm)`                                                  | `116 / apertureMm` → approximate arcseconds.                                    |
| `rayleighLimit(apertureMm)`                                               | `138 / apertureMm` → approximate arcseconds.                                    |
| `limitingMagnitude(apertureMm)`                                           | `2.7 + 5 log₁₀(apertureMm)` → approximate stellar magnitude.                    |
| `lightGraspRatio(largerApertureMm, smallerApertureMm)`                    | Squared aperture ratio → relative collecting area.                              |
| `effectiveApertureWithObstruction(apertureDiameter, obstructionDiameter)` | `√(D² − d²)` → area-equivalent unobstructed diameter, in the input length unit. |
| `obstructionRatio(apertureDiameter, obstructionDiameter)`                 | `100 d / D` → linear obstruction as a percentage of aperture diameter.          |

Use positive physical lengths and ratios. `lightGraspRatio` throws `RangeError` if its first aperture is smaller than its second. `effectiveApertureWithObstruction` requires an obstruction diameter smaller than the aperture; `obstructionRatio` permits equality but rejects a larger obstruction. Both throw `RangeError` when their ordering condition fails. The effective aperture formula accounts for blocked **area**, not the obstruction's effect on diffraction or contrast.

## Eyepieces and exit pupil

`exitPupil(lengthMm, divisor)` is numerically `lengthMm / divisor`. Its two TypeScript call shapes express either `apertureDiameterMm / magnification` or `eyepieceFocalLengthMm / focalRatio`; the runtime uses the same division for both. Use `exitPupilFromApertureAndMagnification` or `exitPupilFromEyepieceAndFocalRatio` when the intended inputs should be explicit. The result is a pupil diameter in the first argument's length unit, normally millimeters.

`eyepieceView(telescopeFocalLengthMm, apertureMm, eyepieceFocalLengthMm, apparentFieldOfViewDegrees)` returns `EyepieceView` with dimensionless `magnification`, `trueFieldOfViewDegrees`, and `exitPupilMm`. It estimates true field as apparent field divided by magnification and pupil as aperture divided by magnification. Its field estimate does not use the eyepiece field-stop diameter.

If the field-stop diameter is known, `eyepieceTrueFovViaFieldStop(fieldStopDiameterMm, telescopeFocalLengthMm)` provides a separate small-angle estimate in **degrees**, using `RAD2DEG × fieldStopDiameterMm / telescopeFocalLengthMm`.

## Limits

Dawes and Rayleigh limits are idealized resolution estimates, not measured image sharpness. The limiting-magnitude and apparent-field formulas are planning heuristics; sky brightness, transmission, observer, target spectrum, and optical design can change real performance. The functions evaluate their formulas on supplied numbers; callers must use physically meaningful positive inputs.
