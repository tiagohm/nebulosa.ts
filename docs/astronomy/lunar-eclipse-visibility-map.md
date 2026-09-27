---
title: Lunar Eclipse Visibility Map
layout: default
parent: Astronomy
nav_order: 580
description: Maps where the Moon is above or below the horizon at each global lunar-eclipse contact.

doc_kind: topic

sources:
    - src/astronomy/events/eclipse/lunar/map.ts

api:
    - lunarEclipseEvents
    - computeLunarEclipseMapGeometry
    - lunarEclipseMapToSvgPaths
    - LunarEclipseContactKind
    - LunarEclipseMapGeometry
    - LunarEclipseMapGeometryOptions
    - LunarEclipseMapSvgOptions
    - LunarEclipseMapSvgPaths
    - LunarLimbVisibility
---

# Lunar Eclipse Visibility Map

`computeLunarEclipseMapGeometry` draws the terrestrial boundary where the Moon meets the horizon at each global lunar-eclipse contact. The curves separate places that can see the Moon from places where it is below the selected horizon. They are **visibility boundaries**, not the path of Earth's shadow on the ground: that shadow falls on the Moon.

## Basic usage

```ts
import { nearestLunarEclipse } from '../src/astronomy/bodies/moon';
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse';
import { computeLunarEclipseMapGeometry, lunarEclipseMapToSvgPaths } from '../src/astronomy/events/eclipse/lunar/map';
import { PlateCarree } from '../src/astronomy/projections/projection';
import { timeYMD } from '../src/astronomy/time/time';
import { PIOVERTWO, TAU } from '../src/core/constants';
import { deg } from '../src/math/units/angle';

const eclipse = nearestLunarEclipse(timeYMD(2025, 3, 1), true);
const map = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, { maxAngularStep: deg(5) });
const projection = new PlateCarree(undefined, {
	scale: 720 / TAU,
	falseEasting: 360,
	falseNorthing: 180,
	yAxisDirection: 'southUp',
	centralMeridian: 0,
	longitudeWrapMode: 'pi',
	maxLatitude: PIOVERTWO,
});
const paths = lunarEclipseMapToSvgPaths(map, projection);
console.log(map.events.length, paths.moonRiseSet.MAX.startsWith('M'), Boolean(paths.sublunarPoints.MAX));
// 7 true true
```

The required Sun/Moon provider supplies geocentric equatorial positions and Moon distance in **Earth equatorial radii** at the eclipse's **TT** contact instants. The included `sunMoonPosition` supplies apparent coordinates. `lunarEclipseEvents` selects the contacts present for the eclipse type: a penumbral eclipse has P1/MAX/P4, a partial eclipse adds U1/U4, and a total eclipse also has U2/U3. `map.events` retains their chronological order, the provider's Moon coordinates, effective horizon altitude, and sublunar geographic points.

## Horizon geometry

Each `map.lines.moonRiseSet` contact curve is a closed, projection-independent small circle around the sublunar point. Its longitude is **Moon RA − Greenwich apparent sidereal time**, east-positive and normalized to **[−π, π]**; latitude equals Moon declination. Coordinates are in **radians**, with optional Julian Day stamps. The circle's angular radius is `π/2 − h₀ − asin(cos(h₀) / d)`, where `h₀` is the effective topocentric horizon altitude and `d` is Moon distance in Earth equatorial radii. The parallax term moves the boundary to where the Moon's **topocentric center** reaches `h₀`, rather than where a geocentric direction does.

`horizonAltitude` defaults to **0 radians**. With `refraction: true`, the routine lowers the effective altitude by **34 arcminutes**. `limbVisibility: 'upperLimb'` lowers it further by the Moon's apparent semidiameter at that contact; `'center'` is the default. `maxAngularStep` sets target spacing along a circle in radians and defaults to **1°**. The curve uses a spherical surface observer, while the local circumstance calculation includes Earth's flattening, so their horizon boundaries can differ slightly.

## SVG paths and filled regions

`lunarEclipseMapToSvgPaths` accepts a caller-supplied cylindrical projection. By default it emits **open path-data strings** for each contact's horizon curve and pixel coordinates for the sublunar points; an absent contact has an empty path string. The serializer splits antimeridian crossings into separate subpaths without changing the geographic geometry.

Set `{ fill: true }` to obtain closed regions instead of open horizon lines. `fillRegion` defaults to `'belowHorizon'` for shading the nonvisible area; `'aboveHorizon'` selects the visibility cap. Render filled paths with SVG `fill-rule="evenodd"`, especially when a near-equatorial cap's complement is represented by a world rectangle with a cutout. Filled regions assume a full-longitude cylindrical projection that can reach both **±90°** latitude edges. Path coordinates retain **two decimal places** by default.

## Accuracy and limits

The contact times come from the supplied lunar-eclipse model, while the curves depend on the Sun/Moon provider, ΔT, parallax, chosen limb, refraction option, and sampling spacing. The 34′ refraction option is a fixed horizon adjustment rather than a weather-dependent refraction calculation. Use [Local Lunar Eclipse Circumstances]({% link astronomy/local-lunar-eclipse-circumstances.md %}) to determine an individual site's event visibility and topocentric angles. [Solar Eclipse Besselian Geometry]({% link astronomy/solar-eclipse-besselian-geometry.md %}) maps a physically different ground-shadow event.
