# Documentation

These instructions apply to everything under `docs/`. The repository root `AGENTS.md` still applies; this file adds the documentation-specific contract.

Nebulosa public documentation is intentionally a **single-page docsify reference**. The source is `docs/README.md`, rendered by `docs/index.html`.

The documentation is not an API reference and not a textbook. Each topic explains **why a capability exists and what it represents**, scientifically or technically, and then shows how to call it in one short example. The API contract itself (options, defaults, enumerations, result fields, failure reasons, mutation, and allocation) lives in the documentation comments of the source code, which callers read from their editor.

Write documentation in **English**.

## Methodology

A topic has two parts, and the weight is deliberately on the first:

1. **Context**: the scientific, physical, mathematical, or technical background that makes the capability meaningful. What quantity, effect, model, or workflow it represents; why an astronomer or developer needs it; the defining equation or convention when it prevents misuse; the model or approximation and its validity; and the important distinction from a nearby capability. This is the most valuable part of the documentation and should be kept and improved.
2. **One example**: a single `ts` code block that calls every public function and method of the topic. Each function or step is explained by one or two comment lines in the example, not by prose paragraphs.

The reason for this methodology is maintenance: documenting every option, field, default, and diagnostic in prose made every internal change produce lines of documentation that added nothing for the reader. A topic must stay valid across internal changes; it changes only when its science, its public functions and methods, or a limitation that changes correct use changes.

## Documentation architecture

Keep the current architecture:

- `docs/README.md` — all public documentation content;
- `docs/index.html` — docsify shell, plugins, theme, and site configuration;
- `docs/_coverpage.md` — cover page;
- `docs/.nojekyll` — GitHub Pages support.

Do not create one file per topic, add front matter, introduce a sidebar, or move topics out of `docs/README.md`. Do not replace docsify or redesign the documentation structure unless that is the explicit task.

The documentation hierarchy is:

```text
# Installation / Documentation
## Domain
### Topic
```

Current documentation domains, in this order:

```text
⭐ Astronomy
📐 Astrometry
🖼️ Imaging
🔭 Observation
📖 Catalogs
🖲️ Devices
🌐 External Services
💾 I/O and Data Formats
🔢 Numerical
💻 Protocols
```

Keep topics alphabetically ordered inside their domain. Do not use `####` subsections; split a topic that needs them into coherent capabilities instead.

## Topic format

````markdown
### Topic Title

<context: what the quantity, effect, model, or workflow is and why it matters;
a defining equation or convention when it prevents misuse>

<scope: what the capability does with it, when to use it, the model or
approximation, and the limitation or nearby alternative that changes the
choice of API>

```ts
import { foo, bar } from 'nebulosa/src/domain/module'

// What foo does, in one line. Inputs with units when not obvious.
const result = foo(input)

console.log(result.value) // meaning and unit

// What bar does, in one line.
bar(result)
```
````

Rules:

- **Exactly one code block per topic**, a `ts` example. A topic may also hold one short `text` block for defining equations when inline code would be unreadable; it is context, not an example. Wire formats, file samples, or protocol messages belong as comments or strings in the `ts` example.
- **No prose after the example.** Everything a reader needs to interpret the topic comes before the code, or as a comment in it.
- Do not add `Context`, `Overview`, `Inputs`, `Outputs`, or `API` headings, parameter tables, or warning boxes.
- Keep paragraphs short. A typical topic is two or three paragraphs of context and scope and one example only as long as its functions require, one or two comment lines and one call each.

## What belongs in the prose

Write in the prose:

- the quantity being computed and its physical or mathematical meaning;
- the defining equation, coordinate frame, time scale, sign convention, or unit that a reader could otherwise misinterpret;
- the model, approximation, or algorithm family and its domain of validity, when it affects the choice of API;
- why the capability exists: the observational or engineering problem it solves;
- the important distinction from a nearby capability, with a link to it;
- a limitation that changes correct use (validity window, singular geometry, unsupported case, synchronous long-running work).

Do not write in the prose:

- lists of options, defaults, enumeration values, or result fields;
- failure reasons, diagnostics, error classes, or validation behavior;
- mutation, aliasing, `out` arguments, allocation, buffer reuse, or caching, unless misuse would silently produce wrong results;
- internal algorithm steps, thresholds, iteration counts, tolerances, or implementation trade-offs;
- source file walkthroughs, or explanations of functions that the example already shows;
- a restatement of what the example already shows.

That information belongs in the documentation comments of the source code.

## The example

The example is the only API documentation of the topic. Keep it short and direct:

