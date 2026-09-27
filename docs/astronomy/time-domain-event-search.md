---
title: Time-Domain Event Search
layout: default
parent: Astronomy
nav_order: 410
description: Finds roots of a continuous time-dependent scalar by sampling and Brent refinement.

doc_kind: topic

sources:
    - src/astronomy/events/search.ts

api:
    - searchRoots
    - TimeSearchOptions
---

# Time-Domain Event Search

`searchRoots` locates times when a scalar objective crosses zero. Use it for custom event conditions such as an angle reaching a threshold, or for the same sampled-root method used by higher-level astronomy event finders.

## Basic usage

```ts
import { searchRoots } from '../src/astronomy/events/search';
import { Timescale, timeShift, timeSubtract, timeYMDHMS } from '../src/astronomy/time/time';
import { TAU } from '../src/core/constants';

const epoch = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.UTC);
const objective = (time: typeof epoch) => Math.sin(TAU * timeSubtract(time, epoch));
const roots = searchRoots(objective, timeShift(epoch, 0.1), timeShift(epoch, 1.1));
console.log(roots.map((time) => timeSubtract(time, epoch).toFixed(1))); // ['0.5', '1.0']
```

The callback returns a scalar number from a `Time`; zero defines the event. `searchRoots` returns `Time[]` in chronological order within the closed `[start, stop]` window. A sample that evaluates to exactly zero, including either endpoint, is reported. An empty or inverted window returns an empty array.

## Sampling contract

`TimeSearchOptions.step` is a positive coarse spacing in **days**, defaulting to `1/24` day (**1 hour**); a nonpositive step returns an empty array. `tolerance` is Brent's refinement tolerance in **days**, defaulting to `10⁻⁶` day (about **0.09 seconds**). Set `step` small enough to place separate events in separate sample intervals. The tolerance refines a bracket; it does not compensate for a missed bracket or guarantee physical timing accuracy.

The objective needs to be continuous over the searched window. A wrapped right ascension, longitude, or hour angle can jump at the 0/2π seam and create a false sign change. Form a continuous difference around the desired target angle or use an appropriate smooth trigonometric objective. A tangential zero with no sign change is missed unless a coarse sample lands exactly on zero. Two roots inside one coarse step can likewise go undetected when the sampled endpoint signs agree. The scanner does not adaptively prove that every zero in the span was found.

For a local maximum or minimum rather than a zero crossing, use the related `searchExtrema` scanner. [Rise, Transit, and Set]({% link astronomy/rise-transit-and-set.md %}) and [Twilight and Darkness Windows]({% link astronomy/twilight-and-darkness-windows.md %}) build event conditions from time-dependent directions and use this sampling approach.
