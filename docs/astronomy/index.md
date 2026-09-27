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

[Earth Rotation and Orientation]({% link astronomy/time-and-earth-orientation/earth-rotation-and-orientation.md %}) evaluates sidereal angles and the Earth's celestial-to-terrestrial orientation at that instant.

[Civil UTC Timestamps]({% link astronomy/time-and-earth-orientation/civil-utc-timestamps.md %}) handles calendar arithmetic and formatting on Unix-millisecond UTC timestamps.

[Delta T]({% link astronomy/time-and-earth-orientation/delta-t.md %}) estimates TT − UT1 from a decimal calendar year.

[Earth Orientation Parameters]({% link astronomy/time-and-earth-orientation/earth-orientation-parameters.md %}) loads IERS DUT1 and polar-motion data used by time and frame calculations.

## Coordinates and Observers

[Celestial and Terrestrial Reference Frames]({% link astronomy/coordinates-and-observers/celestial-and-terrestrial-reference-frames.md %}) rotates vectors and position–velocity states among celestial and Earth-fixed axes without shifting their origins.

[Affine Origin Frames]({% link astronomy/coordinates-and-observers/affine-origin-frames.md %}) translates absolute states between origins while rotating their axes.

[Galactocentric Frame]({% link astronomy/coordinates-and-observers/galactocentric-frame.md %}) expresses Sun-relative positions around the Galactic center with configurable geometry.

[Local Standard of Rest Frames]({% link astronomy/coordinates-and-observers/local-standard-of-rest-frames.md %}) applies conventional solar-motion offsets to velocities.

[Spherical Coordinate Conversions]({% link astronomy/coordinates-and-observers/spherical-coordinate-conversions.md %}) converts sky angles and measures separation and position angle.

[Angular Motion]({% link astronomy/coordinates-and-observers/angular-motion.md %}) derives direction rates, radial velocity, and sampled tracking rates.

[Apparent Direction]({% link astronomy/coordinates-and-observers/apparent-direction.md %}) computes finite-target astrometric and apparent directions from supplied barycentric states.
