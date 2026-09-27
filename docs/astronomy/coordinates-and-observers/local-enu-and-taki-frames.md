---
title: Local ENU and Taki Frames
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 190
description: Converts horizontal directions to east-north-up vectors and rotates equatorial or Taki vectors into local axes.

doc_kind: topic

sources:
    - src/astronomy/coordinates/frame.local.ts

api:
    - horizontalToEnuVector
    - enuVectorToHorizontal
    - equatorialToEnuMatrix
    - enuToEquatorialMatrix
    - takiToEnuMatrix
    - enuToTakiMatrix
---

# Local ENU and Taki Frames

These helpers express local sky directions as Cartesian **east, north, up** (ENU) vectors. They also provide rotation matrices between ENU, equatorial axes, and Taki's local equatorial axes used by mount geometry. Use vectors and matrices when a mount, guider, or geometric model needs components rather than azimuth and altitude alone.

## Basic usage

```ts
import { eraS2c } from '../src/astronomy/coordinates/erfa/erfa';
import { enuToTakiMatrix, enuVectorToHorizontal, equatorialToEnuMatrix, horizontalToEnuVector, takiToEnuMatrix } from '../src/astronomy/coordinates/frame.local';
import { matMulVec } from '../src/math/linear-algebra/mat3';
import { deg } from '../src/math/units/angle';

const latitude = deg(-23.55);
const lst = deg(140); // local apparent sidereal angle
const equatorial = eraS2c(deg(95), deg(-16.7));
const enu = matMulVec(equatorialToEnuMatrix(latitude, lst), equatorial);
const horizontal = enuVectorToHorizontal(enu);
const rebuiltEnu = horizontalToEnuVector(horizontal.azimuth, horizontal.altitude);

const taki = matMulVec(enuToTakiMatrix(latitude), enu);
const restoredEnu = matMulVec(takiToEnuMatrix(latitude), taki);
console.log(horizontal, rebuiltEnu, restoredEnu);
```

All angles are **radians**. `horizontalToEnuVector(azimuth, altitude, out?)` returns a unit direction `[east, north, up]`: azimuth is measured from north through east, and altitude is above the horizon. East on the horizon is `[1, 0, 0]`, north is `[0, 1, 0]`, and zenith is `[0, 0, 1]`. `enuVectorToHorizontal(vector)` accepts a nonzero ENU direction and returns `{ azimuth, altitude }`, with azimuth normalized to `[0, 2π)`. It throws a `RangeError` for a zero vector. At zenith or nadir, where azimuth is undefined, it reports azimuth `0`; it also uses `0` when the horizontal component is at most `10⁻¹⁵` of the vector length.

## Rotation matrices

| Matrix                                 | Direction                                          |
| -------------------------------------- | -------------------------------------------------- |
| `equatorialToEnuMatrix(latitude, lst)` | Equatorial Cartesian vector → ENU.                 |
| `enuToEquatorialMatrix(latitude, lst)` | ENU → equatorial; transpose of the forward matrix. |
| `takiToEnuMatrix(latitude)`            | Taki local equatorial vector → ENU.                |
| `enuToTakiMatrix(latitude)`            | ENU → Taki; transpose of the forward matrix.       |

Each matrix is a flat row-major 3 × 3 proper rotation. Apply it with `matMulVec`; it rotates components without changing a vector's origin or length. `latitude` is north-positive geodetic latitude. The equatorial input uses Cartesian components `[cos δ cos α, cos δ sin α, sin δ]`, and `lst` must match the input right ascension's equinox. The equatorial-to-ENU matrix agrees with [Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) for the same angles and sidereal time.

Taki axes are `[meridian south, east, north celestial pole]`. A **west-positive** hour angle `H` has Taki polar longitude `−H`, so its Taki east-axis component is negative when the direction lies west of the meridian. Unlike the equatorial matrix, the Taki-to-ENU matrix depends on latitude alone because hour angle is already encoded in the Taki vector.

All six helpers are geometric: they do not apply atmospheric refraction, parallax, or astrometric place corrections. Obtain an appropriately reduced direction before using the equatorial matrix when those effects matter. The vector conversion returns a fresh vector unless `out` is supplied; with `out`, it fills and returns that same vector. Each matrix builder likewise fills and returns `out` when supplied, or allocates a new matrix otherwise.

## Related topics

- [Location GCRS Frame]({% link astronomy/coordinates-and-observers/location-gcrs-frame.md %}) rotates GCRS-oriented vectors into local north, east, and up axes.
- [Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) reduces stellar directions to observed angles, with optional refraction.
