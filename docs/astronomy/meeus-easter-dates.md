---
title: Meeus Easter Dates
layout: default
parent: Astronomy
nav_order: 230
description: Calculates Easter Sunday dates with Gregorian or Julian calendar arithmetic.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Easter
---

# Meeus Easter Dates

The `Easter` namespace calculates the calendar date of Easter Sunday using the Gregorian or Julian computus. Use it for a civil or historical calendar date in a Meeus-style calculation. The result is a **date label**, not an astronomical event time.

## Basic usage

```ts
import { Easter, Julian } from '../src/astronomy/ephemeris/meeus';

const gregorianDate = Easter.gregorian(2026); // [2026, 4, 5]
const julianDate = Easter.julian(2026); // [2026, 3, 30] in the Julian calendar
const julianDateInGregorian = new Julian.CalendarJulian(...julianDate).toGregorian().getDate();
console.log(gregorianDate, julianDate, julianDateInGregorian); // Gregorian label: 2026-04-12
```

`Easter.gregorian(year)` and `Easter.julian(year)` each return `[year, month, day]` in the **named calendar**, with a one-based month and an integer day. The functions truncate a fractional year toward zero before calculating. For a Julian result expressed in Gregorian labels, convert it through `Julian.CalendarJulian` as shown; simply relabeling its month and day would change the represented date.

## Model and limits

Both functions use integer calendar cycles and modular arithmetic. They do not calculate the physical equinox, a lunar phase, a location-dependent sunset, or a time of day. Use a positive integer year for the intended computus. Neither function returns a Julian day or a `Time` object.

## Related topics

- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) converts between Julian and Gregorian date labels and Julian days.
