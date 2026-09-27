# Documentation

These instructions apply to the public documentation site under `docs/`. The root `AGENTS.md` still governs the library and decides whether a change needs documentation. Ruby, Bundler, and Jekyll stay in this directory and must not be added to the root package beyond the existing `docs:serve` and `docs:build` scripts.

Write documentation in English. Document behavior that the current implementation has. Use the exact public names.

## Evidence

Read evidence in this order:

```text
current source implementation
→ current tests
→ current examples
→ current production comments
→ existing documentation
```

Existing documentation does not override code. When code and an older page disagree, correct the page. For scientific provenance, use the standard, paper, or reference implementation already identified by the current code. When more external checking is required, prefer the standard or official implementation for that domain.

## Page kinds

```text
Concepts   canonical conventions shared across topics
Topics     one user-visible capability, or a closely related family
Recipes    workflows that combine several topics
```

`API Reference` is reserved for a future mechanical symbol index. A topic answers what problem the API solves, how to call it correctly, and how to interpret the result. It documents the primary entry points. It does not list every property or export in the file.

A concept states a library-wide convention once. Topics link to it. Fold a narrower convention into an existing concept when it is not itself a user-facing capability. These capabilities stay topics, and other pages may treat them as the canonical reference:

```text
Astronomical Time Scales
Earth Orientation Parameters
Time-Domain Event Search
```

The canonical concept set is:

```text
Units and Conventions
Coordinate Systems and Reference Frames
Accuracy, Models, and Reference Implementations
Image Coordinates, CFA Phase, and Sample Scales
WCS Conventions
Earth Geometry and Ellipsoids
Device Lifecycle and Protocol Boundaries
Mount Coordinate and Sign Conventions
```

Create a concept page only when its text documents behavior that already exists. Rotational transport belongs in Coordinate Systems and Reference Frames. Mutable outputs belong in Units and Conventions, or in the numerical topic that owns them. Shared INDI and Alpaca unit boundaries belong in Device Lifecycle and Protocol Boundaries.

## Finding the page to change

Before adding a page:

1. Search `sources` for the implementation path.
2. Search `api` for the exported symbol.
3. Search titles and page text for the capability.
4. Read the related pages.
5. Decide whether the change extends a topic, needs a new topic, changes a concept, belongs only in a recipe, or needs no public page.

```sh
rg 'src/astronomy/time/time.ts' docs
rg 'timeConvert' docs
```

Update the topic that already owns the capability. Create a topic when the change adds a distinct user-facing capability, or a reader would look for that capability on its own. Update a concept when a shared convention changes. Skip documentation when an internal refactor does not change a public or scientific contract.

## Front matter

Every topic page carries its own code mapping. Do not add a central topic registry.

```yaml
---
title: Astronomical Time Scales
layout: default
parent: Time and Earth Orientation
grand_parent: Astronomy
nav_order: 10
description: Represents and converts astronomical instants among UTC, UT1, TAI, TT, TCG, TDB, and TCB.

doc_kind: topic

sources:
    - src/astronomy/time/time.ts
    - src/astronomy/time/iers.ts

api:
    - Time
    - Timescale
    - timeConvert
---
```

Required on every topic: `title`, `layout`, `parent`, `nav_order`, `description`, `doc_kind: topic`, `sources`, and `api`. Add `grand_parent` when the topic sits under a second-level section. Omit `grand_parent` when the parent is a top-level category.

`sources` lists the primary implementation files that define the public capability. Include a coefficient or data file only when it materially defines that contract. Do not list transitive dependencies. Update the list when ownership moves.

`api` lists the primary exported symbols whose user-facing behavior the page documents. Do not list every helper in the implementation file. Update the list when exports are renamed, removed, or moved.

Concept pages use `doc_kind: concept`. Recipe pages use `doc_kind: recipe`. Add `sources` and `api` on those pages when specific modules or exports define the contract being stated. Category pages do not use `doc_kind`.

`_config.yml` already defaults `layout: default`. Keep `layout: default` in front matter so a copied page still renders inside the theme.

## Topic contract

Use the sections that answer the reader's questions. The usual order is:

