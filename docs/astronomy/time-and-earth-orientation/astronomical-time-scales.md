---
title: Astronomical Time Scales
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 10
description: Represents one instant as a two-part Julian Date and converts it among UT1, UTC, TAI, TT, TCG, TDB, and TCB.

doc_kind: topic

sources:
    - src/astronomy/time/time.ts
    - src/astronomy/time/iers.ts

api:
    - Timescale
    - Time
    - TimeCache
    - TimeProviders
    - TimeDelta
    - JulianCalendarCutOff
    - time
    - timeNormalize
    - timeFromEpoch
    - timeUnix
    - timeNow
    - timeMJD
    - timeJulianYear
    - toJulianEpoch
    - timeBesselianYear
    - timeYMD
    - timeYMDHMS
    - timeGPS
    - timeConvert
    - ut1
    - utc
    - tai
    - tt
    - tcg
    - tdb
    - tcb
    - timeSubtract
    - timeShift
    - timeAtJulianDay
    - timeToDate
    - timeToUnix
    - timeToUnixMillis
    - toJulianDay
    - dut1
    - taiMinusUtc
    - ut1MinusTai
    - tdbMinusTt
    - tdbMinusTtByFairheadAndBretagnon1990
    - TIME_PROVIDERS
---

# Astronomical Time Scales

A `Time` is one instant stored as an integer Julian Date `day` plus a `fraction` of a day, tagged with the `Timescale` it was constructed on. Build one when an ephemeris, a civil timestamp, or a scale conversion has to keep that instant from collapsing into a single floating-point Julian Date.

This implementation uses the ERFA timescale chain: leap seconds between UTC and TAI, the constant TT − TAI offset, the IAU linear rates between TT and TCG and between TDB and TCB, and ERFA's TDB − TT series. Use it when the result has to be one of UT1, UTC, TAI, TT, TCG, TDB, or TCB. Wall-clock formatting that ignores leap seconds is a different API. `timeUnix` counts 86400 SI seconds per UTC day; it is neither POSIX Unix time nor GPS time.

## Background

The seven scales name different physical clocks.

| Scale | What it measures                                                                  |
| ----- | --------------------------------------------------------------------------------- |
| UT1   | Earth rotation. Offset from UTC by DUT1.                                          |
| UTC   | Civil atomic time with leap seconds.                                              |
| TAI   | Continuous International Atomic Time.                                             |
| TT    | Terrestrial Time, TAI + 32.184 s.                                                 |
| TCG   | Geocentric Coordinate Time. TT runs slow relative to TCG by `L_G`.                |
| TDB   | Barycentric Dynamical Time. Periodic difference from TT at the millisecond level. |
| TCB   | Barycentric Coordinate Time. TDB runs slow relative to TCB by `L_B`.              |

TT − TAI is the constant `TTMINUSTAI` of 32.184 s. `L_G` is `ELG` (6.969290134e-10) and `L_B` is `ELB` (1.550519768e-8), with `L_G = 1 − d(TT)/d(TCG)` and `L_B = 1 − d(TDB)/d(TCB)`. The TDB/TCB origin offset is `TDB0` (−65.5 µs) at TAI 1977-01-01.0. Those rates are the ERFA definitions used by the converters.

A summed Julian Date near J2000 cannot represent microseconds. The split keeps the day and the fraction apart so a later subtraction can still see them.

## When to use

Construct a `Time` for an ephemeris epoch, or convert a civil UTC timestamp to TT or TDB before calling one.

Set `Time.location` before a TT ↔ TDB conversion when the caller is a site on the Earth. Leave it unset for the geocentric TDB − TT series.

Pass `tdbMinusTtByFairheadAndBretagnon1990` through `Time.providers.tdbMinusTt` only when that short series is the model you intend. It is not the default.

Sidereal time and the GCRS to ITRS matrices use the same `Time`. They are a separate capability.

## Basic usage

