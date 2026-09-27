---
title: Stellar and Asteroidal Occultations
layout: default
parent: Astronomy
nav_order: 440
description: Screens a star and moving finite body for site-specific close approaches and disk occultations.

doc_kind: topic

sources:
    - src/astronomy/events/occultation.ts

api:
    - occultationCandidates
    - OccultationCandidate
    - OccultationOptions
---

# Stellar and Asteroidal Occultations

`occultationCandidates` finds close approaches between a fixed star direction and a moving body's disk from one observer. It reports each sampled separation minimum and tests whether the body's angular disk covers the star. Use it for an asteroid or a spherical Moon against a star when a site-specific observer state is available.

## Basic usage

```ts
import type { PositionAndVelocity } from '../src/astronomy/coordinates/astrometry';
import { occultationCandidates } from '../src/astronomy/events/occultation';
import { Timescale, timeShift, timeSubtract, timeYMDHMS } from '../src/astronomy/time/time';
import { kilometer } from '../src/math/units/distance';

// Simple linear encounter in a shared frame, with the observer at its origin.
const crossing = timeYMDHMS(2026, 5, 1, 0, 0, 0, Timescale.TDB);
const target = (time: typeof crossing): PositionAndVelocity => [
	[2, 1e-6, 2e-4 * timeSubtract(time, crossing)],
	[0, 0, 2e-4],
];
const observer = (): PositionAndVelocity => [
	[0, 0, 0],
	[0, 0, 0],
];
const events = occultationCandidates(target, [1, 0, 0], observer, timeShift(crossing, -0.02), timeShift(crossing, 0.02), {
	radius: kilometer(449),
	lightTimeIterations: 0,
});
console.log(events.length, events[0]?.occultation); // 1 true
```

For a real site, pass a **barycentric observer state** such as `observerState(time, earth(time), site)`; the target callback must use the same origin and ICRS-oriented axes. Position and velocity are in **AU** and **AU/day**. The fixed `star` argument is an ICRS-oriented direction at effectively infinite distance; its magnitude is irrelevant. Prepare its place for the relevant epoch, including proper motion when needed. The function does not propagate a star catalog entry or apply stellar parallax itself.

## Candidates and options

Every returned `OccultationCandidate` is a local minimum of the topocentric star–body angular separation within the window, sorted by time. `separation` and `angularRadius` are **radians**, and `distance` is the body's topocentric distance in **AU**. The angular radius is `asin(radius / distance)` for the physical `radius` supplied in AU. `occultation` is true when `separation <= angularRadius`; the star is treated as a point.

`relativeAngularSpeed` is a nonnegative angular motion estimate in **radians per day**, sampled around the appulse. When the star is covered and the speed is positive, `duration` estimates the chord crossing in **seconds** as `2 × sqrt(angularRadius² − separation²) / relativeAngularSpeed × 86400`. It is `undefined` for a miss or unresolved zero speed. This local straight-chord estimate is not a pair of solved ingress and egress contact times.

`radius` defaults to **0 AU**, so supply the body's physical radius to classify its disk. `maxSeparation`, in radians, filters out wider appulses; without it, every detected separation minimum is returned. `lightTimeIterations` defaults to **2** and retards the body's sampled position to its emission time; zero keeps the body's geometry at reception time. The observer is sampled within `[start, stop]`, while a light-time-corrected target may be sampled before `start`, so its ephemeris must cover that earlier time.

## Accuracy and related topics

The coarse `step` defaults to **1 minute** in days and is capped at one quarter of the search span for short windows. `tolerance` is a refinement tolerance in **days**. A broad step can miss a brief appulse, and an empty or inverted window returns no candidates. This per-site search includes topocentric parallax through the supplied observer, but it does not compute a ground shadow track, atmospheric visibility, or a light curve. It omits aberration in the differential geometry; the body's orbit and prepared star direction remain major sources of event uncertainty.

See [Stellar Space Motion]({% link astronomy/stellar-space-motion.md %}) for propagating catalog astrometry and [Time-Domain Extrema Search]({% link astronomy/time-domain-extrema-search.md %}) for the sampled minimum search.
