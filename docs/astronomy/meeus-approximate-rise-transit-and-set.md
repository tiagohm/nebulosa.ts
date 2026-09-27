---
title: Meeus Approximate Rise, Transit, and Set
layout: default
parent: Astronomy
nav_order: 330
description: Estimates one UT1 day's rise, upper transit, and set from chapter-style apparent coordinates.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Rise
---

# Meeus Approximate Rise, Transit, and Set

`Rise` estimates when a body crosses a selected altitude and its upper meridian on a **UT1 day**. Use its low-level functions when you already have apparent equatorial coordinates, or `PlanetRise` when you want the chapter's planetary apparent-position calculation. These are Meeus single-day approximations, not a continuous search through an arbitrary ephemeris.

## Basic usage

```ts
import { Julian, Rise, Sidereal } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const jd = Julian.calendarGregorianToJD(1988, 3, 20); // UT1 midnight
const observer = { lat: deg(42.3), lon: deg(71.1) }; // longitude positive west
const theta0 = Sidereal.apparent0UT(jd); // seconds of sidereal time
const events = Rise.approxTimes(observer, Rise.stdh0Stellar(), theta0, deg(40), deg(18));
if (events.state === 'normal') {
	console.log(events.rise, events.transit, events.set); // UT1 seconds after midnight
} else {
	console.log(events.state, events.transit);
}
```

`observer.lat` is north-positive geodetic latitude and `observer.lon` is **west-positive** longitude, both in radians. `h0` is the chosen geocentric-center altitude in radians. `theta0` is Greenwich **apparent** sidereal time at UT1 midnight, in **seconds of sidereal time**, whereas RA and declination are radians. `approxTimes(observer, h0, theta0, ra, dec)` holds the apparent coordinates fixed and returns event times as **UT1 seconds after midnight** in `[0, 86400)`. Because each event is wrapped independently, `rise`, `transit`, and `set` need not appear in chronological order within that day's labels.

## Refined events and crossing states

`times(observer, deltaT, h0, theta0, ra3, dec3)` refines the same events once with a three-day quadratic interpolation. `ra3` and `dec3` contain apparent equatorial samples at **0h TT** on the previous, current, and next dates; their angles are radians, and consecutive RA changes must be less than π so the code can unwrap them around the central sample. `deltaT` is **TT − UT1 in seconds**, used to evaluate the interpolated coordinates at each UT1 event. This is a single correction, rather than an iterative root search. It holds the no-crossing classification from the central declination.

`hourAngle(lat, h0, declination)` returns a positive crossing hour angle in radians, or one of three states: `alwaysAbove`, `alwaysBelow`, or `grazing`. Both event functions return `{ state: 'normal', rise, transit, set }` for two ordinary crossings, or `{ state, transit }` without rise/set for a no-crossing state. The latter transit is still the formal hour-angle-zero passage, including at a pole. A tangent, constant-altitude geometry, or singular rise/set correction can produce `grazing`; classification near contact uses a small numerical tolerance. Do not infer a rise or set from the presence of a transit alone.

## Standard horizons

`MEAN_REFRACTION` is **34 arcminutes** in radians. The standard-altitude helpers return a geocentric-center threshold in radians:

| Helper                 | Default threshold or meaning                                    |
| ---------------------- | --------------------------------------------------------------- |
| `stdh0Stellar()`       | `−34′` for stars and planets.                                   |
| `stdh0Solar()`         | `−50′` for the Sun's apparent upper limb.                       |
| `stdh0LunarMean()`     | `+0.125°` mean lunar center altitude.                           |
| `stdh0Lunar(parallax)` | `0.7275 × horizontal parallax − 34′`, with parallax in radians. |

The `STDH0.lunar` value **0.7275** is a dimensionless multiplier, not an angle. For `stdh0Stellar`, `stdh0Solar`, and `stdh0LunarMean`, an omitted refraction argument retains the default 34′; an explicit zero removes that assumed refraction. `stdh0Lunar` also defaults to 34′ and subtracts a supplied positive correction directly. Use a threshold that matches the target's center, limb, and refraction convention.

## Planetary convenience class

```ts
const planet = new Rise.PlanetRise(jd, observer.lat, observer.lon, 'venus');
const planetaryEvents = planet.times();
console.log(planetaryEvents);
```

`PlanetRise` accepts a numeric UT1 JD or a JavaScript `Date` whose Gregorian labels select the UT1 day. It estimates ΔT at that day's midnight, obtains apparent geocentric planetary coordinates through `Elliptic.position`, and applies the stellar/planetary standard horizon. `approxTimes()` uses one position; `times()` uses the interpolated variant. The default result fields are UT1 **Julian days**. With `{ date: true }`, they are fresh JavaScript `Date` values carrying **proleptic Gregorian UT1 labels**; their `Z` serialization does not perform a UT1-to-UTC conversion. Its optional `refraction` is a positive angle in radians; zero disables the default 34′ contribution.

## Accuracy and limits

The event calculation assumes a fixed declination for its initial crossing classification and applies only one correction. Rapid motion, grazing contacts, and polar day or night can defeat the ordinary rise/set approximation; the code reports explicit no-crossing states where its geometric test or correction detects them. It does not use the repository's `Time`-based Earth-orientation providers or an observer horizon mask. For accurate UTC labels, convert UT1 with the library's time-scale machinery and appropriate Earth-orientation data.

## Related topics

- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) explains Julian-day, ΔT, and JavaScript `Date` label conventions.
- [Meeus Sidereal Time]({% link astronomy/meeus-sidereal-time.md %}) supplies the `theta0` input.
- [Transit Altitude and Hour Angle]({% link astronomy/observing-formulas/transit-altitude-and-hour-angle.md %}) solves fixed-declination crossing geometry without a clock.