The smallest useful sequence is a civil UTC instant converted to TT. Noon UTC on 2020-01-01 is 37 s behind TAI, and TT is 32.184 s ahead of TAI, so the TT clock reads 12:01:09.184.

```ts
import { Timescale, timeToDate, timeYMDHMS, tt } from '../src/astronomy/time/time';

const utc = timeYMDHMS(2020, 1, 1, 12, 0, 0, Timescale.UTC);
const terrestrial = tt(utc);

timeToDate(utc);
// [2020, 1, 1, 12, 0, 0, 0]

timeToDate(terrestrial);
// [2020, 1, 1, 12, 1, 9, 184]
```

`tt(utc)` returns a new `Time` whose `scale` is `Timescale.TT`. Calling `tt` again on that result returns the same object.

### Leap-second UTC

On a positive leap-second day, `timeYMDHMS` accepts 23:59:60 UTC and `timeToDate` reads it back on that civil date. The 2016-12-31 leap second is 2017-01-01 00:00:36 TAI and 00:01:08.184 TT.

```ts
import { Timescale, tai, timeToDate, timeYMDHMS, tt } from '../src/astronomy/time/time';

const leap = timeYMDHMS(2016, 12, 31, 23, 59, 60, Timescale.UTC);

timeToDate(leap);
// [2016, 12, 31, 23, 59, 60, 0]

timeToDate(tai(leap));
// [2017, 1, 1, 0, 0, 36, 0]

timeToDate(tt(leap));
// [2017, 1, 1, 0, 1, 8, 184]
```

Other scales always treat the day as 86400 s. On those scales, a `second` of 60 is just the next midnight.

## API

`timeConvert(time, scale)` dispatches to `ut1`, `utc`, `tai`, `tt`, `tcg`, `tdb`, or `tcb`. If `time.scale` is already `scale`, it returns `time`.

| Field       | Unit            | Meaning                                                                                                                                         |
| ----------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `day`       | Julian Date day | Integer day number after normalization.                                                                                                         |
| `fraction`  | day             | Fraction in `[-0.5, 0.5)`. `+0.5` becomes the next day at `-0.5`.                                                                               |
| `scale`     | `Timescale`     | The scale of this `day` and `fraction`. JSON stores the enum number.                                                                            |
| `providers` |                 | Optional replacements for DUT1, TDB − TT, UT1 − TAI, and Earth-orientation models. Omitted fields use `TIME_PROVIDERS`.                         |
| `location`  |                 | Optional geographic position. Used for topocentric TDB − TT. Longitude is east-positive radians, latitude north-positive radians, elevation AU. |
| `cache`     |                 | Memoized conversions and scale offsets. Filled by the converters.                                                                               |

`Timescale` numbers, as stored in JSON, are UT1 `0`, UTC `1`, TAI `2`, TT `3`, TCG `4`, TDB `5`, TCB `6`.

### Constructors

Every constructor returns a normalized `Time`. The default scale is UTC except for the Julian and Besselian year constructors, which default to TT.

