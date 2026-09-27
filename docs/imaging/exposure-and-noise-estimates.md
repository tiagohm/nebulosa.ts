---
title: Exposure and Noise Estimates
layout: default
parent: Imaging
nav_order: 30
description: Estimates electron-budget SNR, stacking gain, dynamic range, saturation, sky-limited exposure, and frame count.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - signalToNoiseRatio
    - stackingSnrGain
    - stackingMagnitudeGain
    - dynamicRange
    - dynamicRangeInStops
    - saturationTime
    - skyLimitedExposure
    - totalIntegrationTime
    - subframeCount
    - requiredSubframeCount
---

# Exposure and Noise Estimates

These formulas combine a supplied electron budget and exposure duration into planning estimates. Use them to compare subexposures, read-noise impact, or stacking plans when the camera and sky rates are already known. They do not inspect images or infer a sensor's gain, dark current, or full-well capacity.

## Basic usage

```ts
import { requiredSubframeCount, signalToNoiseRatio, skyLimitedExposure } from '../src/astronomy/formulas';

const snr = signalToNoiseRatio(1000, 25, 20, 0.1, 3);
const skyLimitedSeconds = skyLimitedExposure(3, 0.5);
const frames = requiredSubframeCount(3610, 120);
console.log({ snr, skyLimitedSeconds, frames });
```

The example returns approximately `24.0597` for dimensionless SNR, `180` seconds for the sky-limited exposure estimate, and `31` whole frames to cover the requested integration time. These values are asserted by the current formula tests.

## Signal and stacking

`signalToNoiseRatio(signalElectrons, pixelCount, backgroundElectronsPerPixel, darkCurrentElectronsPerPixel, readNoiseElectrons)` computes

```text
SNR = signal / √[signal + pixelCount × (background + dark + readNoise²)]
```

`signalElectrons` is accumulated signal in the measured aperture. Background and dark inputs are accumulated **electrons per pixel** over the exposure; `readNoiseElectrons` is the per-pixel read-noise RMS in electrons. `pixelCount` is the number of pixels contributing background, dark, and read variance. The result is dimensionless. If the computed noise variance is not positive, the function throws `RangeError`.

For a positive frame count `N`, `stackingSnrGain(N)` returns `√N` and `stackingMagnitudeGain(N)` returns `1.25 log₁₀(N)` magnitudes. These are idealized gains for comparable, independent frames; changing sky, read noise, calibration, and rejection can alter the achieved result.

## Sensor and duration estimates

| Function                                                            | Meaning and unit                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------ |
| `dynamicRange(fullWellElectrons, readNoiseElectrons)`               | Full well / read noise, a dimensionless ratio.         |
| `dynamicRangeInStops(fullWellElectrons, readNoiseElectrons)`        | Base-2 logarithm of that ratio, in photographic stops. |
| `saturationTime(fullWellElectrons, signalRateElectronsPerSecond)`   | Full well / signal rate, in seconds.                   |
| `skyLimitedExposure(readNoiseElectrons, skyRateElectronsPerSecond)` | `10 × readNoise² / skyRate`, in seconds.               |
| `totalIntegrationTime(frameCount, exposureTimeSeconds)`             | Frame count × exposure time, in seconds.               |
| `subframeCount(totalTimeSeconds, subExposureSeconds)`               | Fractional number of subframes; no rounding.           |
| `requiredSubframeCount(totalTimeSeconds, subExposureSeconds)`       | That count rounded up to a whole frame.                |

Supply full well and read noise in electrons, rates in electrons per second, and durations in seconds. The sky-limited expression is a fixed planning threshold: it seeks sky electrons about ten times read-noise variance. `saturationTime` includes only the supplied signal rate; account for sky and dark contributions separately when estimating real pixel saturation.

## Limits

These scalar formulas assume a consistent electron representation and positive physical denominators. They do not include flat-field error, correlated noise, tracking blur, changing transparency, or clipping from a nonlinear camera response. `requiredSubframeCount` rounds upward so the resulting nominal integration can exceed the requested time.

## Related topics

- [Image Scale and Sampling]({% link imaging/image-scale-and-sampling.md %}) supplies angular and pixel scales for planning an imaging setup.
