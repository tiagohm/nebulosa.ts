---
title: Meeus Lunar Illumination
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 330
description: Estimates the Moon's phase angle from geocentric directions and converts it to the illuminated disk fraction.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - MoonIlluminated
---

# Meeus Lunar Illumination

`MoonIlluminated` calculates the Moon's **phase angle** from geocentric Moon and Sun directions or from a date-only chapter approximation. Pass that angle to `Base.illuminated` to obtain the dimensionless fraction of the apparent lunar disk that is lit. A phase angle near `π` corresponds to new Moon and a fraction near `0`; an angle near `0` corresponds to full Moon and a fraction near `1`.

## Basic usage

```ts
import { Base, MoonIlluminated } from '../src/astronomy/ephemeris/meeus';
import { deg, toDeg } from '../src/math/units/angle';

const moon = [deg(134.6885), deg(13.7684), 368410] as const; // RA, Dec, distance in km
const sun = [deg(20.6579), deg(8.6964), 149971520] as const; // same equatorial frame and distance unit
const phase = MoonIlluminated.phaseAngleEquatorial(moon, sun);
const litFraction = Base.illuminated(phase);
console.log(toDeg(phase), litFraction);
```

This chapter example gives a phase angle of about `69.0756°` and a lit fraction of about `0.67857`. The returned phase angle is in **radians**. The fraction is **not** the lunation number or the instant of a phase event.

## Coordinate forms

| Function                             | Supplied coordinates                                                                              | Distance use                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------- |
| `phaseAngleEquatorial(cMoon, cSun)`  | `[RA, Dec, distance]` for each body, in the same equatorial frame; angles in radians              | Uses both distances          |
| `phaseAngleEquatorial2(cMoon, cSun)` | `[RA, Dec]` for each body                                                                         | Direction-only approximation |
| `phaseAngleEcliptic(cMoon, cSun)`    | `[longitude, latitude, distance]` for Moon and Sun, in the same ecliptic frame; angles in radians | Uses both distances          |
| `phaseAngleEcliptic2(cMoon, cSun)`   | Ecliptic direction pairs                                                                          | Direction-only approximation |

For the distance-aware forms, the two distances may use **any one consistent unit**: both km, or both AU, for example. A zero-length or mismatched unit scale has no physical interpretation. The ecliptic formulas use the Sun's **longitude** but omit its supplied latitude, matching the chapter's near-ecliptic solar approximation. The `*2` methods use only angular elongation, so they can differ from the distance-aware phase angle. All four coordinate methods return angles in `[0, π]` radians and clamp rounding-sensitive inverse-trigonometric inputs where needed.

## Date-only estimate

`phaseAngle3(jde)` accepts a numeric **TT Julian ephemeris day** and evaluates a shorter periodic approximation without caller-supplied Moon or Sun coordinates. The chapter test gives about `68.88°` and, after `Base.illuminated`, a fraction about `0.6801` for 1992-04-12 TT. It is less accurate than the coordinate forms. Its raw expression is **not normalized to `[0, π]`**; `Base.illuminated` uses its cosine, so angles differing by a full turn give the same fraction.

## Accuracy and limits

These methods describe geocentric disk illumination. They do not search for a new Moon, first quarter, full Moon, or last quarter time; `nearestLunarPhase` in `src/astronomy/bodies/moon.ts` is a separate event API. The fraction is geometric and does not model lunar surface reflectance, shadows from eclipses, or a particular observer's atmosphere. The chapter examples establish sample values rather than a uniform accuracy bound over all dates.

## Related topics

- [Meeus Lunar Position]({% link astronomy/meeus-algorithms/lunar-position.md %}) supplies geocentric ecliptic Moon coordinates and distance.
- [Meeus Illuminated Fraction]({% link astronomy/meeus-algorithms/illuminated-fraction.md %}) explains the shared `Base.illuminated` conversion.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) explains numeric TT JDE.
