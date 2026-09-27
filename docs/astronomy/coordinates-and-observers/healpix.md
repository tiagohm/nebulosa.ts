---
title: HEALPix
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 240
description: Divides equatorial sky positions into HEALPix pixels and queries an in-memory spatial index.

doc_kind: topic

sources:
    - src/astronomy/sky/spatial/healpix.ts

api:
    - HealpixId
    - HealpixOrdering
    - HealpixCoverOptions
    - HealpixIndexOptions
    - HealpixInsertObject
    - coordToPixel
    - pixelToCenter
    - pixelToBoundary
    - nestedToRing
    - ringToNested
    - circleToPixels
    - triangleToPixels
    - polygonToPixels
    - HealpixIndex
---

# HEALPix

HEALPix partitions the sphere into twelve base faces and subdivides each face at a chosen `nside`. Use the pixel functions to group equatorial positions or find pixels that may intersect a sky region. Use `HealpixIndex` to retain objects in pixel buckets and query their positions.

## Pixel coordinates and ordering

```ts
import { circleToPixels, coordToPixel, HealpixIndex, pixelToCenter } from '../src/astronomy/sky/spatial/healpix';
import { deg } from '../src/math/units/angle';

const index = new HealpixIndex<{ label: string }>({ nside: 8 });
index.add('near', deg(2), deg(1), { label: 'A' });
index.add('far', deg(30), 0, { label: 'B' });

const pixel = coordToPixel(8, deg(2), deg(1));
const center = pixelToCenter(8, pixel);
const candidatePixels = circleToPixels(8, 0, 0, deg(5));
const matches = index.queryCone(0, 0, deg(5));
console.log(
	pixel,
	center,
	candidatePixels.length,
	matches.map((entry) => entry.id),
);
```

Angles are radians: longitude is equatorial right ascension and latitude is declination. Finite right ascension is normalized to `[0, 2π)`; declination must lie in `[-π/2, π/2]`, allowing a tiny rounding tolerance at the endpoints. Supply coordinates in the same celestial frame and epoch for meaningful spatial comparisons; pixelization does not transform them.

`nside` must be a power of two from `1` through `2^24`. The pixel indices run from `0` to `12 × nside² − 1`. The default ordering is `'nested'`, which groups subdivisions within each base face. Pass `'ring'` when an external pixel number uses the iso-latitude ordering. `nestedToRing` and `ringToNested` convert indices at the same `nside`; pass the ordering to `coordToPixel`, `pixelToCenter`, and `pixelToBoundary` consistently. `pixelToCenter` returns `[rightAscension, declination]`; `pixelToBoundary` returns four such corner pairs in face-local order. The pixel center is a representative direction, not the original input position.

## Covers and region queries

`circleToPixels`, `triangleToPixels`, and `polygonToPixels` return **conservative pixel covers**. They may include pixels with no point inside the requested region. The default output resolution and ordering match the supplied `nside` and nested ordering. `HealpixCoverOptions` can set `targetNside`, `maxDepth`, and output `ordering`; reducing depth makes a coarser cover. The `conservative` property is accepted but the current implementation uses conservative covers regardless of its value.

Circle radius is in radians and must be finite and within `[0, π]`. Triangle and polygon vertices are `[rightAscension, declination]` pairs in radians. Supply ordered vertices forming a convex spherical region; degenerate or nonconvex regions throw. A repeated closing vertex is accepted and removed while building the region. A box is available through the index and may cross the right-ascension zero seam.

`HealpixIndex` uses a cover to find candidate buckets, then tests each candidate object's direction against the requested cone, triangle, polygon, or box. Thus an index query returns position matches within its geometric boundary tolerance, rather than every object in a covered pixel. `queryCone`, `queryTriangle`, `queryPolygon`, and `queryBox` return arrays of stored entries. `queryRegion` accepts the corresponding `StarCatalogQuery` discriminated union. `streamRegion` yields the already collected `queryRegion` results; it is an in-memory iterator. Query cover options may change search depth, but the index uses its own `nside` and ordering for its buckets even if the options request another resolution or ordering.

## Maintaining an index

Construct `HealpixIndex` with `{ nside, ordering? }`, then add objects with `add(id, rightAscension, declination, metadata?)` or `addMany(objects)`. IDs can be numbers, strings, or bigints. Adding an existing ID updates its position; `addMany` validates its whole batch before changing the index. `size`, `get`, `update`, `remove`, and `clear` manage the entries. `update` returns `undefined` for a missing ID, and `remove` returns `false` for one. Omitting metadata on an update retains the existing metadata.

The index caches each object's unit vector and pixel alongside its angles. Returned entries refer to the stored objects; change a position through `update` or `add` so those cached values and the bucket stay synchronized. Keep `nside` modest for broad regions: the number of pixels in a full cover grows as `12 × nside²`, and `HealpixIndex` holds its entries in memory.

## Related topics

- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) prepares directions in the required equatorial axes.
- [Sky Projections]({% link astronomy/coordinates-and-observers/sky-projections.md %}) draws sky directions on a plane after spatial selection.
