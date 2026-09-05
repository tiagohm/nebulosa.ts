# Apparent annular geometry

`analyzeCollimation` measures the apparent displacement between the outer edge and central shadow of one complete, isolated defocused annulus. It reports image geometry. It does not infer optical-axis error, wavefront error, telescope design, a hardware obstruction ratio, or which screw to turn. A nearly circular ellipse's angle is a representation detail, not evidence of an optical aberration.

The implementation has synthetic validation only. The repository currently has no suitable real annular fixtures with known optical configuration, field position, focus side, linearity and provenance. Quantitative utility for a real telescope remains unvalidated. Adding that claim requires real centered, displaced and perturbed controls, recorded source/license and independent review; visual opinion that an image is “collimated” is not numerical ground truth.

## Use

Import `analyzeCollimation` from `./collimation`, public contracts from `./types`, and `createCollimationWorkspace` from `./preprocess`. There is no barrel or debug-image API. A complete runnable synthetic example is available:

```sh
bun run examples/collimation.ts
```

```ts
const result = analyzeCollimation(
	{
		image, // Linear, normalized Image, not DigitalImage or stretched/gamma-encoded samples.
		area: { left: 20, top: 30, right: 180, bottom: 190 },
		center: { x: 100, y: 110 }, // Approximate point inside the central shadow.
	},
	{ plane: 'auto', workspace: createCollimationWorkspace(160, 160) },
)

if (result.success) console.info(result.geometry.offset, result.stability)
else console.info(result.reason)
```

ROI bounds are integer and half-open. Integer coordinates locate pixel centers; X increases rightward and Y downward. The default initial point is `((left + right - 1) / 2, (top + bottom - 1) / 2)`. Give the caller's known field reference through `field` when available; neither an ROI midpoint nor the sensor midpoint establishes an optical axis.

Results use the received image frame. Crop header origins are not added. CFA metadata must already describe that image's local phase; changing only its ROI does not shift the phase. Direction points from the outer center to the shadow center, in `[0, 2*PI)`, from +X toward +Y. Ellipse orientation is in `[0, PI)`. Lengths, residuals and sensitivity are received-image pixels. Euclidean distance and `sqrt(a*b)` describe the sampling grid, so a 2x1 binning change need not preserve normalized distance. Registration, metric correction and optical interpretation belong to the caller.

`auto` selects mono, RGB green, or CFA green1. CFA uses one native subgrid with step 2; it interpolates neither other colors nor missing samples. Both green positions are separately selectable. Centers, axes, residuals and sensitivity are transformed by the same step. Nonfinite values in other channels have no effect. Negative and above-unity samples remain signed; no stretch or percentile normalization is applied.

`saturationLevel` is optional and uses the original normalized raw scale. Absence means unknown, including when every pixel is below 1. Invalid and known-saturated samples invalidate their entire Gaussian filter support. Excess raw-buffer capacity is allowed, while inconsistent dense layout relations throw before processing. Workspaces must match input precision and have enough ROI/angular capacity; incompatibility throws before scratch mutation. Use `{ precision: 64 }` for a `Float64Array` image.

## Results and limits

`outer` and `obstruction` contain independent canonical ellipses, equivalent radii, robust normal-distance RMS, accepted sector counts, angular coverage and maximum circular gaps. The normalized offset is the center-distance divided by the outer equivalent radius. The apparent obstruction ratio is the ratio of equivalent radii.

Background is fitted as a robust plane on spatially distributed exterior support. Noise is a normalized MAD of external residuals and remains absent when unresolved; the code never divides by an invented epsilon to produce SNR. Signal and background retain raw units. Invalid/saturated fractions describe evaluated annular support rather than the entire ROI. A second extended bright pattern in the ROI causes an ambiguous result.

Photometry uses original background-subtracted samples away from both transitions and integrates with `r dr` weighting. It publishes `1.4826 * MAD(sector mean brightness) / median brightness`, coverage and maximum gap. Variable thickness therefore does not become brightness asymmetry. Insufficient photometric support omits `photometry` while preserving usable geometry. No photometric direction or aberration classification is inferred.

Stability removes each of 12 angular blocks from both boundaries, refits every replicate and measures the largest change of the full offset vector. Each normalized replicate uses its own outer radius. Any unsupported replicate makes stability unavailable. It is a sensitivity measure, not covariance, a confidence interval, or an assurance against seeing/diffraction/calibration bias. Increasing the angular density does not multiply information or reduce the sampling floor.

Direction is resolved only when offset magnitude exceeds three times `max(offsetSpread, resolutionFloor)`. Zero offset is valid with absent direction. Optional `tolerance` compares normalized distance with a sensitivity band using `max(normalizedOffsetSpread, resolutionFloor / outerRadius)`. The assessment is `withinTolerance`, `outsideTolerance` or `inconclusive`, never “collimated” or “miscollimated”. A known position outside `field.maximumDistance` forces an inconclusive assessment while retaining geometry. Missing field reference is recorded as unknown.

## Synthetic domain

