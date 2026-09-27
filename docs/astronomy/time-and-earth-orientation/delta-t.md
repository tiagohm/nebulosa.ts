---
title: Delta T
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 40
description: Estimates the difference TT minus UT1 from a decimal calendar year using historical spline and polynomial models.

doc_kind: topic

sources:
    - src/astronomy/time/deltat.ts

api:
    - deltaT
    - deltaTByEspenakMeeus2006
    - s15
    - parabolaOfStephensonMorrison2004
    - parabolaOfStephensonMorrisonHohenkerk2016
---

# Delta T

`deltaT(year)` estimates **ΔT = TT − UT1**, in seconds, from a decimal calendar year. It is useful for historical eclipse calculations and broad epoch estimates when a measured Earth-rotation offset is unavailable. It accepts a year number such as `2024.5`, rather than a `Time`, and does not load Earth-orientation data or alter time-scale conversions.

UT1 follows the Earth's rotation while TT is a uniform terrestrial time scale. ΔT therefore relates these two clocks; it is different from **DUT1 = UT1 − UTC**, which the IERS tables supply. In seconds, the relationships are `TT = UT1 + ΔT` and `UT1 = UTC + DUT1`. The implementation does not combine those offsets for the caller.

## Basic usage

```ts
import { deltaT } from '../src/astronomy/time/deltat';

const year = 2024.5; // decimal calendar year
const ttMinusUt1Seconds = deltaT(year);
// About 74.17 s from the selected forward polynomial.
```

This is a model estimate for the requested year. For an instant with loaded IERS data, use the time-scale functions and their DUT1 provider from [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) instead of assuming this annual model is a current measurement.

## Model selection

| Decimal calendar year        | `deltaT` model                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Before −720                  | `parabolaOfStephensonMorrisonHohenkerk2016`                                                       |
| −720 through 2019, inclusive | Tabulated S15 cubic spline segments                                                               |
| After 2019                   | `deltaTByEspenakMeeus2006` piecewise polynomials; its long-term parabola applies from 2150 onward |

The S15 segment lookup selects a prebuilt `Spline` over an interval in decimal years. Its `compute(year)` returns ΔT in seconds. `s15(year)` itself clamps **which segment is selected** outside the table, but evaluating that segment beyond its bounds extrapolates its cubic. `deltaT` selects the historical parabola or forward polynomial outside the S15 interval instead.

The other exports expose the individual models when a caller specifically needs one. `deltaTByEspenakMeeus2006(year)` evaluates NASA's piecewise polynomial expressions. `parabolaOfStephensonMorrison2004` and `parabolaOfStephensonMorrisonHohenkerk2016` are prebuilt spline objects with a `compute(year)` method; the 2004 parabola is not selected by `deltaT`.

## Accuracy and limitations

{: .accuracy }
The S15 coefficients in this library span −720 to 2019. At exactly 2019, `deltaT` returns the spline value of 69.24 s. Immediately after 2019 it switches to the Espenak–Meeus branch, whose limit is about 71.06 s, creating a step of about 1.82 s. Code that searches continuously across that boundary must account for the model switch.

{: .accuracy }
The Espenak–Meeus source presents its polynomials for −1999 through +3000. The implementation continues evaluating its long-term parabola outside that interval, but does not attach an uncertainty estimate to any result. Historical and future values should be interpreted as model estimates, especially beyond the period supported by observations.

`deltaT` is not called automatically by `timeConvert`, `ut1`, or `tt`; those functions use their configured time providers. The function does not use the IERS DUT1 table, and changing that table does not update a `deltaT(year)` result.

## Related topics

- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) represents instants on TT, UT1, UTC, and the other scales.
- [Sidereal Time and Earth Rotation Angle]({% link astronomy/time-and-earth-orientation/sidereal-time-and-earth-rotation-angle.md %}) uses UT1 for Earth rotation and TT for its celestial model.

## References

- [NASA, Polynomial Expressions for Delta T](https://eclipse.gsfc.nasa.gov/SEhelp/deltatpoly2004.html), adapted from Espenak and Meeus's _Five Millennium Canon of Solar Eclipses_.
- [Stephenson, Morrison, and Hohenkerk, “Measurement of the Earth's rotation: 720 BC to AD 2015”](https://pmc.ncbi.nlm.nih.gov/articles/PMC5247521/) and the [Royal Society's addendum materials](https://rs.figshare.com/collections/Supplementary_material_from_Addendum_2020_to_Measurement_of_the_Earth_s_rotation_720_BC_to_AD_2015_/5300925).
