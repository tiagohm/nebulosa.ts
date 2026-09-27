---
title: Hour-angle Windows
layout: default
parent: Astronomy
nav_order: 380
description: Computes signed hour angle, the wait to meridian passage, and future intervals inside hour-angle bounds.

doc_kind: topic

sources:
    - src/astronomy/events/hourangle.ts

api:
    - hourAngle
    - timeUntilMeridian
    - hourAngleWindows
    - HourAngleWindow
---

# Hour-angle Windows

Hour angle locates a target east or west of the observer's meridian. These functions turn a supplied local sidereal angle and fixed right ascension into a signed hour angle, estimate the wait to the next meridian passage, and find future stretches inside an hour-angle constraint.

## Basic usage

```ts
import { hourAngle, hourAngleWindows, timeUntilMeridian } from '../src/astronomy/events/hourangle';
import { SIDEREAL_DAYSEC } from '../src/core/constants';
import { deg } from '../src/math/units/angle';

const angle = hourAngle(0, deg(45)); // Target is east of the meridian.
console.log(Math.round(timeUntilMeridian(angle))); // 10771 seconds

const windows = hourAngleWindows(angle, deg(-30), deg(30), SIDEREAL_DAYSEC);
console.log(windows.length); // 1
```

`hourAngle(localSiderealTime, rightAscension)` evaluates **local sidereal time − right ascension**, with both inputs in radians. The result is normalized to **(−π, π] radians**: negative east of the meridian, positive west, and zero on it. Supply a local sidereal angle appropriate to the target's right-ascension convention; this function does not calculate sidereal time or transform the target's coordinates.

## Durations and bounds

`timeUntilMeridian(angle)` normalizes its angle and returns a nonnegative wait in **SI seconds**. It returns zero at hour angle zero. If the target is already west of the meridian, the wait reaches the next sidereal turn. The calculation uses the fixed sidereal drift rate of `2π / 86164.0905` radians per second.

`hourAngleWindows(angle, minimum, maximum, durationSeconds)` treats `angle` as the value at second zero and returns `HourAngleWindow` intervals with `startSeconds` and `endSeconds` measured from that point. The bounds are signed radians, ordinarily in the −π to π range. For `minimum <= maximum`, the permitted interval is between the bounds. For `minimum > maximum`, it crosses the ±π cut: for example, +170° through 180° to −170°. Returned stretches are clipped to `[0, durationSeconds]` and joined across the cut when they meet.

An equal pair of bounds, a nonpositive duration, or a nonfinite duration yields an empty list. A duration longer than **100,000 sidereal days** throws `RangeError` to prevent an accidentally huge result.

## Accuracy and related topics

The window calculation advances the initial hour angle at a constant sidereal rate. It does not update a moving target's right ascension, model changes in apparent sidereal rate, or evaluate altitude, refraction, or the observer's horizon. Use it for a fixed-RA meridian constraint; use [Rise, Transit, and Set]({% link astronomy/rise-transit-and-set.md %}) to search actual altitude crossings from a time-dependent direction. [Sidereal Time and Earth Rotation Angle]({% link astronomy/time-and-earth-orientation/sidereal-time-and-earth-rotation-angle.md %}) supplies the Earth-rotation context for a local sidereal angle.
