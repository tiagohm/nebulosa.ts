---
title: Differential Refraction and Atmospheric Dispersion
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 130
description: Compares refraction at two wavelengths and reports the resulting angular and optional pixel displacement.

doc_kind: topic

sources:
    - src/astronomy/coordinates/refraction.ts

api:
    - differentialRefraction
    - atmosphericDispersion
    - AtmosphericDispersion
---

# Differential Refraction and Atmospheric Dispersion

Atmospheric refraction varies with wavelength, separating colors along the direction toward the zenith. `differentialRefraction` returns a **signed** angular difference between two wavelengths. `atmosphericDispersion` returns its nonnegative size and can add a sky position angle or a length in image pixels.

## Basic usage

```ts
import { atmosphericDispersion, differentialRefraction } from '../src/astronomy/coordinates/refraction';
import { deg, toArcsec } from '../src/math/units/angle';

const apparentAltitude = deg(25);
const blueMicrons = 0.45;
const redMicrons = 0.65;

const signed = differentialRefraction(apparentAltitude, blueMicrons, redMicrons);
const dispersion = atmosphericDispersion(apparentAltitude, blueMicrons, redMicrons, {
	hourAngle: deg(20), // west-positive
	declination: deg(-10),
	latitude: deg(-23.5),
	arcsecPerPixel: 1.5,
});

if (signed !== undefined && dispersion !== undefined) {
	console.log(toArcsec(signed), dispersion.arcseconds, dispersion.positionAngle, dispersion.pixels);
}
```

All wavelengths are in micrometers and `altitude` is the **apparent** altitude in radians. Both functions accept optional atmospheric `RefractionConditions`: pressure in hPa, temperature in °C, and relative humidity as a fraction. Omitted values use the same defaults as [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}).

## Difference and direction

`differentialRefraction(altitude, wavelengthAMicrons, wavelengthBMicrons, conditions?)` computes `R(A) − R(B)`, where `R` is the apparent-minus-true angular displacement at that wavelength. Swapping `A` and `B` reverses the sign. In the optical example, blue light is lifted more than red light, so blue minus red is positive. The returned angle is in radians.

`atmosphericDispersion(altitude, blueMicrons, redMicrons, conditions?)` sorts the two wavelength values internally, so their argument order does not change its result. The `AtmosphericDispersion` object contains:

| Field           | Meaning                                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `angle`         | Absolute wavelength difference in radians; nonnegative.                                                                            |
| `arcseconds`    | That angular length in arcseconds.                                                                                                 |
| `positionAngle` | Optional signed angle in radians from celestial north toward east to the shorter-wavelength end, along the local zenith direction. |
| `pixels`        | Optional length `arcseconds / arcsecPerPixel` when an image scale is supplied.                                                     |

`positionAngle` is included when **all three** `hourAngle`, `declination`, and `latitude` are supplied. Their angles are radians; hour angle is positive westward and latitude is positive northward. Its value is the library's `parallacticAngle` result and is not normalized into `[0, 2π)`. Supplying only some geometry leaves `positionAngle` absent. Supply a positive `arcsecPerPixel` in arcseconds per pixel to receive `pixels`; it can be supplied independently of the sky geometry. At zero dispersion, a returned position angle has no physical orientation even if the geometry was supplied.

## Model and limits

Both functions subtract two evaluations of the same bounded refraction model; `atmosphericDispersion` adds orientation and unit conversion rather than a separate physical model. They return `undefined` when apparent altitude is at or below the horizon or above the zenith, following `refractiveDisplacement`. At the zenith the dispersion length is zero. Predictions near the horizon depend strongly on local atmospheric conditions despite the model's finite numerical output.

## Related topics

- [Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) defines the single-wavelength model and its sign.
- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) applies atmospheric refraction to a direction at a site.
