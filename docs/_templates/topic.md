---
title: Topic Title
layout: default
parent: Section Title
grand_parent: Domain Title
nav_order: 10
description: One-sentence description of the capability.

doc_kind: topic

sources:
    - src/path/to/primary.ts

api:
    - primaryExport
---

# Topic Title

Write one or two sentences explaining what this capability does and why a
library user would use it.

## Background

Explain only the scientific, mathematical, physical, protocol, or technical
background required to interpret and use the API correctly.

## When to use

Explain the intended use. When relevant, say when another Nebulosa capability
should be preferred.

## Basic usage

```ts
// Smallest useful example using the current public API.
```

## API

Describe the primary entry points needed for this capability. Use parameter and
return tables when units, frames, defaults, conventions, or constraints would
otherwise be ambiguous.

## Conventions

Document topic-specific units, frames, time scales, origins, axes, wrapping,
sample ranges, mutation, allocation, or lifecycle semantics. Link to canonical
Concept pages instead of repeating library-wide rules.

## How it works

Include only when understanding the pipeline or algorithm helps the caller use
the API correctly.

## Accuracy and limitations

State model provenance, approximation, validity domain, numerical limitations,
sampling assumptions, singularities, unsupported behavior, failure or undefined
semantics, and known accuracy when relevant.

## Related topics

Link only to existing pages.

<!--
Authoring notes, not page content:

- Omit every irrelevant section.
- Do not leave empty headings.
- Custom domain-specific sections are allowed.
- Drop grand_parent when the topic sits directly under a top-level category.
-->
