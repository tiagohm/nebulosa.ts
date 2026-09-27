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

Existing documentation does not override code. When code and an older page disagree, correct the page.

Production comments are evidence, not authority. When a comment describes behavior that can be checked from executable code or tests, verify that behavior before repeating the comment in public documentation. Do not propagate a stale comment merely because it is adjacent to the implementation.

Issues, implementation plans, prompts, reviews, and design descriptions are context only. They do not establish current behavior.

For scientific provenance, use the standard, paper, or reference implementation already identified by the current code. When more external checking is required, prefer the standard or official implementation for that domain.

A page title, a public type name, or a self-evident signature does not need the claim checks in the following verification sections.

## Technical claim verification

Do not write a non-obvious technical claim from memory, from a symbol name, or from a superficial reading of one function.

Before publishing a material claim about any of the following, trace it to current code and, when practical, to a relevant test, executable example, or authoritative reference:

- sign or direction of an offset, error, correction, derivative, axis, or rate;
- units or unit conversion;
- coordinate frame, origin, handedness, axis direction, or orientation;
- epoch, equinox, calendar convention, or time scale;
- angle wrapping or normalization;
- default value or implicit fallback;
- mutation, aliasing, cache behavior, or allocation;
- clamping, extrapolation, interpolation, or normalization;
- failure, `undefined`, exception, timeout, cancellation, or fallback behavior;
- precision, tolerance, validity interval, approximation, or accuracy;
- protocol representation versus public or library representation;
- whether a function uses, bypasses, delegates to, or depends on another model, table, provider, backend, or conversion.

The wording in the page must not be stronger than the evidence.

If behavior is conditional on the input scale, frame, backend, options, device state, provider, or configuration, document the condition instead of describing the behavior as universal.

### Signs and directed relationships

For a derived relationship such as `A − B`, write the relationship explicitly while verifying it.

For example, if a concrete instant shows:

```text
GPS = 00:00:00
TAI = 00:00:19
```

then verify separately that:

```text
TAI − GPS = +19 s
GPS − TAI = −19 s
```

A correct numeric example does not prove that the prose names the subtraction in the correct direction.

Apply the same check to altitude or azimuth errors, east/west and north/south corrections, mount and polar-alignment signs, radial velocities, frame angular velocities, protocol offsets, clock offsets, image coordinate directions, and positive or negative rotation conventions.

## Behavioral call-path verification

When documenting what a public API does or does not use, inspect the full relevant call path rather than only the public function body. A trivial getter or constant whose body is the whole contract does not need a deeper trace.

Trace delegation far enough to determine whether behavior changes with input type, input time scale, coordinate frame, backend, provider override, options, device capability, state, protocol adapter, or cache state.

Do not claim that an API "does not use", "ignores", "bypasses", "always", "never", "only", "directly", or "cannot" do something unless that statement is true for every supported path covered by the documentation.

If only the final stage of an operation has a property, state that narrowly.

```text
Incorrect:
timeToUnix does not use the leap-second table.

Correct:
timeToUnix first converts non-UTC inputs to UTC; that conversion can use the
leap-second table. The final UTC-to-counter mapping treats the UTC day as
86400 seconds.
```

For a wrapper, dispatcher, manager, or adapter, inspect the implementation it delegates to before describing the wrapper's semantics.

## Absolute and equivalence wording

Treat these words as high-risk technical claims: always, never, only, all, none, same, identical, equivalent, exact, directly, does not, cannot.

Before using one, check the supported domain and the non-default paths. Prefer a condition when the behavior depends on one: "For UTC input…", "With the default provider…", "When `location` is unset…", "On the manager-facing API…", "For the tabulated interval…".

Use an absolute statement when the implementation establishes it for the documented domain.

## High-risk claims

For a claim about sign or direction, unit conversion, coordinate frame or origin, epoch or time scale, a protocol-to-public conversion, claimed numerical accuracy, or a scientific validity interval, prefer two forms of evidence when both are available:

```text
implementation + test
implementation + authoritative reference
implementation + independently executed example
```

If only one trustworthy form exists, state the claim conservatively. Do not imply a stronger accuracy, provenance, or universality than that evidence supports. Do not change source behavior merely to make a documentation claim easier to verify.

