---
title: SPICE Text Kernels and Frames
layout: default
parent: Astronomy
nav_order: 90
description: Loads NAIF text PCK and FK assignments to resolve planetary frames and body radii.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/kernels/text.kernel.ts
    - src/astronomy/ephemeris/kernels/frame.kernel.ts
    - src/astronomy/ephemeris/kernels/naif.ts

api:
    - readTextKernel
    - SpiceKernelPool
    - SpiceFrames
    - bodyRadii
    - BodyRadii
    - Naif
---

# SPICE Text Kernels and Frames

`SpiceKernelPool` stores assignments from NAIF text PCK and frame kernels (FK). `SpiceFrames` resolves their frame definitions, optionally using a binary PCK for a rotating body. `bodyRadii` reads a text PCK's tri-axial radii. Use these APIs when a named SPICE frame or kernel-defined body shape is needed alongside an ephemeris.

## Basic usage

```ts
import fs from 'fs/promises';
import { readDaf } from '../src/astronomy/ephemeris/kernels/daf';
import { bodyRadii, SpiceFrames } from '../src/astronomy/ephemeris/kernels/frame.kernel';
import { Naif } from '../src/astronomy/ephemeris/kernels/naif';
import { readPck } from '../src/astronomy/ephemeris/kernels/pck';
import { readTextKernel, SpiceKernelPool } from '../src/astronomy/ephemeris/kernels/text.kernel';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { fileHandleSource } from '../src/io/io';

// Run from a repository checkout containing the lunar kernel fixtures.
const pool = new SpiceKernelPool();
await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'));
pool.load(await readTextKernel(fk));
await using textPck = fileHandleSource(await fs.open('data/pck00008.tpc'));
pool.load(await readTextKernel(textPck));

await using binaryPck = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'));
const pck = readPck(await readDaf(binaryPck));
const frames = new SpiceFrames(pool, pck);
const moonMe = await frames.frame('MOON_ME_DE421');
const radiiAu = bodyRadii(pool, Naif.MOON);
if (radiiAu === undefined) throw new Error('Moon radii are absent');

const instant = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TDB);
console.log(moonMe.rotationAt(instant), radiiAu);
```

`readTextKernel(source)` asynchronously parses a `KPL/PCK` or `KPL/FK` source into ordered assignments. The pool applies `=` by replacing a name and `+=` by appending values, including across files. Names are case-insensitive. Load the desired kernels before resolving frames: `SpiceFrames` caches resolved frames by integer ID. The pool's `get`, `numbers`, and `strings` methods inspect loaded assignments; `numbers` and `strings` filter values by type.

## Frame and radius conventions

`await frames.frame(nameOrId)` accepts a SPICE frame name or integer frame ID and returns a `Frame`. Frame ID `1` (`J2000`) is the identity base. Class-2 frames use a matching **frame class ID** from the supplied binary PCK; the segment must be relative to J2000. Class-4 text-kernel frames apply a constant `MATRIX` or `ANGLES` rotation relative to another resolved frame. `ANGLES` supports radians, degrees, and arcseconds from the kernel's `UNITS` entry. The resulting `rotationAt(time)` maps J2000-oriented vectors into the resolved frame's axes. When the frame chain includes a rotating PCK, its `dRdtTimesRtAt(time)` supplies the angular-rate operator in radians per day.

`bodyRadii(pool, body)` reads the first three numeric `BODY{body}_RADII` values. NAIF text PCK radii are in **kilometres**; the returned `{ x, y, z }` values are in **AU**, in the kernel's axis order. It returns `undefined` if the entry is missing or has fewer than three numeric values. `Naif` provides body identifiers such as `Naif.MOON`; an identifier alone does not evaluate a body state or orientation.

## Coverage and limitations

The text reader supports numeric values, quoted strings, lists, and Fortran `D` exponents in `\begindata` sections of `KPL/PCK` and `KPL/FK` files. It rejects `@` calendar-date values and malformed assignments. `SpiceFrames` supports J2000, class-2 binary PCK frames, and class-4 text-kernel `MATRIX` and `ANGLES` frames. Unknown frames, unsupported classes or units, missing binary PCK segments, and cyclic frame definitions throw.

Resolving a class-2 frame initializes its binary PCK segment metadata; coefficient records remain lazy. Keep the binary PCK's DAF source open while evaluating the resolved frame. Its time coverage and orientation accuracy come from that kernel.

## Related topics

- [Binary PCK Rotation]({% link astronomy/binary-pck-rotation.md %}) describes the rotating segment and its time coverage.
- [DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) describes binary kernel containers and translational states.
- [Planetary Surface Locations]({% link astronomy/coordinates-and-observers/planetary-surface-locations.md %}) uses a body shape and rotating frame to place a surface point.
