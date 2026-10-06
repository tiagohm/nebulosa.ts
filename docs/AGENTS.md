# Documentation

These instructions apply to everything under `docs/`. The repository root `AGENTS.md` still applies; this file adds the documentation-specific contract.

Nebulosa public documentation is intentionally a **single-page docsify reference**. The source is `docs/README.md`, rendered by `docs/index.html`.

The documentation is not a generated API reference and not a textbook. It is a compact, example-driven guide to the capabilities exposed by `nebulosa.ts`.

Write documentation in **English**.

## Documentation architecture

Keep the current architecture:

- `docs/README.md` — all public documentation content;
- `docs/index.html` — docsify shell, plugins, theme, and site configuration;
- `docs/_coverpage.md` — cover page;
- `docs/.nojekyll` — GitHub Pages support.

Do not create one file per topic.

Do not add front matter.

Do not introduce a sidebar or `_sidebar.md`.

Do not move topics out of `docs/README.md`.

Do not replace docsify or redesign the documentation structure unless that is the explicit task.

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

Keep topics alphabetically ordered inside their domain unless a concrete reader workflow justifies another local order.

Use `####` inside a topic only when a genuinely large topic becomes materially clearer with a subsection. Prefer splitting an oversized topic into coherent capabilities instead of introducing deep heading hierarchies.

## Source of truth

Before writing or editing a topic:

1. inspect the current implementation that defines the capability;
2. inspect the closest relevant tests;
3. inspect current examples when available;
4. inspect direct callers or neighboring modules when needed to understand the real contract.

Use evidence in this order:

```text
current implementation
→ current tests
→ current examples
→ current production comments
→ existing documentation
→ issues, plans, inventories, prompts, and old descriptions
```

Executable behavior is authoritative.

Production comments are evidence, not authority. Verify a non-obvious claim before repeating it.

Existing documentation never overrides current code.

Do not preserve an obsolete statement merely because an older topic already contains it.

Do not change production code only to make documentation easier to explain.

# When documentation must change

A source change requires reviewing the public documentation when it changes a user-visible or scientific contract, including:

- a public function, class, method, option, type, or constant used by callers;
- observable behavior;
- accepted inputs or returned outputs;
- units or unit conversion;
- coordinate system, frame, origin, handedness, or axis direction;
- epoch, equinox, calendar convention, or time scale;
- angle wrapping, normalization, or sign convention;
- model, approximation, algorithm, or validity domain;
- numerical accuracy or tolerance visible to callers;
- failure, `undefined`, exception, timeout, cancellation, or fallback behavior;
- mutation, aliasing, allocation, caching, or ownership semantics that affect use;
- protocol/wire versus library-facing representation;
- device capability, state, lifecycle, connection, or cleanup behavior;
- supported workflow;
- an externally visible limitation.

An internal refactor that preserves the public and scientific contract does not require a documentation edit.

When a public capability is removed, renamed, or substantially reworked, update or remove its documentation in the same change.

# Find the owning topic before creating a new one

Before creating a topic, search `docs/README.md` for:

- the public symbol;
- the capability name;
- related terminology;
- existing cross-references.

Then inspect the closest existing topic.

Prefer **editing an existing topic** when the new behavior is:

- another operation of the same capability;
- a forward/inverse pair;
- another constructor or representation of the same abstraction;
- a variant of the same model;
- a helper that only makes sense with the parent capability;
- another option or mode of an already documented workflow.

Create a **new topic** when the capability has an independent user goal and would reasonably be searched for by itself.

A strong new-topic candidate usually has several of these properties:

- its own scientific or technical context;
- its own intended use;
- its own important limitations or model choice;
- an independent public API cluster;
- an independent input/output contract;
- a useful standalone code example;
- callers can use it without first understanding another candidate capability.

Do not create a topic merely because:

- a new file exists;
- a new class or interface exists;
- a helper is exported;
- a coefficient table is public;
- implementation code moved;
- a namespace contains many symbols.

Topic boundaries follow **user-facing capabilities**, not the source tree.

# Topic naming

