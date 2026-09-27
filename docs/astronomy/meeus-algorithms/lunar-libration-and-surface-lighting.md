---
title: Meeus Lunar Libration and Surface Lighting
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 340
description: Computes Meeus geocentric lunar libration, pole angle, subsolar point, and approximate sunlight at selenographic sites.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Moon
---

# Meeus Lunar Libration and Surface Lighting

`Moon.physical(jde)` evaluates the Meeus chapter 53 physical ephemeris of the lunar disk. Use it to identify the geocentric libration and subsolar location for a lunar observing sketch, then calculate sunlight at a named or supplied surface site. The input is a numeric **TT Julian ephemeris day (JDE)**; all returned coordinates and angles are **radians**.

## Basic usage

```ts
import { Julian, Moon } from '../src/astronomy/ephemeris/meeus';
import { toDeg } from '../src/math/units/angle';

const jde = Julian.calendarGregorianToJD(1992, 4, 12); // interpreted as TT
const [libration, poleAngle, subsolar] = Moon.physical(jde);
const copernicusAltitude = Moon.sunAltitude(Moon.selenographic.copernicus, subsolar);
console.log(libration.map(toDeg), toDeg(poleAngle), subsolar.map(toDeg), toDeg(copernicusAltitude));
```

The chapter example yields libration about `[-1.23°, +4.20°]`, pole angle `+15.08°`, subsolar location `[+67.90°, +1.46°]`, and solar-center altitude at Copernicus about `+2.318°`.

## Coordinate and result conventions

`physical(jde)` returns a fresh `[[l, b], P, [l0, b0]]` tuple. `[l, b]` is combined optical and physical **geocentric libration** in selenographic longitude and latitude. `P` is the apparent position angle of the lunar north pole, wrapped to `[0, 2π)`. `[l0, b0]` is the subsolar selenographic longitude and latitude, suitable for lunar surface lighting. Both longitudes are **east-positive** and wrapped to `[-π, π)`; north latitude is positive. These are lunar surface coordinates, not Earth-based right ascension and declination.

The reduction begins with `MoonPosition.position(jde)` in the mean ecliptic of date, then applies the chapter's nutation and physical-libration terms in `Moon.PhysicalEphemeris`. Its mean lunar-equator inclination is `1.54242°`. `PhysicalEphemeris(jde)` precomputes a set of nutation, argument, and `rho`/`sigma`/`tau` corrections for one TT day; its `lib`, `optical`, `physical`, `pa`, and `sun` methods expose the chapter's intermediate calculations when those are needed. The constructor alone does not evaluate Moon or Earth positions.

## Sunlight at a lunar site

`Moon.sunAltitude(site, subsolar)` returns the **geometric solar-center altitude** in radians above a spherical lunar horizon. Both arguments are east-positive `[selenographic longitude, north latitude]` pairs in radians. `Moon.selenographic` supplies named chapter-table sites, including `copernicus`; a caller may also supply a pair for another site. Positive altitude means the solar center is above that ideal horizon. The calculation does not use terrain, local relief, or an atmosphere.

`Moon.sunrise(site, initialJde)` and `sunset` return approximate **TT JDE** roots of zero geometric solar-center altitude. The initial day must be near the chosen event, roughly within a day, and the site must be away from the lunar poles. Each method applies exactly two corrections using the chapter's mean synodic rotation rate; it does not search a long interval or account for terrain. For Copernicus, an initial 1992-04-12 TT day gives a sunrise near 1992-04-11.807 TT in the local test.

## Model and limits

The libration and subsolar coordinates are **geocentric**. They do not include topocentric lunar libration for an Earth observing site. The separate IAU `MOON_ROTATION` cartographic model, including its E1–E13 periodic terms, underlies the body-orientation `subObserverPoint` and `subSolarPoint` APIs; it uses a different model and input contract from `Moon.physical`. Match conventions and ephemeris models before comparing longitude, latitude, or pole-angle values.

## Related topics

- [Meeus Lunar Position]({% link astronomy/meeus-algorithms/lunar-position.md %}) supplies the chapter 47 lunar position used here.
- [Meeus Lunar Illumination]({% link astronomy/meeus-algorithms/lunar-illumination.md %}) gives the disk's lit fraction, a different quantity from a site's solar altitude.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) covers numeric TT JDE and calendar labels.
