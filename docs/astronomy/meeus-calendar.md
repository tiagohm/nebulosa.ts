---
title: Meeus Calendar
layout: default
parent: Astronomy
nav_order: 220
description: Converts Meeus-style calendar labels, Julian days, and modeled TT dates.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts
    - src/astronomy/time/deltat.ts

api:
    - Julian
---

# Meeus Calendar

`Julian` provides Meeus-style calendar arithmetic with **astronomical year numbering** and fractional days. Use it for chapter examples, calendar-to-Julian-day conversion, and modeled UT1/TT conversion. Its core conversions use numeric Julian days and mutable calendar objects rather than the library's `Time` type.

## Basic usage

```ts
import { Julian } from '../src/astronomy/ephemeris/meeus';

const calendar = new Julian.CalendarGregorian(2000, 1, 1.5);
const jdUt1 = calendar.toJD(); // 2451545.0
const jdeTt = calendar.toJDE(); // JD plus modeled TT − UT1.
const [year, month, day] = Julian.jdToCalendarGregorian(jdUt1);
console.log(jdUt1, jdeTt, year, month, day);
```

The day may include a fraction of a uniform **86,400-second** day: `.5` means noon. Julian days change integer part at noon, so Gregorian `2000-01-01.5` maps to JD **2451545.0**. Year **0 means 1 BCE**. `calendarGregorianToJD` and `calendarJulianToJD` choose their named calendar rules explicitly; their inverse helpers return `[year, month, fractionalDay]`. `jdToCalendar(jd)` defaults to Gregorian unless its second argument selects Julian.

## Calendar choice and mutation

`Julian.Calendar` chooses Julian labels before the Gregorian reform and Gregorian labels from **1582-10-15** onward; its JD boundary is `GREGORIAN0JD = 2299160.5`. The historical label gap from October 5 through 14 is not a valid mixed-calendar input. `CalendarJulian` and `CalendarGregorian` instead apply their respective rules proleptically. Their `toGregorian()` and `toJulian()` methods allocate new calendar objects for the **same JD**.

Calendar instances are mutable. `fromJD`, `fromJDE`, `fromDate`, `fromYear`, `midnight`, `noon`, and `deltaT` change the instance and return it; `toJD` and `toJDE` calculate numbers without changing it. `getDate` drops the day fraction, while `getTime` reports hour, minute, second, and truncated millisecond from it. `dayOfYear` uses a one-based ordinal and does not remove the reform gap from the nominal year. The namespace also has leap-year, weekday, ordinal-date, and JD/MJD conversion helpers; **MJD = JD − 2400000.5**.

## UT1, TT, and JavaScript dates

`Calendar.toJD()` treats its labels as **UT1**. `toJDE()` adds modeled **TT − UT1** in seconds divided by 86,400 to produce a **TT** Julian ephemeris day. `fromJDE(jde)` works backward to UT1 labels using three refinements of the ΔT estimate. `deltaT()` mutates UT1 labels into TT labels; `deltaT(true)` performs the reverse conversion.

`Julian.deltaTSeconds(decimalYear)` uses the current `DeltaTProvider`, which defaults to the repository's ΔT model. `setDeltaTProvider(provider)` changes that model for subsequent Meeus calendar conversions; calling `setDeltaTProvider()` restores the default. This is shared module state, so restore the provider after a temporary override.

`dateToJD` and `jdToDate` interpret JavaScript `Date` as **proleptic Gregorian UTC labels**, with no time-scale correction. `dateToJDE` treats those UTC labels as **UT1** before applying ΔT; `jdeToDate` returns a `Date` labeled with modeled UT1. They do not perform a leap-second-aware UTC↔TT conversion. Likewise, `Calendar.toISOString()` formats its calendar labels with a `Z`; that suffix does not turn Julian labels or TT labels into UTC. For an absolute UTC instant and time-scale conversion, use `Time` instead.

## Accuracy and limits

TT conversions inherit the chosen ΔT model's uncertainty and the precision of floating-point Julian days. Calendar-to-JD functions do not represent leap-second labels. Date conversion rounds to JavaScript millisecond precision. Avoid using the mixed-calendar class for dates in the 1582 reform gap; select an explicit proleptic calendar when those labels are needed.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) models absolute instants and UTC, UT1, and TT conversions.
- [Delta T]({% link astronomy/time-and-earth-orientation/delta-t.md %}) explains the default TT − UT1 estimate.
