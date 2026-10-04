Welcome. Nebulosa is a Bun-first, ESM-only TypeScript toolkit for numerical astronomy, astrophotography, imaging, I/O, and observatory control.

# 🚀 Installation

Nebulosa runs on [Bun](https://bun.com). Install it from the Git repository; Bun fetches that repository directly. Imports use the path under `nebulosa/src/` and omit the `.ts` extension.

## Requirements

- Install [Bun](https://bun.com/docs/installation).

## Add the package

```sh
bun add --trust github:tiagohm/nebulosa.ts
```

`--trust` records `nebulosa` in `trustedDependencies`. Bun runs lifecycle scripts only for packages named there, and the postinstall extracts the native libraries shipped with the package. The command writes:

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

The [postinstall](https://github.com/tiagohm/nebulosa.ts/blob/main/postinstall.ts) script extracts the shared libraries for this platform from zips shipped in `native/`:

- `libwcs.shared` — [WCSLIB](https://www.atnf.csiro.au/computing/software/wcs/), for FITS WCS pixel and sky transforms, from `libwcs-<platform>-<arch>.zip`
- `libturbojpeg.shared` — [TurboJPEG](https://github.com/libjpeg-turbo/libjpeg-turbo), for JPEG compression and decompression, from `libturbojpeg-<platform>-<arch>.zip`
- `libastrometry.shared` — [fork of Astrometry.net](https://github.com/tiagohm/astrometry.net), for local plate solving, from `libastrometry-<platform>-<arch>.zip`

The native libraries are built at [nebulosa.native](https://github.com/tiagohm/nebulosa.native) repository.

# 📄 Documentation

## ⭐ Astronomy

Times, coordinates, ephemerides, and events for bodies and observers.

### Affine Origin Frames

### Airmass and Extinction

### Alt-Az Field Rotation

### Angular Size and Surface Brightness Estimates

### Angular Separation and Position Angle

### Annual Aberration

### Apparent Direction

### Approximate Atmospheric Refraction

### Asteroid and Comet Magnitude Estimates

### Asteroid and Comet Orbit Construction

### Astrometric Sample-Grid Interpolation

### Astronomical State Ownership

### Astronomical Time Arithmetic

### Astronomical Time Representation and Epochs

### Astronomical Time-Scale Conversion

### B-Plane

### Barycentric and Heliocentric Light-Time Correction

### Binary PCK Rotation

### Body-Surface Solar Illumination

### Carrington Rotation

### Celestial and Terrestrial Reference Frames

### Civil UTC Timestamps

### Constellations

### DAF Binary Containers

### Delta T

### Dew Point and Frost

### Differential Orbit Correction

### Differential Refraction and Atmospheric Dispersion

### Earth Occultation of a Finite Target

### Earth Orientation Parameters

### Elliptic Elements to Rectangular State

### ELP/MPP02 Lunar Theory

### Ephemeris Observed Positions

### Ephemeris Path Adapters

### Ephemeris Path Composition

### Equation of Time

### Equatorial Ephemeris Interpolation

### Equatorial Mount Geometric Pointing Errors

### Equinoxes and Solstices

### ERFA / SOFA Algorithms

### FK5 Precession and ICRS Frame Bias

### Galactocentric Frame

### Galilean Satellite Theory (L1.2)

### Gauss Angles-Only Orbit Determination

### GCRS to ITRS Rotation

### Geographic Observer

### Geographic Sub-point

### Gibbs Orbit Determination

### Great Red Spot Transits

### Greatest Solar Eclipse Circumstances

### HEALPix Object Index

### HEALPix Pixelization and Covers

### Heliacal Events

### Herrick-Gibbs Orbit Determination

### Hour-Angle Windows

### IAU Body Orientation

### Instantaneous Earth Spin

### Jupiter Central Meridian

### Kepler Anomalies and Periapsis Timing

### Light-Time Solution

### Local ENU Frames

### Local Horizon Coordinates

### Local Horizon Mask

### Local Lunar Eclipse Search

### Local Lunar Eclipse View Geometry

### Local Solar Eclipse Circumstances

### Local Solar Eclipse Search

### Local Solar Eclipse View Geometry

### Local Standard of Rest Frames

### Local Taki Frames

### Location GCRS Frame

### Low-Precision Earth Ephemeris

### Low-Precision Lunar Ephemeris

### Lunar Apsides

### Lunar Declination Extrema and Standstills

### Lunar Eclipse Local Circumstances

### Lunar Eclipse Map SVG Paths

### Lunar Eclipse Search

### Lunar Eclipse Visibility Geometry

### Lunar Libration Extrema

### Lunar Parallax and Semidiameter

### Lunar Phase and Lunation

### Lunar Nodes

### Lunar Saros Index

### Martian Satellite Theory (MARSSAT)

### Meeus Algorithms

### Meteor Activity Profiles

### Meteor Observing Windows

### Meteor Orbit Reconstruction

### Meteor Orbit Similarity

### Meteor Radiants

### Meteor Shower State

### Meteor Solar Longitude

### Meteor Track Association

### Meteor Trajectory Correction

### Meteor Visual Rates

### Minimum Orbit Intersection Distance

### MPCORB Parsing

### Mutual Planetary-Satellite Events

### Nutation and Celestial Orientation

### Obliquity and Ecliptic Orientation

### Observed Catalog Star

### Observing Visibility Windows

### Orbit Covariance Propagation

### Osculating Orbital Elements

### Planetary Apparent Magnitudes (Mallama and Hilton)

### Planetary Closest Approaches

### Planetary Conjunctions

### Planetary Disk Transits

### Planetary Greatest Elongations

### Planetary Oppositions

### Planetary Quadratures

### Planetary Stations

### Planetary Surface Locations

### Pluto Short Analytical Theory

### Polar Motion

### Precession Matrices

### Projected Paths and Polygons

### Radial Doppler Shift

### Radial Velocity Correction

### Refractive Displacement

### Rise, Transit, and Set

### Sampled Angular Motion

### Satellite Conjunctions

### Satellite Eclipses

### Satellite Look Angles

### Satellite Ground Footprint

### Satellite Orbit Beta Angle

### Satellite Passes

### Satellite Sub-point

### Satellite Tracking Rates

### Satellite Trail Prediction

### Satellite Visibility Intervals

### Satellite Visual Magnitude

### Saturnian Satellite Theory (TASS1.7)

### SGP4/SDP4 Propagation

### Sidereal Time and Earth Rotation Angle

### Sky Projections

### Sky-Plane Uncertainty Ellipses

### Solar Eclipse Besselian Elements

### Solar Eclipse Ground-Track Geometry

### Solar Eclipse Map SVG Paths

### Solar Eclipse Search and Classification

### Solar Parallax and Semidiameter

### Solar Saros Index

### Spherical Coordinate Conversions

### Spherical State Rates

### SPICE Body Radii

### SPICE Frame Resolution

### SPICE Text Kernel Pools

### SPK State Kernels

### Starlight Deflection

### Stellar and Asteroidal Occultations

### Stellar Space Motion

### Sub-Observer and Sub-Solar Points

### TEME and ITRF Conversion

### Time-Constraint Intervals

### Time-Domain Event Search

### Time-Domain Extrema Search

### TLE, OMM, and SGP4 Record Construction

### Topocentric Observed Place

### Transit Altitude and Hour Angle

### Tube Flexure Pointing Error

### Twilight and Darkness Windows

### Two-Body Kepler Propagation

### Uranian Satellite Theory (GUST86)

### VSOP87E Planetary Theory

### Zenith and Celestial Circle Intersections

## 📐 Astrometry

### ASTAP Plate Solving

### ASTAP Star Detection

### Astrometry.net Index Selection

### Catalog Crossmatching

### FITS TAN and SIP Coordinate Mapping

### FITS WCS Geometry Updates

### Local Astrometry.net Plate Solving

### Native libastrometry Plate Solving

### Nova Astrometry.net Plate Solving

### Planar Similarity and Affine Transforms

### Plate Solution

### SIP Distortion Fitting

### Star Pattern Matching

### WCSLIB Equatorial Projection

## 🖼️ Imaging

Plan telescope and camera combinations, then work with captured or synthetic images.

### Aberration Inspector

### Arcsinh Stretch

### Automatic Background Extraction

### Backfocus Correction Estimates

### Background Estimate

### Background Neutralization

### Bahtinov Chromatic Comparison

### Bahtinov Focus Analysis

### Bahtinov Overlay Geometry

### Bounded Robust Sampling

### Celestial Streak Tracks

### Collimation Sequence Summary

### Cosmetic Correction

### Critical Focus Planning Estimate

### Critical Focus Zone

### Curves

### Dark Current

### Debayering

### Defocused Annular Geometry Analysis

### Diffraction and Seeing Sampling

### Display Stretch Parameter Estimation

### Drizzle Integration

### Elliptical Moffat Fitting

### Eyepiece Magnification and Exit Pupil

### FFT Image Filter

### Flat Exposure Estimate

### Flat Sequence Stability

### Flat-Frame Quality

### Focus Curve Fitting

### Focus Field Curvature

### Focus Surface Analysis

### Frame Saturation

### Global Image Normalization

### Grayscale Image Conversion

### Image Analysis Planes

### Image Arithmetic

### Image Calibration

### Image Cloning and Copying

### Image Convolution

### Image Intensity Inversion

### Image Mirroring

### Image Scale and Field of View

### Image Stacking

### Image Statistics

### Image Warp

### Live Stacking

### Local Image Normalization

### Multiscale Linear Transform

### Multiscale Median Transform

### Photon Transfer and Read Noise

### Pixel Sigma Clipping and Background Levels

### PSF Filter

### Scalar Surface Fitting

### Scientific Image Loading and Export

### Scientific Image Model

### SCNR

### Screen Transfer Function

### Sensor Characterization

### Sensor Fixed-Pattern Noise

### Sensor Linearity

### Sensor Operating-Point Series

### Sensor Stack Defects

### Sensor Tilt Estimator

### Signal-to-Noise and Dynamic Range Estimates

### Single-Frame Bad-Pixel Map

### Star Detection

### Star List Registration

### Star Profile Measurement

### Star Shape Statistics

### Straight Streak Detection

### Streak Classification

### Streak-Aware Stacking

### Subframe Selector

### Sub-Exposure and Integration Planning

### Synthetic Bahtinov Spikes

### Synthetic Defocused Collimation Patterns

### Synthetic Flats

### Synthetic Image Noise

### Synthetic Optical Aberration

### Synthetic Star Fields

### Synthetic Straight Streaks

### Telescope Resolution and Light Grasp

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

### Meridian Flip Lifecycle

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

### Tracking Rate Correction

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

### ASCOM Alpaca Device Adapter

### ASCOM Alpaca Discovery Client

### ASCOM Alpaca Discovery Server

### ASCOM Alpaca REST API

### ASCOM Alpaca Server

### Firmata Accelerometer

### Firmata Ammeter

### Firmata Analog Thermometer

### Firmata Barometer and Altimeter

### Firmata Character Display

### Firmata DAC

### Firmata Digital Thermometer

### Firmata FM Receivers

### Firmata FM Transmitter

### Firmata Hygrometer

### Firmata IO Expander

### Firmata Light Sensors

### Firmata Magnetometer

### Firmata Peripheral Base

### Firmata Real-Time Clock

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

### INDI Mount Alignment Subsystem

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

### Gaia DR3 Star Catalog

### HiPS Survey Discovery

### HiPS2FITS Cutouts

### IAU Meteor Data Center catalog

### JPL Horizons Observer Tables

### JPL Horizons Orbital Elements

### JPL Horizons SPK Downloads

### JPL Horizons State Vectors

### JPL Small-Body Lookup

### Minor Planet Center API

### MPC1992 Codec

### SIMBAD Object Types

### SIMBAD Star Catalog

### SIMBAD TAP Queries

### Small-Body Identification

### VizieR TAP Queries

## 💾 I/O and Data Formats

### Buffer Byte I/O

### Byte Reading, Writing, and Transfer

### Byte Shuffling

### Byte-Stream Contracts

### CRC Checksums

### CSV Parsing

### Deflate Compression

### File-Handle Byte I/O

### FITS Containers and HDUs

### FITS Header Cards and Metadata

### FITS Pixel I/O and Rice Tiles

### FITS Rice Compression

### Growable Binary Buffers

### HTTP Range Byte Sources

### JPEG via TurboJPEG

### ReadableStream Byte Sources

### Streaming Base64

### Streaming Text Lines

### XISF Containers and Metadata

### XISF Pixel I/O and Compression

### XML Parsing

## 🔢 Numerical

### 2D Vectors

### 2x2 Matrices

### 3D Vectors

### 3x3 Matrices

### Angle Parsing and Formatting

### Angle Units and Wrapping

### Barometric Pressure and Altitude

### Clamping and Tolerant Equality

### Dense Linear System Solvers

### Dense Matrix Operations

### Descriptive Statistics

### Distance Units

### Ellipse Containment Geometry

### Ellipse Fitting

### Error-Free Floating-Point Arithmetic

### Exponential and Power Regression

### Great-Circle Geometry

### Histogram Analysis

### Hyperbolic Regression

### Line Intersection with Spheres and Ellipsoids

### Linear Least Squares

### Linear Regression

### Multivariate Minimization

### Modulo and Integer Division

### Nonlinear Least Squares

### Number Array Type and Detection

### Planar Points and Rectangles

### Polynomial and Chebyshev Regression

### Pressure Units

### Probability Distribution Functions

### Quickselect Order Statistics

### Random Distributions and Shuffling

### Rigid Transforms

### Rounding and Integer Conversion

### Scalar Interpolation and Remapping

### Scalar Minimization

### Scalar Root Finding

### Seeded Random Sources

### Spherical Mount Bases

### Spherical Tangent Planes

### Spherical Triangles and Polygons

### Splines and Interpolation

### Temperature Units

### Trend-Line Regression

### Velocity Units

## 💻 Protocols

### Firmata Board Client

### Firmata DHT

### Firmata Encoders

### Firmata Frequency Measurement

### Firmata I2C

### Firmata One-Wire

### Firmata Scheduler

### Firmata Serial

### Firmata SPI

### Firmata Stepper

### Firmata Wire Protocol

### LX200 Telescope Protocol

### PHD2 Client

### Stellarium Telescope Control Protocol
