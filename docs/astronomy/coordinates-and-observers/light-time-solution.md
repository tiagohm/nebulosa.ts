---
title: Light-Time Solution
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 80
description: Solves the finite travel time and geometric direction between moving astronomical states.

doc_kind: topic

sources:
    - src/astronomy/coordinates/astrometry.ts

api:
    - lightTimeSolution
    - topocentricDirection
    - lightTime
    - LightTimeSolution
    - PositionAndVelocity
    - PositionAndVelocityOverTime
    - DEFAULT_LIGHT_TIME_ITERATIONS
    - MAX_LIGHT_TIME_ITERATIONS
    - validateLightTimeIterations
---

# Light-Time Solution

Use `lightTimeSolution` when the observer receives light from a moving, finite-distance target and you need its retarded geometric vector, distance, or emission time. Use `topocentricDirection` when the vector alone is enough, or `lightTime` to convert a distance vector in AU into one-way travel time in days.

## Basic usage

```ts
import { DEFAULT_LIGHT_TIME_ITERATIONS, lightTimeSolution, topocentricDirection, type PositionAndVelocityOverTime } from '../src/astronomy/coordinates/astrometry';
import { timeSubtract, timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const reception = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.TDB);
const observer: PositionAndVelocityOverTime = () => [
	[0, 0, 0],
	[0, 0, 0],
];
const target: PositionAndVelocityOverTime = (sample) => [
	[1 + 0.001 * timeSubtract(sample, reception), 0, 0], // AU
	[0.001, 0, 0], // AU/day
];

const iterations = DEFAULT_LIGHT_TIME_ITERATIONS;
const solution = lightTimeSolution(target, observer, reception, iterations);
if (solution) {
	console.log(solution.position, solution.distance, solution.lightTime, solution.emissionTime);
}

const vector = topocentricDirection(target, observer, reception, iterations);
// vector is in AU, with its length equal to the light-time distance.
```

Both providers return a `PositionAndVelocity` pair `[position, velocity]`: position in AU and velocity in AU/day. They must use the same origin and Cartesian axes; barycentric ICRS/BCRS states are a common choice. The observer is sampled once at reception time. The target is first sampled at reception, then at successively retarded times. The solver does not fetch an ephemeris or convert provider frames or time scales.

## Result and iteration contract

`lightTimeSolution` returns a `LightTimeSolution` with these fields:

| Field                                  | Meaning                                                                               |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| `time`                                 | The supplied reception `Time` object.                                                 |
| `emissionTime`                         | Reception shifted backward by the light time calculated from the final vector.        |
| `observerPosition`, `observerVelocity` | Observer sample at reception, in AU and AU/day.                                       |
| `targetEmissionPosition`               | Target position in AU from the last sample.                                           |
| `position`                             | `targetEmissionPosition − observerPosition`, in AU, directed from observer to target. |
| `distance`                             | Length of `position`, in AU.                                                          |
| `lightTime`                            | One-way travel time for `distance`, in days.                                          |

`lightTime(p)` converts the length of a vector in AU to one-way travel time in days; at 1 AU it is about 0.00577552 days, or 499 seconds. With the same provider states and iteration count, `topocentricDirection` returns the same final geometric **non-unit** vector as `solution.position`. Its name does not imply that an observing site is applied: the supplied observer state determines the actual origin. Neither function applies gravitational deflection or aberration.

The required `iterations` argument is the number of fixed-point refinements. Zero samples the target at reception and returns the same-epoch geometric vector. For `n` iterations, the target is sampled `n + 1` times. The public `DEFAULT_LIGHT_TIME_ITERATIONS` is `3`, but these two functions require you to pass the count explicitly; `MAX_LIGHT_TIME_ITERATIONS` is `16`. `validateLightTimeIterations` throws unless the count is an integer in `[0, 16]`, and both solvers invoke it before sampling their providers.

The returned snapshot vectors are fresh copies, even if the two providers reuse one workspace. `time` itself is the supplied object. `topocentricDirection` accepts an optional mutable `out` vector, writes the result into it, and returns that same vector; omitting `out` allocates one.

## Accuracy and edge cases

The solver performs a fixed number of iterations without a convergence test. `targetEmissionPosition` comes from the final target sample, while `emissionTime` is recalculated from the resulting separation; with an unconverged moving target, those epochs can differ slightly. Choose enough refinements for the target's motion and required precision.

At zero final separation, `lightTimeSolution` returns `undefined`: there is no distinct target direction. `topocentricDirection` returns a zero vector in that case and also zeroes a supplied `out` buffer. Counts outside `[0, 16]`, including fractions and non-finite values, throw.

## Related topics

- [Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) uses this solution before gravitational deflection and aberration.
