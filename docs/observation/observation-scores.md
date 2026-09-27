---
title: Observation Scores
layout: default
parent: Observation
nav_order: 10
description: Scores an already-reduced observing target from altitude, airmass, twilight, Moon interference, and available duration.

doc_kind: topic

sources:
    - src/astronomy/planning.ts

api:
    - ObservationScoreInput
    - ObservationScoreOptions
    - moonInterference
    - observationScore
---

# Observation Scores

`observationScore` gives one target a dimensionless suitability score from supplied observing geometry and time. Use it to compare targets after computing their altitude, solar altitude, lunar geometry, and available observing duration. It does not calculate positions or predict weather.

## Basic usage

```ts
import { moonInterference, observationScore } from '../src/astronomy/planning';
import { deg } from '../src/math/units/angle';

const moonPenalty = moonInterference(0.5, deg(20), deg(60));
const score = observationScore(
	{
		altitude: deg(45),
		sunAltitude: deg(-19),
		moonInterference: moonPenalty,
		availableDurationHours: 3,
		requiredDurationHours: 2,
	},
	{ scale: 100 },
);
console.log(score);
```

Angles are radians. The target `altitude` and `sunAltitude` are geometric altitudes. Duration inputs are hours, and the optional airmass is dimensionless. The default result is on `[0, 1]`; `{ scale: 100 }` returns the same score on `[0, 100]`. A higher score means more favorable conditions under the factors supplied by the caller.

## How the factors are combined

The score is the geometric mean of the altitude and airmass factors plus each supplied twilight, Moon, or duration factor. A zero factor makes the result zero. Optional conditions omitted from the input are excluded from the mean; both duration fields must be present for duration to contribute. A high score without a Moon penalty says nothing about moonlight or weather.

| Factor          | Input and default behavior                                                                   | Score                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Target altitude | `altitude` is required; `minimumAltitude` defaults to the horizon and `goodAltitude` to 60°. | Linear ramp from 0 at the minimum to 1 at the good altitude.                                                              |
| Airmass         | Use supplied `airmass`, or derive Kasten–Young airmass from positive altitude.               | 1 at airmass 1, linearly falling to 0 at `maximumAirmass`, which defaults to 3. At or below the horizon, the factor is 0. |
| Twilight        | `sunAltitude` is optional.                                                                   | 0 at or above −12° solar altitude; 1 at or below −18°, with a linear ramp between.                                        |
| Moon            | `moonInterference` is optional and is clamped to `[0, 1]`.                                   | `1 − moonInterference`; larger interference lowers the score.                                                             |
| Duration        | Supply both `availableDurationHours` and `requiredDurationHours`.                            | `available / required`, clamped to `[0, 1]`; a zero or negative requirement counts as satisfied.                          |

`moonInterference(illumination, moonAltitude, separation)` estimates a penalty on `[0, 1]` from the illuminated fraction of the lunar disk, geometric lunar altitude, and angular separation from the target. Separation is normalized to `(−π, π]` before taking its magnitude. The weight is `illumination × sin(moonAltitude) × exp(−0.5 × (wrapped separation / 30°)²)`, clamped to `[0, 1]`. The function returns zero when illumination is not positive or the Moon is at or below the horizon. Pass its result as the `moonInterference` input to `observationScore`.

## Model and limits

The linear thresholds and lunar Gaussian are planning heuristics, not an exposure or sky-brightness model. The score compares targets under the same supplied factors and options; omitting a factor changes the geometric mean's membership. `minimumAltitude`, `goodAltitude`, and `maximumAirmass` adjust the corresponding ramps, while `scale` changes only the returned scale. Compute the target and Sun altitudes, Moon separation, and available time in the frame and instant relevant to the intended observation before scoring.

## Related topics

- [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) converts an equatorial direction to altitude and azimuth.
