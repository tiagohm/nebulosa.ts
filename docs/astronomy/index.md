---
title: Astronomy
layout: default
nav_order: 30
has_children: true
description: Times, coordinates, ephemerides, and events.
---

# Astronomy

Times, coordinates, ephemerides, and events for bodies and observers.

## Time and Earth Orientation

[Astronomical Time Scales]({% link astronomy/time-and-earth-orientation/astronomical-time-scales.md %}) stores one instant as a two-part Julian Date and converts it among UT1, UTC, TAI, TT, TCG, TDB, and TCB.

[Sidereal Time and Earth Rotation Angle]({% link astronomy/time-and-earth-orientation/sidereal-time-and-earth-rotation-angle.md %}) evaluates equinox-based sidereal angles and CIO-based Earth rotation.

[Precession, Nutation, and Obliquity]({% link astronomy/time-and-earth-orientation/precession-nutation-and-obliquity.md %}) evaluates the celestial equator and ecliptic orientations of date.

[Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) combines celestial and polar-motion rotations and evaluates instantaneous Earth spin.

[Civil UTC Timestamps]({% link astronomy/time-and-earth-orientation/civil-utc-timestamps.md %}) handles calendar arithmetic and formatting on Unix-millisecond UTC timestamps.

[Delta T]({% link astronomy/time-and-earth-orientation/delta-t.md %}) estimates TT − UT1 from a decimal calendar year.

[Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) loads IERS DUT1 and polar-motion data used by time and frame calculations.

## Coordinates and Observers

[Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) rotates vectors and position–velocity states among celestial and Earth-fixed axes without shifting their origins.

[Affine Origin Frames]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) translates absolute states between origins while rotating their axes.

[Galactocentric Frame]({% link astronomy/coordinates-and-observers/galactocentric-frame.md %}) expresses Sun-relative positions around the Galactic center with configurable geometry.

[Local Standard of Rest Frames]({% link astronomy/coordinates-and-observers/local-standard-of-rest-frames.md %}) applies conventional solar-motion offsets to velocities.

[Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) converts directions between equatorial, ecliptic, and Galactic angular coordinates.

[Angular Separation and Position Angle]({% link astronomy/coordinates-and-observers/angular-separation-and-position-angle.md %}) measures distance and bearing between two equatorial sky directions.

[Angular Motion]({% link astronomy/coordinates-and-observers/angular-motion.md %}) derives direction rates, radial velocity, and sampled tracking rates.

[Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) computes finite-target astrometric and apparent directions from supplied barycentric states.

[Light-Time Solution]({% link astronomy/coordinates-and-observers/light-time-solution.md %}) solves light travel time between moving states and returns the retarded geometric vector.

[Starlight Deflection]({% link astronomy/coordinates-and-observers/starlight-deflection.md %}) models gravitational bending from supplied Solar System bodies.

[Annual Aberration]({% link astronomy/coordinates-and-observers/annual-aberration.md %}) corrects a source direction for the observer's velocity.

[Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) converts stellar directions to observed azimuth, altitude, and equatorial angles.

[Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) computes the altitude shift from atmospheric refraction at one wavelength.

[Differential Refraction and Atmospheric Dispersion]({% link astronomy/coordinates-and-observers/differential-refraction-and-atmospheric-dispersion.md %}) predicts wavelength-dependent angular and pixel separation.

[Constellations]({% link astronomy/coordinates-and-observers/constellations.md %}) finds the IAU sky region containing an equatorial direction.

[Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) creates a geodetic site for Earth-fixed position, sidereal time, and topocentric geometry.

[Geographic Sub-point]({% link astronomy/coordinates-and-observers/geographic-sub-point.md %}) finds the geodetic location beneath an Earth-centered GCRS position.

[Location GCRS Frame]({% link astronomy/coordinates-and-observers/location-gcrs-frame.md %}) orients vectors and states on a site's north, east, and up axes.

[Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) computes geometric azimuth and altitude from equatorial angles and local sidereal time.

[Local ENU and Taki Frames]({% link astronomy/coordinates-and-observers/local-enu-and-taki-frames.md %}) rotates horizontal, equatorial, and mount-local vectors through ENU axes.

[Local Horizon Mask]({% link astronomy/coordinates-and-observers/local-horizon-mask.md %}) interpolates local obstructions and finds sampled path crossings.

[Equatorial Mount Geometric Pointing Errors]({% link astronomy/coordinates-and-observers/equatorial-mount-geometric-pointing-errors.md %}) applies equatorial mount coefficients and tube flexure to pointing coordinates.

[Alt-Az Field Rotation]({% link astronomy/coordinates-and-observers/alt-az-field-rotation.md %}) calculates geometric field rotation and derotator angles for an alt-az mount.

[Sky Projections]({% link astronomy/coordinates-and-observers/sky-projections.md %}) maps spherical sky or geographic coordinates to planar charts.

[Projected Paths and Polygons]({% link astronomy/coordinates-and-observers/projected-paths-and-polygons.md %}) prepares drawable chart segments across map seams and projection gaps.

[HEALPix]({% link astronomy/coordinates-and-observers/healpix.md %}) groups equatorial directions into pixels and searches an in-memory spatial index.

[Radial Velocity Correction]({% link astronomy/coordinates-and-observers/radial-velocity-correction.md %}) computes the observer-motion term to add to a measured stellar radial velocity.

## Observation and Planning

[Observation Scores]({% link observation/observation-scores.md %}) combines supplied target geometry, twilight, Moon interference, and duration into a planning score.

[Weather Quality]({% link observation/weather-quality.md %}) combines available weather readings into an imaging-planning score.

[Mount Tracking Rates]({% link observation/mount-tracking-rates.md %}) provides nominal equatorial drive rates and conversions among rate units.

## Imaging

[Telescope Optical Estimates]({% link imaging/telescope-optical-estimates.md %}) estimates magnification, resolving limits, light collection, and eyepiece field.

[Image Scale and Sampling]({% link imaging/image-scale-and-sampling.md %}) estimates arcseconds per pixel, sensor field, diffraction size, and mosaic coverage.

[Exposure and Noise Estimates]({% link imaging/exposure-and-noise-estimates.md %}) estimates SNR, dynamic range, saturation, and frame counts from supplied sensor and sky values.

[Trailing and Smear Limits]({% link imaging/trailing-and-smear-limits.md %}) estimates pixel drift and blur-limited exposure durations.

## Observing Formulas

[Airmass and Extinction]({% link astronomy/observing-formulas/airmass-and-extinction.md %}) estimates line-of-sight airmass, atmospheric magnitude loss, and a simple refraction correction.

[Dew Point and Frost]({% link astronomy/observing-formulas/dew-point-and-frost.md %}) estimates condensation temperatures, dew margin, and dew risk from ambient conditions.

[Transit Altitude and Hour Angle]({% link astronomy/observing-formulas/transit-altitude-and-hour-angle.md %}) estimates a fixed-declination target's culmination altitude and altitude-crossing hour angle.

[Angular Size and Planning Magnitudes]({% link astronomy/observing-formulas/angular-size-and-planning-magnitudes.md %}) estimates apparent size, mean surface brightness, and simple comet and asteroid magnitudes.
