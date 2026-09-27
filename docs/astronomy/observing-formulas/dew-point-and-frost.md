---
title: Dew Point and Frost
layout: default
parent: Observing Formulas
grand_parent: Astronomy
nav_order: 20
description: Estimates dew and frost points, dew margin, and a simple dew-risk score from temperature and humidity.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - dewPoint
    - frostPoint
    - dewMargin
    - dewRisk
    - dewRiskFromMargin
    - relativeHumidity
    - isMagnusDomain
---

# Dew Point and Frost

These Magnus-relation helpers estimate condensation temperatures from an ambient reading. The dew margin and risk score help plan dew control for optics, while `relativeHumidity` converts an ambient temperature and dew point back to water-relative humidity.

## Basic usage

```ts
import { dewMargin, dewPoint, dewRisk, frostPoint, isMagnusDomain, relativeHumidity } from '../src/astronomy/formulas';

const ambientCelsius = 20;
const humidityPercent = 80;
if (isMagnusDomain(ambientCelsius)) {
	const dewCelsius = dewPoint(ambientCelsius, humidityPercent);
	const marginCelsius = dewMargin(ambientCelsius, humidityPercent);
	const risk = dewRisk(ambientCelsius, humidityPercent);
	const recoveredHumidityPercent = relativeHumidity(ambientCelsius, dewCelsius);
	console.log({ dewCelsius, marginCelsius, risk, recoveredHumidityPercent });
}

// This humidity is relative to ice, not the water-relative reading above.
const frostCelsius = frostPoint(-10, 50);
console.log(frostCelsius);
```

Temperatures and margins are in **degrees Celsius**; relative humidity is a **percentage** on `(0, 100]` for `dewPoint` and `frostPoint`. `dewPoint` uses the water Magnus coefficients. `frostPoint` uses ice coefficients and requires humidity **relative to ice**. A weather station's water-relative reading should not be passed to `frostPoint` as though it were ice-relative. Below freezing, its result is the temperature at which ice would deposit; above freezing, the dew point is generally the relevant condensation temperature.

`dewMargin` returns ambient temperature minus dew point in °C. `dewRisk` maps that margin onto `[0, 1]` through `dewRiskFromMargin`: a margin at or below zero gives `1`, the default clear margin of 5 °C or more gives `0`, and the interval between is linear. Pass a positive `clearMarginCelsius` to either risk function to choose another zero-risk threshold. If the supplied threshold is non-positive or unordered, `dewRiskFromMargin` uses a step at zero instead.

`relativeHumidity(temperatureCelsius, dewPointCelsius)` inverts the water Magnus relation and returns percent. A dew point above ambient temperature yields a value above 100%; the function does not clamp supersaturation. `dewPoint` and `frostPoint` throw `RangeError` for humidity outside `(0, 100]`, including `NaN`. `dewMargin` and `dewRisk` inherit that failure through `dewPoint`.

## Model and limits

`isMagnusDomain(celsius)` reports whether a reading lies in the inclusive `[-100, 100]` °C computational window used by these helpers. Check both ambient and dew-point inputs before calling `relativeHumidity`, and check ambient temperature before a dew or frost calculation. The conversion functions do not themselves reject temperatures outside that window; results there may be non-finite. The window protects the arithmetic from the water formula's singularity and is broader than the range over which the empirical coefficients are calibrated. Treat the results as planning estimates rather than measured surface temperatures or a control-system safety decision.

## Related topics

- [Weather Quality]({% link observation/weather-quality.md %}) scores an already supplied dew margin with the same default risk mapping.
