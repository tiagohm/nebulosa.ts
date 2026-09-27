---
title: Astronomy
layout: default
nav_order: 30
has_children: true
description: Times, coordinates, ephemerides, and events.
---

# Astronomy

Times, coordinates, ephemerides, and events for bodies and observers.

[Time and Earth Orientation]({% link astronomy/time-and-earth-orientation/index.md %}) provides instants on the astronomical timescales, and the Earth orientation those instants select.

[Coordinates and Observers]({% link astronomy/coordinates-and-observers/index.md %}) allows to choose the axes and origin needed to express a position, direction, or velocity, and apply the matching transformation.

[Observing Formulas]({% link astronomy/observing-formulas/index.md %}) estimates the atmospheric conditions and target geometry when planning an observation.

[ERFA / SOFA Algorithms]({% link astronomy/erfa-sofa-algorithms.md %}) exposes low-level numerical recipes for time, Earth orientation, astrometry, and geodesy.

[Meeus Algorithms]({% link astronomy/meeus-algorithms/index.md %}) collects the chapter-style astronomy calculations, disk geometry, and observing formulas.

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

[IAU Body Orientation]({% link astronomy/iau-body-orientation.md %}) evaluates cartographic pole and prime-meridian models and builds body-fixed frames.

[Sub-Observer and Sub-Solar Points]({% link astronomy/sub-observer-and-sub-solar-points.md %}) projects the observer and Sun onto a rotating body and measures its pole angle.

[Solar Parallax and Semidiameter]({% link astronomy/solar-parallax-and-semidiameter.md %}) scales solar horizontal parallax and angular radius from a Sun-observer distance.

[Carrington Rotation]({% link astronomy/carrington-rotation.md %}) assigns a mean synodic solar-rotation index to a Julian day.

[Season Instants and Equation of Time]({% link astronomy/season-instants-and-equation-of-time.md %}) estimates TT season boundaries and apparent-minus-mean solar time.

[Solar Saros Index]({% link astronomy/solar-saros-index.md %}) labels a modeled lunation with its van den Bergh solar Saros series.