```text
What is it?
Why and when would a user call it?
What scientific or technical model does it represent?
How do I call it?
What do the inputs mean?
What do the outputs mean?
Which units, frames, and conventions matter?
What algorithm, accuracy, and limits matter?
What should I use instead in a nearby case?
What related capabilities exist?
```

Headings are flexible. Omit a section that does not apply. Do not leave an empty heading. A domain-specific heading is appropriate when it carries a required part of the contract.

Every topic has:

1. a title;
2. a one- or two-sentence lead;
3. the intended use;
4. current public API usage, when the capability is directly callable;
5. the contract needed to interpret inputs and outputs;
6. important limitations, or an explicit statement that none are material;
7. links to related topics where they help the reader.

Conditional sections:

- **Background.** Required when scientific, mathematical, physical, protocol, or format context is needed to interpret the result. Omit it for a self-explanatory utility.
- **Basic usage.** Required when there is a meaningful call sequence. Omit it for a pure constant table or a page whose purpose is conceptual.
- **Conventions.** Required when the topic adds conventions beyond the library defaults. Link to the concept page instead of repeating those defaults.
- **Accuracy and limitations.** Required for astronomical models, approximations, interpolation, numerical solvers, event searches, image analysis, sensor measurement, propagation, physical estimation, and any API with a validity domain or accuracy trade-off.
- **How it works.** Use it only when the pipeline or algorithm changes how the caller must use the API.
- **Edge cases.** Add them when the behavior is too large for the API or limitations section.
- **References.** Add them when a standard, book, paper, or the implementation's cited source materially helps interpretation.

## Background depth

Use an equation when it clarifies physical meaning, a sign convention, units, coordinate interpretation, result interpretation, algorithm choice, or validity. Prefer definition, then interpretation, then the API mapping. A full derivation that already exists in the literature does not belong on the page.

`W = dR/dt · Rᵀ` belongs on a frame page because it states how rotational velocity is transported. A derivation of the IAU rotation model does not.

## Parallel models

When two APIs compute similar quantities but differ in accuracy, model, provenance, frame, time scale, scope, performance, or intended use, document them on separate pages. On each page state the model, when to use it, and which other topic to prefer in the nearby case.

```text
This implementation uses <model>.
Use it when <case>.
Prefer <other topic> when <case>.
```

Meeus algorithms, ERFA-style reductions, analytical theories, and kernel ephemerides are different models. Typical pairs that need this distinction include Meeus and higher-accuracy reductions, `eraMoon98` and a lunar kernel, analytical ephemerides and SPK, Meeus rise/set and time-domain event search, Meeus refraction and observed-place refraction, geometric pointing errors and a fitted mount model, an image-analysis estimate and sensor characterization, and a protocol client and a shared device manager.

A lower-precision or reference algorithm is not a transparent alias for the primary path.

## API presentation

For a non-trivial function or options object, prefer a table. Keep a column only when it adds information.

| Parameter | Type | Unit / frame | Default | Meaning |
| --------- | ---- | ------------ | ------- | ------- |

| Field | Unit / frame | Meaning |
| ----- | ------------ | ------- |

Do not copy a TypeScript type into prose when the type name already says the same thing. For a small API, describe inputs and outputs in one API section.

## Examples

Build an example from the current `examples/`, then from current tests, then from a minimal snippet checked against the implementation.

An example imports current public symbols, uses the real units and frames, awaits asynchronous calls, and shows cleanup when lifecycle matters. It demonstrates one idea, keeps data small, and contains no invented helper unless that helper is defined in the example. It contains no real or sample secrets, API keys, Wi-Fi passwords, or hardware credentials.

The first example is the smallest useful call sequence. Name later examples by use case. For hardware or network APIs, an example may be illustrative when execution needs external equipment, and it still must call the real library API.

When an example depends on a library API changed in the same work, run the closest library tests or otherwise check the example against that API.

## Mutation and allocation

When mutation or allocation changes how the caller must use the API, state it in this form:

```markdown
**Mutation:** in place
**Allocation:** returns the same image; no new pixel buffer
**Sample range:** values are not clamped
```