Use concise, established scientific or technical terminology.

A title should name what a user would search for.

Prefer:

```text
Satellite Conjunctions
Earth Orientation Parameters
Elliptical Moffat Fitting
FITS TAN and SIP Coordinate Mapping
Three-Point Polar Alignment
```

Avoid source-oriented or vague names unless the source abstraction is itself the public concept.

Avoid unnecessary conjunctions when the parts are independently useful capabilities.

Do not invent terminology merely to make a title shorter.

Preserve standard names and acronyms such as:

```text
ERFA
SOFA
Meeus
SGP4
WCS
FITS
HEALPix
INDI
ASCOM Alpaca
PHD2
```

# Topic format

A normal topic should have this shape:

````markdown
### Topic Title

<short scientific/technical context when it helps interpretation>

<what the capability does, where to use it, and important limitations or
nearby alternatives when relevant>

```ts
// Small, direct usage example.
const result = foo(...)

console.log(result) // expected output — meaning/unit
```
````

````

Do not add mandatory `Context`, `Overview`, `Inputs`, `Outputs`, or `API` headings.

The documentation should read naturally as compact prose followed by code.

A topic normally consists of:

1. **context**, only when scientific/physical/mathematical/technical background helps the reader use the API correctly;
2. **overview and scope**, explaining what the capability does, where to use it, and important cases where it should not be used;
3. **basic usage**, demonstrating the public callable surface owned by the topic.

The code example is the primary API documentation.

Keep the topic as short as possible without omitting information required for correct use.

# Scientific and technical context

Add context when the API represents a non-obvious:

- astronomical quantity;
- physical effect;
- mathematical operation;
- coordinate transformation;
- numerical method;
- image-processing model;
- protocol concept;
- observation/control workflow.

Explain only what is needed to interpret the API.

Useful context may include:

- the quantity being computed;
- a short physical interpretation;
- a defining equation;
- a coordinate frame;
- a time scale;
- a sign convention;
- an approximation/model;
- why a nearby algorithm is different.

Use equations when they clarify meaning or prevent misuse.

Do not add:

- long derivations;
- historical essays;
- textbook material that does not affect use;
- implementation detail that the caller does not need.

# Overview and scope

Explain:

- what the capability does;
- what problem it solves;
- where it should be used;
- what the important inputs mean;
- what the result means.

When there is a realistic ambiguity, also state:

- what it intentionally does not do;
- where it should not be used;
- what nearby Nebulosa topic/API should be preferred instead;
- why the distinction matters.

Important distinctions include:

- approximate versus higher-precision models;
- geometric versus apparent/observed quantities;
- geocentric versus topocentric/barycentric/heliocentric origin;
- analytical ephemeris versus SPK/kernel ephemeris;
- protocol/wire representation versus normalized library/device-manager representation;
- image measurement versus sensor characterization;
- distinct event-search or numerical methods.

Do not claim that two APIs are equivalent merely because they produce similarly named quantities.

# Basic usage

Every topic must contain at least one TypeScript code block.

Keep examples intentionally simple. Their purpose is to demonstrate how to use the library, not to build an application around the API.

Prefer:

```ts
import { foo } from 'nebulosa/src/some/module'

// c: input description and unit.
// d: input description and unit.
const [a, b] = foo(c, d)

console.log(a) // 5.0 — result description and unit
console.log(b) // 2.0 — result description and unit
````

For structured results:

```ts
const result = solve(...)

console.log(result.value) // expected value — meaning
console.log(result.error) // expected value — meaning
```

For asynchronous APIs:

```ts
const result = await query(...)
console.log(result)
```

For stateful/device APIs, demonstrate the smallest correct lifecycle:

```ts
const client = ...

await client.connect()

