---
title: Civil UTC Timestamps
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 30
description: Handles proleptic-Gregorian UTC dates as Unix-millisecond numbers, with calendar arithmetic and fixed-pattern parsing and formatting.

doc_kind: topic

sources:
    - src/astronomy/time/temporal.ts

api:
    - Temporal
    - TemporalDate
    - TemporalUnit
    - TemporalUnitShort
    - temporalNow
    - temporalUnix
    - temporalFromDate
    - temporalToDate
    - temporalFromTime
    - temporalFromFractionOfYear
    - temporalAdd
    - temporalSubtract
    - temporalStartOfDay
    - temporalEndOfDay
    - temporalDayOfWeek
    - zellersCongruence
    - temporalGet
    - temporalSet
    - formatTemporal
    - formatTemporalFromPattern
    - parseTemporal
    - isLeapYear
    - daysInMonth
    - DATE_FORMAT
    - TIME_FORMAT
    - DATE_TIME_FORMAT
    - ISO8601_FORMAT
    - TIMEZONE
---

# Civil UTC Timestamps

`Temporal` is a `number` of milliseconds since 1970-01-01 00:00:00 UTC. Use it for civil timestamps, calendar arithmetic, and display or parsing. It is a fixed 86400-second-per-day counter on a proleptic Gregorian calendar; it cannot represent 23:59:60, UT1, or an astronomical timescale on its own.

Use [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) when the distinction between UTC, UT1, TT, or leap seconds matters. `temporalFromTime` delegates to `timeToUnixMillis`, which converts an astronomical `Time` to UTC and truncates it to an integer millisecond on this civil counter.

## Basic usage

```ts
import { formatTemporal, ISO8601_FORMAT, parseTemporal, temporalAdd, temporalFromDate, temporalToDate } from '../src/astronomy/time/temporal';

const stamp = temporalFromDate(2024, 1, 31, 12, 30);
const nextMonth = temporalAdd(stamp, 1, 'mo');
temporalToDate(nextMonth);
// [2024, 2, 29, 12, 30, 0, 0]

const text = formatTemporal(nextMonth, ISO8601_FORMAT);
// '2024-02-29T12:30:00.000Z'
parseTemporal(text, ISO8601_FORMAT) === nextMonth;
// true
```

`temporalAdd` and `temporalSubtract` use fixed millisecond durations for milliseconds through weeks. Month and year changes are calendar operations: they retain the clock and clamp the day to the destination month's last day.

## Representation and calendar operations

`TemporalDate` is `[year, month, day, hour, minute, second, millisecond]`, with a 1-based month and day, a 24-hour clock, and millisecond values from 0 to 999. `temporalFromDate` constructs a timestamp from these fields; omitted fields default to January 1 at midnight. `temporalToDate` returns the seven UTC fields. Years use the proleptic Gregorian calendar, including year 0 and negative years.

| Function                                                           | Behavior                                                                                         |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `temporalNow()`                                                    | Current timestamp from `Date.now()`, in milliseconds.                                            |
| `temporalUnix(seconds)`                                            | Multiplies a Unix-second count by 1000.                                                          |
| `temporalFromTime(time)`                                           | Converts an astronomical `Time` to UTC and truncates its Unix-style counter to milliseconds.     |
| `temporalFromFractionOfYear(year, days)`                           | Converts a **1-based** fractional day of the year; rounds the result to the nearest millisecond. |
| `temporalAdd(stamp, amount, unit)` / `temporalSubtract(...)`       | Adds or subtracts a fixed unit or changes the calendar month or year.                            |
| `temporalStartOfDay(stamp)`                                        | UTC midnight at the start of the containing day.                                                 |
| `temporalEndOfDay(stamp)`                                          | 23:59:59.999 UTC of the containing day.                                                          |
| `temporalDayOfWeek(stamp)` / `zellersCongruence(year, month, day)` | Weekday number, Sunday `0` through Saturday `6`. `zellersCongruence` also accepts a date tuple.  |
| `temporalGet(stamp, unit)` / `temporalSet(stamp, value, unit)`     | Reads or replaces a UTC field. Setting month or year clamps the day if necessary.                |
| `isLeapYear(year)` / `daysInMonth(year, month)`                    | Gregorian leap-year rule and month length.                                                       |

`TemporalUnit` names are `millisecond`, `second`, `minute`, `hour`, `day`, `week`, `month`, and `year`; `TemporalUnitShort` uses `ms`, `s`, `m`, `h`, `d`, `w`, `mo`, and `y`. For `temporalGet`, `w`/`week` means the weekday number. `temporalSet` has no week-field branch and returns the original timestamp for that unit.

{: .important }
`temporalFromTime` delegates to `timeToUnixMillis`. A non-UTC `Time` can use the leap-second table while converting to UTC; the resulting `Temporal` still has a fixed 86400-second civil day and cannot retain a leap-second label.

## Formatting and parsing

`formatTemporal(stamp, pattern?, timezone?)` defaults to `DATE_TIME_FORMAT` and a UTC offset of `0`. It also accepts a `TemporalDate` tuple. The numeric `timezone` is an offset **in minutes east of UTC** applied before formatting; `true` selects the process offset `TIMEZONE`, captured once when the module loads. If `format` is an `Intl.DateTimeFormat`, that formatter controls the time zone and the `timezone` argument is not used.

`formatTemporalFromPattern(stamp, pattern, timezone?)` performs the same pattern formatting and also defaults to UTC (`timezone = 0`). The predefined patterns are `DATE_FORMAT` (`YYYY-MM-DD`), `TIME_FORMAT` (`HH:mm:ss.SSS`), `DATE_TIME_FORMAT` (`YYYY-MM-DD HH:mm:ss.SSS`), and `ISO8601_FORMAT` (`YYYY-MM-DDTHH:mm:ss.SSSZ`). The `Z` is a literal character, not a computed offset: keep the zero timezone when formatting that pattern.

| Pattern field                   | Output                                                    | Parse support    |
| ------------------------------- | --------------------------------------------------------- | ---------------- |
| `YYYY`, `YY`                    | Padded year, or two-digit year. `YY` parses as 2000–2099. | Yes              |
| `MMMM`, `MMM`, `MM`, `M`        | Full name, short name, padded number, number.             | `MMM` and `MM`   |
| `WW`, `W`                       | Full or abbreviated weekday name.                         | No               |
| `DD`, `D`                       | Padded or unpadded day.                                   | `DD`             |
| `HH`, `H`; `mm`, `m`; `ss`, `s` | Padded or unpadded clock fields.                          | `HH`, `mm`, `ss` |
| `SSS`, `S`                      | Padded or unpadded millisecond.                           | `SSS`            |

`parseTemporal(input, pattern)` reads fixed-width fields into a UTC timestamp. Missing fields retain the default 1970-01-01 00:00:00.000, and input beyond the pattern is ignored. It checks literal characters and rejects invalid parsed month, day, hour, minute, second, or millisecond fields; a second of `60` is rejected. An input that ends before a token is complete stops parsing and leaves remaining fields at their defaults, so callers requiring a complete timestamp must check its expected length separately.

## Limitations

{: .warning }
`ISO8601_FORMAT` with a nonzero `timezone` prints a shifted clock followed by a literal `Z`, which labels that clock as UTC incorrectly. Keep the default timezone with either formatter, or pass `0` explicitly.

The custom pattern parser is a subset of the formatter. In particular, weekday names, full month names, and one-letter numeric fields are for output; parsing those tokens throws. `Intl.DateTimeFormat` follows the platform's locale and time-zone behavior independently of the custom patterns.