## Representation boundaries

Whenever data crosses a representation boundary, verify the contract on both sides before documenting it.

```text
public API ↔ protocol
public API ↔ external service
raw image ↔ processing image
catalog or file format ↔ normalized object
UTC, TAI, TT, and the other scales ↔ external timestamp representation
native binding ↔ TypeScript API
```

For each material conversion, determine the incoming representation, the outgoing representation, the units, the frame or coordinate convention, the normalization, the precision loss, and the sentinel or failure representation. Do not infer one side from the other.

## Defaults and overrides

When an API supports a default model, provider, or backend plus overrides, document them separately.

Verify which default is actually selected, where it is resolved, whether an override is copied or shared, whether cached results depend on the provider identity, and whether the override applies to every call path or only some of them.

Do not describe default behavior as unconditional behavior when a public override can change it. Use wording such as "With the default provider…", "Unless `providers.dut1` is supplied…", or "The manager normalizes the backend value before exposing it…".

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

`api` is a documentation-ownership index, not an export inventory. Include a public symbol when a future change to that symbol's user-facing contract should normally cause this page to be reconsidered. Do not include a symbol solely because the page mentions it once, it is a transitive helper, it lives in a listed source file, or a test uses it incidentally. A topic may own many symbols when they form one coherent public capability, and every entry needs that ownership reason. Update the list when exports are renamed, removed, or moved.

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

### Concrete numerical results

Every concrete numerical result shown in public documentation must be verified against the current implementation.

Prefer, in order:

1. a value already asserted by a current test;
2. an existing runnable example;
3. a small Bun snippet executed against the current source;
4. an authoritative external reference when the documentation is explicitly describing an external standard or reference value.

Do not copy a numeric value from an old page, issue, inventory, comment, or plan without checking it.

When documenting a scientific relationship involving a sign, unit, frame, epoch, or time scale, verify both the numerical result and the prose interpretation of that result. A numerically correct example can still have an incorrectly described sign, direction, frame, or scale.

### Example execution

When a documentation snippet is intended to be executable and does not require external hardware or credentials, run it, or reduce it to a testable equivalent, before finishing the page.

For a hardware, network, or external-service example that cannot be run locally, verify that every imported symbol exists, that argument order and types match the current API, that units and conversions match the current public contract, that async work and cleanup follow the implementation, and that the snippet does not imply an unsupported state transition.

Do not make a snippet appear executable when essential setup has been omitted. Mark an intentionally partial snippet as partial.

## Mutation and allocation

When mutation or allocation changes how the caller must use the API, state it in this form:

```markdown
**Mutation:** in place\
**Allocation:** returns the same image; no new pixel buffer\
**Sample range:** values are not clamped
```

```markdown
**Mutation:** none\
**Allocation:** allocates a new vector unless `out` is supplied\
**Aliasing:** `out` may alias an input
```

Omit the block when allocation is irrelevant to ordinary use. Say whether the return aliases `out`, and whether a fresh value is allocated when `out` is omitted.

