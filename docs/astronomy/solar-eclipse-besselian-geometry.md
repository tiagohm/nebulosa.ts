---
title: Solar Eclipse Besselian Geometry
layout: default
parent: Astronomy
nav_order: 560
description: Fits Besselian elements and constructs geographic contacts, shadow limits, central lines, and SVG map paths.

doc_kind: topic

sources:
    - src/astronomy/events/eclipse/solar/map.ts
    - src/astronomy/events/eclipse/eclipse.ts

api:
    - computePolynomialBesselianElements
    - evaluateBesselian
    - computeSolarEclipseMapGeometry
    - solarEclipseMapToSvgPaths
    - splitCentralLineByKind
    - PolynomialBesselianElements
    - InstantBesselianElements
    - SolarEclipseMapGeometry
    - SolarEclipseMapGeometryOptions
    - SolarEclipseMapSvgPaths
    - RefractionMode
    - sunMoonPosition
---

# Solar Eclipse Besselian Geometry

This pipeline turns a candidate solar eclipse and Sun/Moon positions into geographic map geometry: shadow contacts, a central line, penumbral and umbral limits, and optional eclipse-at-sunrise or sunset curves. Project the geometry separately when an SVG map needs path data.

## Basic usage

```ts
import { nearestSolarEclipse } from '../src/astronomy/bodies/sun';
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse';
import { computePolynomialBesselianElements, computeSolarEclipseMapGeometry, solarEclipseMapToSvgPaths } from '../src/astronomy/events/eclipse/solar/map';
import { PlateCarree } from '../src/astronomy/projections/projection';
import { timeYMD } from '../src/astronomy/time/time';
import { PIOVERTWO, TAU } from '../src/core/constants';
import { deg } from '../src/math/units/angle';

const eclipse = nearestSolarEclipse(timeYMD(2024, 4, 8), true);
const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition);
const map = computeSolarEclipseMapGeometry(eclipse, elements, {
	longitudeStep: deg(3),
	maxAngularStep: deg(6),
	includeRiseSetCurves: false,
});
const projection = new PlateCarree(undefined, {
	scale: 720 / TAU,
	falseEasting: 360,
	falseNorthing: 180,
	yAxisDirection: 'southUp',
	centralMeridian: 0,
	longitudeWrapMode: 'pi',
	maxLatitude: PIOVERTWO,
});
const paths = solarEclipseMapToSvgPaths(map, projection);
console.log(Boolean(map.points.MAX), map.lines.centerLine.length, paths.centerLine.startsWith('M'));
// true 47 true
```

Pass the `SolarEclipse` and elements for the **same candidate eclipse**. `computePolynomialBesselianElements` requires a `SunMoonProvider`; `sunMoonPosition` is the included analytical ERFA provider. It uses `eraEpv00` for the Sun/Earth and `eraMoon98` for the Moon, with light-time, annual-aberration, and precession/nutation corrections before the Besselian fit. Other providers can be passed when their positions use compatible geocentric equatorial coordinates and distances in Earth equatorial radii.

## Elements and geographic coordinates

Besselian `x`, `y`, `l1`, and `l2` are fundamental-plane distances in **Earth equatorial radii**. The fit rounds the supplied maximum to a whole-hour origin, then samples at **−3, −1.5, 0, +1.5, and +3 hours** around that origin and stores polynomial coefficients; `evaluateBesselian` evaluates them at a `Time`. The fit's `mu` uses Earth rotation derived from UT1 through ΔT. The generated elements set `deltaTLongitudeCorrection` to **0** because that correction is already accounted for; imported dynamical-time tabulations may require a nonzero correction under the `PolynomialBesselianElements` contract.

Geographic point `x` is **east-positive longitude**, normalized to **[−π, π]**, and point `y` is latitude, both in **radians**. An optional `jd` gives the point's Julian Day. The geometry projects the shadow onto a flattened Earth limb. The adopted radii are **109.076370706** Earth radii for the Sun, **0.272488** for the Moon's penumbral cone, and **0.272281** for its umbral or antumbral cone.

## Reading the map

`map.points` provides named contacts and greatest eclipse where the solver finds them. `P1`/`P4` mark first/last external penumbral contact with Earth; `U1`–`U4` mark umbral or antumbral cone tangencies. **Map `C1`/`C2` are the beginning and end of the central line on Earth**. They have a different meaning from the site's C1/C2 lunar-limb contacts in [Local Solar Eclipse Circumstances]({% link astronomy/local-solar-eclipse-circumstances.md %}). `MAX` is the greatest-eclipse geographic point.

`map.lines.centerLine` is one geographic branch when the shadow axis intersects Earth; it is empty when the axis misses Earth, including ordinary partial and noncentral eclipses. The geometric axis test can also produce a central line for a candidate that Meeus classified as partial near the boundary. `umbraNorth` and `umbraSouth` can still exist for a noncentral total or annular eclipse whose cone touches Earth. The penumbral and umbral limits are arrays of separate continuity branches. Preserve those branch boundaries when drawing: joining across them can make false lines at polar folds or the antimeridian. For a hybrid eclipse, central-line points carry `total` or `annular` kinds, and `splitCentralLineByKind` separates their segments.

`includeRiseSetCurves` defaults to **false**; enable it for eclipse-at-sunrise and eclipse-at-sunset curves. `longitudeStep` and `maxAngularStep` default to **1°** each; `riseSetStep` defaults to **30 seconds** when rise/set curves are requested. The curve solver's `refractionMode` defaults to `'empirical'`, a horizon-refraction compatibility model; select `'none'` for its unrefracted geometry. It does not change the fitted Sun/Moon positions or turn the map into local observed contacts.

`solarEclipseMapToSvgPaths` takes a caller-supplied **cylindrical projection**. It returns SVG path-data strings for each line family and projected pixel points, with **two decimal places** by default. Empty features yield empty strings. Geographic geometry remains unprojected, and antimeridian crossings become separate SVG subpaths.

## Accuracy and limits

The map is computed from the selected Sun/Moon provider and a finite Besselian fit around one eclipse. Changing the provider or using the polynomial far beyond its sampled interval changes the physical interpretation and can degrade the result. The Meeus candidate's global type is a screening result; the map tests whether the shadow axis actually intersects the ellipsoid when deciding whether to draw a central line. No uniform geographic or timing accuracy is implied by the fit alone.

Use [Solar Eclipse Search and Classification]({% link astronomy/solar-eclipse-search-and-classification.md %}) to find a candidate and [Local Solar Eclipse Circumstances]({% link astronomy/local-solar-eclipse-circumstances.md %}) for contacts and visibility at a site.