| Function                                                          | Default scale | Meaning                                                                                                                               |
| ----------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `time(day, fraction?)`                                            | UTC           | Julian Date split into day and fraction. A single full Julian Date may be passed as `day`.                                            |
| `timeNormalize(day, fraction, divisor?)`                          | UTC           | Compensated split of `day + fraction`. A nonzero `divisor` divides that sum first: `86400` turns a second count into days.            |
| `timeFromEpoch(epoch, unit, day, fraction?, scale?)`              | UTC           | `epoch / unit` days added to the base Julian `day` and `fraction`. `unit` is the number of epoch steps in one day.                    |
| `timeUnix(seconds, fast?)`                                        | UTC           | Seconds from 1970-01-01 00:00:00 UTC. `fast` truncates the day count instead of using the compensated split.                          |
| `timeNow(fast?)`                                                  | UTC           | `timeUnix(Date.now() / 1000, fast)`.                                                                                                  |
| `timeMJD(mjd, scale?)`                                            | UTC           | Days since 1858-11-17 00:00. MJD 51544 is 2000-01-01 00:00.                                                                           |
| `timeYMD(year, month?, day?, fraction?, scale?)`                  | UTC           | Civil date. `fraction` is the day fraction from midnight (`0.5` is noon).                                                             |
| `timeYMDHMS(year, month?, day?, hour?, minute?, second?, scale?)` | UTC           | Civil date and clock. `second` may be fractional.                                                                                     |
| `timeJulianYear(epoch, scale?)`                                   | TT            | Julian epoch, 365.25 d from J2000.0 (JD 2451545.0 TT).                                                                                |
| `toJulianEpoch(time)`                                             |               | Inverse Julian epoch, always from the instant converted to TT.                                                                        |
| `timeBesselianYear(epoch, scale?)`                                | TT            | Besselian epoch from B1900 using a tropical year of 365.242198781 d.                                                                  |
| `timeGPS(seconds)`                                                | TAI           | Seconds from 1980-01-06 00:00:00 UTC, stored on TAI. At the GPS epoch, TAI is 19 s ahead of GPS; that offset is encoded in the epoch. |

`timeYMD` and `timeYMDHMS` parse the calendar with ERFA's Gregorian `eraCalToJd`. `JulianCalendarCutOff` is exported and unused: it does not select a Julian or Gregorian cutover.

### Intervals and readout

| Function                                | Result                   | Meaning                                                                                                       |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `timeSubtract(a, b, scale?)`            | days                     | `a − b` after both instants are converted to `scale` (default `a.scale`).                                     |
| `timeShift(time, fraction)`             | `Time`                   | The same scale, `fraction` days later. Copies `providers` and `location`.                                     |
| `timeAtJulianDay(reference, julianDay)` | `Time`                   | `timeShift` to that summed Julian Date, keeping the reference scale and providers.                            |
| `toJulianDay(time)`                     | days                     | `day + fraction`. This sum drops the low bits the split was keeping.                                          |
| `timeToDate(time)`                      | `[Y, M, D, h, m, s, ms]` | Civil clock of `time.scale`. Milliseconds are truncated. UTC inverts the leap-second day, including 23:59:60. |
| `timeToUnix(time)`                      | s                        | UTC equivalent, truncated to an integer second.                                                               |
| `timeToUnixMillis(time)`                | ms                       | UTC equivalent, truncated to an integer millisecond.                                                          |

### Scale offsets

Offsets are seconds. `dut1`, `taiMinusUtc`, and `ut1MinusTai` cache their results, including a result of zero.