Note the `\` appended, it is used to break the line.

### Mutation, caching, and serialization

When documenting mutation, caching, aliasing, cloning, or serialization, verify the actual object-property behavior.

Check, when relevant, whether the input object is mutated, whether the returned object is the same reference, whether buffers or arrays are shared, whether cache objects are shared, which properties are enumerable, what `JSON.stringify` retains, and what `structuredClone` retains or rejects.

Do not infer serialization behavior from TypeScript interfaces.

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

Document connection lifecycle, capability discovery, state changes, public manager/library-facing units, asynchronous completion, timeout and cancellation, reconnect behavior, missing capabilities, and simulator differences.

When a device is reachable through more than one backend, describe the public manager contract independently from the backend-specific wire representation.

### Protocols

Distinguish these layers when they exist:

1. public/library-facing API;
2. adapter or client internal representation;
3. protocol/wire representation.

Document units and conventions at the layer where they are exposed.

State library-facing units, wire-facing units, framing and encoding, request/reply or event model, correlation, protocol limits, firmware or server capabilities, and disconnect/reconnect semantics.

Do not describe protocol units as manager or library units merely because the adapter receives or stores those values internally.

When a manager normalizes a protocol value into the library convention, the manager page documents the library convention and the protocol page documents the conversion boundary.

Boundary differences that require explicit verification include radians versus degrees, right ascension in radians versus protocol hours, AU/day versus a backend velocity unit, milliseconds versus seconds, normalized image samples versus source DN, and enum or state names versus protocol numeric codes.

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

### Accuracy claims

Do not convert implementation provenance into an accuracy claim without evidence.

"Uses ERFA `eraDtDb`" is a provenance or model statement. "Accurate to X" is an accuracy statement and needs support for X.

When quoting an accuracy, a validity interval, or an error bound, determine whether it belongs to the original algorithm, this implementation, a particular input domain, or a test fixture. State that scope. Do not transfer an upstream bound to a modified implementation unless the implementation still satisfies the assumptions behind that bound.

## Scientific documentation sanity check

Before finishing a scientific, numerical, astrometric, imaging, or protocol topic, re-read the page for:

1. units and conversions;
2. signs and directions;
3. frames, origins, handedness, epochs, equinoxes, and time scales;
4. defaults, providers, fallback paths, and non-default inputs;
5. concrete numerical values;
6. validity and accuracy claims;
7. mutation, aliasing, caching, and allocation when material;
8. protocol or external-service boundaries;
9. absolute wording such as "always", "never", "only", "same", "equivalent", "does not", and "directly".

For each non-trivial statement in those categories, confirm that the exact wording is supported by the current implementation and its relevant evidence. This is a correctness pass, not a prose or style pass.

## Final adversarial documentation review

After writing a new topic, or materially changing a scientific or technical topic, perform a separate correctness pass whose goal is to falsify the page. Do not merely proofread it.

Actively try to find a counterexample:

- for every "always", "never", "only", "same", "equivalent", "does not", or "directly", test whether a non-default input changes the statement;
- reverse every directed offset or error and confirm which subtraction or sign the code implements;
- inspect non-default scales, frames, providers, options, backends, and device states that could alter the behavior;
- verify every concrete numeric result;
- confirm that units shown in tables belong to the public API layer being documented;
- confirm that an accuracy or validity statement applies to the implementation, not merely to one fixture, example, or upstream algorithm;
- confirm that failure and fallback language covers the actual branches;
- confirm that a source comment used as evidence still matches executable code.

If a sentence is broader than the evidence, narrow it. If a claim cannot be verified, remove it or explicitly state the uncertainty. Do not fill the gap from memory.

### Scratch verification for complex topics

For a complex scientific or protocol page, keep a temporary scratch checklist while authoring. Record the claim, the evidence, and whether it was verified. An example row is "TAI − GPS = +19 s at the GPS epoch", evidenced by `timeGPS` plus a test or snippet.

This checklist is working material. Do not publish it and do not commit it unless the task specifically requires a provenance artifact.

## Authoring workflow

For a new topic or a substantial technical update:

1. identify the canonical topic and page;
2. read the primary `sources`;
3. inspect the relevant tests and examples;
4. identify the public `api` ownership;
5. write the minimal reader-facing explanation;
6. verify material technical claims as they are introduced;
7. execute or otherwise validate concrete examples and values;
8. inspect relevant non-default call paths;
9. perform the scientific sanity check;
10. perform the adversarial correctness pass;
11. run the targeted implementation checks that support new concrete claims;
12. run `bun run fmt:check`, `bun run docs:build`, and `git diff --check`.

Do not postpone a technical check until after the whole page is written when the claim can be checked immediately. Ordinary low-risk prose does not need the two-evidence or call-path procedure.

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

Before the site build, run the targeted code, test, or snippet checks needed to support new concrete technical claims.

`bun run docs:build` verifies the documentation site structure and Jekyll syntax. It does not prove that a scientific, mathematical, protocol, or numerical claim is correct.

For a docs change, run:

```sh
bun run fmt:check
bun run docs:build
git diff --check
```

Prefer `bun run fmt -- <explicit paths>` when the worktree contains unrelated edits. Pure prose does not require the TypeScript suite.
