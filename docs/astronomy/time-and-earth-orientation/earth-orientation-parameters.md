---
title: Earth Orientation Parameters
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 50
description: Loads IERS Earth-orientation bulletins and interpolates UT1 minus UTC and polar motion for time and frame calculations.

doc_kind: topic

sources:
    - src/astronomy/time/iers.ts

api:
    - Iers
    - IersBase
    - IersA
    - IersB
    - IersAB
    - iersa
    - iersb
    - iersab
    - dut1
    - xy
---

# Earth Orientation Parameters

IERS Earth-orientation records supply **DUT1 = UT1 − UTC** and polar motion `[x, y]`. Load a supported bulletin when a `Time` conversion or a celestial-to-terrestrial rotation needs measured Earth orientation. The readers use daily Modified Julian Date (MJD) samples and interpolate between them.

The shared readers start with empty tables. Until a bulletin is loaded, their DUT1 result is `0` seconds and polar motion is `[0, 0]` radians. Those are fallback values, not measurements. The default `TIME_PROVIDERS.dut1` and `TIME_PROVIDERS.pm` use these shared readers.

## Basic usage

```ts
import { iersa, iersab } from '../src/astronomy/time/iers';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';
import { readableStreamSource } from '../src/io/io';

// Supply a local IERS finals2000A file in the supported fixed-width format.
await using source = readableStreamSource(Bun.file('finals2000A.all').stream());
await iersa.load(source);

const instant = timeYMDHMS(2020, 10, 7, 12, 0, 0, Timescale.UTC);
const ut1MinusUtcSeconds = iersab.dut1(instant);
const [xRadians, yRadians] = iersab.xy(instant);
```

`iersa` is the shared Bulletin A reader. `iersb` is the shared C04 reader, and `iersab` chooses between them. With a newly loaded A table and an empty B table, the combined reader uses A. If both cover the requested date, it uses B.

## Readers and units

| API                                 | Contract                                                                                                                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IersBase`                          | Supplies table storage, interpolation, and edge handling for the concrete A and B readers.                                                                                         |
| `IersA`                             | Reads fixed-width `finals2000A` records. For each of x, y, and DUT1, it takes the finite final Bulletin B column when present, otherwise the Bulletin A rapid or predicted column. |
| `IersB`                             | Reads the supported fixed-width EOP 14 C04 (`eopc04`) records and skips `#` comments.                                                                                              |
| `IersAB(a, b)`                      | Chooses B when B covers the date, otherwise A when A covers it; outside both spans it chooses the table with the nearer edge, choosing B on an equal-distance tie.                 |
| `iersa`, `iersb`, `iersab`          | Shared instances used by the module-level `dut1(time)` and `xy(time)` functions.                                                                                                   |
| `dut1(time)` / reader `.dut1(time)` | UT1 − UTC, in **seconds**.                                                                                                                                                         |
| `xy(time)` / reader `.xy(time)`     | Polar-motion `[x, y]`, in **radians**. The file values are arcseconds.                                                                                                             |

In the IERS polar-motion convention, x and y locate the pole relative to a terrestrial reference pole: the x axis lies along the Greenwich meridian, and the y axis lies toward 90° west.

`IersA.load` and `IersB.load` accept an I/O `Source` or an array of already split lines. They read the input and replace that reader's table; `clear()` discards the loaded rows. `IersAB.load` throws `Error('not supported')`: load `iersa` and `iersb` separately. `iersab.clear()` clears both underlying readers. A record missing a finite MJD, x, y, or DUT1 is skipped; the loaders do not expose the files' LOD, celestial-pole offsets, flags, or uncertainties.

{: .important }
Pass a UTC `Time` to a direct `iersa`, `iersb`, or `iersab` lookup. These readers use the supplied `day` and `fraction` as a UTC MJD and do not convert another time scale first.

## Interpolation and fallback

Between table rows, x and y are linearly interpolated in their file units and converted to radians for the result. DUT1 is interpolated in seconds after subtracting the nearest integer second from the difference between successive samples. At a leap second, this keeps the step at the next tabulated row rather than spreading it across the preceding day.

Before the first row or after the last row, a reader returns its nearest edge value rather than extrapolating. When the selected table is empty, or a selected result cannot be formed from finite data, `.dut1` returns `0` and `.xy` returns `[0, 0]`. If only one shared table is loaded, `iersab` uses that table, including its edge values outside coverage.

{: .warning }
An edge value far outside a bulletin's dates can be stale, even though it is finite. Check the bulletin span before relying on a result for an observation. Loading or clearing tables after orientation values have been computed does not invalidate an existing `Time.cache`; construct a fresh `Time` for new results.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) uses DUT1 for UTC and UT1 conversion.
- [Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) uses UT1 and polar motion in sidereal angles and terrestrial matrices.
- [Delta T]({% link astronomy/time-and-earth-orientation/delta-t.md %}) estimates TT − UT1 independently of these measured offsets.

## References

- [USNO `finals2000A` format description](https://maia.usno.navy.mil/ser7/readme.finals2000A) specifies the Bulletin A and final Bulletin B columns read by `IersA`.
- [IERS EOP 14 C04 product metadata](https://datacenter.iers.org/productMetadata.php?id=221) describes the daily C04 Earth-orientation series. The loader implements the fixed-width layout in `iers.ts`; check that a downloaded file matches it.
- [IERS Technical Note 16, section IV](https://www.iers.org/SharedDocs/Publikationen/EN/IERS/Publications/tn/TechnNote16/tn16_4.pdf?__blob=publicationFile&v=2) defines the polar-motion x and y directions.
