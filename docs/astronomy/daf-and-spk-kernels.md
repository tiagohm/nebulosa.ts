---
title: DAF and SPK Kernels
layout: default
parent: Astronomy
nav_order: 70
description: Reads a NAIF DAF container and evaluates supported SPK segments as center-to-target states.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/kernels/daf.ts
    - src/astronomy/ephemeris/kernels/spk.ts

api:
    - readDaf
    - Daf
    - readSpk
    - Spk
    - SpkSegment
    - SPK_FRAME_J2000
---

# DAF and SPK Kernels

`readDaf` parses the random-access DAF container used by NAIF kernels from a supplied byte source. `readSpk` interprets an SPK's segment summaries and lets a caller evaluate the state of a target relative to a center. Supply the center and target NAIF IDs explicitly; the returned segment retains the reference frame recorded in the kernel.

## Basic usage

```ts
import fs from 'fs/promises';
import { readDaf } from '../src/astronomy/ephemeris/kernels/daf';
import { Naif } from '../src/astronomy/ephemeris/kernels/naif';
import { readSpk, SPK_FRAME_J2000 } from '../src/astronomy/ephemeris/kernels/spk';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { fileHandleSource } from '../src/io/io';

// Run from a repository checkout containing the DE421 fixture.
await using source = fileHandleSource(await fs.open('data/de421.bsp'));
const spk = readSpk(await readDaf(source));
const segment = await spk.segment(Naif.SSB, Naif.EMB);
if (segment === undefined) throw new Error('Earth-Moon barycenter segment is absent');
if (segment.frame !== SPK_FRAME_J2000) throw new Error('segment needs a frame conversion');

const instant = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB);
const [positionAu, velocityAuPerDay] = segment.at(instant);
console.log(positionAu, velocityAuPerDay);
```

`readDaf(source)` is asynchronous and requires a seekable byte source. It parses the DAF file record and named segment summaries, handling either byte order. The resulting `Daf` keeps the source for later random-access reads; keep that source open until all segment evaluations are finished. Its `read(start, end)` and `readSync(start, end)` use **inclusive, one-based double-word addresses**. Truncated records and a missing DAF/ FTP validation string throw instead of producing a partial record. A DAF may hold an SPK or another kernel type, such as a binary PCK; `readDaf` alone does not make its contents an ephemeris.

`readSpk(daf)` builds a reusable lookup. `await spk.segment(center, target)` returns an initialized segment or `undefined` when that pair is absent. The subsequent `segment.at(time)` call is synchronous and converts the supplied `Time` to **TDB** before evaluating a covered epoch. Types 2, 3, and 21 read coefficient records on demand during `at`, so their backing source must support synchronous reads. Type 9 loads its state and epoch tables during asynchronous initialization. If the time is outside segment coverage, `at` throws. For overlapping segments of the same center and target, the last matching segment in file order takes precedence.

## State units, frames, and supported segments

SPK positions use kilometres and velocities, when stored, use kilometres per second. **`SpkSegment.at` returns position in AU and velocity in AU/day**, as `[position, velocity]`. Both vectors are in the segment's recorded NAIF `frame`; this reader does not rotate them. `SPK_FRAME_J2000` is frame ID `1`, the orientation accepted by the library's ephemeris-path adapter as its base. Inspect `segment.frame` before combining a state with ICRS/BCRS-oriented vectors; other frame IDs require an appropriate rotation outside this reader.

The reader implements SPK types **2** and **3** (Chebyshev), **9** (Lagrange), and **21** (modified difference arrays). Unsupported binary SPK types cause `readSpk` to throw when it builds their segments. Type 2 derives velocity from the position polynomial; type 3 uses stored velocity coefficients. The public state is a center-to-target state for one segment, not an automatically chained state from arbitrary bodies to the solar-system barycenter.

## Related topics

- [Low-Precision Earth Ephemeris]({% link astronomy/low-precision-earth-ephemeris.md %}) provides analytical Earth states without loading an SPK.
- [Planetary Surface Locations]({% link astronomy/coordinates-and-observers/planetary-surface-locations.md %}) can combine a body-center state with a rotating surface point.
