---
title: Meeus Numerical Helpers
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 10
description: Provides chapter-style interpolation, curve fitting, iteration, and shared Meeus formulas.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Base
    - Interpolation
    - Fit
    - Iteration
---

# Meeus Numerical Helpers

The `Base`, `Interpolation`, `Fit`, and `Iteration` namespaces collect numerical recipes used by Meeus-style astronomy calculations. Use them to reproduce a chapter example, interpolate a small table, fit a simple function, or evaluate a shared formula. Their arguments are ordinary numbers and arrays; a Julian ephemeris day here is a numeric TT day count, not a `Time` object.

## Basic usage

```ts
import { Base, Fit, Interpolation, Iteration } from '../src/astronomy/ephemeris/meeus';

const middle = new Interpolation.Len3(0, 2, [1, 2, 5]).interpolateX(0.5);
const [slope, intercept] = Fit.linear([0, 1, 2], [1, 3, 5]);
const root = Iteration.binaryRoot((x) => x * x - 2, 1, 2);
const lightDays = Base.lightTime(1); // Distance in AU; result in days.
console.log(middle, slope, intercept, root, lightDays);
```

## Interpolation and fitting

`Interpolation.Len3(x1, x3, y)` fits three equally spaced ordinates between the endpoint abscissae; `Len5(x1, x5, y)` does the same with five. Their `interpolateX` methods evaluate the fitted value. `interpolateXStrict` rejects a query outside the endpoint interval; the non-strict form can extrapolate. `extremum()` and `zero(strong)` seek a local extremum or zero and throw when the routine cannot obtain one within the table interval.

`Interpolation.linear(x, x1, xN, y)` interpolates equally spaced samples piecewise and extends the edge segment for an outside query. `Interpolation.len4Half(y)` estimates the value halfway between the two central samples of four equally spaced values. For arbitrary distinct abscissae, `Interpolation.lagrange(x, table)` evaluates a Lagrange polynomial from `[x, y]` pairs, while `lagrangePoly(table)` returns its coefficients in **ascending power order** for `Base.horner(x, coefficients)`.

`Fit.linear(x, y)` returns `[a, b]` for `y = ax + b`; `Fit.quadratic` returns `[a, b, c]` for `y = ax² + bx + c`. `Fit.func1` fits `a·f(x)`, and `Fit.func3` fits a weighted sum of three supplied basis functions. `Fit.correlationCoefficient` returns the Pearson coefficient. These fits use the shorter of the two input arrays if their lengths differ. Supply enough independent data for a determined fit; a singular fit can produce non-finite coefficients.

## Iteration and shared formulas

`Iteration.decimalPlaces(better, start, places, maxIterations)` stops when consecutive values differ by less than `10⁻places`. `Iteration.fullPrecision` uses a floating-point convergence threshold; both throw if the iteration limit is reached. `Interpolation.iterate` is a separate 50-step helper that returns `[value, converged]`, with `[0, false]` on failure.

`Iteration.binaryRoot(f, lower, upper)` performs 52 bisection steps at most and returns a number without a convergence flag. Supply an interval that brackets a continuous sign-changing root; the helper does not validate the bracket. For event searches with their own time windows and failure handling, use the event-search capability rather than treating this helper as a complete event finder.

`Base.lightTime(distanceAu)` returns **days** for a distance in **AU** using `0.0057755183 × distanceAu`. `Base.illuminated(phaseAngleRad)` returns `(1 + cos(phaseAngleRad)) / 2`, the illuminated disk fraction. `Base.limb` computes the illuminated-limb position angle from body and Sun RA/Dec, all in **radians**. `Base` also supplies `horner`, Julian and Besselian epoch conversions, and constants such as `J2000 = 2451545`.

## Limits

These chapter formulas do not establish accuracy for a particular ephemeris or observing geometry. Interpolation quality depends on sample spacing and smoothness; polynomial fits and zero finders depend on conditioning and suitable input intervals. For a sampled RA/Dec series with TT conversion, wrap handling, and an explicit out-of-range policy, use the dedicated equatorial ephemeris interpolators.

## Related topics

- [Equatorial Ephemeris Interpolation]({% link astronomy/equatorial-ephemeris-interpolation.md %}) fits time-tagged sky directions.
- [Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) represents instants and converts time scales.
