# Documentation

These instructions apply to the public documentation site under `docs/`. The root `AGENTS.md` still governs the library. Ruby, Bundler, and Jekyll stay in this directory and must not be added to the root package, Bun scripts, or test runner.

## Language and source of truth

Write documentation in English.

The current implementation is the source of truth. Read the code and tests before describing an API. Do not document planned, unfinished, or removed behavior. Use the exact public names and real source paths, such as `src/astronomy/time.ts`.

Examples must call the current API. When a signature, unit, frame, or return value changes, update the example in the same change.

## What a page needs to say

Prefer this order, and drop a section that does not apply:

```text
what it is
→ scientific/technical context
→ when to use it
→ API usage
→ inputs
→ outputs
→ conventions
→ limitations
→ related topics
```

State units for every physical or numerical quantity. Unless the page documents a different convention, angles are radians, distances are AU, velocities are AU/day, temperatures are degrees Celsius, and pressure is millibar (`hPa`). Say whether a time interval is in days or seconds.

Name coordinate frames, reference systems, epochs, and time scales wherever the result depends on them. State the model, approximation, domain, and accuracy limit when a routine is not the primary ephemeris or an exact transform.

Do not describe two algorithms as interchangeable when they differ in precision, frame, timescale, or meaning. Link to the canonical concept page instead of copying that explanation into every topic.

The concept pages to prefer, once they contain real content, are:

```text
Units and Conventions
Astronomical Time Scales
Coordinate Systems and Reference Frames
Accuracy, Models, and Reference Implementations
Image Coordinates, CFA Phase, and Sample Scales
```

Do not create those pages until the text documents behavior that already exists.

## Documentation impact

A change to a public API, observable behavior, scientific interpretation, unit, frame, convention, supported workflow, accuracy claim, or limitation needs a documentation update in the same change. An internal refactor with no observable change does not.

Before finishing a library change, decide whether any page under `docs/` is now wrong or incomplete. Update that page, or record that no page exists yet and the behavior is still undocumented. Do not add an empty page only to mark the gap.

## Navigation

Create a page only when it has meaningful content. Do not add empty categories to reserve a place in the sidebar.

Top-level categories, in reader order:

```text
Home
Getting Started
Concepts
Astronomy
Astrometry
Imaging
Catalogs
Observation
Devices and Protocols
Recipes
API Reference
```

Home is `docs/index.md` with `nav_order: 1` and `permalink: /`. Number sibling pages in the order readers should meet them, usually in steps of 10.

`_config.yml` sets `layout: default` for every page. Keep that key in new front matter so a copied page still renders inside the theme.

Category front matter:

```yaml
---
title: Astrometry
layout: default
nav_order: 30
has_children: true
---
```

Topic front matter:

```yaml
---
title: Plate Solving
layout: default
parent: Astrometry
nav_order: 20
---
```

Use a deeper parent only when it helps a reader find the topic. Do not mirror `src/` directories in the navigation.

`docs/_templates/category.md` and `docs/_templates/topic.md` are authoring templates. `_config.yml` excludes `_templates` and this `AGENTS.md`, so neither appears in the built site or the navigation.

## Callouts

Use the configured callouts for these meanings:

- `{: .note }` — supporting context
- `{: .important }` — a contract required for correct interpretation
- `{: .warning }` — a misuse that can produce wrong results
- `{: .accuracy }` — model, approximation, precision, or domain limitations

Do not add another callout kind without a repeated documentation need.

## Site toolchain

From `docs/`:

```sh
bundle install
bundle exec jekyll serve
bundle exec jekyll build
```

The theme is the pinned `just-the-docs` gem. Do not vendor or edit theme internals. Schemes, the theme toggle, and small CSS hooks live in the files already under `docs/_sass`, `docs/assets/css`, and `docs/_includes`.

The theme compresses HTML onto single lines. Inline scripts in `_includes/` must survive that: end each statement with a semicolon, and use block comments rather than `//` comments.

Generated output stays out of git: `_site/`, `.sass-cache/`, `.jekyll-cache/`, `.jekyll-metadata`, `.bundle/`, and `vendor/`.

The default scheme is `nebulosa-dark`. The toggle stores only `nebulosa-dark` or `nebulosa-light` under `theme`. Do not switch the stock `dark` and `light` schemes in directly.
