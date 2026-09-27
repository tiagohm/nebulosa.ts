---
title: Alt-Az Field Rotation
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 220
description: Calculates geometric alt-az field-rotation rates, pixel-smear exposure limits, and derotator angles.

doc_kind: topic

sources:
    - src/astronomy/coordinates/field.ts

api:
    - FieldRotation
    - DerotatorSample
    - fieldRotationRate
    - fieldRotation
    - derotatorAngle
    - derotatorTrack
---

# Alt-Az Field Rotation

An alt-az mount changes a fixed target's orientation on the sensor as the sky tracks. `fieldRotationRate` gives the signed geometric rate, `fieldRotation` can turn it into an exposure limit for a pixel-smear budget, and `derotatorAngle` or `derotatorTrack` gives a mechanical angle that cancels the parallactic rotation. These functions calculate angles; they do not move a rotator or mount.

## Basic usage

```ts
import { derotatorAngle, derotatorTrack, fieldRotation } from '../src/astronomy/coordinates/field';
import { deg, hour } from '../src/math/units/angle';

const latitude = deg(-23.55);
const rotation = fieldRotation(latitude, deg(0), deg(45), 1, 1000);
if (rotation !== undefined) {
	console.log(rotation.radiansPerSecond, rotation.maxExposureSeconds);
}

const hourAngle = hour(2); // west-positive
const declination = deg(-20);
const command = derotatorAngle(hourAngle, declination, latitude);
const schedule = derotatorTrack(hourAngle, declination, latitude, 3600, 600);
console.log(command, schedule);
```

Latitude, azimuth, altitude, hour angle, declination, and rotator angles are **radians**. Latitude is north-positive; azimuth runs from north through east; altitude is above the local horizon. Hour angle is west-positive, `LST − RA`. The rate is **radians per SI second**, and the schedule's time fields are seconds.

## Rate and exposure limit

For sidereal tracking, the rate follows the library's parallactic-angle convention:

```text
field rate = −dq/dt = Ω cos(latitude) cos(azimuth) / cos(altitude)
```

Here `q` is `parallacticAngle` and `Ω` is the library's `SIDEREAL_DRIFT_RATE`. The sign is positive toward the northern side of the sky and negative toward the southern side for ordinary altitudes. `fieldRotationRate(latitude, azimuth, altitude)` returns the signed rate. It returns `undefined` when `|cos(altitude)| ≤ 10⁻¹²`, where the zenith denominator is singular. Away from that singularity, an exact east/west azimuth or geographic pole returns zero, allowing for floating-point cosine noise near those values.

`fieldRotation` returns `undefined` at that same singularity. Otherwise its `FieldRotation` includes `radiansPerSecond` and `radiansPerMinute` (`60 ×` the second rate). Supply **both** `smearLimitPixels` and `radiusPixels` to receive `maxExposureSeconds`, where `radiusPixels` is the distance from the rotation center to the sensor point to protect, often a corner. The calculation is `|smearLimitPixels| / (|rate| × |radiusPixels|)` seconds. If the rate or radius is zero, the limit is `Infinity`; if either pixel argument is omitted, the field is absent. This is a small-rotation geometric smear estimate, not a full image-trailing model.

## Derotator commands

`derotatorAngle(hourAngle, declination, latitude, mechanicalOffset = 0)` returns `normalizePI(mechanicalOffset − parallacticAngle(...))` in **(−π, π]**. The offset combines the rotator zero and a fixed sky position angle to retain. At the exact zenith, parallactic orientation is physically undefined even though the underlying `parallacticAngle` helper returns a finite convention; do not interpret a command there as a uniquely defined sky angle.

`derotatorTrack(hourAngle, declination, latitude, durationSeconds, stepSeconds, mechanicalOffset = 0)` samples that command while advancing hour angle by `SIDEREAL_DRIFT_RATE × seconds`. It includes time zero and the requested endpoint; the endpoint need not fall on the uniform step grid. Declination and the target's own motion are held fixed. For a positive duration, `stepSeconds` must be positive and finite, and a conservative sample-count estimate above **100,000** throws `RangeError` before allocation. A zero or negative duration returns the single time-zero sample. Each `DerotatorSample` has `{ seconds, angle }`; its angle is normalized independently, so the numerical sequence can jump across the ±π wrap even when the physical motion is continuous.

## Related topics

- [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) defines the azimuth, altitude, and hour-angle conventions.
- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) provides local observed target angles when topocentric effects matter.
