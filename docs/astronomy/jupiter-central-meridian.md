---
title: Jupiter Central Meridian
layout: default
parent: Astronomy
nav_order: 470
description: Returns Jupiter's west-positive central-meridian longitude in Systems I, II, or III.

doc_kind: topic

sources:
    - src/astronomy/events/jupiter.ts

api:
    - jupiterCentralMeridian
    - JovianSystem
---

# Jupiter Central Meridian

`jupiterCentralMeridian` gives the longitude facing an observer on Jupiter's apparent disk in one of its three conventional rotation systems. Use it when comparing a feature longitude, sketch, or almanac entry that names System I, II, or III.

## Basic usage

```ts
import { earth, jupiter } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { jupiterCentralMeridian } from '../src/astronomy/events/jupiter';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { vecMinus } from '../src/math/linear-algebra/vec3';
import { toDeg } from '../src/math/units/angle';

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC);
const jupiterToEarth = vecMinus(earth(time)[0], jupiter(time)[0]);
console.log(toDeg(jupiterCentralMeridian('II', time, jupiterToEarth)).toFixed(2)); // 328.28
```

The vector must point **from Jupiter's center toward the observer** in ICRF-oriented axes, with length in **AU**. Its direction sets the sub-observer point; its length sets the one-way light-time delay applied to Jupiter's rotation at the observed instant. Reversing the vector changes the viewed hemisphere.

## Longitude convention

`JovianSystem` accepts `'I'` (equatorial rotation), `'II'` (temperate-latitude rotation, used for the Great Red Spot), or `'III'` (the magnetic/radio rotation system). The calculation selects the corresponding body-orientation elements and projects the observer into Jupiter's body-fixed frame. That sub-observer longitude is east-positive; the returned central-meridian longitude is its complement, normalized to **[0, 2π) radians** and **positive west**. Compare a feature longitude with the central meridian in the same system.

The returned angle describes the disk center at the supplied `Time`; it does not search for a future crossing or measure a feature's longitude. Prediction quality depends on the supplied Jupiter-to-observer vector and the adopted rotation elements. The routine does not incorporate a site-specific topocentric observer unless the caller supplies that vector.

See [IAU Body Orientation]({% link astronomy/iau-body-orientation.md %}) for the underlying rotation models and [Sub-Observer and Sub-Solar Points]({% link astronomy/sub-observer-and-sub-solar-points.md %}) for east-positive surface points.