try {
	// Demonstrate the capability.
} finally {
	client.close()
}
```

Use the lifecycle the actual implementation requires. Do not add ceremonial setup or cleanup that the API does not need.

# Public API coverage

Within the example, cover every **public callable entry point owned by the topic**.

This means:

- exported functions for a functional capability;
- constructor/factory plus relevant public methods for a class-based capability;
- lifecycle operations for stateful/device capabilities;
- important options required for normal use.

Functions with the same contract may share one example.

Do not turn the example into an export dump.

Do not enumerate unrelated exports merely because they live in the same file.

Types and constants need to appear only when they are necessary to use or interpret the capability.

Large umbrella topics such as raw ERFA/SOFA or Meeus coverage may use more than one code block when one block would become unreadable. Do not split those umbrellas merely to document every low-level routine separately.

# Imports

Use real current import paths.

Imports from Nebulosa use the package source path and omit `.ts`:

```ts
import { foo } from 'nebulosa/src/domain/module'
```

Do not invent a package barrel that does not exist.

Do not import from a private/internal path merely because it makes an example shorter.

Use `import type` when the example only needs a type and that improves clarity.

# Example inputs

Choose inputs that make the behavior easy to understand.

Prefer:

- small deterministic values;
- simple geometry;
- explicit dates;
- small arrays;
- short time windows;
- synthetic values when real external data is unnecessary.

Use repository fixtures when they make an I/O, catalog, image, SPK, or solver example concrete.

Paths beginning with `data/...` refer to repository checkout fixtures. The global documentation note explains that consumer applications replace those paths with their own files; do not repeat that warning in each topic.

Never include:

- real credentials;
- API keys;
- Wi-Fi passwords;
- private hosts;
- personally identifying data.

# Expected outputs

When a code comment contains a concrete result:

```ts
console.log(value) // 5.0
```

verify it.

Prefer, in order:

1. an existing current test expectation;
2. an existing runnable example;
3. a small Bun snippet run against the current implementation;
4. an authoritative external reference when the value is defined by an external standard/model.

Do not invent an output to complete an example.

For floating-point output, show only precision supported by the implementation and useful to the reader.

When exact output depends on:

- current time;
- network data;
- external service state;
- hardware;
- asynchronous device state;
- environment-specific native behavior;

show the result's shape or meaning instead of fabricating a deterministic value.

# Verify technical claims

Do not write non-obvious technical claims from memory.

Explicitly verify claims involving:

- sign or direction;
- units or conversion factors;
- frames, origins, handedness, or axes;
- epochs, equinoxes, calendars, or time scales;
- angle wrapping or normalization;
- defaults, providers, or fallbacks;
- mutation, aliasing, caching, or allocation;
- protocol versus public representation;
- numerical accuracy, tolerance, approximation, or validity;
- failure behavior;
- whether one API delegates to or depends on another model/provider/backend.

The wording must not be stronger than the evidence.

## Signs and directed relationships

For relationships such as `A - B`, verify the direction explicitly.

If:

```text
A = 19
B = 0
```

check both:

```text
A - B = +19
B - A = -19
```

A correct numerical example can still have an incorrectly worded sign.

Apply the same care to:

- clock/time offsets;
- polar-alignment errors;
- east/west and north/south corrections;
- radial velocities;
- mount-axis signs;
- frame angular velocities;
- image axes;
- protocol offsets;
- positive/negative rotation conventions.

## Call-path verification

Before writing an absolute statement such as:

```text
always
never
only
all
none
same
identical
equivalent
exact
directly
does not
cannot
```

inspect the relevant call path.

Check whether behavior changes with:

- time scale;
- coordinate frame;
- options;
- provider override;
- backend;
- protocol adapter;
- device capability/state;
- cache state;
- input representation.

If the claim only applies to the default path, say so:

```text
With the default provider...
For UTC input...
When no backend override is supplied...
On the library-facing API...
```

Do not generalize one path to every supported input.

# Units, frames, and scientific conventions

Nebulosa defaults remain those in the root `AGENTS.md`, but a topic must state the relevant convention when a reader could otherwise misinterpret the example.

Pay particular attention to:

- radians versus degrees versus hours;
- AU versus km versus meters;
- AU/day versus km/s;
- days versus seconds versus milliseconds;
- apparent versus astrometric versus geometric positions;
- ICRS/BCRS/GCRS/CIRS/TIRS/ITRS/TEME and other frames;
- geocentric/topocentric/barycentric/heliocentric origins;
- image coordinates and +Y direction;
- zero-based versus one-based pixel/reference coordinates;
- normalized image samples versus digital numbers;
- CFA origin/phase;
- protocol-facing units versus library-facing units.

Do not infer the public/library unit from the protocol representation.

# Accuracy, models, and limitations

Document a limitation when it changes correct use.

Examples:

- validity interval;
- approximation/model;
- unsupported physical term;
- singular geometry;
- non-convergence;
- interpolation/extrapolation behavior;
- finite sampling;
- unavailable capability;
- upstream/service restriction.

Distinguish **model provenance** from **accuracy**.

For example:

```text
Uses ERFA model X.
```

does not imply:

```text
Accurate to Y.
```

Only quote a numerical accuracy/error bound when the current implementation, tests, or an authoritative source supports that bound for the stated domain.

Do not transfer an upstream algorithm's accuracy claim to a modified implementation without verifying the assumptions still hold.

# Mutation, allocation, and ownership

Mention mutation or ownership only when it affects correct use.

Document when relevant:

- the input is mutated;
- the return aliases an input or `out`;
- a fresh object/vector/buffer is allocated;
- storage is borrowed and overwritten on the next call;
- the caller owns a returned resource;
- a cache object is shared;
- cleanup/disposal is required.

Do not infer runtime ownership from TypeScript types alone.

# Devices and protocols

Keep these layers distinct when they exist:

```text
public/library-facing API
↕ adapter conversion
protocol/wire representation
```

Device-manager topics document the normalized library-facing contract.

Protocol topics document the wire representation and conversion boundary.

Do not describe protocol units as manager/library units merely because an adapter stores or receives them internally.

For device topics document, when relevant:

- connection lifecycle;
- capability discovery;
- state changes;
- command completion semantics;
- timeout/cancellation;
- reconnect behavior;
- missing capabilities;
- simulator behavior.

For protocol topics document, when relevant:

- framing/encoding;
- request/reply/event model;
- correlation;
- wire units;
- numeric/string encodings;
- protocol limits;
- disconnect/reconnect semantics.

# Imaging topics

When relevant, state:

- `Image` versus `DigitalImage`;
- normalized samples versus DN;
- sample type/precision;
- zero-based coordinates;
- pixel-center convention;
- x/y direction;
- grayscale/RGB/CFA support;
- CFA phase/origin;
- in-place versus fresh output;
- clipping or values outside the nominal range;
- output dimensions;
- border/interpolation behavior.

Do not assume processed images remain in `[0, 1]`.

# Numerical topics

When relevant, state:

- mathematical definition;
- input domain;
- units;
- conditioning/singularities;
- convergence method;
- tolerance meaning;
- failure/non-convergence behavior;
- mutation/output buffers;
- stability limitations.

Do not turn numerical documentation into a derivation of the algorithm.

# I/O and external-service topics

For I/O, document when relevant:

- supported format/version subset;
- stream/seek requirements;
- bit depth/sample type;
- endian behavior;
- compression;
- lazy versus materialized data;
- output ownership;
- unsupported constructs.

For external services, document when relevant:

- purpose;
- authentication requirement;
- request type;
- network behavior;
- timeout/cancellation;
- returned units;
- normalization;
- live versus cached data;
- upstream errors.

Never place credentials in examples.

# Cross-topic links

When a topic refers readers to another existing topic, use a same-page internal link rather than plain text.

Prefer:

```markdown
see [Apparent Direction](#apparent-direction)
```

instead of:

```text
see Apparent Direction
```

Use the visible target title as the link text.

Verify the actual docsify anchor, especially for titles containing:

- punctuation;
- `/`;
- `&`;
- parentheses;
- acronyms;
- emoji.

Do not guess a non-trivial slug.

Do not create a link to a topic that does not exist.

Avoid over-linking. Link explicit alternatives, prerequisites, and useful `see X` references; repeated mentions in the same paragraph usually do not need repeated links.

A capability has one canonical topic. Prefer links over duplicating the same explanation in several topics.

# Global navigation and docsify behavior

The documentation keeps a compact jump-to-domain navigation rather than a full topic table of contents.

When adding or renaming a top-level domain, update that navigation.

Do not add hundreds of topic links to the top of the page.

Docsify search should remain able to discover:

- topic names;
- public symbols;
- scientific terminology;
- protocols and formats.

When editing `docs/index.html`, preserve unless the task explicitly changes them:

- docsify single-page behavior;
- cover page;
- `hideSidebar: true`;
- syntax highlighting;
- search;
- current theme;
- GitHub repository link.

Do not add unrelated docsify plugins.

# Editing an existing topic

When source behavior changes:

1. find the owning topic;
2. reread the whole topic, not only the line mentioning the changed symbol;
3. update the prose contract;
4. update affected calls in the example;
5. update expected outputs when behavior legitimately changed;
6. verify those outputs independently;
7. update limitations, units, frames, lifecycle, or alternatives if affected;
8. check incoming/outgoing cross-topic links.

Do not leave stale compatibility prose after an API has changed.

Do not preserve an old output just because it was already documented.

Never change documented expected values merely to accommodate a suspected numerical regression; first establish that the implementation is correct.

# Adding a new topic

For a new public capability:

1. identify the owning domain;
2. verify no existing topic already owns the capability;
3. choose a concise user-facing title;
4. insert the new `###` topic in alphabetical order;
5. write only the scientific/technical context needed for use;
6. describe purpose, intended use, limitations, and nearby alternatives;
7. add a small TypeScript example that covers the public callable API owned by the topic;
8. verify concrete outputs;
9. add useful cross-topic links;
10. confirm the topic is discoverable by docsify search.

If the capability requires several unrelated contexts and unrelated examples, reconsider whether it is actually multiple topics.

If the proposed topic would contain only a trivial helper, reconsider whether it belongs in an existing topic.

# Style

Write clear technical English.

Prefer:

- short paragraphs;
- direct sentences;
- established terminology;
- concrete code;
- units beside values;
- comments close to the call they explain;
- expected outputs inline.

Avoid:

- marketing language;
- filler introductions;
- repetitive headings;
- large parameter tables when code is clearer;
- exhaustive source walkthroughs;
- speculative behavior;
- unnecessary warnings/notes boxes;
- repeating global conventions in every topic;
- repeating the `data/...` fixture note.

The documentation should answer:

```text
What is this?
Why/when would I use it?
How do I call it correctly?
How do I interpret the result?
What important limitation could make me choose something else?
```

No more than needed.

# Final correctness pass

Before finishing a new topic or substantial edit, do a separate correctness review.

Check:

1. every documented symbol exists;
2. every public callable API owned by the topic is represented;
3. imports match the current repository;
4. example calls match current signatures;
5. concrete outputs are verified;
6. units are correct;
7. signs/directions are correct;
8. frames/origins/time scales are correct;
9. default behavior is not confused with override behavior;
10. protocol units are not confused with library units;
11. accuracy/validity claims have evidence;
12. mutation/ownership statements match runtime behavior;
13. broad words such as `always` and `never` survive non-default call paths;
14. links point to existing headings;
15. the topic is concise enough for the single-page format.

Actively try to find a counterexample to broad behavioral claims.

If a claim cannot be verified, narrow or remove it instead of guessing.

# Documentation verification

For documentation-only changes, follow the root `AGENTS.md` verification policy.

At minimum:

```sh
bun run fmt:check
git diff --check
```

When useful, preview the site:

```sh
bun run docs
```

For a documentation example that depends on source code changed in the same task, also run the closest relevant library tests.

A successful docsify render proves formatting/navigation behavior; it does not prove scientific or numerical correctness.

When internal links were added or topic titles changed, verify that:

- every linked topic exists;
- every anchor resolves;
- topic titles remain unique.

When `docs/index.html` changed, verify that:

- the cover page still works;
- search still works;
- TypeScript highlighting still works;
- `hideSidebar: true` is preserved unless explicitly requested otherwise.
