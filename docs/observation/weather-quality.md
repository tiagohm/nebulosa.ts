---
title: Weather Quality
layout: default
parent: Observation
nav_order: 20
description: Turns supplied weather sensor readings into a dimensionless imaging-quality score.

doc_kind: topic

sources:
    - src/astronomy/weather.ts

api:
    - WeatherQualityInput
    - weatherQualityScore
---

# Weather Quality

`weatherQualityScore` reduces one weather reading to a score on `[0, 1]` for imaging plans. Pass the sensors available from a weather station; absent sensors do not contribute a factor. The result is a planning score from fixed thresholds, not a weather forecast or a safety decision for observatory hardware.

## Basic usage

```ts
import { weatherQualityScore } from '../src/astronomy/weather';

const quality = weatherQualityScore({
	cloudCoverPercent: 20,
	humidityPercent: 65,
	windSpeedMetersPerSecond: 4,
	windGustMetersPerSecond: 8,
	dewMarginCelsius: 6,
	rainRateMillimetersPerHour: 0,
});
console.log(quality);
```

Cloud cover and relative humidity are **percentages**. Sustained wind and gust are meters per second. `dewMarginCelsius` is ambient temperature minus dew point in degrees Celsius; rainfall rate is millimeters per hour. The function takes a weather reading that has already been measured or parsed. It does not read a device or derive dew point from temperature and humidity.

## Factor thresholds

| Sensor                       | Score factor                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------- |
| `cloudCoverPercent`          | Falls linearly from 1 at 0% to 0 at 100%, then stays within `[0, 1]`.                    |
| `humidityPercent`            | Stays 1 through 70%, falls linearly to 0 at 100%.                                        |
| Wind speed or gust           | Uses the larger supplied speed; stays 1 through 5 m/s, falls linearly to 0 at 15 m/s.    |
| `dewMarginCelsius`           | Equals `1 − dewRiskFromMargin(margin)`; 0 °C margin scores 0 and at least 5 °C scores 1. |
| `rainRateMillimetersPerHour` | Any positive rate makes the entire score 0. A non-positive rate adds no factor.          |

Except for the rain shortcut, the result is the geometric mean of the factors whose sensors are present. If no scoring sensor is present, it returns `1`, meaning there was no measured penalty; it does not establish that conditions are good. One zero factor also makes the mean zero. When either sustained wind or gust is supplied, their maximum contributes one wind factor.

## Model and limits

The thresholds are fixed planning choices in the current implementation. The score does not account for cloud type, wind direction, changing weather, sensor reliability, or the effect of humidity on astronomical refraction. In particular, `humidityPercent` uses 0–100, while some atmospheric APIs use a fraction on 0–1. Use the underlying readings and an appropriate safety policy to decide whether to operate equipment.

## Related topics

- [Observation Scores]({% link observation/observation-scores.md %}) scores a target from its own geometry, twilight, Moon interference, and available time.