Analytic ellipse tests cover exact/nearly exact circles, rotated ellipses, scale and large translation, imaginary conics, rank loss, short arcs and outliers. The initializer follows [Halir and Flusser](https://autotrace.sourceforge.net/WSCG98.pdf), selecting verified eigenvectors by the ellipse constraint rather than eigenvalue sign. Refinement uses an approximate normal-distance residual near the edge with independent stationarity and conditioning checks. Continuous containment preserves the synthetic renderer's original tangent tolerance; the analyzer requires a strict `1e-10` dimensionless margin.

The image grid includes eight offset directions; radii 24, 48 and 96 plane pixels; four subpixel phases; Gaussian sigma 0.5, 1 and 1.5; independent ellipse orientations; Float32/Float64; RGB; all eight CFA patterns, four crop parities and both green planes. Content tests cover signed faint signal, planar background, noise, blur, spider, saturation, invalid support, crop, multiple rings/stars, small central spots, photometric support and workspace reuse.

An independent binary-pupil rasterizer integrates 8x8 subpixels without using the production synthetic renderer. Its 24 mono cases cover radii 24, 60 and 100, four phases and aspect ratios 1 and 1.5. On 2026-09-05, the largest center error was **0.02852 plane pixel**, and the largest vector error **0.03441 plane pixel**. Eight additional CFA Float32/Float64 cases verify the step-2 transform. A shared boundary perturbation verifies that paired deletion preserves correlated center cancellation. These are observations on a sampled test grid, not a bound for every possible image.

The operational sampling floor is conservatively **0.2 plane pixel**, hence **0.4 image pixel for native CFA**. It is available only when measured outer equivalent radius is 24–100, inner minor radius is at least 8, both axis ratios are at most 1.5, radial separation is at least 8, observed signal/gradient edge width is 2–7, smoothing sigma is 0.5–1.5, at least 180 angular samples are requested, and measurable SNR is at least 30. Values are in native-plane pixels unless stated otherwise. Thresholds apply to measured geometry; a case exactly at a domain endpoint can fall outside after fitting. All 12 replicates must also retain sufficient coverage and conditioning. Geometry outside this domain may still be returned, with stability and direction absent and any assessment inconclusive.

Default acceptance requires 80% angular coverage, maximum gap `PI/3`, boundary RMS at most 0.5 plane pixel and measurable SNR at least 8. Mask dilation, bilinear neighbors and contrast windows can enlarge a rejected arc beyond the original defect. Under noise, missing arcs or asymmetric illumination, the ideal-image precision target is not promised. A robust fit with adequate coverage still cannot identify the physical cause of a deformation.

## Cost and reproducibility

ROI capacity is at most 1024x1024 image pixels; angular capacity is 12–2048. Gaussian sigma capacity is 0–32 plane pixels with support `ceil(3*sigma)`; zero disables smoothing. Radial spacing is 0.5 plane pixel. There are at most three extractions, three IRLS passes per fit and 50 LM iterations per pass. Background regression retains at most 2048 spatial samples. No angle-by-radius profile matrix, full-image search, unbounded cache, history or new worker is allocated. The synchronous analysis can block its calling thread during large frames.

```sh
bun test --timeout 1000 tests/imaging/analysis/collimation
bun run scripts/collimation.bench.ts
```

The benchmark uses one warm-up and five measurements with a reused workspace, reporting medians. Results below were observed on Windows, Intel i5-6500T at 2.50 GHz, Bun 1.4.0 canary (`01c4e2fd6`), 360 angles, on 2026-09-05. CFA uses the native quarter-sized grid and Float64. The 1024² cases keep the outer radius within the stability domain. Memory counts workspace buffers/reservoir, excluding the input, solver temporaries, results and runtime overhead.

| ROI   | Plane / precision | Workspace MiB | Preprocess ms | Init + edges ms | Two fits ms | 24 paired fits ms | Complete analysis ms |
| ----- | ----------------- | ------------: | ------------: | --------------: | ----------: | ----------------: | -------------------: |
| 256²  | Mono / 32         |          2.72 |         14.94 |            9.78 |        5.09 |             70.28 |               144.83 |
| 256²  | CFA / 64          |          4.22 |          5.61 |            4.97 |        4.75 |             64.41 |               113.30 |
| 512²  | Mono / 32         |          7.78 |         61.57 |           15.31 |        4.89 |             60.87 |               253.42 |
| 512²  | CFA / 64          |         13.78 |         17.78 |            6.56 |        5.17 |             71.07 |               189.74 |
| 1024² | Mono / 32         |         28.04 |        250.70 |           29.47 |        5.99 |             63.06 |               678.80 |
| 1024² | CFA / 64          |         52.04 |         67.75 |           14.52 |        4.31 |             60.80 |               234.93 |

Isolated columns are not additive: complete analysis includes background refinement, reextraction, actual robust rejection, stability coverage checks, mask quality and photometry. The paired-fit column isolates the 24 solver calls, rather than instrumenting the private production routine. These measurements establish cost on this machine, not a live-view frame-rate promise. Main work is `O(P*K + A*R)` plus a bounded number of fixed-dimension fits; workspace storage scales with ROI capacity and angular/radial buffers.
