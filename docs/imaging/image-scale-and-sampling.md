---
title: Image Scale and Sampling
layout: default
parent: Imaging
nav_order: 20
description: Estimates focal-plane scale, image sampling, diffraction size, sensor field, and one-axis mosaic coverage.

doc_kind: topic

sources:
    - src/astronomy/formulas.ts

api:
    - plateScale
    - pixelScale
    - samplingRatio
    - fwhmPixelsToSeeing
    - FWHMSamplingKind
    - classifyFWHMSampling
    - recommendedFocalLength
    - airyDiskSize
    - airyDiskInPixels
    - sensorFieldOfView
    - sensorDiagonalFov
    - criticalFocusZone
    - mosaicPanelCount
---

# Image Scale and Sampling

These formulas connect focal length, pixel size, seeing, and sensor dimensions for camera planning. Use them to compare a telescope and sensor, estimate a field of view, or choose a focal length for a target sampling ratio. They take supplied dimensions; they do not measure stars in an image or fit an optical model.

## Basic usage

```ts
import { classifyFWHMSampling, pixelScale, samplingRatio, sensorFieldOfView } from '../src/astronomy/formulas';

const arcsecPerPixel = pixelScale(3.76, 800); // 3.76 µm pixel, 800 mm focal length
const fwhmPixels = samplingRatio(2.5, arcsecPerPixel); // 2.5 arcsec seeing FWHM
const sampling = classifyFWHMSampling(fwhmPixels);
const horizontalFieldDegrees = sensorFieldOfView(22.3, 800); // 22.3 mm sensor width
console.log({ arcsecPerPixel, fwhmPixels, sampling, horizontalFieldDegrees });
```

`pixelScale` uses **micrometers** for pixel size and **millimeters** for telescope focal length, returning arcseconds per pixel. The example gives about `0.9694` arcsec/pixel and `2.579` pixels across the supplied seeing FWHM, classified as `'optimal'`. `sensorFieldOfView` returns about `1.597°` along the supplied sensor axis. These values follow the current formula tests.

## Scale and sampling

| Function                                                                 | Input and result                                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `plateScale(focalLengthMm)`                                              | `ARCSEC_PER_RADIAN / focalLengthMm` → arcseconds per millimeter at the focal plane.         |
| `pixelScale(pixelSizeMicrons, focalLengthMm)`                            | Plate scale × pixel pitch in millimeters → arcseconds per pixel.                            |
| `samplingRatio(seeingArcsec, arcsecPerPixel)`                            | Seeing FWHM / image scale → FWHM in pixels.                                                 |
| `fwhmPixelsToSeeing(fwhmPixels, arcsecPerPixel)`                         | Inverse conversion → angular FWHM in arcseconds.                                            |
| `recommendedFocalLength(pixelSizeMicrons, targetSampling, seeingArcsec)` | Focal length in millimeters that gives the requested FWHM in pixels at the supplied seeing. |

`classifyFWHMSampling(fwhmPixels)` returns `'undersampled'` below 2 pixels, `'optimal'` from 2 through 3 pixels inclusive, and `'oversampled'` above 3. This is a planning classification of stellar FWHM, not a measurement of image quality. If the input seeing or pixel pitch changes, recompute the ratio before classifying it.

## Diffraction, focus, and field

`airyDiskSize(wavelengthMicrons, focalRatio)` estimates the Airy-disk diameter as `2.44 × wavelength × f-number` in micrometers at the focal plane. `airyDiskInPixels(airyDiameterMicrons, pixelSizeMicrons)` divides that diameter by pixel pitch. `criticalFocusZone(wavelengthMicrons, focalRatio)` returns the planning estimate `4.88 × wavelength × f-number²` in **micrometers**. This helper is distinct from the focus-scan `criticalFocusZone` in the imaging aberration module, which has another contract.

`sensorFieldOfView(sensorSizeMm, focalLengthMm)` uses the small-angle ratio `sensorSize / focalLength`, converted to **degrees** along one sensor axis. `sensorDiagonalFov(sensorDiagonal, focalLength)` instead returns `2 atan(sensorDiagonal / (2 × focalLength))` in **radians**; its two lengths must share a unit. Convert the diagonal result before comparing it to a field stated in degrees.

`mosaicPanelCount(targetFov, cameraFov, overlap)` estimates panels along **one axis** as `ceil(targetFov / (cameraFov × (1 − overlap)))`. Use target and camera fields in the same angular unit and overlap as a fraction from 0 up to but excluding 1. It is a width estimate; it does not place tiles or account for sky projection distortion.

## Limits

These are first-order optical and planning formulas. Seeing is supplied as a FWHM, not inferred from the telescope; diffraction and focus estimates do not include aberrations, tracking, atmospheric dispersion, or sensor response. The functions evaluate their formulas for supplied numbers, so use positive physical lengths, angles, and ratios.

## Related topics

- [Telescope Optical Estimates]({% link imaging/telescope-optical-estimates.md %}) provides focal ratio and visual optical estimates.
