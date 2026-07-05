# Nebulosa

Elegant astronomy for TypeScript. Supercharged by Bun.

[![Active Development](https://img.shields.io/badge/Maintenance%20Level-Actively%20Developed-brightgreen.svg)](https://gist.github.com/cheerfulstoic/d107229326a01ff0f333a1d3476e068d)
[![CI](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Nebulosa is a Bun-first, ESM-only TypeScript library for astronomy and astrophotography. It brings high-precision time and coordinate handling, ephemerides, image processing, and telescope-device integration into a single, dependency-light toolkit built for numerical correctness and performance.

## Features

- **Time & coordinates** — high-precision time scales, frames, and transformations between equatorial, horizontal, ecliptic, and galactic systems.
- **Ephemerides & orbits** — planetary and small-body positions, orbital elements, and astronomical event computation.
- **Astrometry & projections** — plate solving support, sky projections, and star catalog access.
- **Imaging** — FITS and XISF reading/writing, tone and color processing, star detection, and synthetic image generation.
- **Devices** — Alpaca, INDI, and Firmata clients plus guiding for observatory hardware control.
- **Observation** — higher-level routines for alignment, focus, framing, guiding, and mount control.

The source is organized under `src/` into layered domain folders (`core`, `math`, `io` at the base; `astronomy`, `imaging`, `astrometry`, `catalogs`, `observation` on top; `devices`, `adapters`, `bindings` at the runtime edges).

## Requirements

- [Bun](https://bun.com) — the sole runtime for the library and its tests.

## Documentation

The API reference is maintained separately. This README covers the project overview only.

## Development

```sh
bun install       # install dependencies
bun run lint      # lint and type-check
bun run fmt       # format
bun test          # run the test suite
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