- Call every public function and method owned by the topic: the functions a caller uses for the capability, the constructor and public methods of a class, and the lifecycle of a stateful or device API. Functions with the same contract (variants for other bodies, frames, or precisions) may share one call with a comment naming the others. Do not enumerate options, modes, or enumeration values.
- Leave out exports that are not part of the caller-facing capability: error classes, validation helpers, implementation helpers exported only for sibling modules or tests (codecs, simulator internals, geometry primitives of a detector), and type-only exports.
- Explain each call with one or two comment lines above it: what it does, and the meaning and unit of inputs that are not obvious.
- Show results with `console.log(x) // meaning and unit`. Write a concrete value only when it helps interpretation and is verified (see Expected outputs); otherwise write its meaning.
- Use small deterministic inputs. When building an input would take many lines (a synthetic image, a star list, a device), declare it in a comment instead, such as `// frames: StackingFrame[] — normalized images with their detected stars`, or use a repository fixture (`data/...`).
- Use real current import paths: `import { foo } from 'nebulosa/src/domain/module'`, without `.ts`, never a barrel or a private path. Use `import type` when only a type is needed.
- Example calls must match current signatures.
- Never include credentials, API keys, Wi-Fi passwords, private hosts, or personal data.

For stateful or device APIs, show the lifecycle the implementation requires and nothing more:

```ts
const client = ...

await client.connect()

try {
	// Use the capability.
} finally {
	client.close()
}
```

## Source of truth

Before writing or editing a topic, inspect the implementation that defines the capability and its closest tests. Executable behavior is authoritative; production comments are evidence, existing documentation never overrides current code. Do not change production code to make documentation easier to explain.

Do not write non-obvious technical claims from memory. Verify signs and directions (for `A - B`, check which side is positive), units, frames, origins, time scales, angle wrapping, and whether a statement holds for every call path or only the default one. The wording must not be stronger than the evidence: if a claim with `always`, `never`, `only`, `same`, or `exact` cannot be verified across options, providers, and backends, narrow it or remove it.

Distinguish model provenance from accuracy: "uses ERFA model X" does not imply "accurate to Y". Quote an accuracy only when the implementation, tests, or an authoritative source supports it for the stated domain.

Keep the public, library-facing representation distinct from the protocol or wire representation: device topics describe the normalized library units, protocol topics describe the wire format and conversion boundary.

## Expected outputs

When a comment shows a concrete value, verify it, in this order of preference: a current test expectation, a runnable example, a small Bun snippet against the current implementation, or an authoritative external reference. Do not invent an output. When the output depends on the current time, network, hardware, or asynchronous device state, write its meaning instead. Show only the precision useful to the reader.

## When documentation must change

Documentation changes only when the reader's understanding would otherwise be wrong:

- a capability is added, removed, or renamed;
- a public function or method is added, removed, or renamed, or one used by the example changes its import path or signature: add it to, or update it in, the example of its topic as a comment line and a call;
- the science changes: the quantity, model, frame, time scale, unit, sign convention, or a limitation that changes correct use.

Adding an option, a result field, a diagnostic, a failure reason, a default, or an internal step does not change the documentation; document it in the source comments. Internal refactors never change it.

## Topics

Before creating a topic, search `docs/README.md` for the symbol, the capability, and related terms. Prefer editing the existing topic when the change is another operation, variant, mode, or helper of the same capability. Create a new topic only for a capability with an independent user goal and its own scientific or technical context; a new file, class, helper, or table is not a reason.

Split a topic only when it has become genuinely complex: it covers several distinct capabilities, each with its own context and its own group of functions, so that one example can no longer show them clearly. Merge topics when they describe the same capability or call the same functions, so that each capability has one canonical topic. Do not split or merge for length alone. When a title changes or disappears, update every link to it.

Name a topic with the established scientific or technical term a user would search for, such as `Satellite Conjunctions`, `Earth Orientation Parameters`, or `Three-Point Polar Alignment`, and preserve standard names and acronyms (ERFA, SOFA, Meeus, SGP4, WCS, FITS, HEALPix, INDI, ASCOM Alpaca, PHD2).

## Cross-topic links

Link to another topic with a same-page link whose text is the visible target title, such as `see [Apparent Direction](#apparent-direction)`. Verify the docsify anchor of titles with punctuation, `/`, `&`, parentheses, acronyms, or emoji, and never link to a topic that does not exist. Link explicit alternatives and prerequisites; do not repeat a link in the same paragraph. A capability has one canonical topic: link to it instead of repeating its explanation.

## Global navigation and docsify behavior

Keep the compact jump-to-domain navigation, and update it when a domain is added or renamed. Do not add topic links to the top of the page. When editing `docs/index.html`, preserve the single-page behavior, the cover page, `hideSidebar: true`, syntax highlighting, search, the theme, and the GitHub link, and add no unrelated plugins.

## Final correctness pass

Before finishing a new topic or an edit, check that:

1. the topic has the context that explains why it exists and what it represents;
2. it has exactly one `ts` example block and no prose after it;
3. every documented symbol and import exists, every call matches its current signature, and every public function and method owned by the topic appears in the example;
4. every concrete output is verified;
5. units, signs, frames, origins, and time scales are correct;
6. broad claims survive non-default call paths;
7. links point to existing headings;
8. no option list, default, result field, or failure reason was added to the prose.

## Documentation verification

For documentation-only changes, follow the root `AGENTS.md` verification policy, at minimum:

```sh
bun fmt --check
git diff --check
```

Preview the site with `bun run docs` when useful; a successful render proves formatting and navigation, not scientific correctness. When links were added or titles changed, verify that every anchor resolves and titles remain unique. When `docs/index.html` changed, verify the cover page, search, and TypeScript highlighting.
