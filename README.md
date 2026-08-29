# Nebulosa

Elegant astronomy for TypeScript. Supercharged by Bun.

[![Active Development](https://img.shields.io/badge/Maintenance%20Level-Actively%20Developed-brightgreen.svg)](https://gist.github.com/cheerfulstoic/d107229326a01ff0f333a1d3476e068d)
[![CI](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Nebulosa is a Bun-first, ESM-only TypeScript toolkit for numerical astronomy, astrophotography, and observatory control. It combines precision time and coordinate models, ephemerides, orbital mechanics, scientific image processing, astrometry, catalogs, and hardware protocols in dependency-light modules built for correctness and performance.

## Features

### Astronomy and orbital mechanics

- **Timekeeping and Earth orientation** — two-part Julian dates; UTC, UT1, TAI, TT, TCG, TDB, and TCB conversions; leap seconds, Delta T, sidereal time, IERS data, precession, nutation, and polar motion.
- **Coordinates and observing geometry** — transformations among ICRS, FK5, ITRS, equatorial, ecliptic, galactic, and observed/horizontal coordinates, with refraction, light-time, and radial-velocity corrections.
- **Ephemerides** — NASA DAF/SPK kernels and analytical models for the Sun, planets, Moon, Pluto, and major planetary satellites, including VSOP87E, ELPMPP02, TASS17, GUST86, L12, and MARSSAT.
- **Orbits and artificial satellites** — asteroid and comet elements, MPCORB parsing, Kepler propagation, SGP4 from TLE/OMM, Gauss/Gibbs/Herrick-Gibbs initial orbit determination, differential correction, covariance, MOID, and B-plane analysis.
- **Almanac and event search** — rise/transit/set, twilight, heliacal phases, planetary transits, occultation candidates, satellite passes and eclipses, conjunctions, mutual moon events, and Jupiter central-meridian phenomena.
- **Eclipse geometry** — local circumstances and global map geometry for solar and lunar eclipses, including contacts, visibility, central paths, greatest eclipse/duration, and SVG-ready output.

### Astrometry, catalogs, and sky data

- **Plate solving and WCS** — FITS WCS parsing, SIP distortion fitting, pixel/sky transforms, Astrometry.net index selection, and solver backends for ASTAP, local or nova Astrometry.net, and native libastrometry.
- **Star matching and catalogs** — similarity/affine matching, catalog crossmatching, HEALPix and tiled-sky queries, plus readers for HYG, HNSKY, SAO, UCAC4, and ASTAP `.1476` databases.
- **Online services** — adapters for JPL Horizons and Small-Body Database, SIMBAD, VizieR, HiPS2FITS, and AstroBin.

### Imaging and optical analysis

- **Scientific image I/O** — FITS and XISF reading/writing, image metadata and header utilities, Rice/deflate compression, and TurboJPEG bindings.
- **Calibration and integration** — bias/dark/flat calibration, debayering, cosmetic correction, star registration, global or local normalization, and live or batch stacking with multiple rejection strategies.
- **Processing** — arithmetic, convolution, FFT, multiscale transforms, background extraction and surface fitting, STF and arcsinh stretches, curves, SCNR, color neutralization, and tone mapping.
- **Measurement and diagnostics** — star detection, profile and PSF measurement, subframe selection, Bahtinov focus/chromatic analysis, field-aberration and focus-surface diagnostics, and sensor characterization from PTC through dark current, linearity, saturation, and defect maps.
- **Synthetic data** — generated star fields, flat frames, Bahtinov spikes, and controllable aberration/collimation models for deterministic testing and simulated acquisition.

### Observatory hardware and workflows

- **Device integration** — typed INDI managers and an ASCOM Alpaca REST client, server, and discovery stack for cameras, mounts, focusers, filter wheels, rotators, domes, covers/flat panels, weather stations, and safety monitors.
- **Protocol coverage** — PHD2 guiding, LX200 and Stellarium telescope protocols, plus Firmata boards, sensors, and peripherals.
- **Realistic simulators** — INDI camera, mount, wheel, focuser, rotator, dome, cover, flat-panel, weather, and safety-monitor simulators; the mount models tracking, slewing, guiding, periodic error, wind, settling, parking, and meridian flips.
- **Observation algorithms** — polar alignment, autofocus and backlash calibration, guider calibration and dithering, mosaic framing, dome-slit geometry, and mount alignment, kinematics, pointing models, and meridian-flip planning.

### Numerical foundation

- **Math primitives** — allocation-conscious vectors and matrices, rigid transforms, geometry, interpolation, regression, least squares, root finding, optimization, surface fitting, statistics, and deterministic random generators.
- **Units and data utilities** — angle, distance, velocity, pressure, and temperature conversions together with CSV/XML parsing, compression, checksums, and reusable streaming I/O abstractions.

## Project layout

- [`src/core`](./src/core), [`src/math`](./src/math), and [`src/io`](./src/io) provide the low-level numerical and data foundations.
- [`src/astronomy`](./src/astronomy), [`src/imaging`](./src/imaging), [`src/astrometry`](./src/astrometry), [`src/catalogs`](./src/catalogs), and [`src/observation`](./src/observation) contain the domain algorithms.
- [`src/devices`](./src/devices), [`src/adapters`](./src/adapters), and [`src/bindings`](./src/bindings) form the runtime and integration edges.
- [`tests`](./tests) mirrors the source layout, while [`examples`](./examples) contains runnable protocol and astronomy examples.

## Requirements

- [Bun](https://bun.com) — the sole runtime for the library and its tests.

## Documentation

The API reference is maintained separately. For runnable integrations, see the Alpaca, PHD2, LX200, Firmata, and almanac examples in [`examples`](./examples).

## Development

```sh
bun install          # install dependencies
bun test --parallel  # run the test suite
bun run lint         # lint and type-check
bun run fmt:check    # check formatting
bun run fmt          # format the project
```

## Inspired by

Thanks to all these projects:

- [Skyfield](https://github.com/skyfielders/python-skyfield)
- [Astropy](https://github.com/astropy/astropy)
- [ERFA](https://github.com/liberfa/erfa)
- [Astronomia](https://github.com/commenthol/astronomia)
- [Astrarium](https://github.com/Astrarium/Astrarium)

## License

Released under the [MIT License](./LICENSE). Copyright © 2025 Tiago Melo.
