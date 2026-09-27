---
title: Sky Projections
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 230
description: Projects spherical sky or geographic angles to azimuthal and cylindrical map planes and inverts supported points.

doc_kind: topic

sources:
    - src/astronomy/projections/projection.ts

api:
    - Projection
    - ProjectionOptions
    - LongitudeWrapMode
    - RaAxisDirection
    - YAxisDirection
    - AzimuthalProjection
    - Gnomonic
    - Stereographic
    - Orthographic
    - LambertAzimuthalEqualArea
    - AzimuthalEquidistant
    - CylindricalProjection
    - Mercator
    - WebMercator
    - EllipsoidalMercator
    - Miller
    - CentralCylindrical
    - CylindricalEqualArea
    - LambertCylindricalEqualArea
    - Behrmann
    - GallPeters
    - HoboDyer
    - Balthasart
    - TrystanEdwards
    - CylindricalStereographic
    - Gall
    - Braun
    - CylindricalEquidistant
    - PlateCarree
    - WEB_MERCATOR_MAX_LATITUDE
    - projectMany
---

# Sky Projections

The `Projection` interface maps spherical longitude and latitude, or equatorial right ascension and declination, to planar `{ x, y }` coordinates and back. Choose a projection for the map or chart geometry you need, then use its `project` and `unproject` methods. `projectMany` projects a batch of independent points.

## Basic usage

```ts
import { Gnomonic, PlateCarree } from '../src/astronomy/projections/projection';
import { deg } from '../src/math/units/angle';

const chart = new Gnomonic(deg(120), deg(-30), { raAxisDirection: 'west', scale: 100 });
const projected = chart.project(deg(121), deg(-29.5));
if (projected !== undefined) {
	const recovered = chart.unproject(projected.x, projected.y);
	console.log(projected, recovered);
}

const map = new PlateCarree();
const mapped = map.project(deg(170), deg(10));
console.log(mapped);
```

Input `longitude`/`latitude` and inverse output `x`/`y` are **radians**. For sky charts, treat longitude as right ascension and latitude as declination only when those angles already share the intended frame and epoch; projection does not reduce a coordinate. Forward output is in planar units set by `radius × scale`, both defaulting to `1`. With those defaults, the output is a normalized map coordinate, not a distance or a pixel unless the caller chooses a matching scale.

## Choosing a projection

| Family                  | Available choices                                                                                                           | Domain or use                                                                                                                                                                                                                        |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tangent-plane azimuthal | `Gnomonic`, `Stereographic`, `Orthographic`, `LambertAzimuthalEqualArea`, `AzimuthalEquidistant`                            | Construct with center longitude and latitude. Gnomonic is restricted to less than a hemisphere; orthographic shows one hemisphere. The antipode is unsupported by stereographic, Lambert equal-area, and azimuthal equidistant here. |
| Mercator                | `Mercator`, `WebMercator`, `EllipsoidalMercator`                                                                            | Mercator approaches infinity at the poles; Web Mercator clamps to `±WEB_MERCATOR_MAX_LATITUDE = ±atan(sinh π)` by default. Ellipsoidal Mercator uses a configured eccentricity and an iterative inverse.                             |
| Other cylindrical       | `Miller`, `CentralCylindrical`, `CylindricalEqualArea`, `CylindricalStereographic`, `CylindricalEquidistant`, `PlateCarree` | Longitude maps linearly to x; each class supplies its latitude mapping. `PlateCarree` is the equidistant form with a zero standard parallel.                                                                                         |

The equal-area cylindrical family also provides named standard-parallel classes: `LambertCylindricalEqualArea`, `Behrmann`, `GallPeters`, `HoboDyer`, `Balthasart`, and `TrystanEdwards`. Cylindrical stereographic provides `Gall` and `Braun`. Choose a class by its mapping property and intended visible region; these are map projections, not astrometric WCS fits.

`EllipsoidalMercator` resolves its eccentricity **in the constructor**. Supply a valid `eccentricity` or `flattening`, or `sphericalOnly: true`; constructing it without an ellipsoid choice throws `TypeError` in the current implementation. Its per-call options can change plane scaling, centering, and inverse iteration settings, but do not replace the constructor's eccentricity. A failed inverse iteration returns `undefined`.

## Shared options and result contract

`project(longitude, latitude, out?, options?)` returns a planar `Point` when it can represent the input; individual projections return `undefined` for their unsupported regions or invalid plane settings. `unproject(x, y, out?, options?)` returns longitude and latitude or `undefined` if its inverse cannot represent the point. On success, an optional `out` point is filled and returned; without it, a new point is allocated. A failed inverse can have written intermediate coordinates into `out`, so use the returned value to decide whether a result is valid.

For applicable projection paths, constructor options are defaults and per-call options override them. `radius` and `scale` multiply the planar coordinates; `falseEasting` and `falseNorthing` shift them; `yAxisDirection: 'southUp'` flips y. The defaults are zero false offsets and `'northUp'`. `raAxisDirection` defaults to `'east'`; `'west'` mirrors the projected right-ascension x direction. A negative or zero plane `radius` or `scale` makes projection return `undefined`.

For cylindrical projections, `centralMeridian` defaults to zero and `longitudeWrapMode` defaults to `'pi'`; `'tau'` uses `[0, 2π)`, while `'none'` leaves the longitude delta unwrapped. The `-π` and `+π` seam values can remain distinct in `'pi'` mode. Azimuthal projections instead use their constructor center and normalize inverse longitude to `[0, 2π)`; `centralMeridian` and `longitudeWrapMode` are not their centering or output-wrap controls. `maxLatitude` and `clampLatitude` apply where a cylindrical class calls the shared latitude conditioner; Web Mercator enables clamping in its constructor. `eccentricity`, `flattening`, and `sphericalOnly` select the ellipsoid model for `EllipsoidalMercator`, rather than changing every projection family.

## Batch projection

`projectMany(projection, points, options?, out?)` projects an array whose input points store `{ x: longitude, y: latitude }` in radians. It returns the supplied `out` array when successful, growing it as needed, or `undefined` at the first unsupported point. Earlier elements may already have been written on failure, and a reused `out` longer than the input is not shortened.

`projectMany` treats each point independently. For a connected line or polygon ring that crosses a map seam or projection boundary, use [Projected Paths and Polygons]({% link astronomy/coordinates-and-observers/projected-paths-and-polygons.md %}) to obtain drawable segments. Projection itself does not model time, atmospheric refraction, coordinate precession, or WCS distortion.

## Related topics

- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) prepares longitude and latitude in the needed celestial axes.
- [Constellations]({% link astronomy/coordinates-and-observers/constellations.md %}) can label sky directions before drawing them on a chart.
- [Projected Paths and Polygons]({% link astronomy/coordinates-and-observers/projected-paths-and-polygons.md %}) handles connected map geometry across seams and gaps.
