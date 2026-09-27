---
title: Coordinates and Observers
layout: default
parent: Astronomy
nav_order: 20
has_children: true
description: Coordinate frames, transformations, and observer geometry for astronomical vectors and states.
---

# Coordinates and Observers

Choose the axes and origin needed to express a position, direction, or velocity, and apply the matching transformation.

[Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) rotates vectors and position–velocity states among celestial, intermediate, and Earth-fixed axes without shifting their origins.

[Affine Origin Frames]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) combines a frame rotation with an origin position and velocity for absolute states, including heliocentric ecliptic coordinates.

[Galactocentric Frame]({% link astronomy/coordinates-and-observers/galactocentric-frame.md %}) places absolute Sun-relative positions on axes centered at the Galactic center.

[Local Standard of Rest Frames]({% link astronomy/coordinates-and-observers/local-standard-of-rest-frames.md %}) applies conventional solar-motion offsets to Cartesian velocities in ICRS or Galactic axes.

[Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) converts sky angles between equatorial, ecliptic, and Galactic axes and measures separations and position angles.

[Angular Motion]({% link astronomy/coordinates-and-observers/angular-motion.md %}) derives angular and radial rates from Cartesian states or sampled sky positions.

[Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) computes light-time-corrected astrometric and apparent directions from supplied barycentric states.

[Light-Time Solution]({% link astronomy/coordinates-and-observers/light-time-solution.md %}) solves finite light travel time and returns the geometric observer-to-target vector.

[Starlight Deflection]({% link astronomy/coordinates-and-observers/starlight-deflection.md %}) applies gravitational bending from supplied Solar System bodies to finite or stellar directions.

[Annual Aberration]({% link astronomy/coordinates-and-observers/annual-aberration.md %}) shifts a natural direction using the observer's barycentric velocity.

[Topocentric Observed Place]({% link astronomy/coordinates-and-observers/topocentric-observed-place.md %}) converts stellar ICRS or CIRS directions to local observed angles with optional refraction.

[Refractive Displacement]({% link astronomy/coordinates-and-observers/refractive-displacement.md %}) computes the atmospheric lift at one wavelength and converts between true and apparent altitude.

[Differential Refraction and Atmospheric Dispersion]({% link astronomy/coordinates-and-observers/differential-refraction-and-atmospheric-dispersion.md %}) predicts chromatic separation on the sky and optionally on an image sensor.

[Constellations]({% link astronomy/coordinates-and-observers/constellations.md %}) labels an equatorial direction with its IAU sky region using B1875 boundaries.

[Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) defines a geodetic Earth site and computes its ITRS position, local sidereal time, and parallax factors.

[Geographic Sub-point]({% link astronomy/coordinates-and-observers/geographic-sub-point.md %}) converts a geocentric GCRS position to geodetic longitude, latitude, and ellipsoidal height.

[Location GCRS Frame]({% link astronomy/coordinates-and-observers/location-gcrs-frame.md %}) rotates GCRS-oriented vectors and states into local north, east, and up axes.

[Local Horizon Coordinates]({% link astronomy/coordinates-and-observers/local-horizon-coordinates.md %}) converts equatorial angles to geometric azimuth and altitude using a supplied local sidereal angle.

[Local ENU and Taki Frames]({% link astronomy/coordinates-and-observers/local-enu-and-taki-frames.md %}) expresses horizontal, equatorial, and mount-local directions as ENU vectors.

[Local Horizon Mask]({% link astronomy/coordinates-and-observers/local-horizon-mask.md %}) checks a sampled sky path against a circular minimum-altitude profile.

[Equatorial Mount Geometric Pointing Errors]({% link astronomy/coordinates-and-observers/equatorial-mount-geometric-pointing-errors.md %}) predicts optical-axis offsets from mount geometry and tube flexure.

[Alt-Az Field Rotation]({% link astronomy/coordinates-and-observers/alt-az-field-rotation.md %}) estimates sensor field rotation, smear-limited exposures, and derotator commands.

[Sky Projections]({% link astronomy/coordinates-and-observers/sky-projections.md %}) maps sky or geographic angles to a plane and splits chart paths at wraps and discontinuities.

[HEALPix]({% link astronomy/coordinates-and-observers/healpix.md %}) partitions equatorial directions into pixels and queries an in-memory spatial index.
