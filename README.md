<p align="center">
<img src="https://github.com/tiagohm/nebulosa.ts/blob/main/docs/nebulosa.ico?raw=true" height="128" alt="Nebulosa" />
</p>

<h1 align="center">Nebulosa</h1>

<h4 align="center">Elegant astronomy for TypeScript. Supercharged by Bun.</h4>

[![Active Development](https://img.shields.io/badge/Maintenance%20Level-Actively%20Developed-brightgreen.svg)](https://gist.github.com/cheerfulstoic/d107229326a01ff0f333a1d3476e068d)
[![CI](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Documentation](https://img.shields.io/badge/Documentation-GitHub_Pages-purple.svg)](https://tiagohm.github.io/nebulosa.ts)

Nebulosa is a zero dependencies, Bun-first, ESM-only TypeScript toolkit for numerical astronomy, astrophotography, and observatory control. It combines precision time and coordinate models, ephemerides, orbital mechanics, scientific image processing, astrometry, catalogs, and hardware protocols.

## Requirements

- [Bun](https://bun.com) — the sole runtime for the library and its tests.

## Installation

```sh
bun add --trust github:tiagohm/nebulosa.ts
```

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