```markdown
**Mutation:** none
**Allocation:** allocates a new vector unless `out` is supplied
**Aliasing:** `out` may alias an input
```

Omit the block when allocation is irrelevant to ordinary use. Say whether the return aliases `out`, and whether a fresh value is allocated when `out` is omitted.

## Domain contracts

Document the items that apply to the topic.

### Astronomy, astrometry, and orbits

Coordinate system and frame, origin, epoch and equinox, time scale, apparent versus astrometric versus geometric place, geocentric versus topocentric versus barycentric versus heliocentric origin, angle wrapping and sign, distance and velocity units, model provenance, validity interval, known accuracy, and the higher- or lower-precision alternative.

### Numerical computing

Mathematical definition, input domain, conditioning and singularities, convergence strategy, tolerances, failure and non-convergence behavior, mutation and aliasing, optional output buffers, asymptotic complexity when it affects use, and stability limits. Equations state semantics.

### Imaging

`Image` versus `DigitalImage`, sample scale, valid sample range, zero- or one-based coordinates, +Y direction, pixel-center convention, mono/RGB/CFA support, CFA origin and offset, planar or interleaved storage, in-place versus a fresh result, clipping, border behavior, interpolation and mask behavior, and output dimensions.

### Observation and workflows

State machine and lifecycle, caller responsibilities, required measurements or callbacks, cancellation, convergence and termination, whether the routine is hardware-independent or commands a device, and one complete minimal workflow.

### Devices

Connection lifecycle, capability discovery, state changes, manager units versus library units, asynchronous completion, timeout and cancellation, reconnect behavior, missing capabilities, and simulator differences.

### Protocols

Library-facing units, wire-facing units, framing and encoding, request/reply or event model, correlation, protocol limits, firmware or server capabilities, and disconnect/reconnect semantics. Keep protocol units out of shared manager pages when the manager already converts them.

### I/O and data formats

Supported format or version subset, loaded versus lazy data, seek or stream requirement, planar or interleaved layout, bit depth and sample type, endian handling, compression, mutation and allocation, and unsupported constructs.

### External services

Service purpose, authentication, request type, network behavior, timeout and cancellation, returned units and normalization, `undefined` versus a thrown error or a result object, upstream errors, service-specific limits, and whether the data is queried live.

## Failure and undefined behavior

State the outcome the implementation actually produces: `undefined`, throw, typed failure, clamp, extrapolate, fall back, time out, or ignore an unsupported capability. Document validation behavior only when the implementation has that behavior.

For numerical APIs, distinguish mathematically undefined geometry, an unsupported domain, non-convergence, and invalid input at an untrusted boundary. For network and device APIs, distinguish an unavailable capability, timeout, disconnect, remote or protocol error, and cancellation.

## What to leave out

A topic is not a code walkthrough. Include an internal mechanism only when it affects correctness, interpretation, the performance contract, memory or mutation, lifecycle, compatibility, accuracy, or failure semantics.

Tests are evidence for the author. They are not a section of the public page. Implementation paths stay in `sources`.

## References

Add `## References` when a scientific or technical source helps the reader interpret the result. Prefer IAU, IERS, SOFA/ERFA, NAIF/JPL, ASCOM specifications, the original paper, an established standard, or the source already cited by the implementation. State that the implementation follows a paper or version only when the current code shows that. Utility pages do not need a bibliography.

## Navigation and files

Use at most three levels:

```text
Domain → Section → Topic
```

Add a deeper level only to solve a concrete navigation problem. Number siblings in steps of 10.

```text
Home                    1
Getting Started        10
Concepts               20
Astronomy              30
Astrometry             40
Imaging                50
Catalogs               60
Observation            70
Devices and Protocols  80
I/O and Data Formats   90
External Services     100
Numerical Computing   110
Recipes               120
API Reference         130
```

Second-level sections, created only when a real child exists:

