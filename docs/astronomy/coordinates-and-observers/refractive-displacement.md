---
title: Refractive Displacement
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 120
description: Calculates wavelength-dependent atmospheric refraction and converts between apparent and true altitude.

doc_kind: topic

sources:
    - src/astronomy/coordinates/refraction.ts
    - src/astronomy/coordinates/astrometry.ts

api:
    - refractiveDisplacement
    - RefractionConditions
    - refractedAltitude
    - unrefractedAltitude
---

# Refractive Displacement

`refractiveDisplacement` gives the angular lift of a source at a chosen wavelength when its **apparent altitude** is known. Use `refractedAltitude` to map a true vacuum altitude to an apparent one, or `unrefractedAltitude` for the reverse mapping. These functions share the bounded refraction model used by the observed-place transforms.

## Basic usage

```ts
import { refractedAltitude, unrefractedAltitude } from '../src/astronomy/coordinates/astrometry';
import { refractiveDisplacement } from '../src/astronomy/coordinates/refraction';
import { deg, toArcsec } from '../src/math/units/angle';

const apparentAltitude = deg(10);
const displacement = refractiveDisplacement(apparentAltitude, 0.55);
if (displacement !== undefined) {
	const trueAltitude = apparentAltitude - displacement;
	console.log(toArcsec(displacement), trueAltitude);
}

const trueAltitude = deg(10);
const modeledApparentAltitude = refractedAltitude(trueAltitude, { wl: 0.55 });
const recoveredTrueAltitude = unrefractedAltitude(modeledApparentAltitude, { wl: 0.55 });
```

All altitudes and returned displacements are in radians. `wavelengthMicrons` is the observing wavelength in micrometers; the companion altitude converters pass it as `wl` in their `RefractionParameters` object. Optional `RefractionConditions` override pressure in hPa, temperature in °C, and relative humidity as a fraction from 0 to 1. Omitted values use `1013.25` hPa, `15` °C, and `0.5`; omitted wavelength in the companion converters defaults to `0.55` µm. Pressure zero suppresses the model's refraction.

## Sign and domain

For a valid apparent altitude, the displacement is

```text
apparent altitude − unrefracted altitude
= unrefracted zenith distance − apparent zenith distance.
```

Under ordinary atmospheric conditions it is positive: refraction raises the observed source toward the zenith. At the zenith (`π/2`) it is zero. `refractiveDisplacement` returns `undefined` at or below the apparent horizon (`altitude ≤ 0`) and above the zenith (`altitude > π/2`); those limits are specific to this planning API. The lower-level `unrefractedAltitude` can still invert an apparent altitude just above the horizon to a **negative** true altitude.

`refractedAltitude(trueAltitude, refraction?)` adds the modeled refraction to a true altitude. `unrefractedAltitude(apparentAltitude, refraction?)` uses four fixed-point refinements to invert that mapping. `refractiveDisplacement` computes the inverse at the supplied wavelength and subtracts it from apparent altitude, so its sign follows the same convention. These functions return numbers and do not mutate their inputs.

## Model and limitations

The refraction coefficients come from the ERFA-style two-constant model; the altitude correction uses a bounded form near the horizon instead of letting a raw tangent polynomial grow without limit. At 1° apparent altitude, default conditions and 0.55 µm produce about **646.928 arcseconds** in the implemented model. This is a model value, not a promise of real-sky accuracy near the horizon, where local atmospheric structure matters strongly.

The coefficient calculation selects its optical branch for wavelengths at or below 100 µm and its radio branch above that value. It clamps temperature to `[-150, 200]` °C, pressure to `[0, 10000]` hPa, relative humidity to `[0, 1]`, and wavelength to `[0.1, 1000000]` µm. These limits keep the formula bounded; they do not make extreme conditions physically calibrated.

## Related topics

- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) applies the same refraction model while converting sky directions at a site.

## References

- [ERFA `eraRefco` routine notes](https://github.com/liberfa/erfa/blob/master/src/refco.c) describe the coefficient inputs and optical/radio branches.
- [ERFA `eraAtioq` routine notes](https://github.com/liberfa/erfa/blob/master/src/atioq.c) describe the bounded observed-place refraction correction.
