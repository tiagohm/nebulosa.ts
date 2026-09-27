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

[Barycentric and Heliocentric Light-Time Correction]({% link astronomy/coordinates-and-observers/barycentric-and-heliocentric-light-time-correction.md %}) shifts a TDB observation date by its geometric path-length offset.

[Planetary Surface Locations]({% link astronomy/coordinates-and-observers/planetary-surface-locations.md %}) locates a point on a tri-axial body and evaluates its rotational position and velocity.

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

## Algorithms

[ERFA / SOFA Algorithms]({% link astronomy/erfa-sofa-algorithms.md %}) exposes low-level numerical recipes for time, Earth orientation, astrometry, and geodesy.

[Low-Precision Earth Ephemeris]({% link astronomy/low-precision-earth-ephemeris.md %}) provides analytical barycentric and heliocentric Earth states in BCRS axes.

[Low-Precision Lunar Ephemeris]({% link astronomy/low-precision-lunar-ephemeris.md %}) provides an approximate geocentric lunar state in GCRS-oriented axes.

[DAF and SPK Kernels]({% link astronomy/daf-and-spk-kernels.md %}) opens NAIF binary kernels and evaluates supported center-to-target SPK segments.

[Binary PCK Rotation]({% link astronomy/binary-pck-rotation.md %}) evaluates a kernel-defined body-fixed rotation and its angular rate.

[SPICE Text Kernels and Frames]({% link astronomy/spice-text-kernels-and-frames.md %}) loads text kernel constants for body radii and planetary frame resolution.

[Ephemeris Paths and Observed Positions]({% link astronomy/ephemeris-paths-and-observed-positions.md %}) composes states and distinguishes geometric, light-time, and apparent stages.

[Ephemeris Path Adapters]({% link astronomy/ephemeris-path-adapters.md %}) creates compatible paths from SPK, SGP4, and surface-state providers.

[VSOP87E Planetary Theory]({% link astronomy/vsop87e-planetary-theory.md %}) evaluates analytical barycentric states for the Sun and eight planets.

[ELP/MPP02 Lunar Theory]({% link astronomy/elp-mpp02-lunar-theory.md %}) evaluates the Moon's analytical geocentric state and velocity.

[Galilean Satellite Theory (L1.2)]({% link astronomy/galilean-satellite-theory-l12.md %}) evaluates analytical Jupiter-centered states for the four Galilean moons.

[Saturnian Satellite Theory (TASS1.7)]({% link astronomy/saturnian-satellite-theory-tass17.md %}) evaluates analytical Saturn-centered states for eight major moons.

[Uranian Satellite Theory (GUST86)]({% link astronomy/uranian-satellite-theory-gust86.md %}) evaluates analytical Uranus-centered states for five major moons.

[Martian Satellite Theory (MARSSAT)]({% link astronomy/martian-satellite-theory-marssat.md %}) evaluates analytical Mars-centered states for Phobos and Deimos.

[Pluto Short Analytical Theory]({% link astronomy/pluto-short-analytical-theory.md %}) estimates Pluto's heliocentric position from a short periodic series.

[Equatorial Ephemeris Interpolation]({% link astronomy/equatorial-ephemeris-interpolation.md %}) fits sampled right ascension and declination over time.

[Astrometric Sample-Grid Interpolation]({% link astronomy/astrometric-sample-grid-interpolation.md %}) evaluates sky directions between sampled image pixels.

[Meeus Numerical Helpers]({% link astronomy/meeus-numerical-helpers.md %}) supplies chapter-style interpolation, fitting, iteration, and shared formulas.

[Meeus Calendar]({% link astronomy/meeus-calendar.md %}) converts chapter-style calendar labels, Julian days, and modeled TT dates.

[Meeus Easter Dates]({% link astronomy/meeus-easter-dates.md %}) calculates Easter Sunday in the Gregorian or Julian calendar.

[Meeus Sidereal Time]({% link astronomy/meeus-sidereal-time.md %}) evaluates chapter-style Greenwich sidereal time in seconds of time.