```text
Astronomy: Time and Earth Orientation, Coordinates and Observers, Ephemerides, Meeus Algorithms, Almanac and Events, Eclipses, Orbits and Meteors
Astrometry: Plate Solving, WCS and Distortion, Matching and Crossmatching
Imaging: Image Model and Optics, Stars and Tracking, Calibration and Integration, Processing and Display, Measurement and Diagnostics, Synthetic Data
Catalogs: Catalog Infrastructure, Star Catalogs
Observation: Planning, Polar Alignment, Focus, Guiding, Mount and Dome
Devices and Protocols: INDI, Simulators, ASCOM Alpaca, Firmata, Guiding and Telescope Protocols
I/O and Data Formats: Image Formats, Streaming I/O, Compression and Checksums, Text Formats
Numerical Computing: Units, Linear Algebra and Geometry, Numerical Algorithms, Statistics and Randomness
```

Keep External Services flat until the number of pages makes a section useful. Reader-facing groups are Time and Earth Orientation, not a mirror of `src/`.

Each topic has one canonical parent. Link a capability from another category overview, from Related topics, or from a recipe. Do not publish a second copy. Solar-eclipse search belongs under Astronomy → Eclipses. Hour-angle windows stay with the astronomy event topic and may be linked from Observation → Planning. Bahtinov analysis stays under Imaging measurement and may be linked from Observation focus. A shared device manager has one page when INDI and Alpaca expose the same semantics.

Use lower-case kebab-case directories and filenames that follow the reader hierarchy:

```text
docs/astronomy/time-and-earth-orientation/astronomical-time-scales.md
docs/concepts/units-and-conventions.md
```

Home is `docs/index.md` with `nav_order: 1` and `permalink: /`. Getting Started pages (installation, a short first call, and how to choose a capability) are authored from the current package and runtime after the topic framework exists. The home page links only to pages that exist.

A category page exists only when it has at least one real child. It explains what the section covers, what the reader can accomplish, and links to its important children. A second-level category sets `parent` to the domain title.

`docs/_templates/category.md` and `docs/_templates/topic.md` are authoring templates. `_config.yml` excludes `_templates` and this `AGENTS.md`.

## Links

Use Jekyll's `link` tag so a missing page fails the build:

```markdown
[Time-Domain Event Search]({% link astronomy/almanac-and-events/time-domain-event-search.md %})
```

```markdown
[rotational transport]({% link concepts/coordinate-systems-and-reference-frames.md %}#rotational-transport)
```

Link only to a page that already exists. During a batch of new pages, add a cross-link after both targets exist.

## Callouts

- `{: .note }` — supporting context
- `{: .important }` — a contract required for correct interpretation
- `{: .warning }` — a misuse that can produce a wrong result
- `{: .accuracy }` — a concrete model, approximation, precision, or domain limit

Put a generic warning in `warning` or `important`. Reserve `accuracy` for a scientific or numerical fact. Do not add another callout kind without a repeated documentation need.

```markdown
{: .accuracy }
This analytical model is valid for the documented interval and loses the short-period terms retained by the kernel ephemeris.
```

## Site toolchain

From the repository root:

```sh
bun run docs:serve
bun run docs:build
```

Those scripts run Jekyll in `docs/`. The same build from this directory is `bundle install` followed by `bundle exec jekyll serve` or `bundle exec jekyll build`. The theme is the pinned `just-the-docs` gem. Do not vendor or edit theme internals. Schemes, the theme toggle, and small CSS hooks live under `docs/_sass`, `docs/assets/css`, and `docs/_includes`.

The theme compresses HTML onto single lines. Inline scripts in `_includes/` must survive that: end each statement with a semicolon, and use block comments rather than `//` comments.

Generated output stays out of git: `_site/`, `.sass-cache/`, `.jekyll-cache/`, `.jekyll-metadata`, `.bundle/`, and `vendor/`.

The default scheme is `nebulosa-dark`. The toggle persists only `nebulosa-dark` or `nebulosa-light` under the `theme` key. `jtd.getTheme()` returns the text after the last hyphen, so only the parsed value `light` selects `nebulosa-light`. Loud callout title colors in the theme apply to the scheme name `dark`; `nebulosa-dark` supplies its own callout title colors.

For a docs change, run:

```sh
bun run fmt:check
bun run docs:build
git diff --check
```

Prefer `bun run fmt -- <explicit paths>` when the worktree contains unrelated edits. Pure prose does not require the TypeScript suite.
