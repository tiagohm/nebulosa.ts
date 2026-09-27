---
title: Equatorial Mount Geometric Pointing Errors
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 210
description: Applies six geometric equatorial mount terms and a separate gravity-driven tube-flexure offset.

doc_kind: topic

sources:
    - src/astronomy/coordinates/pointing.ts

api:
    - EquatorialPointingModel
    - IDENTITY_EQUATORIAL_POINTING_MODEL
    - MAX_POINTING_DECLINATION
    - polarAlignmentPointingModel
    - isIdentityEquatorialPointingModel
    - equatorialPointingError
    - applyEquatorialPointingError
    - tubeFlexureError
    - applyTubeFlexureError
---

# Equatorial Mount Geometric Pointing Errors

This model maps an equatorial mount's mechanical hour angle and declination to the direction its optical axis points. It combines six TPoint-style geometric terms and offers a separate tube-flexure correction. Use it with known coefficients to predict a pointing offset; these functions do not fit coefficients from measurements or command a mount.

## Basic usage

```ts
import { applyEquatorialPointingError, applyTubeFlexureError, equatorialPointingError, IDENTITY_EQUATORIAL_POINTING_MODEL, polarAlignmentPointingModel } from '../src/astronomy/coordinates/pointing';
import { arcsec, deg, hour } from '../src/math/units/angle';

const model = {
	...IDENTITY_EQUATORIAL_POINTING_MODEL,
	indexHourAngle: arcsec(30),
	coneError: arcsec(10),
};
const lst = hour(7);
const ra = hour(5);
const dec = deg(30);
const [deltaHourAngle, deltaDeclination] = equatorialPointingError(lst - ra, dec, model);
const [pointedRa, pointedDec] = applyEquatorialPointingError(ra, dec, lst, model);

const polarModel = polarAlignmentPointingModel(arcsec(60), arcsec(30), deg(45));
const [flexedRa, flexedDec] = applyTubeFlexureError(pointedRa, pointedDec, lst, deg(45), arcsec(20));
console.log(deltaHourAngle, deltaDeclination, polarModel, flexedRa, flexedDec);
```

All input angles, coefficients, errors, and output coordinates are **radians**. Hour angle is west-positive, `H = LST − RA`. The returned pair from `equatorialPointingError(H, δ, model)` is `[ΔH, Δδ]`, the error added to the mechanical orientation. Away from the poles, `applyEquatorialPointingError` returns `[normalizeAngle(RA − ΔH), δ + Δδ]`: positive hour-angle error decreases right ascension, while positive declination error increases declination.

## Six geometric terms

For a model with coefficients `IH`, `ID`, `CH`, `NP`, `MA`, and `ME`, the implementation evaluates:

```text
ΔH = IH + CH sec δ + NP tan δ − MA cos H tan δ + ME sin H tan δ
Δδ = ID + MA sin H + ME cos H
```

| Property                  | Term | Geometric meaning                                                                            |
| ------------------------- | ---- | -------------------------------------------------------------------------------------------- |
| `indexHourAngle`          | IH   | Constant hour-angle index offset.                                                            |
| `indexDeclination`        | ID   | Constant declination index offset.                                                           |
| `coneError`               | CH   | Optical-axis collimation offset; contributes through `sec δ`.                                |
| `axisNonPerpendicularity` | NP   | Mount-axis nonperpendicularity; contributes through `tan δ`.                                 |
| `polarAzimuthError`       | MA   | Horizontal polar-axis misalignment coefficient.                                              |
| `polarAltitudeError`      | ME   | Vertical polar-axis misalignment coefficient, positive for a mount pole below the true pole. |

`IDENTITY_EQUATORIAL_POINTING_MODEL` sets every coefficient to zero, and `isIdentityEquatorialPointingModel` checks for that exact all-zero case. `equatorialPointingError` uses the supplied model as given and needs no site latitude. To construct polar terms from physical adjuster errors, use `polarAlignmentPointingModel(azimuthError, altitudeError, latitude)`, which sets `MA = azimuthError cos φ`, `ME = −altitudeError`, and `IH = azimuthError sin φ`. A **positive** physical altitude error means the mount pole is above the true pole, so it produces a **negative** `polarAltitudeError`; at `H = 0`, this lowers the modeled declination. Add an independent encoder index offset to the returned `IH` if both effects apply.

## Tube flexure and polar behavior

`tubeFlexureError(H, δ, latitude, flexure)` returns a `[ΔH, Δδ]` pair in the same convention. A positive `flexure` is the tube's horizon droop; its magnitude at zenith distance `z` is `flexure · sin z`, directed away from the zenith. The parallactic angle splits that displacement into east and north components. Flexure vanishes at the zenith, and `flexure = 0` returns exactly `[0, 0]`. Apply it with `applyTubeFlexureError(ra, dec, lst, latitude, flexure)`; when combining ordinary offsets away from a pole, account for the order in which the model and flexure are applied.

The `sec δ` and `tan δ` representation becomes singular at a celestial pole. `equatorialPointingError` and `tubeFlexureError` clamp declination inside those terms to `±MAX_POINTING_DECLINATION` (`±89.9°`), keeping their reported error pairs finite. For `|δ| > 89.9°`, the `apply...` functions instead use a great-circle offset so an east/west optical displacement is retained at the pole and a crossing is represented on the opposite meridian. Away from that region, applied right ascension is normalized to `[0, 2π)` and declination is left unwrapped. The two reported `[ΔH, Δδ]` pairs should not be treated as complete on-sky offsets at a pole; use the `apply...` functions there.

The optional `o` tuple on error and apply functions is filled and returned, so it may be reused for repeated evaluations. Without `o`, they allocate a result tuple. The model object is not modified. The calculation is geometric: its accuracy depends on the supplied coefficients and the suitability of this six-term model and simple flexure law for the actual mount.

## Related topics

- [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) defines the hour-angle and altitude conventions used for a site.
- [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) supplies the latitude used to construct polar-alignment terms.
