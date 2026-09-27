---
title: Great Red Spot Transits
layout: default
parent: Astronomy
nav_order: 480
description: Finds when a supplied System II spot longitude faces a specified observer.

doc_kind: topic

sources:
    - src/astronomy/events/jupiter.ts

api:
    - greatRedSpotTransits
---

# Great Red Spot Transits

`greatRedSpotTransits` searches for instants when Jupiter's System II central meridian reaches a supplied Great Red Spot longitude. Use it to schedule a disk-center crossing after obtaining the spot's current observed longitude.

## Basic usage

```ts
import { earth, jupiter } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { greatRedSpotTransits } from '../src/astronomy/events/jupiter';
import { timeSubtract, timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { deg } from '../src/math/units/angle';

const start = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const stop = timeYMDHMS(2026, 7, 1, 0, 0, 0, Timescale.UTC);
const jupiterToEarth = (time: typeof start) => vecMinus(earth(time)[0], jupiter(time)[0]);
const transits = greatRedSpotTransits(deg(50), jupiterToEarth, start, stop);
console.log(transits.length, (timeSubtract(transits[0], start, Timescale.UTC) * 24).toFixed(2));
// 5 2.25
```

The first argument is the spot's **west-positive System II longitude in radians**. `jupiterToObserverAt(time)` must return the vector **from Jupiter toward the observer** in ICRF-oriented axes and **AU**; the example uses Earth's center. The function does not infer or update the spot longitude. Supply a longitude appropriate to the observing period, since the feature can drift relative to System II.

## Search and limits

The result is a chronological `Time[]` within `[start, stop]`. The search finds zeros of `sin(centralMeridian − spotLongitude)`, which avoids a false crossing at the 0/2π wrap. It then keeps the crossings where the cosine of that difference is positive, removing the anti-transits when the spot is on the far side.

Optional `step` and `tolerance` follow `TimeSearchOptions` in **days**. The default coarse step is **1 hour**, and the default root refinement tolerance is **10⁻⁶ day**. A step wide enough to straddle multiple crossings can miss a transit. The routine models the System II longitude crossing; it does not test whether Jupiter is above a site's horizon, whether the spot is visually distinct, or how the spot changes during the search window. Timing depends on the supplied direction model, spot longitude, and sampling.

See [Jupiter Central Meridian]({% link astronomy/jupiter-central-meridian.md %}) for the west-positive longitude convention and [Time-Domain Event Search]({% link astronomy/time-domain-event-search.md %}) for root-sampling limits.
