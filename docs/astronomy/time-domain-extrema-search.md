---
title: Time-Domain Extrema Search
layout: default
parent: Astronomy
nav_order: 420
description: Locates sampled local minima and maxima of a time-dependent scalar with Brent refinement.

doc_kind: topic

sources:
    - src/astronomy/events/search.ts

api:
    - searchExtrema
    - TimeExtremum
---

# Time-Domain Extrema Search

`searchExtrema` finds local minima and maxima of a scalar objective over a time span. Use it for closest approaches, greatest elongations, or other events defined by a peak or trough rather than a zero crossing.

## Basic usage

```ts
import { searchExtrema } from '../src/astronomy/events/search';
import { Timescale, timeShift, timeSubtract, timeYMDHMS } from '../src/astronomy/time/time';
import { TAU } from '../src/core/constants';

const epoch = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.UTC);
const objective = (time: typeof epoch) => Math.sin(TAU * timeSubtract(time, epoch));
const extrema = searchExtrema(objective, epoch, timeShift(epoch, 1));
console.log(extrema.map((event) => [event.kind, timeSubtract(event.time, epoch).toFixed(2)]));
// [['maximum', '0.25'], ['minimum', '0.75']]
```

Each `TimeExtremum` contains a `time`, the scalar `value` at that instant, and `kind` (`'minimum'` or `'maximum'`). Results are chronological. An empty or inverted time window returns an empty array.

## Sampling and limits

The scanner compares each middle sample with its immediate neighbors. A strictly lower middle value brackets a minimum; a strictly higher one brackets a maximum. Brent minimization then refines that bracket, negating the objective for a maximum. This is a **local** search: it does not select the single global peak or trough for the whole window. Filter the returned events if a particular extremum is needed.

The inherited `step` is the coarse spacing in **days**, defaulting to **1 hour**; `tolerance` is the Brent refinement tolerance in **days**, defaulting to **10⁻⁶ day** (about **0.09 seconds**). A nonpositive step returns an empty list. The objective should be continuous over the searched window. A flat shoulder, an extremum between poorly spaced samples, or an extremum at a window endpoint can be missed. A smaller step improves bracketing but cannot make a discontinuous wrapped angle suitable for this search. The refinement tolerance does not establish physical accuracy independently of the objective and model.

Use [Time-Domain Event Search]({% link astronomy/time-domain-event-search.md %}) for zero crossings and its shared `TimeSearchOptions` contract. [Observing Visibility Windows]({% link astronomy/observing-visibility-windows.md %}) uses threshold crossings to return whole observing intervals.
