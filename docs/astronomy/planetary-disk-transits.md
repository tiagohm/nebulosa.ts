---
title: Planetary Disk Transits
layout: default
parent: Astronomy
nav_order: 430
description: Predicts site-specific Mercury or Venus transit contacts across the solar disk.

doc_kind: topic

sources:
    - src/astronomy/events/transit.ts

api:
    - planetaryTransits
    - PlanetaryTransit
    - PlanetaryTransitOptions
---

# Planetary Disk Transits

`planetaryTransits` predicts when a foreground planet's disk crosses the Sun's disk as seen from one observer. It finds the closest center-to-center approach and the exterior and, for a full transit, interior contacts. This is the Mercury or Venus solar-disk event, not an exoplanet light-curve transit.

## Basic usage

```ts
import { observerState } from '../src/astronomy/coordinates/correction';
import { earth, mercury, sun } from '../src/astronomy/ephemeris/models/analytical/vsop87e';
import { planetaryTransits } from '../src/astronomy/events/transit';
import { Ellipsoid, geodeticLocation } from '../src/astronomy/observer/location';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { SUN_RADIUS_AU } from '../src/core/constants';
import { deg } from '../src/math/units/angle';
import { kilometer } from '../src/math/units/distance';

const site = geodeticLocation(deg(-0.0015), deg(51.4779), kilometer(0.047), Ellipsoid.WGS84);
const start = timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC);
const stop = timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC);
const observer = (time: typeof start) => observerState(time, earth(time), site);
const events = planetaryTransits(mercury, sun, observer, start, stop, {
	sunRadius: SUN_RADIUS_AU,
	planetRadius: kilometer(2439.7),
});
console.log(events.length, events[0]?.full); // 1 true
```

The planet, Sun, and observer callbacks return **position and velocity in AU and AU/day** in a shared barycentric frame with ICRS-oriented axes. The observer callback above includes the site's rotating offset through `observerState`; passing Earth's center instead would omit diurnal parallax. `sunRadius` and `planetRadius` are required physical radii in **AU**. A transit candidate must have the planet nearer to the observer than the Sun, with the disks overlapping at the closest approach.

## Contacts and result

The returned `PlanetaryTransit[]` is chronological. For each event, `time` is the minimum topocentric angular separation, and `minSeparation`, `sunAngularRadius`, and `planetAngularRadius` are in **radians**. Each angular radius is `asin(physical radius / topocentric distance)` at mid-transit.

| Contact | Result field      | Disk geometry                                                                  |
| ------- | ----------------- | ------------------------------------------------------------------------------ |
| I       | `exteriorIngress` | First exterior tangency; separation equals the sum of angular radii.           |
| II      | `interiorIngress` | Planet becomes wholly inside the Sun; separation equals the radius difference. |
| III     | `interiorEgress`  | Planet starts leaving the interior; separation equals the radius difference.   |
| IV      | `exteriorEgress`  | Last exterior tangency; separation equals the sum of angular radii.            |

`full` is true when the planet's disk passes wholly inside the solar disk. A grazing overlap has `full: false` and no interior contacts. Each contact can be `undefined` when it lies outside `[start, stop]`. Detection requires the **minimum-separation instant itself inside the window**; a window containing only egress after mid-transit returns no event. `duration` is the I-to-IV span in **seconds** and is defined only when both exterior contacts are found. `ingressPositionAngle` and `egressPositionAngle` are the planet's direction relative to the Sun at contacts I and IV, measured **from celestial north through east** in `[0, 2π)` radians; each is absent when its contact is absent. Returned `Time` values retain the input window's time scale, so convert them to the display scale needed by the caller.

## Model and limitations

Both body directions use iterative light-time correction at the observer's reception time; `lightTimeIterations` defaults to **2**, while zero uses unretarded geometry. The coarse `step` defaults to **2 minutes** in days and is capped at one quarter of the requested window to sample short windows. `tolerance` controls the numerical refinement in **days**. A step too large for an event's contact or appulse spacing can miss it. A nonpositive window returns no transits.

The calculation omits annual and diurnal aberration, gravitational deflection, the detailed solar photospheric limb, and black-drop effects. It also does not check whether the Sun is above the observer's horizon, so geometric contacts are not a visibility forecast. Accuracy depends on the input ephemerides, observer state, radii, and omitted optical effects; the implementation supplies no uniform contact-time accuracy bound or multi-site ground track.

See [Solar Parallax and Semidiameter]({% link astronomy/solar-parallax-and-semidiameter.md %}) for solar angular-size context and [Time-Domain Extrema Search]({% link astronomy/time-domain-extrema-search.md %}) for the minimum-separation search.
