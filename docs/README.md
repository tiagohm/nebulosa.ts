Welcome. Nebulosa is a Bun-first, ESM-only TypeScript toolkit for numerical astronomy, astrophotography, imaging, I/O, and observatory control.

# 🚀 Installation

Nebulosa runs on [Bun](https://bun.com). Install it from the Git repository; Bun fetches that repository directly. Imports use the path under `nebulosa/src/` and omit the `.ts` extension.

## Requirements

Install [Bun](https://bun.com/docs/installation), then add Nebulosa to a project that imports ESM.

## Add the package

```sh
bun add --trust github:tiagohm/nebulosa.ts
```

`--trust` records `nebulosa` in `trustedDependencies`. Bun runs lifecycle scripts only for packages named there, and the postinstall is what fetches the native libraries. The command writes:

```json
{
	"dependencies": {
		"nebulosa": "github:tiagohm/nebulosa.ts"
	},
	"trustedDependencies": ["nebulosa"]
}
```

Append `#` and a commit or tag to stay on one revision:

```sh
bun add --trust github:tiagohm/nebulosa.ts#<commit>
```

## Import a module

```ts
import { formatHMS, hour } from 'nebulosa/src/math/units/angle'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

// 2026-06-29 00:00:00 UTC, stored as a two-part Julian Date.
const instant = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

console.log(formatHMS(hour(12), false)) // 12:00:00
console.log(instant.day + instant.fraction) // 2461220.5
```

## Native libraries

The postinstall script saves these shared libraries under `native/` when the file is absent:

- `libwcs.shared` — WCSLIB, for FITS WCS pixel and sky transforms
- `libturbojpeg.shared` — TurboJPEG, for JPEG compression and decompression
- `libastrometry.shared` — Astrometry.net, for local plate solving

They come from [`tiagohm/nebulosa.data`](https://github.com/tiagohm/nebulosa.data), under `native/<platform>-<arch>/`. A file that is already present is left as it is. If a download fails, delete the matching `native/*.shared` file and run `bun install` again. The rest of the install still completes, and the modules that need that library stay unavailable until the file is there.

# 📄 Documentation

## ⭐ Astronomy

Times, coordinates, ephemerides, and events for bodies and observers.

### Affine Origin Frames

### Airmass and Extinction

### Alt-Az Field Rotation

### Angular Motion

### Angular Separation and Position Angle

### Angular Size and Planning Magnitudes

### Annual Aberration

### Apparent Direction

### Astrometric Sample-Grid Interpolation

### Astronomical Time Scales

### B-Plane

### Barycentric and Heliocentric Light-Time Correction

### Binary PCK Rotation

### Carrington Rotation

### Celestial and Terrestrial Reference Frames

### Civil UTC Timestamps

### Constellations

### Covariance and Sky-Plane Uncertainty

### DAF and SPK Kernels

### Delta T

### Dew Point and Frost

### Differential Orbit Correction

### Differential Refraction and Atmospheric Dispersion

### Earth Occultation of a Finite Target

### Earth Orientation Parameters

### Earth Rotation and Orientation

### ELP/MPP02 Lunar Theory

### Ephemeris Path Adapters

### Ephemeris Paths and Observed Positions

### Equatorial Ephemeris Interpolation

### Equatorial Mount Geometric Pointing Errors

### ERFA / SOFA Algorithms

### Galactocentric Frame

### Galilean Satellite Theory (L1.2)

### Geographic Observer

### Geographic Sub-point

### Great Red Spot Transits

### HEALPix

### Heliacal Events

### Hour-Angle Windows

### IAU Body Orientation

### Initial Orbit Determination

### Jupiter Central Meridian

### Keplerian Orbits and Asteroid / Comet Propagation

### Light-Time Solution

### Local ENU and Taki Frames

### Local Horizon Coordinates

### Local Horizon Mask

### Local Solar Eclipse Circumstances

### Local Standard of Rest Frames

### Location GCRS Frame

### Low-Precision Earth Ephemeris

### Low-Precision Lunar Ephemeris

### Lunar Apsides and Nodes

### Lunar Declination Extrema and Standstills

### Lunar Eclipse Local Circumstances

### Lunar Eclipse Search

### Lunar Eclipse Visibility Map

### Lunar Parallax and Semidiameter

### Lunar Phase and Lunation

### Martian Satellite Theory (MARSSAT)

### Meeus Algorithms

### Meteor Activity Profiles

### Meteor Observing Windows

### Meteor Radiants

### Meteor Shower State

### Meteor Solar Longitude

### Meteor Stream Orbits

### Meteor Track Association

### Meteor Trajectory Correction

### Meteor Visual Rates

### Minimum Orbit Intersection Distance

### MPCORB Parsing

### Mutual Planetary-Satellite Events

### Observed Catalog Star

### Observing Visibility Windows

### Planetary Apparent Magnitudes (Mallama and Hilton)

### Planetary Disk Transits

### Planetary Surface Locations

### Pluto Short Analytical Theory

### Precession, Nutation, and Obliquity

### Projected Paths and Polygons

### Radial Velocity Correction

### Refractive Displacement

### Rise, Transit, and Set

### Satellite Conjunctions

### Satellite Eclipses

### Satellite Look Angles

### Satellite Passes

### Satellite Trail Prediction

### Satellite Visual Magnitude

### Saturnian Satellite Theory (TASS1.7)

### Season Instants and Equation of Time

### SGP4/SDP4

### Sidereal Time and Earth Rotation Angle

### Sky Projections

### Solar Eclipse Besselian Geometry

### Solar Eclipse Search and Classification

### Solar Parallax and Semidiameter

### Solar Saros Index

### Spherical Coordinate Conversions

### SPICE Text Kernels and Frames

### Starlight Deflection

### Stellar and Asteroidal Occultations

### Stellar Space Motion

### Sub-Observer and Sub-Solar Points

### Time-Domain Event Search

### Time-Domain Extrema Search

### Topocentric Observed Place

### Transit Altitude and Hour Angle

### Twilight and Darkness Windows

### Uranian Satellite Theory (GUST86)

### VSOP87E Planetary Theory

## 📐 Astrometry

### ASTAP Plate Solving

### Astrometry.net Index Selection

### Catalog Crossmatching

### Local Astrometry.net Plate Solving

### Native libastrometry Plate Solving

### Nova Astrometry.net Plate Solving

### Plate Solution

### SIP Distortion Fitting

### Star Pattern Matching

### WCSLIB Equatorial Projection

### World Coordinate System and FITS WCS

## 🖼️ Imaging

Plan telescope and camera combinations, then work with captured or synthetic images.

### Aberration Inspector

### Arcsinh Stretch

### Automatic Background Extraction

### Background Estimate

### Background Neutralization

### Bahtinov Chromatic Comparison

### Bahtinov Focus Analysis

### Bahtinov Overlay Geometry

### Celestial Streak Tracks

### Collimation Sequence Summary

### Cosmetic Correction

### Critical Focus Zone

### Curves

### Dark Current

### Debayering

### Defocused Annular Geometry Analysis

### Drizzle Integration

### Elliptical Moffat Fitting

### Exposure and Noise Estimates

### FFT Image Filter

### Field Curvature and Backfocus

### Flat Exposure Estimate

### Flat Sequence Stability

### Flat-Frame Quality

### Focus Curve Fitting

### Focus Surface Analysis

### Frame Saturation

### Geometric Image Operations

### Global Image Normalization

### Image Arithmetic

### Image Calibration

### Image Convolution

### Image Planes and Robust Sampling

### Image Scale and Sampling

### Image Stacking

### Image Statistics

### Image Warp

### Live Stacking

### Local Image Normalization

### Multiscale Linear Transform

### Multiscale Median Transform

### Photon Transfer and Read Noise

### PSF Filter

### Scalar Surface Fitting

### Scientific Image Loading and Export

### Scientific Image Model

### SCNR

### Screen Transfer Function

### Sensor Characterization

### Sensor Fixed Pattern and Defects

### Sensor Linearity

### Sensor Operating-Point Series

### Sensor Tilt Estimator

### Single-Frame Bad-Pixel Map

### Star Detection

### Star List Registration

### Star Profile Measurement

### Star Shape Statistics

### Straight Streak Detection

### Streak Classification

### Streak-Aware Stacking

### Subframe Selector

### Synthetic Bahtinov Spikes

### Synthetic Defocused Collimation Patterns

### Synthetic Flats

### Synthetic Image Noise

### Synthetic Optical Aberration

### Synthetic Star Fields

### Synthetic Straight Streaks

### Telescope Optical Estimates

### Tone Mapping

### Tracking Quality

### Trailing and Smear Limits

## 🔭 Observation

Evaluate observing conditions and target suitability before scheduling or controlling an observation.

### Autofocus

### Challis Polar Alignment

### DARV Exposure Planning

### DARV Image Analysis

### DARV Polar Error Estimation

### Direction Alignment

### Dither Guide Pulses

### Dither Offsets

### Dome Slit Geometry

### Focuser Backlash Calibration

### Focuser Backlash Compensation

### Guide Pulse Loop

### Guide Star Tracking

### Guiding Assistant

### Guiding Calibration

### iPolar Alignment

### Local Pointing Residuals

### Meridian Flip Planning

### Mosaic Framing

### Mount Axis Limits

### Mount Kinematics

### Mount Tracking Rates

### Non-Sidereal Guide Tracking

### Observation Scores

### Pointing Model Fit and Correction

### Polar Alignment Exposure Estimator

### Polar Alignment Geometry

### Polar Alignment Overlay

### Taki Mount Geometry

### Three-Point Polar Alignment

### Tracking Rate Estimation

### Weather Quality

## 📖 Catalogs

### ASTAP Tiled Catalog

### Hipparcos Catalog

### HNSKY Tiled Catalog

### HYG Catalog

### SAO Catalog

### Star Catalog Interface and Spatial Query

### Stellarium Catalog

### Tiled Sky Catalog

### UCAC4 Catalog

## 🖲️ Devices

### ASCOM Alpaca Client

### ASCOM Alpaca Discovery

### ASCOM Alpaca Server

### Firmata Accelerometer

### Firmata Ammeter

### Firmata Barometer and Altimeter

### Firmata Character Display

### Firmata DAC

### Firmata Hygrometer

### Firmata IO Expander

### Firmata Light Sensors

### Firmata Magnetometer

### Firmata Peripheral Base

### Firmata Radio

### Firmata Real-Time Clock

### Firmata Thermometer Chips

### Firmata-to-INDI Bridge

### INDI Camera Control

### INDI Camera Simulator

### INDI Client Simulator

### INDI Cover

### INDI Cover Simulator

### INDI Dew Heater

### INDI Dome and Roof

### INDI Dome Simulator

### INDI Filter Wheel

### INDI Filter Wheel Simulator

### INDI Flat Panel

### INDI Flat Panel Simulator

### INDI Focuser Control

### INDI Focuser Simulator

### INDI Guide Output

### INDI Mount Control

### INDI Mount Simulator

### INDI Power Channels

### INDI Protocol Client

### INDI Rotator

### INDI Rotator Simulator

### INDI Safety Monitor

### INDI Safety Simulator

### INDI Thermometer

### INDI Weather

### INDI Weather Simulator

## 🌐 External Services

### ADES Codec

### AstroBin Equipment API

### Close Approach Data

### HiPS2FITS Cutouts

### IAU Meteor Data Center catalog

### JPL Horizons client

### JPL Small-Body Lookup

### Minor Planet Center API

### MPC1992 Codec

### SIMBAD TAP

### Small-Body Identification

### VizieR / Gaia TAP

## 💾 I/O and Data Formats

### CRC Checksums

### CSV Parsing

### Deflate Compression

### FITS Image I/O

### FITS Rice Compression

### JPEG via TurboJPEG

### Streaming byte I/O

### XISF Image I/O

### XML Parsing

## 🔢 Numerical

### Angle Units

### Dense Matrix Algebra

### Derivative-Free Optimization

### Descriptive Statistics

### Distance Units

### Ellipse Fitting

### Linear Least Squares

### Pressure Units

### Regression

### Rigid Transforms

### Seeded Random Sources

### Shared Spherical Geometry

### Splines and Interpolation

### Temperature Units

### Vectors and Fixed Matrices

### Velocity Units

## 💻 Protocols

### Firmata Client and Protocol

### Firmata DHT

### Firmata Encoders

### Firmata Frequency Measurement

### Firmata I2C

### Firmata One-Wire

### Firmata Scheduler

### Firmata Serial

### Firmata SPI

### Firmata Stepper

### LX200 Telescope Protocol

### PHD2 Client

### Stellarium Telescope Control Protocol