[Meeus Globe Ellipsoid]({% link astronomy/meeus-globe-ellipsoid.md %}) computes chapter-style Earth radii, parallax factors, and surface distances.

[Meeus Coordinate Transforms]({% link astronomy/meeus-coordinate-transforms.md %}) converts chapter-style ecliptic, equatorial, horizontal, and B1950 Galactic angles.

[Meeus Precession]({% link astronomy/meeus-precession.md %}) rotates chapter-style sky coordinates and orbital elements between Julian epochs.

[Meeus Nutation and Obliquity]({% link astronomy/meeus-nutation-and-obliquity.md %}) evaluates chapter-style nutation angles and mean obliquity.

[Meeus Apparent Place of a Star]({% link astronomy/meeus-apparent-place-of-a-star.md %}) reduces a mean stellar position with Meeus precession, nutation, and annual aberration.

[Meeus Parallactic Angle]({% link astronomy/meeus-parallactic-angle.md %}) evaluates chapter-style parallactic and horizon-intersection angles.

[Meeus Topocentric Parallax]({% link astronomy/meeus-topocentric-parallax.md %}) shifts a geocentric Meeus body position to an observer using Earth parallax factors.

[Meeus Refraction Formulas]({% link astronomy/meeus-refraction-formulas.md %}) provides chapter-style scalar corrections between true and apparent altitude.

[Meeus Approximate Rise, Transit, and Set]({% link astronomy/meeus-approximate-rise-transit-and-set.md %}) estimates one UT1 day's crossings and upper transit from apparent positions.

[Meeus Solar Day Clock]({% link astronomy/meeus-solar-day-clock.md %}) estimates solar noon, limb events, twilight, and golden-hour boundaries for a UT1 day.

[Meeus Solar Coordinates]({% link astronomy/meeus-solar-coordinates.md %}) evaluates short and VSOP87E geocentric solar positions and vectors.

[Meeus Equinoxes and Solstices]({% link astronomy/meeus-equinoxes-and-solstices.md %}) estimates season boundaries from Meeus tables or a VSOP87E solar-longitude refinement.

[Meeus Equation of Time]({% link astronomy/meeus-equation-of-time.md %}) calculates the Meeus apparent-minus-mean solar-time angle.

[Meeus Keplerian Elements]({% link astronomy/meeus-keplerian-elements.md %}) solves chapter-style Kepler equations and evaluates fixed solar-orbit elements.

[Meeus Geocentric Planet Positions]({% link astronomy/meeus-geocentric-planet-positions.md %}) explains the heliocentric planet coordinates that feed Meeus geocentric reductions.

[Meeus Apsis and Node Passages]({% link astronomy/meeus-apsis-and-node-passages.md %}) estimates planetary apsides and fixed-orbit node crossing times.

[Meeus Planetary Phenomena]({% link astronomy/meeus-planetary-phenomena.md %}) estimates chapter-table conjunctions, oppositions, Mercury elongations, and a Mars station.

[Meeus Conjunction Interpolation]({% link astronomy/meeus-conjunction-interpolation.md %}) locates coordinate conjunctions from five supplied position samples.

[Meeus Alignment Geometry]({% link astronomy/meeus-alignment-geometry.md %}) measures separations, dates sampled great-circle crossings, and encloses compact triples.

[Meeus Illuminated Fraction]({% link astronomy/meeus-illuminated-fraction.md %}) computes planetary phase angles, lit disk fractions, and bright-limb direction.

[Meeus Planetary Magnitudes]({% link astronomy/meeus-planetary-magnitudes.md %}) estimates visual brightness from distances, phase, and Saturn-ring geometry.

[Solar disk physical ephemeris]({% link astronomy/solar-disk-physical-ephemeris.md %}) computes solar-disk orientation and approximate Carrington rotation starts.

[Meeus Mars Disk]({% link astronomy/meeus-mars-disk.md %}) describes the pole, central meridian, size, and illumination of Mars's apparent disk.

[Meeus Jupiter Disk]({% link astronomy/meeus-jupiter-disk.md %}) documents System I and II central meridians and Jupiter's apparent pole angle.
