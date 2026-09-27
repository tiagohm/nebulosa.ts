---
title: Sundial geometry
layout: default
parent: Astronomy
nav_order: 580
description: Computes sampled shadow hour lines for planar sundials from latitude, dial orientation, and stylus length.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Sundial
---

# Sundial geometry

`Sundial` implements the planar shadow geometry in Meeus chapter 58. Use it to lay out hour-line sample points for a straight stylus on a general, equatorial, horizontal, or vertical dial. The returned `hour` labels represent **local apparent solar time**; a clock-time layout also needs the equation of time and the site's longitude offset from its time-zone meridian.

## Basic usage

```ts
import { Sundial } from '../src/astronomy/ephemeris/meeus';
import { deg } from '../src/math/units/angle';

const dial = Sundial.vertical(deg(40), deg(70), 1);
const noon = dial.lines.find((line) => line.hour === 12);
console.log(dial.center, dial.length, noon?.points);
```

Here the site latitude is `+40°`, the dial's outward normal points `70°` west of the southern meridian, and the perpendicular stylus length is `1` drawing unit. The chapter test gives `center ≈ (-2.7475, 2.4534)` and polar-stylus `length ≈ 3.8168` in that unit.

## Choosing a dial

| Function                | Geometry and returned fields                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| `general(phi, D, a, z)` | Plane with specified stylus zenith distance `z`; returns `{ lines, center, length, angle }`. |
| `equatorial(phi, a)`    | Plane parallel to Earth's equator; returns `{ north, south }`, hour lines on the two faces.  |
| `horizontal(phi, a)`    | Level dial; returns `{ lines, center, length }`.                                             |
| `vertical(phi, D, a)`   | Vertical dial with specified face orientation; returns `{ lines, center, length }`.          |

`phi` is **geographic latitude** in radians. `D` is the gnomonic declination of the plane's perpendicular: measure it from the **southern meridian toward the west**, in radians. It is not the site's longitude. `a` is the length of a straight stylus perpendicular to the plane, in the caller's chosen drawing unit. For `general`, `z` is the stylus direction's **zenith distance** in radians. The returned `center`, every line point, and `length` scale with `a` and use that same drawing unit; `angle` is the angle in radians between the polar stylus and the plane.

Each `Sundial.Line` contains an integer `hour` from `0` through `23` and one or more `{ x, y }` shadow coordinates on the dial plane. A line's points sample seven fixed solar declinations, ordered from `−23.44°` through `+23.44°`, with intermediate samples at `−20.15°`, `−11.47°`, `0°`, `+11.47°`, and `+20.15°`. Hours without surviving points are omitted. For an equatorial dial, negative and positive declinations go to the south and north face respectively; the equinox sample at zero declination is omitted because its shadow projection has a zero denominator.

## Geometric limits

The routine excludes samples where the Sun is at or below the geometric horizon. General and vertical dials also exclude rays behind their plane. These fixed declination samples describe points along hour lines; they do not resolve a continuous analemma or include atmospheric refraction. A singular dial orientation can make `center`, `length`, or individual shadow points non-finite because the geometric formulas divide by vanishing projection factors. Choose a physically usable plane and stylus geometry before drawing the output.

## Related topics

- [Meeus Equation of Time]({% link astronomy/meeus-equation-of-time.md %}) relates apparent solar time to mean solar time.
- [Meeus Equinoxes and Solstices]({% link astronomy/meeus-equinoxes-and-solstices.md %}) computes the seasonal instants represented by the declination range.
- [Meeus Approximate Rise, Transit, and Set]({% link astronomy/meeus-approximate-rise-transit-and-set.md %}) estimates when the Sun or another body crosses the horizon.
