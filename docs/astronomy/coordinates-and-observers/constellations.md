---
title: Constellations
layout: default
parent: Coordinates and Observers
grand_parent: Astronomy
nav_order: 140
description: Finds the IAU constellation containing an equatorial direction using B1875 boundary data.

doc_kind: topic

sources:
    - src/astronomy/coordinates/constellation.ts

api:
    - constellation
    - Constellation
    - ConstellationIAU
    - CONSTELLATIONS
    - CONSTELLATION_LIST
---

# Constellations

`constellation(ra, dec, equinox?)` identifies which of the 88 IAU sky regions contains an equatorial direction. Use it to label a chart, catalog position, or target list. The boundary grid is defined for the **B1875 equator and equinox**; the function normally precesses input coordinates to that system before lookup.

## Basic usage

```ts
import { CONSTELLATIONS, constellation } from '../src/astronomy/coordinates/constellation';
import { Timescale, timeBesselianYear } from '../src/astronomy/time/time';
import { deg, hour } from '../src/math/units/angle';

const key = constellation(deg(135), deg(65)); // 'UMA' with the default J2000 equinox
const metadata = CONSTELLATIONS[key];
console.log(metadata.name, metadata.iau); // 'Ursa Major', 'UMa'

const b1875 = timeBesselianYear(1875, Timescale.TT);
const nearBorder = constellation(hour(6.24171), deg(3), b1875); // 'MON'
const alreadyB1875 = constellation(hour(6.24171), deg(3), false); // also 'MON'
```

Right ascension and declination inputs are in **radians**. The example uses `deg` and `hour` to convert familiar angular units. The function normalizes right ascension to `[0, 2π)` before lookup, so values such as −1 hour and 23 hours address the same direction. Supply declination within the sky range `[-π/2, π/2]`.

## Equinox and boundary convention

Omitting `equinox` selects **FK5 J2000.0 in TT**. For another FK5 equinox, pass its `Time`; the function converts the equinoxes to TT, forms an FK5 direction, and applies the IAU 2006 precession model to B1875 before searching the boundary grid. Passing the exact B1875 `Time`, or `false`, skips that precession. Use `false` only when `ra` and `dec` are already expressed on B1875 axes.

The input angles are treated as FK5 coordinates at the supplied equinox. A coordinate in ICRS, CIRS, or observed axes is not implicitly converted to FK5. Convert its frame first when a border-level distinction matters. `equinox` describes the coordinate axes, not a star's observation epoch: this lookup does not propagate proper motion, parallax, or a changing source position.

The B1875 right-ascension and declination edges are stored in hours and degrees internally; the lookup converts the caller's radians after precession. A position close to a constellation border can change classification if its equinox or frame is specified incorrectly. The function returns the embedded grid's `Constellation` key, not a boundary distance or a polygon.

## Result and metadata

`Constellation` is an uppercase three-letter key such as `UMA`, `ORI`, or `MON`. `CONSTELLATIONS[key]` provides `name`, the mixed-case IAU `iau` abbreviation (`ConstellationIAU`), Latin `genitive`, and a short `description`. `CONSTELLATION_LIST` contains the 88 keys in the metadata table's declaration order; it is not a sky-traversal order.

The whole-sky grid covers ordinary right ascensions and declinations, including the right-ascension wrap. At exact or rounded boundaries, the embedded grid and its search convention decide the returned side; retain sufficient coordinate precision when classifying positions near a border.

## Related topics

- [Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) explains FK5, ICRS frame bias, and precession.
- [Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) converts angular directions among equatorial and other axes.

## References

- [IAU constellation overview](https://iauarchive.eso.org/public/themes/constellations/) explains the official sky regions and Delporte boundaries.
- [CDS constellation identification table VI/42](https://cdsarc.cds.unistra.fr/viz-bin/ReadMe/VI/42?format=html&tex=true) documents B1875 right-ascension and declination boundary ranges for position lookup.