| Function                               | Definition | When it is not the conversion                                                                                                                                          |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dut1`                                 | UT1 − UTC  | From the IERS provider. `0` until a bulletin is loaded, so UT1 then tracks UTC. Near a leap second on a UT1 instant, the value is recomputed on the matching UTC date. |
| `taiMinusUtc`                          | TAI − UTC  | ERFA `eraDat` on the UTC civil date. Not pluggable.                                                                                                                    |
| `ut1MinusTai`                          | UT1 − TAI  | `dut1 − (TAI − UTC)` on that same UTC date.                                                                                                                            |
| `tdbMinusTt`                           | TDB − TT   | Default ERFA `eraDtDb`. Returns `0` unless the argument is already TT or TDB. Topocentric when `location` is set; otherwise geocentric.                                |
| `tdbMinusTtByFairheadAndBretagnon1990` | TDB − TT   | Optional series. Returns `0` unless the argument is already TT or TDB.                                                                                                 |

Assign a partial `providers` object. Missing fields keep the `TIME_PROVIDERS` default. There is no provider for TAI − UTC.

```ts
instant.providers = { dut1: () => -0.2 };
```

The converters store `providers` with `enumerable: false`. `structuredClone` then copies the instant and omits `providers`. A plain enumerable assignment still drives conversions, and `structuredClone` throws `DataCloneError` because the provider functions cannot be cloned. `JSON.stringify` keeps `day`, `fraction`, `scale`, `location`, and the numeric cache offsets. It drops provider functions and the cached `Time` objects for other scales.

**Mutation:** conversion fills `cache` on the input. It does not change `day`, `fraction`, or `scale`.\
**Allocation:** a new `Time` when the scale changes; the same object when it does not. `timeShift` always allocates and does not share the cache.\
**Aliasing:** a converted `Time` shares `cache` with the input and copies `location`.

## How it works

UTC ↔ TAI applies the leap-second table. TAI ↔ TT adds or removes 32.184 s. TT ↔ TCG and TDB ↔ TCB apply `L_G` and `L_B` from 1977-01-01.0 TAI. TT ↔ TDB calls the `tdbMinusTt` provider, which by default evaluates `eraDtDb` after approximating the UT1 fraction of the day. Any other scale reaches these pairs by converting to TAI, TT, or TDB first.

`timeUnix` itself does not consult the leap-second table. `timeToUnix` and `timeToUnixMillis` first convert a non-UTC input to UTC, and that conversion uses the leap-second table. The final mapping then treats the resulting UTC date as 86400 seconds per civil day, so a leap second is not an extra Unix second. POSIX Unix time repeats one second at a positive leap, so the two counters differ by up to one second on that day. `timeGPS` is a TAI count from the GPS epoch, not a `timeUnix` count.

## Accuracy and limitations

{: .accuracy }
The embedded TAI − UTC table matches ERFA `dat.c` in this tree and ends at 2017 January with TAI − UTC = 37 s. Later dates keep 37 s until that table changes. No leap second after 2016-12-31 is applied.

{: .accuracy }
With no IERS bulletin loaded, DUT1 is 0 and UT1 matches UTC. A loaded table is linearly interpolated. Outside its span the value clamps to the nearest edge; it is not extrapolated. Polar motion stays zero in that same unloaded state, which matters for orientation and not for these scale conversions.

{: .accuracy }
Default TDB − TT is ERFA `eraDtDb`: the `FAIRHEAD` coefficient series, the topocentric terms cited in that function as Moyer (1981) and Murray (1983), and a small adjustment to JPL planetary masses. The geocentric call leaves the topocentric terms at zero; a `location` supplies them. `tdbMinusTtByFairheadAndBretagnon1990` is the separate short series written as USNO Circular 179 equation 2.6. TT and TDB stay within about 2 ms, which is why that short series accepts either scale. It is not a substitute for `eraDtDb`.

{: .important }
`toJulianEpoch` converts to TT before measuring the Julian year. A Julian year constructed on UTC does not invert back to the same number.

{: .warning }
`timeToDate` truncates the millisecond. A civil second that is not an exact binary fraction of the day can read back 1 ms low: `timeYMDHMS(1980, 1, 6, 0, 0, 19, Timescale.TAI)` and `timeGPS(0)` are the same instant, and both read as 00:00:18.999 on that TAI clock.

The compensated split is built for sums below about `1e16` days. Above that, the remainder can exceed one day. Subtract instants with `timeSubtract`, or with separate `day` and `fraction` terms. Subtracting two `toJulianDay` values discards the fraction bits the split preserved.

## References

- ERFA (SOFA) routines `eraDat`, `eraCalToJd`, `eraJdToCal`, and the TT/TCG/TDB/TCB converters.
- `eraDtDb`, whose periodic series is the `FAIRHEAD` table. Its topocentric terms cite Moyer (1981) and Murray (1983).
- IERS Bulletins A and B for UT1 − UTC. The loader lives with the Earth-orientation parameters.
- USNO Circular 179, equation 2.6, as coded in `tdbMinusTtByFairheadAndBretagnon1990`.
