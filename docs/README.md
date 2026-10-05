Welcome. Nebulosa is a Bun-first, ESM-only TypeScript toolkit for numerical astronomy, astrophotography, imaging, I/O, and observatory control.

# 🚀 Installation

Nebulosa runs on [Bun](https://bun.com). Install it from the Git repository; Bun fetches that repository directly. Imports use the path under `nebulosa/src/` and omit the `.ts` extension.

## Requirements

- Install [Bun](https://bun.com/docs/installation).

## Add the package

```sh
bun add --trust github:tiagohm/nebulosa.ts
```

`--trust` records `nebulosa` in `trustedDependencies`. Bun runs lifecycle scripts only for packages named there, and the postinstall extracts the native libraries shipped with the package. The command writes:

```json
{
	"dependencies": {
		"nebulosa": "github:tiagohm/nebulosa.ts"
	},
	"trustedDependencies": ["nebulosa"]
}
```

Append `#` and a commit or tag to stay on one revision:

```sh
bun add --trust github:tiagohm/nebulosa.ts#<commit>
```

## Import a module

```ts
import { formatHMS, hour } from 'nebulosa/src/math/units/angle'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

// 2026-06-29 00:00:00 UTC, stored as a two-part Julian Date.
const instant = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

console.log(formatHMS(hour(12), false)) // 12:00:00
console.log(instant.day + instant.fraction) // 2461220.5
```

## Native libraries

The [postinstall](https://github.com/tiagohm/nebulosa.ts/blob/main/postinstall.ts) script extracts the shared libraries for this platform from zips shipped in `native/`:

- `libwcs.shared` — [WCSLIB](https://www.atnf.csiro.au/computing/software/wcs/), for FITS WCS pixel and sky transforms, from `libwcs-<platform>-<arch>.zip`
- `libturbojpeg.shared` — [TurboJPEG](https://github.com/libjpeg-turbo/libjpeg-turbo), for JPEG compression and decompression, from `libturbojpeg-<platform>-<arch>.zip`
- `libastrometry.shared` — [fork of Astrometry.net](https://github.com/tiagohm/astrometry.net), for local plate solving, from `libastrometry-<platform>-<arch>.zip`

The native libraries are built at [nebulosa.native](https://github.com/tiagohm/nebulosa.native) repository.

# 📄 Documentation

## ⭐ Astronomy

Times, coordinates, ephemerides, and events for bodies and observers.

### Affine Origin Frames

A rotation-only `Frame` changes the axes but keeps the origin. An affine frame also moves the origin: a position is first shifted by the origin position `O`, then rotated by `R`, and a velocity is shifted by the origin velocity `Ȯ`. If the frame rotates with time (`dRdtTimesRtAt`), the velocity gains the extra drift term `W · p`.

```text
p_frame = R · (p − O)
v_frame = R · (v − Ȯ) + W · p_frame
```

Use these functions to move absolute positions (AU) or full `[position, velocity]` states (AU, AU/day) between frames whose origins differ, such as barycentric ICRS and a Sun-centered ecliptic. Inputs and outputs of the base side are in ICRS/BCRS axes. Never pass a normalized direction: subtracting an origin from a unit vector is meaningless, so use a plain `Frame` conversion for directions. `originAt` and `originVelocityAt` are optional, so every plain `Frame` is already a valid `AffineFrame`; with no origin the result equals the rotation-only conversion.

`BARYCENTRIC_ECLIPTIC` is `ECLIPTIC_J2000` used as an `AffineFrame` (same origin as the base). `heliocentricEclipticFrame` has the same orientation with the origin at the Sun; the Sun's barycentric state is supplied by the caller, so this module imports no ephemeris. The Galactic-center and Local Standard of Rest origins are covered by Galactocentric Frame and Local Standard of Rest Frames.

```ts
import { affineFromBase, affineToAffine, affineToBase, BARYCENTRIC_ECLIPTIC, heliocentricEclipticFrame } from 'nebulosa/src/astronomy/coordinates/affine'
import type { PositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { ICRS } from 'nebulosa/src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC)

// Sun's barycentric [position (AU), velocity (AU/day)] in ICRS at `time`.
// Synthetic constants here; pass a real ephemeris lookup in practice.
const helio = heliocentricEclipticFrame(() => [
	[0.004, -0.007, -0.003],
	[0.0000035, 0.0000045, 0.000002],
])

// Barycentric ICRS state: position in AU, velocity in AU/day.
const state: PositionAndVelocity = [
	[1.2, 0.3, -0.5],
	[0.002, -0.001, 0.0008],
]

// Base (ICRS) -> heliocentric ecliptic J2000. A full state returns [p, v].
const [p, v] = affineFromBase(state, helio, time)

console.log(p) // [1.196, 0.083972, -0.578106] — AU, Sun-centered ecliptic axes
console.log(v) // [0.0019965, -0.000604, 0.001132] — AU/day

// A bare position (length 3) transforms only the position.
console.log(affineFromBase([1.2, 0.3, -0.5], helio, time)) // [1.196, 0.083972, -0.578106] — AU

// With BARYCENTRIC_ECLIPTIC only the axes rotate; the origin stays at the base origin.
console.log(affineFromBase(state, BARYCENTRIC_ECLIPTIC, time)[0]) // [1.2, 0.076356, -0.578074] — AU

// Exact inverse: frame -> base (ICRS).
const back = affineToBase([p, v], helio, time)

console.log(back[0]) // [1.2, 0.3, -0.5] — AU, original position
console.log(back[1]) // [0.002, -0.001, 0.0008] — AU/day, original velocity

// Between any two affine frames (a plain Frame such as ICRS is accepted); goes through the base.
const same = affineToAffine(state, ICRS, helio, time)

console.log(same[0]) // [1.196, 0.083972, -0.578106] — AU, same as affineFromBase above
```

All three functions accept an optional `o` argument: the result is written there and the return value aliases it. `o` may be the input itself for an in-place transform. Without `o`, a fresh vector or state is allocated.

### Airmass and Extinction

Airmass is the optical path length through the atmosphere relative to the zenith path. It is 1 at the zenith and grows quickly near the horizon, where the simple `sec(z)` form stops being a good approximation. Atmospheric extinction is the magnitude loss `k · X`, where `k` is the extinction coefficient in magnitudes per airmass and `X` the airmass.

Use these for planning and photometric estimates, not for precise reduction. `airmass` is `sec(z)` from the zenith distance and is only reasonable well above the horizon. `airmassKastenYoung` takes the altitude instead and stays usable near the horizon; it is clamped to a minimum of 1 because the published fit dips slightly below 1 at the zenith. Both are dimensionless and ignore pressure, temperature, and altitude of the site.

```ts
import { airmass, airmassKastenYoung, atmosphericExtinction } from 'nebulosa/src/astronomy/formulas'
import { deg } from 'nebulosa/src/math/units/angle'

// sec(z). z: zenith distance in radians.
console.log(airmass(deg(60))) // 2.0 — dimensionless airmass

// Kasten-Young. altitude: radians above the horizon, in (0, PI/2].
console.log(airmassKastenYoung(deg(30))) // 1.9943 — dimensionless
console.log(airmassKastenYoung(deg(10))) // 5.5860 — dimensionless

// Magnitude loss = k * X. k: mag/airmass. X: airmass, must be >= 1 (throws RangeError otherwise).
console.log(atmosphericExtinction(0.2, airmassKastenYoung(deg(30)))) // 0.3989 — magnitudes lost
```

### Alt-Az Field Rotation

An alt-az mount keeps the optical axis on the target but not the sky orientation: the field turns about the optical axis at a rate that depends on latitude, azimuth, and altitude, and diverges at the zenith. The rate is `Ω · cos(latitude) · cos(azimuth) / cos(altitude)`, with `Ω` the sidereal rate. It equals minus the rate of the parallactic angle, and a rotator holds the sky orientation by commanding `offset − parallactic angle`.

Use `fieldRotationRate` for the signed rate, `fieldRotation` when you also want the longest exposure that keeps a point at a given sensor radius inside a smear budget, and `derotatorAngle` or `derotatorTrack` to command an instrument rotator. Angles are radians, azimuth is measured north through east, and rates are radians per SI second. The rate functions return `undefined` at the zenith. Nothing here moves hardware; the derotator track follows the sidereal hour angle only and ignores the target's own motion.

```ts
import { derotatorAngle, derotatorTrack, fieldRotation, fieldRotationRate } from 'nebulosa/src/astronomy/coordinates/field'
import { deg, hour } from 'nebulosa/src/math/units/angle'

// latitude 45°, azimuth 30°, altitude 40° (radians).
console.log(fieldRotationRate(deg(45), deg(30), deg(40))) // 5.829e-5 — rad/s, signed

// Adds the exposure limit: smear budget of 1 pixel at 2000 px from the rotation center.
const rotation = fieldRotation(deg(45), deg(30), deg(40), 1, 2000)

console.log(rotation?.radiansPerMinute) // 0.0034976 — rad/min
console.log(rotation?.maxExposureSeconds) // 8.58 — seconds; Infinity if the field is not rotating
console.log(fieldRotation(deg(45), deg(30), deg(90))) // undefined — zenith

// Derotator command: hour angle (positive west), declination, latitude, optional mechanical offset.
console.log(derotatorAngle(hour(2), deg(20), deg(45))) // -0.6606 — radians in (-PI, PI]
console.log(derotatorAngle(hour(2), deg(20), deg(45), deg(10))) // -0.4860 — with a 10° offset

// Samples every 300 s over 600 s starting at the given hour angle.
const track = derotatorTrack(hour(2), deg(20), deg(45), 600, 300)

console.log(track.map((s) => s.angle)) // [-0.6606, -0.6757, -0.6899] — radians at 0, 300, 600 s
```

Both `derotatorTrack` limits throw a `RangeError`: a non-positive step, or a step so fine that the track would exceed 100000 samples. A zero duration returns a single sample.

### Angular Size and Surface Brightness Estimates

Angular diameter is the angle an object of a given size subtends at a given distance, `2 · atan(d / 2D)`. Surface brightness spreads an integrated magnitude over an area in square arcseconds, `m + 2.5 · log10(A)`, so a larger object of the same total magnitude is fainter per unit area.

These are planning helpers for sizing a target in the frame or judging how hard an extended object is to see. The surface brightness is a mean over the area you supply, not a measured profile.

```ts
import { objectAngularDiameter, surfaceBrightness } from 'nebulosa/src/astronomy/formulas'
import { toArcmin } from 'nebulosa/src/math/units/angle'

// Diameter and distance must be in the same length unit (here km: Sun and 1 AU).
const theta = objectAngularDiameter(1391400, 149597870.7)

console.log(theta) // 0.0093009 — angular diameter in radians
console.log(toArcmin(theta)) // 31.974 — arcminutes

// Total magnitude 10 spread over 3600 arcsec² (one square arcminute).
console.log(surfaceBrightness(10, 3600)) // 18.8908 — mag/arcsec²
```

### Angular Separation and Position Angle

Two sky positions are separated by the great-circle angle between them, and the position angle says in which direction one lies from the other, measured from celestial north toward east: 0° is north, 90° east, 180° south, 270° west.

`angularDistance` uses an `atan2` form that keeps tiny separations accurate, so prefer it; `angularDistanceHaversine` gives the same quantity with a less stable formulation. `positionAngleBetween` is the position angle of the second point as seen from the first, wrapped to `[0, 2π)`, and 0 when the points coincide. `separationFrom` is the angle between two Cartesian direction vectors instead of equatorial coordinates. All angles are radians.

```ts
import { angularDistance, angularDistanceHaversine, positionAngleBetween } from 'nebulosa/src/astronomy/coordinates/coordinate'
import { separationFrom } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// Right ascension and declination of point 0 and point 1 (radians).
const separation = angularDistance(deg(10), deg(20), deg(10), deg(21))

console.log(toDeg(separation)) // 1.0 — degrees
console.log(toDeg(angularDistanceHaversine(deg(10), deg(20), deg(10), deg(21)))) // 1.0 — same quantity

// Point 1 is directly north of point 0.
console.log(toDeg(positionAngleBetween(deg(10), deg(20), deg(10), deg(21)))) // 0 — north
console.log(toDeg(positionAngleBetween(deg(10), deg(20), deg(11), deg(20)))) // 89.83 — nearly east
console.log(toDeg(positionAngleBetween(deg(10), deg(20), deg(9), deg(20)))) // 270.17 — nearly west

// Direction vectors (need not be unit length for the angle).
console.log(toDeg(separationFrom([1, 0, 0], [0, 1, 0]))) // 90 — degrees
```

### Annual Aberration

Aberration is the apparent shift of a source toward the direction the observer is moving, caused by the observer's velocity relative to the speed of light. For the Earth's orbital speed (about 30 km/s) the shift reaches about 20.5″; the diurnal term from the Earth's rotation is much smaller.

`annualAberration` applies the ERFA special-relativistic model (`eraAb`) to a unit direction in ICRS/BCRS axes and returns a fresh unit vector. It is the complete aberration correction for whatever velocity you pass: use the Earth's barycentric velocity for the annual term, or the observer's full barycentric velocity (geocenter plus diurnal rotation) for annual plus diurnal. `sunDistance` only feeds the tiny light-bending term inside the ERFA model. For a full astrometric-to-apparent chain with deflection and ordering handled for you, see Apparent Direction.

```ts
import { annualAberration } from 'nebulosa/src/astronomy/coordinates/correction'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// direction: unit vector toward the source (ICRS/BCRS axes).
// observerVelocity: AU/day, barycentric. sunDistance: observer-Sun distance in AU.
const apparent = annualAberration([1, 0, 0], [0, kilometerPerSecond(29.78), 0], 1)

console.log(apparent) // [0.99999999507, 0.0000993354, 0] — unit vector, tilted toward +y, the velocity direction

// A zero velocity leaves the direction unchanged.
console.log(annualAberration([1, 0, 0], [0, 0, 0], 1)) // [1, 0, 0]
```

### Apparent Direction

The apparent direction of a Solar-System target is where an observer sees it in barycentric ICRS/BCRS axes. It is built in a fixed order: solve light time to get the astrometric direction, bend the ray by the gravity of any bodies you list, then apply the observer's aberration. Precession, nutation, Earth rotation, horizontal conversion, and refraction are not applied, and there is no hidden ephemeris: the target, observer, Sun, and every deflector are state providers you supply.

`apparentDirection` runs the whole chain from providers. Each provider is a function of `Time` returning a barycentric `[position (AU), velocity (AU/day)]`. Aberration is on by default and then requires `sun`, which supplies the observer-Sun distance; without it the call throws. Deflection happens only for the bodies in `deflectors` (the Sun is not implied), in the order the photon meets them; `SUN_LIGHT_DEFLECTOR_MASS` and `SUN_LIGHT_DEFLECTOR_LIMITER` (with the Jupiter and Saturn equivalents) hold the ERFA constants. `lightTimeIterations` is an integer in `[0, 16]` (default 3). It returns `undefined` when the retarded observer-target vector is zero. For a star at infinity use Starlight Deflection instead, since this path assumes a finite-distance source.

```ts
import { apparentDirection, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from 'nebulosa/src/astronomy/coordinates/apparent'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TDB)

// Synthetic providers: barycentric [position (AU), velocity (AU/day)]. Use ephemeris lookups in practice.
const sun = () =>
	[
		[0, 0, 0],
		[0, 0, 0],
	] as const
const observer = () =>
	[
		[1, 0, 0],
		[0, 0.0172, 0],
	] as const
const target = () =>
	[
		[1.5, 4.5, 0.5],
		[0, 0, 0],
	] as const

const result = apparentDirection(target, observer, time, { sun })

console.log(result?.astrometric) // [0.109764, 0.987878, 0.109764] — unit direction after light time
console.log(result?.apparent) // [0.109753, 0.987881, 0.109753] — unit direction after aberration
console.log(result?.distance) // 4.5552 — AU at the retarded solution
console.log(result?.lightTime) // 0.026309 — days
// result?.emissionTime is the retarded emission Time (time - lightTime).

// Add solar deflection; deflectors are listed in photon encounter order.
const deflected = apparentDirection(target, observer, time, {
	sun,
	deflectors: [{ mass: SUN_LIGHT_DEFLECTOR_MASS, limiter: SUN_LIGHT_DEFLECTOR_LIMITER, state: sun }],
})

console.log(deflected?.apparent) // direction shifted by about 0.0029″ relative to the previous apparent one
```

When you already hold snapshots, `applyApparentDirectionCorrections` applies only the deflection and aberration stages to an astrometric unit direction. Its arguments are the astrometric direction, the target emission position (AU), the observer position (AU) and velocity (AU/day), the light time in days, and `{ aberration, sunPosition, deflectors }` where each deflector is a snapshot with `mass`, `limiter`, `position`, and `velocity`. It returns a fresh unit vector.

```ts
import { applyApparentDirectionCorrections } from 'nebulosa/src/astronomy/coordinates/apparent'

// `result` is the apparentDirection result computed in the previous snippet.
const apparent = applyApparentDirectionCorrections(
	result!.astrometric, // unit direction after light time
	[1.5, 4.5, 0.5], // target position at emission, AU
	[1, 0, 0], // observer position at reception, AU
	[0, 0.0172, 0], // observer velocity, AU/day
	result!.lightTime, // days
	{ sunPosition: [0, 0, 0] }, // aberration is on by default and needs the Sun position
)

console.log(apparent) // [0.109753, 0.987881, 0.109753] — same as result.apparent
```

### Approximate Atmospheric Refraction

Refraction bends starlight so an object appears higher than its geometric position, by about 1′ at 45° altitude and several arcminutes near the horizon. `atmosphericRefraction` uses Sæmundsson's formula (Meeus, ch. 16) as a standard-atmosphere planning estimate.

The input is the true (airless) altitude, and the result is the amount to add to it to get the apparent altitude. It is not Bennett's apparent-altitude formula and takes no pressure or temperature, so do not use it when pressure, temperature, humidity, or wavelength matter; see Refractive Displacement for that. Valid for altitudes above the horizon.

```ts
import { atmosphericRefraction } from 'nebulosa/src/astronomy/formulas'
import { arcmin, deg } from 'nebulosa/src/math/units/angle'

// altitude: true geometric altitude in radians, in (0, PI/2].
const r = atmosphericRefraction(deg(10))

console.log(r) // 5.4077 — refraction in arcminutes (not radians)
console.log(atmosphericRefraction(deg(45))) // 1.0127 — arcminutes

// Apparent altitude = true altitude + refraction (converted to radians).
const apparent = deg(10) + arcmin(r)

console.log(apparent) // 0.17611 — apparent altitude in radians
```

### Asteroid and Comet Magnitude Estimates

Apparent magnitude grows with the distances to the Sun and to the observer. Asteroids follow `m = H + 5·log10(r·Δ) + φ`, where `H` is the absolute magnitude and `φ` is a phase correction you supply. Comets follow `m = H + 5·log10(Δ) + k·log10(r)`, where `k` is an activity coefficient you supply.

These are quick planning formulas, not the Mallama and Hilton planetary model, and they do not compute the phase angle or the phase function for you; use Planetary Apparent Magnitudes (Mallama and Hilton) for planets. Distances are positive and in AU.

```ts
import { asteroidMagnitudeEstimate, cometMagnitudeEstimate } from 'nebulosa/src/astronomy/formulas'

// H: absolute magnitude. r: heliocentric distance (AU). delta: geocentric distance (AU).
// phase: magnitude correction already computed by the caller.
console.log(asteroidMagnitudeEstimate(12, 1.5, 0.8, 0.3)) // 12.696 — apparent magnitude

// H: total absolute magnitude. delta, r: AU. k: activity coefficient.
console.log(cometMagnitudeEstimate(8, 0.5, 1.2, 10)) // 7.2867 — apparent magnitude
```

### Asteroid and Comet Orbit Construction

A small body's orbit is described by classical elements referred to a plane and an epoch. Asteroids are normally given by the semi-major axis, eccentricity, inclination, longitude of the ascending node, argument of perihelion, and mean anomaly at an epoch. Comets, whose eccentricity can be 1 or more, are given by perihelion distance (or the semi-latus rectum) and the time of perihelion passage instead. Both become a `KeplerOrbit`, a two-body orbit around the Sun whose state vector the library can propagate (see Two-Body Kepler Propagation).

`asteroid(a, e, i, om, w, M, epoch)` takes `a` in AU, the angles in radians (`om` the ascending node, `w` the argument of perihelion, `M` the mean anomaly at `epoch`), and `epoch` as a `Time`. `comet(p, e, i, om, w, epoch)` takes the semi-latus rectum `p` in AU and `epoch` as the time of perihelion. `mpcAsteroid(record)` and `mpcComet(record)` build them from parsed MPC records (see MPCORB Parsing), taking the epoch in TT. The elements are heliocentric and referred to the ecliptic and equinox of J2000, and by default the orbit's gravitational parameter is the Sun's (`GM_SUN_PITJEVA_2005`). `orbit.position` and `orbit.velocity` hold the state at the epoch in that ecliptic frame, while `orbit.at(time)` returns a state rotated to equatorial J2000 (see Two-Body Kepler Propagation). For finer control, `KeplerOrbit.meanAnomaly(p, e, i, om, w, M, epoch, mu?, rotation?)`, `KeplerOrbit.trueAnomaly(p, e, i, om, w, v, epoch, mu?, rotation?)`, and `KeplerOrbit.periapsis(p, e, i, om, w, epoch, mu?, rotation?)` build an orbit from the semi-latus rectum, with a different `mu` or output `rotation` if needed, and `new KeplerOrbit(position, velocity, epoch, mu?, rotation?)` builds one from a state. A hyperbolic orbit (`e > 1`) has a negative semi-major axis, and a state with zero angular momentum throws an `Error` ("motion is not conical").

```ts
import { asteroid, comet, KeplerOrbit, mpcAsteroid, mpcComet } from 'nebulosa/src/astronomy/orbits/asteroid'
import { mpcorb, mpcorbComet } from 'nebulosa/src/astronomy/orbits/mpcorb'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const epoch = timeYMDHMS(2025, 5, 5, 0, 0, 0, Timescale.TT)

// (1) Ceres from classical elements: a (AU), e, i, node, argument of perihelion, mean anomaly (radians).
const ceres = asteroid(2.7660512, 0.0794013, deg(10.5878), deg(80.25221), deg(73.27343), deg(188.70269), epoch)

console.log(ceres.position) // [2.7711, -0.96407, -0.54103] — AU, ecliptic J2000 at the epoch
console.log(ceres.periodInDays / 365.25) // 4.600 — years

// A comet from the semi-latus rectum p = q(1 + e) and the perihelion time.
const halley = comet(0.583972 * (1 + 0.967311), 0.967311, deg(162.2146), deg(59.6368), deg(112.547), timeYMDHMS(2061, 8, 31, 19, 50, 18, Timescale.TT))

console.log(halley.periapsisDistance, halley.eccentricity) // 0.583972 0.967311
console.log(halley.periodInDays / 365.25) // 75.5 — years

// From MPC records: an MPCORB line for an asteroid, a CometEls line for a comet.
const line = '00001    3.34  0.15 K2555 188.70269   73.27343   80.25221   10.58780  0.0794013  0.21424651   2.7660512  0 E2024-V47  7330 125 1801-2024 0.80 M-v 30k MPCLINUX   4000      (1) Ceres              20241101'

console.log(mpcAsteroid(mpcorb(line)!).position) // [2.7711, -0.96407, -0.54103] — same orbit, epoch K2555 = 2025-05-05

const cometLine = '0001P         2061 08 31.8266  0.583972  0.967311  112.5470   59.6368  162.2146  20250501   4.0  6.0  1P/Halley                                                 98, 1083'

console.log(mpcComet(mpcorbComet(cometLine)!).semiMajorAxis) // 17.864 — AU

// A hyperbolic orbit (e = 1.5): negative semi-major axis, infinite period.
const hyperbolic = KeplerOrbit.meanAnomaly(1.5, 1.5, deg(10), deg(20), deg(30), 0.5, epoch)

console.log(hyperbolic.semiMajorAxis, hyperbolic.periodInDays) // -1.2 Infinity

// An orbit from the state at perihelion: position [q, 0, 0] for p = 1, e = 0.2, i = 0.
console.log(KeplerOrbit.periapsis(1, 0.2, 0, 0, 0, epoch).position) // [0.83333, 0, 0] — AU

console.log(toDeg(KeplerOrbit.trueAnomaly(1, 0.2, 0, 0, 0, Math.PI / 2, epoch).trueAnomaly)) // 90 — degrees
```

### Astrometric Sample-Grid Interpolation

A plate-solved image gives the sky position of every pixel through the WCS, but evaluating it for each mouse movement is slow. `AstrometricInterpolator` precomputes the right ascension and declination on a coarse, regular grid of pixels once, and then answers pixel-to-sky queries with a cheap local interpolation. Samples are stored as Cartesian unit vectors, so interpolating never crosses the 0/2π right ascension seam, and the interpolated vector is renormalized before it is converted back to RA and Dec.

`new AstrometricInterpolator(raGrid, decGrid, width, height, stepX, stepY, options?)` takes the right ascension and declination grids in radians, row-major with `width × height` entries each, and the pixel spacing between adjacent samples (`stepX`, `stepY`, in image pixels). It throws an `Error` when the grid lengths disagree with `width × height`, and a `TypeError` when a sample is not finite. `options.interpolation` is the local kernel: `'nearest'`, `'bilinear'`, `'catmullRom'` (the default, bicubic), or `'cubicConvolution'` (Keys, with `options.cubicTension`, default −0.5 which equals Catmull-Rom). `pixelToSky(x, y, out?)` returns `[ra, dec]` in radians, with right ascension in `[0, 2π)`, writing into `out` when given. Queries are clamped to the sampled extent, so it never extrapolates beyond the grid. This is an interpolation of a precomputed grid, not a plate solution: for the WCS itself see Plate Solution.

```ts
import { AstrometricInterpolator } from 'nebulosa/src/astronomy/ephemeris/interpolation/astrometric'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// A 4 x 4 grid: RA grows by 1° per column, Dec by 1° per row, samples every 10 px in x and 20 px in y.
const width = 4
const height = 4
const ra = new Float64Array(width * height)
const dec = new Float64Array(width * height)

for (let row = 0; row < height; row++) {
	for (let col = 0; col < width; col++) {
		ra[row * width + col] = deg(10 + col)
		dec[row * width + col] = deg(-5 + row)
	}
}

const interpolator = new AstrometricInterpolator(ra, dec, width, height, 10, 20, { interpolation: 'bilinear' })

// Pixel (15, 30) is the center of a grid cell.
console.log(interpolator.pixelToSky(15, 30).map(toDeg)) // [11.5, -3.5] — degrees (bilinear is off by about 1e-4° in Dec due to the sphere)

// The default bicubic Catmull-Rom kernel.
console.log(new AstrometricInterpolator(ra, dec, width, height, 10, 20).pixelToSky(15, 30).map(toDeg)) // [11.5, -3.5] — degrees

// Queries outside the grid clamp to its edge.
console.log(interpolator.pixelToSky(-100, 1000).map(toDeg)) // [10, -2] — degrees, the nearest corner sample

// Across the 0/360° seam: the samples 359.9°, 0°, 0.1° interpolate to 359.95°, not through 180°.
const seam = new AstrometricInterpolator(new Float64Array([deg(359.9), 0, deg(0.1), deg(359.9), 0, deg(0.1)]), new Float64Array(6), 3, 2, 10, 10, { interpolation: 'bilinear' })

console.log(seam.pixelToSky(5, 5).map(toDeg)) // [359.95, 0] — degrees
```

### Astronomical State Ownership

Position and velocity states are plain pairs of three-component arrays, `[position (AU), velocity (AU/day)]`, in ICRS/BCRS axes, and the types say who may write them. `PositionAndVelocity` is `readonly [Vec3, Vec3]`: a state you may read but do not own. `PositionAndVelocityMut` is `[MutVec3, MutVec3]`: a workspace or result you may write, whose position and velocity are distinct arrays. `readonly` is only a promise of the type; it does not mean the storage is a snapshot, and its lifetime belongs to whoever produced it. The same split applies to the samplers: `PositionAndVelocityOverTime` (and the position-only `PositionOverTime` and velocity-only `VelocityOverTime`) return a borrowed state that the provider may overwrite on its next call, so copy it before keeping it, and two independent providers must not share output storage. The `…Mut` samplers promise only a writable type, not a snapshot.

`zeroPositionAndVelocity()` allocates a fresh writable zero state, never shared with another call. `relativePositionAndVelocity(target, origin, time)` samples both providers at the same instant and returns the geometric difference `target − origin` as a new `PositionAndVelocityMut`, with no light time and no aberration; with the Sun as origin it gives a heliocentric state, with the Earth a geocentric one. Functions that take an optional `out` (such as `eraEpv00` and `eraMoon98`) write into it and return it, so passing the same workspace twice makes the first result alias the second. Light-time results (`lightTimeSolution`) are the opposite: owned snapshots, safe to keep.

```ts
import { type PositionAndVelocity, type PositionAndVelocityOverTime, relativePositionAndVelocity, zeroPositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

// A heliocentric Earth state: Earth (VSOP87E, barycentric) minus the Sun.
const [position, velocity] = relativePositionAndVelocity(earth, sun, time)
console.log(position) // [0.12544, −0.92555, −0.40121] AU
console.log(velocity) // [0.016787, 0.0018891, 0.00081848] AU/day
console.log(Math.hypot(...position)) // 1.0165 — AU

// A fresh workspace each time; the position and velocity arrays are distinct.
const a = zeroPositionAndVelocity()
const b = zeroPositionAndVelocity()
console.log(a, a[0] === b[0], a[0] === a[1]) // [[0, 0, 0], [0, 0, 0]] false false

// Any function of Time returning a state is a provider. A fixed point at 1 AU on +x:
const fixed: PositionAndVelocityOverTime = (): PositionAndVelocity => [
	[1, 0, 0],
	[0, 0, 0],
]
console.log(relativePositionAndVelocity(fixed, () => zeroPositionAndVelocity(), time)) // [[1, 0, 0], [0, 0, 0]]

// A borrowed state must be copied before the provider is called again.
let shared: [number, number, number] = [0, 0, 0]
const reusing: PositionAndVelocityOverTime = (t) => {
	shared[0] = t.day // overwritten on every call
	return [shared, [0, 0, 0]]
}
const first = reusing(time)
const kept: [number, number, number] = [...first[0]] // owned copy
reusing({ ...time, day: 0 })
console.log(first[0][0] === kept[0]) // false — the borrowed state changed under us
```

### Astronomical Time Arithmetic

Differences and offsets between instants are only meaningful inside one time scale. UTC has leap seconds, so a UTC "day" can be 86401 s long, while TAI and TT run uniformly.

`timeSubtract(a, b, scale?)` returns `a − b` in days after converting both instants to `scale`, which defaults to the scale of `a`. In UTC the difference counts civil days on the quasi-Julian-Date axis and ignores a leap second; pass `Timescale.TAI` or `Timescale.TT` for elapsed physical time. `timeShift(time, days)` returns a new `Time` in the same scale, moved by a number of days, and keeps the `providers` and `location` of the original. `timeAtJulianDay(reference, jd)` builds the instant at an absolute Julian Date (days) in the scale of `reference`, with the same providers and location. Neither carries the cache over, so derived values are recomputed for the new instant.

```ts
import { Timescale, timeAtJulianDay, timeShift, timeSubtract, timeToDate, timeYMD, timeYMDHMS, tt } from 'nebulosa/src/astronomy/time/time'

const newYear = timeYMD(2017, 1, 1)
const eve = timeYMD(2016, 12, 31) // a leap second was inserted at the end of this day

console.log(timeSubtract(newYear, eve)) // 1 — days, UTC quasi-JD (leap second not counted)
console.log(timeSubtract(newYear, eve, Timescale.TAI) * 86400) // 86401 — elapsed SI seconds

// Move by a number of days (1/24 = one hour). The scale is preserved.
console.log(timeToDate(timeShift(timeYMDHMS(2026, 6, 29, 0, 0, 0), 1 / 24))) // [2026, 6, 29, 1, 0, 0, 0]

// Instant at an absolute Julian Date, in the scale of the reference (TT here).
const instant = timeAtJulianDay(tt(timeYMDHMS(2026, 6, 29)), 2461221.25)

console.log(instant.scale === Timescale.TT) // true
console.log(timeToDate(instant)) // [2026, 6, 29, 18, 0, 0, 0] — TT clock reading
```

### Astronomical Time Representation and Epochs

A `Time` is an instant stored as an integer Julian Date `day`, a `fraction` of a day in `[−0.5, 0.5)`, and a `Timescale` tag (`UT1`, `UTC`, `TAI`, `TT`, `TCG`, `TDB`, `TCB`). The two-part form keeps full double precision: JD 2461220.5 is stored as day 2461221 and fraction −0.5, because the fraction is measured from the nearest integer day. Read it as `day + fraction` with `toJulianDay`.

`time` and `timeNormalize` build and normalize an instant from any day and fraction without losing precision; the scale defaults to `UTC`. Other constructors express the same instant from an epoch convention: `timeMJD` from a Modified Julian Date, `timeJulianYear` and `timeBesselianYear` from epoch years such as J2000.0 or B1950.0 (default scale `TT`), `timeFromEpoch` from a count of units after a reference instant, and `timeGPS` from GPS seconds (a `TAI` instant). `toJulianEpoch` is the inverse of `timeJulianYear`, computed from the instant in TT. The tag only labels the instant; converting between scales is a separate step, see Astronomical Time-Scale Conversion, and calendar construction is under Civil UTC Timestamps.

```ts
import { time, timeBesselianYear, timeFromEpoch, timeGPS, timeJulianYear, timeMJD, timeNormalize, Timescale, toJulianDay, toJulianEpoch } from 'nebulosa/src/astronomy/time/time'

// day: integer Julian Date. fraction: days. Normalized so the fraction is within [-0.5, 0.5).
const t = time(2451545, 0.25)

console.log(t.day, t.fraction) // 2451545 0.25 — UTC by default
console.log(timeNormalize(2451545.75, 0.5).day) // 2451546 — carries the whole days; the fraction is 0.25

console.log(toJulianDay(timeMJD(51544.5))) // 2451545 — J2000.0 as a JD (UTC scale label)
console.log(timeJulianYear(2000).scale === Timescale.TT) // true — epoch years default to TT
console.log(toJulianDay(timeBesselianYear(1950))) // 2433282.42346 — B1950.0 as a JD in TT
console.log(toJulianEpoch(timeJulianYear(2026.5))) // 2026.5 — Julian epoch year

// 1.5 days after JD 2451545.0, labeled TAI.
console.log(toJulianDay(timeFromEpoch(86400 * 1.5, 86400, 2451545, 0, Timescale.TAI))) // 2451546.5

// GPS time zero is 1980-01-06 00:00:00 UTC, as a TAI instant.
console.log(toJulianDay(timeGPS(0))) // 2444244.50022 — TAI
```

### Astronomical Time-Scale Conversion

A `Time` is converted between scales by a function per target: `utc`, `ut1`, `tai`, `tt`, `tcg`, `tdb`, and `tcb`, or generically by `timeConvert(time, scale)`. Each returns the same object when the instant is already in that scale, and otherwise a new `Time` whose conversions are memoized on the instant. The chain goes through TAI: UTC to TAI adds the leap-second count, TAI to TT adds 32.184 s, and TDB differs from TT by a periodic term of under 2 ms.

The offsets come from replaceable providers. UT1 needs UT1−UTC from the IERS Earth orientation tables; if the tables are not loaded the offset is 0 (see Earth Orientation Parameters). `taiMinusUtc`, `dut1`, `ut1MinusTai`, and `tdbMinusTt` return those offsets in seconds. `tdbMinusTt` is the ERFA model, which also adds a topocentric term when `time.location` is set; assign `time.providers` (for example `{ dut1: () => 0.123 }`) to override a provider for that instant, ideally with `Object.defineProperty(time, 'providers', { value, enumerable: false, writable: true })` so it survives `structuredClone`.

```ts
import { dut1, tai, taiMinusUtc, tcb, tcg, tdb, tdbMinusTt, timeConvert, timeToDate, timeYMDHMS, Timescale, toJulianDay, tt, ut1, utc } from 'nebulosa/src/astronomy/time/time'

// 2026-06-29 00:00:00 UTC.
const instant = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

const terrestrial = tt(instant)

console.log(toJulianDay(terrestrial) - toJulianDay(instant)) // 0.000800741 — days, i.e. 69.184 s = 37 s + 32.184 s
console.log(timeToDate(terrestrial)) // [2026, 6, 29, 0, 1, 9, 183] — TT clock reading
console.log(taiMinusUtc(instant)) // 37 — seconds, leap seconds in force

console.log(tt(instant) === tt(instant)) // true — the conversion is cached on the instant
console.log(utc(terrestrial).day === instant.day) // true — round trip returns the original UTC instant

// Other targets.
const sameInstant = [tai(instant), tdb(instant), tcg(instant), tcb(instant), ut1(instant), timeConvert(instant, Timescale.TT)]

console.log(sameInstant.map((t) => Timescale[t.scale])) // ['TAI', 'TDB', 'TCG', 'TCB', 'UT1', 'TT']
console.log(tdbMinusTt(terrestrial)) // 0.000174 — seconds, TDB - TT
console.log(dut1(instant)) // 0 — seconds, UT1 - UTC (0 when no IERS data is loaded)
```

### B-Plane

During a flyby the small body moves relative to the planet on an approximately two-body hyperbola. The B-plane is the plane through the planet's center perpendicular to the incoming asymptote `S`, and the B-vector runs from the center to where the asymptote pierces it. Its length, the impact parameter, is the perpendicular miss distance of the undeflected path; it exceeds the real closest-approach distance because of gravitational focusing. Its components on the `T` and `R` axes (`bt`, `br`) are the standard coordinates for flyby targeting, gravity assists, and impact and keyhole analysis.

`closeApproachBPlane` takes the planetocentric state of the body (body minus planet, in AU and AU/day) near the encounter, where the two-body approximation holds, and forms the osculating hyperbola. `options.mu` is the planet's gravitational parameter in AU³/day² (default Earth's). `options.pole` sets the reference pole for the axes `T = S × pole` and `R = S × T` (default `[0, 0, 1]`, the equator for an ICRF state); use the ecliptic pole for the ecliptic convention. The orbit must be hyperbolic: a bound relative orbit throws an `Error`. A head-on radial encounter is valid and returns zero impact parameter.

```ts
import { closeApproachBPlane } from 'nebulosa/src/astronomy/orbits/bplane'
import { kilometer, toKilometer } from 'nebulosa/src/math/units/distance'
import { kilometerPerSecond, toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// Body minus Earth, inbound at about 300000 km: position in AU, velocity in AU/day.
const position = [kilometer(-300000), kilometer(40000), kilometer(10000)] as const
const velocity = [kilometerPerSecond(12), kilometerPerSecond(-1), kilometerPerSecond(0.5)] as const

const bplane = closeApproachBPlane(position, velocity)

console.log(toKilometer(bplane.impactParameter)) // 27288 — km, |B|
console.log(toKilometer(bplane.bt), toKilometer(bplane.br)) // -15086 -22739 — km, B-vector on T and R
console.log(toKilometerPerSecond(bplane.vInfinity)) // 11.94 — km/s, hyperbolic excess speed
console.log(toKilometer(bplane.periapsisDistance)) // 24636 — km, closest approach (smaller than |B|)
console.log(bplane.sHat) // [0.9957, -0.0827, 0.0418] — incoming asymptote direction
// bplane.tHat, bplane.rHat complete the right-handed (S, T, R) frame; bplane.bVector is B in AU.

// Same encounter on the ecliptic convention: pass the ecliptic pole in the state's axes.
const ecliptic = closeApproachBPlane(position, velocity, { pole: [0, -0.3978, 0.9175] })

console.log(toKilometer(ecliptic.bt), toKilometer(ecliptic.br)) // -22880 -14871 — km
```

### Barycentric and Heliocentric Light-Time Correction

Light from a distant source reaches the Earth earlier or later than it would reach the Solar-System barycenter (BJD) or the Sun's center (HJD), depending on where the observer sits along the line of sight. The light-travel-time correction is `(r_obs · n) / c`, with `r_obs` the observer's position relative to the chosen center and `n` the unit direction to the source. Timing work such as eclipse or pulsar timing adds it to the observed time.

`lightTravelTime` returns that correction in days, positive when the observer lies on the source's side of the center. You choose the reference center through the Earth state you pass: a barycentric Earth state gives the barycentric correction and a heliocentric one the heliocentric correction. The correction is first-order and not fully relativistic. `observerState` builds the observer's `[position (AU), velocity (AU/day)]` that both this and Radial Velocity Correction use: it adds the site's topocentric offset and diurnal rotation to the Earth state, or returns a copy of the Earth state when no location is given. `location` defaults to `time.location`. Source direction is ICRS right ascension and declination in radians.

```ts
import { lightTravelTime, observerState } from 'nebulosa/src/astronomy/coordinates/correction'
import { eraEpv00 } from 'nebulosa/src/astronomy/coordinates/erfa/earth'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { tdb, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, hour } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

// La Silla Observatory: longitude, latitude, elevation.
const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
const time = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC)

// Earth's [heliocentric, barycentric] state (AU, AU/day) at the TDB instant.
const t = tdb(time)
const [heliocentric, barycentric] = eraEpv00(t.day, t.fraction)

// Source at RA 5.5 h, Dec -5°.
const ra = hour(5.5)
const dec = deg(-5)

const bjd = lightTravelTime(ra, dec, time, barycentric, location)

console.log(bjd * 86400) // 410.68 — seconds to add for the barycentric reference
console.log(lightTravelTime(ra, dec, time, heliocentric, location) * 86400) // 413.66 — seconds, heliocentric reference
console.log(lightTravelTime(ra, dec, time, barycentric) * 86400) // 410.67 — seconds, geocentric observer (no site)

// Observer state used internally: Earth state plus the site's offset and diurnal velocity.
const [position, velocity] = observerState(time, barycentric, location)

console.log(position) // [-0.16633, 0.88918, 0.38543] — AU, barycentric ICRS axes
console.log(velocity) // [-0.017353, -0.002531, -0.001185] — AU/day
```

### Binary PCK Rotation

A binary PCK (Planetary Constants Kernel) stores the orientation of a body-fixed frame, such as the Moon's principal-axes frame, as Chebyshev series for three Euler angles `φ`, `δ`, `W` against an inertial frame (J2000, NAIF id 1). The rotation is `R = Rz(W) · Rx(δ) · Rz(φ)`, from the inertial frame to the body-fixed frame, and the angular-rate operator `W = dR/dt · Rᵀ` comes from the same polynomials, in radians per day. Only Chebyshev Type 2 segments are supported; any other data type throws on load.

`readPck(daf)` builds a `Pck` from an already-opened DAF (see DAF Binary Containers). `await pck.initialize()` loads the segment directories; Chebyshev records are then read on demand and cached, so the DAF source must support synchronous reads and stay open while you evaluate. `pck.segment(id)` returns the segment for a PCK frame class id (for example 31006 for the DE421 lunar principal axes), or `undefined`; several segments with the same id are merged, and overlapping coverage resolves to the latest in file order. A segment is a `Frame`, so it works with the frame functions (`frameAt`, `frameToFrame`) as well as directly through `rotationAt(time)` and `dRdtTimesRtAt(time)`, each returning a copy. The time may be in any scale and is converted to TDB; a time outside the segment's coverage throws an `Error`, and calling `rotationAt` before `initialize` throws too. For IAU analytical rotation models see IAU Body Orientation.

```ts
import fs from 'fs/promises'
import { readDaf } from 'nebulosa/src/astronomy/ephemeris/kernels/daf'
import { readPck } from 'nebulosa/src/astronomy/ephemeris/kernels/pck'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { fileHandleSource } from 'nebulosa/src/io/file'

// Lunar principal-axes orientation from the DE421 binary PCK.
await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
const pck = readPck(await readDaf(source))

await pck.initialize()

const moon = pck.segment(31006)!

console.log(moon.inertialFrameId) // 1 — J2000 inertial frame
console.log(moon.start, moon.end) // -3155716800 1609416000 — coverage, TDB seconds past J2000

const time = timeYMDHMS(2026, 6, 29, 12, 0, 0, Timescale.TDB)

// Inertial -> Moon principal-axes rotation, row-major 3x3.
console.log(moon.rotationAt(time)) // [-0.04874, 0.92578, 0.37490, -0.99873, -0.04988, -0.00666, 0.01254, -0.37475, 0.92704]

// Angular-rate operator W = dR/dt · Rᵀ, radians per day (antisymmetric).
console.log(moon.dRdtTimesRtAt(time)) // [0, 0.22998, -0.0000071, -0.22998, 0, -0.00021533, 0.0000071, 0.00021533, 0]

console.log(pck.segment(1)) // undefined — no segment for that frame class id
```

### Body-Surface Solar Illumination

On a rotating body, the local Sun altitude at a surface point is the angle between the Sun direction and the local horizontal plane, which is perpendicular to the reference ellipsoid's normal at that point. It changes as the body rotates, and sunrise and sunset are the times it crosses a chosen horizon altitude.

`bodySurfaceSolarAltitude(location, sunAt, time)` returns the altitude of the Sun's center in radians. `bodySurfaceSunEvents(location, sunAt, start, stop, options)` returns the chronological sunrise and sunset crossings in a window, each with its refined `time`, `kind` (`'sunrise'` while the altitude rises, `'sunset'` while it falls), and the `altitude` there. `options.horizon` is the altitude in radians that defines the crossing (default 0, the geometric horizon); `options.step` and `options.tolerance` are the coarse scan step and refinement tolerance in days (defaults one hour and about 0.09 s). The step must be small enough that no two crossings share a step. Tangential touches are omitted, so an empty list can mean polar day or night.

`location` is a `BodySurfaceLocation` (see Planetary Surface Locations), whose frame orients the rotating body. `sunAt` is a function of `Time` returning the body-center-to-Sun vector in the library's base axes. It is treated as parallel across the body, so there is no terrain, refraction, solar radius, or surface parallax, and the altitude refers to the solar center. The scan evaluates `sunAt` slightly beyond the window edges to classify each root.

```ts
import { bodyFixedFrame, MOON_ROTATION } from 'nebulosa/src/astronomy/bodies/orientation'
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { bodySurfaceSolarAltitude, bodySurfaceSunEvents } from 'nebulosa/src/astronomy/events/surface'
import { bodyShape, bodySurfaceLocation } from 'nebulosa/src/astronomy/observer/body'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer } from 'nebulosa/src/math/units/distance'

const epoch = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)

// Copernicus crater on the Moon: 20.08° W, 9.62° N, on a sphere of radius 1737.4 km.
const radius = kilometer(1737.4)
const location = bodySurfaceLocation(deg(-20.08), deg(9.62), 0, bodyShape([radius, radius, radius]), bodyFixedFrame(MOON_ROTATION))

// Moon-center to Sun, in base axes (geometric, no light time).
const sunAt = (time: Time) => vecMinus(vecMinus(sun(time)[0], earth(time)[0]), moon(time)[0])

console.log(toDeg(bodySurfaceSolarAltitude(location, sunAt, epoch))) // -43.87 — degrees, the Sun is below the horizon
console.log(toDeg(bodySurfaceSolarAltitude(location, sunAt, timeShift(epoch, 10)))) // 73.52 — degrees, local day

const events = bodySurfaceSunEvents(location, sunAt, epoch, timeShift(epoch, 32), { step: 0.5 })

console.log(events.map((e) => e.kind)) // ['sunrise', 'sunset']
console.log(events.map((e) => timeSubtract(e.time, epoch))) // [3.674, 18.492] — days after the epoch

// Sunrise/sunset at 5° solar altitude instead of 0°.
const high = bodySurfaceSunEvents(location, sunAt, epoch, timeShift(epoch, 32), { step: 0.5, horizon: deg(5) })

console.log(high.map((e) => timeSubtract(e.time, epoch))) // [4.091, 18.075] — days, a shorter day
```

### Carrington Rotation

The Carrington system numbers the Sun's rotations by a fixed synodic period of about 27.2753 days, as seen from Earth, counted from a conventional epoch in 1853. Solar maps and datasets are usually labeled by Carrington rotation number.

`carringtonRotationNumber` returns the integer rotation number whose span contains the given `Time`. It is a linear count with that fixed period; it does not compute the central meridian longitude within the rotation.

```ts
import { carringtonRotationNumber } from 'nebulosa/src/astronomy/bodies/sun'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const rotation = carringtonRotationNumber(timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC))

console.log(rotation) // 2302 — Carrington rotation number
```

### Celestial and Terrestrial Reference Frames

A reference frame here is an orientation of the axes, defined relative to a common base (ICRS/GCRS-oriented) by a base-to-frame rotation matrix at a time. Fixed frames never change: ICRS, FK4, FK5, Galactic, Supergalactic, the B1950 equatorial and ecliptic, and the J2000 ecliptic. Dynamical frames depend on time: the mean and true equator and equinox of date, the mean and true ecliptic of date, and the Celestial Intermediate Reference System (CIRS). Earth-fixed frames add the planet's rotation: TIRS, and ITRS (TIRS plus polar motion). TEME, the SGP4 frame, is also provided.

A rotating frame also needs the term `W = dR/dt · Rᵀ`, so that a full state transforms as `v_frame = R · v_base + W · p_frame`. Dynamical frames derive it numerically, ITRS and TIRS use the mean Earth spin, and a frame without `dRdtTimesRtAt` adds no transport (time-independent frames and TEME). Frames only rotate: they do not shift the origin (see Affine Origin Frames) and do not apply aberration, deflection, or refraction (see Apparent Direction).

`frameAt(pv, frame, time)` rotates a position (a `Vec3`) or a `[position, velocity]` state from the base into a frame, `frameToBase` is its exact inverse, and `frameToFrame(pv, from, to, time)` goes through the base. `frameRotationAt` returns the single matrix `R_to · R_fromᵀ` for repeated use on positions or on inertial pairs, but it does not include `W`. The named wrappers (`galactic`, `supergalactic`, `fk4`, `fk5`, `icrs`, `eclipticJ2000`, `eclipticB1950`, `meanEquatorAndEquinoxAtB1950` take no time; `ecliptic`, `meanEclipticOfDate`, `meanEquatorAndEquinoxOfDate`, `trueEquatorAndEquinoxOfDate`, `cirs`, `tirs`, `teme`, `itrs`, `itrsInstantaneous` take a `Time`) call `frameAt` with the matching frame constant. `icrsToFk5` and `fk5ToIcrs` apply only the constant frame bias. Units are whatever the input carries: pass AU and AU/day for states. Every function accepts an optional output `o`: the result is written there and the return aliases it, and `o` may be the input itself.

```ts
import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { ecliptic, frameAt, frameRotationAt, frameToBase, frameToFrame, galactic, GALACTIC, ICRS, ITRS, ECLIPTIC_J2000 } from 'nebulosa/src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { matMulVec } from 'nebulosa/src/math/linear-algebra/mat3'
import { deg, hour } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 12, 0, 0, Timescale.UTC)

// Unit direction for RA 10 h, Dec +20° in ICRS.
const direction = eraS2c(hour(10), deg(20))

// Time-independent frame wrapper: ICRS -> Galactic Cartesian axes.
console.log(galactic(direction)) // [-0.5312, -0.3556, 0.7690]

// Generic: frame -> frame. Equivalent to rotating ICRS to the J2000 ecliptic.
console.log(frameToFrame(direction, ICRS, ECLIPTIC_J2000)) // unit vector in ecliptic J2000 axes

// Time-dependent: the ecliptic of date (true ecliptic at `time`).
console.log(ecliptic(direction, time)) // unit vector in ecliptic-of-date axes

// Inverse back to the base frame.
console.log(frameToBase(galactic(direction), GALACTIC, time)) // [-0.8138, 0.4698, 0.3420] — the original direction

// A state: AU and AU/day, here a point fixed in the ICRS frame at 1 AU on +x.
const state = [
	[1, 0, 0],
	[0, 0, 0],
] as const

// In ITRS the point is not at rest: Earth's spin adds W · p to the velocity.
const [position, velocity] = frameAt(state, ITRS, time)

console.log(position) // [-0.1261, -0.9920, 0.0026] — AU, Earth-fixed axes
console.log(velocity) // [-6.250, 0.7946, 0] — AU/day

// One matrix for many vectors at one instant (positions only; no W term).
const rotation = frameRotationAt(ICRS, GALACTIC, time)

console.log(matMulVec(rotation, direction)) // [-0.5312, -0.3556, 0.7690] — same as galactic(direction)
```

### Civil UTC Timestamps

Civil time is a calendar date and clock reading in UTC, and Unix time counts seconds since 1970-01-01 00:00:00 UTC. UTC includes leap seconds, so a civil day can last 86401 s and the clock can read 23:59:60. The library keeps this exact when you build or read UTC instants.

`timeYMDHMS` builds an instant from year, month, day, hour, minute, and second (fractional allowed); `timeYMD` takes a day fraction instead of a clock. For UTC the day length is 86400 s plus the day's leap second, so 23:59:60 stays on its civil date. For any other scale the day is 86400 s. `timeToDate` reads an instant back as `[year, month, day, hour, minute, second, millisecond]`, in the clock of the instant's own scale, and inverts the leap-second stretch for UTC. `timeUnix` and `timeNow` build UTC instants from Unix seconds and the system clock; `fast: true` skips the compensated normalization. `timeToUnix` and `timeToUnixMillis` convert any instant to UTC first. Unix time here is monotonic at 86400 s per UTC day and does not follow POSIX's jump back on leap-second days, so it can differ from strict POSIX by up to 1 s.

```ts
import { timeNow, timeToDate, timeToUnix, timeToUnixMillis, timeUnix, timeYMD, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

// Defaults: month = 1, day = 1, clock = 00:00:00, scale = UTC.
const instant = timeYMDHMS(2026, 6, 29, 12, 30, 15.25)

console.log(timeToDate(instant)) // [2026, 6, 29, 12, 30, 15, 250] — UTC; the last field is truncated milliseconds
console.log(timeToDate(timeYMD(2026, 6, 29, 0.75))) // [2026, 6, 29, 18, 0, 0, 0] — 0.75 of the civil day

// Unix seconds since 1970-01-01 00:00:00 UTC.
console.log(timeToDate(timeUnix(946684800))) // [2000, 1, 1, 0, 0, 0, 0]
console.log(timeToUnix(timeYMDHMS(2000, 1, 1))) // 946684800 — seconds
console.log(timeToUnixMillis(timeYMDHMS(2000, 1, 1, 0, 0, 1.5))) // 946684801500 — milliseconds

// A positive leap second: 2016-12-31 23:59:60.
console.log(timeToDate(timeYMDHMS(2016, 12, 31, 23, 59, 60.5))) // [2016, 12, 31, 23, 59, 60, 500]

// Current instant, UTC. The value depends on the system clock.
const now = timeNow()
console.log(timeToDate(now)) // current UTC date and time
```

### Constellations

The IAU divides the sky into 88 constellations with boundaries defined along lines of constant right ascension and declination in the B1875 equinox. `constellation` finds the one containing a position: it precesses the position to B1875, then looks it up in the Delporte boundary table.

`ra` and `dec` are in radians. `equinox` is the epoch of the input coordinates as a `Time`, and defaults to J2000; pass `false` when the coordinates are already referred to B1875 to skip precession. The result is the three-letter uppercase key, which indexes `CONSTELLATIONS` for the display name, mixed-case IAU abbreviation, Latin genitive, and a short description.

```ts
import { constellation, CONSTELLATIONS } from 'nebulosa/src/astronomy/coordinates/constellation'
import { deg, hour } from 'nebulosa/src/math/units/angle'

// J2000 right ascension 5h30m, declination -5°.
const key = constellation(hour(5.5), deg(-5))

console.log(key) // ORI
console.log(CONSTELLATIONS[key].name) // Orion
console.log(CONSTELLATIONS[key].iau) // Ori
console.log(CONSTELLATIONS[key].genitive) // Orionis

console.log(constellation(hour(0.7122), deg(41.269))) // AND — M31 region
console.log(constellation(0, deg(-90))) // OCT — south celestial pole

// Coordinates already on the B1875 equinox: no precession is applied.
console.log(constellation(hour(5.5), deg(-5), false)) // ORI
```

### DAF Binary Containers

DAF (Double precision Array File) is the NAIF binary container underneath SPK ephemeris kernels and binary PCK orientation kernels. A file is a sequence of 1024-byte records holding a header, a chain of segment summaries, and the numeric data, as 64-bit floats in either byte order. Each summary describes one segment: a trimmed name, a few doubles (for SPK and PCK these are the start and end epochs, in TDB seconds past J2000), and integers (ids, data type, and the first and last data word).

`readDaf(source)` parses the header and the summary chain from a seekable byte source and returns a `Daf` without reading the data. It handles big- and little-endian files, and throws an `Error` for an unsupported format, a damaged file, or a truncated one. `daf.summaries` lists the segments. `daf.read(start, end)` returns the inclusive, 1-based range of double-words as a `Float64Array`, either a promise or an array depending on the source. `daf.readSync` does the same synchronously and requires a source that supports synchronous reads; kernel frames use it because `rotationAt` cannot await. The container only exposes bytes: interpret the segments with Binary PCK Rotation or SPK State Kernels.

```ts
import fs from 'fs/promises'
import { readDaf } from 'nebulosa/src/astronomy/ephemeris/kernels/daf'
import { fileHandleSource } from 'nebulosa/src/io/file'

// The source must be seekable and stay open while you read from the Daf.
await using source = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
const daf = await readDaf(source)

console.log(daf.summaries.length) // 1 — one segment in this kernel

const [summary] = daf.summaries

console.log(summary.name) // de421.nio
console.log(summary.doubles) // [-3155716800, 1609416000] — start and end epochs, TDB seconds past J2000
console.log(summary.ints) // [31006, 1, 2, 641, 221284] — frame id, inertial frame id, data type, first and last double-word

// Words 641 to 644 of the segment data: a 1-based, inclusive range.
const words = await daf.read(summary.ints[3], summary.ints[3] + 3)

console.log(words.length) // 4

const same = daf.readSync(summary.ints[3], summary.ints[3] + 3)

console.log(same.length) // 4 — synchronous counterpart of read
```

### Delta T

Delta T is `TT − UT1`: the gap between the uniform Terrestrial Time scale and Earth-rotation time. It changes irregularly because the Earth's rotation does, so past values come from historical records and future values are extrapolations.

`deltaT` takes a decimal calendar year and returns seconds, picking one model per era: the Stephenson, Morrison and Hohenkerk 2016 parabola before the S15 spline's start (year −720), the S15 cubic spline from there to 2019, and the Espenak and Meeus 2006 expressions after 2019. A step of about 1.8 s exists at 2019, where observations hand over to forward prediction, so values after 2019 are model predictions rather than measurements. `deltaTByEspenakMeeus2006` is that polynomial model alone and stays finite for any year. `s15` returns the spline segment covering a year; call its `compute` with the year.

```ts
import { deltaT, deltaTByEspenakMeeus2006, s15 } from 'nebulosa/src/astronomy/time/deltat'

// year: decimal calendar year, e.g. 2000.5 is mid-2000.
console.log(deltaT(2000)) // 63.81 — seconds, from the S15 spline
console.log(deltaT(1900)) // -1.98 — seconds
console.log(deltaT(2100)) // 202.74 — seconds, predicted

console.log(deltaTByEspenakMeeus2006(2000)) // 63.86 — seconds, Espenak-Meeus polynomial only
console.log(s15(2000).compute(2000)) // 63.81 — seconds, same as deltaT(2000)
```

### Dew Point and Frost

The dew point is the temperature at which air saturates and water condenses on a surface; the frost point is the same for deposition of ice. Both come from the Magnus approximation. The margin `T − Tdew` says how far the air is from saturation, and optics that cool below the dew point collect dew.

`dewPoint` and `frostPoint` take the ambient temperature in °C within `[-100, 100]` and a relative humidity in percent within `(0, 100]`, and throw a `RangeError` for any other humidity. `frostPoint` expects the humidity relative to ice, not the water-relative value weather stations report; above freezing the dew point is the relevant temperature. `relativeHumidity` is the inverse of `dewPoint` (it may exceed 100 for supersaturated input). `isMagnusDomain` tests a temperature before calling, since outside the domain results can be non-finite.

```ts
import { dewMargin, dewPoint, dewRisk, dewRiskFromMargin, frostPoint, isMagnusDomain, relativeHumidity } from 'nebulosa/src/astronomy/formulas'

// temperature: °C. humidity: percent over water, in (0, 100].
const td = dewPoint(20, 60)

console.log(td) // 12.0 — dew point in °C
console.log(relativeHumidity(20, td)) // 60 — percent, inverse of dewPoint
console.log(frostPoint(-10, 50)) // -17.58 — °C, humidity relative to ice

console.log(dewMargin(20, 60)) // 8.0 — °C above the dew point (T - Tdew)

// Risk on a 0..1 scale: 1 at margin <= 0, linearly down to 0 at the clear margin (default 5 °C).
console.log(dewRiskFromMargin(2.5)) // 0.5
console.log(dewRisk(20, 60)) // 0 — margin of 8 °C is beyond the default clear margin
console.log(dewRisk(10, 90, 10)) // 0.8435 — margin of 1.57 °C against a 10 °C clear margin

console.log(isMagnusDomain(150)) // false — outside [-100, 100] °C
```

### Differential Orbit Correction

Differential correction refines an approximate orbit so that it reproduces a set of astrometric observations. Starting from a state guess at an epoch, the six Cartesian parameters (position and velocity) are adjusted to minimize the weighted squared difference between the observed and predicted right ascension and declination, using a Levenberg-Marquardt least-squares loop with a finite-difference Jacobian. It is a two-body fit around the Sun: it models no planetary perturbations, so it suits short arcs and modest accuracy.

`fitOrbit(observations, epoch, position, velocity, options?)` needs at least 3 observations (6 parameters) and throws an `Error` otherwise or when the model cannot be evaluated. An observation is `{ time, rightAscension, declination, observerPosition, raErr?, decErr? }` with angles in radians in the same inertial frame as the state, and `observerPosition` the observer's position at the observation time in that frame and unit system (AU, heliocentric for a heliocentric state). `raErr` and `decErr` are 1-σ uncertainties in radians (default 1″), and the right-ascension residual is weighted by `cos(dec)`. The initial state is the `position` and `velocity` guess in AU and AU/day at `epoch`. Useful `options` are `mu` (gravitational parameter, default the Sun's), `maxIterations` (default 50), `computeCovariance` (default true), and the convergence tolerances `tolerance`, `parameterTolerance`, and `gradientTolerance`. The result has the fitted `state`, the `orbit` as a `KeplerOrbit` in the input frame, the 6×6 parameter `covariance` (ordered `x, y, z, vx, vy, vz`; absent when not requested or too ill-conditioned), `residuals` (normalized in σ units and angular in radians), `chi2`, `reducedChi2` (NaN when there are no degrees of freedom), `rms` (radians), the accepted `iterations`, and `converged`. The covariance is scaled by the reduced χ², and feeds Orbit Covariance Propagation.

```ts
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { fitOrbit, type OrbitFitObservation } from 'nebulosa/src/astronomy/orbits/fit'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, time } from 'nebulosa/src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { arcsec, toArcsec } from 'nebulosa/src/math/units/angle'
import { vecLength, vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'

// A "true" orbit (Vesta's heliocentric equatorial state at 2025-04-21 12:00 TDB) used to synthesize observations.
const position = [-1.70317472297052, -1.333843040283118, -0.3086709149679688] as const
const velocity = [0.007882762615954012, -0.008079478592200335, -0.004254433056153772] as const
const epoch = time(2460787, 0, Timescale.TDB)
const truth = new KeplerOrbit(position, velocity, epoch, GM_SUN_PITJEVA_2005, matIdentity())

// Ten weekly observations seen from the Earth (heliocentric), each off by a fraction of an arcsecond.
const observations: OrbitFitObservation[] = [0, 7, 14, 21, 28, 35, 42, 49, 56, 63].map((days, k) => {
	const t = time(2460787 + days, 0, Timescale.TDB)
	const observer = vecMinus(earth(t)[0], sun(t)[0])
	const p = truth.at(t)[0]
	const x = p[0] - observer[0]
	const y = p[1] - observer[1]
	const z = p[2] - observer[2]
	const declination = Math.asin(z / vecLength([x, y, z])) + arcsec(k % 3 ? 0.3 : -0.3)
	const rightAscension = Math.atan2(y, x) + arcsec(k % 2 ? 0.4 : -0.4) / Math.cos(declination)

	return { time: t, rightAscension: (rightAscension + 2 * Math.PI) % (2 * Math.PI), declination, observerPosition: observer, raErr: arcsec(0.5), decErr: arcsec(0.5) }
})

// A starting guess off by about 0.1% in every component.
const fit = fitOrbit(observations, epoch, [position[0] * 1.001, position[1] * 0.999, position[2] * 1.002], [velocity[0] * 1.003, velocity[1] * 0.997, velocity[2] * 1.001])

console.log(fit.converged, fit.iterations) // true 8
console.log(fit.reducedChi2) // 0.642 — about 1, consistent with the 0.5" uncertainties
console.log(toArcsec(fit.rms)) // 0.474 — arcseconds, RMS angular residual
console.log(fit.state.position) // [-1.70314, -1.33381, -0.30867] — AU, within 5e-5 AU of the true state
console.log(fit.orbit.semiMajorAxis) // 2.3614 — AU
console.log(Math.sqrt(fit.covariance!.get(0, 0))) // 0.0000412 — AU, 1-sigma uncertainty of x

// Without the covariance, and with an iteration cap.
console.log(fitOrbit(observations, epoch, position, velocity, { computeCovariance: false, maxIterations: 20 }).covariance) // undefined
```

### Differential Refraction and Atmospheric Dispersion

Refraction depends on wavelength: blue light is bent more than red, so the image of a star is stretched into a short spectrum along the vertical, with the blue end toward the zenith. The effect grows toward the horizon and matters for broadband imaging, guiding, and spectroscopy.

`differentialRefraction(altitude, wavelengthAMicrons, wavelengthBMicrons, conditions?)` returns the signed difference in radians between the refractive displacements at the two wavelengths, in the order given: it is positive when A is the bluer one. `atmosphericDispersion(altitude, blueMicrons, redMicrons, conditions?)` returns the length of the dispersion for a spectral window, whatever the order of the two edges. `altitude` is the apparent altitude in radians; both functions return `undefined` on the horizon and below it. `conditions` takes `pressure` (hPa), `temperature` (°C), and `relativeHumidity` (fraction 0..1), with standard defaults, and `atmosphericDispersion` also accepts extra fields: `hourAngle`, `declination`, and `latitude` (radians), which together orient the dispersion, and `arcsecPerPixel`, which adds its length in pixels. The result has `angle` (radians, never negative), `arcseconds`, optionally `positionAngle` (the parallactic angle, north through east, where the shorter wavelength lies toward the zenith), and optionally `pixels`. For one wavelength, see Refractive Displacement.

```ts
import { atmosphericDispersion, differentialRefraction } from 'nebulosa/src/astronomy/coordinates/refraction'
import { deg, hour, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

// Blue (0.45 µm) minus red (0.65 µm) at apparent altitude 45°; the sign follows the argument order.
console.log(toArcsec(differentialRefraction(deg(45), 0.45, 0.65)!)) // 0.8669 — arcseconds, positive
console.log(toArcsec(differentialRefraction(deg(45), 0.65, 0.45)!)) // -0.8669 — arcseconds
console.log(toArcsec(differentialRefraction(deg(10), 0.45, 0.65)!)) // 4.7616 — arcseconds, larger lower down

// A 0.4-0.7 µm band at altitude 40°, with orientation and a 1.5"/pixel image scale.
const dispersion = atmosphericDispersion(deg(40), 0.4, 0.7, { hourAngle: hour(2), declination: deg(20), latitude: deg(-30), arcsecPerPixel: 1.5 })

console.log(dispersion?.arcseconds) // 1.7036 — arcseconds
console.log(toDeg(dispersion!.positionAngle!)) // 149.2 — degrees, parallactic angle: blue end toward the zenith
console.log(dispersion?.pixels) // 1.1357 — pixels

// Without the geometry or image scale only the length is returned.
console.log(atmosphericDispersion(deg(40), 0.7, 0.4)?.arcseconds) // 1.7036 — arcseconds, edge order does not matter
console.log(atmosphericDispersion(0, 0.4, 0.7)) // undefined — on the horizon
```

### Earth Occultation of a Finite Target

A satellite or spacecraft can be hidden behind the solid Earth as seen from another one. The question is whether the straight segment from an observer to a target at a finite distance touches the Earth's reference ellipsoid, and where. This is a geometric test only: there is no atmosphere, terrain, or shadow of the Sun, so it says nothing about visibility under illumination.

`earthOccultation(observer, target, time, ellipsoid?)` takes the observer and target positions as geocentric vectors in AU, in the same GCRS/ICRS-oriented axes at the same reception time, and `ellipsoid` (default `Ellipsoid.IERS2010`). It rotates both into ITRS and tests the closed segment against the ellipsoid. It returns `{ occulted, intersection?, tangent }`: `occulted` is true when the segment touches or enters the ellipsoid, `intersection` is the first contact as a fraction `t` in `[0, 1]` along `observer + t · (target − observer)`, and `tangent` marks a graze within numerical tolerance. The observer must be outside the solid Earth. A surface contact counts as an occultation.

```ts
import { earthOccultation } from 'nebulosa/src/astronomy/events/occultation.earth'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { kilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.UTC)

// An observer 7000 km from the center on +x, and a target 40000 km on the opposite side: Earth is in the way.
const behind = earthOccultation([kilometer(7000), 0, 0], [kilometer(-40000), 0, 0], time)

console.log(behind.occulted) // true
console.log(behind.intersection) // 0.01323 — fraction of the segment: about 622 km from the observer, at the surface
console.log(behind.tangent) // false

// Same side: the segment moves away from the Earth.
console.log(earthOccultation([kilometer(7000), 0, 0], [kilometer(40000), 0, 0], time).occulted) // false

// A segment that passes at 7000 km from the center never touches the 6378 km equatorial radius.
console.log(earthOccultation([kilometer(7000), 0, 0], [kilometer(7000), kilometer(30000), 0], time).occulted) // false
```

### Earth Orientation Parameters

The Earth does not rotate uniformly, and its rotation axis wanders slightly inside the crust. The IERS publishes the irregularities as daily Earth orientation parameters: `UT1 − UTC` in seconds and the polar-motion coordinates `x`, `y` in arcseconds. They are needed for UT1, sidereal time, and the GCRS to ITRS rotation, so they are the data behind precise Earth-fixed work and topocentric coordinates.

The library has no built-in tables. You load one of two IERS files into a shared provider, and the time module reads them automatically: `iersa` takes the IERS Bulletin A `finals2000A` file (rapid and predicted values extending into the future) and `iersb` the IERS EOP 14 C04 `eopc04` series (final values). `dut1(time)` and `xy(time)` use the combined provider, which prefers C04 wherever it covers the date and otherwise falls back to Bulletin A. Values are linearly interpolated between daily samples, with the leap-second jump removed from `UT1 − UTC` so it stays continuous through a leap-second day; outside the table they clamp to the nearest edge. With nothing loaded they return 0 and 0, which silently turns UT1 into UTC, so load a table before computing UT1-dependent results. `covers(time)` reports whether a table spans an instant, `distance(time)` how many days it lies outside, and `clear()` discards a table. Polar motion `xy` is in radians; the loaded tables are stored in arcseconds.

`load` accepts a byte `Source` (such as `readableStreamSource` or a `fileHandleSource`) or an array of file lines. To use other data for a single instant or the whole process, replace the providers described in Astronomical Time-Scale Conversion instead.

```ts
import { dut1, iersa, iersb, xy } from 'nebulosa/src/astronomy/time/iers'
import { dut1 as dut1FromTime, Timescale, timeYMDHMS, ut1 } from 'nebulosa/src/astronomy/time/time'
import { readableStreamSource } from 'nebulosa/src/io/io'
import { toArcsec } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)

console.log(dut1FromTime(time)) // 0 — nothing loaded yet, so UT1 equals UTC

// IERS Bulletin A (finals2000A). Use iersb with eopc04 for the final C04 series.
await using source = readableStreamSource(Bun.file('data/finals2000A.txt').stream())
await iersa.load(source)

// A fresh instant, since the offset is cached on an instant once computed.
const later = timeYMDHMS(2020, 10, 7, 12, 34, 56, Timescale.UTC)

console.log(dut1(later)) // -0.17181 — seconds, UT1 - UTC
console.log(dut1FromTime(later)) // -0.17181 — the time module now sees it
console.log(xy(later).map(toArcsec)) // [0.18781, 0.31804] — arcseconds, polar motion x and y

console.log(iersa.covers(later)) // true
console.log(iersb.covers(later)) // false — C04 not loaded

console.log(ut1(later).scale === Timescale.UT1) // true — now offset by UT1 - UTC from UTC
```

### Elliptic Elements to Rectangular State

The analytical satellite theories describe each orbit by slowly varying elliptic elements and need a position and velocity from them. The element set used is equinoctial-style, which stays well defined for small eccentricity and inclination: mean longitude `L = Ω + ω + M`, `K = e·cos(Ω + ω)`, `H = e·sin(Ω + ω)`, `Q = sin(i/2)·cos Ω`, and `P = sin(i/2)·sin Ω`. Kepler's equation is solved in these variables by Newton's method, which converges in a few steps for eccentricity below 1 and stops at a safety cap otherwise.

The solvers take an element array `[a or n, L, K, H, Q, P]` and a time offset `dt` from the elements' epoch, in days, with `L`, `K`, `H`, `Q`, `P` in radians and dimensionless. Position is in AU and velocity in AU/day, in the frame the elements are referred to. `ellipticToRectangularA(mu, elem, dt)` takes the semi-major axis in `elem[0]` (AU) and derives the mean motion from the gravitational parameter `mu` (AU³/day²). `ellipticToRectangularN(mu, elem, dt)` takes the mean motion in `elem[0]` (radians/day) and derives the semi-major axis. `ellipticToRectangular(a, n, elem, dt)` is the shared core when you already have both, and ignores `elem[0]`. Each returns `[position, velocity]`, allocating a pair unless you pass an `out` state, which is filled and returned. The orbit must be elliptic (`K² + H² < 1`); for hyperbolic or parabolic orbits see Two-Body Kepler Propagation.

```ts
import { ellipticToRectangular, ellipticToRectangularA, ellipticToRectangularN } from 'nebulosa/src/astronomy/ephemeris/ephemeris'
import { GM_SUN_PITJEVA_2005, TAU } from 'nebulosa/src/core/constants'

const mu = GM_SUN_PITJEVA_2005 // AU³/day²
const a = 1 // AU
const n = Math.sqrt(mu / a ** 3) // radians/day, a period of 365.26 days

// Circular, equatorial orbit (K = H = Q = P = 0) starting at L = 0 on +x.
const elements = [a, 0, 0, 0, 0, 0]

// Quarter of an orbit later: dt in days.
const [position, velocity] = ellipticToRectangularA(mu, elements, TAU / n / 4)

console.log(position) // [0, 1, 0] — AU
console.log(velocity) // [-0.017202, 0, 0] — AU/day, counter-clockwise

// Same orbit with the mean motion given instead of a.
console.log(ellipticToRectangularN(mu, [n, 0, 0, 0, 0, 0], TAU / n / 4)[0]) // [0, 1, 0] — AU

// Both a and n given, at the epoch.
console.log(ellipticToRectangular(a, n, elements, 0)) // [[1, 0, 0], [0, 0.017202, 0]]

// An eccentric, inclined orbit: build the equinoctial set from e, i, Ω, ω and M.
const e = 0.2
const i = 0.4
const node = 0.3
const periapsis = Math.PI / 2
const L = node + periapsis + 0.5
const K = e * Math.cos(node + periapsis)
const H = e * Math.sin(node + periapsis)
const Q = Math.sin(i / 2) * Math.cos(node)
const P = Math.sin(i / 2) * Math.sin(node)

console.log(ellipticToRectangularA(mu, [a, L, K, H, Q, P], 10)[0]) // [-0.81474, 0.21432, 0.18836] — AU
```

### ELP/MPP02 Lunar Theory

ELP/MPP02 is an analytical theory of the Moon's motion. It sums large tables of periodic terms, the main problem plus planetary and other perturbations, for the Moon's ecliptic longitude, latitude, and distance, and ties the result to the ICRF equatorial frame. It needs no data files and works over a wide range of dates, which makes it a good default Moon ephemeris when an SPK kernel is not at hand.

`moon(time)` returns the geocentric position in AU and velocity in AU/day, in ICRF equatorial axes. The time is converted to TT internally, so any scale works. The returned pair is freshly allocated on each call. It is geocentric: add it to the Earth's barycentric state to get a barycentric Moon (see Ephemeris Path Composition), and for a high-precision lunar ephemeris use an SPK kernel instead (see SPK State Kernels).

```ts
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

const [position, velocity] = moon(time)

console.log(position) // [-0.00052834, -0.0023152, -0.0012725] — AU, geocentric ICRF
console.log(velocity) // [0.00055235, -0.000087550, -0.000035530] — AU/day
console.log(toKilometer(Math.hypot(...position))) // 403051 — km, Earth-Moon distance
```

### Ephemeris Observed Positions

Observing a body from another moves through stages, each a distinct kind of position. A geometric position is the same-epoch center-to-target state. An astrometric position is the retarded one: the target is sampled at emission time and the observer at reception, so light time is accounted for. An apparent position then adds the deflection of light by Solar-System bodies and the observer's aberration. Each stage is an owned snapshot tagged with a `kind`, in ICRS/BCRS-oriented axes, positions in AU, velocities in AU/day, and light time in days.

`ephemerisAt(path, time)` materializes a path (see Ephemeris Path Composition) as an owned `GeometricPosition` with `position` and `velocity` copies. `observeEphemeris(observer, target, time, options?)` returns the `AstrometricPosition`: the retarded observer-to-target `position`, its unit `direction`, `distance`, `lightTime`, `emissionTime`, and the observer and target snapshots. Both paths must be barycentric (center `SOLAR_SYSTEM_BARYCENTER`), or it throws, and `options.lightTimeIterations` is an integer in `[0, 16]` (default 3). It returns `undefined` for coincident points. `apparentPosition(position, options?)` applies the corrections to that astrometric position and returns an `ApparentPosition`: aberration is on by default and then requires `options.sun`, a barycentric Sun path, or it throws, and `options.deflectors` lists barycentric `{ mass, limiter, path }` bodies in photon encounter order (none are implicit). Distance and light time stay astrometric. This is the path-based counterpart of `apparentDirection` from Apparent Direction.

The remaining functions convert a stage. `equatorialPosition(position)` returns `[ra, dec, distance]`, with right ascension in `[0, 2π)` and declination in radians, distance in AU. `directionPositionInFrame(position, frame)` rotates the direction of an astrometric or apparent stage into a frame at its epoch, and `geometricPositionInFrame(position, frame)` rotates a geometric state, including the rotating-frame term. `geometricSphericalPositionAndVelocity(position, frame?)` gives the spherical coordinates and rates of a geometric state (see Spherical State Rates), or `undefined` at zero distance. The optional `out` arguments receive the result and are returned. No precession, nutation, or refraction is applied here: for an observed place use Topocentric Observed Place.

```ts
import { Naif } from 'nebulosa/src/astronomy/ephemeris/kernels/naif'
import { earth, mars, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { ephemerisPath, naifEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from 'nebulosa/src/astronomy/ephemeris/path'
import { apparentPosition, directionPositionInFrame, ephemerisAt, equatorialPosition, geometricSphericalPositionAndVelocity, observeEphemeris } from 'nebulosa/src/astronomy/ephemeris/position'
import { ECLIPTIC_J2000 } from 'nebulosa/src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg, toHour } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.TDB)

// Barycentric paths from VSOP87E: Earth is the observer, Mars the target, the Sun feeds the aberration term.
const earthPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.EARTH, 'Earth'), earth)
const marsPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(499, 'Mars'), mars)
const sunPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, naifEphemerisEndpoint(Naif.SUN, 'Sun'), sun)

// Geometric: Earth's owned barycentric state at one epoch.
const geometric = ephemerisAt(earthPath, time)

console.log(geometric.position) // [0.12079, -0.93081, -0.40337] — AU
console.log(geometric.velocity) // [0.016799, 0.0018474, 0.00080029] — AU/day

// Astrometric: Mars as seen from Earth, with light time.
const astrometric = observeEphemeris(earthPath, marsPath, time)!

console.log(astrometric.distance) // 2.1124 — AU
console.log(astrometric.lightTime) // 0.012200 — days, about 17.6 minutes
console.log(astrometric.direction) // [0.50353, 0.79494, 0.33843] — unit vector

// Apparent: adds aberration (the Sun path is required) and no deflection.
const apparent = apparentPosition(astrometric, { sun: sunPath })

console.log(apparent.direction) // [0.50360, 0.79490, 0.33841] — shifted by aberration

const [ra, dec, distance] = equatorialPosition(apparent)

console.log(toHour(ra), toDeg(dec), distance) // 3.8430 19.780 2.1124 — hours, degrees, AU (ICRS, not of date)

// Ecliptic J2000 axes for the same apparent direction.
console.log(directionPositionInFrame(apparent, ECLIPTIC_J2000)) // [0.50360, 0.86392, -0.0057048]

// Spherical coordinates and rates of Earth's own barycentric state.
console.log(geometricSphericalPositionAndVelocity(geometric)?.longitudeRate) // 0.018003 — radians/day
```

### Ephemeris Path Adapters

Adapters turn the library's other state sources into ephemeris paths, so they can be composed and observed uniformly (see Ephemeris Path Composition): a JPL SPK segment, an SGP4 satellite, a ground site on the Earth, and a site on another body's surface. All paths are synchronous, in AU and AU/day, in ICRS/BCRS-oriented axes.

`spkEphemerisPath(spk, center, target)` is asynchronous only to prepare: it resolves and initializes the segment, then returns a synchronous path. It returns `undefined` when the kernel has no segment for that center and target, and throws if the segment's frame is not J2000 (NAIF id 1), because any other frame would be published as ICRS axes. Evaluating can still read the file when a needed coefficient record is not cached, so keep the DAF source open. `sgp4EphemerisPath(source, target?)` takes a TLE, an OMM, or a prepared SGP4 record and returns an Earth-to-satellite path, converting SGP4's TEME state to ICRS; the default target is the custom endpoint `norad:<number>`. `earthObserverEphemerisPath(location, target)` is Earth center to a geodetic site, including the diurnal velocity. `bodySurfaceEphemerisPath(body, target, location)` is body center to a `BodySurfaceLocation`, including the body's rotational velocity; you supply the center and site endpoints.

```ts
import fs from 'fs/promises'
import { bodyFixedFrame, MOON_ROTATION } from 'nebulosa/src/astronomy/bodies/orientation'
import { readDaf } from 'nebulosa/src/astronomy/ephemeris/kernels/daf'
import { Naif } from 'nebulosa/src/astronomy/ephemeris/kernels/naif'
import { readSpk } from 'nebulosa/src/astronomy/ephemeris/kernels/spk'
import { composeEphemerisPaths, customEphemerisEndpoint, naifEphemerisEndpoint } from 'nebulosa/src/astronomy/ephemeris/path'
import { bodySurfaceEphemerisPath, earthObserverEphemerisPath, sgp4EphemerisPath, spkEphemerisPath } from 'nebulosa/src/astronomy/ephemeris/path.adapter'
import { bodyShape, bodySurfaceLocation } from 'nebulosa/src/astronomy/observer/body'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { deg } from 'nebulosa/src/math/units/angle'
import { kilometer, meter, toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2023, 8, 19, 12, 25, 28, Timescale.UTC)

// SPK: barycenter -> Earth-Moon barycenter and Earth-Moon barycenter -> Earth, from DE421.
await using source = fileHandleSource(await fs.open('data/de421.bsp'))
const spk = readSpk(await readDaf(source))
const emb = (await spkEphemerisPath(spk, Naif.SSB, Naif.EMB))!
const earth = (await spkEphemerisPath(spk, Naif.EMB, Naif.EARTH))!

console.log(composeEphemerisPaths(emb, earth).stateAt(time)[0]) // [0.83020, -0.52161, -0.22589] — AU, barycentric
console.log(await spkEphemerisPath(spk, Naif.SSB, 12345)) // undefined — no such segment

// SGP4: Earth -> ISS from a TLE, target id norad:25544.
const tle = parseTLE('1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996', '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611')
const iss = sgp4EphemerisPath(tle)

console.log(iss.target.id) // norad:25544
console.log(iss.stateAt(time)[0].map(toKilometer)) // [-3712, 2990, 4839] — km, geocentric ICRS

// Earth center -> observatory, including Earth's rotation velocity.
const site = customEphemerisEndpoint('lasilla', 'La Silla')
const observatory = earthObserverEphemerisPath(geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400)), site)

console.log(observatory.stateAt(time)[0].map(toKilometer)) // [678, 5529, -3102] — km, geocentric ICRS

// Moon center -> Copernicus crater on a 1737.4 km sphere.
const radius = kilometer(1737.4)
const surface = bodySurfaceLocation(deg(-20.08), deg(9.62), 0, bodyShape([radius, radius, radius]), bodyFixedFrame(MOON_ROTATION))
const crater = bodySurfaceEphemerisPath(naifEphemerisEndpoint(Naif.MOON, 'Moon'), customEphemerisEndpoint('copernicus', 'Copernicus'), surface)

console.log(crater.stateAt(time)[0].map(toKilometer)) // [1639, -565, 107] — km, 1737.4 km from the Moon's center
```

### Ephemeris Path Composition

An ephemeris path is a prepared, synchronous state provider from a center to a target: a function of `Time` returning `[position (AU), velocity (AU/day)]` in ICRS/BCRS-oriented axes, tagged with its two endpoints. Paths can be chained or subtracted like vectors between points: Earth to Moon added to the barycenter to Earth gives the barycenter to Moon, and two paths from the same center give the target relative to any other body.

An endpoint is either a NAIF body code (`naifEphemerisEndpoint`) or a caller-defined string identifier (`customEphemerisEndpoint`); the optional name is only a label, and identity is the kind plus the id (`sameEphemerisEndpoint`). `SOLAR_SYSTEM_BARYCENTER` is the barycenter endpoint that observation functions require as the origin. `ephemerisPath(center, target, stateAt)` wraps any provider. `reverseEphemerisPath(path)` swaps center and target and negates the state. `composeEphemerisPaths(first, second)` returns center-to-target by adding `first` (center to middle) and `second` (middle to target) at the same epoch, and throws if `first.target` is not `second.center`. `relativeEphemerisPath(target, origin)` returns origin-to-target from two paths with the same center, and throws if the centers differ. No light-time correction is applied by any of them: use Ephemeris Observed Positions for that.

The state vectors that `stateAt` returns are borrowed: each path reuses its own storage, so a later call overwrites an earlier result. Copy the state, or use `ephemerisAt` (see Ephemeris Observed Positions), to keep one. Reversed, composed, and relative paths write into a scratch state; pass your own as the last argument to control it, but it must not alias the source storage.

```ts
import { Naif } from 'nebulosa/src/astronomy/ephemeris/kernels/naif'
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { composeEphemerisPaths, customEphemerisEndpoint, ephemerisPath, naifEphemerisEndpoint, relativeEphemerisPath, reverseEphemerisPath, sameEphemerisEndpoint, SOLAR_SYSTEM_BARYCENTER } from 'nebulosa/src/astronomy/ephemeris/path'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.TDB)

const EARTH = naifEphemerisEndpoint(Naif.EARTH, 'Earth')
const MOON = naifEphemerisEndpoint(Naif.MOON, 'Moon')
const SUN = naifEphemerisEndpoint(Naif.SUN, 'Sun')

// Barycenter -> Earth and barycenter -> Sun from VSOP87E (barycentric), Earth -> Moon from ELP/MPP02 (geocentric).
const earthPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, EARTH, earth)
const sunPath = ephemerisPath(SOLAR_SYSTEM_BARYCENTER, SUN, sun)
const moonFromEarth = ephemerisPath(EARTH, MOON, moon)

// Barycenter -> Moon = (barycenter -> Earth) + (Earth -> Moon).
const moonPath = composeEphemerisPaths(earthPath, moonFromEarth)

console.log(moonPath.target.name) // Moon
console.log(moonPath.stateAt(time)[0]) // [0.12060, -0.93320, -0.40464] — AU, barycentric ICRS

// Earth -> barycenter, the reverse of the first path.
console.log(reverseEphemerisPath(earthPath).stateAt(time)[0]) // [-0.12079, 0.93081, 0.40337] — AU

// Earth -> Sun, from the two barycentric paths.
console.log(relativeEphemerisPath(sunPath, earthPath).stateAt(time)[0]) // [-0.12263, 0.92586, 0.40134] — AU

// Endpoint identity ignores the display name, and kinds never mix.
console.log(sameEphemerisEndpoint(EARTH, naifEphemerisEndpoint(399))) // true
console.log(sameEphemerisEndpoint(EARTH, customEphemerisEndpoint('399'))) // false

// Mismatched endpoints throw instead of giving plausible but invalid geometry.
composeEphemerisPaths(earthPath, sunPath) // Error: cannot compose ephemeris paths: first target does not match second center
```

### Equation of Time

The equation of time is the difference between apparent solar time (a sundial) and mean solar time (a clock). Here it is the hour-angle difference, apparent Sun minus mean Sun, and it stays within roughly ±16 minutes over a year, positive when the sundial is ahead of the clock.

`equationOfTime` returns it in radians, wrapped to `[−π, π]`; multiply degrees by 4 to get minutes of time. The caller supplies `apparentSunRightAscension`, which must be referred to the true equator and equinox of date, the same reference as Greenwich apparent sidereal time. Passing an ICRS/J2000 right ascension adds a spurious precession term of about 50″ per year, so precess and nutate the Sun direction first, for example with `equatorialFromJ2000`. Keeping the right ascension as an argument leaves the function independent of the ephemeris model.

```ts
import { equationOfTime } from 'nebulosa/src/astronomy/bodies/sun'
import { equatorial } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { equatorialFromJ2000 } from 'nebulosa/src/astronomy/coordinates/coordinate'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 11, 3, 12, 0, 0, Timescale.UTC)

// Geocentric ICRS direction to the Sun, then its right ascension of date.
const [ra, dec] = equatorial(vecMinus(sun(time)[0], earth(time)[0]))
const [raOfDate] = equatorialFromJ2000(ra, dec, time)

const minutes = toDeg(equationOfTime(time, raOfDate)) * 4

console.log(minutes) // 16.42 — minutes of time; the sundial is ahead of the clock
```

### Equatorial Ephemeris Interpolation

A precomputed ephemeris, such as a table of apparent right ascension and declination from an external service, gives positions at discrete times. An interpolator turns those samples into a continuous function of time, from which you read positions at any instant inside the span, or resample a denser table. It works on topocentric or apparent equatorial samples, with right ascension unwrapped before fitting so the 0/2π seam causes no jump.

Three factories share the `EphemerisInterpolator` interface: `linearInterpolator(points, options?)`, `splineInterpolator(points, type?, options?)`, and `chebyshevInterpolator(points, degree?, options?)`. A point is `{ time, rightAscension, declination }` with angles in radians and the `Time` in any scale (converted to TT); points may arrive unordered. A spline needs 3 samples, with `type` one of `'naturalCubic'` (default), `'cubicHermite'`, `'pchip'`, `'akima'`, or `'catmullRom'`. A Chebyshev fit is a least-squares polynomial of `degree` over the whole interval (default `min(12, samples − 1)`) that needs `degree + 1` samples and is unsafe to extrapolate. `options.outOfRange` is `'clamp'` (default, returns the first or last sample's position), `'extrapolate'`, or `'throw'` (a `RangeError`); `options.computeRmsError` fills `diagnostics` with fit residuals in radians; `options.allowDuplicateTimes` lets repeated times overwrite instead of throwing. `compute(time)` returns a fresh `[ra, dec]` in radians with right ascension in `[0, 2π)`; `computeInto(time, out)` writes into `out`, which is returned; `resample(times)` returns `EphemerisPoint`s. `startTime`, `endTime` (TT Julian Date), `sampleCount`, and `strategy` describe the fit. The interpolator object also implements `update(points)` to rebuild it from new samples; cast it to `UpdatableEphemerisInterpolator` to call it. For a pixel grid rather than a time series, see Astrometric Sample-Grid Interpolation.

```ts
import { chebyshevInterpolator, type EphemerisPoint, linearInterpolator, splineInterpolator, type UpdatableEphemerisInterpolator } from 'nebulosa/src/astronomy/ephemeris/interpolation/ephemeris'
import { Timescale, time, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, hour, toDeg, toHour } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.TT)
const at = (days: number) => time(start.day, start.fraction + days, Timescale.TT)

// Daily samples over 4 days: RA drifts east and speeds up, Dec decreases.
const points: EphemerisPoint[] = [0, 1, 2, 3, 4].map((d) => ({ time: at(d), rightAscension: hour(10) + deg(0.5) * d + deg(0.02) * d * d, declination: deg(20) - deg(0.1) * d }))

const linear = linearInterpolator(points)
const [ra, dec] = linear.compute(at(1.5))

console.log(toHour(ra), toDeg(dec)) // 10.0533 19.85 — hours, degrees

console.log(toHour(splineInterpolator(points).compute(at(1.5))[0])) // 10.0530 — hours, natural cubic spline
console.log(toHour(splineInterpolator(points, 'pchip').compute(at(1.5))[0])) // 10.0530 — hours, monotone PCHIP

// A degree-4 Chebyshev fit reproduces this polynomial track; residuals are reported on request.
const chebyshev = chebyshevInterpolator(points, 4, { computeRmsError: true })

console.log(toHour(chebyshev.compute(at(1.5))[0])) // 10.0530 — hours
console.log(chebyshev.diagnostics?.maxAbsRA) // 0 — radians, within the fit's rounding

// Outside the span: clamped by default, optionally extrapolated or rejected.
console.log(linear.compute(at(6)).map(toDeg)) // [152.32, 19.6] — degrees, the last sample
console.log(linearInterpolator(points, { outOfRange: 'extrapolate' }).compute(at(5)).map(toDeg)) // [152.96, 19.5] — degrees
linearInterpolator(points, { outOfRange: 'throw' }).compute(at(9)) // RangeError: interpolation time is outside the sample range

// A denser table.
console.log(
	splineInterpolator(points)
		.resample([at(0.5), at(2.5)])
		.map((p) => toDeg(p.declination)),
) // [19.95, 19.75] — degrees

// Rebuild in place from new samples.
;(linear as UpdatableEphemerisInterpolator).update(points.slice(0, 2))

console.log(linear.sampleCount) // 2
```

### Equatorial Mount Geometric Pointing Errors

An equatorial mount that is not perfectly built or aligned points slightly away from where its axes say it points. The model here is the six basic geometric terms of TPoint: index offsets in hour angle and declination (`IH`, `ID`), collimation or cone error (`CH`), non-perpendicularity of the polar and declination axes (`NP`), and polar-axis misalignment in azimuth (`MA`) and elevation (`ME`). The error at a mechanical orientation is

```text
ΔH = IH + CH·sec δ + NP·tan δ − MA·cos H·tan δ + ME·sin H·tan δ
Δδ = ID + MA·sin H + ME·cos H
```

`equatorialPointingError(hourAngle, declination, model)` returns `[ΔH, Δδ]` in radians, the amount to add to the mechanical hour angle and declination to get where the optical axis really points. `applyEquatorialPointingError(ra, dec, lst, model)` does that for right ascension and declination: with `H = LST − RA` it returns `[RA − ΔH, dec + Δδ]`, with the right ascension wrapped to `[0, 2π)` and the declination left unwrapped. The model is an `EquatorialPointingModel` whose six coefficients (`indexHourAngle`, `indexDeclination`, `coneError`, `axisNonPerpendicularity`, `polarAzimuthError`, `polarAltitudeError`) are radians that default to zero in `IDENTITY_EQUATORIAL_POINTING_MODEL`; `isIdentityEquatorialPointingModel` tests for it so callers can skip the work. `polarAlignmentPointingModel(azimuthError, altitudeError, latitude)` builds the model of a mount whose polar axis is misaligned by knob errors, with `MA = azimuth·cos(latitude)`, `ME = −altitude`, and a constant hour-angle term `azimuth·sin(latitude)` kept in `indexHourAngle`. Positive `altitudeError` means the polar axis points above the true pole.

The `sec δ` and `tan δ` terms diverge at the pole, so `equatorialPointingError` clamps the declination to `MAX_POINTING_DECLINATION` (89.9°) and the hour-angle term it returns grows large there without meaning an on-sky error of that size. Within that limit of the pole `applyEquatorialPointingError` applies the same terms as a great-circle offset instead, which is well defined at the pole and can cross it. Pass an optional last argument `o` to receive the result in place; the return value aliases it. Add tube flexure separately with Tube Flexure Pointing Error.

```ts
import { applyEquatorialPointingError, equatorialPointingError, type EquatorialPointingModel, IDENTITY_EQUATORIAL_POINTING_MODEL, polarAlignmentPointingModel } from 'nebulosa/src/astronomy/coordinates/pointing'
import { arcsec, deg, hour, toArcsec, toDeg, toHour } from 'nebulosa/src/math/units/angle'

const model: EquatorialPointingModel = {
	...IDENTITY_EQUATORIAL_POINTING_MODEL,
	indexHourAngle: arcsec(30), // IH
	indexDeclination: arcsec(-45), // ID
	coneError: arcsec(120), // CH
	axisNonPerpendicularity: arcsec(90), // NP
	polarAzimuthError: arcsec(60), // MA
	polarAltitudeError: arcsec(-60), // ME
}

// Error at hour angle 3 h, declination +45° (radians in, radians out).
const [deltaHourAngle, deltaDeclination] = equatorialPointingError(hour(3), deg(45), model)

console.log(toArcsec(deltaHourAngle)) // 204.85 — arcseconds in hour angle
console.log(toArcsec(deltaDeclination)) // -45 — arcseconds in declination

// Where the optical axis actually points when the mount reads RA 10 h, Dec +45° at LST 13 h.
const [ra, dec] = applyEquatorialPointingError(hour(10), deg(45), hour(13), model)

console.log(toHour(ra), toDeg(dec)) // 9.9962 44.9875 — hours, degrees

// A mount with a polar axis 120" off in azimuth and 300" too low, at latitude +40°.
const polar = polarAlignmentPointingModel(arcsec(120), arcsec(-300), deg(40))

console.log(toArcsec(polar.polarAzimuthError)) // 91.93 — MA = azimuth · cos(latitude)
console.log(toArcsec(polar.polarAltitudeError)) // 300 — ME = -altitude
console.log(toArcsec(polar.indexHourAngle)) // 77.13 — azimuth · sin(latitude)
```

### Equinoxes and Solstices

The astronomical seasons begin at the two equinoxes and two solstices, the instants when the Sun's apparent ecliptic longitude is 0°, 90°, 180°, and 270°. Here `spring`, `summer`, `autumn`, and `winter` name the starts of the northern-hemisphere seasons: the March equinox, June solstice, September equinox, and December solstice.

`season` uses Meeus' method and is valid for years 1000 to 3000. The instant comes back in dynamical time: the returned `Time` is tagged TT, so convert it with `utc` for a civil clock time, which moves it earlier by Delta T (about a minute in the 2020s).

```ts
import { season } from 'nebulosa/src/astronomy/bodies/sun'
import { timeToDate, utc } from 'nebulosa/src/astronomy/time/time'

// year: calendar year. name: 'spring' | 'summer' | 'autumn' | 'winter'.
const june = season(2026, 'summer')

console.log(june.scale) // 3 — Timescale.TT, not UTC
console.log(timeToDate(utc(june)).slice(0, 6)) // [2026, 6, 21, 8, 24, 55] — civil UTC
console.log(timeToDate(utc(season(2026, 'spring'))).slice(0, 6)) // [2026, 3, 20, 14, 45, 35]
console.log(timeToDate(utc(season(2026, 'autumn'))).slice(0, 6)) // [2026, 9, 23, 0, 5, 30]
console.log(timeToDate(utc(season(2026, 'winter'))).slice(0, 6)) // [2026, 12, 21, 20, 50, 13]
```

### ERFA / SOFA Algorithms

`src/astronomy/coordinates/erfa/erfa.ts` is a TypeScript port of the ERFA (Essential Routines for Fundamental Astronomy) library, derived from the IAU SOFA routines, with the `era` prefix of the C names kept: `eraAtco13`, `eraC2t06a`, `eraNut06a`, and so on. The two companion files add `eraEpv00` (Earth position and velocity, `erfa/earth.ts`) and `eraMoon98` (geocentric Moon, `erfa/moon.ts`). The port follows the conventions of the original: the date is a two-part Julian Day `(date1, date2)` whose sum is the date, split to keep the precision (`2400000.5` plus an MJD, or `2451545` plus an offset), angles are radians, distances AU, velocities AU/day (unless the parameter is typed `Velocity`, which is in the unit of the library) and rotation matrices are row-major `Mat3` in the sense of the C code. Functions that return several values return a tuple, and many accept an optional output (`out`, `o`, `astrom`) that is filled and returned to avoid allocations. A routine whose C version returns a status code returns it as the first element (`eraTpxes`, `eraTpors`) or `false` (`eraPvstar`); the tests of the library reproduce the t_erfa_c reference values.

The naming follows ERFA, so the routines come in families: `Tt`, `Tai`, `Utc`, `Ut1`, `Tdb` and `Tcb` for the time scales, `Nut`, `Pn`, `Pnm`, `Pr`, `Prec`, `Bp`, `Pfw` and `Fw` for precession, bias and nutation (IAU 1976/1980, 2000A/B and 2006), `Gst`, `Gmst`, `Era` and `Ee` for the sidereal times, `Xy`, `Xys` and `S` for the CIO locator, `C2i`, `C2t`, `C2ixy` and `C2tcio` for the celestial-to-terrestrial matrices, `Ap`, `At` for the star-independent and the astrometric transformations, `Fk`, `H`, `Icrs` and `G` for the reference frames, `Tp` for the tangent plane, `Ltp` and `Lte` for the long-term precession, `Fa` for the fundamental arguments, and `Pv`, `Star` and `Pm` for the position/velocity and proper motion. The astrometric functions work on an `EraAstrom` record of the star-independent parameters, which `eraApco13`, `eraApci13` and the other `eraAp*` routines build and `eraAtciq`, `eraAtioq` and the other `eraAt*` routines consume. The chain of the observer functions is ICRS (`rc`, `dc`) to CIRS (`ri`, `di`) to observed (`aob`, `zob`, `hob`, `dob`, `rob`), with refraction when the pressure is positive.

Each snippet below shows one call per distinct pattern, with the reference values used by the tests of the library and the output observed when running it; the long list that follows names the other routines of each family and what they return.

```ts
import {
	eraAe2hd,
	eraAnpm,
	eraApco13,
	eraAtciq,
	eraAtco13,
	eraAtoc13,
	eraBp06,
	eraC2i06a,
	eraC2s,
	eraC2t06a,
	eraCalToJd,
	eraDat,
	eraEe00a,
	eraEpj,
	eraEra00,
	eraFal03,
	eraGmst06,
	eraGst06a,
	eraHd2ae,
	eraHd2pa,
	eraJdToCal,
	eraNut06a,
	eraObl06,
	eraP2s,
	eraPfw06,
	eraPom00,
	eraRefco,
	eraS06,
	eraS2c,
	eraTaiTt,
	eraTtTdb,
	eraUtcTai,
	eraUtcUt1,
	eraXys06a,
} from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { arcsec, deg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// Angles and vectors: normalize to [-π, π), Cartesian to spherical and back, and position to spherical with the radius.
console.log(eraAnpm(deg(190))) // -2.96705972839036 (-170°)
console.log(eraC2s(1, 1, 1)) // [ 0.7853981633974483, 0.6154797086703873 ]
console.log(eraS2c(1, 0.5)) // [ 0.4741598817790379, 0.7384602626041288, 0.479425538604203 ]
console.log(eraP2s(1, 2, 3)) // [ 1.1071487177940904, 0.9302740141154721, 3.7416573867739413 ] — longitude, latitude, radius

// Calendars: the MJD of 2008-02-29, the calendar date of an MJD (year, month, day, fraction), and TAI-UTC on 2017-01-01 in seconds.
console.log(eraCalToJd(2008, 2, 29)) // 54525
console.log(eraJdToCal(2400000.5, 54000.25)) // [ 2006, 9, 22, 0.25 ]
console.log(eraDat(2017, 1, 1, 0.5)) // 37

// Time scales: UTC 2456384.5 + 0.969254051 days to TAI, TT and UT1 with DUT1 = 0.1550675 s; each result is a [part1, part2] pair.
const utc1 = 2456384.5
const utc2 = 0.969254051
const tai = eraUtcTai(utc1, utc2).slice()
const tt = eraTaiTt(tai[0], tai[1]).slice()
const ut1 = eraUtcUt1(utc1, utc2, 0.1550675).slice()
console.log(tai, tt, ut1) // [ 2456384.5, 0.9696591435925925 ] [ 2456384.5, 0.9700316435925925 ] [ 2456384.5, 0.9692558457627314 ]
console.log(eraTtTdb(tt[0], tt[1], -0.001342).slice()) // [ 2456384.5, 0.9700316280601852 ] — TDB − TT given in seconds
console.log(eraEpj(2451545, 0)) // 2000 — the Julian epoch

// Earth rotation and sidereal times (radians): ERA, GMST 2006, GAST 2006/2000A and the equation of the equinoxes.
console.log(eraEra00(ut1[0], ut1[1]), eraGmst06(ut1[0], ut1[1], tt[0], tt[1])) // 3.1454097152192517 3.14837320809816
console.log(eraGst06a(ut1[0], ut1[1], tt[0], tt[1]), eraEe00a(tt[0], tt[1])) // 3.148430263574054 0.00005705546414680882

// Nutation (Δψ, Δε), the mean obliquity and a fundamental argument (the mean anomaly of the Moon) at the same TT.
console.log(eraNut06a(tt[0], tt[1])) // [ 0.0000621963812079798, -0.000027249381174917327 ]
console.log(eraObl06(tt[0], tt[1])) // 0.40906250804962774
console.log(eraFal03(0.8)) // 5.132369751109105
console.log(eraPfw06(tt[0], tt[1])) // [ 6.5678e-6, 0.40906256, 0.00323715, 0.40906251 ] — γ̄, φ̄, ψ̄, ε_A (Fukushima-Williams angles)

// Bias-precession: the frame bias, the precession and the bias-precession matrices (row-major 3×3 each).
const [bias, precession, biasPrecession] = eraBp06(tt[0], tt[1])
console.log(biasPrecession[0], biasPrecession[1], biasPrecession[2]) // 0.9999947799282427 -0.0029634906149046173 -0.0012875712178174882

// The CIP coordinates and the CIO locator, and the celestial-to-intermediate matrix.
console.log(eraXys06a(tt[0], tt[1])) // [ 0.0013122272008502932, -0.000029280862309744027, 3.0574946809250636e-8 ] — X, Y, s
console.log(eraS06(tt[0], tt[1], 0.0006, 0.0001)) // -1.863662518434849e-8
console.log(eraC2i06a(tt[0], tt[1])[0], eraC2i06a(tt[0], tt[1])[8]) // 0.9999991390295148 0.9999991386008312

// The celestial-to-terrestrial matrix with polar motion xp, yp and the locator s'.
const xp = 2.47230737e-7
const yp = 1.82640464e-6
const sp = -3.01974337e-11
console.log(eraPom00(xp, yp, sp)[0], eraC2t06a(tt[0], tt[1], ut1[0], ut1[1], xp, yp, sp)[0]) // 0.9999999999999695 -0.9999918539305882 — the first elements of the polar-motion and of the celestial-to-terrestrial matrices

// Refraction constants A and B (radians) for 731 hPa, 12.8 °C, 59 % humidity and 0.55 µm.
console.log(eraRefco(731, 12.8, 0.59, 0.55)) // [ 0.0002014187785940397, -2.3614083149436963e-7 ]

// Astrometry: the ICRS position of a star to observed place at an observatory, with the barycentric and heliocentric Earth.
const pb = [-0.974170437669016342, -0.211520082035387968, -0.091758302425478583] as const
const vb = [0.003643658242375083, -0.015428731944935825, -0.006689220237864495] as const
const ph = [-0.973458265012157486, -0.209215306558769298, -0.090699647709202746] as const
const site = [-0.527800806, -1.2345856, meter(2738), xp, yp, sp, 731, 12.8, 0.59, 0.55] as const // longitude, latitude, height, xp, yp, sp, pressure, temperature, humidity, wavelength
const [aob, zob, hob, rob, dob, astrom] = eraAtco13(tt[0], tt[1], ut1[0], ut1[1], 2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), ...site, [pb, vb], ph)
console.log(aob, zob, hob) // 0.09251774485486736 1.4076614052564997 -0.09265154431530948 — azimuth, zenith distance, hour angle
console.log(rob, dob, astrom.eo) // 2.710260453504961 0.17166265600725286 -0.0030205483548024123 — observed RA, Dec and the equation of the origins

// The inverse: from observed azimuth/zenith distance ('A') to ICRS, and the two stages separately.
console.log(eraAtoc13('A', aob, zob, tt[0], tt[1], ut1[0], ut1[1], ...site, [pb, vb], ph).slice(0, 2)) // [ 2.710132222988453, 0.17406641381551874 ]
const params = eraApco13(tt[0], tt[1], ut1[0], ut1[1], ...site, [pb, vb], ph)
console.log(eraAtciq(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), params)) // [ 2.7102974865123404, 0.17283379216905348 ] — CIRS

// Horizontal and equatorial: hour angle/declination from azimuth/elevation and back, and the parallactic angle.
console.log(eraAe2hd(5.5, 1.1, 0.7), eraHd2ae(1.1, 1.2, 0.3)) // [ 0.5933291115507308, 0.9613934761647818 ] [ 5.916889243730066, 0.4472186304990486 ]
console.log(eraHd2pa(1.1, 1.2, 0.3)) // 1.9062274280019955
```

The frames, the proper motion, the geodetic and the tangent-plane routines follow the same pattern.

```ts
import { eraFk425, eraG2icrs, eraGc2Gde, eraGd2Gce, eraIcrs2g, eraLtp, eraNut80, eraObl80, eraPlan94, eraPr00, eraPrec76, eraPvstar, eraSepp, eraSeps, eraStarpm, eraStarpv, eraTpsts, eraTpxes } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { eraEpv00 } from 'nebulosa/src/astronomy/coordinates/erfa/earth'
import { eraMoon98 } from 'nebulosa/src/astronomy/coordinates/erfa/moon'

// Geodetic and geocentric coordinates (radius 6378136.6 m, flattening 1/298.25642): [x, y, z] in meters and [longitude, latitude, height].
console.log(eraGd2Gce(6378136.6, 1 / 298.25642, 3, -0.5, 1000)) // [ -5546462.988430975, 790629.1252902636, -3040190.092955975 ]
console.log(eraGc2Gde(6378136.6, 1 / 298.25642, 2e6, 3e6, 5.244e6)) // [ 0.982793723247329, 0.971601856417379, 331.8555791663812 ]

// Frames: FK4 B1950 to FK5 J2000 (position, proper motion, parallax, radial velocity), and ICRS to Galactic and back.
console.log(eraFk425(0.1, 0.2, 1e-6, 2e-6, 0.1, 10)) // [ 0.11128743449126417, 0.20483107183314778, 5.1259e-9, -9.7198e-9, 5.4752e-6, 10.000213636167985 ]
console.log(eraIcrs2g(0, 0), eraG2icrs(0, 0)) // [ 1.6814025947831113, -1.0504884265315022 ] [ 4.64964430303663, -0.5050315085342666 ]

// Separations: from spherical coordinates, and from two vectors.
console.log(eraSeps(1, 0.5, 2, 0.4), eraSepp([1, 0, 0], [0, 1, 0])) // 0.8976778790449081 1.5707963267948966

// Star: position/velocity vector in AU and AU/day, and back; then the proper motion to another epoch.
const pv = eraStarpv(0.01, 0.02, 1e-6, 2e-6, 0.05, 10)
console.log(pv[0], pv[1]) // [ 19.995000341656528, 0.19995666868328996, 0.3999733338666616 ] [ 10.285693775251145, 0.10286042445623095, 0.2057517119612684 ] — the vectors keep the units of the function
console.log(eraPvstar(pv[0], pv[1])) // [ 0.01, 0.02, 1.0000e-6, 2.0000e-6, 0.05, 9.999999999999998 ]
console.log(eraStarpm(0.01, 0.02, 1e-6, 2e-6, 0.05, 10, 2451545, 0, 2460000, 0)) // [ 0.010000005637155604, 0.020000011274311204, ... ]

// Planets and the Moon: heliocentric Mercury (index 0), the Earth (barycentric and heliocentric) and the geocentric Moon.
console.log(eraPlan94(2400000.5, 43999.9, 0)[0]) // [ 0.2945293959257472, -0.2452204176600993, -0.1615427700571952 ]
console.log(eraEpv00(2400000.5, 53411.52501161)[0][0]) // [ -0.7714104440491069, 0.5598412061824241, 0.24259962777224825 ]
console.log(eraMoon98(2400000.5, 54282.5)[0]) // [ 0.0008944441964973188, -0.002147741375955652, -0.0011168576496977227 ]

// Long-term precession matrix, precession angles and nutation of the 1976/1980 model, the mean obliquity and the tangent plane.
console.log(eraLtp(1000)[0], eraPr00(2460000, 0)) // 0.9705557534220458 [ -0.00033628890273744413, -0.000000028326153529427962 ]
console.log(eraPrec76(2451545, 0, 2460000, 0)) // [ 0.0025882842609029747, 0.0025884902343692377, 0.002249269302520354 ]
console.log(eraNut80(2451545, 0), eraObl80(2451545, 0)) // [ -0.00006750247617532478, -0.000027992212383770132 ] 0.40909280422232897
console.log(eraTpxes(1.2, 0.5, 1.0, 0.4)) // [ 0, 0.17810827845499125, 0.10894523228859818 ] — status, ξ, η
console.log(eraTpsts(0.1, 0.1, 1, 0.4)) // [ 1.1128814592161678, 0.49698817476678764 ]
```

The remaining routines, by family:

- Time scales: `eraTcbTdb`, `eraTcgTt`, `eraTdbTcb`, `eraTtTcg`, `eraTtUt1`, `eraTaiUt1`, `eraUt1Tai`, `eraUt1Tt`, `eraTtTai`, `eraTdbTt`, `eraTaiUtc`, `eraUtcTai`, `eraUt1Utc`, `eraDtDb` (TDB − TT in seconds), `eraEpb`, `eraEpb2jd` and `eraEpj2jd`; all take a two-part date and return a new two-part date.
- Sidereal time and Earth rotation: `eraGmst82`, `eraGmst00`, `eraGst94`, `eraGst00a`, `eraGst00b`, `eraGst06`, `eraEqeq94`, `eraEect00`, `eraEe00`, `eraEe00b`, `eraEe06a`, `eraEo06a`, `eraEors`, `eraSp00`, `eraPom00` and `eraC2teqx`.
- CIO locator and the X, Y of the CIP: `eraS00`, `eraS00a`, `eraS00b`, `eraS06a`, `eraXys00a`, `eraXys00b`, `eraXy06`, `eraBpn2xy`, `eraFw2xy`.
- Precession, nutation and obliquity: `eraPr00`, `eraPrec76`, `eraPmat76`, `eraPmat00`, `eraPmat06`, `eraPnm80`, `eraPnm00a`, `eraPnm00b`, `eraPnm06a`, `eraPn00`, `eraPn00a`, `eraPn00b`, `eraPn06`, `eraPn06a`, `eraP06e`, `eraBp00`, `eraBi00`, `eraPb06`, `eraFw2m`, `eraNut80`, `eraNutm80`, `eraNumat`, `eraNum00a`, `eraNum00b`, `eraNum06a`, `eraNut00a`, `eraNut00b`, `eraNut06a`, `eraObl80`, `eraObl06`.
- Fundamental arguments: `eraFal03`, `eraFalp03`, `eraFad03`, `eraFaf03`, `eraFaom03`, `eraFapa03`, `eraFame03`, `eraFave03`, `eraFae03`, `eraFama03`, `eraFaju03`, `eraFasa03`, `eraFaur03`, `eraFane03`, each of the Julian centuries `t` since J2000.
- Celestial to terrestrial: `eraC2t06a`, `eraC2t00a`, `eraC2t00b`, `eraC2txy`, `eraC2tpe`, `eraC2i06a`, `eraC2i00a`, `eraC2i00b`, `eraC2ixys`, `eraC2ixy`, `eraC2ibpn` and `eraC2tcio`.
- Ecliptic and long-term precession: `eraEqec06`, `eraEceq06`, `eraEcm06`, `eraLtpecl`, `eraLtpequ`, `eraLtp`, `eraLtpb`, `eraLtecm`, `eraLteqec`, `eraLteceq`.
- Reference frames: `eraFk425`, `eraFk45z`, `eraFk524`, `eraFk54z`, `eraFk5hz`, `eraFk52h`, `eraH2fk5`, `eraHfk5z`, `eraIcrs2g`, `eraG2icrs`.
- Stars, vectors and apparent place: `eraStarpv`, `eraS2pv`, `eraStarpmpv`, `eraStarpm`, `eraPvstar`, `eraPv2s`, `eraPpsp`, `eraSeps`, `eraSepp`, `eraPmpx` (proper motion and parallax to a position), `eraAb` (stellar aberration), `eraLdn`, `eraLd` and `eraLdSun` (light deflection).
- Astrometry parameters: `eraApci13`, `eraApci`, `eraApcg`, `eraApcs`, `eraApco`, `eraApco13`, `eraApio13`, `eraApio`, `eraPvtob`, `eraRefco`; transformations `eraAtccq`, `eraAtciq`, `eraAtciqz`, `eraAtciqn`, `eraAtioq`, `eraAtoiq`, `eraAticq`, `eraAticqn`, `eraAtci13`, `eraAtco13`, `eraAtoc13`, `eraAtio13`, `eraAtoi13`, `eraAtic13` and `eraAtcc13`.
- Horizontal and tangent plane: `eraAe2hd`, `eraHd2ae`, `eraHd2pa`, `eraTpsts`, `eraTpstv`, `eraTpors`, `eraTporv`, `eraTpxes`, `eraTpxev`; the geodetic routines `eraGc2Gde`, `eraGd2Gce` take the ellipsoid radius and flattening as arguments.
- Planets and Moon: `eraPlan94` (`np` from 0 for Mercury to 7 for Neptune, with the Earth–Moon barycentre as 2; an index outside 0 to 7 throws a TypeError), `eraEpv00` and `eraMoon98`.

### FK5 Precession and ICRS Frame Bias

FK5 is the J2000 mean-equator-and-equinox catalog frame. ICRS differs from it by a small constant frame bias of a few tens of milliarcseconds, and FK5 positions at another equinox differ by precession. Both are rotations, so they preserve the length of a vector.

`fk5(ra, dec, distance?)` builds an FK5 Cartesian vector from spherical coordinates (radians; distance in AU, defaulting to 1 kpc when only the direction matters), and `icrs(ra, dec, distance?)` does the same for ICRS. `precessFk5(p, from, to, o?)` rotates an FK5 vector from the equinox `from` to the equinox `to` with the IAU 2006 precession (Capitaine), and `precessFk5FromJ2000` and `precessFk5ToJ2000` are the J2000 shortcuts. The equinox arguments are `Time` instants interpreted in TT. The optional `o` receives the result and is returned. `icrsToFk5` and `fk5ToIcrs` apply only the constant bias, so precess to J2000 first when the FK5 position is at another equinox. `fk5Frame(equinox)` returns the FK5 equinox-of-date `Frame` relative to ICRS for use with the frame functions; it includes the bias as well as the precession, so it differs slightly from `precessFk5FromJ2000` alone.

```ts
import { fk5, precessFk5FromJ2000, precessFk5ToJ2000 } from 'nebulosa/src/astronomy/coordinates/fk5'
import { fk5ToIcrs, icrsToFk5 } from 'nebulosa/src/astronomy/coordinates/frame'
import { icrs } from 'nebulosa/src/astronomy/coordinates/icrs'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecAngle } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, toArcsec } from 'nebulosa/src/math/units/angle'

// RA 10.625°, Dec +41.2° at distance 1 (AU here; any length unit works for a unit vector).
const position = fk5(deg(10.625), deg(41.2), 1)

console.log(position) // [0.73951, 0.13873, 0.65869] — FK5 J2000 Cartesian

// Equinox of 1975.0 (TT).
const equinox = timeYMDHMS(1975, 1, 1, 12, 0, 0, Timescale.TT)

console.log(precessFk5FromJ2000(position, equinox)) // [0.74188, 0.13459, 0.65689] — mean place at the 1975 equinox
console.log(precessFk5ToJ2000(position, equinox)) // [0.73713, 0.14286, 0.66048] — treating the input as a 1975 place

// The frame bias moves the direction by a few tens of milliarcseconds, at most.
const direction = icrs(deg(10.625), deg(41.2), 1)

console.log(toArcsec(vecAngle(direction, icrsToFk5(direction)))) // 0.0317 — arcseconds for this direction
console.log(toArcsec(vecAngle(position, fk5ToIcrs(position)))) // 0.0317 — arcseconds, the inverse rotation
```

### Galactocentric Frame

The Galactocentric frame is Cartesian with its origin at the Galactic center, x pointing from the Sun toward the center (so the Sun sits near x = −8.1 kpc), and z toward the north Galactic pole. The Sun is slightly above the Galactic midplane, which the frame accounts for by tilting about y by `asin(zSun / distance)`. The construction mirrors Astropy: rotate ICRS so x points at the center, apply an optional roll about that line, then the Sun-height tilt.

`galactocentricFrame(params?)` returns an `AffineFrame` for use with `affineFromBase`, `affineToBase`, and `affineToAffine` (see Affine Origin Frames). Parameters are `galcen` (ICRS right ascension and declination of the center, radians), `galcenDistance` (Sun to center, AU), `zSun` (Sun height above the midplane, positive toward the north pole, AU), and `roll` (extra roll about the Sun-center line, radians). `GALACTOCENTRIC_DEFAULTS` holds the Astropy "latest" values: center at (266.4051°, −28.936175°), 8.122 kpc, 20.8 pc, roll 0. The frame is constant in time and has no origin velocity, so velocities are rotated but receive no solar-motion offset. It needs absolute positions with a real distance, never normalized directions.

```ts
import { affineFromBase, affineToBase, galactocentricFrame, GALACTOCENTRIC_DEFAULTS } from 'nebulosa/src/astronomy/coordinates/affine'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { ONE_KILOPARSEC } from 'nebulosa/src/core/constants'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC) // the frame does not depend on time

// Astropy defaults. Pass { ...GALACTOCENTRIC_DEFAULTS, galcenDistance: ... } to change one parameter.
const frame = galactocentricFrame()

// ICRS position in AU (here 1, 2, 3 kpc along the ICRS axes) -> Galactocentric Cartesian, AU.
const [x, y, z] = affineFromBase([1 * ONE_KILOPARSEC, 2 * ONE_KILOPARSEC, 3 * ONE_KILOPARSEC], frame, time)

console.log(x / ONE_KILOPARSEC, y / ONE_KILOPARSEC, z / ONE_KILOPARSEC) // -11.3749 1.8454 0.1333 — kpc

// The Sun (the ICRS origin) is 8.122 kpc from the center and 20.8 pc above the midplane.
const [sx, , sz] = affineFromBase([0, 0, 0], frame, time)

console.log(sx / ONE_KILOPARSEC, sz / ONE_KILOPARSEC) // -8.12197 0.0208 — kpc

// Exact inverse: Galactocentric -> ICRS.
console.log(affineToBase([x, y, z], frame, time)) // the original ICRS position, 1, 2, 3 kpc expressed in AU

// A different Sun-center distance, in AU.
const far = galactocentricFrame({ ...GALACTOCENTRIC_DEFAULTS, galcenDistance: 8.2 * ONE_KILOPARSEC })

console.log(affineFromBase([0, 0, 0], far, time)[0] / ONE_KILOPARSEC) // -8.19997 — kpc
```

### Galilean Satellite Theory (L1.2)

L1.2 (Lainey, Vienne, and Duriez) is the IMCCE analytical theory of the four Galilean satellites. For each body, trigonometric series give equinoctial elements (semi-major axis, mean longitude, and the eccentricity and inclination vectors), degree-8 Chebyshev polynomials add the official long-period corrections, and Kepler's equation is solved for the position. The result is rotated into the J2000 equatorial frame.

`io`, `europa`, `ganymede`, and `callisto` take a `Time` (any scale; converted to TT) and return the Jovicentric position in AU and velocity in AU/day, in J2000 equatorial axes. `compute(time, index)` is the shared function behind them, with `index` 0 for Io through 3 for Callisto. The long-period corrections are applied only inside the theory's validity window of about the years 1140 to 2760; outside it they are omitted, matching the official approximate-ephemeris path. The returned vectors alias internal buffers, so copy them before computing another state. Add the result to Jupiter's barycentric state for an inertial position; for the Great Red Spot and the central meridian see Jupiter Central Meridian.

```ts
import { callisto, compute, europa, ganymede, io } from 'nebulosa/src/astronomy/ephemeris/models/analytical/l12'
import { Timescale, time, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

const [position, velocity] = io(instant)

console.log(position) // [-0.0028234, -0.000024337, -0.000055447] — AU, Jovicentric
console.log(velocity) // [0.00020049, -0.0090228, -0.0042977] — AU/day
console.log(toKilometer(Math.hypot(...position))) // 422475 — km, close to Io's orbital radius

console.log(europa(instant)[0]) // [0.0024260, 0.0033655, 0.0016436] — AU
console.log(callisto(instant)[0]) // [-0.010959, -0.0056894, -0.0028438] — AU

// compute(time, index): the same as ganymede(time) for index 2.
console.log(compute(instant, 2)[0]) // [-0.00050927, -0.0064253, -0.0030895] — AU
console.log(ganymede(instant)[0]) // [-0.00050927, -0.0064253, -0.0030895] — AU

// The IMCCE reference epoch, JD 2451545.0 TT (TestL1.2.res).
console.log(io(time(2451545, 0, Timescale.TT))[0]) // [0.0026720, 0.00076440, 0.00040873] — AU
```

### Gauss Angles-Only Orbit Determination

Gauss's method is the classical way to get a first orbit from just three observations of angles. Three right ascensions and declinations, with the observer's position at each time, fix the unknown distances through an eighth-degree polynomial in the middle range. It then reconstructs the three position vectors and recovers the middle velocity with Gibbs or Herrick-Gibbs. The result is a rough state meant to seed a least-squares refinement such as Differential Orbit Correction, not a final orbit.

`gauss(obs1, obs2, obs3, options)` takes three `GaussObservation`s, `{ time, rightAscension, declination, observer }`, with angles in radians in an inertial frame and `observer` the observer's position in the same frame, in the length unit of `options.mu` (AU and `GM_SUN_PITJEVA_2005` for a heliocentric orbit with the observer at the Earth). The times must strictly increase, or a `RangeError` is thrown; a degenerate line-of-sight geometry also throws. Positive roots of the range polynomial are bracketed and refined, the observer-collocated root is rejected, and the surviving candidates are scored by how well their two-body orbit reprojects onto the lines of sight. `options.method` forces `'gibbs'` or `'herrick-gibbs'` for the velocity; by default it is chosen from the arc, and Herrick-Gibbs is used only for short arcs (a span of at most 5 days and 5° on the sky). Other options are `minPositiveRho`, `maxIterations`, and `tolerance`. The result gives the middle `state` (`r`, `v`), the reconstructed `positions` (`r1`, `r2`, `r3`), the topocentric `ranges`, and `diagnostics` (the chosen root, all candidate roots, the angular separations, the velocity method, and a list of `warnings`). Inspect the warnings, for example `MULTIPLE_POSITIVE_ROOTS` or `SMALL_ANGULAR_SEPARATION`, before trusting the state.

```ts
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { gauss, type GaussObservation } from 'nebulosa/src/astronomy/orbits/determination/gauss'
import { Timescale, timeShift, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { DAYSPERJY, GM_SUN_PITJEVA_2005, TAU } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { vecDistance, vecLength } from 'nebulosa/src/math/linear-algebra/vec3'
import { normalizeAngle } from 'nebulosa/src/math/units/angle'

const epoch = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)

// A "true" asteroid orbit to synthesize observations: a = 1.9 AU, e = 0.18, in the observer's inertial axes.
const orbit = KeplerOrbit.trueAnomaly(1.9, 0.18, 0.12, 0.8, 1.1, 0.35, epoch, GM_SUN_PITJEVA_2005, matIdentity())

// A simple observer on a 1 AU circular orbit.
const observerAt = (days: number): [number, number, number] => {
	const angle = (TAU * days) / DAYSPERJY + 0.4
	return [Math.cos(angle), Math.sin(angle), 0.04 * Math.sin(2 * angle)]
}

// Noise-free right ascension and declination of the orbit as seen from the observer.
const observe = (days: number): GaussObservation => {
	const time = timeShift(epoch, days)
	const observer = observerAt(days)
	const [px, py, pz] = orbit.at(time)[0]
	const x = px - observer[0]
	const y = py - observer[1]
	const z = pz - observer[2]

	return { time, rightAscension: normalizeAngle(Math.atan2(y, x)), declination: Math.asin(z / Math.hypot(x, y, z)), observer }
}

// Three observations 4 days apart; mu in AU^3/day^2.
const result = gauss(observe(-4), observe(0), observe(4), { mu: GM_SUN_PITJEVA_2005 })

const truth = orbit.at(epoch)

console.log(result.state.r) // [-1.01276, 1.25652, 0.19315] — AU, heliocentric, at the middle epoch
console.log(result.state.v) // [-0.011825, -0.0085827, 0.00030193] — AU/day
console.log(vecDistance(result.state.r, truth[0])) // 0.000188 — AU from the true position
console.log(vecDistance(result.state.v, truth[1]) / vecLength(truth[1])) // 0.00033 — relative velocity error
console.log(result.ranges.rho2) // 2.1257 — AU, observer-to-target distance
console.log(result.diagnostics.methodForVelocity) // gibbs — chosen from the geometry
console.log(result.diagnostics.warnings) // ['MULTIPLE_POSITIVE_ROOTS']

// Times that do not increase throw.
gauss(observe(0), observe(-4), observe(4), { mu: GM_SUN_PITJEVA_2005 }) // RangeError: gauss requires strictly increasing observation times
```

### GCRS to ITRS Rotation

The geocentric celestial frame (GCRS, ICRS-oriented and non-rotating) and the Earth-fixed ITRS are related by Earth orientation: frame bias, precession, and nutation, then the Earth's rotation by the Greenwich apparent sidereal time, then polar motion. `gcrsToItrsRotationMatrix(time)` returns that single 3×3 matrix, which takes a GCRS vector to ITRS (`v_itrs = R · v_gcrs`) and whose transpose goes back.

It is the same rotation the `ITRS` frame uses (see Celestial and Terrestrial Reference Frames), so prefer the frame functions when you also need velocities. The matrix is cached on the `Time` and shared, so treat it as read-only and copy before changing it. It depends on UT1 and polar motion, which come from the loaded Earth orientation data; without it they are 0 (see Earth Orientation Parameters).

```ts
import { gcrsToItrsRotationMatrix, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { matMulVec, matTransposeMulVec } from 'nebulosa/src/math/linear-algebra/mat3'

// A UT1 instant, so the example does not depend on loaded Earth orientation data.
const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UT1)

const rotation = gcrsToItrsRotationMatrix(time)

console.log(rotation.slice(0, 3)) // [0.11758, -0.99306, -0.00028] — first row, row-major

const gcrs = [1, 0, 0] as const
const itrs = matMulVec(rotation, gcrs)

console.log(itrs) // [0.11758, 0.99306, 0.00259] — the same direction in Earth-fixed axes
console.log(matTransposeMulVec(rotation, itrs)) // [1, 0, 0] — back to GCRS
```

### Geographic Observer

An observer on the Earth is a point on a reference ellipsoid: geodetic latitude (north-positive), longitude (east-positive), and height above the ellipsoid. The library supports GRS80, WGS72, WGS84, and IERS2010 ellipsoids, with IERS2010 as the default. Angles are radians and elevation is in AU, so convert heights with `meter`.

`geodeticLocation(longitude, latitude, elevation, ellipsoid?)` builds a `GeographicPosition` from geodetic coordinates, and `geocentricLocation(x, y, z, ellipsoid?)` from an Earth-centered Cartesian (ITRS) position in AU. Note the argument order: longitude comes before latitude. The returned object caches derived geometry on itself, so reuse one instance per site. `localSiderealTime(time, location?, mean?, tio?)` is the sidereal time at the site: apparent by default (`mean = true` gives mean), using the observer's longitude from a location or from a plain angle, and `location` defaults to `time.location`. `tio: true` also applies polar motion and the TIO locator, and `'sp'` applies only the TIO locator; the default applies neither. `polarRadius(ellipsoid)` is the ellipsoid's polar semi-axis, and `rhoCosPhi` and `rhoSinPhi` are the geocentric parallax terms `ρ·cos φ′` and `ρ·sin φ′` (in Earth equatorial radii) used for topocentric parallax. UT1, hence sidereal time, uses the loaded Earth orientation data; see Earth Orientation Parameters.

```ts
import { Ellipsoid, geocentricLocation, geodeticLocation, localSiderealTime, polarRadius, rhoCosPhi, rhoSinPhi } from 'nebulosa/src/astronomy/observer/location'
import { itrs } from 'nebulosa/src/astronomy/coordinates/itrs'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg, toHour } from 'nebulosa/src/math/units/angle'
import { meter, toKilometer, toMeter } from 'nebulosa/src/math/units/distance'

// longitude, latitude, elevation (all radians and AU). La Silla Observatory.
const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))

// The same site from ITRS Cartesian coordinates, in AU.
const xyz = itrs(site)
const fromXyz = geocentricLocation(xyz[0], xyz[1], xyz[2])

console.log(toDeg(fromXyz.longitude), toDeg(fromXyz.latitude), toMeter(fromXyz.elevation)) // -70.7313 -29.2563 2400 — degrees, meters

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

console.log(toHour(localSiderealTime(time, site))) // 17.7685 — hours, apparent
console.log(toHour(localSiderealTime(time, site.longitude, true))) // 17.7683 — hours, mean, from a plain longitude
console.log(toHour(localSiderealTime({ ...time, location: site }))) // 17.7685 — hours, location taken from time.location

// Parallax terms and polar radius.
const ellipsoid = Ellipsoid.WGS84
const mid = geodeticLocation(deg(10), deg(45), 0, ellipsoid)

console.log(rhoCosPhi(mid), rhoSinPhi(mid)) // 0.70829 0.70355 — Earth radii
console.log(toKilometer(polarRadius(ellipsoid))) // 6356.752 — km
```

### Geographic Sub-point

The sub-point of a celestial position is the point on the Earth's surface directly beneath it: the geodetic longitude and latitude where the local vertical through the position meets the ellipsoid, plus the height above the ellipsoid. It is how you place a satellite, the Moon, or any geocentric vector on a map.

`subpoint(geocentric, time, ellipsoid?)` takes a geocentric position in GCRS/ICRS-oriented axes (AU), rotates it into ITRS at `time` with the full Earth orientation, and converts it to geodetic coordinates on the ellipsoid (IERS2010 by default). The result is a `GeographicPosition` with longitude wrapped to `(−π, π]` (east-positive), latitude, `elevation` in AU above the ellipsoid, and the ITRS vector cached as `itrs`. Earth rotation, so UT1, comes from the loaded Earth orientation data (see Earth Orientation Parameters). For satellites tracked with SGP4 see Satellite Sub-point; for sub-points on other bodies see Sub-Observer and Sub-Solar Points.

```ts
import { subpoint } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

// Geocentric position in AU, GCRS axes (about 10 600 km above the surface).
const point = subpoint([1e-4, 2e-5, 5e-5], time)

console.log(toDeg(point.longitude)) // 34.41 — degrees east
console.log(toDeg(point.latitude)) // 26.32 — degrees north
console.log(toKilometer(point.elevation)) // 10617 — km above the ellipsoid
```

### Gibbs Orbit Determination

The Gibbs method finds the velocity of a body at the middle of three position vectors, assuming two-body motion and no time information: the three position vectors, which must lie in one plane, determine the orbit's plane, shape, and the velocity at the middle point. It is the classical choice when the points are widely separated in angle, and it needs positions relative to the central body, not raw right ascension and declination (for those use Gauss Angles-Only Orbit Determination, and for closely spaced points with known times use Herrick-Gibbs Orbit Determination).

`gibbs(r1, r2, r3, mu, options?)` takes three position vectors and the gravitational parameter in consistent units (AU and AU³/day² give AU/day). It returns `{ r, v, diagnostics }`: `r` is a copy of `r2`, `v` the middle velocity, and `diagnostics` holds the coplanarity error, the angles between the positions, the norms of the positions and auxiliary vectors, a `reliability` of `'good'`, `'warning'`, or `'bad'`, and a list of `warnings`. The default thresholds flag positions closer than 1° or farther apart than 60° and poor coplanarity. A rejected solution throws a `RangeError`, unless `options.allowUnreliable` is true, in which case it returns a `'bad'` result with a `NaN` velocity. Other options are `coplanarityTolerance`, `minAngularSeparation`, `maxAngularSeparation` (radians), `degeneracyTolerance`, and `minPositionNorm`.

```ts
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { gibbs } from 'nebulosa/src/astronomy/orbits/determination/gibbs'
import { Timescale, timeShift, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const epoch = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
const orbit = KeplerOrbit.trueAnomaly(1.9, 0.18, 0.12, 0.8, 1.1, 0.35, epoch, GM_SUN_PITJEVA_2005, matIdentity())

// Heliocentric positions 15 days before, at, and 15 days after the epoch.
const r1 = orbit.at(timeShift(epoch, -15))[0]
const r2 = orbit.at(epoch)[0]
const r3 = orbit.at(timeShift(epoch, 15))[0]

const { r, v, diagnostics } = gibbs(r1, r2, r3, GM_SUN_PITJEVA_2005)

console.log(r) // [-1.01258, 1.25644, 0.19314] — AU, the middle position
console.log(v) // [-0.011823, -0.0085783, 0.00030201] — AU/day, equal to the true velocity to about 1e-14 relative
console.log(diagnostics.reliability) // good
console.log(toDeg(diagnostics.angle12)) // 7.76 — degrees between the first two positions
console.log(diagnostics.warnings) // []

// Duplicate positions are degenerate: this returns a bad result instead of throwing.
console.log(gibbs(r1, r1, r3, GM_SUN_PITJEVA_2005, { allowUnreliable: true }).v) // [NaN, NaN, NaN]

gibbs(r1, r1, r3, GM_SUN_PITJEVA_2005) // RangeError: gibbs input is invalid: ANGULAR_SEPARATION_TOO_SMALL, ...
```

### Great Red Spot Transits

The Great Red Spot is a long-lived storm at a drifting System II longitude. It is best seen when it crosses Jupiter's central meridian, which happens once per System II rotation, about every 9 h 56 m. Its position is an observed quantity, so you give the current System II longitude, from an observer bulletin such as ALPO or JUPOS. It drifts by under a degree per month, so one value is adequate for a prediction window of a few weeks.

`greatRedSpotTransits(grsLongitude, jupiterToObserverAt, start, stop, options?)` returns the transit instants in the window as `Time`s in chronological order. `grsLongitude` is the System II longitude, positive west, in radians. `jupiterToObserverAt` returns the Jupiter-to-observer vector (AU, ICRF) at a time, as for `jupiterCentralMeridian` (see Jupiter Central Meridian). A transit is where the System II central meridian equals the spot's longitude with the spot on the near side; the anti-transits half a rotation later are discarded. `options.step` and `options.tolerance` are in days; the step must stay well under half a rotation, and its default of one hour is ample. The times keep the scale of `start`.

```ts
import { earth, jupiter } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { greatRedSpotTransits } from 'nebulosa/src/astronomy/events/jupiter'
import { type Time, Timescale, timeSubtract, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg } from 'nebulosa/src/math/units/angle'

const jupiterToEarth = (time: Time) => vecMinus(earth(time)[0], jupiter(time)[0])

const start = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
const stop = timeYMDHMS(2026, 7, 1, 0, 0, 0, Timescale.UTC)

// A spot at System II longitude 50° (west-positive).
for (const time of greatRedSpotTransits(deg(50), jupiterToEarth, start, stop)) console.log(timeToDate(time).slice(0, 6), timeSubtract(time, start) * 24)
// [2026, 6, 29, 2, 15, 15] 2.2543 — hours after the start, UTC
// [2026, 6, 29, 12, 11, 6] 12.1850
// [2026, 6, 29, 22, 6, 56] 22.1158
// [2026, 6, 30, 8, 2, 47] 32.0465
// [2026, 6, 30, 17, 58, 38] 41.9773 — five transits in 48 hours, about 9.93 hours apart
```

### Greatest Solar Eclipse Circumstances

The greatest eclipse and the point of greatest duration are the two places of the Earth that the usual eclipse tables list: the point where the shadow axis passes closest to the Earth's center, and the point on the central line where totality or annularity lasts longest. They are generally not the same place. Both functions take the `PolynomialBesselianElements` of Solar Eclipse Besselian Elements and return a `SolarEclipseExtremeCircumstances`, which describes the Sun at that point: the `longitude` (east-positive, in `[−π, π]`) and the geodetic `latitude`, in radians, the TT `time`, `deltaT` (TT − UT1, seconds), the geometric `sunAltitude` and the `sunAzimuth` (from north through east, in `[0, 2π)`), in radians, and, only for a point on the central line, `pathWidthKm`, `centralDuration` (seconds) and `kind` (`'total'` or `'annular'`).

`computeGreatestEclipseCircumstances(pbe)` is the greatest eclipse. For a central eclipse it is the central point at that instant; for a partial or non-central one it is the limb point nearest the axis, and `pathWidthKm`, `centralDuration` and `kind` are `undefined`. It returns `undefined` only when the point cannot be projected. `computeGreatestDurationCircumstances(pbe)` scans the central line over the contact window (128 samples, refined with a Brent minimization) and returns `undefined` for an eclipse without a central line.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeGreatestDurationCircumstances, computeGreatestEclipseCircumstances } from 'nebulosa/src/astronomy/events/eclipse/solar/local'
import { computePolynomialBesselianElements } from 'nebulosa/src/astronomy/events/eclipse/solar/map'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

// The total solar eclipse of 8 April 2024.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)
const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)

const greatest = computeGreatestEclipseCircumstances(pbe)!
console.log(toDeg(greatest.longitude), toDeg(greatest.latitude)) // -104.05 25.40
console.log(timeToDate(utc(greatest.time)).slice(0, 6).join('-'), greatest.deltaT) // 2024-4-8-18-17-46 74.03057366821392
console.log(toDeg(greatest.sunAltitude), toDeg(greatest.sunAzimuth)) // 69.78 150.02
console.log(greatest.pathWidthKm, greatest.centralDuration, greatest.kind) // 187.87109375 269.8845148086548 total

// The greatest duration is on the central line too, but about 0.5° to the north-east.
const longest = computeGreatestDurationCircumstances(pbe)!
console.log(toDeg(longest.longitude), toDeg(longest.latitude)) // -103.53 25.94
console.log(timeToDate(utc(longest.time)).slice(0, 6).join('-')) // 2024-4-8-18-19-39
console.log(longest.pathWidthKm, longest.centralDuration, longest.kind) // 187.78076171875 269.9222132563591 total
```

### HEALPix Object Index

A HEALPix index is an in-memory spatial index: objects with sky positions are bucketed by the HEALPix pixel that contains them, so a region query only examines the few buckets that the region touches instead of every object. It is the structure behind fast cone, box, and polygon searches on a large list of stars or targets (see HEALPix Pixelization and Covers for the pixel scheme itself). It also implements the star-catalog query interface used by the catalog modules.

`new HealpixIndex<M>({ nside, ordering? })` creates an empty index; `nside` is a power of two from 1 to 2²⁴ (a higher value gives smaller pixels and fewer objects per bucket), and `ordering` is `'nested'` (the default) or `'ring'`. `index.add(id, rightAscension, declination, metadata?)` inserts an object, or moves and updates it when the `id` (a number, string, or bigint) already exists; `addMany(objects)` validates the whole batch first and inserts `{ id, rightAscension, declination, metadata? }` records. `get(id)`, `update(id, ra, dec, metadata?)` (undefined for an unknown id), `remove(id)` (a boolean), `clear()`, and `size` manage the contents. Right ascension and declination are in radians, and right ascension is wrapped to `[0, 2π)`. Entries are objects with `id`, `rightAscension`, `declination`, `metadata`, and cached `pixel` and unit `vector`. The queries `queryCone(ra, dec, radius)`, `queryBox(minRA, maxRA, minDEC, maxDEC)`, `queryTriangle(a, b, c)`, and `queryPolygon(vertices)` return arrays of the matching entries, where vertices are `[rightAscension, declination]` pairs and a polygon must be convex; a box whose right ascension range wraps through 0 is split automatically. `queryRegion(query)` and `streamRegion(query)` take a catalog query object (`kind` of `'cone'`, `'triangle'`, `'box'`, or `'polygon'`) and return an array or a generator. `coordToPixel`, `pixelToCenter`, and `pixelToBoundary` on the index use its nside and ordering. A radius outside `[0, π]` throws.

```ts
import { HealpixIndex } from 'nebulosa/src/astronomy/sky/spatial/healpix'
import { deg, hour } from 'nebulosa/src/math/units/angle'

// A resolution of NSIDE 64 gives pixels about 0.92° across.
const index = new HealpixIndex<{ name: string }>({ nside: 64 })

index.add('a', hour(10), deg(20), { name: 'A' })
index.add(2, hour(10) + deg(0.5), deg(20.2)) // numeric ids work, and metadata is optional
index.add(3n, hour(11), deg(-30), { name: 'C' })

console.log(index.size) // 3
console.log(index.get('a')?.metadata) // { name: 'A' }
console.log(index.coordToPixel(hour(10), deg(20))) // 4455 — nested pixel index

// Region queries return entries.
console.log(index.queryCone(hour(10), deg(20), deg(1)).map((entry) => entry.id)) // ['a', 2]
console.log(index.queryBox(hour(9.9), hour(10.2), deg(19), deg(21)).map((entry) => entry.id)) // ['a', 2]
console.log(
	index
		.queryPolygon([
			[hour(9.9), deg(19)],
			[hour(10.3), deg(19)],
			[hour(10.3), deg(21)],
			[hour(9.9), deg(21)],
		])
		.map((entry) => entry.id),
) // ['a', 2]

// Moving an object updates its bucket; removing returns whether it existed.
index.update('a', hour(12), deg(0))

console.log(index.queryCone(hour(10), deg(20), deg(1)).map((entry) => entry.id)) // [2]
console.log(index.remove(2), index.remove(2)) // true false

// A box that wraps through RA = 0 is handled.
index.addMany([
	{ id: 'x', rightAscension: 0, declination: 0 },
	{ id: 'y', rightAscension: deg(359.9), declination: deg(0.1) },
])

console.log(index.queryBox(deg(359), deg(1), deg(-1), deg(1)).map((entry) => entry.id)) // ['x', 'y']
```

### HEALPix Pixelization and Covers

HEALPix divides the sphere into 12 base faces, each split into `NSIDE × NSIDE` pixels, for `12 · NSIDE²` equal-area pixels in total; `NSIDE` must be a power of two, up to 2²⁴. Pixels can be numbered in two orderings: nested, a hierarchy in which a pixel's index contains its parent's, which suits multi-resolution work, and ring, which numbers pixels along rings of constant latitude. A cover is the set of pixels that intersects a region, used to prune a catalog search.

`coordToPixel(nside, ra, dec, ordering?)` returns the pixel containing a position, with angles in radians and `ordering` `'nested'` by default. `pixelToCenter(nside, pixel, ordering?)` returns the pixel's `[ra, dec]` center, and `pixelToBoundary(nside, pixel, ordering?)` the four corner `[ra, dec]` pairs. `nestedToRing(nside, pixel)` and `ringToNested(nside, pixel)` convert indices. `circleToPixels(nside, ra, dec, radius, options?)`, `triangleToPixels(nside, a, b, c, options?)`, and `polygonToPixels(nside, vertices, options?)` return the conservative cover of a cone (radius in `[0, π]`), a spherical triangle, or a convex polygon, where vertices are `[ra, dec]` pairs; the cover can include pixels that only touch the region, never fewer, and is in nested ordering unless `options.ordering` is `'ring'`. `options.targetNside` computes the cover at a different resolution and `options.maxDepth` limits the recursion. An `NSIDE` that is not a power of two, a pixel out of range, or an invalid radius throws an `Error`. For a ready-made object index built on these, see HEALPix Object Index.

```ts
import { circleToPixels, coordToPixel, nestedToRing, pixelToBoundary, pixelToCenter, polygonToPixels, ringToNested, triangleToPixels } from 'nebulosa/src/astronomy/sky/spatial/healpix'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'

const nside = 64 // 12 · 64² = 49152 pixels of about 0.84 square degrees

// The pixel under RA 10 h, Dec +20°, in nested and ring ordering.
const nested = coordToPixel(nside, hour(10), deg(20))
const ring = coordToPixel(nside, hour(10), deg(20), 'ring')

console.log(nested, ring) // 4455 16107
console.log(nestedToRing(nside, nested), ringToNested(nside, ring)) // 16107 4455 — the two orderings convert exactly

// Its center and four corners, in radians.
console.log(pixelToCenter(nside, nested).map(toDeg)) // [150.47, 20.106] — degrees
console.log(pixelToBoundary(nside, nested).map((corner) => corner.map(toDeg))) // [[150.47, 19.47], [151.17, 20.11], [150.47, 20.74], [149.77, 20.11]]

// Conservative covers: pixels that intersect the region.
console.log(circleToPixels(nside, hour(10), deg(20), deg(1)).length) // 21 — pixels for a 1° radius cone, including the one above

console.log(triangleToPixels(nside, [hour(10), deg(20)], [hour(10) + deg(2), deg(20)], [hour(10), deg(22)]).length) // 20
console.log(
	polygonToPixels(nside, [
		[hour(10), deg(20)],
		[hour(10) + deg(2), deg(20)],
		[hour(10) + deg(2), deg(22)],
		[hour(10), deg(22)],
	]).length,
) // 25

// The same cone in ring ordering, and at a finer resolution.
console.log(circleToPixels(nside, hour(10), deg(20), deg(1), { ordering: 'ring' }).length) // 21
console.log(circleToPixels(nside, hour(10), deg(20), deg(1), { targetNside: 256 }).length) // 111

coordToPixel(63, 0, 0) // Error: invalid HEALPix NSIDE: 63. Expected a power of two in [1, 16777216]
```

### Heliacal Events

As the Sun moves along the ecliptic, a fixed star or planet cycles through four classical visibility transitions each year. The heliacal rising is the first morning it is seen rising in the east just before dawn, after months lost in the Sun's glare; the famous Sothic rising of Sirius is one. The acronychal rising is the last evening it is seen rising at dusk. The heliacal setting is the last evening it is seen setting in the west after dusk, before it is lost in the glare. The cosmical setting is the first morning it is seen setting in the west before dawn.

`heliacalPhases(body, sun, location, start, stop, options?)` finds them with an arc-of-vision model. Each day it finds the object's rise and set, then asks whether the Sun is at least `arcusVisionis` below the geometric horizon at that instant. A brighter object needs a smaller depression than a fainter one, so the arc of vision stands in for the object's brightness and the sky: `options.arcusVisionis` (radians) defaults to 11°, the classical value for a first-magnitude star, and a larger value pushes first visibility later and last visibility earlier. `options.horizon` is the horizon altitude of the crossing (default `STANDARD_HORIZON`), and `options.step` and `options.tolerance` tune the daily rise/set search. `body` and `sun` return geocentric J2000/ICRS directions at a time and `location` is the observer. The result is a chronological list of `{ kind, time, arcusVisionis }`, where `time` is the object's rise or set on the transition day (UTC-based `Time`) and `arcusVisionis` is the Sun depression realized there, in radians. The window must span a full year and should start near the object's conjunction with the Sun so that each season's boundary falls inside it; only transitions inside the window are returned, and a circumpolar or never-rising object returns none. The model is geometric and has no sky-brightness or extinction model, so it is suited to calendar-scale dating. It scans day by day and is not fast: expect seconds for a year.

```ts
import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { heliacalPhases } from 'nebulosa/src/astronomy/events/heliacal'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { type Time, Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const athens = geodeticLocation(deg(23.7275), deg(37.9838), meter(100))
const sirius = eraS2c(hour(6.7525), deg(-16.7161)) // fixed ICRS direction
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])

// One year starting near Sirius's conjunction with the Sun.
const start = timeYMDHMS(2025, 6, 20, 0, 0, 0, Timescale.UTC)
const stop = timeYMDHMS(2026, 6, 20, 0, 0, 0, Timescale.UTC)

for (const phase of heliacalPhases(() => sirius, sunAt, athens, start, stop)) {
	console.log(phase.kind, timeToDate(phase.time).slice(0, 5), toDeg(phase.arcusVisionis))
}
// heliacalRising [2025, 8, 12, 2, 39] 11.28 — UTC, degrees of Sun depression
// cosmicalSetting [2025, 12, 17, 4, 35] 11.40
// acronychalRising [2026, 1, 14, 16, 26] 11.34
// heliacalSetting [2026, 5, 18, 18, 34] 11.48

// A fainter object (or a worse sky) needs a smaller depression to count as visible: 8°.
const lenient = heliacalPhases(() => sirius, sunAt, athens, start, stop, { arcusVisionis: deg(8) })

console.log(lenient[0].kind, timeToDate(lenient[0].time).slice(0, 5)) // heliacalRising [2025, 8, 9, 2, 51] — 3 days earlier

// A circumpolar object has no phases.
console.log(heliacalPhases(() => eraS2c(0, deg(89)), sunAt, athens, start, timeYMDHMS(2025, 7, 20, 0, 0, 0, Timescale.UTC))) // []
```

### Herrick-Gibbs Orbit Determination

The Herrick-Gibbs method is the short-arc counterpart of Gibbs: for three positions that are close together in time and angle, it estimates the middle velocity from a Taylor-series expansion that also uses the three epochs. It stays accurate where the classical Gibbs method becomes ill-conditioned because the points are nearly colinear. Like Gibbs, it needs positions relative to the central body, not angles.

`herrickGibbs(r1, r2, r3, t1, t2, t3, mu, options?)` takes the three positions, their epochs as `Time` instants, and `mu`. Time differences are taken with `timeSubtract` in days (in `options.timescale`, defaulting to the scale of `t2`), so `mu` must be in position-unit³/day² and the velocity comes out in position-unit/day. It returns `{ r, v, diagnostics }` with `r` a copy of `r2`, `v` the middle velocity, and `diagnostics` giving the time intervals `dt21`, `dt32`, `dt31` (days), the angles, the coplanarity error, a `reliable` flag, and the `warnings`. The default checks treat spacings under about 0.1 ms as singular and flag spans over 5 days and separations over 5° as outside the usual regime. An unreliable geometry returns a `NaN` velocity with the warnings, or throws an `Error` if `options.throwOnInvalid` is true. Other options are `minTimeInterval`, `maxTimeInterval` (days), `minPositionNorm`, `minAngularSeparation`, `maxAngularSeparation` (radians), `coplanarityTolerance`, and `minCrossNormRatio`. Inspect the diagnostics before using the state as a seed for a fit.

```ts
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { herrickGibbs } from 'nebulosa/src/astronomy/orbits/determination/herrickgibbs'
import { Timescale, timeShift, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'

const epoch = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.TT)
const orbit = KeplerOrbit.trueAnomaly(1.9, 0.18, 0.12, 0.8, 1.1, 0.35, epoch, GM_SUN_PITJEVA_2005, matIdentity())

// Heliocentric positions 2 days before, at, and 3 days after the epoch.
const [t1, t2, t3] = [timeShift(epoch, -2), epoch, timeShift(epoch, 3)]
const [r1, r2, r3] = [orbit.at(t1)[0], orbit.at(t2)[0], orbit.at(t3)[0]]

const { r, v, diagnostics } = herrickGibbs(r1, r2, r3, t1, t2, t3, GM_SUN_PITJEVA_2005)

console.log(r) // [-1.01258, 1.25644, 0.19314] — AU, the middle position
console.log(v) // [-0.011823, -0.0085783, 0.00030201] — AU/day, within 1e-8 of the true velocity (relative)
console.log(diagnostics.dt21, diagnostics.dt32, diagnostics.dt31) // 2 3 5 — days
console.log(diagnostics.reliable, diagnostics.warnings) // true []

// Epochs that do not increase are rejected: NaN velocity and a warning list.
const bad = herrickGibbs(r3, r2, r1, t3, t2, t1, GM_SUN_PITJEVA_2005)

console.log(bad.diagnostics.reliable, bad.diagnostics.warnings) // false ['NON_INCREASING_TIME', 'TIME_INTERVAL_TOO_SMALL']

herrickGibbs(r3, r2, r1, t3, t2, t1, GM_SUN_PITJEVA_2005, { throwOnInvalid: true }) // Error: herrick-gibbs input is unreliable: NON_INCREASING_TIME, TIME_INTERVAL_TOO_SMALL
```

### Hour-Angle Windows

The hour angle of a target is local sidereal time minus its right ascension: zero on the meridian, negative east of it, positive west. A fixed-right-ascension target's hour angle advances at the sidereal rate, so how long it stays within hour-angle limits, such as a mount's tracking range or the span around the meridian where the airmass is low, is simple geometry. These functions ignore the target's own motion.

`hourAngle(localSiderealTime, rightAscension)` returns `LST − RA` in radians, normalized to `(−π, π]`. `timeUntilMeridian(hourAngle)` returns the SI seconds until the target next stands on the meridian: 0 if it is on it now, and a full circuit minus the elapsed part for a target already west. `hourAngleWindows(hourAngle, minimum, maximum, durationSeconds)` returns the future stretches `{ startSeconds, endSeconds }`, measured from the epoch of the supplied hour angle, during which the signed hour angle lies in `[minimum, maximum]`. When `minimum > maximum` the interval crosses the ±π cut, for example from +160° through 12 h to −160°, and the pieces split by the cut are joined. An empty or non-positive duration, or `minimum == maximum`, returns `[]`, and a duration over 100000 sidereal days throws a `RangeError`. All angles are radians.

```ts
import { hourAngle, hourAngleWindows, timeUntilMeridian } from 'nebulosa/src/astronomy/events/hourangle'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'

// LST 20 h, RA 18 h: 2 hours of sidereal time west of the meridian.
console.log(toDeg(hourAngle(hour(20), hour(18)))) // 30 — degrees

// East of the meridian by 30°: the target transits in about 2 hours; west by 30°: a sidereal day minus 2 hours.
console.log(timeUntilMeridian(deg(-30)) / 3600) // 1.9945 — hours
console.log(timeUntilMeridian(deg(30)) / 3600) // 21.9399 — hours
console.log(timeUntilMeridian(0)) // 0 — seconds, on the meridian

// Starting at hour angle -100°, the target is within ±60° of the meridian from 9574 s to 38295 s.
console.log(hourAngleWindows(deg(-100), deg(-60), deg(60), 86400)) // [{ startSeconds: 9573.8, endSeconds: 38295.2 }]

// A window that crosses the ±180° cut (below the pole): from 160° through 180° to -160°.
console.log(hourAngleWindows(deg(170), deg(160), deg(-160), 86400)) // [{ 0, 7180.3 }, { 83770.6, 86400 }] — two visits in a day

console.log(hourAngleWindows(0, deg(10), deg(20), 0)) // [] — no duration
```

### IAU Body Orientation

The IAU Working Group on Cartographic Coordinates and Rotational Elements publishes how each body is oriented in space: the right ascension and declination of its north pole as polynomials in time, and the angle of its prime meridian, which grows linearly with time plus small periodic corrections. From those the body-fixed frame follows, with +Z along the north pole and +X toward the prime meridian. It is the geometry behind the central meridian, ring tilt, solar disk orientation, and surface points on other bodies.

The library holds the rotation elements as `RotationElements` constants: `SUN_ROTATION`, `MERCURY_ROTATION`, `VENUS_ROTATION`, `EARTH_ROTATION`, `MARS_ROTATION`, `JUPITER_ROTATION` (System III), `JUPITER_SYSTEM_I`, `JUPITER_SYSTEM_II`, `SATURN_ROTATION`, `URANUS_ROTATION`, `NEPTUNE_ROTATION`, and `MOON_ROTATION`. They reproduce the bodies to about 0.1° over the modern era; a few minor periodic terms of Mercury and Mars are omitted. `orientation(elements, time)` returns `{ poleRa, poleDec, primeMeridian }` in radians, with the right ascension and the prime meridian wrapped to `[0, 2π)`, evaluated at TDB. `bodyFixedMatrix(elements, time)` returns the 3×3 rotation that takes an ICRF vector to body-fixed axes (the 3-1-3 sequence `Rz(W) · Rx(π/2 − δ) · Rz(π/2 + α)`). `bodyFixedFrame(elements)` wraps it as a `Frame` with the analytic angular-rate operator `W = dR/dt · Rᵀ` in radians per day, so it works with the frame functions (see Celestial and Terrestrial Reference Frames) and with surface locations (see Planetary Surface Locations). For the points beneath an observer or the Sun, see Sub-Observer and Sub-Solar Points.

```ts
import { bodyFixedFrame, bodyFixedMatrix, orientation } from 'nebulosa/src/astronomy/bodies/orientation'
import { MARS_ROTATION, MOON_ROTATION } from 'nebulosa/src/astronomy/bodies/orientation.data'
import { frameAt } from 'nebulosa/src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

// Mars: pole direction and prime meridian angle.
const mars = orientation(MARS_ROTATION, time)

console.log(toDeg(mars.poleRa), toDeg(mars.poleDec)) // 317.65 52.87 — degrees, ICRF north pole
console.log(toDeg(mars.primeMeridian)) // 72.29 — degrees

console.log(toDeg(orientation(MOON_ROTATION, time).primeMeridian)) // 84.41 — degrees

// ICRF -> Mars body-fixed rotation; the first row is the prime-meridian axis expressed in ICRF.
console.log(bodyFixedMatrix(MARS_ROTATION, time).slice(0, 3)) // [-0.3563, 0.7365, 0.5750]

// The same orientation as a Frame, with the rotation-rate operator.
const frame = bodyFixedFrame(MARS_ROTATION)

console.log(frame.dRdtTimesRtAt!(time).slice(0, 3)) // [0, 6.124, 3.7e-8] — radians/day, Mars rotates 6.124 rad/day

// A point fixed in ICRF seen in Mars's body-fixed axes: position [1, 0, 0] and zero velocity.
console.log(
	frameAt(
		[
			[1, 0, 0],
			[0, 0, 0],
		] as const,
		frame,
		time,
	),
) // [[-0.3563, -0.8210, 0.4461], [-5.028, 2.182, ~0]]
```

### Instantaneous Earth Spin

When a state is moved between the inertial and Earth-fixed frames, its velocity picks up a rotating-frame term `W · p`, with `W = dR/dt · Rᵀ` for the GCRS to ITRS rotation `R`. The `ITRS` frame uses a constant mean spin rate for it. The instantaneous versions evaluate the real rate, including the small contributions of precession, nutation, and polar motion, by central differences over ±1 second.

`instantaneousEarthRotationMatrix(time)` returns the antisymmetric operator `W` in radians per day, and `instantaneousEarthAngularVelocity(time)` the Earth's angular-velocity vector `ω` in ITRS axes, in radians per day, positive along +z (toward the celestial pole). Both are cached on the `Time`. Use them when velocity accuracy at the level of precession or polar-motion rates matters; otherwise the cheaper mean-rate `ITRS` is enough. To apply the exact term to a state, use the `ITRS_INSTANTANEOUS` frame or `itrsInstantaneous` from Celestial and Terrestrial Reference Frames.

```ts
import { instantaneousEarthAngularVelocity, instantaneousEarthRotationMatrix, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

// A UT1 instant, so the example does not depend on loaded Earth orientation data.
const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UT1)

// W = dR/dt · Rᵀ, radians per day, antisymmetric.
const w = instantaneousEarthRotationMatrix(time)

console.log(w[1], w[3]) // 6.3004 -6.3004 — the dominant spin term, about 2π × 1.0027379 per day

// ω in ITRS axes, radians per day.
console.log(instantaneousEarthAngularVelocity(time)) // [-5.2e-7, 6.9e-8, 6.30039] — mostly along +z
```

### Jupiter Central Meridian

The central meridian of Jupiter is the line of longitude that crosses the middle of the disk as the observer sees it, and its longitude tells you which part of the planet faces you. Because Jupiter is a gas giant, there are three conventional rotation systems. System I covers the equatorial jet and System II the temperate latitudes, where the Great Red Spot lies; System III is the magnetic or radio system tied to the interior. Longitudes in Systems I and II are the ones almanacs and observers quote for features on the disk, and they are measured positive to the west.

`jupiterCentralMeridian(system, time, jupiterToObserver)` returns the central-meridian longitude in radians in `[0, 2π)` for `'I'`, `'II'`, or `'III'`. `jupiterToObserver` is the vector from Jupiter's center to the observer in AU, in ICRF axes, for example `earth − jupiter` for a geocentric view; its length sets the light-time delay and its direction the sub-observer point. The longitude increases with time as the planet rotates (System II turns every 9 h 55 m), and it agrees with published System I and II longitudes to about 0.001°. Apply it to a feature at a known longitude to see when it faces you, or use Great Red Spot Transits for the transit instants of a single longitude.

```ts
import { earth, jupiter } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { jupiterCentralMeridian } from 'nebulosa/src/astronomy/events/jupiter'
import { type Time, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

// Vector from Jupiter's center to a geocentric observer, in AU and ICRF axes.
const jupiterToEarth = (time: Time) => vecMinus(earth(time)[0], jupiter(time)[0])

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

console.log(toDeg(jupiterCentralMeridian('I', time, jupiterToEarth(time)))) // 15.82 — degrees, System I (equatorial)
console.log(toDeg(jupiterCentralMeridian('II', time, jupiterToEarth(time)))) // 328.28 — degrees, System II (temperate)
console.log(toDeg(jupiterCentralMeridian('III', time, jupiterToEarth(time)))) // 264.39 — degrees, System III (magnetic)
```

### Kepler Anomalies and Periapsis Timing

The position of a body on its orbit is measured by three angles. The true anomaly `v` is the actual angle from periapsis, the eccentric anomaly `E` is an auxiliary angle (the hyperbolic anomaly for open orbits), and the mean anomaly `M` grows linearly with time. Kepler's equation relates them: `M = E − e·sin E` for an ellipse and `M = e·sinh H − H` for a hyperbola. Going from `M` to `E` requires solving it iteratively, and from there the time since periapsis follows from the mean motion.

`meanAnomaly(E, e, norm?)` gives `M` from `E`: wrapped to `[0, 2π)` for an ellipse, and for a hyperbola signed and wrapped to `[−π, π]` only when `norm` is true. `eccentricAnomalyFromMean(M, e)` inverts it with Newton's method and returns the eccentric (or hyperbolic) anomaly, and throws an `Error` if it does not converge. `eccentricAnomaly(v, e)` gives `E` from the true anomaly. `trueAnomalyClosed(e, E)` and `trueAnomalyHyperbolic(e, H)` give `v` from `E` or `H`, and `trueAnomalyParabolic(p, mu, M)` does so for a parabola from the semi-latus rectum `p` (AU), `mu` (AU³/day²), and the parabolic mean anomaly. For `e = 1`, `eccentricAnomaly`, `eccentricAnomalyFromMean`, and `meanAnomaly` return 0, since the parabola uses `v` directly. `timeSincePeriapsis(M, n, v, p, mu)` returns the days since periapsis, `M / n` for any orbit with a usable mean motion `n` (radians/day), and Barker's equation from `v` and `p` when `n` is essentially zero. All angles are radians. The same quantities are available as properties of an orbit (see Osculating Orbital Elements).

```ts
import { eccentricAnomaly, eccentricAnomalyFromMean, meanAnomaly, meanMotion, timeSincePeriapsis, trueAnomalyClosed, trueAnomalyHyperbolic, trueAnomalyParabolic } from 'nebulosa/src/astronomy/orbits/asteroid'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'

// An ellipse with e = 0.3 at eccentric anomaly E = 0.7 rad.
const e = 0.3
const M = meanAnomaly(0.7, e)
const v = trueAnomalyClosed(e, 0.7)

console.log(M) // 0.50673 — radians, E - e·sin(E)
console.log(v) // 0.92321 — radians, true anomaly
console.log(eccentricAnomaly(v, e)) // 0.7 — back to E
console.log(eccentricAnomalyFromMean(M, e)) // 0.7 — Kepler's equation solved for E
console.log(eccentricAnomalyFromMean(0.5, 0.99)) // 1.4865 — a near-parabolic ellipse still converges

// Hyperbola with e = 1.5 and hyperbolic anomaly H = 4.
const vh = trueAnomalyHyperbolic(1.5, 4)

console.log(vh) // 2.2729 — radians
console.log(eccentricAnomaly(vh, 1.5)) // 4 — back to H
console.log(meanAnomaly(4, 1.5)) // 36.935 — radians, e·sinh(H) - H, not wrapped
console.log(meanAnomaly(4, 1.5, true)) // -0.76424 — radians, wrapped to [-PI, PI]

// Parabola: semi-latus rectum 2 AU, solar mu.
console.log(trueAnomalyParabolic(2, GM_SUN_PITJEVA_2005, 0.1)) // 0.53831 — radians
console.log(trueAnomalyParabolic(2, GM_SUN_PITJEVA_2005, -0.1)) // -0.53831 — radians, before periapsis

// Time since periapsis for a 1 AU, e = 0.3 ellipse.
const n = meanMotion(1, GM_SUN_PITJEVA_2005) // 0.017202 — radians/day

console.log(timeSincePeriapsis(M, n, v, 1 * (1 - e * e), GM_SUN_PITJEVA_2005)) // 29.458 — days
```

### Light-Time Solution

Light takes time to cross the Solar System, so a body seen at time `t` is where it was at the earlier emission time `t − τ`, with `τ = distance / c`. Because the distance depends on that earlier position, the solution is found by fixed-point iteration: sample the observer at reception, sample the target at the retarded epoch, recompute the distance, and repeat. Three iterations are enough for Solar-System bodies.

`lightTimeSolution(target, observer, time, iterations)` returns the retarded geometry, or `undefined` when target and observer coincide. `target` and `observer` are functions of `Time` returning a barycentric `[position (AU), velocity (AU/day)]` that share one origin, typically ICRS/BCRS; the observer is sampled once at reception and the target `iterations + 1` times. `iterations` must be an integer in `[0, 16]` (0 is the uncorrected geometric direction) or an `Error` is thrown; `DEFAULT_LIGHT_TIME_ITERATIONS` is 3. The result is an owned snapshot: `position` (target minus observer, AU), `distance` (AU), `lightTime` (days), `emissionTime`, the observer's position and velocity at reception, and the target's position at emission. `topocentricDirection` returns only the observer-to-target vector, a freshly allocated non-unit vector whose length is the distance in AU; its optional `out` receives the result and is returned. Neither applies aberration or deflection, so the vector is a geometric line of sight and not an apparent place; for that use Apparent Direction. `lightTime(p)` converts a position's length to days of light travel.

```ts
import { DEFAULT_LIGHT_TIME_ITERATIONS, lightTime, lightTimeSolution, topocentricDirection } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

// Synthetic barycentric providers: [position (AU), velocity (AU/day)].
const observer = () =>
	[
		[1, 0, 0],
		[0, 0.0172, 0],
	] as const
const target = () =>
	[
		[1.5, 4.5, 0.5],
		[0, 0, 0],
	] as const

const solution = lightTimeSolution(target, observer, time, DEFAULT_LIGHT_TIME_ITERATIONS)

console.log(solution?.position) // [0.5, 4.5, 0.5] — AU, target minus observer
console.log(solution?.distance) // 4.5552 — AU
console.log(solution?.lightTime) // 0.026309 — days
// solution?.emissionTime is time - lightTime; observerPosition, observerVelocity and
// targetEmissionPosition are the reception and emission samples.

const direction = topocentricDirection(target, observer, time, DEFAULT_LIGHT_TIME_ITERATIONS)

console.log(direction) // [0.5, 4.5, 0.5] — AU, not normalized
console.log(lightTime(direction)) // 0.026309 — days of light travel

console.log(
	lightTimeSolution(
		() =>
			[
				[1, 0, 0],
				[0, 0, 0],
			] as const,
		observer,
		time,
		3,
	),
) // undefined — coincident
```

### Local ENU Frames

East-North-Up (ENU) is the local Cartesian frame of an observer: +x points east, +y north, and +z toward the zenith, all tangent to the ellipsoid at the site. Azimuth, measured from north through east, and altitude are its spherical angles. ENU vectors are convenient for mount and horizon geometry because a direction needs no spherical formulas, only a rotation from equatorial axes.

`horizontalToEnuVector(azimuth, altitude, out?)` returns the unit ENU direction for an azimuth and altitude in radians, and `enuVectorToHorizontal(vector)` inverts it, returning `{ azimuth, altitude }` with azimuth wrapped to `[0, 2π)`, or 0 at the zenith and nadir, where it is undefined. A zero vector throws a `RangeError`. `equatorialToEnuMatrix(latitude, lst, out?)` returns the 3×3 rotation taking an apparent equatorial vector (as from `eraS2c(rightAscension, declination)`, with the equator of date) to ENU for a geodetic latitude and a local apparent sidereal time, both in radians. `enuToEquatorialMatrix` is its exact transpose. The matrices are pure rotations: they apply no refraction, aberration, or parallax, and the optional `out` argument receives the result and is returned. For plain azimuth and altitude from right ascension and declination, Local Horizon Coordinates is shorter; use these matrices when you already work with vectors, or need many conversions at one instant (build the matrix once).

```ts
import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { enuToEquatorialMatrix, enuVectorToHorizontal, equatorialToEnuMatrix, horizontalToEnuVector } from 'nebulosa/src/astronomy/coordinates/frame.local'
import { matMulVec } from 'nebulosa/src/math/linear-algebra/mat3'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'

const latitude = deg(-29.2563)
const lst = hour(17.7685) // local apparent sidereal time

// An apparent equatorial direction (RA 16 h, Dec -26°) rotated into ENU.
const equatorial = eraS2c(hour(16), deg(-26))
const enu = matMulVec(equatorialToEnuMatrix(latitude, lst), equatorial)

console.log(enu) // [-0.4014, 0.01056, 0.9158] — east, north, up

const { azimuth, altitude } = enuVectorToHorizontal(enu)

console.log(toDeg(azimuth), toDeg(altitude)) // 271.51 66.32 — degrees, north through east

// The reverse: azimuth and altitude to a unit ENU vector, and back to equatorial.
console.log(horizontalToEnuVector(azimuth, altitude)) // [-0.4014, 0.01056, 0.9158]
console.log(matMulVec(enuToEquatorialMatrix(latitude, lst), enu)) // [-0.4494, -0.7784, -0.4384] — equal to the original equatorial vector

// Cardinal directions: north, east, south, and zenith.
console.log(horizontalToEnuVector(0, 0)) // [0, 1, 0]
console.log(horizontalToEnuVector(deg(90), 0)) // [1, 0, 0]
console.log(horizontalToEnuVector(deg(180), 0)) // [0, -1, 0]
console.log(enuVectorToHorizontal([0, 0, 1])) // { azimuth: 0, altitude: 1.5708 } — the azimuth is arbitrary at the zenith

enuVectorToHorizontal([0, 0, 0]) // RangeError: vector must be non-zero
```

### Local Horizon Coordinates

The horizontal system describes where a source appears for an observer: azimuth measured from north through east, and altitude above the local horizon. Converting from equatorial coordinates needs the local hour angle `H = LST − RA`, where LST is the local apparent sidereal time, and the observer's latitude.

`equatorialToHorizontal(ra, dec, latitude, lst)` returns `[azimuth, altitude]` and `horizontalToEquatorial(azimuth, altitude, latitude, lst)` returns `[ra, dec]`. All angles are radians; `ra` and `dec` are in the equatorial frame of date (the same equator as the sidereal time), `latitude` is geodetic, `lst` is the local apparent sidereal time (use `localSiderealTime`), azimuth comes back in `[0, 2π)`, and the right ascension returned by the inverse is wrapped to `[0, 2π)`. The conversion is pure trigonometry: it applies no refraction, aberration, or parallax, and at the zenith or a pole the azimuth is arbitrary but finite. For a refracted, topocentric place with ERFA corrections see Topocentric Observed Place.

```ts
import { equatorialToHorizontal, horizontalToEquatorial } from 'nebulosa/src/astronomy/coordinates/coordinate'
import { localSiderealTime } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, hour, toDeg, toHour } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)
const longitude = deg(-70.7313) // east-positive
const latitude = deg(-29.2563)

// Local apparent sidereal time at the observer's longitude (radians).
const lst = localSiderealTime(time, longitude)

console.log(toHour(lst)) // 17.768 — hours

// Equatorial of date: RA 16 h, Dec -26°.
const [azimuth, altitude] = equatorialToHorizontal(hour(16), deg(-26), latitude, lst)

console.log(toDeg(azimuth)) // 271.51 — degrees, north through east (west)
console.log(toDeg(altitude)) // 66.32 — degrees

// Inverse: recovers the equatorial coordinates.
const [ra, dec] = horizontalToEquatorial(azimuth, altitude, latitude, lst)

console.log(toHour(ra), toDeg(dec)) // 16 -26 — hours, degrees

// A body at declination equal to the latitude and transiting is at the zenith.
console.log(toDeg(equatorialToHorizontal(lst, latitude, latitude, lst)[1])) // 90 — degrees
```

### Local Horizon Mask

A real observing site rarely has a flat, clear horizon: trees, buildings, and hills hide the sky below some altitude that depends on azimuth. A horizon mask records that as a list of azimuths with the minimum altitude a target must reach there to be seen. Between samples the minimum altitude is interpolated linearly around the circle, so the segment from the last azimuth back to the first is included.

A mask is an array of `HorizonSample`s, `{ azimuth, minimumAltitude }` in radians with azimuth north through east. It may be empty (nothing is hidden), unordered, or have repeated azimuths (the higher altitude is kept); a single sample applies at every azimuth. `horizonMinimumAltitude(samples, azimuth)` returns the interpolated minimum altitude at an azimuth, or −π/2 for an empty mask. `isAboveHorizon(samples, altitude, azimuth)` is true when the altitude is at least that. `horizonCrossings(path, horizon)` finds where a sampled path crosses behind or out from behind the mask. A path is an array of `{ time, altitude, azimuth }` samples, with time in any uniform unit (the crossing keeps it) and angles in radians, sorted by time or not. It returns the `HorizonCrossing`s in time order as `{ time, altitude, azimuth, kind }`, where `kind` is `'set'` when the target goes behind the mask and `'rise'` when it emerges. Each path segment is split at the mask's azimuth samples so that a peak or valley inside it still gives its crossings; the samples must be dense enough that each step is the short azimuth arc. A path of fewer than two samples has no crossings. To make a path from an ephemeris, sample the altitude and azimuth of the target (see Local Horizon Coordinates).

```ts
import { horizonCrossings, horizonMinimumAltitude, isAboveHorizon, type HorizonSample, type HorizontalPathSample } from 'nebulosa/src/astronomy/observer/horizon'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// Obstructions every 90° of azimuth: 10° to the north, 25° to the east, 5° to the south, 15° to the west.
const mask: HorizonSample[] = [
	{ azimuth: deg(0), minimumAltitude: deg(10) },
	{ azimuth: deg(90), minimumAltitude: deg(25) },
	{ azimuth: deg(180), minimumAltitude: deg(5) },
	{ azimuth: deg(270), minimumAltitude: deg(15) },
]

// Linear interpolation on the circle, including the wrap from 270° back to 0°.
console.log(toDeg(horizonMinimumAltitude(mask, deg(45)))) // 17.5 — degrees
console.log(toDeg(horizonMinimumAltitude(mask, deg(315)))) // 12.5 — degrees
console.log(toDeg(horizonMinimumAltitude([], deg(45)))) // -90 — an empty mask hides nothing

console.log(isAboveHorizon(mask, deg(20), deg(45))) // true — 20° is above the 17.5° there
console.log(isAboveHorizon(mask, deg(15), deg(60))) // false — the mask is about 20° at that azimuth

// A target rising in the east-northeast: 10° of altitude and 20° of azimuth per time unit.
const rising: HorizontalPathSample[] = [0, 1, 2, 3, 4, 5, 6].map((i) => ({ time: i, altitude: deg(5 + 10 * i), azimuth: deg(60 + 20 * i) }))

for (const crossing of horizonCrossings(rising, mask)) console.log(crossing.kind, crossing.time, toDeg(crossing.altitude), toDeg(crossing.azimuth))
// rise 1.846 23.46 96.92 — emerges from behind the mask at 23.5° altitude, azimuth 97°

// A setting target that drops behind the southwest mask.
const setting: HorizontalPathSample[] = [0, 1, 2, 3].map((i) => ({ time: 10 * i, altitude: deg(40 - 12 * i), azimuth: deg(200 + 10 * i) }))

for (const crossing of horizonCrossings(setting, mask)) console.log(crossing.kind, crossing.time, toDeg(crossing.altitude), toDeg(crossing.azimuth))
// set 25 10 225 — behind the mask at time 25, altitude 10°, azimuth 225°
```

### Local Lunar Eclipse Search

`listLocalLunarEclipses(longitude, latitude, startTime, endTime, sunMoonPosition, options?)` returns the lunar eclipses of a time window that can be seen from a site, in chronological order. Because a lunar eclipse is global, the only local test is whether the Moon is above the horizon during some part of the penumbral phase, including a moonrise or moonset in the middle of the eclipse. `longitude` is east-positive and `latitude` is geodetic, both in radians. `startTime` and `endTime` can be in any time scale; they are compared in TT with the instant of greatest eclipse, and the window is open at `startTime` and closed at `endTime`. A reversed window returns an empty list.

Each `LocalLunarEclipseListEntry` has the `eclipse` as returned by `nearestLunarEclipse` (the global circumstances) and the `circumstances` computed for the site, so the caller does not recompute them (see Lunar Eclipse Local Circumstances). The eclipses come from the Meeus series of `nearestLunarEclipse`, one per step, and an eclipse for which the Moon never reaches the horizon (`geometricOnlyBelowHorizon`) is omitted. `options` are those of `computeLocalLunarEclipseCircumstances`: `horizonAltitude` (radians, default 0) and `altitudeSamples` of the altitude scan.

```ts
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { listLocalLunarEclipses } from 'nebulosa/src/astronomy/events/eclipse/lunar/local'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2025, 1, 1, 0, 0, 0, Timescale.UTC)
const stop = timeYMDHMS(2028, 1, 1, 0, 0, 0, Timescale.UTC)

// São Paulo. Five eclipses are visible from the site in these three years; that of 7 September 2025 is not.
for (const { eclipse, circumstances } of listLocalLunarEclipses(deg(-46.6333), deg(-23.55), start, stop, sunMoonPosition)) {
	console.log(timeToDate(utc(eclipse.maximalTime)).slice(0, 5).join('-'), eclipse.type, circumstances.visibility.kind, circumstances.details.observableDuration)
}
// 2025-3-14-6-59 TOTAL totalVisible 18767.62
// 2026-3-3-11-34 TOTAL penumbralOnlyVisible 598.84
// 2026-8-28-4-13 PARTIAL completelyVisible 20144.43
// 2027-2-20-23-13 PENUMBRAL penumbralOnlyVisible 12885.95
// 2027-8-17-7-14 PENUMBRAL completelyVisible 12990.18

// With a 20° horizon the eclipse of 3 March 2026, which is only seen near the horizon, disappears.
console.log(listLocalLunarEclipses(deg(-46.6333), deg(-23.55), start, stop, sunMoonPosition, { horizonAltitude: deg(20) }).length) // 4

// A reversed window is empty.
console.log(listLocalLunarEclipses(deg(-46.6333), deg(-23.55), stop, start, sunMoonPosition).length) // 0
```

### Local Lunar Eclipse View Geometry

The local view of a lunar eclipse is the diagram that shows where the Moon crosses the Earth's shadow as seen from a site: the penumbra and umbra as two concentric circles, the Moon's disk at each contact, the path of its center, and the horizon. `computeLocalLunarEclipseViewGeometry(circumstances, eclipse, options?)` builds it as plain shapes in SVG pixels (no text, labels or markup), from the `events` of `computeLocalLunarEclipseCircumstances` (see Lunar Eclipse Local Circumstances) and the `LunarEclipse`. Only the `events` property of the circumstances is read, so any object with that shape works. The diagram is a schematic of the Moon plane: the shadow center is fixed at the center of the view, the Moon is placed by the contact's shadow-axis distance and its position angle, and the scale is `options.umbraRadiusPx` pixels for the umbra radius (the penumbra and the Moon follow in proportion, with the Moon radius from `MOON_RADIUS_EARTH_RADII`). The horizon offset uses a mean angular size of an Earth radius at the Moon, so it is schematic and meant for judging which side of the horizon a disk is on.

`options` are all optional: `width` and `height` (pixels, default 300), `selectedEvent` (the contact drawn as the primary disk, default `'MAX'`), `orientationMode` (`'zenith'`, the default, puts the local zenith up; `'north'` puts celestial north up), `handedness` (`'eastRight'`, the default, puts east on the right; `'eastLeft'` mirrors it), `umbraRadiusPx` (default 70), `includeGhostDisks` (draw the other contacts, default true), `includeHorizon` (draw the horizon, default true), `horizonBandPaddingPx` (default 4) and `horizonAltitude` (radians, default 0): pass the value used for the circumstances so that a disk is above the line exactly when its event is `observable`. If the requested contact does not exist for the eclipse type, `MAX` is used, then the first existing contact; `selectedEvent` of the result is the contact actually drawn, `undefined` when there are no events, and `requestedEvent` the one asked for.

The result has the size, the orientation, the radius of the umbra and the list of `shapes` in painter order: the `horizonBand` polygon (the below-horizon region), the `trajectoryPath` through the existing contacts in chronological order, the `ghostMoonDisk` circles, the `moonDisk` of the primary contact, the `penumbra` and `umbra` circles (each with `cx`, `cy` and `r`), and finally the `horizonLine`. A `circle` has `role`, `cx`, `cy` and `r` (and `event` for the Moon disks), a `line` has `x1`, `y1`, `x2`, `y2`, a `path` has the data `d`, and a `polygon` has `points`. SVG `y` grows downward.

```ts
import { nearestLunarEclipse } from 'nebulosa/src/astronomy/bodies/moon'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeLocalLunarEclipseCircumstances, computeLocalLunarEclipseViewGeometry } from 'nebulosa/src/astronomy/events/eclipse/lunar/local'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

// The total lunar eclipse of 7 September 2025, seen from Perth.
const eclipse = nearestLunarEclipse(timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.UTC), true)
const circumstances = computeLocalLunarEclipseCircumstances(eclipse, deg(115.86), deg(-31.95), sunMoonPosition)

const view = computeLocalLunarEclipseViewGeometry(circumstances, eclipse)
console.log(view.width, view.height, view.orientationMode, view.selectedEvent, view.umbraRadiusPx) // 300 300 zenith MAX 70
console.log(view.shapes.map((shape) => `${shape.kind}:${shape.role}`).join(' '))
// polygon:horizonBand path:trajectoryPath circle:ghostMoonDisk ×6 circle:moonDisk circle:penumbra circle:umbra line:horizonLine

for (const shape of view.shapes) {
	if (shape.kind === 'circle' && (shape.role === 'moonDisk' || shape.role === 'penumbra' || shape.role === 'umbra')) console.log(shape.role, shape.event, shape.cx.toFixed(2), shape.cy.toFixed(2), shape.r.toFixed(2))
}
// moonDisk MAX 156.10 124.81 25.61
// penumbra undefined 150.00 150.00 120.32
// umbra undefined 150.00 150.00 70.00

const trajectory = view.shapes.find((shape) => shape.kind === 'path')!
console.log(trajectory.d) // M295.56 160.44L245.58 147.49L191.22 133.52L156.1 124.81L121.38 116.07L67.12 102.33L17.07 89.8

// The start of totality, in the sky-north orientation, east to the left, without the other disks.
const north = computeLocalLunarEclipseViewGeometry(circumstances, eclipse, { selectedEvent: 'U2', orientationMode: 'north', handedness: 'eastLeft', includeGhostDisks: false })
console.log(north.shapes.map((shape) => `${shape.kind}:${shape.role}`).join(' ')) // polygon:horizonBand path:trajectoryPath circle:moonDisk circle:penumbra circle:umbra line:horizonLine

// A penumbral eclipse has only P1, MAX and P4; asking for U2 falls back to MAX.
const penumbral = nearestLunarEclipse(timeYMDHMS(2027, 2, 1, 0, 0, 0, Timescale.UTC), true)
const events = computeLocalLunarEclipseCircumstances(penumbral, 0, 0, sunMoonPosition)
const fallback = computeLocalLunarEclipseViewGeometry(events, penumbral, { selectedEvent: 'U2' })
console.log(penumbral.type, fallback.requestedEvent, fallback.selectedEvent) // PENUMBRAL U2 MAX

// With no events there are only the two shadow circles.
const empty = computeLocalLunarEclipseViewGeometry({ events: {} }, eclipse)
console.log(
	empty.selectedEvent,
	empty.shapes.map((shape) => shape.role),
) // undefined ['penumbra', 'umbra']
```

### Local Solar Eclipse Circumstances

The local circumstances of a solar eclipse are what an observer at one place sees: the contacts, the magnitude, the durations, the Sun's altitude and the position angles at each contact, and a classification of how visible the eclipse is. `computeLocalSolarEclipseCircumstances(pbe, longitude, latitude, options?)` resolves all of it for a geodetic site (`longitude` east-positive and `latitude`, in radians) from the `PolynomialBesselianElements` of Solar Eclipse Besselian Elements. The shadow is evaluated on the fundamental plane (Earth radii) from the cubic fit, which is valid for about ±3 h around `time0`, and the contacts are searched in a window that is widened up to 5 h when a contact is missed. The site is treated geometrically: every contact is computed even with the Sun below the horizon, and only the `observable` flag reflects the horizon.

`options.horizonAltitude` (radians, default 0) is the altitude of the apparent horizon, and an event is observable when the Sun's center is at or above it. `options.sunMoonPosition` is the provider used to build the elements (such as `sunMoonPosition`), which is strongly preferred: with it the altitude, the position angles and the apparent diameters are computed from the real Sun and Moon, and without it the altitude is a Besselian approximation and the angles are undefined.

The result has `location`, `visibility`, `details` and `events`. `events` has `C1` and `C4` (the start and end of the partial phase), `MAX` (the local maximum) and, only when the maximum is central, `C2` and `C3` (the start and end of the total or annular phase); a missing contact is `undefined`. A `LocalSolarEclipseEvent` has its `kind`, a `description`, the TT `time` and `jd`, the `sunAltitude` (radians), the `positionAngle` of the contact point on the solar limb (from celestial north toward east) and the `zenithAngle` of the same point from the zenith, both in `[0, 2π)`, the `visibility` (`'aboveHorizon'` or `'belowHorizon'`) and `observable` flags, the local `magnitude` (fraction of the solar diameter covered; above 1 only during a total eclipse), the Moon/Sun `moonSunDiameterRatio` and the `centralPhaseKind`. At a total `C2` and `C3` the position angle is that of the far limb, opposite to the Moon's center direction.

`details` has the maximum magnitude and diameter ratio, `partialPhaseDuration` (C4 − C1) and `centralPhaseDuration` (C3 − C2) in seconds, and `shadowPathWidthKm`, the width of the central shadow chord through the observer, which is `undefined` outside the central path. `visibility` has `kind`, one of `'notVisible'`, `'geometricOnlyBelowHorizon'`, `'partiallyVisible'`, `'completelyVisible'`, `'centralPhaseVisible'` or `'partialOnlyVisible'`, the `text` of it, the flags `hasGeometricEclipse`, `hasObservableEclipse` and `hasCentralPhase`, the `centralPhaseKind` (`'none'`, `'total'` or `'annular'`), `sunMotion` (`'rising'`, `'setting'` or `'none'`) and `completeness`, which says whether all the expected contacts were resolved.

The lower-level functions are exported too. `computeLocalFundamentalState(pbe, longitude, latitude, time, state?)` is the geometry at one instant (the observer coordinates `ksi`, `eta` and `zeta` and the axis offsets `u` and `v` on the fundamental plane, the `distance` between them, the local cone radii `L1` and `L2`, and the magnitude); it fills and returns `state` when it is given, to avoid an allocation in a loop. `findLocalMaximumTime(pbe, longitude, latitude, fromJd, toJd, stepDays)` and `findLocalContactRoots(pbe, longitude, latitude, fromJd, toJd, stepDays, fn)` find the Julian Day of the magnitude maximum and all the zeros of a function of the state. `computeLocalEclipseEvents` is the `events` of the result, `computeLocalShadowPathWidthKm` the path width at an instant, `computeSolarAngularRadius(distance)` the apparent radius (radians) of the Sun from its distance in Earth radii, and `computeSeparationSolarRadii(state)` the Sun–Moon center separation in solar radii. `localVisibilityText(kind)` gives the English text of a visibility kind.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeLocalEclipseEvents, computeLocalFundamentalState, computeLocalShadowPathWidthKm, computeLocalSolarEclipseCircumstances, computeSeparationSolarRadii, computeSolarAngularRadius, findLocalContactRoots, findLocalMaximumTime, localVisibilityText } from 'nebulosa/src/astronomy/events/eclipse/solar/local'
import { computePolynomialBesselianElements } from 'nebulosa/src/astronomy/events/eclipse/solar/map'
import { Timescale, timeToDate, timeYMDHMS, toJulianDay, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// The total solar eclipse of 8 April 2024, seen from Dallas.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)
const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
const longitude = deg(-96.797)
const latitude = deg(32.776)

const circumstances = computeLocalSolarEclipseCircumstances(pbe, longitude, latitude, { sunMoonPosition })
console.log(circumstances.visibility.kind, circumstances.visibility.text) // completelyVisible Entire eclipse visible
console.log(circumstances.visibility.centralPhaseKind, circumstances.visibility.sunMotion) // total setting
console.log(circumstances.details.maximalMagnitude, circumstances.details.moonSunDiameterRatio) // 1.0154 1.0562
console.log(circumstances.details.partialPhaseDuration, circumstances.details.centralPhaseDuration, circumstances.details.shadowPathWidthKm) // 9560.84 234.98 172.49

for (const event of Object.values(circumstances.events)) {
	console.log(event.kind, timeToDate(utc(event.time)).slice(0, 6).join('-'), toDeg(event.sunAltitude).toFixed(2), toDeg(event.positionAngle!).toFixed(1), event.magnitude.toFixed(4), event.description)
}
// C1 2024-4-8-17-23-22 60.57 226.2 -0.0000 Beginning of partial phase
// C2 2024-4-8-18-40-44 64.67 20.3 1.0000 Beginning of total phase
// MAX 2024-4-8-18-42-41 64.62 137.3 1.0154 Local maximum
// C3 2024-4-8-18-44-39 64.56 254.2 1.0000 End of total phase
// C4 2024-4-8-20-2-43 56.75 49.2 0.0000 End of partial phase

// New York is outside the path: no C2 and C3, and a partial magnitude of 0.91.
const partial = computeLocalSolarEclipseCircumstances(pbe, deg(-74.006), deg(40.713), { sunMoonPosition })
console.log(partial.visibility.kind, partial.events.C2, partial.events.MAX!.magnitude) // completelyVisible undefined 0.9103

// A site far away has no eclipse at all.
const far = computeLocalSolarEclipseCircumstances(pbe, deg(110), deg(-30), { sunMoonPosition })
console.log(far.visibility.kind, far.visibility.hasGeometricEclipse, far.events.MAX) // notVisible false undefined

// With a horizon at 70° the Sun is never high enough: the eclipse occurs but cannot be observed.
const raised = computeLocalSolarEclipseCircumstances(pbe, longitude, latitude, { sunMoonPosition, horizonAltitude: deg(70) })
console.log(raised.visibility.kind, raised.events.MAX!.observable, raised.events.MAX!.visibility) // geometricOnlyBelowHorizon false belowHorizon

// The same events as a separate call, and the width of the shadow at the local maximum.
console.log(Object.keys(computeLocalEclipseEvents(pbe, longitude, latitude, { sunMoonPosition }))) // [ 'C1', 'C2', 'MAX', 'C3', 'C4' ]
console.log(computeLocalShadowPathWidthKm(pbe, longitude, latitude, circumstances.events.MAX!.jd)) // 172.490234375

// The geometry at the instant of the global maximum.
const state = computeLocalFundamentalState(pbe, longitude, latitude, eclipse.maximalTime)
console.log(state.distance, state.L1, state.L2, state.magnitude, state.centralPhaseKind) // 0.16549 0.53151 -0.014559 0.70803 none
console.log(computeSeparationSolarRadii(state)) // 0.64026

// The local maximum and the partial contacts, found directly.
const jd = toJulianDay(eclipse.maximalTime)
console.log(findLocalMaximumTime(pbe, longitude, latitude, jd - 0.1, jd + 0.1, 60 / 86400)) // 2460409.2804498803
console.log(findLocalContactRoots(pbe, longitude, latitude, jd - 0.1, jd + 0.1, 60 / 86400, (s) => s.distance - s.L1)) // [ 2460409.2253655596, 2460409.3360234406 ]

// The apparent solar radius at 1 AU (23455 Earth radii), and the visibility text of each kind.
console.log(computeSolarAngularRadius(23455), computeSolarAngularRadius()) // 0.0046504696 0.0046524175 — the mean radius, 959.63″
console.log(localVisibilityText('centralPhaseVisible')) // Central phase visible
```

### Local Solar Eclipse Search

`listLocalSolarEclipses(longitude, latitude, startTime, endTime, sunMoonPosition)` lists the solar eclipses whose greatest eclipse falls in `(startTime, endTime]` and whose shadow reaches a site (`longitude` east-positive and geodetic `latitude`, in radians). It walks the eclipses with `nearestSolarEclipse` (the global search of Solar Eclipse Search and Classification), builds the Besselian elements of each one once, and keeps the eclipse when the local magnitude is above zero at some time, so the filter is purely geometric: an eclipse is included even when the Sun is below the horizon at the site. `sunMoonPosition` is the required provider of the Sun and Moon positions that the elements are fitted to (such as `sunMoonPosition`). The result is ordered earliest first, and is empty when `endTime` is before `startTime`.

Each `LocalSolarEclipseListEntry` has the `eclipse` (the global circumstances, a `SolarEclipse` with its type, magnitude and `maximalTime`), the `elements` (the `PolynomialBesselianElements`, ready for `computeLocalSolarEclipseCircumstances` of Local Solar Eclipse Circumstances, which then does not refit them) and `state`, the `LocalFundamentalState` at the local maximum, whose `magnitude` is the local magnitude. The cost is dominated by the Besselian fit of each global eclipse, which is why the elements are returned: refining the eclipses of an entry list is cheap.

```ts
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeLocalSolarEclipseCircumstances, listLocalSolarEclipses } from 'nebulosa/src/astronomy/events/eclipse/solar/local'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

// The solar eclipses seen from Dallas between 2023 and 2026.
const longitude = deg(-96.797)
const latitude = deg(32.776)
const start = timeYMDHMS(2023, 1, 1, 0, 0, 0, Timescale.UTC)
const end = timeYMDHMS(2026, 12, 31, 0, 0, 0, Timescale.UTC)

const entries = listLocalSolarEclipses(longitude, latitude, start, end, sunMoonPosition)
console.log(entries.length) // 3

for (const { eclipse, elements, state } of entries) {
	const local = computeLocalSolarEclipseCircumstances(elements, longitude, latitude, { sunMoonPosition })
	console.log(timeToDate(utc(eclipse.maximalTime)).slice(0, 3).join('-'), eclipse.type, eclipse.magnitude.toFixed(3), local.visibility.kind, local.details.maximalMagnitude!.toFixed(3), state.magnitude.toFixed(3))
}
// 2023-10-14 annular 0.952 completelyVisible 0.862 0.862
// 2024-4-8 total 1.055 completelyVisible 1.015 1.015
// 2025-3-29 partial 0.935 geometricOnlyBelowHorizon 0.617 0.617

// An empty range, or one whose end precedes its start, gives an empty list.
console.log(listLocalSolarEclipses(longitude, latitude, end, start, sunMoonPosition).length) // 0
```

### Local Solar Eclipse View Geometry

The local view of a solar eclipse is the diagram of the Sun with the Moon in front of it, as the observer sees it: the solar disk at the center, the Moon's disk offset by the local separation of the centers, and the horizon. `computeLocalSolarEclipseViewGeometry(circumstances, options?)` builds it as plain shapes in SVG pixels (no text, labels or markup) from the `events` of `computeLocalSolarEclipseCircumstances` (Local Solar Eclipse Circumstances); only the `events` property is read, so any object with that shape works. The Sun is the unit of the diagram: the Moon is placed by the separation of the centers in solar radii, scaled to `solarRadiusPx`, and the lunar radius follows from the Moon/Sun diameter ratio of the event.

`options` are all optional: `width` and `height` (SVG pixels, default 450 and 160), `selectedEvent` (the contact drawn as the primary state, default `'MAX'`), `orientationMode` (`'zenith'`, the default, draws the local zenith up; `'north'` draws celestial north up and rotates the horizon by the parallactic angle of the Sun), `handedness` (`'eastRight'`, the default, puts celestial east on the right; `'eastLeft'` mirrors it, as in the naked-eye view), `solarRadiusPx` (default 34), `includeGhostDisks` (draw the Moon at the other contacts, default true), `includeHorizon` (draw the horizon, default true) and `horizonBandPaddingPx`. If the requested contact does not exist at the site, `MAX` is used, then the first existing one; `selectedEvent` of the result is the contact actually drawn (`undefined` when there are no events) and `requestedEvent` the one asked for.

The result has the size, `orientationMode`, `solarRadiusPx` and the list of `shapes`: `ghostMoonDisk` circles (one per other contact, each with its `event` tag), the `sunDisk` and `moonDisk` of the primary contact, the `horizonBand` polygon (the below-horizon region, with `points`) and the `horizonLine`. A circle has `role`, `cx`, `cy` and `r`, a line `x1`, `y1`, `x2` and `y2`. SVG `y` grows downward. The horizon is placed from the Sun's altitude: at the usual altitude of an eclipse it is far below the Sun, outside the diagram, and it enters the view only when the Sun is low.

`computeLocalViewDiskPair(event, options, frameEvent?)` returns the `sun` and `moon` circles of one event, in the frame of `frameEvent` (the event itself when omitted), and `buildLocalViewHorizonGeometry(event, options)` the `horizonBand` and `horizonLine` of one event; they are the pieces of the function above, and take a full `LocalSolarEclipseViewOptions`.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { buildLocalViewHorizonGeometry, computeLocalSolarEclipseCircumstances, computeLocalSolarEclipseViewGeometry, computeLocalViewDiskPair } from 'nebulosa/src/astronomy/events/eclipse/solar/local'
import { computePolynomialBesselianElements } from 'nebulosa/src/astronomy/events/eclipse/solar/map'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

// The total solar eclipse of 8 April 2024, seen from Dallas.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)
const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
const circumstances = computeLocalSolarEclipseCircumstances(pbe, deg(-96.797), deg(32.776), { sunMoonPosition })

const view = computeLocalSolarEclipseViewGeometry(circumstances)
console.log(view.width, view.height, view.orientationMode, view.requestedEvent, view.selectedEvent, view.solarRadiusPx) // 450 160 zenith MAX MAX 34
console.log(view.shapes.map((shape) => `${shape.kind}:${shape.role}`).join(' '))
// circle:ghostMoonDisk ×4 circle:sunDisk circle:moonDisk polygon:horizonBand line:horizonLine

for (const shape of view.shapes) {
	if (shape.kind === 'circle') console.log(shape.role, shape.event, shape.cx.toFixed(2), shape.cy.toFixed(2), shape.r.toFixed(2))
}
// ghostMoonDisk C1 180.57 133.97 35.90
// ghostMoonDisk C2 224.55 81.86 35.91
// ghostMoonDisk C3 226.77 79.27 35.91
// ghostMoonDisk C4 272.12 28.42 35.86
// sunDisk MAX 225.00 80.00 34.00
// moonDisk MAX 225.66 80.56 35.91 — the Moon is 5.6% larger than the Sun and almost centered

// Totality begins: the sky-north orientation, east to the left, with no ghosts and no horizon.
const north = computeLocalSolarEclipseViewGeometry(circumstances, { selectedEvent: 'C2', orientationMode: 'north', handedness: 'eastLeft', includeGhostDisks: false, includeHorizon: false })
console.log(north.shapes.map((shape) => `${shape.kind}:${shape.role}`).join(' '), north.selectedEvent) // circle:sunDisk circle:moonDisk C2

// A site outside the path has no C2: asking for it falls back to the maximum.
const partial = computeLocalSolarEclipseCircumstances(pbe, deg(-74.006), deg(40.713), { sunMoonPosition })
const fallback = computeLocalSolarEclipseViewGeometry(partial, { selectedEvent: 'C2' })
console.log(fallback.requestedEvent, fallback.selectedEvent) // C2 MAX

// With no events there is nothing to draw.
const empty = computeLocalSolarEclipseViewGeometry({ events: {} })
console.log(empty.selectedEvent, empty.shapes.length) // undefined 0

// The pieces: the disks of the start of totality in the frame of the maximum, and its horizon.
const options = { width: 450, height: 160, selectedEvent: 'MAX', orientationMode: 'zenith', solarRadiusPx: 34, includeGhostDisks: true, includeHorizon: true } as const
const pair = computeLocalViewDiskPair(circumstances.events.C2!, options, circumstances.events.MAX!)
console.log(pair.sun.cx, pair.sun.cy, pair.moon.cx.toFixed(2), pair.moon.cy.toFixed(2), pair.moon.r.toFixed(2)) // 225 80 224.55 81.86 35.91
console.log(buildLocalViewHorizonGeometry(circumstances.events.MAX!, options).map((shape) => `${shape.kind}:${shape.role}`)) // [ 'polygon:horizonBand', 'line:horizonLine' ]
```

### Local Standard of Rest Frames

The Local Standard of Rest (LSR) is the reference frame in which the average motion of nearby stars is zero. Velocities relative to the Sun, in ICRS, are converted to it by adding the Sun's peculiar motion. Only velocities change: LSR frames have the ICRS origin, so positions are unchanged, apart from the Galactic variant, which also rotates the axes.

`lsrFrame(solarVelocity?)` is the standard LSR. `solarVelocity` is the Sun's peculiar velocity relative to the LSR in Galactic Cartesian (U, V, W), AU/day, and defaults to `LSR_DEFAULT_SOLAR_VELOCITY` = (11.1, 12.24, 7.25) km/s (Schönrich, Binney and Dehnen 2010). `lsrdFrame()` is the dynamical LSR with the Delhaye (1965) motion (9, 12, 7) km/s. `lsrkFrame()` is the kinematic LSR with the solar-apex motion of about 20 km/s defined in ICRS axes. `galacticLsrFrame(solarVelocity?)` is the LSR expressed in Galactic axes: positions are rotated into Galactic Cartesian and velocities gain the same offset as `lsrFrame`. All four return an `AffineFrame` for `affineFromBase`, `affineToBase`, and `affineToAffine`; see Affine Origin Frames. Pass full `[position, velocity]` states in AU and AU/day (`kilometerPerSecond` converts km/s).

```ts
import { affineFromBase, galacticLsrFrame, lsrdFrame, lsrFrame, lsrkFrame } from 'nebulosa/src/astronomy/coordinates/affine'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { ONE_PARSEC } from 'nebulosa/src/core/constants'
import { kilometerPerSecond, toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.UTC)

// ICRS state: position 100, 200, 50 pc (in AU); velocity 10, -20, 5 km/s (in AU/day).
const state = [
	[100 * ONE_PARSEC, 200 * ONE_PARSEC, 50 * ONE_PARSEC],
	[kilometerPerSecond(10), kilometerPerSecond(-20), kilometerPerSecond(5)],
] as const

const [position, velocity] = affineFromBase(state, lsrFrame(), time)

console.log(position.map((x) => x / ONE_PARSEC)) // [100, 200, 50] — pc, unchanged
console.log(velocity.map(toKilometerPerSecond)) // [9.148, -36.576, 12.078] — km/s, ICRS velocity plus the Sun's motion

console.log(affineFromBase(state, lsrdFrame(), time)[1].map(toKilometerPerSecond)) // [9.362, -34.585, 12.801] — km/s, dynamical
console.log(affineFromBase(state, lsrkFrame(), time)[1].map(toKilometerPerSecond)) // [10.290, -37.317, 15.001] — km/s, kinematic

// The same offset in Galactic axes: position rotated, velocity offset as for lsrFrame.
const [galacticPosition, galacticVelocity] = affineFromBase(state, galacticLsrFrame(), time)

console.log(galacticPosition.map((x) => x / ONE_PARSEC)) // [-204.37, -2.206, -103.58] — pc, Galactic axes
console.log(galacticVelocity.map(toKilometerPerSecond)) // [25.601, 29.813, 4.815] — km/s
```

### Local Taki Frames

The Taki frame is a local equatorial frame used for polar-aligned mounts and pointing models. Its axes are fixed to the observer's meridian and the celestial pole: +x points to the meridian toward the south, +y east, and +z toward the north celestial pole. A direction with west-positive hour angle `H` and declination `δ` is `[cos δ cos H, −cos δ sin H, sin δ]` in it, so the hour angle appears as a polar longitude of `−H`. Unlike the apparent equatorial frame, it does not depend on the sidereal time: it rotates with the Earth, and the target moves through it as the hour angle advances.

`takiToEnuMatrix(latitude, out?)` returns the 3×3 rotation taking a Taki vector to East-North-Up (see Local ENU Frames), and `enuToTakiMatrix(latitude, out?)` is its exact transpose. `latitude` is geodetic, in radians, and `out` receives the result and is returned. These are pure rotations with no refraction or place corrections; at a pole (`latitude = ±π/2`) the Taki frame degenerates into the ENU axes.

```ts
import { enuToTakiMatrix, takiToEnuMatrix } from 'nebulosa/src/astronomy/coordinates/frame.local'
import { matMulVec } from 'nebulosa/src/math/linear-algebra/mat3'
import { deg, hour } from 'nebulosa/src/math/units/angle'

const latitude = deg(-29.2563)

// A target at RA 16 h, Dec -26° when the local sidereal time is 17.7685 h: hour angle +1.7685 h, west of the meridian.
const hourAngle = hour(17.7685) - hour(16)
const declination = deg(-26)
const taki = [Math.cos(declination) * Math.cos(hourAngle), -Math.cos(declination) * Math.sin(hourAngle), Math.sin(declination)] as const

console.log(taki) // [0.8042, -0.4014, -0.4384] — meridian-south, east, north pole

// To ENU: the same direction as horizontalToEnuVector(azimuth 271.51°, altitude 66.32°).
const enu = matMulVec(takiToEnuMatrix(latitude), taki)

console.log(enu) // [-0.4014, 0.01056, 0.9158] — east, north, up

// And back.
console.log(matMulVec(enuToTakiMatrix(latitude), enu)) // [0.8042, -0.4014, -0.4384]
```

### Location GCRS Frame

`gcrs(location)` builds a `Frame` whose axes are the local altazimuth axes of a site, expressed relative to the geocentric celestial frame: it rotates a geocentric (GCRS/ICRS-oriented) vector by the Earth's orientation at the instant (precession, nutation, rotation, polar motion) and then into the site's local altazimuth axes. The frame rotates with the Earth, so a full `[position, velocity]` state also receives the rotating-frame term from the instantaneous Earth angular velocity.

Use it with the frame functions (`frameAt`, `frameToFrame`, see Celestial and Terrestrial Reference Frames) to express geocentric vectors in a site's horizon axes. `gcrsRotationAt(location, time)` returns just the 3×3 rotation, as a fresh matrix, and does not mutate the cached GCRS-to-ITRS matrix of the time. This is geometry only, with no refraction, aberration, or origin shift: a geocentric vector stays geocentric, so subtract the observer's position first for topocentric directions, or use Topocentric Observed Place for a full observed place.

```ts
import { frameAt } from 'nebulosa/src/astronomy/coordinates/frame'
import { gcrs, gcrsRotationAt, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)
const frame = gcrs(site)

// A unit direction (RA 200°, Dec 30°) in the site's local axes.
const direction = [Math.cos(deg(30)) * Math.cos(deg(200)), Math.cos(deg(30)) * Math.sin(deg(200)), Math.sin(deg(30))] as const

console.log(frameAt(direction, frame, time)) // [0.6053, -0.7936, 0.0618] — local-axes components

// A state: the Earth's rotation adds the transport term to the velocity.
const [position, velocity] = frameAt([direction, [0, 0, 0]] as const, frame, time)

console.log(position) // [0.6053, -0.7936, 0.0618]
console.log(velocity) // [-2.4435, -2.2038, -4.3621] — per day, from the rotating frame

console.log(gcrsRotationAt(site, time)) // 3x3 row-major rotation, the matrix applied by frameAt
```

### Low-Precision Earth Ephemeris

`eraEpv00(tdb1, tdb2, out?)` is the ERFA port of Bretagnon's simplified VSOP2000 model of the Earth. It returns two `PositionAndVelocityMut` states, in this order: the barycentric one, relative to the Solar System barycenter, and the heliocentric one, relative to the Sun. Positions are in AU, velocities in AU/day, in BCRS-oriented axes (the analytical model is rotated onto DE405). It is a harmonic series, not a JPL kernel, so it is approximate and fast, and it is best used where the full precision of VSOP87E or an SPK kernel is not needed, for example in the aberration and light-deflection terms of the apparent-place pipeline.

The date is a two-part TDB Julian date, `tdb1 + tdb2`, with any split (`tdb1` is often `2400000.5` or `2451545` and `tdb2` the remainder). Time in the series is Julian years from J2000. Pass an `out` pair `[barycentric, heliocentric]` of `PositionAndVelocityMut` to avoid allocation: it is filled, returned, and aliased by the result.

```ts
import { eraEpv00 } from 'nebulosa/src/astronomy/coordinates/erfa/earth'
import { zeroPositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'

// The SOFA test epoch: JD 2400000.5 + 53411.52501161 TDB.
const [barycentric, heliocentric] = eraEpv00(2400000.5, 53411.52501161)
console.log(barycentric[0]) // [−0.77141, 0.55984, 0.24260] AU
console.log(barycentric[1]) // [−0.010919, −0.012465, −0.0054048] AU/day
console.log(heliocentric[0]) // [−0.77572, 0.55981, 0.24270] AU
console.log(Math.hypot(...barycentric[0]), Math.hypot(...heliocentric[0])) // 0.98354 0.98693 — AU

// The Sun-to-barycenter offset is the difference between the two (about 0.004 AU here).
console.log(barycentric[0][0] - heliocentric[0][0]) // 0.0043134

// A reusable workspace: the returned pair is the one passed in.
const out = [zeroPositionAndVelocity(), zeroPositionAndVelocity()] as const
console.log(eraEpv00(2451545, 0, out) === out) // true
```

### Low-Precision Lunar Ephemeris

`eraMoon98(tt1, tt2, out?)` is the ERFA port of the low-precision lunar theory, an ELP-based series with the additive terms of Meeus' _Astronomical Algorithms_: the Moon's geocentric position and velocity from a short series in the mean arguments of the lunar orbit. The date is a two-part Terrestrial Time Julian date `tt1 + tt2`. The result is a `PositionAndVelocityMut` in AU and AU/day, aligned with ICRS (the series is rotated through the IAU 2006 precession and frame bias), so it is the geocentric vector to the Moon with no light time and no aberration. It is an approximation intended for eclipse screening and similar uses where the precision of a JPL kernel is not needed.

The optional `out` receives the result and is returned. The returned object is aliased to `out`, and a fresh state is allocated when it is omitted.

```ts
import { eraMoon98 } from 'nebulosa/src/astronomy/coordinates/erfa/moon'
import { zeroPositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { AU_KM, DAYSEC } from 'nebulosa/src/core/constants'

// The SOFA test epoch: JD 2400000.5 + 43999.9 TT.
const [position, velocity] = eraMoon98(2400000.5, 43999.9)
console.log(position) // [−0.0026013, 0.00061398, 0.00026408] AU
console.log(velocity) // [−0.00012443, −0.00052191, −0.00017161] AU/day
console.log(Math.hypot(...position) * AU_KM) // 401787.8 — km, geocentric distance
console.log((Math.hypot(...velocity) * AU_KM) / DAYSEC) // 0.97535 — km/s

// Reuse a workspace.
const out = zeroPositionAndVelocity()
console.log(eraMoon98(2451545, 0, out) === out) // true
```

### Lunar Apsides

The Moon's orbit is an ellipse, so its distance from the Earth changes each month between perigee, the closest point, and apogee, the farthest. They vary from month to month, with perigee distances from about 356,400 km to 370,400 km and apogee from 404,000 km to 406,700 km. A full Moon at perigee is the popular supermoon.

`nearestLunarApsis(time, apsis, next)` finds the previous or next perigee or apogee by Meeus's chapter 50 series with its periodic corrections. `apsis` is `'PERIGEE'` or `'APOGEE'`, and `next` selects the first event strictly after `time` when true, or the last one at or before it when false. It returns `[instant, distance, diameter]`: a fresh TT `Time`, the geocentric Earth-Moon distance in AU, and the Moon's apparent angular diameter in radians. `nearestMeanLunarApsis(time, apsis, next)` gives only the mean apsis instant, without the periodic corrections, as a fresh TT `Time`; it can differ from the true one by up to about a day. Results are accurate to a few minutes in time near the modern epoch. All times are TT: convert with `utc` for a civil clock time. The distance converts to a parallax with `moonParallax` (see Lunar Parallax and Semidiameter).

```ts
import { nearestLunarApsis, nearestMeanLunarApsis } from 'nebulosa/src/astronomy/bodies/moon'
import { Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toArcsec } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const start = timeYMDHMS(2026, 1, 1, 0, 0, 0, Timescale.UTC)

// The next perigee after the start.
const [time, distance, diameter] = nearestLunarApsis(start, 'PERIGEE', true)

console.log(timeToDate(time).slice(0, 5)) // [2026, 1, 1, 21, 44] — TT
console.log(toKilometer(distance)) // 360347 — km
console.log(toArcsec(diameter)) // 1989.6 — arcseconds, the Moon's apparent diameter

// The next apogee, and the previous one counted from just after it.
const [apogee, apogeeDistance] = nearestLunarApsis(start, 'APOGEE', true)

console.log(timeToDate(apogee).slice(0, 5), toKilometer(apogeeDistance)) // [2026, 1, 13, 20, 48] 405436
console.log(timeToDate(nearestLunarApsis(timeYMDHMS(2026, 1, 13, 20, 50, 0, Timescale.TT), 'APOGEE', false)[0]).slice(0, 5)) // [2026, 1, 13, 20, 48] — the same event

// The next mean perigee after the start, without the periodic corrections: it can be hours away from the true one.
console.log(timeToDate(nearestMeanLunarApsis(start, 'PERIGEE', true)).slice(0, 5)) // [2026, 1, 28, 1, 3] — TT
```

### Lunar Declination Extrema and Standstills

The Moon's declination swings between a northern and a southern maximum every month, about 13.7 days apart. The size of the swing changes over the 18.6-year cycle of the lunar nodes: at a major lunar standstill the monthly extremes reach about ±28.6° (the obliquity plus the Moon's orbital inclination), and at a minor standstill only about ±18.3° (the obliquity minus the inclination). The standstills matter for the rising and setting azimuths of the Moon, and in archaeoastronomy.

`nearestMaxDeclination(time, declination, next)` finds the previous or next monthly extreme, with `declination` `'NORTH'` or `'SOUTH'`, from Meeus's chapter 52 series. It returns `[instant, declination]`: a fresh TT `Time` and the geocentric declination in radians, positive for a northern maximum and negative for a southern one. `nearestLunarStandstill(time, standstill, declination, next)` finds the previous or next major or minor standstill (`'MAJOR'` or `'MINOR'`) for one hemisphere, as the extreme monthly maximum of the 18.6-year envelope, and returns the same pair; query each hemisphere separately, since the northern and southern ones fall a couple of weeks apart. `next` selects strictly after `time` when true, and at or before it when false. The declination is the mean geocentric value of a truncated series, accurate to a few arcminutes with times good to about 20 minutes, and applies neither nutation nor topocentric parallax.

```ts
import { nearestLunarStandstill, nearestMaxDeclination } from 'nebulosa/src/astronomy/bodies/moon'
import { Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2025, 3, 1, 0, 0, 0, Timescale.UTC)

// The next northern and southern monthly maxima.
const [north, northDeclination] = nearestMaxDeclination(start, 'NORTH', true)
const [south, southDeclination] = nearestMaxDeclination(start, 'SOUTH', true)

console.log(timeToDate(north).slice(0, 5), toDeg(northDeclination)) // [2025, 3, 7, 15, 57] 28.71 — TT, degrees
console.log(timeToDate(south).slice(0, 5), toDeg(southDeclination)) // [2025, 3, 22, 6, 48] -28.72

// The major standstill of the current cycle: the largest monthly maximum, near +28.7°.
const [major, majorDeclination] = nearestLunarStandstill(timeYMDHMS(2024, 1, 1, 0, 0, 0, Timescale.UTC), 'MAJOR', 'NORTH', true)

console.log(timeToDate(major).slice(0, 5), toDeg(majorDeclination)) // [2025, 3, 7, 15, 57] 28.71

// The minor standstill of the 2015 cycle: the smallest monthly maximum, near +18.1°.
const [minor, minorDeclination] = nearestLunarStandstill(timeYMDHMS(2014, 1, 1, 0, 0, 0, Timescale.UTC), 'MINOR', 'NORTH', true)

console.log(timeToDate(minor).slice(0, 5), toDeg(minorDeclination)) // [2015, 10, 3, 23, 55] 18.14

// The next major standstill, one nodal cycle later.
console.log(timeToDate(nearestLunarStandstill(timeYMDHMS(2025, 4, 1, 0, 0, 0, Timescale.UTC), 'MAJOR', 'NORTH', true)[0]).slice(0, 5)) // [2043, 9, 25, 14, 43]
```

### Lunar Eclipse Local Circumstances

A lunar eclipse happens on the Moon, so its contact instants (P1, U1, U2, MAX, U3, U4, P4) are the same for every observer. What changes with the site is whether the Moon is above the horizon at each contact and during the phases, the Moon's altitude and azimuth, and the orientation of the contact point on the lunar limb. `computeLocalLunarEclipseCircumstances(eclipse, longitude, latitude, sunMoonPosition, options?)` computes those local circumstances from a `LunarEclipse` (see Lunar Eclipse Search) and a Sun/Moon position provider such as `sunMoonPosition`, the analytical ERFA/Meeus ephemeris. `longitude` is east-positive and `latitude` is geodetic, both in radians. It does not rebuild the global geometry.

The result has a `location`, a `visibility`, the `details` and the `events`. Each entry of `events` is keyed by contact kind and exists only for the contacts that the eclipse type has (three for a penumbral eclipse, five for a partial one, seven for a total one). An event carries its TT `time` and Julian Day `jd`, the topocentric `altitude` and `azimuth` of the Moon's center (diurnal parallax is applied, refraction is not; azimuth from north through east), an `observable` flag (`altitude` at or above the horizon), the `positionAngle` of the contact point on the lunar limb (north through east, `[0, 2π)`, the P angle of the contact tables), the `zenithAngle` of the same point measured from the local zenith (the Z angle), and the `umbralMagnitude` and `penumbralMagnitude` at that instant. At the internal contacts U2 and U3 of a total eclipse the contact point is on the far side of the disk from the shadow center, so P is rotated by π there. The umbral magnitude is 0 at U1/U4, 1 at U2/U3, and negative when the Moon is wholly outside the umbra (at P1/P4).

`visibility.kind` is one of `'notVisible'`, `'penumbralOnlyVisible'`, `'partialVisible'`, `'totalVisible'`, `'completelyVisible'` or `'geometricOnlyBelowHorizon'`, with `visibility.text` as a description and the flags `hasGeometricEclipse` and `hasObservableEclipse`. The classification does not rely only on the contacts: the altitude is also sampled across the penumbral interval, so a Moon that rises or sets in the middle of the eclipse is reported as visible for the part that is above the horizon, and `completelyVisible` requires the Moon to stay above the horizon for the whole of P1 to P4. `details` has the durations of the phases in seconds (`penumbralPhaseDuration`, and `partialPhaseDuration` and `totalPhaseDuration` when they exist), the maximal magnitudes (`maximalUmbralMagnitude` is `undefined` for a penumbral eclipse), and `observableDuration`, the time in seconds the Moon is above the horizon between P1 and P4.

`options.horizonAltitude` (radians, default 0) is the altitude the Moon must reach to count as observable, for example a raised horizon, and `options.altitudeSamples` (default 48 across the penumbral phase) sets the sampling of the altitude scan; a stretch above the horizon that is shorter than one sample can be missed at a coarse sampling. `moonAltitudeAt(time, longitude, latitude, sunMoonPosition)` gives the topocentric altitude of the Moon's center at one instant, in radians, and `localLunarVisibilityText(kind)` returns the description of a classification.

```ts
import { nearestLunarEclipse } from 'nebulosa/src/astronomy/bodies/moon'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeLocalLunarEclipseCircumstances, localLunarVisibilityText, moonAltitudeAt } from 'nebulosa/src/astronomy/events/eclipse/lunar/local'
import { Timescale, timeToDate, timeYMDHMS, utc, type Time } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

// The total lunar eclipse of 7 September 2025.
const eclipse = nearestLunarEclipse(timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.UTC), true)

// Perth (115.86°E, 31.95°S): the Moon is high in the sky during the whole eclipse.
const perth = computeLocalLunarEclipseCircumstances(eclipse, deg(115.86), deg(-31.95), sunMoonPosition)
console.log(perth.visibility.kind, perth.visibility.text) // completelyVisible Entire eclipse visible
console.log(perth.details.totalPhaseDuration, perth.details.observableDuration) // 4887.64 19477.89 — seconds

const max = perth.events.MAX!
console.log(format(max.time), max.observable) // 2025-9-7-18-12-2 true
console.log(toDeg(max.altitude), toDeg(max.azimuth)) // 51.72 307.32
console.log(toDeg(max.positionAngle), toDeg(max.zenithAngle)) // 330.93 193.62 — the P and Z angles of the contact point
console.log(max.umbralMagnitude, max.penumbralMagnitude) // 1.3606 2.3430

// São Paulo: the Moon is below the horizon during every contact, so the eclipse is only geometric.
const saoPaulo = computeLocalLunarEclipseCircumstances(eclipse, deg(-46.6333), deg(-23.55), sunMoonPosition)
console.log(saoPaulo.visibility.kind, saoPaulo.details.observableDuration) // geometricOnlyBelowHorizon 0
console.log(toDeg(saoPaulo.events.MAX!.altitude)) // -36.44
console.log(toDeg(moonAltitudeAt(eclipse.maximalTime, deg(-46.6333), deg(-23.55), sunMoonPosition))) // -36.44

// Greenwich: the Moon rises during the eclipse, so the last part of totality and the last partial phase are seen.
const greenwich = computeLocalLunarEclipseCircumstances(eclipse, 0, deg(51.48), sunMoonPosition)
console.log(greenwich.visibility.kind, greenwich.details.observableDuration) // totalVisible 8332.34
console.log(
	Object.entries(greenwich.events)
		.map(([kind, event]) => `${kind}:${event.observable}`)
		.join(' '),
) // P1:false U1:false U2:false MAX:false U3:true U4:true P4:true

// With a 10° horizon the same site keeps only the last partial phase.
const raised = computeLocalLunarEclipseCircumstances(eclipse, 0, deg(51.48), sunMoonPosition, { horizonAltitude: deg(10), altitudeSamples: 96 })
console.log(raised.visibility.kind) // partialVisible

console.log(localLunarVisibilityText('penumbralOnlyVisible')) // Only the penumbral phase visible
```

### Lunar Eclipse Map SVG Paths

`lunarEclipseMapToSvgPaths(geometry, projection, options?)` turns the geometry of Lunar Eclipse Visibility Geometry into SVG path data: one string for the moonrise/moonset curve of each contact, and the projected sublunar point of each contact. `projection` is any `CylindricalProjection` (for example `PlateCarree`), and the geometry itself is never modified. The curves are projected and split at the antimeridian only here, so a ring that crosses it becomes two subpaths (`M…` commands) instead of a line across the whole map.

The result has `moonRiseSet`, with one string per contact `P1`, `U1`, `U2`, `MAX`, `U3`, `U4` and `P4` (an empty string for a contact that the eclipse does not have, for example `U2` of a penumbral eclipse), and `sublunarPoints`, the projected sublunar point of each existing contact (a missing key for a contact that does not exist or that falls outside the projection). The coordinates are those of the projection: with `PlateCarree`, `x` is the longitude and `y` the latitude, multiplied by the projection `scale`, with north up. SVG `y` grows downward, so pass `yAxisDirection: 'southUp'` in the projection options to get SVG axes, and `centralMeridian` to center the map on another longitude.

`options.precision` is the number of decimals of the path coordinates (default 2), and `options.projectionOptions` are applied to the curves and to the sublunar points, on top of those of the projection. With `options.fill` the strings are closed region polygons instead of open curves, for shading: `options.fillRegion` selects the `'belowHorizon'` (default, the region where the Moon is down) or `'aboveHorizon'` side, and the paths must be rendered with `fill-rule="evenodd"`, because the complement of a cap that does not enclose a pole is the map rectangle with the cap punched out. The fill assumes a cylindrical projection over the full longitude range that can show the ±90° latitude edges (such as `PlateCarree`); when the cap encloses a pole, as it usually does, the region is closed along that pole's edge of the map, and when it encloses neither pole (a near-equatorial eclipse, with the declination smaller than the parallax) the cap ring is filled directly.

```ts
import { nearestLunarEclipse } from 'nebulosa/src/astronomy/bodies/moon'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeLunarEclipseMapGeometry, lunarEclipseMapToSvgPaths } from 'nebulosa/src/astronomy/events/eclipse/lunar/map'
import { PlateCarree } from 'nebulosa/src/astronomy/projections/projection'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

// The total lunar eclipse of 7 September 2025, on a map 100 pixels per radian wide, SVG axes (y down).
const eclipse = nearestLunarEclipse(timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.UTC), true)
const geometry = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition)
const projection = new PlateCarree(0, { scale: 100, yAxisDirection: 'southUp' })

const paths = lunarEclipseMapToSvgPaths(geometry, projection)
console.log(paths.sublunarPoints.MAX) // { x: 151.17, y: 10.47 } — greatest eclipse, the Moon is at the zenith there
console.log(paths.moonRiseSet.MAX.slice(0, 59)) // M151.17 -144.88L165.41 -144.76L179.1 -144.39L191.82 -143.81
console.log(
	Object.entries(paths.moonRiseSet)
		.map(([kind, d]) => `${kind}:${d.match(/M/g)?.length}`)
		.join(' '),
) // P1:2 U1:2 U2:2 MAX:2 U3:2 U4:2 P4:2 — every ring is split once at the antimeridian

// A closed region polygon for shading, with coordinates of one decimal place.
const filled = lunarEclipseMapToSvgPaths(geometry, projection, { fill: true, precision: 1 })
console.log(filled.moonRiseSet.MAX.slice(0, 44), filled.moonRiseSet.MAX.endsWith('Z')) // M-314.1 66.1L-313.8 67.8L-313.6 69.6L-313.3 true
console.log(lunarEclipseMapToSvgPaths(geometry, projection, { fill: true, fillRegion: 'aboveHorizon' }).moonRiseSet.MAX.length > 0) // true

// A map centered on 90°E: the sublunar point at greatest eclipse (86.6°E) is now close to the center, at x = -5.91.
const shifted = lunarEclipseMapToSvgPaths(geometry, new PlateCarree(0, { scale: 100 }), { projectionOptions: { centralMeridian: deg(90) } })
console.log(shifted.sublunarPoints.MAX) // { x: -5.91, y: -10.47 } — north up, so y is the latitude

// A penumbral eclipse has no umbral contacts: their paths are empty.
const penumbral = nearestLunarEclipse(timeYMDHMS(2027, 2, 1, 0, 0, 0, Timescale.UTC), true)
const empty = lunarEclipseMapToSvgPaths(computeLunarEclipseMapGeometry(penumbral, sunMoonPosition), projection)
console.log(Object.keys(empty.sublunarPoints), empty.moonRiseSet.U1 === '') // ['P1', 'MAX', 'P4'] true
```

### Lunar Eclipse Search

A lunar eclipse happens when the Moon passes through the Earth's shadow at full moon: totally if it enters the dark umbra completely, partially if only a part, and as a penumbral eclipse if it passes only through the faint outer shadow. An eclipse is seen from everywhere the Moon is above the horizon, and the circumstances do not depend on the observer: they are the instants of the contacts and the eclipse magnitude. For the view from a given site see Local Lunar Eclipse Search.

`nearestLunarEclipse(time, next)` finds the previous or next lunar eclipse with Meeus's chapter 54 method. `next` selects the first eclipse strictly after `time` when true, and the last at or before it when false. It returns a `LunarEclipse` with the Meeus `lunation` index and the `type` (`'TOTAL'`, `'PARTIAL'`, or `'PENUMBRAL'`). All times are TT `Time`s: `maximalTime` (greatest eclipse), `firstContactPenumbraTime` (P1), `firstContactUmbraTime` (U1), `totalBeginTime` (U2), `totalEndTime` (U3), `lastContactUmbraTime` (U4), and `lastContactPenumbraTime` (P4). The contacts that do not exist for the type (no umbral phase for a penumbral eclipse, no totality unless total) are the sentinel `Time` whose `day` is 0. Also `magnitude` (the umbral magnitude, or the penumbral one for a penumbral eclipse), `gamma` (the least distance of the Moon's center from the shadow axis, in equatorial Earth radii, signed by the side of the axis), the shadow radii `sigma` (umbra) and `rho` (penumbra) in Earth radii, and the half-durations `sdPenumbra`, `sdPartial`, and `sdTotal` in days, which are `NaN` when the phase does not occur. Convert the times with `utc` for civil UTC.

```ts
import { nearestLunarEclipse } from 'nebulosa/src/astronomy/bodies/moon'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'

const fmt = (time: ReturnType<typeof nearestLunarEclipse>['maximalTime']) => timeToDate(utc(time)).slice(0, 5)

// The first lunar eclipse after 1 September 2025: the total eclipse of 7 September.
const eclipse = nearestLunarEclipse(timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.UTC), true)

console.log(eclipse.type) // TOTAL
console.log(fmt(eclipse.firstContactPenumbraTime)) // [2025, 9, 7, 15, 29] — P1, UTC
console.log(fmt(eclipse.firstContactUmbraTime)) // [2025, 9, 7, 16, 28] — U1
console.log(fmt(eclipse.totalBeginTime)) // [2025, 9, 7, 17, 31] — U2
console.log(fmt(eclipse.maximalTime)) // [2025, 9, 7, 18, 12] — greatest eclipse
console.log(fmt(eclipse.totalEndTime)) // [2025, 9, 7, 18, 52] — U3
console.log(fmt(eclipse.lastContactUmbraTime)) // [2025, 9, 7, 19, 56] — U4
console.log(fmt(eclipse.lastContactPenumbraTime)) // [2025, 9, 7, 20, 54] — P4

console.log(eclipse.magnitude) // 1.3606 — umbral magnitude
console.log(eclipse.gamma) // -0.2758 — Earth radii, the Moon passes south of the shadow axis' center
console.log(eclipse.sdTotal * 1440) // 40.7 — minutes, half the duration of totality (81 min in total)

// A penumbral eclipse has no umbral contacts: their day is 0, and the umbral durations are NaN.
const penumbral = nearestLunarEclipse(timeYMDHMS(1973, 6, 1, 0, 0, 0, Timescale.UTC), true)

console.log(penumbral.type, penumbral.firstContactUmbraTime.day, penumbral.sdPartial) // PENUMBRAL 0 NaN
```

### Lunar Eclipse Visibility Geometry

A map of a lunar eclipse cannot show a shadow on the ground, because the shadow falls on the Moon. What a map can show is where on the Earth the Moon is up. For each contact of the eclipse, the boundary between the hemisphere that sees the Moon above the horizon and the one that does not is a small circle centered on the sublunar point, the place where the Moon is at the zenith (latitude equal to the Moon's declination, longitude equal to its right ascension minus Greenwich apparent sidereal time). `computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, options?)` computes those circles, and `lunarEclipseEvents(eclipse)` returns the contacts that the eclipse has. Projecting the curves to a map is the subject of Lunar Eclipse Map SVG Paths.

`lunarEclipseEvents` returns the existing contacts in chronological order as `LunarEclipseContact`s, each with its `kind` (`'P1'`, `'U1'`, `'U2'`, `'MAX'`, `'U3'`, `'U4'` or `'P4'`), its TT `time` and its Julian Day `jd`: P1, MAX and P4 for a penumbral eclipse, adding U1 and U4 for a partial one, and U2 and U3 for a total one. The radius of the circle is not the geocentric 90° of the horizon: the observer is on the surface, so the Moon seen on the horizon is lower in the sky than its geocentric direction by the lunar parallax, and the circle radius is `π/2 − h0 − asin(cos h0 / d)`, with `h0` the horizon altitude and `d` the Moon distance in Earth radii (about 0.95° smaller than the bare 90°). The observer is treated as spherical, with a geocentric radius of one equatorial Earth radius.

`computeLunarEclipseMapGeometry` returns the `eclipse`, the `events` and `lines.moonRiseSet`. Each `LunarEclipseMapEvent` adds the apparent geocentric Moon `rightAscension` and `declination`, the `gast` (all in radians), the `distance` (Earth equatorial radii), the effective `horizonAltitude` (radians) of that contact, and the `sublunar` point as an `EclipseGeoPoint`, whose `x` is the east-positive longitude in `[−π, π]` and `y` the latitude, in radians. `lines.moonRiseSet` has one curve per existing contact (`P1` to `P4`): a curve is a list of branches of `EclipseGeoPoint`s (one closed ring here, with its first point repeated at the end) that is still in geographic coordinates and is not split at the antimeridian yet.

`options.maxAngularStep` (radians, default 1°) is the target spacing of the points along the circle, `options.horizonAltitude` (radians, default 0) is the altitude of the visibility horizon for the Moon's center, `options.refraction` (default false) lowers that horizon by the standard 34′ of refraction at the horizon, and `options.limbVisibility` is `'center'` (default) to mark where the Moon's center is on the horizon or `'upperLimb'` to mark where its upper limb is, which lowers the horizon by the Moon's apparent semidiameter at that contact. `MOON_RADIUS_EARTH_RADII` is the lunar radius in equatorial Earth radii, 0.2725076, and the sampler is a `SunMoonProvider` such as `sunMoonPosition`.

```ts
import { nearestLunarEclipse } from 'nebulosa/src/astronomy/bodies/moon'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computeLunarEclipseMapGeometry, lunarEclipseEvents, MOON_RADIUS_EARTH_RADII } from 'nebulosa/src/astronomy/events/eclipse/lunar/map'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// The total lunar eclipse of 7 September 2025.
const eclipse = nearestLunarEclipse(timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.UTC), true)

for (const contact of lunarEclipseEvents(eclipse)) console.log(contact.kind, timeToDate(utc(contact.time)).slice(0, 6).join('-'), contact.jd)
// P1 2025-9-7-15-29-43 2460926.1464
// U1 2025-9-7-16-28-1 2460926.1869
// U2 2025-9-7-17-31-18 2460926.2309
// MAX 2025-9-7-18-12-2 2460926.2592
// U3 2025-9-7-18-52-45 2460926.2874
// U4 2025-9-7-19-56-3 2460926.3314
// P4 2025-9-7-20-54-21 2460926.3719

const geometry = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition)

const max = geometry.events.find((event) => event.kind === 'MAX')!
console.log(toDeg(max.rightAscension), toDeg(max.declination), toDeg(max.gast)) // -13.33 -6.00 260.06 — the right ascension is 346.67° (−13.33°)
console.log(max.distance, max.horizonAltitude) // 57.958 0
console.log(toDeg(max.sublunar.x), toDeg(max.sublunar.y)) // 86.61 -6.00 — the Moon is at the zenith there at greatest eclipse

// One closed ring of 361 points at 1° spacing; the first and the last coincide.
const [ring] = geometry.lines.moonRiseSet.MAX!
console.log(ring.length, ring[0].x === ring[360].x && ring[0].y === ring[360].y) // 361 true
console.log(ring[0], ring[0].jd === max.jd) // { x: 1.5117, y: 1.4488, jd: 2460926.2592 } true — due north of the sublunar point, 89.0° away

// Coarser spacing, the horizon lowered by refraction and the upper limb instead of the center.
const coarse = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, { maxAngularStep: deg(10) })
console.log(coarse.lines.moonRiseSet.MAX![0].length) // 37

const refracted = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, { refraction: true })
console.log(toDeg(refracted.events[3].horizonAltitude)) // -0.5667 — 34′

const limb = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, { limbVisibility: 'upperLimb' })
console.log(toDeg(limb.events[3].horizonAltitude)) // -0.2694 — the semidiameter of the Moon at that distance

const raised = computeLunarEclipseMapGeometry(eclipse, sunMoonPosition, { horizonAltitude: deg(10) })
console.log(raised.events[3].horizonAltitude) // 0.1745

console.log(MOON_RADIUS_EARTH_RADII) // 0.2725076
```

### Lunar Libration Extrema

The Moon always shows nearly the same face to the Earth, but it seems to nod and sway by a few degrees. Optical libration makes this: the sub-Earth point on the lunar surface wanders in longitude (an east-west sway from the eccentric orbit, up to about 8°) and in latitude (a north-south nod from the tilt of the lunar equator, up to about 7°). Knowing when each reaches an extreme tells you when the limb regions are best seen.

`lunarLibrationExtrema(moonToObserverAt, start, stop, options?)` returns the local extrema of both angles as chronological `{ axis, kind, time, angle }`. `axis` is `'longitude'` (east-positive) or `'latitude'` (north-positive) of the sub-observer point, `kind` is `'minimum'` or `'maximum'`, and `angle` is the signed libration in radians. `moonToObserverAt` returns the Moon-center-to-observer vector in AU in ICRF axes, which also sets the light delay; the orientation is the IAU lunar rotation model evaluated one light time earlier. Extrema on the first or last sample of the window are excluded. The longitude must stay away from the ±π cut, which holds for terrestrial observers, and `options.step` and `options.tolerance` are in days (the step must resolve the extrema; a few hours suit a lunar month).

```ts
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { lunarLibrationExtrema } from 'nebulosa/src/astronomy/events/lunar'
import { type Time, Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecNegate } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

// Moon center to a geocentric observer: the negative of the geocentric Moon vector (AU).
const moonToObserver = (time: Time) => vecNegate(moon(time)[0])

const start = timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.UTC)
const stop = timeYMDHMS(2025, 10, 1, 0, 0, 0, Timescale.UTC)

for (const e of lunarLibrationExtrema(moonToObserver, start, stop, { step: 0.25 })) console.log(e.axis, e.kind, timeToDate(e.time).slice(0, 5), toDeg(e.angle))
// latitude maximum [2025, 9, 1, 3, 3] 6.85 — UTC, degrees
// longitude minimum [2025, 9, 4, 16, 43] -5.68
// latitude minimum [2025, 9, 14, 4, 23] -6.80
// longitude maximum [2025, 9, 17, 21, 52] 5.97
// latitude maximum [2025, 9, 28, 9, 53] 6.83
```

### Lunar Parallax and Semidiameter

The Moon is close enough that its position and size depend on where you stand. Its equatorial horizontal parallax is the angle that the Earth's equatorial radius subtends at the Moon, about 57′ (0.95°), and its semidiameter is the angular radius of the disk, about 15.5′ to 16.7′. Both scale inversely with the distance, and the topocentric semidiameter grows slightly when the Moon is high, because the observer is then closer to it than the Earth's center is.

`moonParallax(distance)` returns the horizontal parallax in radians from the geocentric distance in AU, using the Earth's equatorial radius of 6378.135 km; the distance must exceed that radius. `moonSemidiameter(distance)` returns the geocentric semidiameter in radians from the distance in AU (Meeus, chapter 55, with the small-angle coefficient `358473400″·km`). `moonTopocentricSemidiameter(distance, declination, hourAngle, rhoSinPhi, rhoCosPhi)` gives the topocentric semidiameter in radians with the rigorous Meeus formula; `declination` and the west-positive `hourAngle` are in radians, and `rhoSinPhi` and `rhoCosPhi` are the observer's geocentric parallax constants in Earth radii (see Geographic Observer). `moonTopocentricSemidiameterApprox(distance, altitude)` is the first-order version from the true altitude in radians, accurate to a few parts in 100000. `crescentWidth(semidiameter, illuminatedFraction)` is the width of the illuminated crescent in radians, `2 · semidiameter · fraction`, a first-order estimate that suits a thin crescent. For the Sun see Solar Parallax and Semidiameter.

```ts
import { crescentWidth, moonParallax, moonSemidiameter, moonTopocentricSemidiameter, moonTopocentricSemidiameterApprox } from 'nebulosa/src/astronomy/bodies/moon'
import { deg, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer } from 'nebulosa/src/math/units/distance'

const distance = kilometer(384400) // the mean Earth-Moon distance, in AU

console.log(toDeg(moonParallax(distance))) // 0.9507 — degrees
console.log(toDeg(moonParallax(kilometer(368409.7)))) // 0.99199 — degrees, near perigee (Meeus 47.a)

console.log(toArcsec(moonSemidiameter(distance))) // 932.55 — arcseconds
console.log(toArcsec(moonSemidiameter(kilometer(368409.7)))) // 973.03 — arcseconds

// The topocentric semidiameter, with the Moon overhead: the observer is 1 Earth radius closer.
console.log(toArcsec(moonTopocentricSemidiameterApprox(distance, deg(90)))) // 948.03 — arcseconds
console.log(toArcsec(moonTopocentricSemidiameterApprox(distance, 0))) // 932.55 — arcseconds, on the horizon
console.log(toArcsec(moonTopocentricSemidiameter(distance, deg(-20), deg(30), 0.5, 0.8))) // 939.95 — arcseconds, rigorous

// Width of the illuminated crescent when 10% of the disk is lit.
console.log(toArcsec(crescentWidth(moonSemidiameter(distance), 0.1))) // 186.51 — arcseconds
```

### Lunar Phase and Lunation

The Moon cycles through its phases every synodic month, 29.53 days: new, first quarter, full, and last quarter. A lunation is one such cycle, numbered consecutively from a conventional starting point, and different calendars and almanacs use different starting points.

`nearestLunarPhase(time, phase, next)` finds the previous or next principal phase with Meeus's chapter 49 series. `phase` is `'NEW'`, `'FIRST_QUARTER'`, `'FULL'`, or `'LAST_QUARTER'`, and `next` selects the first phase strictly after `time` when true, or the last at or before it when false. It returns a fresh `Time` in TT, with the periodic terms applied; convert it with `utc` for a civil time. `lunation(time, system?)` returns the integer lunation number of the cycle containing `time`. The default `'BROWN'` is the Brown numbering; `'MEEUS'` is the Meeus index, which is 0 for the new moon of 6 January 2000, and `'GOLDSTINE'`, `'HEBREW'`, `'ISLAMIC'`, and `'THAI'` are the other conventions. Each differs from the Meeus index only by a constant offset (for Brown, 953). For the day-by-day illuminated fraction see Meeus Algorithms.

```ts
import { lunation, nearestLunarPhase } from 'nebulosa/src/astronomy/bodies/moon'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.UTC)

const fmt = (instant: ReturnType<typeof nearestLunarPhase>) => timeToDate(utc(instant)).slice(0, 5)

console.log(fmt(nearestLunarPhase(time, 'NEW', true))) // [2025, 10, 21, 12, 25] — UTC
console.log(fmt(nearestLunarPhase(time, 'FIRST_QUARTER', true))) // [2025, 9, 29, 23, 53]
console.log(fmt(nearestLunarPhase(time, 'FULL', true))) // [2025, 10, 7, 3, 47]
console.log(fmt(nearestLunarPhase(time, 'LAST_QUARTER', true))) // [2025, 10, 13, 18, 12]

// The previous full moon.
console.log(fmt(nearestLunarPhase(time, 'FULL', false))) // [2025, 9, 7, 18, 8]

// Lunation numbers: Brown (default), Meeus, and two calendar conventions.
console.log(lunation(time)) // 1271 — Brown lunation number
console.log(lunation(time, 'MEEUS')) // 318 — lunations since the new moon of 6 January 2000
console.log(lunation(time, 'HEBREW'), lunation(time, 'ISLAMIC')) // 71552 17356
```

### Lunar Nodes

The lunar nodes are the two points where the Moon's orbit crosses the ecliptic: the ascending node, where it passes from south to north, and the descending node, where it passes north to south. Eclipses can happen only when a new or full moon falls near a node. The nodes move westward along the ecliptic, completing a turn in 18.6 years, which sets the cycle of the lunar standstills (see Lunar Declination Extrema and Standstills).

`nearestLunarNode(time, direction, next)` finds the previous or next passage through the ecliptic with Meeus's chapter 51 series. `direction` is `'ASCENDING'` or `'DESCENDING'`, and `next` selects strictly after `time` when true, and at or before it when false. It returns a fresh TT `Time` from a truncated series with minute-level accuracy near the modern epoch. `moonMeanAscendingNode(time)` returns the longitude of the mean ascending node in the mean ecliptic and equinox of date, in radians in `[0, 2π)`, from Meeus's equation 47.7 without the periodic terms of the true node.

```ts
import { moonMeanAscendingNode, nearestLunarNode } from 'nebulosa/src/astronomy/bodies/moon'
import { Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.UTC)

console.log(timeToDate(nearestLunarNode(time, 'ASCENDING', true)).slice(0, 5)) // [2025, 10, 5, 9, 21] — TT
console.log(timeToDate(nearestLunarNode(time, 'DESCENDING', true)).slice(0, 5)) // [2025, 10, 18, 4, 34]
console.log(timeToDate(nearestLunarNode(time, 'ASCENDING', false)).slice(0, 5)) // [2025, 9, 7, 23, 8] — the previous ascending passage

// Mean ascending node longitude, in degrees.
console.log(toDeg(moonMeanAscendingNode(time))) // 347.20
console.log(toDeg(moonMeanAscendingNode(timeYMDHMS(2025, 1, 29, 0, 0, 0, Timescale.TT)))) // 0.0147 — the node was at 0° (the vernal equinox) in January 2025
```

### Lunar Saros Index

A saros is a period of about 6585.3 days (18 years 11 days) after which the Sun, Moon, and node return to nearly the same geometry, so a lunar eclipse is followed by a similar one. Eclipses are grouped into numbered saros series. `lunarSaros(time)` returns the saros series number, from 1 to 223, for the lunation that contains `time`, counting from the full moon of 18 January 2003 (series 192), and advancing by 38 (modulo 223) per lunation. It is a numbering of the lunation, not a test that an eclipse occurs: not every lunation belongs to a series that produces one, so check with Lunar Eclipse Search. For the solar series see Solar Saros Index.

```ts
import { lunarSaros } from 'nebulosa/src/astronomy/bodies/moon'
import { timeYMD } from 'nebulosa/src/astronomy/time/time'

console.log(lunarSaros(timeYMD(2025, 9, 7))) // 128 — the total lunar eclipse of 7 September 2025
console.log(lunarSaros(timeYMD(2016, 8, 18))) // 109
console.log(lunarSaros(timeYMD(2026, 3, 3))) // 133 — the total lunar eclipse of 3 March 2026
```

### Martian Satellite Theory (MARSSAT)

MARSSAT (Lainey) is an analytical theory of Phobos and Deimos fitted to observations from 1877 to 2005. Trigonometric series perturb each satellite's equinoctial elements, which are converted to rectangular coordinates and rotated through the slowly precessing Laplace-plane node and inclination into the equatorial frame.

`phobos` and `deimos` take a `Time` (any scale; converted to TT) and return the Marscentric position in AU and velocity in AU/day, in equatorial axes. `marssat(time, index)` is the shared function, with `index` 0 for Phobos and 1 for Deimos. The returned vectors alias internal buffers, so copy them before computing another state. Add the result to Mars's barycentric state for an inertial position. Phobos orbits within about 9400 km of the planet's center and Deimos within about 23500 km.

```ts
import { deimos, marssat, phobos } from 'nebulosa/src/astronomy/ephemeris/models/analytical/marssat'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

const [position, velocity] = phobos(time)

console.log(position) // [-0.000038291, 0.000030662, 0.000038326] — AU, Marscentric
console.log(velocity) // [-0.00078355, -0.00096404, -0.000038947] — AU/day
console.log(toKilometer(Math.hypot(...position))) // 9313 — km

console.log(deimos(time)[0]) // [-0.000053312, 0.00011828, 0.000087980] — AU
console.log(toKilometer(Math.hypot(...deimos(time)[0]))) // 23451 — km

// marssat(time, index): index 0 is Phobos.
console.log(marssat(time, 0)[0]) // [-0.000038291, 0.000030662, 0.000038326] — AU
```

### Meeus Algorithms

`src/astronomy/ephemeris/meeus.ts` is a port of the algorithms of Jean Meeus' _Astronomical Algorithms_ (2nd edition), organized as one TypeScript `namespace` per chapter topic. It is a toolkit of pure functions: unless a function says otherwise, angles are radians, distances are AU, and a Julian Day argument named `jde` is on the dynamical (TT) scale while `jd` is UT. Sidereal times are in seconds of time. The longitudes of `Rise` and `Sunrise` are west-positive, as in the book, and the `Julian.Calendar` classes use fractional days. The functions are low-order series meant for the book's accuracy (arcseconds for the Sun, Moon and planets, minutes of time for events), not a replacement for the JPL ephemerides of the library; the tests of the module reproduce the examples of the book.

The namespaces are, by group:

- Time and calendars: `Julian` (Julian Day and calendar conversions, `Calendar`, `CalendarGregorian`, `CalendarJulian`), `Easter`, `Base` (Julian centuries, `horner`, `K`, `J2000`), `Sidereal`.
- Numerics: `Interpolation` (`Len3`, `Len5`), `Fit`, `Iteration`, `Kepler`.
- Geometry and coordinates: `Coords`, `Parallactic`, `Globe` (`Ellipsoid`, `EARTH76`), `Refraction`, `Rise` (`PlanetRise`), `AngularSeparation`, `Conjunction`, `Line`, `Circle`, `Precession` (`Precessor`, `EclipticPrecessor`), `Nutation`, `Apparent`, `ElementEquinox`, `Parallax`.
- Sun: `Solar`, `SolarXYZ`, `Solstice`, `EquationOfTime`, `SolarDisk`, `Sunrise`, `Sundial`.
- Planets and orbits: `PlanetElements`, `PlanetPosition`, `Elliptic`, `Parabolic`, `NearParabolic`, `Planetary` (conjunctions, oppositions, elongations, stations), `Perihelion`, `Node`, `Illuminated`, `Mars`, `Jupiter`, `JupiterMoons`, `SaturnRing`, `SaturnMoons`.
- Moon and stars: `MoonPosition`, `MoonIlluminated`, `Moon` (`PhysicalEphemeris`), `Semidiameter`, `Stellar`, `BinaryStars`.

The functions of a namespace of a given kind share an argument pattern, so the snippets below show one call per distinct pattern and the remaining names are listed with what they return. Some functions return an object or a class instance whose shape is in the type, and `Interpolation.Len3.extremum()` throws when the extremum lies outside its table.

```ts
import { AngularSeparation, Base, Coords, Easter, Julian, Nutation, Precession, Sidereal } from 'nebulosa/src/astronomy/ephemeris/meeus'
import { hms, signedDms, toDeg } from 'nebulosa/src/math/units/angle'

// Calendars: the Julian Day of 2000-01-01 12:00 and the calendar date of a Julian Day (fractional day).
console.log(Julian.calendarGregorianToJD(2000, 1, 1.5)) // 2451545
console.log(Julian.jdToCalendar(2436116.31)) // [ 1957, 10, 4.81 ] — year, month and fractional day

// Easter Sunday: the Gregorian and the Julian calendar.
console.log(Easter.gregorian(1991), Easter.julian(179)) // [ 1991, 3, 31 ] [ 179, 4, 12 ] — year, month, day

// Sidereal time at 0h UT of 1987-04-10, in seconds of time: mean and apparent.
console.log(Sidereal.mean(2446895.5), Sidereal.apparent(2446895.5)) // 47446.36683 47446.13514 (13h10m46.37s)

// Ecliptic to equatorial coordinates of Pollux (example 13.a, lon 113.21563°, lat 6.68417°), in degrees.
console.log(Coords.eclipticToEquatorial(...([113.21563, 6.68417].map((v) => (v * Math.PI) / 180) as [number, number]), Nutation.meanObliquity(2447000.5)).map(toDeg)) // [ 116.3293245, 28.0276333 ] — the obliquity of the date is that of 2447000.5, not the book's 23.4392911°

// Nutation in longitude and obliquity for 1987-04-10 0h TT, in arcseconds, and the mean obliquity.
console.log(Nutation.nutation(2446895.5).map((v) => (v * 206264.80624709636).toFixed(3))) // [ '-3.788', '9.443' ]
console.log(toDeg(Nutation.meanObliquity(2446895.5))) // 23.44094649

// Angular separation of Arcturus and Spica (RA, Dec in radians), in degrees.
const arcturus = [hms(14, 15, 39.7), signedDms(false, 19, 10, 57)] as const
const spica = [hms(13, 25, 11.6), signedDms(true, 11, 9, 41)] as const
console.log(toDeg(AngularSeparation.sep(arcturus, spica))) // 32.79301034

// Precession of a star from J2000 to the epoch 2028 November 13.19, in degrees.
const epoch = Base.jdeToJulianYear(Julian.calendarGregorianToJD(2028, 11, 13.19))
const precessor = new Precession.Precessor(2000, epoch)
console.log(precessor.precess(hms(2, 44, 11.986), signedDms(false, 49, 13, 42.48)).map(toDeg)) // [ 41.5430861, 49.3492074 ] — without proper motion
```

The Sun, the planets, the Moon and the satellites all follow the same pattern of one position or one event per Julian Day.

```ts
import { Base, BinaryStars, Elliptic, EquationOfTime, Illuminated, Jupiter, JupiterMoons, Julian, Kepler, Mars, MoonPosition, Parabolic, Parallax, Perihelion, PlanetPosition, Planetary, SaturnRing, Semidiameter, Solar, SolarDisk, Solstice } from 'nebulosa/src/astronomy/ephemeris/meeus'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// The Sun on 1992-10-13 0h TT (Meeus example 25.a): low-order longitude and radius, apparent RA/Dec, equation of time.
const jde = 2448908.5
const T = Base.j2000Century(jde)
console.log(toDeg(Solar.trueLongitude(T)[0]), Solar.radius(T)) // 199.9098727 0.99766195
console.log(Solar.apparentEquatorial(jde).map(toDeg)) // [ 198.3808252, -7.7850698 ] — 13h13m31.4s, -7°47′06″
console.log(Solar.apparentEquatorialVSOP87(jde).map(toDeg)) // [ 198.3781182, -7.7838165, 57.1587575 ] — RA, Dec in degrees, then the range in the unit of the function
console.log(EquationOfTime.e(jde) * 13750.987083139758) // 822.5786 seconds of time (13 m 42.6 s)
console.log(SolarDisk.ephemeris(2448908.50068).map(toDeg)) // [ 26.2734545, 5.9882202, 238.6315682 ] — P, B0, L0
console.log(SolarDisk.cycle(1699), Solstice.june(1962), Solstice.march(2000)) // 2444480.7229648 2437837.3924482 2451623.8169944

// Kepler's equation and the planets: Venus on 1992-12-20 0h TT (example 33.a).
console.log(Kepler.kepler1(0.1, deg(5), 8)) // 0.0969458701 rad
console.log(PlanetPosition.position('venus', 2448976.5).map(toDeg)) // [ 26.1141192, -2.6206030, 41.5166177 ] — lon, lat in degrees, range
console.log(Elliptic.position('venus', 2448976.5).map(toDeg)) // [ 316.1727242, -18.8880108 ] — apparent RA, Dec

// A comet on an elliptic and on a parabolic orbit.
const orbit = new Elliptic.Elements(2.2091404, 0.8502196, deg(11.94524), deg(186.23352), deg(334.75006), Julian.calendarGregorianToJD(1990, 10, 28.54502))
console.log(orbit.position(Julian.calendarGregorianToJD(1990, 10, 6)).map(toDeg)) // [ 158.5589662, 19.1584951, 40.5073087 ] — RA, Dec, elongation
console.log(new Parabolic.Elements(Julian.calendarGregorianToJD(1998, 4, 14.4358), 1.487469).anomalyDistance(Julian.calendarGregorianToJD(1998, 8, 5))) // [ 1.1656813, 2.1339113 ] — true anomaly (rad), distance (AU)

// Events: Mars opposition in 2729, Jupiter opposition in 2000, the perihelion of Venus in 1978 and the aphelion of Mars in 1993.
console.log(Planetary.marsOpp(2729.5), Planetary.jupiterOpp(2000)) // 2718057.6412432 2451475.4243247
console.log(Perihelion.perihelion('venus', 1978), Perihelion.aphelion2('mars', 1993)) // 2443424.3026596 [ 2449103.4732999, 1.6660372 ]

// Parallax: the horizontal parallax at 1 AU (8.794″) and the topocentric RA/Dec of Mars.
console.log(Parallax.horizontal(1)) // 0.0000426345 rad
console.log(Parallax.topocentric(deg(339.530208), deg(-15.771083), 0.37276, 0.546861, 0.836339, deg(116.8625), 2452879.63651)) // [ 5.9260142, -0.2753258 ] radians

// Phase: the phase angle and illuminated fraction of Venus.
console.log(Illuminated.phaseAngle(0.724604, 0.910947, 0.983824), Illuminated.fraction(0.724604, 0.910947, 0.983824), Illuminated.fractionVenus(2448976.5)) // 1.2733055 0.6465611 0.6402440

// Physical ephemerides: Mars (example 42.a) and Jupiter, in degrees (Mars index 6 is the illuminated fraction, indexes 5 and 7 are small angles left in radians).
console.log(Mars.physical(2448935.500683).map((v, i) => (i === 6 ? v : toDeg(v)))) // [ 12.4371585, -2.7577986, 111.5542286, 347.6431727, 279.9113725, 0.0029869, 0.9011823, 0.0002952 ]
console.log(Jupiter.physical(2448972.50068).map(toDeg)) // [ -2.1980363, -2.4846212, 268.0632373, 72.7355344, 24.8008112 ]

// Satellites of Jupiter: x, y, z in Jupiter radii for Io, Europa, Ganymede and Callisto, and Saturn's ring.
console.log(JupiterMoons.positions(2448972.50068)[JupiterMoons.IO]) // [ -3.4443983, 0.2101855, -4.8224636 ]
console.log(SaturnRing.ring(2448972.50068).map(toDeg).slice(0, 3)) // [ 16.4418434, 14.6788975, 4.1982761 ]

// The Moon: geocentric ecliptic longitude and latitude (degrees) and the distance (AU) of 1992-04-12 0h TT (example 47.a).
const [lon, lat, distance] = MoonPosition.position(2448724.5)
console.log(toDeg(lon), toDeg(lat), distance) // 133.1626547 -3.2291264 0.0024627 — the distance is in AU

// The solar semidiameter at 1 AU (radians, 959.63″) and the apparent eccentricity of a binary star orbit.
console.log(Semidiameter.semidiameter(Semidiameter.SUN, 1)) // 0.00465241753 rad
console.log(BinaryStars.apparentEccentricity(0.2763, deg(59.025), deg(219.907))) // 0.8599374
```

Group by group, the functions not shown are: `Sidereal.mean0UT` and `apparent0UT` (the sidereal time at 0h UT), `Globe.Ellipsoid` and `EARTH76` (the figure of the Earth) with `oneDegreeOfLongitude`, `oneDegreeOfLatitude`, `geocentricLatitudeDifference`, `approxAngularDistance` and `approxLinearDistance`, `Refraction` (`bennett`, `bennett2`, `saemundsson`, `gt15True` and `gt15Apparent`), `Rise.approxTimes` and `times` (rise, transit and set in seconds of time, with `hourAngle` returning `alwaysAbove` or `alwaysBelow`), `Interpolation.Len3` and `Len5` (`interpolateX`, `interpolateN`, `zero`, `extremum`), `Fit` (`linear`, `quadratic`, `correlationCoefficient`), `Iteration` (`decimalPlaces`, `fullPrecision`, `binaryRoot`), `Julian` (`calendarJulianToJD`, `jdToCalendarGregorian`, `jdToCalendarJulian`, `isLeapYearGregorian`, `isLeapYearJulian`, `dayOfWeek`, `dayOfYear`, `mjdToJD`, `jdToMJD`, `jdToDate`, `dateToJD`, `deltaTSeconds`), `Coords` (`equatorialToEcliptic`, `equatorialToHorizontal`, `horizontalToEquatorial`, `equatorialToGalactic`, `galacticToEquatorial`, which returns B1950 coordinates), `Parallactic` (`parallacticAngle`, `parallacticAngleOnHorizon`, `eclipticAtHorizon`, `eclipticAtEquator`, `diurnalPathAtHorizon`), `Conjunction` (`stellar`, `planetary`), `Line` (`time`, `angle`, `error`, `angleError`), `Circle.smallest` (the diameter and a flag that tells the smallest circle is the one through two stars), `Apparent` (`nutation`, `aberration`, `aberrationRonVondrak`, `eclipticAberration`, `perihelion`, `position`, `positionRonVondrak`), `ElementEquinox` (`reduceB1950ToJ2000`, `reduceB1950FK4ToJ2000FK5`), `Precession.mn`, `approxAnnualPrecession`, `approxPosition` (low-accuracy precession from the annual `m` and `n`, for example 10h07m12.1s, +12°04′32″ from J2000 to 1978), `position`, `properMotion`, `properMotion3D`, `EclipticPrecessor` and `eclipticPosition`, `PlanetElements` (`mean`, `inc`, `node`), `PlanetPosition.position2000` and `toFK5`, `Planetary` (`mercuryInfConj`, `mercurySupConj`, `venusInfConj`, `saturnOpp`, `saturnConj`, `uranusOpp`, `neptuneOpp`, `mercuryEastElongation`, `mercuryWestElongation`, `marsStation2`), `NearParabolic.Elements`, `Node` (the passage through the nodes of elliptic and parabolic orbits), `Parallax.topocentric2`, `topocentric3` and `topocentricEcliptical`, `Illuminated` (the per-planet magnitude functions and the 1984 variants), `Jupiter.physical2`, `JupiterMoons.e5`, `SaturnMoons.positions`, `MoonIlluminated` (the phase angle from the coordinates of the Sun and the Moon), `Moon.physical` and `PhysicalEphemeris` (selenographic position and libration), `Stellar` (`sum`, `sumN`, `ratio`, `difference`, absolute magnitudes), `Sundial` (`equatorial`, `horizontal`, `vertical`, `general`), and `Sunrise.Sunrise`, a class built from a `Julian.Calendar` day, a latitude and a west-positive longitude whose methods `rise`, `riseEnd`, `setStart`, `set`, `dawn`, `dusk`, `nauticalDawn`, `nauticalDusk`, `nightStart`, `nightEnd`, `goldenHourStart`, `goldenHourEnd` and `noon` return a `Julian.CalendarGregorian`. For example, on 2020-06-21 at latitude 50.8° and longitude 4.36° east (`-4.36°` west-positive) the sunrise is at 03:29:06 UTC, noon at 11:44:28 UTC and sunset at 19:59:48 UTC.

### Meteor Activity Profiles

Meteor activity is described in two independent ways. A catalog solution carries a support interval (`MeteorSolarLongitudeInterval`), which only says where the shower is active. The ZHR curve itself is explicit, caller-supplied data: a `MeteorActivityProfile` that is either `exponential` (one peak with separate rise and decay slopes), `sampled` (PCHIP-interpolated ZHR samples) or `multiPeak` (a sum of exponential components). All longitudes are geocentric solar longitudes in radians, and every interval advances in increasing longitude, so a window such as 350°–20° wraps through 0.

The exponential slopes are the base-10 decay per degree of solar longitude, as they are published: `ZHR = peak · 10^(−slope · |Δλ in degrees|)`, with `slopeBefore` used before the maximum and `slopeAfter` after it. A profile returns zero outside its support. Sampled profiles must have strictly increasing sample longitudes within the support, otherwise the first evaluation throws an `Error`. Global maxima are cached per profile object, so profiles should be treated as immutable.

```ts
import {
	integrateMeteorZhr,
	isMeteorShowerActive,
	meteorActivityFraction,
	meteorActivityIntervalsAboveFraction,
	meteorActivityMaximumSolarLongitude,
	meteorActivityMaximumZhr,
	meteorActivityPhase,
	meteorActivityProgress,
	meteorActivityZhr,
	meteorExponentialZhr,
	meteorSolarLongitudeForwardDelta,
} from 'nebulosa/src/astronomy/meteors/activity'
import type { MeteorActivityProfile, MeteorExponentialActivityProfile } from 'nebulosa/src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const exponential: MeteorExponentialActivityProfile = { type: 'exponential', support: { start: deg(90), end: deg(110) }, solarLongitude: deg(100), zhr: 120, slopeBefore: 0.1, slopeAfter: 0.2 }

// Support membership: undefined means that no interval was published.
console.log(isMeteorShowerActive(exponential.support, deg(95))) // true
console.log(isMeteorShowerActive(exponential.support, deg(120))) // false
console.log(isMeteorShowerActive(undefined, deg(95))) // undefined
console.log(isMeteorShowerActive({ start: 0, end: 0, fullCircle: true }, deg(95))) // true

// ZHR in meteors per hour. 120 · 10^(−0.1 · 5) = 37.95 five degrees before the maximum.
console.log(meteorActivityZhr(exponential, deg(100))) // 120
console.log(meteorExponentialZhr(exponential, deg(95))) // 37.947
console.log(meteorActivityZhr(exponential, deg(105))) // 12 — 120 · 10^(−0.2 · 5)
console.log(meteorActivityZhr(exponential, deg(120))) // 0 — outside the support

console.log(meteorActivityProgress(exponential.support, deg(95))) // 0.25 — a quarter of the way through the support
console.log(meteorActivityProgress(exponential.support, deg(120))) // undefined — inactive
console.log(meteorActivityPhase(exponential, deg(95))) // { active: true, progress: 0.25, deltaFromMaximum: −0.0873 } — radians

// Global maximum and relative intensity in [0, 1].
console.log(toDeg(meteorActivityMaximumSolarLongitude(exponential)!)) // 100
console.log(meteorActivityMaximumZhr(exponential)) // 120
console.log(meteorActivityFraction(exponential, deg(95))) // 0.3162

// Forward circular displacement in [0, 2π).
console.log(toDeg(meteorSolarLongitudeForwardDelta(deg(350), deg(10)))) // 20

// Circular intervals where the profile is at least half of its peak: 96.99° to 101.51°.
const half = meteorActivityIntervalsAboveFraction(exponential, 0.5)
console.log(half.map((interval) => [toDeg(interval.start), toDeg(interval.end)])) // [[96.990, 101.505]]

// ZHR integrated over time, in ZHR·hours (meteors seen by an ideal observer). The solar longitude
// is computed at each Simpson sample; `options.step` is the panel width in days (default 1/24).
const quadrantids: MeteorActivityProfile = { type: 'exponential', support: { start: deg(280), end: deg(286) }, solarLongitude: deg(283), zhr: 110, slopeBefore: 0.2, slopeAfter: 0.2 }
const start = timeYMDHMS(2024, 1, 3, 12, 0, 0, Timescale.UTC)
const end = timeYMDHMS(2024, 1, 4, 12, 0, 0, Timescale.UTC)
console.log(integrateMeteorZhr(quadrantids, start, end)) // 2302.26
```

A multi-peak profile adds its components, so its maximum can lie between the component peaks and `meteorActivityPhase` reports the progress of the strongest component. A sampled profile is zero before its first and after its last sample. `meteorActivityIntervalsAboveFraction(profile, 0)` returns one `fullCircle` interval, positive fractions return one interval per disconnected run, and `options.samples` (default 1440, minimum 32) sets the scan resolution before the edges are refined by bisection.

```ts
import { meteorActivityIntervalsAboveFraction, meteorActivityMaximumSolarLongitude, meteorActivityMaximumZhr, meteorActivityPhase, meteorActivityZhr, isMeteorShowerActivityYearLimited, meteorShowerActivityYearApplies } from 'nebulosa/src/astronomy/meteors/activity'
import type { MeteorActivityProfile, MeteorShowerActivity } from 'nebulosa/src/astronomy/meteors/types'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const multiPeak: MeteorActivityProfile = {
	type: 'multiPeak',
	components: [
		{ type: 'exponential', support: { start: deg(90), end: deg(110) }, solarLongitude: deg(100), zhr: 120, slopeBefore: 0.1, slopeAfter: 0.2 },
		{ type: 'exponential', support: { start: deg(100), end: deg(130) }, solarLongitude: deg(115), zhr: 60, slopeBefore: 0.1, slopeAfter: 0.2 },
	],
}

console.log(meteorActivityZhr(multiPeak, deg(105))) // 18 — 12 from the first component plus 6 from the second
console.log(toDeg(meteorActivityMaximumSolarLongitude(multiPeak)!)) // 100
console.log(meteorActivityMaximumZhr(multiPeak)) // 121.90
console.log(meteorActivityIntervalsAboveFraction(multiPeak, 0.5).map((interval) => [toDeg(interval.start), toDeg(interval.end)])) // [[97.058, 101.570]]

const sampled: MeteorActivityProfile = {
	type: 'sampled',
	support: { start: deg(90), end: deg(110) },
	samples: [
		{ solarLongitude: deg(92), zhr: 10 },
		{ solarLongitude: deg(100), zhr: 100 },
		{ solarLongitude: deg(108), zhr: 20 },
	],
}

console.log(meteorActivityZhr(sampled, deg(96))) // 76.875 — PCHIP between the first two samples
console.log(meteorActivityZhr(sampled, deg(91))) // 0 — before the first sample
console.log(meteorActivityPhase(sampled, deg(96)).active) // true

// Year-limited labels (a dated observation or an outburst) only apply in their civil UTC years.
const outburst: MeteorShowerActivity = { kind: 'yearSpecific', source: '2024', years: { start: 2024, end: 2024 } }
console.log(isMeteorShowerActivityYearLimited(outburst)) // true
console.log(meteorShowerActivityYearApplies(outburst, 2024)) // true
console.log(meteorShowerActivityYearApplies(outburst, 2025)) // false
console.log(isMeteorShowerActivityYearLimited({ kind: 'annual', source: 'annual' })) // false
```

### Meteor Observing Windows

`meteorObservingWindows` plans when a shower can be observed from a site. It intersects the activity support (catalog interval and profile), solar darkness, a minimum radiant altitude and, only when requested, lunar constraints. Every boundary is refined by root search, and the surviving windows are integrated for their expected count and **ordered by expected count, most productive first**, not chronologically. The solution and the explicit `MeteorActivityProfile` can be passed in either order.

The default constraints are a Sun at most 18° below the horizon (`maximumSolarAltitude`, radians, default `deg(-18)`) and a radiant above the geometric horizon (`minimumRadiantAltitude`, 0). Altitudes are geometric, so a window opens when the radiant crosses 0° of geometric altitude, a few minutes after the refracted rise reported by the rise/transit/set finder. Lunar constraints are opt-in: `maximumMoonAltitude`, `minimumMoonRadiantSeparation` and `maximumMoonIllumination` (the last two apply only while the Moon is above the horizon). Nothing penalizes the rate for moonlight or clouds unless `rateCorrection(time, conditions)` is supplied; it returns a multiplier in the local rate. The rate model uses `limitingMagnitude` (default 6.5), `populationIndex` (2), `obstructionCorrection` (1) and `altitudeExponent` (1). `step` is the scan resolution in days (default 1/24, reduced automatically for narrow supports), `tolerance` the root tolerance, and `minimumDurationHours` drops short slivers. A dated outburst outside its years yields no windows unless `extrapolateYearLimitedActivity` is set. A non-positive span returns `[]`.

```ts
import { meteorObservingWindows } from 'nebulosa/src/astronomy/meteors/planner'
import type { MeteorActivityProfile, MeteorShowerSolution } from 'nebulosa/src/astronomy/meteors/types'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { type Time, Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

// Illustrative values close to the Quadrantids; they are not read from a catalog.
const solution: MeteorShowerSolution = { activity: { kind: 'annual', source: 'annual' }, activityInterval: { start: deg(280), end: deg(286) }, referenceSolarLongitude: deg(283.16), rightAscension: deg(230.1), declination: deg(48.5) }
const profile: MeteorActivityProfile = { type: 'exponential', support: { start: deg(280), end: deg(286) }, solarLongitude: deg(283.16), zhr: 110, slopeBefore: 0.2, slopeAfter: 0.2 }

const observer = geodeticLocation(deg(-8), deg(40), meter(100), Ellipsoid.WGS84) // longitude, latitude, height
const start = timeYMDHMS(2024, 1, 3, 12, 0, 0, Timescale.UTC)
const end = timeYMDHMS(2024, 1, 5, 12, 0, 0, Timescale.UTC)
const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

// Dark-sky windows over two days for a limiting magnitude of 6.0, ignoring windows shorter than 30 minutes.
const windows = meteorObservingWindows(solution, profile, observer, start, end, { limitingMagnitude: 6, populationIndex: 2.1, minimumDurationHours: 0.5 })

for (const window of windows) {
	console.log(format(window.start), format(window.end), window.durationHours, window.expectedCount, format(window.bestTime!), window.bestLocalHourlyRate, toDeg(window.maximumRadiantAltitude!))
}
// 2024-1-3-22-17-0 2024-1-4-6-17-2 8.001 220.09 2024-1-4-6-17-2 62.10 60.05
// 2024-1-4-22-13-4 2024-1-5-6-17-9 8.068 172.89 2024-1-5-6-17-9 43.86 60.72
// 2024-1-3-18-55-50 2024-1-3-19-45-26 0.827 1.11 2024-1-3-18-55-50 2.69 2.69
// 2024-1-4-18-56-37 2024-1-4-19-41-30 0.748 0.98 2024-1-4-18-56-37 2.61 2.38

// Opt-in lunar constraints and a higher radiant. The window also reports the Moon at its best instant.
const [best] = meteorObservingWindows(profile, solution, observer, start, end, { limitingMagnitude: 6, populationIndex: 2.1, minimumDurationHours: 1, minimumRadiantAltitude: deg(20), minimumMoonRadiantSeparation: deg(30), maximumMoonIllumination: 0.4 })
console.log(format(best.start), format(best.end), best.durationHours, best.expectedCount) // 2024-1-5-4-51-49 2024-1-5-6-17-9 1.422 58.23
console.log(best.moonIlluminationAtBest, toDeg(best.minimumMoonRadiantSeparation!), toDeg(best.maximumMoonAltitude!)) // 0.3943 63.31 37.58
console.log(best.maximumZhr, best.maximumActivityFraction) // 74.92 0.6811
```

The conditions at one instant (Sun, Moon, radiant) are available directly, which is what a `rateCorrection` callback receives. `meteorObservingConditionsAt(radiant, observer, time, context?)` returns the geometric altitudes of the Sun and Moon, the lunar illuminated fraction, the Moon-radiant separation and the horizontal radiant. `meteorObservationContext(time, observer?)` prepares the shared solar longitude and local sidereal time, while `meteorSunDirection` and `meteorMoonDirection` return the geocentric equatorial J2000 vectors (AU) and `meteorMoonIllumination` the illuminated fraction from them.

```ts
import { meteorMoonDirection, meteorMoonIllumination, meteorObservationContext, meteorObservingConditionsAt, meteorSunDirection } from 'nebulosa/src/astronomy/meteors/observation'
import type { MeteorRadiant } from 'nebulosa/src/astronomy/meteors/types'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const observer = geodeticLocation(deg(-8), deg(40), meter(100), Ellipsoid.WGS84)
const time = timeYMDHMS(2024, 1, 4, 3, 0, 0, Timescale.UTC)
const radiant: MeteorRadiant = { rightAscension: deg(230.1), declination: deg(48.5) }

const conditions = meteorObservingConditionsAt(radiant, observer, time)
console.log(toDeg(conditions.sunAltitude), toDeg(conditions.moonAltitude)) // −55.22 24.83
console.log(conditions.moonIllumination, toDeg(conditions.moonRadiantSeparation)) // 0.5034 62.45
console.log(toDeg(conditions.radiant.altitude), toDeg(conditions.radiant.azimuth)) // 28.70 49.18

const context = meteorObservationContext(time, observer)
console.log(toDeg(context.solarLongitude), context.localSiderealTime) // 282.896 2.4475 — degrees, radians

const sun = meteorSunDirection(time)
const moon = meteorMoonDirection(time)
console.log(sun) // [0.21945, −0.87944, −0.38123] — AU
console.log(moon) // [−0.0026157, −0.00055206, −0.00020355] — AU
console.log(meteorMoonIllumination(sun, moon)) // 0.5034
```

### Meteor Orbit Reconstruction

A meteor's heliocentric orbit follows from where it comes from and how fast it hits the Earth. The geocentric radiant (equatorial J2000, radians) gives the direction of the incoming velocity, and the asymptotic geocentric speed `Vg` (AU/day) its magnitude. The heliocentric velocity is the Earth's heliocentric velocity minus `Vg` along the radiant direction, and the position is the Earth's position, since the meteoroid meets the Earth. States are heliocentric in the **ecliptic J2000** frame, with the Earth taken from VSOP87E. The speed must already be free of the Earth's gravity, the zenith attraction and the observer's rotation; see the trajectory-correction topic for those corrections.

`meteorHeliocentricState(radiant, geocentricSpeed, time)` returns the state together with the Earth state used. `meteorOrbitFromRadiant(radiant, geocentricSpeed, time, mu?)` wraps it in a `KeplerOrbit` whose elements are in the same ecliptic frame as the stream elements of the IAU Meteor Data Center, with the Sun's GM from Pitjeva (2005) by default. A result with `eccentricity ≥ 1` is an unbound (hyperbolic) orbit, which is the signature of an inconsistent radiant or speed rather than of an interstellar meteoroid unless the measurement is accurate enough to say so.

```ts
import { meteorHeliocentricState, meteorOrbitFromRadiant } from 'nebulosa/src/astronomy/meteors/orbit'
import type { MeteorRadiant } from 'nebulosa/src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometerPerSecond, toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// A Geminid-like radiant, with the typical speed of 33.8 km/s.
const radiant: MeteorRadiant = { rightAscension: deg(112.5), declination: deg(32.3) }
const speed = kilometerPerSecond(33.8)
const time = timeYMDHMS(2023, 12, 14, 12, 0, 0, Timescale.UTC)

const state = meteorHeliocentricState(radiant, speed, time)
console.log(state.position) // [0.13883, 0.97458, −0.0000523] — AU, the Earth position
console.log(state.velocity) // [−0.011005, −0.015776, −0.0035064] — AU/day
console.log(toKilometerPerSecond(Math.hypot(...state.velocity))) // 33.853 — km/s, heliocentric speed
console.log(state.earthVelocity) // [−0.017320, 0.0023603, 8.7e-8] — AU/day

const orbit = meteorOrbitFromRadiant(radiant, speed, time)
console.log(orbit.semiMajorAxis) // 1.3517 — AU
console.log(orbit.eccentricity) // 0.88773
console.log(toDeg(orbit.inclination)) // 22.02
console.log(orbit.periapsisDistance) // 0.15176 — AU
console.log(toDeg(orbit.argumentOfPeriapsis)) // 323.01
console.log(toDeg(orbit.longitudeOfAscendingNode)) // 261.88
```

The inverse question is where a stream with known elements meets the Earth. `meteorStreamOrbitNodeEncounters(stream, time, mu?)` takes the complete elements `q`, `e`, `ω`, `Ω` and `i` (a `MeteorCompleteStreamOrbit`, with no epoch or mean anomaly) and evaluates the two geometric nodes of the orbit. For each node it returns the candidate geocentric radiant (equatorial J2000), the relative geocentric speed there (AU/day) and the Earth-node distance (AU) at `time`. No node is selected for the caller: a node is a real encounter only when the Earth is near it, so the distance has to be compared with a physical limit chosen by the caller. A node that does not exist (`1 + e·cos ν ≤ 0`) is skipped, and `q ≤ 0` or `e < 0` gives an empty list.

```ts
import { meteorStreamOrbitNodeEncounters } from 'nebulosa/src/astronomy/meteors/orbit'
import type { MeteorCompleteStreamOrbit } from 'nebulosa/src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const stream: MeteorCompleteStreamOrbit = { perihelionDistance: 0.14, eccentricity: 0.89, argumentOfPerihelion: deg(324.3), longitudeOfAscendingNode: deg(261.2), inclination: deg(22.9) }
const time = timeYMDHMS(2023, 12, 14, 12, 0, 0, Timescale.UTC)

for (const encounter of meteorStreamOrbitNodeEncounters(stream, time)) {
	console.log(encounter.node, toDeg(encounter.radiant.rightAscension), toDeg(encounter.radiant.declination), toKilometerPerSecond(encounter.geocentricSpeed), encounter.earthNodeDistance)
}
// ascending 152.94 −7.239 131.53 1.138 — the Earth is 1.14 AU from this node
// descending 112.16 32.615 33.912 0.0322 — 0.032 AU away: the shower radiant and speed
```

### Meteor Orbit Similarity

Whether two meteors, or a meteor and a parent body, share an orbit is decided with a dimensionless distance between orbits: the smaller the value, the more similar the orbits, and a shower association is usually declared below a threshold chosen for the criterion and the sample. Three classic criteria are available, all taking `MeteorComparableOrbit` objects in the same ecliptic J2000 frame: perihelion distance `q` (AU), eccentricity `e`, inclination `i`, longitude of the ascending node `Ω` and argument of perihelion `ω` (radians).

- `meteorDSouthworthHawkins` is the `D_SH` of Southworth and Hawkins: `D² = (q₂ − q₁)² + (e₂ − e₁)² + (2 sin(I/2))² + (ē · 2 sin(Π/2))²`, where `I` is the angle between the orbital planes and `Π` the longitude-of-perihelion separation measured from the mutual node.
- `meteorDDrummond` is `D_D`, which normalizes the `q` and `e` differences by their sums and uses the angle between the perihelion directions instead of `Π`.
- `meteorDJopek` is the hybrid `D_J`: `e` is not normalized, `q` is normalized by the sum and the angular terms are those of `D_SH`.

The three values are not on the same scale and must not be compared with each other's thresholds. A criterion returns `undefined` when the geometry is singular: a non-positive or non-finite `q` or `e`, an inclination of exactly 0 or π (the node is undefined), or the mutual-node orientation becoming singular. `meteorComparableOrbitFromKepler` converts a `KeplerOrbit` into that shape and returns `undefined` for the same singular orbits. Identical orbits have a distance of 0 and the criteria are symmetric.

```ts
import { meteorComparableOrbitFromKepler, meteorDDrummond, meteorDJopek, meteorDSouthworthHawkins, meteorOrbitFromRadiant } from 'nebulosa/src/astronomy/meteors/orbit'
import type { MeteorComparableOrbit } from 'nebulosa/src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// Orbit reconstructed from a Geminid-like radiant and speed.
const time = timeYMDHMS(2023, 12, 14, 12, 0, 0, Timescale.UTC)
const measured = meteorComparableOrbitFromKepler(meteorOrbitFromRadiant({ rightAscension: deg(112.5), declination: deg(32.3) }, kilometerPerSecond(33.8), time))!
console.log(measured) // { perihelionDistance: 0.15176, eccentricity: 0.88773, inclination: 0.38440, longitudeOfAscendingNode: 4.5708, argumentOfPerihelion: 5.6376 } — AU, radians

// Mean orbit of the stream, with the same elements.
const stream: MeteorComparableOrbit = { perihelionDistance: 0.14, eccentricity: 0.89, inclination: deg(22.9), longitudeOfAscendingNode: deg(261.2), argumentOfPerihelion: deg(324.3) }

console.log(meteorDSouthworthHawkins(measured, stream)) // 0.02240
console.log(meteorDDrummond(measured, stream)) // 0.04080
console.log(meteorDJopek(measured, stream)) // 0.04459
console.log(meteorDSouthworthHawkins(stream, stream)) // 0

// A very different orbit is far apart, while a coplanar orbit (i = 0) has no node and no result.
console.log(meteorDSouthworthHawkins(measured, { ...stream, perihelionDistance: 1, eccentricity: 0.5, inclination: deg(100) })) // 1.566
console.log(meteorDJopek({ ...stream, inclination: 0 }, stream)) // undefined
```

### Meteor Radiants

A meteor radiant is the point of the sky from which the shower's meteors appear to diverge. Catalog radiants are geocentric, in equatorial J2000 coordinates (`MeteorRadiant`: right ascension normalized to `[0, 2π)` and declination, both in radians), and can drift during the activity period. A drift is declared with its unit basis: `solarLongitude` rates are radians per radian of solar longitude, `day` rates are radians per day. The radiant moves linearly away from the catalog reference longitude (`referenceSolarLongitude`), and the result reports `extrapolated: true` whenever it was evaluated away from that reference. A radiant that is missing, a drift without a reference longitude, a declination that would cross a pole, or a displacement beyond the allowed limit gives `undefined`.

`MeteorRadiantOptions` controls the extrapolation: `extrapolate: false` accepts only the exact reference, `maxExtrapolationSolarLongitude` (default π, radians) limits a longitude drift, and `maxExtrapolationDays` (default 366) limits a daily drift. A daily drift is anchored to the nearest annual occurrence of the reference longitude, so `solarLongitudeSearch` can tune that inversion.

```ts
import { meteorRadiantDegrees, meteorRadiantJ2000, meteorRadiantPath, meteorRadiantPathBetween, meteorRadiantPathSegmentsBetween, meteorRadiantVector } from 'nebulosa/src/astronomy/meteors/radiant'
import { meteorComputationContext } from 'nebulosa/src/astronomy/meteors/solar'
import type { MeteorShowerSolution } from 'nebulosa/src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// Illustrative values close to the Quadrantids; they are not read from a catalog.
const base: MeteorShowerSolution = { activity: { kind: 'annual', source: 'annual' }, activityInterval: { start: deg(280), end: deg(286) }, referenceSolarLongitude: deg(283.16), rightAscension: deg(230.1), declination: deg(48.5) }
const longitudeDrift: MeteorShowerSolution = { ...base, radiantDrift: { basis: 'solarLongitude', rightAscensionRate: 1, declinationRate: -0.2 } }
const dailyDrift: MeteorShowerSolution = { ...base, radiantDrift: { basis: 'day', rightAscensionRate: deg(1), declinationRate: deg(-0.25) } }

const time = timeYMDHMS(2024, 1, 4, 5, 0, 0, Timescale.UTC)
const context = meteorComputationContext(time) // solar longitude 282.98°

const fixed = meteorRadiantJ2000(base, context)
console.log(toDeg(fixed!.radiant.rightAscension), toDeg(fixed!.radiant.declination), fixed!.extrapolated) // 230.1 48.5 false

const drifting = meteorRadiantJ2000(longitudeDrift, context)
console.log(toDeg(drifting!.radiant.rightAscension), toDeg(drifting!.radiant.declination), drifting!.extrapolated) // 229.921 48.536 true

const daily = meteorRadiantJ2000(dailyDrift, context)
console.log(toDeg(daily!.radiant.rightAscension), toDeg(daily!.radiant.declination), daily!.extrapolated) // 229.924 48.544 true

console.log(meteorRadiantJ2000(longitudeDrift, context, { extrapolate: false })) // undefined — not at the reference longitude

// Samples over a forward interval of solar longitude (radians), endpoint included. A daily drift needs
// absolute times and throws here.
const path = meteorRadiantPath(longitudeDrift, deg(282), deg(284), deg(1))
console.log(path.map((point) => [toDeg(point.solarLongitude), toDeg(point.rightAscension), toDeg(point.declination)])) // [[282, 228.94, 48.732], [283, 229.94, 48.532], [284, 230.94, 48.332]]

// The same for absolute times: `step` is in days (default 1). Segments split the path wherever the model
// is unavailable, so a polyline cannot bridge the gap.
const start = timeYMDHMS(2024, 1, 3, 0, 0, 0, Timescale.UTC)
const end = timeYMDHMS(2024, 1, 5, 0, 0, 0, Timescale.UTC)
const timed = meteorRadiantPathBetween(dailyDrift, start, end)
console.log(timed.map((point) => [toDeg(point.solarLongitude), toDeg(point.rightAscension), toDeg(point.declination)])) // [[281.749, 228.716, 48.846], [282.768, 229.716, 48.596], [283.788, 230.716, 48.346]]
console.log(meteorRadiantPathSegmentsBetween(dailyDrift, start, end).map((segment) => segment.length)) // [3]

// Unit vector in equatorial J2000, and a radiant built from degrees.
console.log(meteorRadiantVector({ rightAscension: deg(90), declination: 0 })) // [6.1e-17, 1, 0]
console.log(meteorRadiantDegrees(-90, 10)) // { rightAscension: 4.7124, declination: 0.17453 } — radians
```

Local circumstances are geometric: the radiant is precessed and nutated to the true equator of date, then rotated to the horizon with the apparent sidereal time of the observer, and no refraction is applied. Azimuth is measured north through east. `meteorRadiantMaximumAltitude` scans a bounded interval at `options.step` (days, default 1/24) and refines around the best sample, returning `undefined` when the radiant never rises. `meteorRadiantRiseTransitSet` uses the shared horizon event finder over `options.window` days (default 1) and the standard horizon altitude of the finder, so its rise and set instants are not the instants of the geometric altitude crossing zero. `meteorRadiantVisibility` classifies that result as `alwaysUp`, `alwaysDown`, `risesAndSets`, `risesOnly`, `setsOnly` or `unknown`.

```ts
import { meteorRadiantHorizontal, meteorRadiantMaximumAltitude, meteorRadiantOfDate, meteorRadiantRiseTransitSet, meteorRadiantVisibility } from 'nebulosa/src/astronomy/meteors/radiant'
import type { MeteorRadiant, MeteorShowerSolution } from 'nebulosa/src/astronomy/meteors/types'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const solution: MeteorShowerSolution = { activity: { kind: 'annual', source: 'annual' }, referenceSolarLongitude: deg(283.16), rightAscension: deg(230.1), declination: deg(48.5) }
const radiant: MeteorRadiant = { rightAscension: deg(230.1), declination: deg(48.5) }
const observer = geodeticLocation(deg(-8), deg(40), meter(100), Ellipsoid.WGS84) // longitude, latitude, height
const time = timeYMDHMS(2024, 1, 4, 5, 0, 0, Timescale.UTC)

const ofDate = meteorRadiantOfDate(radiant, time)
console.log(toDeg(ofDate.rightAscension), toDeg(ofDate.declination)) // 230.292 48.413

const horizontal = meteorRadiantHorizontal(radiant, observer, time)
console.log(toDeg(horizontal.azimuth), toDeg(horizontal.altitude)) // 57.973 47.321

const start = timeYMDHMS(2024, 1, 4, 0, 0, 0, Timescale.UTC)
const end = timeYMDHMS(2024, 1, 5, 0, 0, 0, Timescale.UTC)
const highest = meteorRadiantMaximumAltitude(solution, observer, start, end)
console.log(highest && [timeToDate(utc(highest.time)), toDeg(highest.altitude), toDeg(highest.azimuth)]) // [[2024, 1, 4, 8, 59, 15, 651], 81.587, 360] — at the transit, due north of the zenith

const events = meteorRadiantRiseTransitSet(solution, observer, start)
console.log(events && timeToDate(utc(events.rise!))) // [2024, 1, 4, 21, 57, 57, 299]
console.log(meteorRadiantVisibility(events)) // risesAndSets
console.log(meteorRadiantVisibility(undefined)) // unknown
```

### Meteor Shower State

`meteorShowerState` gathers everything a planner needs about one shower solution at one instant: whether it is active, its ZHR and relative activity, the radiant in J2000 and of date, the local horizontal radiant, and the Sun and Moon circumstances. The common values (solar longitude, sidereal time, Sun and Moon vectors and altitudes, lunar illumination) are computed once in a `MeteorShowerComputationContext` and shared by any number of solutions, so a batch of showers costs one ephemeris evaluation, not one per shower.

`meteorShowerComputationContext(time, observer?, options?)` prepares the context. Without an observer there is no local sidereal time and no altitudes, and the state has no `horizontal`, `sunAltitude` or `moonAltitude`. `includeHorizontal`, `includeSun` and `includeMoon` switch the optional groups off; the Moon vector is the most expensive and is evaluated by default, so a caller that does not need lunar quantities should pass `includeMoon: false`. All altitudes are geometric, without refraction.

`meteorShowerState(solution, context, options?)` never mutates the context. `active` is the conjunction of every known support: the catalog interval and the profile support. It is `undefined` when neither exists and `false` for a dated observation or outburst outside its civil years, unless `extrapolateYearLimitedActivity` is set. `zhr` and `activityFraction` need `options.profile`; pass `activityMaximumZhr` when calling repeatedly to skip the global-peak search of the profile. The radiant options (`extrapolate`, `maxExtrapolationDays`, ...) are those of the radiant evaluation, `radiantExtrapolated` tells whether the drift was applied away from its reference, and `includeRadiantOfDate: false` skips the precession and nutation of the radiant when only J2000 is needed.

```ts
import { meteorShowerComputationContext, meteorShowerState, meteorShowerStates } from 'nebulosa/src/astronomy/meteors/state'
import type { MeteorActivityProfile, MeteorShowerSolution } from 'nebulosa/src/astronomy/meteors/types'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

// Illustrative values close to the Quadrantids and Geminids; they are not read from a catalog.
const quadrantids: MeteorShowerSolution = { activity: { kind: 'annual', source: 'annual' }, activityInterval: { start: deg(280), end: deg(286) }, referenceSolarLongitude: deg(283.16), rightAscension: deg(230.1), declination: deg(48.5) }
const geminids: MeteorShowerSolution = { activity: { kind: 'annual', source: 'annual' }, activityInterval: { start: deg(250), end: deg(270) }, referenceSolarLongitude: deg(262), rightAscension: deg(112.5), declination: deg(32.3) }
const profile: MeteorActivityProfile = { type: 'exponential', support: { start: deg(280), end: deg(286) }, solarLongitude: deg(283.16), zhr: 110, slopeBefore: 0.2, slopeAfter: 0.2 }

const observer = geodeticLocation(deg(-8), deg(40), meter(100), Ellipsoid.WGS84) // longitude, latitude, height
const time = timeYMDHMS(2024, 1, 4, 5, 0, 0, Timescale.UTC)
const context = meteorShowerComputationContext(time, observer)

const state = meteorShowerState(quadrantids, context, { profile })
console.log(toDeg(state.solarLongitude)) // 282.981
console.log(state.active, state.zhr, state.activityFraction) // true 101.28 0.9207
console.log(state.radiantExtrapolated) // false — no drift is declared
console.log(toDeg(state.horizontal!.azimuth), toDeg(state.horizontal!.altitude)) // 57.973 47.321
console.log(toDeg(state.moonSeparation!), toDeg(state.moonAltitude!), state.moonIllumination) // 62.46 40.39 0.4955
console.log(toDeg(state.sunAltitude!)) // −32.53

// A batch shares the same context; each input carries its own optional profile.
const states = meteorShowerStates([{ solution: quadrantids, profile }, { solution: geminids }], context)
console.log(states.map((value) => [value.active, value.zhr, value.activityFraction])) // [[true, 101.28, 0.9207], [false, undefined, undefined]]

// Without an observer there is no local geometry.
const geocentric = meteorShowerComputationContext(time)
console.log(meteorShowerState(quadrantids, geocentric, { profile, includeMoon: false }).horizontal) // undefined
```

### Meteor Solar Longitude

Meteor catalogs locate a shower by the Sun's ecliptic longitude, not by calendar date. The meteor modules compute it as the geometric geocentric longitude in the **J2000 ecliptic**, from the VSOP87E Sun and Earth positions, with no light-time, aberration or precession to the date. Because the frame is fixed at J2000, longitude 0° is reached about eight hours after the 2024 March equinox, not at it. Longitudes are in radians and normalized to `[0, 2π)`.

Converting a longitude to a time is limited to one civil UTC year: `timeAtMeteorSolarLongitude(year, longitude, options?)` returns the first occurrence in that year and throws an `Error` if the longitude does not occur in it. The result is in UTC unless `options.scale` selects another scale. `meteorSolarLongitudeTimes` solves several longitudes with the same shared setup and preserves their order. `options` also accepts the root-search `step` and `tolerance`.

```ts
import { meteorComputationContext, meteorSolarLongitude, meteorSolarLongitudeDelta, meteorSolarLongitudeForwardDelta, meteorSolarLongitudeTimes, meteorSolarRelativeState, meteorSolarState, timeAtMeteorSolarLongitude } from 'nebulosa/src/astronomy/meteors/solar'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2024, 1, 4, 0, 0, 0, Timescale.UTC)

console.log(toDeg(meteorSolarLongitude(time))) // 282.768 — degrees

// One shared Sun/Earth evaluation: longitude plus the geocentric equatorial J2000 Sun vector (AU).
const state = meteorSolarState(time)
console.log(toDeg(state.solarLongitude)) // 282.768
console.log(state.sun) // [0.21732, −0.87988, −0.38142]

// Signed shortest displacement in [−π, π) and forward displacement in [0, 2π).
console.log(toDeg(meteorSolarLongitudeDelta(deg(5), deg(355)))) // 10
console.log(toDeg(meteorSolarLongitudeForwardDelta(deg(350), deg(10)))) // 20
console.log(toDeg(meteorSolarLongitudeForwardDelta(deg(10), deg(350)))) // 340

// Time at which the longitude 283° is reached in 2024: 2024-01-04 05:27:22 UTC.
console.log(timeToDate(utc(timeAtMeteorSolarLongitude(2024, deg(283))))) // [2024, 1, 4, 5, 27, 22, 227]

// Several longitudes at once, in input order. J2000 longitudes 0°, 90°, 180° and 270°.
const times = meteorSolarLongitudeTimes(2024, [0, deg(90), deg(180), deg(270)])
console.log(times.map((value) => timeToDate(utc(value)).slice(0, 6))) // [[2024, 3, 20, 11, 6, 42], [2024, 6, 21, 5, 17, 2], [2024, 9, 22, 21, 2, 45], [2024, 12, 21, 17, 25, 31]]

// Minimal context shared by batch calculations: time and solar longitude (no observer, so no sidereal time).
const context = meteorComputationContext(time)
console.log(toDeg(context.solarLongitude), context.localSiderealTime) // 282.768 undefined

// Geocentric Sun position and velocity in the ecliptic J2000 frame: AU and AU/day.
const [position, velocity] = meteorSolarRelativeState(time)
console.log(position) // [0.21732, −0.95899, 0.0000523]
console.log(velocity) // [0.017060, 0.0038608, −9.13e-7]
```

`meteorShowerDates(solution, year, options?)` turns the support interval and the reference longitude of a catalog solution into instants: `start`, `reference` and `end`. The reference is the mean activity longitude of the catalog and is not a ZHR maximum. `maximum` is filled only when `options.profile` supplies an explicit profile, because the catalog alone does not define one. An interval that wraps through the new year gets its `end` in the following year, and a full-circle interval ends one year after its start. A dated observation or outburst outside its years returns `{}` unless `options.extrapolateYearLimitedActivity` is set.

```ts
import { meteorShowerDates } from 'nebulosa/src/astronomy/meteors/solar'
import type { MeteorShowerSolution } from 'nebulosa/src/astronomy/meteors/types'
import { timeToDate, utc } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

const solution: MeteorShowerSolution = { activity: { kind: 'annual', source: 'annual' }, activityInterval: { start: deg(280), end: deg(286) }, referenceSolarLongitude: deg(283) }

const dates = meteorShowerDates(solution, 2024, { profile: { type: 'exponential', support: { start: deg(280), end: deg(286) }, solarLongitude: deg(283.2), zhr: 110, slopeBefore: 0.2, slopeAfter: 0.2 } })

console.log(timeToDate(utc(dates.start!))) // [2024, 1, 1, 6, 48, 21, 800]
console.log(timeToDate(utc(dates.reference!))) // [2024, 1, 4, 5, 27, 22, 227]
console.log(timeToDate(utc(dates.end!))) // [2024, 1, 7, 4, 5, 28, 442]
console.log(timeToDate(utc(dates.maximum!))) // [2024, 1, 4, 10, 9, 56, 97]
```

### Meteor Track Association

A single observed meteor can be tested against a shower by geometry: its trail, extended backwards, must pass through the radiant. A `MeteorTrack` is the great-circle arc between two equatorial J2000 points (`start` and `end` in the direction of motion, radians). Only the J2000 frame is supported. The helpers return `undefined` for a degenerate track, one whose two ends coincide or are antipodal and therefore do not define a plane.

`meteorTrackGreatCircle` returns the unit pole of the trail's great circle, `meteorTrackLength` the arc length (radians) and `meteorTrackPoint(track, fraction)` the point at `fraction` of the way along the short arc, with `0` the start and `1` the end. `meteorTrackPositionAngle(start, end)` is the direction of the trail at its start, east of celestial north, in `[0, 2π)`. `meteorRadiantTrackResidual` is the angular distance of a radiant from that great-circle plane (the cross-track error, radians), and `meteorTrackDirectionCompatible` tells whether the meteor moves away from the radiant, as a real shower member must, by comparing the radiant's distances to the two ends.

`associateMeteorTrack(radiant, track, options?)` combines these into one decision. `compatible` requires a non-degenerate track, direction compatibility (unless `requireDirectionCompatibility` is `false`), and each of `maximumCrossTrackError` and `maximumRadiantDistance` (radians) that is set; a threshold that is not set is not applied. `radiantDistance` is the angular distance from the radiant to the start of the trail. It is a geometric screen and does not use the speed or the radiant error, so the thresholds belong to the caller.

```ts
import { associateMeteorTrack, meteorRadiantTrackResidual, meteorTrackDirectionCompatible, meteorTrackGreatCircle, meteorTrackLength, meteorTrackPoint, meteorTrackPositionAngle } from 'nebulosa/src/astronomy/meteors/trajectory'
import type { MeteorRadiant, MeteorTrack } from 'nebulosa/src/astronomy/meteors/types'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const track: MeteorTrack = { start: { rightAscension: deg(220), declination: deg(55) }, end: { rightAscension: deg(228), declination: deg(48) } }
const radiant: MeteorRadiant = { rightAscension: deg(214.2), declination: deg(61.7) }

console.log(meteorTrackGreatCircle(track)) // [0.89389, −0.26973, 0.35807] — unit pole
console.log(toDeg(meteorTrackLength(track)!)) // 8.58
console.log(toDeg(meteorTrackPositionAngle(track.start, track.end))) // 141.37
console.log(meteorTrackPoint(track, 0.5)) // { rightAscension: 3.9149, declination: 0.90003 } — radians

console.log(toDeg(meteorRadiantTrackResidual(radiant, track)!)) // 2.10
console.log(meteorTrackDirectionCompatible(radiant, track)) // true — the meteor moves away from the radiant

const association = associateMeteorTrack(radiant, track, { maximumCrossTrackError: deg(5), maximumRadiantDistance: deg(30) })
console.log(association.compatible, toDeg(association.crossTrackError), toDeg(association.radiantDistance), association.directionCompatible) // true 2.10 7.35 true

// The same trail travelling the other way moves towards the radiant, so it is rejected.
const reversed: MeteorTrack = { start: track.end, end: track.start }
console.log(associateMeteorTrack(radiant, reversed).compatible) // false
console.log(associateMeteorTrack(radiant, reversed, { requireDirectionCompatibility: false }).compatible) // true

// A degenerate track has no plane.
console.log(meteorTrackPoint({ start: track.start, end: track.start }, 0.5)) // undefined
console.log(associateMeteorTrack(radiant, { start: track.start, end: track.start }).compatible) // false
```

### Meteor Trajectory Correction

The direction in which a meteor is seen is not the direction in which it approached the Earth. The Earth's gravity bends the path and speeds the meteoroid up (zenith attraction), and an observer on the rotating Earth adds a velocity of their own. The functions here correct between the geocentric radiant (equatorial J2000, the one of a catalog) and the apparent local radiant. Speeds are AU/day and distances AU. Atmospheric drag is not modeled, and the entry altitude is measured from an explicit reference ellipsoid (default `Ellipsoid.IERS2010`).

The entry speed follows from energy conservation: `v² = Vg² + 2·GM/r`, with `Vg` the asymptotic geocentric speed and `r` the geocentric distance of the entry point. `meteorGeocentricRadius(latitude, entryAltitude?, ellipsoid?)` gives that distance for a geodetic latitude and height, and `meteorSpeedAtGeodeticAltitude` combines both steps. Schiaparelli's zenith attraction `Δz` is the angle by which the apparent zenith angle `z` of the entry is smaller than the geocentric one: `z_geocentric = z + Δz`, with `Δz = 2·atan((v − Vg)·tan(z/2) / (v + Vg))`. The inverse is solved by bisection, which is stable at the zenith and near the horizon, and returns `undefined` for a geocentric zenith angle outside `[0, π/2]`.

```ts
import { apparentZenithAngleFromGeocentric, geocentricZenithAngleFromApparent, meteorGeocentricRadius, meteorSpeedAtDistance, meteorSpeedAtGeodeticAltitude, meteorZenithAttraction } from 'nebulosa/src/astronomy/meteors/trajectory'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer, toKilometer } from 'nebulosa/src/math/units/distance'
import { kilometerPerSecond, toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const speed = kilometerPerSecond(41) // asymptotic geocentric speed Vg
const latitude = deg(40)
const altitude = kilometer(100) // height of the entry point above the ellipsoid

const radius = meteorGeocentricRadius(latitude, altitude)
console.log(toKilometer(radius)) // 6469.34 — from the center of the Earth

const entrySpeed = meteorSpeedAtGeodeticAltitude(speed, latitude, altitude)
console.log(toKilometerPerSecond(entrySpeed)) // 42.476
console.log(toKilometerPerSecond(meteorSpeedAtDistance(speed, radius))) // 42.476

// An apparent zenith angle of 60° corresponds to a geocentric zenith angle 1.17° larger.
console.log(toDeg(meteorZenithAttraction(deg(60), speed, entrySpeed))) // 1.170
console.log(toDeg(geocentricZenithAngleFromApparent(deg(60), speed, entrySpeed))) // 61.170
console.log(toDeg(apparentZenithAngleFromGeocentric(deg(60), speed, entrySpeed)!)) // 58.857
console.log(apparentZenithAngleFromGeocentric(deg(100), speed, entrySpeed)) // undefined — below the horizon
```

`apparentMeteorRadiantHorizontal(radiant, observer, time, options)` takes a geocentric J2000 radiant and returns where it appears for the observer, with the attraction applied to the geometric altitude; the azimuth is unchanged, since the correction acts along the vertical. It returns `undefined` when the geometric radiant is not above the horizon. `geocentricMeteorRadiantFromHorizontal` is the inverse, from an apparent horizontal position (azimuth north through east, altitude, radians) back to the catalog frame, with `undefined` for a non-positive altitude. Both need `options.geocentricSpeed` and `options.entryAltitude`, and refraction is not part of either. In the example, the 41 km/s radiant at an altitude of 47.32° is seen 0.78° higher at 48.10°.

```ts
import { apparentMeteorRadiantHorizontal, geocentricMeteorRadiantFromHorizontal } from 'nebulosa/src/astronomy/meteors/trajectory'
import { meteorRadiantHorizontal } from 'nebulosa/src/astronomy/meteors/radiant'
import type { MeteorRadiant } from 'nebulosa/src/astronomy/meteors/types'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer, meter } from 'nebulosa/src/math/units/distance'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const observer = geodeticLocation(deg(-8), deg(40), meter(100), Ellipsoid.WGS84)
const time = timeYMDHMS(2024, 1, 4, 5, 0, 0, Timescale.UTC)
const radiant: MeteorRadiant = { rightAscension: deg(230.1), declination: deg(48.5) }
const options = { geocentricSpeed: kilometerPerSecond(41), entryAltitude: kilometer(100) }

const geometric = meteorRadiantHorizontal(radiant, observer, time)
console.log(toDeg(geometric.azimuth), toDeg(geometric.altitude)) // 57.973 47.321

const apparent = apparentMeteorRadiantHorizontal(radiant, observer, time, options)!
console.log(toDeg(apparent.azimuth), toDeg(apparent.altitude)) // 57.973 48.097
console.log(toDeg(apparent.rightAscension), toDeg(apparent.declination)) // 228.951 48.657 — J2000

// The inverse recovers the catalog radiant.
const recovered = geocentricMeteorRadiantFromHorizontal(apparent, observer, time, options)!
console.log(toDeg(recovered.rightAscension), toDeg(recovered.declination)) // 230.1 48.5
```

The rotation of the Earth shifts the radiant too. `meteorObserverRotationVelocity(observer, time)` is the velocity of the observer in the GCRS (AU/day), from the ITRS position and the instantaneous angular velocity of the Earth, and has no gravity term. `meteorRadiantWithEarthRotation(radiant, geocentricSpeed, observer, time)` subtracts it from the incoming geocentric velocity and returns the corrected radiant in the same frame, or `undefined` for a zero relative speed. The correction is of the order of the ratio between the rotation speed (up to 0.465 km/s) and the meteor speed, which is a fraction of a degree for fast meteors and larger for slow ones.

```ts
import { meteorObserverRotationVelocity, meteorRadiantWithEarthRotation } from 'nebulosa/src/astronomy/meteors/trajectory'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'
import { kilometerPerSecond, toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const observer = geodeticLocation(deg(-8), deg(40), meter(100), Ellipsoid.WGS84)
const time = timeYMDHMS(2024, 1, 4, 5, 0, 0, Timescale.UTC)

const velocity = meteorObserverRotationVelocity(observer, time)
console.log(velocity) // [−0.000035756, −0.00020294, 8.98e-8] — AU/day
console.log(toKilometerPerSecond(Math.hypot(...velocity))) // 0.3568

const radiant = meteorRadiantWithEarthRotation({ rightAscension: deg(230.1), declination: deg(48.5) }, kilometerPerSecond(41), observer, time)!
console.log(toDeg(radiant.rightAscension), toDeg(radiant.declination)) // 230.471 48.177
```

### Meteor Visual Rates

Visual meteor counts are converted to the zenithal hourly rate (ZHR), the rate an ideal observer would see with the radiant at the zenith under a limiting magnitude of 6.5. The correction is `ZHR = N · F · r^(6.5 − lm) / (T · sin(h)^γ)`: `N` is the count, `F` the obstruction correction (`F ≥ 1`), `r` the population index, `lm` the limiting magnitude, `T` the effective observing time in hours, `h` the geometric radiant altitude (radians) and `γ` the altitude exponent (default 1). An observation with a non-positive effective time or a radiant at or below the horizon yields a ZHR of zero rather than `Infinity`. The local rate returned by `meteorLocalHourlyRate` is the inverse relation: the idealized rate a given ZHR produces under the same conditions, with no lunar or weather penalty.

```ts
import { combineMeteorVisualObservations, meteorLocalHourlyRate, meteorVisualRate, meteorZhrFromObservation } from 'nebulosa/src/astronomy/meteors/observation'
import type { MeteorVisualObservation } from 'nebulosa/src/astronomy/meteors/types'
import { deg } from 'nebulosa/src/math/units/angle'

const observation: MeteorVisualObservation = { count: 25, effectiveTime: 1.5, limitingMagnitude: 6.0, populationIndex: 2.2, obstructionCorrection: 1.1, radiantAltitude: deg(40) }

console.log(meteorZhrFromObservation(observation)) // 42.30 — meteors per hour
console.log(meteorLocalHourlyRate(100, observation)) // 39.40 — local meteors per hour that a ZHR of 100 produces

// Both values with the observation retained for provenance.
const rate = meteorVisualRate(observation)
console.log(rate.zhr, rate.localHourlyRate) // 42.30 16.67

// Observations are combined by exposure, not by averaging their ZHR: total count over corrected time.
const second: MeteorVisualObservation = { ...observation, count: 10, effectiveTime: 1, radiantAltitude: deg(60) }
console.log(combineMeteorVisualObservations([observation, second])) // 31.20 — ZHR
```

The population index `r` is the factor by which the counts grow for each magnitude step fainter, `N(m + Δm) / N(m) = r^Δm`. It converts to the meteor mass index as `s = 1 + 2.3 · log10(r)`. `meteorPopulationIndexFromMagnitudeBins` estimates `r` from counts per magnitude class by a linear regression of `ln N` against magnitude. Bins are weighted by their Poisson count by default (`weighted: false` gives equal weights), bins with a zero count are skipped, and fewer than two usable bins return `undefined`. A bin with a non-finite magnitude or a negative or non-finite count throws an `Error`.

```ts
import { meteorMagnitudeRatio, meteorMassIndex, meteorPopulationIndex, meteorPopulationIndexFromMagnitudeBins } from 'nebulosa/src/astronomy/meteors/observation'

console.log(meteorMagnitudeRatio(2.5, 1)) // 2.5 — one magnitude fainter has 2.5 times more meteors
console.log(meteorMassIndex(2.5)) // 1.9153
console.log(meteorPopulationIndex(meteorMassIndex(2.5))) // 2.5

const bins = [
	{ magnitude: 1, count: 4 },
	{ magnitude: 2, count: 10 },
	{ magnitude: 3, count: 26 },
	{ magnitude: 4, count: 62 },
]

console.log(meteorPopulationIndexFromMagnitudeBins(bins)) // 2.474 — Poisson-weighted
console.log(meteorPopulationIndexFromMagnitudeBins(bins, { weighted: false })) // 2.504
```

Counts are Poisson-distributed, so `meteorGarwoodInterval(count, confidence = 0.95)` gives the exact two-sided confidence interval of the expected count from chi-square quantiles; zero counts have a lower bound of 0. `meteorGarwoodZhr` scales that interval through the linear ZHR correction of one observation. `integrateMeteorExpectedCount` integrates the expected number of meteors seen by one observer over a time window, from a profile and an explicit observing model, with Simpson's rule (trapezoids for an odd number of panels). `radiantAltitude` (or `radiant`) supplies the radiant altitude over time and defaults to the horizon, which gives zero. `rateCorrection` is the only place where weather, coverage or lunar losses can enter, and `step` is the panel width in days (default 1/24).

```ts
import { integrateMeteorExpectedCount, meteorGarwoodInterval, meteorGarwoodZhr } from 'nebulosa/src/astronomy/meteors/observation'
import type { MeteorVisualObservation } from 'nebulosa/src/astronomy/meteors/types'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

console.log(meteorGarwoodInterval(25)) // { lower: 16.18, upper: 36.90 } — 95% interval of a count of 25
console.log(meteorGarwoodInterval(0)) // { lower: 0, upper: 3.689 }

const observation: MeteorVisualObservation = { count: 25, effectiveTime: 1.5, limitingMagnitude: 6.0, populationIndex: 2.2, obstructionCorrection: 1.1, radiantAltitude: deg(40) }
console.log(meteorGarwoodZhr(observation)) // { lower: 27.38, upper: 62.45 } — ZHR

const profile = { type: 'exponential', support: { start: deg(280), end: deg(286) }, solarLongitude: deg(283), zhr: 110, slopeBefore: 0.2, slopeAfter: 0.2 } as const
const start = timeYMDHMS(2024, 1, 4, 2, 0, 0, Timescale.UTC)
const end = timeYMDHMS(2024, 1, 4, 4, 0, 0, Timescale.UTC)

// Two hours with a constant 45° radiant altitude, limiting magnitude 6.5 and 20% losses to clouds.
const count = integrateMeteorExpectedCount(profile, start, end, { limitingMagnitude: 6.5, populationIndex: 2.1, obstructionCorrection: 1, radiantAltitude: () => deg(45), rateCorrection: () => 0.8 })
console.log(count) // 118.62 — meteors
```

### Minimum Orbit Intersection Distance

The MOID is the smallest distance between two orbits as geometric curves, minimized independently over the position on each. It does not depend on where either body is, only on the shapes and orientations of the orbits. An Earth MOID below 0.05 AU is the standard screen for potentially hazardous asteroids: a close approach is geometrically possible, though it need not happen.

`moid(first, second, options?)` takes two `KeplerOrbit`s in the same reference frame and returns `{ distance, trueAnomaly1, trueAnomaly2 }`: the distance in AU and the true anomalies (radians, `[0, 2π)`) where the closest points lie on each orbit. Epoch and mean anomaly are irrelevant. Both orbits must be bound (`e < 1`), or an `Error` is thrown. The search samples both orbits on a grid, finds the local minima of the distance, and refines each by Newton's method; the smallest is the answer. `options.samples` is the grid size per orbit (default 180, 2° apart) and can be raised when the closest-approach valley is narrow, and `options.tolerance` is the refinement tolerance in radians (default 1e-10). Swapping the two orbits gives the same distance. The MOID is a property of osculating orbits at one epoch; it does not predict an encounter.

```ts
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { moid } from 'nebulosa/src/astronomy/orbits/moid'
import { Timescale, time } from 'nebulosa/src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

// Heliocentric ICRF equatorial states at JD 2461200.5 TDB (JPL Horizons): AU and AU/day.
const epoch = time(2461200.5, 0, Timescale.TDB)
const orbit = (position: readonly [number, number, number], velocity: readonly [number, number, number]) => new KeplerOrbit(position, velocity, epoch, GM_SUN_PITJEVA_2005, matIdentity())

const earth = orbit([-0.2139643995461386, -0.910369590875501, -0.3946284477233859], [0.01653870730744617, -0.003392349872193463, -0.001471244370548932])
const apophis = orbit([-0.9239966398806005, 0.5636773710014709, 0.1861766030828077], [-0.008138789687781776, -0.01148145591898846, -0.004471286309082429])
const eros = orbit([-1.158993982497945, -0.5306759952015061, -0.5107638781319018], [0.004824359618549828, -0.01280096500658081, -0.006396039805884967])

const result = moid(apophis, earth)

console.log(result.distance) // 0.00010792 — AU
console.log(toKilometer(result.distance)) // 16144 — km, a potentially hazardous geometry
console.log(toDeg(result.trueAnomaly1), toDeg(result.trueAnomaly2)) // 233.48 99.645 — degrees on Apophis and on Earth

console.log(moid(eros, earth).distance) // 0.14880 — AU
console.log(moid(earth, apophis).distance) // 0.00010792 — AU, argument order does not matter

// A finer grid and tolerance for a narrow valley.
console.log(moid(apophis, earth, { samples: 360, tolerance: 1e-12 }).distance) // 0.00010792 — AU
```

### MPCORB Parsing

The Minor Planet Center distributes osculating orbits in fixed-width text files: MPCORB lines for asteroids and CometEls lines for comets. These functions turn one line into a structured record with angles already converted to radians and distances in AU, ready to build a `KeplerOrbit` (see Asteroid and Comet Orbit Construction).

`mpcorb(line)` parses an MPCORB asteroid line into an `MPCOrbit`: packed designation, absolute magnitude `H` and slope `G`, the packed epoch, mean anomaly, argument of perihelion, node, inclination (radians), eccentricity, mean daily motion (degrees/day, as published), semi-major axis (AU), and the orbit quality and bookkeeping fields. `mpcorbComet(line)` parses a CometEls line into an `MPCOrbitComet`: optional periodic number, orbit type (`P`, `C`, `D`, `X`, `A`, or `I`), perihelion date and distance (AU), eccentricity, angles in radians, and the magnitude parameters. Both return `undefined` for an empty line, and read fixed columns without checking their ranges. The epoch of an asteroid line is a five-character packed date: `unpackDate(packed)` returns `[year, month, day]` and `packDate(year, month, day)` is its inverse, and both throw a `RangeError` on malformed or out-of-range input.

```ts
import { mpcorb, mpcorbComet, packDate, unpackDate } from 'nebulosa/src/astronomy/orbits/mpcorb'
import { toDeg } from 'nebulosa/src/math/units/angle'

const line = '00001    3.34  0.15 K2555 188.70269   73.27343   80.25221   10.58780  0.0794013  0.21424651   2.7660512  0 E2024-V47  7330 125 1801-2024 0.80 M-v 30k MPCLINUX   4000      (1) Ceres              20241101'

const ceres = mpcorb(line)!

console.log(ceres.designation) // (1) Ceres
console.log(ceres.magnitudeH, ceres.magnitudeG) // 3.34 0.15
console.log(ceres.epochPacked, unpackDate(ceres.epochPacked)) // K2555 [2025, 5, 5]
console.log(toDeg(ceres.meanAnomaly)) // 188.70269 — degrees, stored in radians
console.log(ceres.eccentricity, ceres.semiMajorAxis) // 0.0794013 2.7660512 — AU
console.log(ceres.meanDailyMotion) // 0.21424651 — degrees/day

const cometLine = '0001P         2061 08 31.8266  0.583972  0.967311  112.5470   59.6368  162.2146  20250501   4.0  6.0  1P/Halley                                                 98, 1083'

const halley = mpcorbComet(cometLine)!

console.log(halley.number, halley.orbitType, halley.designation) // 1 P 1P/Halley
console.log(halley.perihelionYear, halley.perihelionMonth, halley.perihelionDay, halley.perihelionDayFraction) // 2061 8 31 0.8266
console.log(halley.perihelionDistance, halley.eccentricity) // 0.583972 0.967311
console.log(toDeg(halley.inclination)) // 162.2146 — degrees

console.log(mpcorb('')) // undefined

// Packed dates: century letter, two digits, month and day in base 32.
console.log(packDate(2024, 11, 1)) // K24B1
console.log(unpackDate('J9611')) // [1996, 1, 1]
packDate(2025, 13, 1) // RangeError: invalid packed date value "13"
```

### Mutual Planetary-Satellite Events

The satellites of a giant planet occult and eclipse each other when the Earth (or the Sun) crosses the planet's equatorial plane, a season that comes around once per planetary year: about every six years for Jupiter and about every fifteen for Saturn, so most windows return nothing. A **mutual occultation** is one moon passing in front of another as seen from Earth, and a **mutual eclipse** is one moon casting its shadow on another. `galileanMutualEvents(start, stop, options?)` covers Io, Europa, Ganymede and Callisto with the L1.2 theory, and `saturnianMutualEvents(start, stop, options?)` the seven main moons of Saturn (Mimas, Enceladus, Tethys, Dione, Rhea, Titan and Iapetus) with TASS 1.7; Hyperion is omitted. All pairs are screened for both kinds of event and the result is chronological.

This is the detection layer only: it reports the times, the pair and how central the event is, and it has no light curve, no obscured-area fraction and no magnitude drop. Satellite positions are added to the VSOP87E planet position, so every body shares one barycentric frame. Occultations use the apparent geocentric directions of the two moons, each corrected for its own light time. Eclipses are evaluated from the heliocentric shadow geometry (the shadowed moon must lie behind the caster, and the contact limit is the penumbral radius plus the moon's radius) and are reported at the instant they are seen from Earth. `options` is a `TimeSearchOptions`: `step` (days, default 10 minutes) must be shorter than the width of a conjunction, and `tolerance` is the refinement tolerance.

Each `MutualEvent` has the `kind`, the `front` moon (the nearer one for an occultation, the caster for an eclipse), the `back` moon, the instants of the first contact (`start`), of maximum obscuration (`middle`) and of the last contact (`end`), and the `impactParameter` in `[0, 1)`: the minimum separation divided by the contact limit, zero for a central event and close to one for a grazing one. `start` or `end` is `undefined` when the event is already underway at the start of the window or still underway at its end; the window is padded internally so events that overlap its edges are not lost.

```ts
import { galileanMutualEvents, saturnianMutualEvents } from 'nebulosa/src/astronomy/events/mutual'
import { type Time, Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'

const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

// Jupiter's mutual-event season of 2026-2027. On 2026-12-02 Ganymede casts its shadow on Callisto and on Europa.
const start = timeYMDHMS(2026, 12, 2, 19, 0, 0, Timescale.UTC)
const stop = timeYMDHMS(2026, 12, 2, 22, 0, 0, Timescale.UTC)

for (const event of galileanMutualEvents(start, stop)) {
	console.log(event.kind, event.front, event.back, format(event.start!), format(event.middle), format(event.end!), event.impactParameter)
}
// eclipse ganymede callisto 2026-12-2-20-45-18 2026-12-2-20-51-58 2026-12-2-20-58-38 0.0294 — almost central
// eclipse ganymede europa 2026-12-2-21-43-51 2026-12-2-21-47-32 2026-12-2-21-51-12 0.3122

// Europa passes in front of Ganymede on 2026-12-05. A window that opens in the middle of the event leaves `start` undefined.
const occultations = galileanMutualEvents(timeYMDHMS(2026, 12, 5, 19, 20, 0, Timescale.UTC), timeYMDHMS(2026, 12, 5, 19, 30, 0, Timescale.UTC))
console.log(occultations.map((event) => [event.kind, event.front, event.back, event.start, format(event.middle), format(event.end!), event.impactParameter]))
// [['occultation', 'europa', 'ganymede', undefined, '2026-12-5-19-17-51', '2026-12-5-19-26-47', 0.3236]]

// Outside a season there is nothing to report.
console.log(galileanMutualEvents(timeYMDHMS(2024, 1, 1, 0, 0, 0, Timescale.UTC), timeYMDHMS(2024, 1, 2, 0, 0, 0, Timescale.UTC)).length) // 0

// Saturn, shortly after the ring-plane crossing of 2025: Titan eclipses Rhea, and occults it a few minutes later.
for (const event of saturnianMutualEvents(timeYMDHMS(2025, 3, 12, 10, 0, 0, Timescale.UTC), timeYMDHMS(2025, 3, 12, 13, 0, 0, Timescale.UTC))) {
	console.log(event.kind, event.front, event.back, format(event.middle), event.impactParameter)
}
// eclipse titan rhea 2025-3-12-11-27-26 0.8338
// occultation titan rhea 2025-3-12-11-34-1 0.2453
```

### Nutation and Celestial Orientation

Nutation is the short-period wobble of the Earth's pole on top of precession, expressed as two small angles: `Δψ`, the nutation in longitude, and `Δε`, the nutation in obliquity. Together with precession and the frame bias they orient the true equator and equinox of date, or the CIO-based Celestial Intermediate frame, relative to GCRS.

`nutationAngles(time)` returns `[Δψ, Δε]` in radians from the IAU 2000A model (adjusted for IAU 2006). `cirsRotationMatrix(time)` returns the GCRS to CIRS matrix (frame bias, precession, and nutation, with right ascension on the Celestial Intermediate Origin), which is the right companion for `cirsToObserved` and `observedToCirs`; the equinox-based `precessionNutationMatrix` would offset right ascension by the equation of the origins, about 50″ per year since J2000. `equationOfOrigins(time)` returns the related matrix `Rz(GAST − ERA) · PN`, which agrees with the CIRS matrix to about 1e-9. All are cached on the `Time` and shared, so treat them as read-only. See Precession Matrices for the equinox-based matrices.

```ts
import { cirsRotationMatrix, equationOfOrigins, nutationAngles, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toArcsec } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.TT)

const [deltaPsi, deltaEpsilon] = nutationAngles(time)

console.log(toArcsec(deltaPsi)) // 8.046 — arcseconds, nutation in longitude
console.log(toArcsec(deltaEpsilon)) // 7.477 — arcseconds, nutation in obliquity

console.log(cirsRotationMatrix(time).slice(0, 3)) // [0.9999966, -4.8e-9, -0.0025894] — first row, GCRS to CIRS
console.log(equationOfOrigins(time).slice(0, 3)) // [0.9999966, -4.8e-9, -0.0025894] — the same to about 1e-9
```

### Obliquity and Ecliptic Orientation

The obliquity of the ecliptic is the tilt of the ecliptic plane relative to the Earth's equator, about 23.44°. The mean obliquity follows precession only; the true obliquity adds the nutation in obliquity `Δε`. The ecliptic frame of date is the equator frame of date tilted about the x axis by the obliquity.

`meanObliquity(time)` and `trueObliquity(time)` return radians. `trueEclipticRotation(time)` returns a fresh matrix that takes a GCRS vector to the true ecliptic of date (`Rx(true obliquity)` times the precession-nutation matrix), the same orientation as the `ECLIPTIC` frame. For converting spherical coordinates see Spherical Coordinate Conversions.

```ts
import { meanObliquity, trueEclipticRotation, trueObliquity, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.TT)

console.log(toDeg(meanObliquity(time))) // 23.43583 — degrees
console.log(toDeg(trueObliquity(time))) // 23.43791 — degrees, mean plus nutation in obliquity

// GCRS -> true ecliptic of date; the z row carries sin/cos of the obliquity.
console.log(trueEclipticRotation(time).slice(6, 9)) // [0.0000054, -0.39772, 0.91751]
```

### Observed Catalog Star

The observed place of a catalog star is where an observer on the Earth's surface sees it at a given instant: catalog position and proper motion carried to the date, parallax, light deflection, aberration, precession and nutation, Earth rotation, polar motion, and optionally atmospheric refraction. It is the end of the astrometric chain for a star, one call that gives azimuth, altitude, hour angle, and the apparent right ascension and declination, which is what a mount needs in order to point.

`observeStar(star, time, ebpv, ehp?, refraction?)` takes a `Star` or `StarPositionAndVelocity` (from `star()`, see Stellar Space Motion), the `Time`, the Earth's barycentric `[position, velocity]` in AU and AU/day as `ebpv`, and the Earth's heliocentric position `ehp` (defaulting to `ebpv[0]`). `time.location` is required, as a geodetic site, or it throws an `Error`. `refraction` is `{ pressure (hPa), temperature (°C), relativeHumidity (0..1), wl (µm) }` with defaults for omitted fields, or `false` to disable refraction; leave it `undefined` for the defaults. The result is an `ObservedStar`: the original `star`, `azimuth` (north through east), `altitude` (negative below the horizon), `hourAngle`, the observed `rightAscension` and `declination`, and `equationOfOrigins`, all in radians. The catalog data is taken as referred to J2000.0 and a star with another epoch is propagated to J2000.0 first. UT1 and polar motion come from the loaded Earth orientation data (see Earth Orientation Parameters); the outputs below assume none is loaded. For positions with other body types see Topocentric Observed Place.

```ts
import { observeStar, star } from 'nebulosa/src/astronomy/bodies/star'
import { eraEpv00 } from 'nebulosa/src/astronomy/coordinates/erfa/earth'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { tdb, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { arcsec, deg, hour, toDeg, toHour } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// Barnard's Star, as in Stellar Space Motion.
const declination = deg(4.693391)
const mas = (value: number) => arcsec(value / 1000)
const barnard = star(hour(17 + 57 / 60 + 48.4997 / 3600), declination, mas(-797.84) / Math.cos(declination), mas(10328.12), mas(546.98), kilometerPerSecond(-110.51))

// La Silla, and the time carries the location.
const time = timeYMDHMS(2025, 7, 1, 3, 0, 0, Timescale.UTC)

time.location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))

// The Earth's [heliocentric, barycentric] state at that TDB instant.
const [heliocentric, barycentric] = eraEpv00(tdb(time).day, tdb(time).fraction)

const observed = observeStar(barnard, time, barycentric, heliocentric[0])

console.log(toDeg(observed.azimuth), toDeg(observed.altitude)) // 27.05 52.65 — degrees, north through east
console.log(toDeg(observed.hourAngle)) // -16.07 — degrees, east of the meridian
console.log(toHour(observed.rightAscension), toDeg(observed.declination)) // 17.9624 4.7527 — observed (CIRS) place, hours and degrees
console.log(observed.star === barnard) // true

// Without refraction, and with a thinner, colder atmosphere.
console.log(toDeg(observeStar(barnard, time, barycentric, heliocentric[0], false).altitude)) // 52.64 — degrees
console.log(toDeg(observeStar(barnard, time, barycentric, heliocentric[0], { pressure: 700, temperature: 0 }).altitude)) // 52.65 — degrees

// A missing location is rejected.
observeStar(barnard, timeYMDHMS(2025, 7, 1, 3, 0, 0, Timescale.UTC), barycentric, heliocentric[0]) // Error: time.location is required
```

### Observing Visibility Windows

A target is observable when several conditions hold together: it is high enough, the sky is dark enough, and it is far enough from the Sun and the Moon. `visibilityWindows` turns a set of such constraints into the time intervals where all are met, using the constraint-interval search (see Time-Constraint Intervals).

`visibilityWindows(targetAt, location, start, end, constraints?, sources?)` returns chronological `{ start, end }` intervals inside the window. `targetAt` returns the ICRS-oriented direction of the target at a time, and `location` is the observer. `constraints` selects the limits, all optional and combined: `minimumAltitude` (the target's geometric altitude), `maximumAirmass` (Kasten–Young; converted to a minimum altitude, and the stricter of the two is used, while an airmass below 1 gives no windows), `maximumSunAltitude`, `minimumSunSeparation`, and `minimumMoonSeparation`, all angles in radians. `sources` provides `sunAt` (needed for any solar limit) and `moonAt` (needed for the Moon separation) as direction callbacks, plus the search `step` and `tolerance` in days. A solar or lunar constraint without its callback throws a `RangeError`, since dropping it would report the target as visible without checking that body. An empty constraint set returns the whole window, and a window of zero or negative length returns `[]`. No origin or correction is applied: pass directions in matching frames and corrections, with the topocentric parallax included in the providers if you want it. The step must resolve every crossing of each constraint.

```ts
import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { visibilityWindows } from 'nebulosa/src/astronomy/events/visibility'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, hour } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400)) // La Silla
const start = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.UTC)
const end = timeShift(start, 1)

const star = eraS2c(hour(5.919), deg(7.407)) // fixed direction
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])
const moonAt = (time: Time) => moon(time)[0]

const fmt = (intervals: readonly { start: Time; end: Time }[]) => intervals.map((i) => [timeToDate(i.start).slice(0, 5), timeToDate(i.end).slice(0, 5)])

// Above 30° while the Sun is below -18°.
const dark = visibilityWindows(() => star, site, start, end, { minimumAltitude: deg(30), maximumSunAltitude: deg(-18) }, { sunAt })

console.log(fmt(dark)) // [[[2025, 9, 28, 6, 52], [2025, 9, 28, 9, 5]]] — UTC

// An airmass cap of 2 (altitude about 30°), the Sun below -12° and at least 30° from the Moon.
const strict = visibilityWindows(() => star, site, start, end, { maximumAirmass: 2, maximumSunAltitude: deg(-12), minimumMoonSeparation: deg(30) }, { sunAt, moonAt })

console.log(fmt(strict)) // [[[2025, 9, 28, 6, 52], [2025, 9, 28, 9, 33]]]

console.log(visibilityWindows(() => star, site, start, end).length) // 1 — no constraints: the whole window
console.log(visibilityWindows(() => star, site, start, end, { maximumAirmass: 0.9 })) // [] — airmass below 1 is impossible

visibilityWindows(() => star, site, start, end, { maximumSunAltitude: 0 }) // RangeError: sun direction is required when a solar limit is set
```

### Orbit Covariance Propagation

An orbit fit gives a state and a 6×6 covariance at the fit epoch, and the uncertainty grows as the orbit is propagated away from it. To first order the covariance maps linearly through the state-transition matrix `Φ = ∂state(t)/∂state(epoch)`, so `C(t) = Φ C₀ Φᵀ`. `Φ` is obtained here by central finite differences of the two-body propagation, which reuses `KeplerOrbit`. The linear-Gaussian model is valid while the uncertainty stays small, over short to medium arcs; very poorly constrained orbits need nonlinear methods.

`stateTransitionMatrix(orbit, time, options?)` returns the 6×6 `Φ` (a `Matrix`), with `time` at the epoch giving the identity. `propagateStateCovariance(orbit, covariance, time, options?)` returns `Φ C Φᵀ`; it throws an `Error` unless `covariance` is 6×6. State ordering is `[x, y, z, vx, vy, vz]`, positions in AU and velocities in AU/day, in the frame of the orbit's `position` and `velocity` (not its output `rotation`). The top-left 3×3 block of the result is the position covariance used by Sky-Plane Uncertainty Ellipses. `options.relativeStep` (default 1e-6), `positionFloor` (1e-9 AU), and `velocityFloor` (1e-11 AU/day) control the finite-difference steps. Take the covariance from `fitOrbit` (see Differential Orbit Correction).

```ts
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { propagateStateCovariance, stateTransitionMatrix } from 'nebulosa/src/astronomy/orbits/covariance'
import { Timescale, time } from 'nebulosa/src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { Matrix } from 'nebulosa/src/math/linear-algebra/matrix'

// Vesta's heliocentric equatorial state at 2025-04-21 12:00 TDB (AU, AU/day), kept in its input axes.
const position = [-1.70317472297052, -1.333843040283118, -0.3086709149679688] as const
const velocity = [0.007882762615954012, -0.008079478592200335, -0.004254433056153772] as const
const epoch = time(2460787, 0, Timescale.TDB)
const orbit = new KeplerOrbit(position, velocity, epoch, GM_SUN_PITJEVA_2005, matIdentity())

// An uncorrelated epoch covariance: 4e-5 AU in each position component, 1e-8 AU/day in each velocity component.
// In practice take it from fitOrbit (see Differential Orbit Correction).
const covariance = new Matrix(6, 6)

for (let i = 0; i < 3; i++) {
	covariance.set(i, i, 4e-5 ** 2)
	covariance.set(i + 3, i + 3, 1e-8 ** 2)
}

const later = time(2460787 + 365, 0, Timescale.TDB) // one year after the epoch

const phi = stateTransitionMatrix(orbit, later)

console.log(phi.rows, phi.cols) // 6 6
console.log(phi.get(0, 0)) // -0.1377 — d x(later) / d x(epoch)
console.log(phi.get(0, 3)) // 240.55 — d x(later) / d vx(epoch), in days

const propagated = propagateStateCovariance(orbit, covariance, later)

console.log(Math.sqrt(propagated.get(0, 0))) // 0.0000073 — AU, 1-sigma x a year later
console.log(Math.sqrt(propagated.get(1, 1))) // 0.000184 — AU, 1-sigma y, where the error has grown
console.log(Math.sqrt(propagated.get(2, 2))) // 0.0000755 — AU, 1-sigma z

// At the epoch itself the covariance is unchanged.
console.log(propagateStateCovariance(orbit, covariance, epoch).get(0, 0) / covariance.get(0, 0)) // 1
```

### Osculating Orbital Elements

The osculating elements of a body are the Keplerian elements of the two-body orbit that matches its position and velocity at one instant. They describe the orbit it would follow if every perturbation vanished at that moment, and they drift as perturbations act, so they are tied to an epoch. A `KeplerOrbit` built from a heliocentric state exposes the full set as lazily computed properties (see Asteroid and Comet Orbit Construction for the other ways to build one).

`new KeplerOrbit(position, velocity, epoch, mu?, rotation?)` takes the state in AU and AU/day, an epoch, a gravitational parameter (default the Sun's, AU³/day²), and an output rotation used only by propagation. Distances are AU, angles radians in `[0, 2π)` unless noted, and rates per day. The properties are `semiMajorAxis` (negative for hyperbolas, `Infinity` for parabolas), `semiMinorAxis`, `semiLatusRectum`, `eccentricity`, `eccentricityVector` (toward periapsis), `inclination`, `longitudeOfAscendingNode`, `argumentOfPeriapsis`, `longitudeOfPeriapsis`, `trueAnomaly`, `eccentricAnomaly`, `meanAnomaly`, `meanLongitude`, `trueLongitude`, `argumentOfLatitude`, `nodeVector`, `meanMotionPerDay`, `periodInDays` and `apoapsisDistance` (both `Infinity` for open orbits), `periapsisDistance`, and `periapsisTime`, a TDB `Time`. Circular or equatorial orbits have no node or periapsis, so the node and argument of periapsis fall back to 0 there. The free functions with the same names (for example `semiLatusRectum`, `eccentricityVector`, `inclination`) take the primitive inputs the property uses, and `tisserandParameter(a, e, i, perturberSemiMajorAxis)` classifies a small body relative to a planet: above 3 is typically asteroidal, between 2 and 3 a Jupiter-family comet, and below 2 a Halley-type or nearly isotropic orbit. The elements refer to the frame the state is in, so a state in equatorial axes gives elements relative to the equator.

```ts
import { KeplerOrbit, tisserandParameter } from 'nebulosa/src/astronomy/orbits/asteroid'
import { Timescale, time, timeToDate } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

// Heliocentric state of Vesta from JPL Horizons, 2025-04-21 12:00 TDB: AU and AU/day.
const position = [-1.70317472297052, -1.333843040283118, -0.3086709149679688] as const
const velocity = [0.007882762615954012, -0.008079478592200335, -0.004254433056153772] as const
const vesta = new KeplerOrbit(position, velocity, time(2460787, 0, Timescale.TDB))

console.log(vesta.semiMajorAxis, vesta.eccentricity) // 2.3614 0.090099 — AU
console.log(toDeg(vesta.inclination)) // 22.768 — degrees (equatorial axes, since the state is)
console.log(toDeg(vesta.longitudeOfAscendingNode)) // 18.192 — degrees
console.log(toDeg(vesta.argumentOfPeriapsis)) // 238.53 — degrees
console.log(toDeg(vesta.meanAnomaly), toDeg(vesta.trueAnomaly)) // 328.78 322.87 — degrees

console.log(vesta.periapsisDistance, vesta.apoapsisDistance) // 2.1486 2.5741 — AU
console.log(vesta.periodInDays) // 1325.4 — days
console.log(vesta.meanMotionPerDay) // 0.0047406 — radians/day
console.log(timeToDate(vesta.periapsisTime).slice(0, 3)) // [2021, 12, 28] — last perihelion passage (TDB)

console.log(vesta.eccentricityVector) // [-0.022557, -0.082003, -0.029741] — toward periapsis
console.log(vesta.nodeVector) // [0.95002, 0.31220, 0] — unit vector toward the ascending node

// Tisserand parameter relative to Jupiter (a = 5.2044 AU); more than 3 means asteroidal.
console.log(tisserandParameter(vesta.semiMajorAxis, vesta.eccentricity, vesta.inclination, 5.2044)) // 3.4411
```

### Planetary Apparent Magnitudes (Mallama and Hilton)

The apparent magnitude of a planet depends on how far it is from the Sun and from the observer, `5·log10(r·Δ)`, and on how much of its lit face we see, which is set by the phase angle (the Sun-planet-observer angle). Each planet adds its own brightness term: Saturn's brightness includes the rings and depends on how open they are, Uranus's depends on its polar aspect, and Neptune brightens slowly with time. The model of Mallama and Hilton (2018), used for the Astronomical Almanac, gives visual magnitudes from these.

`planetMagnitude(planet, sunToPlanet, observerToPlanet, options?)` takes the planet name (`'mercury'`, `'venus'`, `'earth'`, `'mars'`, `'jupiter'`, `'saturn'`, `'uranus'`, or `'neptune'`) and two vectors in AU in any one consistent frame: from the Sun to the planet and from the observer to the planet. The distances and phase angle follow from them, so geometric vectors give consistent results. It returns the magnitude, or `NaN` where the model is undefined: Saturn with its rings beyond a 6.5° phase angle, or Neptune beyond 1.9° before the year 2000. `options.year` is the Julian year of the observation, which feeds Neptune's secular term (default 2000), and `options.rings` (default true) includes Saturn's rings. The Mars rotation and season correction, up to ±0.06 mag, is not modelled. A smaller number is brighter.

```ts
import { type Planet, planetMagnitude } from 'nebulosa/src/astronomy/bodies/photometry'
import { earth, jupiter, mars, mercury, neptune, saturn, sun, uranus, venus } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, timeYMDHMS, toJulianEpoch } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)
const year = toJulianEpoch(time)

// Vectors in the barycentric ICRS frame, in AU: Sun to planet and observer (the Earth's center) to planet.
const magnitude = (planet: typeof venus, name: Planet) => planetMagnitude(name, vecMinus(planet(time)[0], sun(time)[0]), vecMinus(planet(time)[0], earth(time)[0]), { year })

console.log(magnitude(mercury, 'mercury')) // 1.831
console.log(magnitude(venus, 'venus')) // -4.059
console.log(magnitude(mars, 'mars')) // 1.304
console.log(magnitude(jupiter, 'jupiter')) // -1.812
console.log(magnitude(saturn, 'saturn')) // 0.783 — with the rings
console.log(magnitude(uranus, 'uranus')) // 5.811
console.log(magnitude(neptune, 'neptune')) // 7.765 — year 2026.49

// Saturn's globe alone, without the rings.
console.log(planetMagnitude('saturn', vecMinus(saturn(time)[0], sun(time)[0]), vecMinus(saturn(time)[0], earth(time)[0]), { rings: false })) // 0.846

// A planet at zero phase angle: Sun, planet and observer on one line, 5 AU and 4 AU away.
console.log(planetMagnitude('jupiter', [5, 0, 0], [4, 0, 0])) // -2.890 — base magnitude plus 5·log10(20)

// Saturn with rings beyond a 6.5° phase angle is outside the model.
console.log(planetMagnitude('saturn', [10, 0, 0], [10 * Math.cos(0.17), 10 * Math.sin(0.17), 0])) // NaN
```

### Planetary Closest Approaches

A planet's distance from the observer is not constant: for Mars it swings from about 0.4 AU at a favorable opposition to over 2.5 AU near conjunction. A closest approach is a local minimum of that distance.

`planetaryClosestApproaches(targetAt, start, stop, options?)` returns the local minima of the observer-target distance in the window as chronological `{ time, distance }`, with `distance` in AU. `targetAt` is a function of `Time` returning the observer-to-target vector in ICRS-oriented axes (AU), so the same function serves geocentric, topocentric, or heliocentric distances. No correction is added: choose geometric, astrometric, or apparent vectors yourself. The search is the extremum scan of Time-Domain Extrema Search with `options.step` and `options.tolerance` (days; the step must resolve the event), and a minimum sitting at the first or last sample of the window is not reported. The physical or angular diameter is a separate calculation.

```ts
import { earth, mars, venus } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryClosestApproaches } from 'nebulosa/src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'

const start = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const stop = timeShift(start, 366)

// Geocentric geometric vectors (AU) of Mars and Venus.
const marsAt = (time: Time) => vecMinus(mars(time)[0], earth(time)[0])
const venusAt = (time: Time) => vecMinus(venus(time)[0], earth(time)[0])

for (const approach of planetaryClosestApproaches(marsAt, start, stop, { step: 2 })) console.log(timeToDate(approach.time).slice(0, 5), approach.distance)
// [2020, 10, 6, 14, 19] 0.4149 — Mars, TT, AU

console.log(planetaryClosestApproaches(venusAt, start, stop, { step: 2 }).map((a) => [timeToDate(a.time).slice(0, 5), a.distance])) // [[[2020, 6, 3, 17, 0], 0.2886]] — Venus, near inferior conjunction
```

### Planetary Conjunctions

A conjunction is when a planet and the Sun have the same ecliptic longitude as seen from the observer, so the planet is lost in the Sun's glare. In practice the planet is rarely exactly on the Sun's disk, because of the inclination of its orbit, so the event is taken as the local minimum of the angular separation, which is reported as it is. For an inner planet there are two kinds: inferior conjunction, between the Earth and the Sun, and superior conjunction, beyond the Sun.

`planetaryConjunctions(targetAt, sunAt, start, stop, options?)` returns the separation minima in the window as chronological `{ time, elongation }`, with `elongation` the actual target-Sun separation in radians. `planetaryInnerConjunctions` returns the same events as `{ time, elongation, kind }`, where `kind` is `'inferior'` when the target is closer to the observer than the Sun and `'superior'` otherwise; use it for Mercury and Venus. Both providers, `targetAt` and `sunAt`, return the observer-relative ICRS-oriented vector at a time, in AU, and must share the observer and correction stage. `options.step` and `options.tolerance` are in days. For the outer planets conjunction is the minimum of the same quantity; their opposition is in Planetary Oppositions.

```ts
import { earth, sun, venus } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryConjunctions, planetaryInnerConjunctions } from 'nebulosa/src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const stop = timeShift(start, 366)

const venusAt = (time: Time) => vecMinus(venus(time)[0], earth(time)[0])
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])

const [conjunction] = planetaryConjunctions(venusAt, sunAt, start, stop, { step: 2 })

console.log(timeToDate(conjunction.time).slice(0, 5)) // [2020, 6, 3, 18, 43] — TT
console.log(toDeg(conjunction.elongation)) // 0.482 — degrees, Venus passes 0.48° from the Sun's center

const [inner] = planetaryInnerConjunctions(venusAt, sunAt, start, stop, { step: 2 })

console.log(inner.kind) // inferior — Venus is nearer the Earth than the Sun
```

### Planetary Disk Transits

A transit is a planet's disk crossing the Sun's disk, possible only for Mercury and Venus at inferior conjunction when their orbits are aligned with the Earth's. Seen from a given site it is a chord across the solar disk, with four contacts: exterior ingress (I, the disk first touches the limb), interior ingress (II, the disk is wholly inside), interior egress (III), and exterior egress (IV). Because the planet is much closer than the Sun, its parallax shifts the contact times by minutes from site to site.

`planetaryTransits(planet, sun, observer, start, stop, options)` predicts the transits seen from one observer in the window. `planet`, `sun`, and `observer` are functions of `Time` returning barycentric `[position, velocity]` states (AU, AU/day); the observer is a topocentric state, for example from `observerState` (see Barycentric and Heliocentric Light-Time Correction). `options.sunRadius` and `options.planetRadius` are the physical radii in AU and are required, since they set the angular disks. `options.step` is the coarse step in days (default 2 minutes, capped so the window has at least four intervals), `options.tolerance` the refinement tolerance, and `options.lightTimeIterations` the light-time iterations (default 2). Each `PlanetaryTransit` has the mid-transit `time` (least separation of the centers), `minSeparation` (the impact parameter, radians), the two angular radii, `full` (whether the planet is ever wholly inside the disk, false for a grazing transit), the four contacts (`exteriorIngress`, `interiorIngress`, `interiorEgress`, `exteriorEgress`), the position angles of the first and last contact on the Sun's limb (north through east, radians), and `duration` in seconds from I to IV. Contacts outside the search window are `undefined`, as is the duration, and a grazing transit has no interior contacts. Times keep the scale of `start`. Aberration is omitted because it cancels in the difference, and light bending near the limb is not modelled, so contacts are good to about a second or two.

```ts
import { observerState } from 'nebulosa/src/astronomy/coordinates/correction'
import { earth, mercury, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryTransits } from 'nebulosa/src/astronomy/events/transit'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { type Time, Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { SUN_RADIUS_AU } from 'nebulosa/src/core/constants'
import { deg, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer } from 'nebulosa/src/math/units/distance'

// Greenwich, as a topocentric observer: the Earth's state plus the site offset.
const greenwich = geodeticLocation(deg(-0.0015), deg(51.4779), kilometer(0.047), Ellipsoid.WGS84)
const observer = (time: Time) => observerState(time, earth(time), greenwich)

// The 13 November 2032 transit of Mercury.
const [transit] = planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 11, 13, 5, 0, 0, Timescale.UTC), timeYMDHMS(2032, 11, 13, 12, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: kilometer(2439.7) })

console.log(transit.full) // true
console.log(timeToDate(transit.exteriorIngress!).slice(0, 6)) // [2032, 11, 13, 6, 41, 35] — contact I, UTC
console.log(timeToDate(transit.interiorIngress!).slice(0, 6)) // [2032, 11, 13, 6, 43, 39] — contact II
console.log(timeToDate(transit.time).slice(0, 6)) // [2032, 11, 13, 8, 54, 48] — mid-transit
console.log(timeToDate(transit.interiorEgress!).slice(0, 6)) // [2032, 11, 13, 11, 5, 55] — contact III
console.log(timeToDate(transit.exteriorEgress!).slice(0, 6)) // [2032, 11, 13, 11, 7, 59] — contact IV

console.log(toArcsec(transit.minSeparation)) // 569.4 — arcseconds, impact parameter
console.log(toArcsec(transit.sunAngularRadius), toArcsec(transit.planetAngularRadius)) // 969.4 4.97 — arcseconds
console.log(toDeg(transit.ingressPositionAngle!), toDeg(transit.egressPositionAngle!)) // 77.78 329.23 — degrees, north through east
console.log(transit.duration! / 3600) // 4.44 — hours from I to IV

// A window with no transit returns an empty list.
console.log(planetaryTransits(mercury, sun, observer, timeYMDHMS(2032, 12, 13, 0, 0, 0, Timescale.UTC), timeYMDHMS(2032, 12, 14, 0, 0, 0, Timescale.UTC), { sunRadius: SUN_RADIUS_AU, planetRadius: kilometer(2439.7) })) // []
```

### Planetary Greatest Elongations

An inner planet never strays far from the Sun in the sky. Its elongation, the angular separation from the Sun, rises to a maximum and falls again over each synodic period, and that maximum is the greatest elongation: about 28° for Mercury and 47° for Venus, at their best for observing. It happens east of the Sun in the evening sky and west of it in the morning sky.

`planetaryGreatestElongations(targetAt, sunAt, start, stop, options?)` returns the elongation maxima in the window as chronological `{ time, elongation, kind }`, with `elongation` in radians in `[0, π]` and `kind` `'east'` or `'west'` from the sign of the ecliptic-longitude difference of date, correct across the 0/2π seam. `targetAt` and `sunAt` return the observer-relative ICRS-oriented vectors at a time and must share the observer, axes, and correction stage. No synodic span is chosen for you, so set `start` and `stop` to cover what you want, and `options.step` and `options.tolerance` (days) must resolve the maxima. It is intended for inner planets: for an outer planet use Planetary Oppositions and Planetary Quadratures.

```ts
import { earth, sun, venus } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryGreatestElongations } from 'nebulosa/src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const stop = timeShift(start, 366)

const venusAt = (time: Time) => vecMinus(venus(time)[0], earth(time)[0])
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])

for (const event of planetaryGreatestElongations(venusAt, sunAt, start, stop, { step: 2 })) console.log(timeToDate(event.time).slice(0, 5), toDeg(event.elongation), event.kind)
// [2020, 3, 24, 21, 59] 46.08 east — evening star, TT
// [2020, 8, 13, 0, 0] 45.79 west — morning star
```

### Planetary Oppositions

An outer planet is in opposition when it lies opposite the Sun in the sky, so it is up all night, at its closest and brightest. Because planetary orbits are inclined, the elongation reaches its maximum near, but rarely exactly at, 180°, so the event is taken as the maximum of the separation on the far side of quadrature.

`planetaryOppositions(targetAt, sunAt, start, stop, options?)` returns chronological `{ time, elongation }`, with `elongation` in radians, the separation maxima over 90° in the window. `targetAt` and `sunAt` return the observer-relative ICRS-oriented vectors at a time (AU) with the same observer, axes, and correction stage. The reported elongation need not reach π. `options.step` and `options.tolerance` are in days, and a maximum at the first or last sample is missed. For the closest distance, which can differ by days, use Planetary Closest Approaches.

```ts
import { earth, mars, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryOppositions } from 'nebulosa/src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const stop = timeShift(start, 366)

const marsAt = (time: Time) => vecMinus(mars(time)[0], earth(time)[0])
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])

const [opposition] = planetaryOppositions(marsAt, sunAt, start, stop, { step: 2 })

console.log(timeToDate(opposition.time).slice(0, 5)) // [2020, 10, 14, 2, 2] — TT
console.log(toDeg(opposition.elongation)) // 177.0 — degrees: Mars is 3° off the exact opposite direction
```

### Planetary Quadratures

A planet is at quadrature when it is 90° from the Sun as seen from the observer. For an outer planet it marks the half-lit phase and the boundary between the morning and evening halves of its apparition. East quadrature has the planet east of the Sun, in the evening sky, and west quadrature has it west, in the morning sky.

`planetaryQuadratures(targetAt, sunAt, start, stop, options?)` returns the instants the separation crosses 90° as chronological `{ time, elongation, kind }`, where `elongation` is the resolved separation in radians (close to π/2) and `kind` is `'east'` or `'west'` from the ecliptic-longitude difference, safe across the 0/2π seam. `targetAt` and `sunAt` return observer-relative ICRS-oriented vectors at a time, sharing the observer, axes, and correction stage. `options.step` and `options.tolerance` (days) must resolve the crossings.

```ts
import { earth, mars, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryQuadratures } from 'nebulosa/src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const stop = timeShift(start, 366)

const marsAt = (time: Time) => vecMinus(mars(time)[0], earth(time)[0])
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])

for (const event of planetaryQuadratures(marsAt, sunAt, start, stop, { step: 2 })) console.log(timeToDate(event.time).slice(0, 5), toDeg(event.elongation), event.kind)
// [2020, 6, 6, 19, 2] 90 west — Mars in the morning sky, TT
```

### Planetary Stations

Seen from the Earth, a planet normally drifts eastward among the stars, direct motion, but around opposition (for an outer planet) or inferior conjunction (for an inner one) it appears to reverse for weeks: retrograde motion. The station is the moment its ecliptic longitude stops changing and the motion reverses, from direct to retrograde and back.

`planetaryStations(targetAt, start, stop, options?)` returns the stations in the window as chronological `{ time, kind, longitude }`, where `kind` is `'directToRetrograde'` or `'retrogradeToDirect'` and `longitude` is the signed true ecliptic longitude of date at the station in radians, in `(−π, π]`. It is the root of the longitude rate, estimated by a centered difference of the ecliptic longitude of date (precession and nutation applied, so the orientation must vary smoothly with time). `targetAt` returns the observer-relative ICRS-oriented vector (AU), `options.derivativeHalfStep` is the half-step of that difference in days (default 0.5, must be positive and finite, and the providers must cover the window extended by twice that), and `options.step` and `options.tolerance` are the search step and tolerance in days. A tangential zero rate that does not change sign is not a station. A non-positive `derivativeHalfStep` throws a `RangeError`.

```ts
import { earth, mars } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { planetaryStations } from 'nebulosa/src/astronomy/events/planetary'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const start = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.TT)
const stop = timeShift(start, 366)

const marsAt = (time: Time) => vecMinus(mars(time)[0], earth(time)[0])

for (const station of planetaryStations(marsAt, start, stop, { step: 2 })) console.log(station.kind, timeToDate(station.time).slice(0, 5), toDeg(station.longitude))
// directToRetrograde [2020, 9, 9, 22, 19] 28.14 — TT, ecliptic longitude in degrees
// retrogradeToDirect [2020, 11, 14, 0, 32] 15.23

planetaryStations(marsAt, start, stop, { derivativeHalfStep: 0 }) // RangeError: value must be positive
```

### Planetary Surface Locations

A point on the surface of another body is described by planetocentric east longitude, latitude from the body's equatorial plane, and elevation above a reference triaxial ellipsoid, in the body-fixed frame. Moving it to the inertial frame needs the body's orientation (see IAU Body Orientation, or a SPICE or PCK frame) and carries the rotational velocity of the surface. The result composes with a body-center ephemeris, so the crater or landing site works anywhere a body ephemeris does (see Ephemeris Path Adapters). Elevation here is a radial offset along the planetocentric direction, not a planetographic or geodetic height, and the surface normal is that of the reference ellipsoid, ignoring relief.

`bodyShape(radii)` builds the ellipsoid from three semi-axes in AU, along body-fixed X, Y, and Z, as an array or as an `{ x, y, z }` record such as the SPICE body radii (see SPICE Body Radii). `bodySurfaceLocation(longitude, latitude, elevation, shape, frame)` builds a `BodySurfaceLocation`, with the angles in radians (longitude wrapped to `[0, 2π)`), `elevation` in AU, and `frame` the body-fixed `Frame`; it caches the body-fixed Cartesian point. `bodySurfaceNormal(location, out?)` returns the unit outward normal of the reference ellipsoid in body-fixed axes, written into `out` when given. `bodySurfaceState(location, time, out?)` returns the location's `[position, velocity]` relative to the body center in the library's base axes (AU, AU/day), including the velocity from the frame's rotation; a frame without `dRdtTimesRtAt` adds none. `bodySurfacePositionAndVelocity(body, location)` returns a state sampler that adds that to a body ephemeris, so it behaves like any body in the library. The solar altitude at such a location is in Body-Surface Solar Illumination.

```ts
import { bodyFixedFrame } from 'nebulosa/src/astronomy/bodies/orientation'
import { MARS_ROTATION } from 'nebulosa/src/astronomy/bodies/orientation.data'
import { mars } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { bodyShape, bodySurfaceLocation, bodySurfaceNormal, bodySurfacePositionAndVelocity, bodySurfaceState } from 'nebulosa/src/astronomy/observer/body'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer, toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

// Mars as an oblate ellipsoid: 3396.2 km equatorial and 3376.2 km polar radii.
const shape = bodyShape([kilometer(3396.2), kilometer(3396.2), kilometer(3376.2)])

// 18° N, 135° W (225° E), at the reference surface, in the IAU body-fixed frame.
const location = bodySurfaceLocation(deg(-135), deg(18), 0, shape, bodyFixedFrame(MARS_ROTATION))

console.log(toDeg(location.longitude)) // 225 — degrees east, wrapped
console.log(location.bodyFixed!.map(toKilometer)) // [-2282.64, -2282.64, 1048.89] — km, body-fixed axes
console.log(bodySurfaceNormal(location)) // [-0.6717, -0.6717, 0.3123] — unit outward normal of the ellipsoid

// Its state relative to Mars's center in ICRF axes, with the velocity from Mars's rotation.
const [position, velocity] = bodySurfaceState(location, time)

console.log(position.map(toKilometer)) // [3155.32, -873.54, -895.52] — km
console.log(velocity) // [0.0000434, 0.0001193, 0.0000366] — AU/day, about 0.23 km/s

// Added to Mars's barycentric ephemeris, it becomes an ordinary barycentric body.
const site = bodySurfacePositionAndVelocity(mars, location)

console.log(site(time)[0]) // [1.18438, 0.74857, 0.31160] — AU, close to Mars's own position
console.log(mars(time)[0]) // [1.18435, 0.74858, 0.31160] — AU

// A point 21.9 km above the reference surface is that much farther from the center.
const summit = bodySurfaceLocation(deg(-135), deg(18), kilometer(21.9), shape, bodyFixedFrame(MARS_ROTATION))

console.log(Math.hypot(...summit.bodyFixed!.map(toKilometer))) // 3416.17 — km from the center
```

### Pluto Short Analytical Theory

Pluto's orbit is strongly perturbed by Neptune's 3:2 resonance, so a simple Kepler orbit is a poor model. Meeus (Astronomical Algorithms, chapter 37) gives a short theory that fits the heliocentric longitude, latitude, and radius with 43 periodic terms in the mean longitudes of Jupiter, Saturn, and Pluto. Its stated accuracy is 0.07″ in longitude, 0.02″ in latitude, and 0.000006 AU in radius, and it is valid only for 1885 to 2099.

`pluto(time, frame?)` returns Pluto's heliocentric position in AU as a Cartesian `[x, y, z]` in the ICRF equatorial frame by default. Unlike the planet theories it returns a position only, with no velocity. With `frame = 'eclipticJ2000'` it returns the underlying spherical coordinates `[longitude, latitude, radius]` instead (radians, radians, AU), referred to the J2000 ecliptic, not Cartesian ecliptic coordinates. The time is converted to TT. Outside 1885 to 2099 the result is not meaningful; use an SPK kernel (see SPK State Kernels) there. For barycentric Pluto, add the Sun's barycentric state.

```ts
import { pluto } from 'nebulosa/src/astronomy/ephemeris/models/analytical/pluto'
import { Timescale, time, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

const instant = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

console.log(pluto(instant)) // [18.971, -26.376, -13.945] — AU, heliocentric ICRF equatorial

// Spherical J2000 ecliptic: longitude, latitude, radius.
const [longitude, latitude, radius] = pluto(instant, 'eclipticJ2000')

console.log(toDeg(longitude), toDeg(latitude), radius) // 302.53 -3.7346 35.356 — degrees, degrees, AU

// Meeus example 37.a, JD 2448908.5 TT.
const [lon, lat, r] = pluto(time(2448908, 0.5, Timescale.TT), 'eclipticJ2000')

console.log(toDeg(lon), toDeg(lat), r) // 232.74071 14.58782 29.711111 — degrees, degrees, AU
```

### Polar Motion

Polar motion is the slow drift of the Earth's rotation pole relative to the crust, described by two angles `x` and `y` of a few tenths of an arcsecond, plus the tiny TIO locator `s′`. It tilts the Earth-fixed frame slightly and matters for precise Earth-fixed positions and topocentric work.

`pmAngles(time, pm?)` returns `[s′, x, y]` in radians and `pmMatrix(time, pm?)` the 3×3 polar-motion rotation built from them. A `PolarMotion` provider is a function of `Time` returning `[x, y]` in radians. Without `pm`, the provider assigned to the `Time` (`time.providers.pm`) is used, then the default from the loaded IERS tables, which gives `[0, 0]` when nothing is loaded (see Earth Orientation Parameters). Pass `pm` to override it for one call; `NO_POLAR_MOTION` is the provider that disables polar motion. The results are cached on the `Time` per provider.

```ts
import { NO_POLAR_MOTION, pmAngles, pmMatrix, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { arcsec, toArcsec } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UT1)

// A custom provider: x = 0.19", y = 0.32" (radians).
const provider = () => [arcsec(0.19), arcsec(0.32)] as [number, number]

console.log(pmAngles(time, provider).map(toArcsec)) // [-0.0000125, 0.19, 0.32] — arcseconds: s', x, y
console.log(pmMatrix(time, provider).slice(0, 3)) // [1, -5.9e-11, 9.2e-7] — first row of the rotation
console.log(pmAngles(time, NO_POLAR_MOTION).map(toArcsec)) // [-0.0000125, 0, 0] — only the TIO locator remains
```

### Precession Matrices

Precession is the slow, steady motion of the Earth's rotation axis (a 26,000-year cycle) that moves the equator and equinox of date relative to the fixed GCRS axes. Nutation adds the short-period wobble on top. Both rotate GCRS vectors into the equator-and-equinox frame of date.

`precessionMatrix(time)` is the IAU 2006 precession matrix including the frame bias, taking a GCRS vector to the mean equator and equinox of date. `precessionNutationMatrix(time)` adds nutation and gives the true equator and equinox of date (see Nutation and Celestial Orientation). Both are cached on the `Time`, so treat them as read-only. `precessionMatrixCapitaine(from, to)` is the precession between two equinoxes, as a fresh matrix that takes a vector at `from` to `to`; the FK5 helpers in FK5 Precession and ICRS Frame Bias use it. Times are converted to TT internally.

```ts
import { precessionMatrixCapitaine } from 'nebulosa/src/astronomy/coordinates/frame'
import { precessionMatrix, precessionNutationMatrix, Timescale, timeJulianYear, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.TT)

// GCRS -> mean equator and equinox of date (frame bias + precession).
console.log(precessionMatrix(time).slice(0, 3)) // [0.99997914, -0.0059238, -0.0025737] — first row

// GCRS -> true equator and equinox of date (adds nutation).
console.log(precessionNutationMatrix(time).slice(0, 3)) // [0.99997889, -0.0059596, -0.0025892] — first row

// Precession only, between equinoxes J2000.0 and J2026.5 (both TT).
console.log(precessionMatrixCapitaine(timeJulianYear(2000), timeJulianYear(2026.5)).slice(0, 3)) // [0.99997913, -0.0059259, -0.0025747]
```

### Projected Paths and Polygons

A path across the sky or a map, such as a satellite ground track or an eclipse limit, becomes a set of lines when projected. Where it crosses the antimeridian, or runs off the visible hemisphere or into a singularity, the projected line must be cut rather than drawn straight across the map. These helpers do the cutting.

`projectMany(projection, points, options?, out?)` projects an array of spherical `{ x: longitude, y: latitude }` points in radians into planar points, filling `out`; it returns `undefined` if any point is outside the projection's domain. `projectPolyline(projection, points, options?)` returns an array of planar polylines, splitting the path where the longitude jumps by more than `splitLongitudeGap` (default π, an antimeridian crossing), where a point is not projectable (such as the far side of an orthographic view), and where consecutive projected points are farther apart than `discontinuityThreshold` (planar units). `maxSegmentRadians` first densifies long segments along the shorter longitude path, so a long great-circle-like step is split correctly and shows its curvature. The `ProjectionPolylineOptions` extend the projection options (central meridian, scale, wrap mode, and so on). `projectPolygon(projection, rings, options?)` applies the same to each ring of a polygon and returns the resulting pieces per ring; a ring that crosses the antimeridian comes back in several pieces that the caller closes or fills as needed. An empty input returns `[]`.

```ts
import { Orthographic, PlateCarree, projectMany, projectPolygon, projectPolyline } from 'nebulosa/src/astronomy/projections/projection'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const map = new PlateCarree()

// Project a few points: x = longitude, y = latitude.
console.log(
	projectMany(map, [
		{ x: 0, y: 0 },
		{ x: deg(10), y: deg(20) },
	]),
) // [{ x: 0, y: 0 }, { x: 0.1745, y: 0.3491 }]

// A track crossing the 180° meridian is cut into two lines instead of one line across the map.
const track = [170, 175, -175, -170].map((longitude) => ({ x: deg(longitude), y: deg(10) }))
const lines = projectPolyline(map, track)

console.log(lines.length) // 2
console.log(lines.map((line) => line.map((p) => [toDeg(p.x), toDeg(p.y)]))) // [[[170, 10], [175, 10]], [[-175, 10], [-170, 10]]]

// Densify long segments: a 90° step becomes four points, each at most 30° apart.
console.log(
	projectPolyline(
		map,
		[
			{ x: 0, y: 0 },
			{ x: deg(90), y: 0 },
		],
		{ maxSegmentRadians: deg(30) },
	)[0].length,
) // 4

// Points on the far side of an orthographic globe are dropped; the visible part remains one line.
const globe = new Orthographic(0, 0)
const equator = [0, 40, 80, 120, 160].map((longitude) => ({ x: deg(longitude), y: 0 }))

console.log(projectPolyline(globe, equator).map((line) => line.length)) // [3]

// A polygon ring crossing the antimeridian comes back in pieces: one entry per ring, each a list of lines.
const ring = [
	{ x: deg(170), y: deg(10) },
	{ x: deg(-170), y: deg(10) },
	{ x: deg(-170), y: deg(20) },
	{ x: deg(170), y: deg(20) },
	{ x: deg(170), y: deg(10) },
]

console.log(projectPolygon(map, [ring]).map((pieces) => pieces.map((piece) => piece.length))) // [[1, 2, 2]]
```

### Radial Doppler Shift

The Doppler shift is the change in a received frequency caused by motion along the line of sight: a receding source is redshifted, an approaching one blueshifted. `radialDopplerShift` is the classical first-order shift `−(rangeRate / c) · f`, which assumes `|rangeRate| ≪ c` and ignores relativistic and transverse terms. It suits radio tracking of satellites and spacecraft, not high-velocity sources.

`rangeRate` is the receiver-to-source range derivative in AU/day, positive when receding. The result is in the unit of `carrierFrequency`, negative for receding (a redshift).

```ts
import { radialDopplerShift } from 'nebulosa/src/astronomy/formulas'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// rangeRate: AU/day (kilometerPerSecond converts km/s). carrierFrequency: Hz.
console.log(radialDopplerShift(kilometerPerSecond(7), 145.8e6)) // -3404.4 — Hz, receding source
console.log(radialDopplerShift(kilometerPerSecond(-7), 145.8e6)) // 3404.4 — Hz, approaching source
```

### Radial Velocity Correction

A measured radial velocity includes the observer's own motion. The correction projects the observer's velocity onto the line of sight so the measurement can be referred to the solar-system barycenter or to the Sun: `rv_referred = rv_topocentric + correction`. A positive correction means the observer is moving toward the source.

`radialVelocityCorrection` returns that value in AU/day for an ICRS direction (right ascension and declination in radians). The reference center follows the Earth state you pass, barycentric or heliocentric, and `location` adds the site's diurnal rotation; omit it for a geocentric correction. It is a first-order Newtonian projection and does not use the source's own velocity. Use `kilometerPerSecond` and `toKilometerPerSecond` to convert. For the timing counterpart, see Barycentric and Heliocentric Light-Time Correction.

```ts
import { radialVelocityCorrection } from 'nebulosa/src/astronomy/coordinates/correction'
import { eraEpv00 } from 'nebulosa/src/astronomy/coordinates/erfa/earth'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { tdb, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, hour } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'
import { toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400))
const time = timeYMDHMS(2020, 1, 1, 0, 0, 0, Timescale.UTC)
const t = tdb(time)
const [heliocentric, barycentric] = eraEpv00(t.day, t.fraction)

// Source at RA 5.5 h, Dec -5°. Earth state sets the reference center.
const correction = radialVelocityCorrection(hour(5.5), deg(-5), time, barycentric, location)

console.log(toKilometerPerSecond(correction)) // -8.056 — km/s, barycentric
console.log(toKilometerPerSecond(radialVelocityCorrection(hour(5.5), deg(-5), time, heliocentric, location))) // -8.061 — km/s, heliocentric
console.log(toKilometerPerSecond(radialVelocityCorrection(hour(5.5), deg(-5), time, barycentric))) // -8.381 — km/s, geocentric (no diurnal term)
```

### Refractive Displacement

The atmosphere bends light, so a source appears higher than its geometric position. The displacement depends on the apparent altitude, the pressure, temperature, and humidity, and the observing wavelength. It is about a minute of arc at 45° and grows to roughly 10′ at 1°.

`refractiveDisplacement(altitude, wavelengthMicrons, conditions?)` returns the displacement in radians at one wavelength, using the same bounded, Newton-corrected ERFA model as the observed-place transforms (see Topocentric Observed Place). `altitude` is the apparent altitude in radians, strictly above the horizon, and at most π/2. The result is the amount by which the apparent altitude exceeds the unrefracted (geometric) altitude, so it is positive, finite at low altitude, and exactly 0 at the zenith. It returns `undefined` at or below the horizon, where this planning API does not apply. `conditions` is `{ pressure (hPa), temperature (°C), relativeHumidity (fraction 0..1) }` with the standard defaults (1013.25 hPa, 15 °C, 0.5) for omitted fields; a pressure of 0 gives 0. For a quick Sæmundsson estimate without wavelength or weather, see Approximate Atmospheric Refraction. For the difference between two wavelengths, see Differential Refraction and Atmospheric Dispersion.

```ts
import { refractiveDisplacement } from 'nebulosa/src/astronomy/coordinates/refraction'
import { deg, toArcsec } from 'nebulosa/src/math/units/angle'

// Apparent altitude 45°, wavelength 0.55 µm (green), standard conditions.
console.log(toArcsec(refractiveDisplacement(deg(45), 0.55)!)) // 57.11 — arcseconds

console.log(toArcsec(refractiveDisplacement(deg(10), 0.55)!)) // 312.31 — arcseconds
console.log(toArcsec(refractiveDisplacement(deg(1), 0.55)!)) // 646.93 — arcseconds, near the horizon

// Thinner, colder air refracts less.
console.log(toArcsec(refractiveDisplacement(deg(10), 0.55, { pressure: 700, temperature: -5 })!)) // 232.47 — arcseconds

console.log(refractiveDisplacement(deg(90), 0.55)) // 0 — zenith
console.log(refractiveDisplacement(0, 0.55)) // undefined — on the horizon
```

### Rise, Transit, and Set

A body rises when its altitude crosses a horizon value going up, sets when it crosses going down, and transits when it reaches its highest altitude on the meridian. The almanac convention measures the crossing against a horizon altitude that folds in refraction and the body's apparent size, instead of the geometric zero: `STANDARD_HORIZON` (−34′) is for a point source such as a star or planet, `SUN_HORIZON` (−50′) for the Sun's upper limb, and `CIVIL_TWILIGHT`, `NAUTICAL_TWILIGHT`, and `ASTRONOMICAL_TWILIGHT` (−6°, −12°, −18°) for the Sun's depression angle.

`riseTransitSet(directionAt, location, time, options?)` searches a window starting at `time` (one day by default, `options.window` in days) and returns `{ rise?, transit?, set?, transitAltitude, alwaysUp, alwaysDown }`. `directionAt` returns the J2000/ICRS geocentric direction toward the body at a time (only its direction is used), `location` is a geodetic observer, and `options.horizon` (radians, default `STANDARD_HORIZON`) is the crossing altitude. The altitude is geocentric and geometric, with precession and nutation applied but no aberration or parallax, so for the Moon raise the horizon by its horizontal parallax to match almanac values. The transit is the altitude maximum and is reported even below the horizon; `transitAltitude` is in radians. When the body never crosses the horizon, `rise` and `set` are `undefined` and exactly one of `alwaysUp` and `alwaysDown` is true. `options.step` and `options.tolerance` are the search step and tolerance in days (defaults 1/24 and 1e-6). A body that rises and sets once per window gives one of each, but a window that starts mid-day can place the set before the rise: choose the start time (for example, the local midnight) accordingly. `altitudeOf(direction, time, location)` gives the geometric altitude of a direction in radians. The search is built on Time-Domain Event Search and Time-Domain Extrema Search.

```ts
import { eraS2c } from 'nebulosa/src/astronomy/coordinates/erfa/erfa'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { altitudeOf, riseTransitSet, STANDARD_HORIZON, SUN_HORIZON } from 'nebulosa/src/astronomy/events/horizon'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { type Time, Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400)) // La Silla
const start = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.UTC)

// The Sun: geocentric ICRS direction, measured against the upper-limb horizon.
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])
const sunEvents = riseTransitSet(sunAt, site, start, { horizon: SUN_HORIZON })

console.log(timeToDate(sunEvents.rise!).slice(0, 5)) // [2025, 9, 28, 10, 24] — UTC
console.log(timeToDate(sunEvents.transit!).slice(0, 5)) // [2025, 9, 28, 16, 33]
console.log(timeToDate(sunEvents.set!).slice(0, 5)) // [2025, 9, 28, 22, 42]
console.log(toDeg(sunEvents.transitAltitude)) // 63.05 — degrees

// A fixed star (RA 5.919 h, Dec +7.407°): a constant direction.
const star = eraS2c(hour(5.919), deg(7.407))
const starEvents = riseTransitSet(() => star, site, start, { horizon: STANDARD_HORIZON })

console.log(timeToDate(starEvents.transit!).slice(0, 5), toDeg(starEvents.transitAltitude)) // [2025, 9, 28, 10, 9] 53.33

// Altitude of a direction at one instant.
console.log(toDeg(altitudeOf(star, start, site))) // -56.39 — degrees, well below the horizon at 00:00 UTC

// A circumpolar star at latitude +80°: never sets. A southern one never rises.
const arctic = geodeticLocation(0, deg(80), 0)

console.log(riseTransitSet(() => eraS2c(0, deg(85)), arctic, start).alwaysUp) // true
console.log(riseTransitSet(() => eraS2c(0, deg(-60)), arctic, start).alwaysDown) // true
```

### Sampled Angular Motion

The angular motion of a moving target on the sky, such as a comet, asteroid, or satellite, can be estimated from a few sampled positions. Two samples give a constant rate. Three or more also give an acceleration, which captures the curvature of the track and sets how a mount should track a body whose rate changes.

`angularMotionOrDifferentialTrackingRate(samples)` takes samples of `{ longitude, latitude, timeDays }`, with longitude and latitude (right ascension and declination) in radians and time in days; only differences in time matter and the samples may be unordered. It returns `undefined` for fewer than two samples or when the endpoints share a time. The rate is the secant from the earliest to the latest sample, with the longitude difference unwrapped to `(−π, π]` so a sample crossing 0 h does not invent a full-turn rate. The result gives `longitudeRatePerDay` and `latitudeRatePerDay` (coordinate rates; longitude is not multiplied by `cos(latitude)`), the great-circle `angularRatePerDay`, the same three per SI second, and the `positionAngle` of travel (north through east, `[0, 2π)`). With three or more samples it adds the longitude, latitude, and tangential accelerations in radians per day squared. The tangential acceleration is omitted when a leg is antipodal.

```ts
import { angularMotionOrDifferentialTrackingRate } from 'nebulosa/src/astronomy/coordinates/motion'
import { arcsec, deg, hour, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

// Positions at 0 h and 1 h (time in days): RA +30" and Dec -10" in the hour.
const samples = [
	{ longitude: hour(10), latitude: deg(20), timeDays: 0 },
	{ longitude: hour(10) + arcsec(30), latitude: deg(20) - arcsec(10), timeDays: 1 / 24 },
]

const motion = angularMotionOrDifferentialTrackingRate(samples)

console.log(toArcsec(motion!.longitudeRatePerSecond)) // 0.00833 — arcsec/s in RA
console.log(toArcsec(motion!.angularRatePerSecond)) // 0.00831 — arcsec/s on the sky
console.log(toDeg(motion!.positionAngle)) // 109.53 — degrees, mostly east and slightly south

// A third sample adds the acceleration of a curved track.
const curved = angularMotionOrDifferentialTrackingRate([...samples, { longitude: hour(10) + arcsec(70), latitude: deg(20) - arcsec(30), timeDays: 2 / 24 }])

console.log(curved?.angularRatePerDay) // 0.0042061 — radians/day
console.log(curved?.angularAccelerationPerDaySquared) // 0.03832 — radians/day²
console.log(curved?.longitudeAccelerationPerDaySquared) // 0.027925 — radians/day²

console.log(angularMotionOrDifferentialTrackingRate([samples[0]])) // undefined — a single sample has no rate
```

### Satellite Conjunctions

`satelliteConjunctions(a, b, start, stop, options?)` screens two satellites for close approaches. Both are propagated with SGP4 in the shared TEME frame, so their separation is the direct difference of the two position vectors and needs no frame conversion. The squared separation is sampled every `options.step` (default 30 s), its local minima are bracketed by the shared extrema search and refined with Brent's minimizer, and each one is reported as a `SatelliteConjunction`: the `time` of closest approach, the true `distance` (AU) and the `relativeSpeed` (AU/day) at that instant. Only minima at or below `options.threshold` (AU, default no limit) are returned, in chronological order.

This is a geometric screen of the SGP4 states, not a collision probability: it has no covariance and no uncertainty on the element sets. SGP4 is only valid near each TLE epoch, so `start` and `stop` should stay within a few days of the epochs of both objects. The step must be finer than the approach one wants to catch, because a deep and brief minimum between two coarse samples can be missed, which matters for close approaches at high relative speed.

The example uses a synthetic companion, the ISS elements with the ascending node shifted by +10°. The two orbital planes then cross and the separation has two minima per revolution; they are not a real close approach.

```ts
import { satelliteConjunctions } from 'nebulosa/src/astronomy/events/satellite'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift, timeToDate, utc } from 'nebulosa/src/astronomy/time/time'
import { AU_KM, DAYSEC } from 'nebulosa/src/core/constants'
import { kilometer, toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const companion = recordFromTLE(parseTLE('1 25545U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25545  51.6442  31.4611 0001363  85.7790 274.3535 15.49180547 25697', 'COMPANION'))
const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

const stop = timeShift(tle.epoch, 0.25) // six hours after the epoch

const all = satelliteConjunctions(iss, companion, tle.epoch, stop)
console.log(all.length) // 8

for (const conjunction of all.slice(0, 2)) {
	console.log(format(conjunction.time), toKilometer(conjunction.distance), (conjunction.relativeSpeed * AU_KM) / DAYSEC)
}
// 2020-11-25-13-32-11 734.70 1.3359 — time, km, km/s
// 2020-11-25-14-18-38 736.17 1.3332

// Keep only approaches closer than 735 km.
console.log(satelliteConjunctions(iss, companion, tle.epoch, stop, { threshold: kilometer(735) }).length) // 4
```

### Satellite Eclipses

A satellite in low orbit spends part of each revolution in the shadow of the Earth. The shadow model is conical, in the geocentric ICRS frame, using the apparent angular radii of the Sun and of the Earth's spherical limb as seen from the satellite: the satellite is in **umbra** when the Earth's disk fully covers the Sun's, in **penumbra** when it covers it partially, and **sunlit** otherwise. The Earth is treated as a sphere of radius `EARTH_RADIUS_AU`, and no refraction by the atmosphere is modeled.

Both functions take a `sunAt` provider that returns the geocentric Sun position (AU, ICRS) at a time, for example the VSOP87E Sun minus the Earth. `satelliteShadowState(satrec, sunAt, time)` classifies one instant and `isSatelliteSunlit` is true only for `sunlit`, so penumbra counts as not sunlit. `satelliteEclipses(satrec, sunAt, start, stop, options?)` finds the interval during which the satellite is inside the selected boundary, `options.boundary` being `'umbra'` (the default, total eclipse) or `'penumbra'` (any partial obscuration). The signed margin to the boundary is sampled every `options.step` (default 30 s) and its zero crossings give the entries and exits. When the window starts inside the shadow, the first eclipse has no `entry`, and when it ends inside, the last one has no `exit`; in both cases the `duration` (seconds) is clipped to the window. Providing a cheap `sunAt` matters, because it is called at every sample.

```ts
import { isSatelliteSunlit, satelliteEclipses, satelliteShadowState } from 'nebulosa/src/astronomy/events/satellite'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift, timeToDate, utc } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0]) // geocentric ICRS, AU
const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

console.log(satelliteShadowState(iss, sunAt, tle.epoch)) // umbra
console.log(isSatelliteSunlit(iss, sunAt, tle.epoch)) // false

// Six hours after the epoch. The window starts inside the umbra, so the first eclipse has no entry.
const stop = timeShift(tle.epoch, 0.25)
for (const eclipse of satelliteEclipses(iss, sunAt, tle.epoch, stop)) {
	console.log(eclipse.entry && format(eclipse.entry), eclipse.exit && format(eclipse.exit), eclipse.duration)
}
// undefined 2020-11-25-13-37-45 1725.2 — seconds, clipped to the window start
// 2020-11-25-14-35-12 2020-11-25-15-10-43 2130.3
// 2020-11-25-16-8-11 2020-11-25-16-43-40 2129.6
// 2020-11-25-17-41-9 2020-11-25-18-16-38 2128.9

// The penumbra boundary is crossed slightly earlier and later, since it includes the partial shadow.
const penumbra = satelliteEclipses(iss, sunAt, tle.epoch, stop, { boundary: 'penumbra' })
console.log(penumbra.map((eclipse) => eclipse.duration)) // [1733.9, 2147.6, 2147.0, 2146.3]
```

### Satellite Look Angles

`satelliteLookAngles(satrec, location, time)` gives where a satellite appears for a ground observer: azimuth, altitude and slant range. The satellite is propagated with SGP4 in the TEME frame, rotated to the Earth-fixed ITRS frame and differenced against the observer's ITRS position; the topocentric vector is then resolved onto the local south-east-zenith axes of the geodetic vertical. Azimuth is measured from north through east, in `[0, 2π)`. Altitude is geometric, in `[−π/2, π/2]`, with no refraction, and a negative value means the satellite is below the horizon. The range is the observer-to-satellite distance in AU. No light time or aberration is applied.

The `SatRec` comes from `recordFromTLE(parseTLE(line1, line2, name))` and the observer from `geodeticLocation(longitude, latitude, height)`. SGP4 is only meaningful near the epoch of the element set, so queries should stay within a few days of it.

```ts
import { satelliteLookAngles } from 'nebulosa/src/astronomy/events/satellite'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { timeShift } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const site = geodeticLocation(deg(-46.6361), deg(-23.5475), 0) // São Paulo: longitude, latitude (radians), height (AU)

// At the TLE epoch, 2020-11-25 13:09:00 UTC, the ISS is on the other side of the Earth.
const epoch = satelliteLookAngles(iss, site, tle.epoch)
console.log(toDeg(epoch.azimuth), toDeg(epoch.altitude), toKilometer(epoch.range)) // 148.014 −75.888 12806.5

// One hour later the ISS is 3.4° above the horizon of the site.
const later = satelliteLookAngles(iss, site, timeShift(tle.epoch, 1 / 24))
console.log(toDeg(later.azimuth), toDeg(later.altitude), toKilometer(later.range)) // 153.318 3.433 2033.7
```

### Satellite Ground Footprint

`satelliteGroundFootprint(satrec, time, referenceRadius?)` computes the ideal coverage cap of a satellite: the part of the Earth from which it is above the geometric horizon. It is an explicit spherical approximation. The Earth is a sphere of radius `referenceRadius` (AU, default `EARTH_RADIUS_AU`), so the subpoint latitude is **spherical** (geocentric), not the geodetic latitude of `satelliteSubpoint`, and terrain, refraction and any elevation mask are ignored. The horizon half-angle is `atan2(√(h·(r + R)), R)`, with `r` the satellite's geocentric radius, `R` the reference radius and `h = r − R` the height, computed with `atan2` so that it stays stable at low height.

The result has the `subpoint` (east-positive longitude in `(−π, π]`, geocentric latitude, and elevation, radians and AU), the `altitude` above the sphere (AU), the `referenceRadius`, the `halfAngle` of the cap (radians, measured at the Earth's center) and the `surfaceRadius`, the arc length from the subpoint to the horizon over the sphere (AU). The function throws an `Error` when `referenceRadius` is not positive and finite, and a `RangeError` when the satellite is inside the sphere, since an interior point has no tangent horizon. SGP4 is only meaningful near the TLE epoch.

```ts
import { satelliteGroundFootprint } from 'nebulosa/src/astronomy/events/satellite'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { toDeg } from 'nebulosa/src/math/units/angle'
import { kilometer, toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)

const footprint = satelliteGroundFootprint(iss, tle.epoch)
console.log(toDeg(footprint.subpoint.longitude), toDeg(footprint.subpoint.latitude)) // 119.282 0.01417
console.log(toKilometer(footprint.altitude), toKilometer(footprint.referenceRadius)) // 419.79 6378.135
console.log(toDeg(footprint.halfAngle)) // 20.24
console.log(toKilometer(footprint.surfaceRadius)) // 2253.2 — arc length on the sphere

// A smaller reference sphere, of mean radius 6371 km, gives a slightly larger cap.
const mean = satelliteGroundFootprint(iss, tle.epoch, kilometer(6371))
console.log(toDeg(mean.halfAngle), toKilometer(mean.surfaceRadius)) // 20.414 2269.9
```

### Satellite Orbit Beta Angle

The beta angle of an orbit is the elevation of the Sun above the orbital plane. It controls how long the satellite spends in sunlight: at a beta angle of 0° the Sun lies in the orbital plane and a low orbit crosses the Earth's shadow on every revolution, while a high beta angle shortens or removes the eclipses. It also drives the thermal and power conditions of the spacecraft.

`satelliteBetaAngle(satrec, sunAt, time)` takes the orbit normal from the SGP4 angular momentum `r × v`, rotates it from TEME to the geocentric ICRS axes and returns `asin(n̂·ŝ)`, in radians in `[−π/2, π/2]`. The sign is positive when the Sun lies on the `+n` side of the plane, that is, on the side of the orbital angular momentum. `sunAt` returns the geocentric Sun position (AU, ICRS) at a time and is not mutated. The beta angle is that of the osculating orbit at `time`, so it drifts slowly with the node precession, and SGP4 should be used only near the epoch of the element set.

```ts
import { satelliteBetaAngle } from 'nebulosa/src/astronomy/events/satellite'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0]) // geocentric ICRS, AU

console.log(toDeg(satelliteBetaAngle(iss, sunAt, tle.epoch))) // 14.62
console.log(toDeg(satelliteBetaAngle(iss, sunAt, timeShift(tle.epoch, 1)))) // 17.81 — one day later
```

### Satellite Passes

`satellitePasses(satrec, location, start, stop, options?)` lists the passes of a satellite over a ground site in a time window. The geometric altitude is sampled every `options.step` (default 30 s) and its crossings of the horizon are located with the shared root finder. Each rising crossing is paired with the next setting one, and the culmination is the altitude maximum between them, refined with Brent's minimizer on the negated altitude. A pass is returned only when both its rise and its set lie inside the window: a pass already in progress at `start`, or still in progress at `stop`, is skipped. Passes are chronological.

Every event (`rise`, `culmination`, `set`) is a `SatellitePassEvent`: the `time` plus the azimuth (north through east, radians), the geometric altitude (radians, no refraction) and the slant range (AU) at that instant. `options.minAltitude` (radians, default 0) replaces the ideal horizon, which models a local obstruction or a minimum-elevation constraint. `options.step` must be shorter than the shortest pass that matters, otherwise a brief grazing pass between two samples can be missed, and `options.tolerance` is the root and extremum tolerance.

```ts
import { satellitePasses } from 'nebulosa/src/astronomy/events/satellite'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift, timeToDate, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const site = geodeticLocation(deg(-46.6361), deg(-23.5475), 0) // São Paulo
const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

const start = tle.epoch
const stop = timeShift(start, 1) // one day after the epoch

// Every pass above the ideal horizon.
console.log(satellitePasses(iss, site, start, stop).length) // 6

// Passes that reach at least 10° of altitude.
for (const pass of satellitePasses(iss, site, start, stop, { minAltitude: deg(10) })) {
	console.log(format(pass.rise.time), toDeg(pass.rise.azimuth), toDeg(pass.rise.altitude))
	console.log(format(pass.culmination.time), toDeg(pass.culmination.altitude), toKilometer(pass.culmination.range))
	console.log(format(pass.set.time), toDeg(pass.set.azimuth), toDeg(pass.set.altitude))
}
// 2020-11-25-14-1-27 291.92 10.00 — rise: azimuth and altitude in degrees, at the 10° limit
// 2020-11-25-14-4-32 32.06 749.5 — culmination: altitude in degrees, range in km
// 2020-11-25-14-7-38 160.63 10.00 — set
// 2020-11-25-22-14-13 203.75 10.00
// 2020-11-25-22-17-27 38.78 651.8
// 2020-11-25-22-20-38 62.08 10.00
```

### Satellite Sub-point

`satelliteSubpoint(satrec, time, ellipsoid?)` returns the point of the Earth's surface directly beneath the satellite. SGP4 gives the position in TEME, which is rotated to the Earth-fixed ITRS frame and converted to geodetic coordinates on the chosen ellipsoid (default `Ellipsoid.IERS2010`, like the other geographic-position APIs). The returned `GeographicPosition` has east-positive `longitude` in `(−π, π]` and geodetic `latitude`, both in radians, and `elevation`, the height above the ellipsoid in AU. It is a new object on every call. Propagation is only meaningful near the epoch of the element set.

```ts
import { satelliteSubpoint } from 'nebulosa/src/astronomy/events/satellite'
import { Ellipsoid } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { timeShift } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)

const subpoint = satelliteSubpoint(iss, tle.epoch)
console.log(toDeg(subpoint.longitude), toDeg(subpoint.latitude), toKilometer(subpoint.elevation)) // 119.282 0.01425 419.79

// Another instant, 1.5 hours later, and another ellipsoid: the geodetic latitude and the height barely change.
const time = timeShift(tle.epoch, 0.0625)
console.log(toDeg(satelliteSubpoint(iss, time).latitude), toKilometer(satelliteSubpoint(iss, time).elevation)) // −8.802 421.536
const wgs84 = satelliteSubpoint(iss, time, Ellipsoid.WGS84)
console.log(toDeg(wgs84.latitude), toKilometer(wgs84.elevation)) // −8.802 421.535
```

### Satellite Tracking Rates

`satelliteTrackingState(satrec, location, time)` adds the rates that a tracking mount or a Doppler correction needs to the look angles. The SGP4 position and velocity are rotated from TEME to the geocentric inertial axes, the observer's geocentric position and diurnal velocity are subtracted, and the rates follow analytically from the observer-relative vectors `r` and `v`: `rangeRate = r·v / |r|` and `angularRate = |r × v| / |r|²`. The result extends the look angles (`azimuth` north through east in `[0, 2π)`, geometric `altitude`, `range` in AU) with:

- `rangeRate`, the derivative of the slant range in AU/day, positive when the satellite is receding. It is the input of a Doppler shift.
- `angularRate`, the speed of the line of sight in **inertial** axes, in radians/day and never negative. It is not the derivative of azimuth or altitude, which are measured in the rotating horizon frame, so it is the rate at which a fixed-star-referenced mount has to move.

No refraction or light time is applied, and SGP4 is only meaningful near the TLE epoch.

```ts
import { satellitePasses, satelliteTrackingState } from 'nebulosa/src/astronomy/events/satellite'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { timeShift } from 'nebulosa/src/astronomy/time/time'
import { AU_KM, DAYSEC } from 'nebulosa/src/core/constants'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const site = geodeticLocation(deg(-46.6361), deg(-23.5475), 0) // São Paulo

const [, pass] = satellitePasses(iss, site, tle.epoch, timeShift(tle.epoch, 1), { minAltitude: deg(10) })

// At the rise, 10° above the horizon, the ISS approaches quickly and moves slowly on the sky.
const rise = satelliteTrackingState(iss, site, pass.rise.time)
console.log(toKilometer(rise.range)) // 1519.06
console.log((rise.rangeRate * AU_KM) / DAYSEC) // −6.365 — km/s, approaching
console.log(toDeg(rise.angularRate) / DAYSEC) // 0.1390 — degrees/s

// At the culmination the range is at its minimum, so the range rate is close to zero, while the
// line of sight moves fastest.
const culmination = satelliteTrackingState(iss, site, pass.culmination.time)
console.log(toKilometer(culmination.range)) // 651.76
console.log((culmination.rangeRate * AU_KM) / DAYSEC) // −0.0244 — km/s
console.log(toDeg(culmination.angularRate) / DAYSEC) // 0.6468 — degrees/s
console.log(toDeg(culmination.azimuth), toDeg(culmination.altitude)) // 132.91 38.78
```

### Satellite Trail Prediction

`predictSatelliteTrails` answers the astrophotographer's question: will a satellite cross my frame during an exposure, where, and how long will the streak be? Given the SGP4 record, the observer, the equatorial center of the field, the rectangular `SensorField` and the exposure interval, it returns one `SatelliteTrailPrediction` for each continuous visit to the sensor: the `entry` and `exit` points (a TT `Time`, right ascension, declination and the gnomonic `sensorX`/`sensorY` on the sensor plane), the great-circle chord `length` (radians), the `positionAngle` of the chord from entry to exit (north through east, `[0, 2π)`) and, when `options.arcsecPerPixel` is given, `lengthPixels`. A satellite already inside the field at the start, or still inside at the end, is clipped to the exposure.

The prediction is geometric and topocentric: the observer is a site on the Earth, and no light time, aberration, refraction, illumination or pointing correction is applied. Directions and the field center are in the library's ICRS-oriented axes, in radians. The sensor is a gnomonic rectangle: `width` and `height` are angular sizes in `(0, π)` radians, and the sensor `+Y` axis is rotated from celestial north toward east by `positionAngle` (default 0), with `+X` 90° further toward east. The length is the chord between entry and exit, not the integrated arc, which is a good approximation for the short crossings of a single exposure.

The track is sampled adaptively in uniform TT seconds. A span is bisected until its midpoint residual against the spherical and the right-ascension/declination interpolation is below `options.maxInterpolationError` (default 0.1 arcsecond), and until it is no wider than `options.maxStep` seconds (default 1). That is a local error estimate, not a bound on the time of a grazing contact. `options.maxSamples` (default 65537) bounds the number of propagated instants, and exhausting it throws a `RangeError` instead of returning an undersampled prediction. A reversed or empty window returns `[]`. The `SatRec` is copied internally, so the caller's record is not modified.

```ts
import { predictSatelliteTrails } from 'nebulosa/src/astronomy/events/satellite.trail'
import { customEphemerisEndpoint, relativeEphemerisPath } from 'nebulosa/src/astronomy/ephemeris/path'
import { earthObserverEphemerisPath, sgp4EphemerisPath } from 'nebulosa/src/astronomy/ephemeris/path.adapter'
import { ephemerisAt, equatorialPosition } from 'nebulosa/src/astronomy/ephemeris/position'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift, timeToDate, tt, utc } from 'nebulosa/src/astronomy/time/time'
import { deg, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const site = geodeticLocation(deg(-46.6361), deg(-23.5475), 0, Ellipsoid.WGS84) // São Paulo
const epoch = tt(tle.epoch)
const at = (seconds: number) => timeShift(epoch, seconds / 86400) // seconds after the TLE epoch
const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

// Point the camera where the ISS will be 3332 s after the epoch, near its culmination.
const path = relativeEphemerisPath(sgp4EphemerisPath({ ...iss }), earthObserverEphemerisPath(site, customEphemerisEndpoint('site')))
const [rightAscension, declination] = equatorialPosition(ephemerisAt(path, at(3332)))
console.log(toDeg(rightAscension), toDeg(declination)) // 161.664 −48.236

// A 0.1° square field, rotated by 0.7 rad, observed with a 4 s exposure and an image scale of 2"/pixel.
const field = { width: deg(0.1), height: deg(0.1), positionAngle: 0.7 }
const trails = predictSatelliteTrails(iss, site, rightAscension, declination, field, at(3330), at(3334), { arcsecPerPixel: 2 })

console.log(trails.length) // 1
const [trail] = trails
console.log(format(trail.entry.time), format(trail.exit.time)) // 2020-11-25-14-4-31 2020-11-25-14-4-32 — the crossing lasts 0.23 s
console.log(toArcsec(trail.length), trail.lengthPixels) // 471.80 235.90
console.log(toDeg(trail.positionAngle)) // 179.84
console.log(trail.entry.sensorX, trail.entry.sensorY) // −0.00073938 0.00087266
console.log(trail.exit.sensorX, trail.exit.sensorY) // 0.00073905 −0.00087266

// An exposure ten seconds later no longer catches the satellite.
console.log(predictSatelliteTrails(iss, site, rightAscension, declination, field, at(3340), at(3344)).length) // 0
```

`sensorTrails(centerRightAscension, centerDeclination, field, track, options?)` is the geometry alone, for a track the caller already has: `SensorTrackSample`s of `time` (any uniform unit), `rightAscension` and `declination` (radians). The samples are sorted by time, the track is interpolated linearly in right ascension (taking the shortest way around) and declination between them, and each continuous visit to the rectangle is clipped with a Liang-Barsky test. A sample on the far hemisphere of the field center is a break in the path. The result is empty for a track that misses the sensor, for fewer than two samples, or for a non-positive field. The times of the entry and exit are in the unit of the samples.

```ts
import { sensorTrails } from 'nebulosa/src/astronomy/events/satellite.trail'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// A straight equatorial track from right ascension −1° to +1° across a 1° field centered on (0, 0).
const trails = sensorTrails(
	0,
	0,
	{ width: deg(1), height: deg(1) },
	[
		{ time: 0, rightAscension: -deg(1), declination: 0 },
		{ time: 1, rightAscension: deg(1), declination: 0 },
	],
	{ arcsecPerPixel: 2 },
)

const [trail] = trails
console.log(trail.entry.time, trail.exit.time) // 0.25 0.75 — it is on the sensor for half of the track
console.log(toDeg(trail.entry.rightAscension), toDeg(trail.exit.rightAscension)) // 359.5 0.5
console.log(toDeg(trail.length), toDeg(trail.positionAngle)) // 1 90 — due east
console.log(trail.lengthPixels) // 1800
```

### Satellite Visibility Intervals

`satelliteVisibleIntervals(satrec, location, sunAt, start, stop, options)` finds the periods in which a satellite is actually worth watching from a site. An interval is an unbroken stretch of time throughout which **all** the criteria hold: the geometric altitude is at least `minimumAltitude`, the apparent magnitude is at most `maximumMagnitude`, the Sun is at most `maximumSunAltitude` above the observer's horizon, and the satellite is outside the Earth's umbra. All four options are required, because there are no subjective brightness or twilight defaults, and `standardMagnitude` is the empirical value of the satellite (see the visual-magnitude topic). Angles are in radians.

The four margins are scanned independently every `options.step` (default 30 s), and the boundaries are refined by root finding, so each crossing must be resolved by the step. Intervals that touch the window edges are kept and clipped. The result has only the endpoints and the altitude maximum of each interval, as `SatelliteVisibilityEvent`s: the pass event (`time`, `azimuth`, `altitude`, `range`) plus the `magnitude`, the observer's `sunAltitude` and the `shadow` state. An interval can end on an umbra boundary, so its last event can report `umbra`. Refraction, extinction, flares, terrain and penumbral dimming are not modeled. `sunAt` returns the geocentric Sun position (AU, ICRS).

```ts
import { satelliteVisibleIntervals } from 'nebulosa/src/astronomy/events/satellite'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift, timeToDate, utc } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const site = geodeticLocation(deg(-46.6361), deg(-23.5475), 0) // São Paulo
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0]) // geocentric ICRS, AU
const format = (time: Time) => timeToDate(utc(time)).slice(0, 6).join('-')

// Higher than 10°, brighter than magnitude 3, with the Sun more than 6° below the horizon.
const intervals = satelliteVisibleIntervals(iss, site, sunAt, tle.epoch, timeShift(tle.epoch, 1), { standardMagnitude: -1.8, minimumAltitude: deg(10), maximumMagnitude: 3, maximumSunAltitude: deg(-6) })

console.log(intervals.length) // 1

const [interval] = intervals
console.log(format(interval.start.time), interval.start.magnitude, interval.start.shadow) // 2020-11-25-22-14-13 0.5436 sunlit
console.log(format(interval.end.time), interval.end.shadow) // 2020-11-25-22-20-5 umbra — it fades into the Earth's shadow
console.log(toDeg(interval.culmination.altitude), interval.culmination.magnitude, toDeg(interval.culmination.sunAltitude)) // 38.78 −3.057 −9.358
```

### Satellite Visual Magnitude

`satelliteMagnitude(satrec, location, sunAt, time, standardMagnitude)` estimates the apparent visual magnitude of a satellite for a ground observer with the standard-magnitude model of Molczan and McCants: `m = m_std − 15.75 + 2.5·log10(range_km² / f)`, where `f = (1 + cos φ) / 2` is the illuminated fraction of a diffuse sphere and `φ` is the Sun-satellite-observer phase angle. The standard magnitude `m_std` is an empirical constant of each object: its brightness at a range of 1000 km and half illumination (phase angle 90°); about −1.8 is the value usually quoted for the ISS. Smaller magnitudes are brighter.

The result carries the geometry it was computed from: `phaseAngle` (radians, zero at full phase and π at a thin crescent), the slant `range` (AU) and `illuminated`. A satellite inside the Earth's umbra reflects no sunlight, so the magnitude is only meaningful while `illuminated` is true. Penumbra counts as illuminated. The model has no atmospheric extinction near the horizon, no refraction, no specular flares and no dependence on the orientation of the satellite, so it is a planning estimate rather than a photometric prediction. `sunAt` returns the geocentric Sun position (AU, ICRS).

```ts
import { satelliteMagnitude, satellitePasses } from 'nebulosa/src/astronomy/events/satellite'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { parseTLE, recordFromTLE } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { type Time, timeShift } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const tle = parseTLE('1 25544U 98067A   20330.54791667  .00016717  00000-0  10270-3 0  9000', '2 25544  51.6442  21.4611 0001363  85.7790 274.3535 15.49180547 25697', 'ISS')
const iss = recordFromTLE(tle)
const site = geodeticLocation(deg(-46.6361), deg(-23.5475), 0) // São Paulo
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0]) // geocentric ICRS, AU
const standardMagnitude = -1.8

// At the TLE epoch the ISS is in the umbra: the value is not meaningful.
const dark = satelliteMagnitude(iss, site, sunAt, tle.epoch, standardMagnitude)
console.log(dark.illuminated) // false

// At the culmination of the second pass of the day the ISS is sunlit, 38.8° above the horizon.
const [, pass] = satellitePasses(iss, site, tle.epoch, timeShift(tle.epoch, 1), { minAltitude: deg(10) })
const bright = satelliteMagnitude(iss, site, sunAt, pass.culmination.time, standardMagnitude)
console.log(bright.magnitude) // −3.057
console.log(toDeg(bright.phaseAngle)) // 69.20
console.log(toKilometer(bright.range)) // 651.76
console.log(bright.illuminated) // true
```

### Saturnian Satellite Theory (TASS1.7)

TASS 1.7 (Vienne and Duriez) is the IMCCE analytical theory of the eight major Saturnian satellites, including Hyperion. The shared satellite mean longitudes are evaluated first; each body's equinoctial element series is then summed using integer combinations of those longitudes, converted to rectangular coordinates, and rotated into the J2000 equatorial frame.

`mimas`, `enceladus`, `tethys`, `dione`, `rhea`, `titan`, `iapetus`, and `hyperion` take a `Time` (any scale; converted to TT) and return the Saturnicentric position in AU and velocity in AU/day, in J2000 equatorial axes. `tass17(time, index)` is the shared function, with `index` 0 for Mimas through 7 for Hyperion. The returned vectors alias internal buffers, so copy them before computing another state. Add the result to Saturn's barycentric state for an inertial position.

```ts
import { enceladus, hyperion, iapetus, mimas, tass17, titan } from 'nebulosa/src/astronomy/ephemeris/models/analytical/tass17'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

const [position, velocity] = titan(time)

console.log(position) // [0.0078347, 0.0010775, -0.00076689] — AU, Saturnicentric
console.log(velocity) // [-0.00043573, 0.0032733, -0.00018113] — AU/day
console.log(toKilometer(Math.hypot(...position))) // 1188636 — km, close to Titan's orbital radius

console.log(toKilometer(Math.hypot(...mimas(time)[0]))) // 184379 — km
console.log(toKilometer(Math.hypot(...enceladus(time)[0]))) // 237189 — km
console.log(toKilometer(Math.hypot(...iapetus(time)[0]))) // 3475592 — km
console.log(toKilometer(Math.hypot(...hyperion(time)[0]))) // 1556482 — km

// tass17(time, index): index 5 is Titan. The other wrappers are tethys, dione and rhea.
console.log(tass17(time, 5)[0]) // [0.0078347, 0.0010775, -0.00076689] — AU
```

### SGP4/SDP4 Propagation

SGP4 and SDP4 are the standard analytical models for Earth satellites. They propagate mean orbital elements from a two-line element set (TLE) or an Orbit Mean-Elements Message (OMM), including secular gravity terms (J2, J3, J4), atmospheric drag through the `B*` coefficient, and, for deep-space orbits with periods of 225 minutes or more, lunar-solar perturbations and resonance. SGP4 is used for near-Earth objects and SDP4 for deep space, and the library selects between them automatically. The elements are mean elements fitted to observations: they must be propagated with this model, not treated as osculating elements, and accuracy degrades with distance from the epoch, typically over days.

`sgp4(time, source, meanElements?)` returns `[position (AU), velocity (AU/day)]` in the TEME frame for any `Time`, which is a fresh pair. `source` is a parsed `TLE`, an `OMM`, or a prepared `SatRec`. With a `TLE` or `OMM` the record is built on every call with the WGS-72 constants, so for repeated propagation build a `SatRec` once (see TLE, OMM, and SGP4 Record Construction) and pass that. The elapsed time since the epoch is measured in UTC. If you pass a `meanElements` object, it is filled with the singly averaged elements at that time (`am` in Earth radii, `em`, `im`, `Om`, `om`, `mm` in radians, `nm` in radians per minute). The call throws an `Error` explaining the failure when the model cannot propagate, such as a decayed orbit or an out-of-range eccentricity; `satelliteRecordErrorMessage(error)` gives the text for a `SatRecError` code, and `record.error` holds the last one. TEME is not a fixed Earth frame: convert it with `temeToItrf` (see TEME and ITRF Conversion), or wrap it as a path (see Ephemeris Path Adapters). Velocities and positions are TEME and use the quasi-inertial convention of SGP4.

```ts
import { parseTLE, recordFromTLE, SatRecError, satelliteRecordErrorMessage, sgp4, SGP4_WGS84, type MeanElements } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { timeShift } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'
import { toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

const tle = parseTLE('1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996', '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611', 'ISS (ZARYA)')

// At the TLE epoch: TEME position in AU and velocity in AU/day.
const [position, velocity] = sgp4(tle.epoch, tle)

console.log(position.map(toKilometer)) // [-3737.79, 2970.46, 4831.15] — km, TEME
console.log(velocity.map(toKilometerPerSecond)) // [-6.2140, -3.7036, -2.5222] — km/s

// One day after the epoch.
console.log(sgp4(timeShift(tle.epoch, 1), tle)[0].map(toKilometer)) // [3643.22, -3199.15, -4765.94] — km

// A prepared record avoids rebuilding it; it also exposes the SGP4 mode and the gravity model.
const record = recordFromTLE(tle)

console.log(record.method, record.gravity.name, record.error) // n wgs72 0 — near-Earth SGP4, WGS-72 constants, no error

// Singly averaged mean elements at that instant, filled into the optional third argument.
const mean = {} as MeanElements

sgp4(tle.epoch, record, mean)

console.log(mean.am, mean.em, mean.nm) // 1.0657 0.0003559 0.067601 — Earth radii, dimensionless, radians/minute

// WGS-84 constants bind to a record; the default for operational TLEs is WGS-72.
console.log(sgp4(timeShift(tle.epoch, 1), recordFromTLE(tle, SGP4_WGS84))[0].map(toKilometer)) // [3643.26, -3199.12, -4765.91] — km

console.log(satelliteRecordErrorMessage(SatRecError.Decayed)) // the orbit has decayed below the Earth surface model
```

### Sidereal Time and Earth Rotation Angle

Sidereal time is the hour angle of the equinox: it measures how far the Earth has turned relative to the stars, and it equals the right ascension currently on the local meridian. The Earth rotation angle (ERA) measures the same rotation relative to the Celestial Intermediate Origin instead of the equinox. Greenwich mean sidereal time (GMST) uses the mean equinox; apparent sidereal time (GAST) uses the true equinox, so GAST − GMST is the equation of the equinoxes, an arcsecond-scale nutation term.

`greenwichMeanSiderealTime`, `greenwichApparentSiderealTime`, and `earthRotationAngle` take a `Time` and return radians; `equationOfEquinoxes` returns GAST − GMST in radians, wrapped to `[−π, π]` so it stays signed. All depend on UT1, so they use the loaded Earth orientation data; without it UT1 equals UTC and the angle is off by up to about 0.9 s of rotation (see Earth Orientation Parameters). The IAU 2006/2000A ERFA models are the defaults and can be replaced per instant with `time.providers`. For local sidereal time at a site, see Geographic Observer.

```ts
import { earthRotationAngle, equationOfEquinoxes, greenwichApparentSiderealTime, greenwichMeanSiderealTime, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toArcsec, toDeg, toHour } from 'nebulosa/src/math/units/angle'

// A UT1 instant, so the example does not depend on loaded Earth orientation data.
const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UT1)

console.log(toHour(greenwichMeanSiderealTime(time))) // 18.4728 — hours
console.log(toHour(greenwichApparentSiderealTime(time))) // 18.4729 — hours
console.log(toArcsec(equationOfEquinoxes(time))) // 7.381 — arcseconds, GAST - GMST
console.log(toDeg(earthRotationAngle(time))) // 276.752 — degrees
```

### Sky Projections

A map projection flattens the celestial or terrestrial sphere onto a plane, trading shape, area, or distance fidelity. This module provides forward and inverse projections between spherical coordinates (longitude and latitude, or right ascension and declination, in radians) and planar x/y, with shared options for the plane transform. Azimuthal projections are tangent at a chosen center and suit fields of view and all-sky charts; cylindrical ones map the whole sphere and suit sky maps and world maps.

Every projection implements `project(longitude, latitude, out?, options?)`, which returns a `Point` `{ x, y }` or `undefined` when the point is outside the projection's domain (for example the far side of a gnomonic or orthographic view, or a pole in Mercator), and `unproject(x, y, out?, options?)`, which returns `{ x: longitude, y: latitude }` or `undefined`. The optional `out` point is filled and returned. Azimuthal projections are constructed with `(centerLongitude, centerLatitude, options?)`: `Gnomonic` (great circles are straight lines, less than a hemisphere), `Stereographic` (conformal), `Orthographic` (a globe seen from infinity, one hemisphere), `LambertAzimuthalEqualArea` (area-preserving), and `AzimuthalEquidistant` (true distances from the center). Cylindrical projections take `options` (some also a standard parallel): `Mercator`, `WebMercator` (clamped to ±85.05° so the map is square), `EllipsoidalMercator`, `Miller`, `CentralCylindrical`, `CylindricalEqualArea(standardParallel, latitudeOfOrigin, options)` with the `LambertCylindricalEqualArea`, `Behrmann`, `GallPeters`, `HoboDyer`, `Balthasart`, and `TrystanEdwards` presets, `CylindricalStereographic(standardParallel, options)` with the `Gall` and `Braun` presets, and `CylindricalEquidistant(standardParallel, latitudeOfOrigin, options)` with `PlateCarree(latitudeOfOrigin, options)`.

The shared `ProjectionOptions` set the planar transform and conventions: `centralMeridian` (radians), `scale` and `radius` (planar units per radian, multiplied), `falseEasting` and `falseNorthing`, `raAxisDirection` (`'east'`, the default, or `'west'` for a sky chart with right ascension increasing to the left), `yAxisDirection` (`'northUp'`, the default, or `'southUp'`), `longitudeWrapMode` (`'pi'` for `(−π, π]`, `'tau'` for `[0, 2π)`, or `'none'`), `clampLatitude` and `maxLatitude` (radians), and for the ellipsoidal Mercator `eccentricity` or `flattening`. Options on the constructor are defaults, and options passed to a call override them. By default the plane is in units of the sphere radius, that is, radians for small angles; set `scale` to get arcseconds, pixels, or meters. A malformed option such as an invalid standard parallel or flattening throws a `TypeError`. To project paths and polygons that cross the antimeridian, see Projected Paths and Polygons.

```ts
import { AzimuthalEquidistant, Gnomonic, LambertCylindricalEqualArea, Mercator, Orthographic, PlateCarree, Stereographic, WebMercator, WEB_MERCATOR_MAX_LATITUDE } from 'nebulosa/src/astronomy/projections/projection'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'

// A tangent projection centered on RA 10 h, Dec +20°, projecting a point 2° east in RA and 3° north in Dec.
const center = [hour(10), deg(20)] as const
const gnomonic = new Gnomonic(center[0], center[1])
const point = gnomonic.project(hour(10) + deg(2), deg(23))!

console.log(point) // { x: 0.032186, y: 0.052628 } — tangent-plane units (radians for small offsets)

const back = gnomonic.unproject(point.x, point.y)!

console.log(toDeg(back.x), toDeg(back.y)) // 152 23 — degrees of RA and Dec, the inverse

// The other azimuthal projections of the same point differ at the 1e-5 level here.
console.log(new Stereographic(center[0], center[1]).project(hour(10) + deg(2), deg(23))) // { x: 0.032156, y: 0.052578 }
console.log(new Orthographic(center[0], center[1]).project(hour(10) + deg(2), deg(23))) // { x: 0.032125, y: 0.052528 }
console.log(new AzimuthalEquidistant(center[0], center[1]).project(hour(10) + deg(2), deg(23))) // { x: 0.032145, y: 0.052561 }

// A point on the far side is outside the gnomonic and orthographic domain.
console.log(gnomonic.project(hour(22), deg(-20))) // undefined

// A scale turns plane units into arcseconds, with RA increasing to the left as on a sky chart.
const chart = new Gnomonic(center[0], center[1], { scale: 206264.806, raAxisDirection: 'west' })

console.log(chart.project(hour(10) + deg(2), deg(23))) // { x: -6638.9, y: 10855.2 } — arcseconds

// Cylindrical: Mercator of 30° E, 45° N, and the equal-area and plate carree variants.
console.log(new Mercator().project(deg(30), deg(45))) // { x: 0.5236, y: 0.8814 }
console.log(new LambertCylindricalEqualArea().project(deg(30), deg(45))) // { x: 0.5236, y: 0.7071 }
console.log(new PlateCarree().project(deg(30), deg(45))) // { x: 0.5236, y: 0.7854 } — x = longitude, y = latitude

// The poles diverge in Mercator: undefined, or clamped by WebMercator at the square-map limit.
console.log(new Mercator().project(0, deg(90))) // undefined
console.log(toDeg(WEB_MERCATOR_MAX_LATITUDE)) // 85.05 — degrees
console.log(new WebMercator().project(0, deg(90))) // { x: 0, y: 3.1416 }
```

### Sky-Plane Uncertainty Ellipses

An orbit's position uncertainty is a 3D ellipsoid, but an observer sees only its projection on the plane of the sky. That projection is an error ellipse around the predicted position, which tells you how large a field must be to catch the object. The linear position spread is divided by the distance to give angles, and the ellipse axes are the eigenvalues of the 2×2 covariance along East (increasing right ascension) and North (increasing declination).

`ephemerisUncertaintyEllipse(covariance, geocentric, options?)` takes a covariance whose top-left 3×3 block is the position covariance (a full 6×6 state covariance from Orbit Covariance Propagation is fine) and the observer-to-object vector `geocentric` in AU, in the same frame, usually ICRF equatorial. The vector's direction sets the tangent plane and its length converts the spread to angles; it must be non-zero or an `Error` is thrown. The observer's own position is treated as errorless. It returns `semiMajor` and `semiMinor` in radians on the sky and `positionAngle` of the major axis (radians, north through east, in `[0, π)`). `options.sigma` scales the axes (default 1 for the 1-σ ellipse, 3 for 3-σ). Near a celestial pole the position angle is arbitrary but the shape is still correct.

```ts
import { ephemerisUncertaintyEllipse } from 'nebulosa/src/astronomy/orbits/covariance'
import { Matrix } from 'nebulosa/src/math/linear-algebra/matrix'
import { toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

// A position covariance in AU^2: sigma x = 1e-4, y = 5e-5, z = 2e-5 AU, with a 0.5 x-y correlation.
const covariance = new Matrix(3, 3)

covariance.set(0, 0, 1e-4 ** 2)
covariance.set(1, 1, 5e-5 ** 2)
covariance.set(2, 2, 2e-5 ** 2)
covariance.set(0, 1, 0.5 * 1e-4 * 5e-5)
covariance.set(1, 0, 0.5 * 1e-4 * 5e-5)

// Observer-to-object vector in the same frame (AU, ICRF equatorial), 2.62 AU long.
const geocentric = [2.1, -1.2, -1.0] as const

const ellipse = ephemerisUncertaintyEllipse(covariance, geocentric)

console.log(toArcsec(ellipse.semiMajor)) // 6.60 — arcseconds, 1-sigma along the major axis
console.log(toArcsec(ellipse.semiMinor)) // 2.10 — arcseconds, 1-sigma across it
console.log(toDeg(ellipse.positionAngle)) // 73.5 — degrees, major axis from north through east

// The 3-sigma ellipse.
console.log(toArcsec(ephemerisUncertaintyEllipse(covariance, geocentric, { sigma: 3 }).semiMajor)) // 19.8 — arcseconds

ephemerisUncertaintyEllipse(covariance, [0, 0, 0]) // Error: geocentric direction must be a non-zero vector to define a sky-plane ellipse
```

### Solar Eclipse Besselian Elements

The Besselian elements describe a solar eclipse in the fundamental plane, the plane through the Earth's center perpendicular to the Moon's shadow axis. `x` and `y` are the coordinates of the shadow axis in that plane, `d` and `mu` are the declination of the axis and the Greenwich hour angle of its direction (radians), `l1` and `l2` are the radii of the penumbral and umbral cones in the fundamental plane (`l2` is negative for a total eclipse, positive for an annular one), and `tanF1` and `tanF2` are the tangents of the half-angles of those cones. `x`, `y`, `l1` and `l2` are in equatorial Earth radii. Every other solar eclipse routine of the library (the ground track, the local circumstances) is built on them.

`computePolynomialBesselianElements(maximumTime, sunMoonPosition)` samples the Sun and Moon at five instants spaced by `1/24` day around the `time0` of the eclipse (the maximum rounded to the nearest hour) and fits a cubic in `t`, the time in hours since `time0`, for each of `x`, `y`, `l1`, `l2`, `d` and `mu`. The result is a `PolynomialBesselianElements` with `time0`, `maximumTime`, `deltaT` (TT − UT1, seconds), `deltaTLongitudeCorrection` (radians, 0 here), `step` (days), the four-coefficient arrays (in increasing powers of `t`) and the constants `tanF1` and `tanF2`. `evaluateBesselian(pbe, time)` evaluates the polynomials at a `Time` and returns the instantaneous `InstantBesselianElements`, adding the time derivatives `dx` and `dy` (Earth radii per hour). `besselianSampleAtJulianDay(pbe, jd)` does the same for a TT Julian Day and also returns the `jd`, and `instantBesselianFromSunMoon(time, sunMoonPosition)` computes the elements directly from the Sun and Moon positions at one instant, without the polynomial, which is useful to check the fit.

The polynomials are extrapolated outside the fitted window, so results more than a few hours from `time0` are unreliable. `SUN_RADIUS_EARTH_RADII`, `MOON_RADIUS_PENUMBRA_EARTH_RADII` and `MOON_RADIUS_UMBRA_EARTH_RADII` are the solar radius and the two lunar radii (NASA/Espenak convention; the first is the solar radius and the others the Espenak `k1` and `k2` constants) in equatorial Earth radii.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { besselianSampleAtJulianDay, computePolynomialBesselianElements, evaluateBesselian, instantBesselianFromSunMoon, MOON_RADIUS_PENUMBRA_EARTH_RADII, MOON_RADIUS_UMBRA_EARTH_RADII, SUN_RADIUS_EARTH_RADII } from 'nebulosa/src/astronomy/events/eclipse/solar/map'
import { Timescale, timeShift, timeYMDHMS, toJulianDay } from 'nebulosa/src/astronomy/time/time'
import { toDeg } from 'nebulosa/src/math/units/angle'

// The total solar eclipse of 8 April 2024.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)
const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)

console.log(pbe.time0.fraction, pbe.step, pbe.deltaT, pbe.deltaTLongitudeCorrection) // 0.25 0.041666666666666664 74.0306 0
console.log(pbe.tanF1, pbe.tanF2) // 0.0046663658 0.0046431178
console.log(pbe.x) // [-0.3188609437, 0.5117079966, 3.2949e-5, -8.4194e-6]
console.log(pbe.l2) // [-0.01037827013, 6.1747e-5, -1.2692e-5, 2.0632e-9]

// The elements at the instant of greatest eclipse.
const maximum = evaluateBesselian(pbe, eclipse.maximalTime)
console.log(maximum.x, maximum.y) // -0.157500055 0.305084134
console.log(maximum.l1, maximum.l2) // 0.53572629 -0.01036006
console.log(toDeg(maximum.d), toDeg(maximum.mu)) // 7.59086 94.01317
console.log(maximum.dx, maximum.dy) // 0.51172626 0.2709267
console.log(Math.hypot(maximum.x, maximum.y)) // 0.34334 — the axis passes inside the Earth's limb

// The same through a Julian Day, and straight from the Sun and Moon positions.
const sample = besselianSampleAtJulianDay(pbe, toJulianDay(eclipse.maximalTime))
console.log(sample.x, sample.y) // -0.157500055 0.305084134
const exact = instantBesselianFromSunMoon(timeShift(eclipse.maximalTime, 0), sunMoonPosition(eclipse.maximalTime))
console.log(exact.x, exact.y, exact.l2) // -0.1575000315 0.3050841577 -0.01036006

console.log(SUN_RADIUS_EARTH_RADII, MOON_RADIUS_PENUMBRA_EARTH_RADII, MOON_RADIUS_UMBRA_EARTH_RADII) // 109.076370706 0.272488 0.272281
```

### Solar Eclipse Ground-Track Geometry

The ground track of a solar eclipse is made of curves on the Earth's surface that follow from the Besselian elements of Solar Eclipse Besselian Elements: the central line of totality or annularity, its northern and southern limits, the northern and southern limits of the partial eclipse, the sunrise and sunset curves, and the named contact points. `computeSolarEclipseMapGeometry(eclipse, pbe, options?)` computes all of them in geographic coordinates (an `EclipseGeoPoint`, with `x` the east-positive longitude and `y` the latitude, in radians, plus the TT Julian Day `jd` of the instant when the shadow is there), and they are projected to a map by Solar Eclipse Map SVG Paths.

The result has `points`, a `SolarEclipseContactPoints` with the contacts `P1`–`P4` (penumbra against the limb), `U1`–`U4` (umbra against the limb), `C1` and `C2` (the ends of the central line), `MAX` (greatest eclipse) and `N1`, `N2`, `S1`, `S2` (the ends of the northern and southern limits of the partial eclipse), each one present only when it exists, and `lines`: `centerLine` (a single branch, empty for a partial or non-central eclipse), `umbraNorth` and `umbraSouth`, `penumbraNorth` and `penumbraSouth` (lists of branches, so that a fold that the solver could not follow is never joined by a straight line) and `riseSetCurves`. Points of the central line are tagged with their `kind`, `'total'` or `'annular'`, and `splitCentralLineByKind(centerLine, pbe?)` splits the line into the `total` and `annular` runs, which is what a hybrid eclipse needs; with `pbe` the exact instant where the umbral radius is zero is solved and shared as the seam of the two runs.

`options.longitudeStep` and `options.maxAngularStep` (radians, default 1° each) are the longitude scan step and the maximum spacing of the points along a curve, `options.includeRiseSetCurves` (default `false`) adds the sunrise and sunset curves, which are the slowest part, and `options.riseSetStep` (seconds, default 30) is their time step. `options.refractionMode` is `'empirical'` (default), which lifts the observer near the horizon with an empirical refraction factor so that the extremes of the partial limits match the published refracted references, or `'none'` for the purely geometric solution. The two modes must not be mixed in one map. The cost grows quickly as the steps shrink: the default steps are the accurate setting, and coarse ones are only for previews.

The lower-level routines are exported too. `findMaximumPoint(pbe)` is the greatest eclipse point, `findPenumbraContactPoints(pbe)` and `findUmbraContactPoints(pbe)` return the `P` and `U` contacts, and `findCentralLineExtremePoint(pbe, begin)` the `C1` (`begin` true) or `C2` point. `centralAxisIntersectsEarth(pbe)` tells whether the shadow axis pierces the ellipsoid, which is when `centerLine`, `C1` and `C2` exist. `centralLineKind(pbe, jd)` is the local character of the central line at an instant. `findEclipseCurvePoint(pbe, longitude, initialLatitude, i, G, refractionMode?)` solves a point at a longitude (`i` is `0` for the central line and `+1` or `−1` for the northern or southern limit, `G` is `1` for the totality limit and `0` for the partial limit), and `findCurvePoints(pbe, i, G, options?)` traces a whole family. `computeRiseSetCurves(pbe, P1, P4, optionalContacts?, options?)` builds the sunrise and sunset curves from the contacts, `projectFundamentalPoint(sample, x, y)` converts a point of the fundamental plane to the geographic coordinates of the surface point under it (`undefined` outside the Earth's limb), `projectClosestEarthLimbPoint(sample, x, y)` gives the nearest point of the limb instead, and `solarAltitudeAtPoint(pbe, point)` is the geometric altitude of the Sun in radians at a point and its instant.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import {
	besselianSampleAtJulianDay,
	centralAxisIntersectsEarth,
	centralLineKind,
	computePolynomialBesselianElements,
	computeSolarEclipseMapGeometry,
	findCentralLineExtremePoint,
	findCurvePoints,
	findMaximumPoint,
	findPenumbraContactPoints,
	findUmbraContactPoints,
	projectClosestEarthLimbPoint,
	projectFundamentalPoint,
	solarAltitudeAtPoint,
	splitCentralLineByKind,
} from 'nebulosa/src/astronomy/events/eclipse/solar/map'
import { Timescale, timeYMDHMS, toJulianDay } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// The total solar eclipse of 8 April 2024.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)
const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)

// A preview-quality map: 5° longitude scan and 2° spacing of the points.
const geometry = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(5), maxAngularStep: deg(2) })
console.log(Object.keys(geometry.points).join(' ')) // P1 P2 P3 P4 MAX U1 U2 U3 U4 C1 C2 N1 N2 S1 S2

const { lines } = geometry
console.log(
	lines.centerLine.length,
	lines.umbraNorth.map((branch) => branch.length),
	lines.umbraSouth.map((branch) => branch.length),
) // 89 [ 89 ] [ 87 ]
console.log(
	lines.penumbraNorth.map((branch) => branch.length),
	lines.penumbraSouth.map((branch) => branch.length),
	lines.riseSetCurves.length,
) // [ 242 ] [ 99 ] 0

// The central line, from C1 to C2; its first point is at (−158.5°, −7.8°), where the axis first touches the Earth.
const [first] = lines.centerLine
console.log(toDeg(first.x), toDeg(first.y), first.kind) // -158.53 -7.81 total

// The greatest eclipse point and the contact points, with their longitude and latitude in degrees.
const max = geometry.points.MAX!
console.log(toDeg(max.x), toDeg(max.y)) // -104.05 25.40
console.log(toDeg(geometry.points.P1!.x), toDeg(geometry.points.P1!.y)) // -143.12 -14.92
console.log(toDeg(geometry.points.U2!.x), toDeg(geometry.points.U2!.y)) // -158.74 -7.17
console.log(toDeg(geometry.points.C2!.x), toDeg(geometry.points.C2!.y)) // -19.78 47.63

// The sunrise and sunset curves are optional and slower; a 10 minute step is enough for a preview.
const withRiseSet = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(5), maxAngularStep: deg(2), includeRiseSetCurves: true, riseSetStep: 600 })
console.log(withRiseSet.lines.riseSetCurves.map((branch) => branch.length)) // [ 113, 139, 98, 138 ]

// The purely geometric solution, without the empirical refraction lift of the partial limits.
const geometric = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(5), maxAngularStep: deg(2), refractionMode: 'none' })
console.log(toDeg(geometric.points.N1!.x), toDeg(geometric.points.N1!.y)) // -177.04 33.54

// The central line of a total eclipse has one run of one kind, and a hybrid one would have both.
const kinds = splitCentralLineByKind(lines.centerLine, pbe)
console.log(kinds.total.length, kinds.annular.length) // 1 0 — runs of each kind

// The lower-level routines.
console.log(centralAxisIntersectsEarth(pbe), centralLineKind(pbe, toJulianDay(eclipse.maximalTime))) // true total
console.log(findMaximumPoint(pbe)!.jd, findCentralLineExtremePoint(pbe, true)!.jd) // 2460409.2631 2460409.1953
console.log(Object.keys(findPenumbraContactPoints(pbe)).join(' '), Object.keys(findUmbraContactPoints(pbe)).join(' ')) // P1 P2 P3 P4 U1 U2 U3 U4

const northLimit = findCurvePoints(pbe, 1, 1, { longitudeStep: deg(5), maxAngularStep: deg(2) })
console.log(northLimit.length) // 90

// The fundamental plane point of the axis at greatest eclipse is on the Earth; a point outside the limb is not.
const sample = besselianSampleAtJulianDay(pbe, toJulianDay(eclipse.maximalTime))
const under = projectFundamentalPoint(sample, sample.x, sample.y)!
console.log(toDeg(under.x), toDeg(under.y)) // -104.05 25.40
console.log(projectFundamentalPoint(sample, 2, 0)) // undefined
console.log(projectClosestEarthLimbPoint(sample, 2, 0)) // the { x: -0.07004, y: 0, jd: 2460409.2631 } — the nearest limb point, in radians
console.log(toDeg(solarAltitudeAtPoint(pbe, under))) // 69.78
```

### Solar Eclipse Map SVG Paths

`solarEclipseMapToSvgPaths(geometry, projection, options?)` turns the geometry of Solar Eclipse Ground-Track Geometry into SVG path data, one string per curve, plus the projected position of each named point. `projection` is any `CylindricalProjection` (for example `PlateCarree`), and the geometry is never modified. The curves are projected, and split at the antimeridian, only here: a curve that crosses it becomes several subpaths (`M…` commands) and no connector is ever drawn across the map. Each branch of a penumbral limit is its own subpath, so the arcs of a fold that the solver could not follow are drawn as separate arcs.

The result has the strings `centerLine`, `umbraNorth`, `umbraSouth`, `penumbraNorth`, `penumbraSouth` and `riseSetCurves` (an empty string for a curve that the eclipse does not have, such as the rise and set curves when they were not computed), and `points`, the projected `P1`–`P4`, `U1`–`U4`, `C1`, `C2`, `MAX`, `N1`, `N2`, `S1` and `S2` that exist and fall inside the projection. The coordinates are those of the projection: with `PlateCarree`, `x` is the longitude and `y` the latitude, in radians multiplied by the projection `scale`, with north up. SVG `y` grows downward, so pass `yAxisDirection: 'southUp'` to the projection to get SVG axes, and `centralMeridian` in `options.projectionOptions` to center the map on another longitude. `options.precision` is the number of decimals of the path coordinates (default 2); the projected `points` are not rounded.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { sunMoonPosition } from 'nebulosa/src/astronomy/events/eclipse/eclipse'
import { computePolynomialBesselianElements, computeSolarEclipseMapGeometry, solarEclipseMapToSvgPaths } from 'nebulosa/src/astronomy/events/eclipse/solar/map'
import { PlateCarree } from 'nebulosa/src/astronomy/projections/projection'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg } from 'nebulosa/src/math/units/angle'

// The total solar eclipse of 8 April 2024, as a preview-quality geometry.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)
const pbe = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition)
const geometry = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(5), maxAngularStep: deg(2) })

// A map 100 pixels per radian wide, SVG axes (y down).
const paths = solarEclipseMapToSvgPaths(geometry, new PlateCarree(0, { scale: 100, yAxisDirection: 'southUp' }))
console.log(paths.points.MAX) // { x: -181.5986, y: -44.3387 } — greatest eclipse, not rounded by the precision
console.log(paths.points.C1) // { x: -276.6948, y: 13.6315 }
console.log(paths.centerLine.slice(0, 60)) // M-276.69 13.63L-273.61 13.2L-270.53 12.7L-268.34 12.31L-266.
console.log(paths.umbraNorth.slice(0, 20), (paths.penumbraNorth.match(/M/g) ?? []).length) // M-277.05 12.52L-270.

// The partial limit crosses the antimeridian, so it is two subpaths; the rise and set curves are empty here.
console.log(paths.penumbraNorth.slice(0, 50)) // M125.75 -145.88L130.9 -151.49L132.48 -151.99L134.39 -152.47L
console.log(paths.riseSetCurves === '') // true

// With the rise and set curves computed, they become four subpaths.
const withRiseSet = computeSolarEclipseMapGeometry(eclipse, pbe, { longitudeStep: deg(5), maxAngularStep: deg(2), includeRiseSetCurves: true, riseSetStep: 600 })
const curves = solarEclipseMapToSvgPaths(withRiseSet, new PlateCarree(0, { scale: 100, yAxisDirection: 'southUp' }))
console.log((curves.riseSetCurves.match(/M/g) ?? []).length) // 4

// A map centered on 100°W with integer coordinates and north up: the maximum is at x = -7.
const centered = solarEclipseMapToSvgPaths(geometry, new PlateCarree(0, { scale: 100 }), { precision: 0, projectionOptions: { centralMeridian: deg(-100) } })
console.log(centered.points.MAX) // { x: -7.0657, y: 44.3387 } — the points keep full precision
console.log(centered.centerLine.slice(0, 30)) // M-102 -14L-99 -13L-96 -13L-94 -12L-92 -12L
```

### Solar Eclipse Search and Classification

A solar eclipse happens at new moon when the Moon's shadow reaches the Earth. It is total when the Moon's umbra reaches the surface (the Moon looks larger than the Sun), annular when only the antumbra does (the Moon looks smaller, leaving a ring), hybrid when the eclipse is annular in part of its track and total in another, and partial when only the penumbra touches the Earth. This topic gives the global classification of each eclipse; for the ground path and the view from a site, see Solar Eclipse Besselian Elements and the local solar eclipse topics.

`nearestSolarEclipse(time, next)` finds the previous or next solar eclipse with Meeus's chapter 54 series. `next` selects the first eclipse strictly after `time` when true, and the last at or before it when false. It returns a `SolarEclipse` with the Meeus `lunation` index, `maximalTime` (the instant of greatest eclipse, a TT `Time`), `type` (`'total'`, `'annular'`, `'hybrid'`, or `'partial'`), `magnitude` (at greatest eclipse: the Moon-to-Sun apparent-diameter ratio for a central eclipse, and the fraction of the Sun's diameter covered otherwise), `gamma` (the least distance of the shadow axis from the Earth's center, in equatorial Earth radii, signed by the side), the umbral radius `u` and the penumbral radius `p` in the fundamental plane in Earth radii, and `central`, which is false for the rare eclipse whose axis misses the Earth's center but touches its limb, and for partial ones. A negative `u` is a total eclipse and a positive one an annular or hybrid one. It does not give Besselian elements, a track, or local contacts, and the series is accurate to about a minute in time. Convert the TT time with `utc` for civil time.

```ts
import { nearestSolarEclipse } from 'nebulosa/src/astronomy/bodies/sun'
import { Timescale, timeToDate, timeYMDHMS, utc } from 'nebulosa/src/astronomy/time/time'

// The first solar eclipse after 1 April 2024: the total eclipse of 8 April.
const eclipse = nearestSolarEclipse(timeYMDHMS(2024, 4, 1, 0, 0, 0, Timescale.UTC), true)

console.log(eclipse.type, eclipse.central) // total true
console.log(timeToDate(utc(eclipse.maximalTime)).slice(0, 6)) // [2024, 4, 8, 18, 17, 46] — UTC
console.log(eclipse.magnitude) // 1.0553 — the Moon is 5.5% larger than the Sun
console.log(eclipse.gamma) // 0.3437 — Earth radii, the axis passes north of the center
console.log(eclipse.u, eclipse.p) // -0.0102 0.5359 — negative u: the umbra reaches the surface

// The annular, hybrid, and partial cases.
for (const [year, month, day] of [
	[2023, 9, 1],
	[2023, 4, 1],
	[2025, 3, 1],
] as const) {
	const next = nearestSolarEclipse(timeYMDHMS(year, month, day, 0, 0, 0, Timescale.UTC), true)

	console.log(next.type, timeToDate(utc(next.maximalTime)).slice(0, 5), next.magnitude)
}
// annular [2023, 10, 14, 17, 59] 0.9519
// hybrid [2023, 4, 20, 4, 16] 1.0128
// partial [2025, 3, 29, 10, 48] 0.9348

// The previous eclipse, counted from the afternoon of 8 April 2024: the same event.
console.log(nearestSolarEclipse(timeYMDHMS(2024, 4, 8, 19, 0, 0, Timescale.UTC), false).type) // total
```

### Solar Parallax and Semidiameter

The Sun's horizontal parallax is the angle the Earth's equatorial radius subtends at the Sun, and its semidiameter is the angular radius of the solar disk. Both scale inversely with the Earth-Sun distance, so they grow when the Earth is closer to the Sun.

`sunParallax` and `sunSemidiameter` take the distance in AU and return radians, using 8.794143″ and 959.63″ at 1 AU. They are Sun-specific; for the Moon see Lunar Parallax and Semidiameter.

```ts
import { sunParallax, sunSemidiameter } from 'nebulosa/src/astronomy/bodies/sun'
import { toArcsec } from 'nebulosa/src/math/units/angle'

// distance: Earth-Sun distance in AU.
console.log(toArcsec(sunParallax(1))) // 8.794 — arcseconds
console.log(toArcsec(sunSemidiameter(1))) // 959.63 — arcseconds
console.log(toArcsec(sunSemidiameter(0.98329))) // 975.94 — arcseconds, near perihelion
```

### Solar Saros Index

A saros is a period of about 6585.3 days (18 years 11 days) after which the Sun, Moon, and lunar node return to nearly the same geometry, so a solar eclipse is followed by a similar one about 120° of longitude to the west. Solar eclipses are grouped into numbered saros series, with number 1 to 223 in the van den Bergh catalog. `solarSaros(time)` returns the saros series number of the lunation that contains `time`, using the Kluepfel formula on the Meeus lunation index. It is a numbering of the lunation, not a test that an eclipse occurs: use `nearestSolarEclipse` (see Solar Eclipse Search and Classification) to find the eclipse itself, and pass its maximal time here to get its series. For the lunar series see Lunar Saros Index.

```ts
import { nearestSolarEclipse, solarSaros } from 'nebulosa/src/astronomy/bodies/sun'
import { Timescale, timeYMD, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

console.log(solarSaros(timeYMD(2024, 4, 8))) // 139 — the total eclipse of 8 April 2024
console.log(solarSaros(timeYMD(2017, 8, 21))) // 145 — the "Great American" total eclipse of 21 August 2017
console.log(solarSaros(timeYMD(1999, 8, 11))) // 145 — the same series, one saros (18 years) earlier

// The series of the next eclipse, from its time of greatest eclipse.
const eclipse = nearestSolarEclipse(timeYMDHMS(2025, 3, 1, 0, 0, 0, Timescale.UTC), true)

console.log(solarSaros(eclipse.maximalTime)) // 149 — the partial eclipse of 29 March 2025
```

### Spherical Coordinate Conversions

The same direction on the sky can be written in several spherical systems. Equatorial uses right ascension and declination, ecliptic uses longitude and latitude relative to the plane of the Earth's orbit, and Galactic uses longitude and latitude relative to the plane of the Milky Way. Converting between them is a fixed rotation (J2000 systems) or a time-dependent one (systems "of date", which depend on precession, nutation, and obliquity).

Each function takes and returns radians as a `[longitude-like, latitude-like]` pair. The J2000 pairs (`equatorialToEclipticJ2000`, `eclipticJ2000ToEquatorial`, `equatorialToGalactic`, `galacticToEquatorial`) need no time. The "of date" ones take a `Time` and default to the current instant: `equatorialToEcliptic` and `eclipticToEquatorial` rotate about the equator-of-date by the true obliquity, and `equatorialFromJ2000` and `equatorialToJ2000` apply or remove the IAU 2006/2000A precession-nutation. Longitudes and right ascensions come back in `(−π, π]`, not wrapped to `[0, 2π)`; wrap with `normalizeAngle` when you need that. These are directions only: for positions or states and the other frames, see Celestial and Terrestrial Reference Frames, and for the horizontal system see Local Horizon Coordinates.

```ts
import { eclipticJ2000ToEquatorial, eclipticToEquatorial, equatorialFromJ2000, equatorialToEcliptic, equatorialToEclipticJ2000, equatorialToGalactic, equatorialToJ2000, galacticToEquatorial } from 'nebulosa/src/astronomy/coordinates/coordinate'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

// J2000 equatorial RA 10 h, Dec +20° -> J2000 ecliptic.
const [lambda, beta] = equatorialToEclipticJ2000(hour(10), deg(20))

console.log(toDeg(lambda), toDeg(beta)) // 145.128 7.2907 — degrees
console.log(eclipticJ2000ToEquatorial(lambda, beta).map(toDeg)) // [150, 20] — degrees, round trip

// Ecliptic of date (true obliquity at `time`), then back.
console.log(equatorialToEcliptic(hour(10), deg(20), time).map(toDeg)) // [145.1281, 7.2915] — degrees

// Position of the Galactic center region in Galactic coordinates (J2000).
console.log(equatorialToGalactic(hour(17.7611), deg(-28.9362)).map(toDeg)) // [0.0052, -0.0086] — degrees
console.log(galacticToEquatorial(0, 0).map(toDeg)) // [-93.595, -28.936] — degrees; add 360 for RA = 266.405

// J2000 -> equatorial coordinates of date (precession and nutation), and back.
const [ra, dec] = equatorialFromJ2000(hour(10), deg(20), time)

console.log(toDeg(ra), toDeg(dec)) // 150.369 19.872 — degrees
console.log(equatorialToJ2000(ra, dec, time).map(toDeg)) // [150, 20] — degrees
```

### Spherical State Rates

A Cartesian position and velocity can be rewritten as spherical coordinates and their first derivatives: longitude, latitude, distance, the two angular rates, and the radial speed. This gives the apparent motion of a body on the sky, or its rate in any frame the state is already written in.

`sphericalPositionAndVelocity(pv)` takes a `[position (AU), velocity (AU/day)]` state and returns longitude (radians, `[0, 2π)`), latitude (radians), `distance` (AU), `longitudeRate` and `latitudeRate` (radians per day), and `radialVelocity` (AU/day, positive when receding). It returns `undefined` for the zero position. At an exact Cartesian pole (`x = y = 0`) the longitude is 0 and both angular rates are omitted (`undefined`), because the chart is singular; near the pole the true, possibly large, rate is returned. `longitudeRate` is the rate of the coordinate itself, not multiplied by `cos(latitude)`. `frameSphericalPositionAndVelocity(pv, frame, time, out?)` first transforms the state into `frame` (including the rotating-frame term `W · p`), then converts it, so a point fixed in ITRS has near-zero Earth-fixed rates. `out` is an optional workspace for the transformed state and may alias `pv`. For plain angle conversions without rates, see Spherical Coordinate Conversions.

```ts
import { frameSphericalPositionAndVelocity, sphericalPositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { ITRS } from 'nebulosa/src/astronomy/coordinates/frame'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

// Position in AU and velocity in AU/day, in whatever frame the state is already in.
const state = [
	[1, 1, 1],
	[0.01, -0.02, 0.03],
] as const

const spherical = sphericalPositionAndVelocity(state)

console.log(spherical?.longitude) // 0.7854 — radians
console.log(spherical?.latitude) // 0.6155 — radians
console.log(spherical?.distance) // 1.7321 — AU
console.log(spherical?.longitudeRate) // -0.015 — radians/day
console.log(spherical?.latitudeRate) // 0.016499 — radians/day
console.log(spherical?.radialVelocity) // 0.011547 — AU/day

console.log(
	sphericalPositionAndVelocity([
		[0, 0, 2],
		[0.1, 0, 0.3],
	] as const),
) // longitude 0, latitude PI/2, rates undefined, radialVelocity 0.3
console.log(
	sphericalPositionAndVelocity([
		[0, 0, 0],
		[0, 0, 0],
	] as const),
) // undefined

// An inertial point at rest sweeps across the Earth-fixed sky at Earth's spin rate.
const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

console.log(
	frameSphericalPositionAndVelocity(
		[
			[1, 0, 0],
			[0, 0, 0],
		] as const,
		ITRS,
		time,
	)?.longitudeRate,
) // -6.3004 — radians/day
```

### SPICE Body Radii

NAIF text PCK kernels list a body's triaxial reference ellipsoid as `BODY{id}_RADII`, three numbers in kilometers: the x, y, and z semi-axes in the body-fixed frame, usually the two equatorial radii and the polar radius. `bodyRadii(pool, body)` reads that variable for a NAIF body id from a loaded kernel pool (see SPICE Text Kernel Pools) and returns `{ x, y, z }` converted to AU, or `undefined` when the variable is missing or has fewer than three numbers. The result feeds `bodyShape` for surface locations (see Planetary Surface Locations).

```ts
import fs from 'fs/promises'
import { bodyRadii } from 'nebulosa/src/astronomy/ephemeris/kernels/frame.kernel'
import { Naif } from 'nebulosa/src/astronomy/ephemeris/kernels/naif'
import { readTextKernel, SpiceKernelPool } from 'nebulosa/src/astronomy/ephemeris/kernels/text.kernel'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { toKilometer } from 'nebulosa/src/math/units/distance'

// A text PCK with the BODY{id}_RADII values.
const pool = new SpiceKernelPool()

await using tpc = fileHandleSource(await fs.open('data/pck00008.tpc'))
pool.load(await readTextKernel(tpc))

const moon = bodyRadii(pool, Naif.MOON)!

console.log(toKilometer(moon.x), toKilometer(moon.y), toKilometer(moon.z)) // 1737.4 1737.4 1737.4 — km, from AU

const earth = bodyRadii(pool, Naif.EARTH)!

console.log(toKilometer(earth.x), toKilometer(earth.z)) // 6378.14 6356.75 — km, equatorial and polar

console.log(bodyRadii(pool, 999999)) // undefined — no radii loaded for that body
```

### SPICE Frame Resolution

A SPICE frame is defined by kernels: a frame kernel (`KPL/FK`) gives each frame a name and an id and says how it is built, either from a binary PCK orientation (class 2) or as a fixed offset relative to another frame (class 4, a constant `MATRIX` or `ANGLES` rotation). `SpiceFrames` resolves a frame name or id from a loaded text-kernel pool, and a binary PCK when class-2 frames are needed, into a library `Frame`, which maps the base (ICRS/J2000) axes to the body-fixed axes, with the angular-rate operator when the frame rotates (see Celestial and Terrestrial Reference Frames).

`new SpiceFrames(pool, pck?)` binds the resolver to a `SpiceKernelPool` and an optional `Pck` from `readPck` (see Binary PCK Rotation). `await frames.frame(nameOrId)` returns the `Frame` for a SPICE name (such as `'MOON_PA_DE421'`) or an integer id, and caches it. `J2000` (id 1) is built in as the identity base. A class-2 frame needs the binary PCK segment loaded and initialized, and the DAF source must stay open while you evaluate the frame. A class-4 frame chains onto its relative frame, so `MOON_PA` resolves through `MOON_PA_DE421` here. The call throws an `Error` for an unknown name or id, a missing PCK segment, an unsupported frame class (class 1 inertial frames and others) or `TKFRAME` specification, and a cyclic frame definition. The result integrates with `frameAt`, `frameToFrame`, and the other frame functions, and with `bodySurfaceLocation`.

```ts
import fs from 'fs/promises'
import { frameAt } from 'nebulosa/src/astronomy/coordinates/frame'
import { readDaf } from 'nebulosa/src/astronomy/ephemeris/kernels/daf'
import { SpiceFrames } from 'nebulosa/src/astronomy/ephemeris/kernels/frame.kernel'
import { readPck } from 'nebulosa/src/astronomy/ephemeris/kernels/pck'
import { readTextKernel, SpiceKernelPool } from 'nebulosa/src/astronomy/ephemeris/kernels/text.kernel'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { fileHandleSource } from 'nebulosa/src/io/file'

// Frame kernel (names and ids) and the binary PCK that holds the lunar orientation.
const pool = new SpiceKernelPool()

await using fk = fileHandleSource(await fs.open('data/moon_080317.tf'))
pool.load(await readTextKernel(fk))

await using bpc = fileHandleSource(await fs.open('data/moon_pa_de421_1900-2050.bpc'))
const pck = readPck(await readDaf(bpc))

await pck.initialize()

const frames = new SpiceFrames(pool, pck)
const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.TDB)

// Principal axes (class 2, from the binary PCK) and the mean-Earth frame fixed to it (class 4).
const principal = await frames.frame('MOON_PA_DE421')
const meanEarth = await frames.frame('MOON_ME_DE421')

console.log(principal.rotationAt(time).slice(0, 3)) // [0.06618, 0.92539, 0.37319] — first row, J2000 to principal axes
console.log(meanEarth.rotationAt(time).slice(0, 3)) // [0.06651, 0.92523, 0.37353] — first row, J2000 to mean-Earth axes

// The alias MOON_PA and the integer id resolve to the same frame.
console.log((await frames.frame('MOON_PA')).rotationAt(time).slice(0, 3)) // [0.06618, 0.92539, 0.37319]
console.log((await frames.frame(31006)) === principal) // true

// A state at rest in the J2000 frame, seen in the body-fixed frame (position, velocity in AU and AU/day).
console.log(
	frameAt(
		[
			[1, 0, 0],
			[0, 0, 0],
		] as const,
		principal,
		time,
	),
) // [[0.06618, -0.99773, 0.01264], [-0.22946, -0.015222, -0.00021406]]

// J2000 is the identity base and has no angular-rate operator.
console.log((await frames.frame('J2000')).dRdtTimesRtAt) // undefined
```

### SPICE Text Kernel Pools

NAIF text kernels (`KPL/PCK` and `KPL/FK`) store constants as `name = value` assignments between `\begindata` and `\begintext` markers: body radii, frame definitions, and the like. A value is a number (Fortran `D` exponents allowed), a quoted string, or a parenthesized list. An assignment either replaces a name (`=`) or appends to it (`+=`), so load order matters when several kernels set the same name.

`readTextKernel(source)` parses a text kernel into an ordered list of assignments, each `{ name, append, values }` with the name uppercased. The first line must be `KPL/PCK` or `KPL/FK`, and the call throws an `Error` for a malformed assignment, an unterminated list or string, a non-numeric value, or an `@` calendar date, which is not supported. `SpiceKernelPool` is an explicit, non-global pool: `pool.load(assignments)` applies `=` and `+=` in order against what earlier files already set (a `Map` of names to values is treated as plain `=` assignments), `pool.get(name)` returns the values or `undefined`, and `pool.numbers(name)` and `pool.strings(name)` return only the numeric or string values. Names are case-insensitive on lookup. Use the pool with SPICE Frame Resolution and SPICE Body Radii.

```ts
import { readTextKernel, SpiceKernelPool } from 'nebulosa/src/astronomy/ephemeris/kernels/text.kernel'
import { bufferSource } from 'nebulosa/src/io/io'

const text = `KPL/PCK

\\begindata
  BODY301_RADII = ( 1737.4 1737.4 1737.4 )
  FRAME_31000_NAME = 'MOON_PA'
  ITEMS = ( 1 2 )
  ITEMS += ( 3 )
  GM = ( 3.9860043543609598D+05 )
\\begintext
`

// Ordered assignments; the second ITEMS has append = true.
const assignments = await readTextKernel(bufferSource(Buffer.from(text, 'ascii')))

console.log(assignments.length) // 5

const pool = new SpiceKernelPool()

pool.load(assignments)

console.log(pool.get('items')) // [1, 2, 3] — `=` then `+=`, name matched case-insensitively
console.log(pool.numbers('BODY301_RADII')) // [1737.4, 1737.4, 1737.4] — kilometers in the file
console.log(pool.strings('FRAME_31000_NAME')) // ['MOON_PA']
console.log(pool.get('GM')) // [398600.435436096] — the D exponent is converted
console.log(pool.get('MISSING')) // undefined

// A later load replaces a name with `=`.
pool.load(new Map([['ITEMS', [9]]]))

console.log(pool.get('ITEMS')) // [9]
```

### SPK State Kernels

An SPK (Spacecraft and Planet Kernel) is a NAIF binary file of ephemerides: for a set of target bodies, the position and velocity relative to a center body over a time span, stored as numerically fitted segments inside a DAF container (see DAF Binary Containers). JPL planetary ephemerides such as DE421 and DE440 and small-body files such as the Didymos kernel are SPKs. Bodies are identified by NAIF integer codes (the `Naif` enum covers the barycenters, planets, major satellites, and some asteroids), and a chain of segments links bodies, for example the solar-system barycenter to the Earth-Moon barycenter to the Earth.

`readSpk(daf)` builds an `Spk` from an opened DAF. `spk.segments` lists every segment as `[center, target, segment]` in file order, and `await spk.segment(center, target)` returns the segment giving the target relative to the center, initialized and ready, or `undefined` when none exists. Overlapping segments for the same pair are merged, and the one latest in file order wins where they overlap. `segment.at(time)` returns `[position (AU), velocity (AU/day)]` as a fresh pair, with the time converted to TDB; it throws when the time is outside the segment's coverage. `segment.start` and `segment.end` are the coverage in TDB seconds past J2000 and `segment.frame` is the NAIF frame id. Chebyshev types 2 and 3, Lagrange type 9, and extended modified-difference type 21 are decoded; no rotation is applied, so a state is in the segment's own frame, and the J2000 frame (id 1, `SPK_FRAME_J2000`) is the one that matches the library axes. Coefficient records are read from the file when needed, so keep the DAF source open. To use segments with the rest of the library, wrap them with `spkEphemerisPath` (see Ephemeris Path Adapters). The helpers `extendedPermanentAsteroidNumber`, `extendedPrimaryBodyOfPermanentAsteroidNumber`, and `extendedSatelliteOfPermanentAsteroidNumber` build the NAIF codes JPL assigns to numbered asteroids and their satellites; the `original*` and `extendedProvisional*` ones cover the other numbering schemes.

```ts
import fs from 'fs/promises'
import { readDaf } from 'nebulosa/src/astronomy/ephemeris/kernels/daf'
import { extendedPermanentAsteroidNumber, extendedPrimaryBodyOfPermanentAsteroidNumber, Naif } from 'nebulosa/src/astronomy/ephemeris/kernels/naif'
import { readSpk } from 'nebulosa/src/astronomy/ephemeris/kernels/spk'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { fileHandleSource } from 'nebulosa/src/io/file'

await using source = fileHandleSource(await fs.open('data/de440s.bsp'))
const spk = readSpk(await readDaf(source))

console.log(spk.segments.length) // 14 — segments in DE440s

// Earth-Moon barycenter relative to the solar-system barycenter, at one TDB instant.
const segment = (await spk.segment(Naif.SSB, Naif.EMB))!
const time = timeYMDHMS(2025, 1, 15, 9, 20, 50, Timescale.TDB)

const [position, velocity] = segment.at(time)

console.log(segment.frame) // 1 — J2000
console.log(position) // [-0.42340, 0.81246, 0.35239] — AU
console.log(velocity) // [-0.015849, -0.0067662, -0.0029331] — AU/day

// The Moon relative to the Earth-Moon barycenter, from another segment.
const moon = (await spk.segment(Naif.EMB, Naif.MOON))!

console.log(moon.at(time)[0]) // [-0.0017378, 0.0016515, 0.00089348] — AU

console.log(await spk.segment(7, 9)) // undefined — no segment for that pair

// A time outside the coverage throws.
segment.at(timeYMDHMS(2300, 1, 1, 0, 0, 0, Timescale.TDB)) // Error: cannot find a segment that covers the date

// NAIF codes for asteroid 65803 (Didymos).
console.log(extendedPermanentAsteroidNumber(65803)) // 20065803
console.log(extendedPrimaryBodyOfPermanentAsteroidNumber(65803)) // 920065803 — the system, equal to Naif.DIDYMOS
```

### Starlight Deflection

The Sun and, to a much smaller degree, Jupiter and Saturn bend passing light, shifting a star's apparent position. `deflectStarlight` applies the ERFA multi-body model (`eraLdn`) to the observer-to-star direction of a star treated as infinitely distant and returns the deflected direction.

Use it for stars and other very distant sources. It must not be used for finite-distance Solar-System targets, which need a deflector-to-source geometry; `apparentDirection` handles those. Inputs are a unit direction in ICRS/BCRS axes, the observer's barycentric position in AU, and a list of snapshot bodies at the observation epoch: `bm` the mass in solar masses, `dl` the deflection limiter in radians²/2, and `p` and `v` the barycentric position (AU) and velocity (AU/day). The result is a freshly allocated unit direction and the input is not mutated. The ERFA constants for the Sun, Jupiter, and Saturn are exported from the Apparent Direction module.

```ts
import { deflectStarlight, SUN_LIGHT_DEFLECTOR_LIMITER, SUN_LIGHT_DEFLECTOR_MASS } from 'nebulosa/src/astronomy/coordinates/apparent'
import { vecAngle } from 'nebulosa/src/math/linear-algebra/vec3'
import { toArcsec } from 'nebulosa/src/math/units/angle'

const sun = { bm: SUN_LIGHT_DEFLECTOR_MASS, dl: SUN_LIGHT_DEFLECTOR_LIMITER, p: [0, 0, 0], v: [0, 0, 0] } as const

// Observer at 1 AU on +x, looking along +z, 90° from the Sun.
const direction = [0, 0, 1] as const
const deflected = deflectStarlight(direction, [1, 0, 0], [sun])

console.log(toArcsec(vecAngle(direction, deflected))) // 0.00407 — arcseconds of deflection at 90° from the Sun
```

### Stellar and Asteroidal Occultations

A body (an asteroid, or the Moon treated as a sphere) occults a star when its disk passes in front of it as seen from one observer. `occultationCandidates` answers that per-site question directly, without projecting the shadow onto the Earth: over a window it samples the topocentric angular separation between the body and the star, finds each separation minimum (the **appulse**) with the shared extrema search, refines it, and reports it as an `OccultationCandidate`. The appulse is an occultation (`occultation: true`) when the minimum separation does not exceed the angular radius of the disk, `asin(radius / distance)`, with the star treated as a point.

`target` and `observer` are samplers of position and velocity (`PositionAndVelocityOverTime`) in the same origin and frame, normally barycentric ICRS; the topocentric observer state, for example from `observerState`, is what includes the diurnal parallax, which decides which sites see the event. `star` is the ICRS direction to the star, and does not need to be a unit vector; fold proper motion and parallax into it first, as the track is only as wide as the body. Light time to the body is iterated `options.lightTimeIterations` times (default 2, enough for interplanetary distances; 0 gives the geometric position), which samples the `target` before `start` by up to the light travel time, while the observer is only sampled inside the window. Annual and diurnal aberration are omitted because they shift the star and the body almost equally and cancel in the differential separation. The accuracy is set by the ephemeris of the body and the astrometry of the star, not by this geometry.

`options.radius` is the physical radius of the body in AU (default 0, which makes every appulse a near miss), `options.maxSeparation` (radians) discards wider appulses, and `options.step` (default 60 s) must be finer than the approach one wants to catch; it is capped at a quarter of the window, so a short window is still sampled. The candidate carries the `separation` and `angularRadius` (radians), the topocentric `distance` (AU), the `relativeAngularSpeed` (radians/day) and, for a true occultation, the `duration` in seconds: the chord across the disk at that impact parameter divided by the speed. Candidates are chronological.

The first example is a synthetic encounter whose result has a closed form: a body 2 AU away drifts transversely at 2·10⁻⁴ AU/day past a star on the +x axis, with a miss distance of 10⁻⁶ AU, and the observer is fixed at the origin.

```ts
import { type PositionAndVelocity, type PositionAndVelocityOverTime, zeroPositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { occultationCandidates } from 'nebulosa/src/astronomy/events/occultation'
import { Timescale, time, timeShift, timeSubtract, type Time } from 'nebulosa/src/astronomy/time/time'
import { DAYSEC } from 'nebulosa/src/core/constants'
import { toArcsec } from 'nebulosa/src/math/units/angle'

const crossing: Time = time(2461200.5, 0, Timescale.TDB)

// The body is on the +x line of sight at `crossing` and drifts along z.
const target: PositionAndVelocityOverTime = (t: Time): PositionAndVelocity => [
	[2, 1e-6, 2e-4 * timeSubtract(t, crossing)],
	[0, 0, 2e-4],
]
const observer: PositionAndVelocityOverTime = () => zeroPositionAndVelocity()

const start = timeShift(crossing, -0.02)
const stop = timeShift(crossing, 0.02)

// Geometric position (no light time) and a body of radius 3·10⁻⁶ AU, about 449 km.
const [appulse] = occultationCandidates(target, [1, 0, 0], observer, start, stop, { radius: 3e-6, lightTimeIterations: 0 })

console.log(appulse.occultation) // true
console.log(timeSubtract(appulse.time, crossing) * DAYSEC) // ≈ 0 — seconds from the crossing
console.log(toArcsec(appulse.separation)) // 0.1031 — the miss distance over the range
console.log(toArcsec(appulse.angularRadius)) // 0.3094
console.log(appulse.distance) // 2
console.log(appulse.relativeAngularSpeed) // 0.0001 — radians/day
console.log(appulse.duration) // 2443.8 — seconds

// A zero radius reports the same appulse as a near miss, and maxSeparation filters it out.
const [point] = occultationCandidates(target, [1, 0, 0], observer, start, stop, { lightTimeIterations: 0 })
console.log(point.occultation, point.duration) // false undefined
console.log(occultationCandidates(target, [1, 0, 0], observer, start, stop, { lightTimeIterations: 0, maxSeparation: 1e-7 }).length) // 0
```

The second example uses a real orbit. Ceres, from its JPL Horizons heliocentric state at JD 2461200.5 TDB, is moved to the barycentric frame with the VSOP87E Sun, and the observer is São Paulo with the Earth's barycentric state. To keep the example self-contained, the star is placed exactly on the geometric topocentric direction of Ceres at a chosen instant, so an occultation is guaranteed there; it does not predict a real event.

```ts
import { type PositionAndVelocityOverTime } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { observerState } from 'nebulosa/src/astronomy/coordinates/correction'
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { occultationCandidates } from 'nebulosa/src/astronomy/events/occultation'
import { Ellipsoid, geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { KeplerOrbit } from 'nebulosa/src/astronomy/orbits/asteroid'
import { Timescale, time, timeShift, timeSubtract, type Time } from 'nebulosa/src/astronomy/time/time'
import { AU_KM, DAYSEC, GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { deg, toArcsec } from 'nebulosa/src/math/units/angle'
import { kilometer, toKilometer } from 'nebulosa/src/math/units/distance'

const epoch: Time = time(2461200.5, 0, Timescale.TDB)
const orbit = new KeplerOrbit([1.414905393343522, 2.2479053286939, 7.722476360317566e-1], [-9.08092698547858e-3, 3.499459682146027e-3, 3.499457832664595e-3], epoch, GM_SUN_PITJEVA_2005, matIdentity())
const site = geodeticLocation(deg(-46.633), deg(-23.55), kilometer(0.76), Ellipsoid.WGS84)

// Barycentric samplers: Ceres is the Sun plus its heliocentric state, and the observer is the topocentric one.
const target: PositionAndVelocityOverTime = (t) => {
	const [sunPosition, sunVelocity] = sun(t)
	const [position, velocity] = orbit.at(t)
	return [
		[sunPosition[0] + position[0], sunPosition[1] + position[1], sunPosition[2] + position[2]],
		[sunVelocity[0] + velocity[0], sunVelocity[1] + velocity[1], sunVelocity[2] + velocity[2]],
	]
}
const observer: PositionAndVelocityOverTime = (t) => observerState(t, earth(t), site)

const anchor = timeShift(epoch, 0.3)
const [targetPosition] = target(anchor)
const [observerPosition] = observer(anchor)
const star: [number, number, number] = [targetPosition[0] - observerPosition[0], targetPosition[1] - observerPosition[1], targetPosition[2] - observerPosition[2]]

const candidates = occultationCandidates(target, star, observer, timeShift(anchor, -0.05), timeShift(anchor, 0.05), { radius: 469 / AU_KM, lightTimeIterations: 0, step: 300 / DAYSEC })
const appulse = candidates.find((candidate) => Math.abs(timeSubtract(candidate.time, anchor)) < 0.01)!

console.log(appulse.occultation) // true
console.log(toArcsec(appulse.separation)) // 0.00026
console.log(toKilometer(appulse.distance)) // 559365738 — km
console.log(toArcsec(appulse.relativeAngularSpeed) / DAYSEC) // 0.0171 — arcsec/s
```

### Stellar Space Motion

Stars move. A catalog gives a star's position at a reference epoch together with its proper motion (the yearly drift across the sky), its parallax (which sets its distance), and its radial velocity (toward or away from us). From those, the star's position and velocity in the barycentric celestial frame can be built and then propagated to another epoch, which matters for nearby, fast stars: Barnard's Star moves more than 10″ per year. The propagation here is a linear space-motion model, not a perturbed orbit.

`star(ra, dec, pmRA?, pmDEC?, parallax?, rv?, epoch?)` returns a `StarPositionAndVelocity`: the catalog values plus the BCRS `[position (AU), velocity (AU/day)]` pair. `ra` and `dec` are radians at `epoch`, which defaults to J2000.0 (TDB). `pmRA` is the proper motion in right ascension as `dα/dt` in radians per year, which is the catalog value `μα*` divided by `cos(dec)`, not `μα*` itself; `pmDEC` is in radians per year, `parallax` in radians, and `rv` in AU/day, positive when receding (`kilometerPerSecond` converts km/s). A zero parallax places the star at a very large distance and a zero proper motion and radial velocity make it fixed. `spaceMotion(star, time, out?)` returns the star's position and velocity propagated to `time`, writing into `out` when given (it is returned). The position is the space-motion-corrected one; the velocity is the constant catalog velocity. The angular position at that time is `equatorial(position)`. For the place an observer sees, with aberration and refraction, see Observed Catalog Star.

```ts
import { equatorial } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { spaceMotion, star } from 'nebulosa/src/astronomy/bodies/star'
import { Timescale, timeJulianYear } from 'nebulosa/src/astronomy/time/time'
import { arcsec, deg, hour, normalizeAngle, toDeg, toHour } from 'nebulosa/src/math/units/angle'
import { kilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// Barnard's Star at J2000.0: RA 17 h 57 m 48.5 s, Dec +4.693391°, mu_alpha* -797.84 mas/yr, mu_delta +10328.12 mas/yr,
// parallax 546.98 mas, radial velocity -110.51 km/s.
const declination = deg(4.693391)
const mas = (value: number) => arcsec(value / 1000)

const barnard = star(hour(17 + 57 / 60 + 48.4997 / 3600), declination, mas(-797.84) / Math.cos(declination), mas(10328.12), mas(546.98), kilometerPerSecond(-110.51))

console.log(barnard[0]) // [-3594.0, -375815.9, 30855.5] — AU, barycentric ICRS: about 376500 AU, 5.95 light-years
console.log(barnard[1]) // [-0.003343, 0.06787, 0.04628] — AU/day

// Propagate to J2025.0 and read the angular position.
const [position] = spaceMotion(barnard, timeJulianYear(2025, Timescale.TDB))
const [ra, dec] = equatorial(position)

console.log(toHour(normalizeAngle(ra)), toDeg(dec)) // 17.9631 4.7652 — the star has moved about 4.3' north in 25 years

// A star with no proper motion stays where the catalog puts it.
const fixed = star(hour(10), deg(20))

console.log(spaceMotion(fixed, timeJulianYear(2025, Timescale.TDB))[0]) // the same vector as fixed[0]
```

### Sub-Observer and Sub-Solar Points

The sub-observer point is the spot on a body's surface directly beneath the observer, the center of the disk as seen; its longitude is the central meridian. The sub-solar point is the spot directly beneath the Sun. Their latitudes are the tilt of the pole toward the observer or the Sun, and the longitude difference is the phase geometry. The orientation is evaluated one light time earlier, since the body turned while the light was in flight, which matters for fast rotators like Jupiter, whose prime meridian advances about 18° over the light time.

`subObserverPoint(elements, time, bodyToObserver)` returns `{ longitude, latitude }` in radians, planetocentric and east-positive, with longitude in `[0, 2π)`. `bodyToObserver` is the vector from the body's center to the observer in AU, in ICRF axes: its length sets the light-time delay and its direction sets the point. `subSolarPoint(elements, time, bodyToObserver, bodyToSun)` takes the same and the body-to-Sun vector, whose small change over the light time is neglected, and returns the point beneath the Sun as the observer sees it. For west-positive (planetographic) longitudes of a prograde body use `2π − longitude`, as `jupiterCentralMeridian` does. `positionAngleOfPole(elements, time, bodyToObserver)` returns the position angle of the body's north pole on the sky, measured at the disk center from celestial north toward east, in `(−π, π]`; for the Sun it is the classical P angle. It is referred to the true equator and equinox of date and neglects aberration of the disk-center direction. The rotation elements come from IAU Body Orientation.

```ts
import { positionAngleOfPole, subObserverPoint, subSolarPoint } from 'nebulosa/src/astronomy/bodies/orientation'
import { MARS_ROTATION, SUN_ROTATION } from 'nebulosa/src/astronomy/bodies/orientation.data'
import { earth, mars, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { type Time, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 0, 0, 0, Timescale.UTC)

// Vectors from Mars's center to a geocentric observer and to the Sun, in AU and ICRF axes.
const marsToEarth = (t: Time) => vecMinus(earth(t)[0], mars(t)[0])
const marsToSun = (t: Time) => vecMinus(sun(t)[0], mars(t)[0])

const observer = subObserverPoint(MARS_ROTATION, time, marsToEarth(time))
const solar = subSolarPoint(MARS_ROTATION, time, marsToEarth(time), marsToSun(time))

console.log(toDeg(observer.longitude), toDeg(observer.latitude)) // 131.85 -9.86 — degrees, east longitude and latitude
console.log(360 - toDeg(observer.longitude)) // 228.15 — degrees west, the central meridian
console.log(toDeg(solar.longitude), toDeg(solar.latitude)) // 107.57 -19.17 — degrees: the Sun is 19° south of Mars's equator

console.log(toDeg(positionAngleOfPole(MARS_ROTATION, time, marsToEarth(time)))) // -36.98 — degrees, tilt of the Martian axis on the sky

// The Sun: P angle and B0, the heliographic latitude of the disk center.
const sunToEarth = (t: Time) => vecMinus(earth(t)[0], sun(t)[0])

console.log(toDeg(positionAngleOfPole(SUN_ROTATION, time, sunToEarth(time)))) // -3.61 — degrees, the P angle
console.log(toDeg(subObserverPoint(SUN_ROTATION, time, sunToEarth(time)).latitude)) // 2.62 — degrees, B0
```

### TEME and ITRF Conversion

SGP4 outputs positions in TEME, the True Equator, Mean Equinox frame: an Earth-centered frame close to inertial that does not rotate with the Earth. To place a satellite over the ground you convert to ITRF, the Earth-fixed frame, by a rotation about the pole through the Greenwich mean sidereal time, optionally followed by polar motion. A velocity in the Earth-fixed frame also gains the term from the Earth's rotation, so an inertially fixed point appears to move.

`temeToItrf(pv, time, polarMotion?)` and `itrfToTeme(pv, time, polarMotion?)` convert a position `Vec3` or a `[position, velocity]` state at a `Time`, using GMST at that time. `polarMotion` is true by default and applies the polar-motion matrix from the loaded Earth orientation data (see Earth Orientation Parameters); pass `false` to skip it. `temeToItrfByGmst(pv, gmst, polarMotion?)` and `itrfToTemeByGmst(pv, gmst, polarMotion?)` take the sidereal angle in radians and an optional polar-motion `Mat3` instead, for callers that already have them. A position input returns a position and a state returns a state, both fresh, in the units of the input (AU and AU/day for SGP4 output). The conversion uses the mean Earth spin rate for the velocity term. Both directions are exact inverses of each other, and `frameToFrame(pv, TEME, ITRS, time)` gives the same result through the general frame machinery (see Celestial and Terrestrial Reference Frames). UT1, and so GMST, comes from the loaded Earth orientation data; without it UT1 equals UTC, which moves a low-orbit position by up to about 0.5 km.

```ts
import { itrfToTemeByGmst, itrfToTeme, temeToItrf, temeToItrfByGmst } from 'nebulosa/src/astronomy/coordinates/frame'
import { parseTLE, sgp4 } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { greenwichMeanSiderealTime } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'
import { toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'

// A pure geometric rotation about the pole by 10 rad of sidereal angle: a point on +x.
console.log(temeToItrfByGmst([6400, 0, 0], 10)) // [-5370.06, 3481.74, 0] — same unit as the input

// And the inverse.
console.log(itrfToTemeByGmst([5555, 3000, 0], 100)) // [6309.28, -225.904, 0]

// A satellite: the ISS at its TLE epoch, converted from TEME to the Earth-fixed frame.
const tle = parseTLE('1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996', '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611')
const teme = sgp4(tle.epoch, tle)

// Position and velocity (AU, AU/day). Output values below assume no Earth orientation data (UT1 = UTC).
const [position, velocity] = temeToItrf(teme, tle.epoch)

console.log(position.map(toKilometer)) // [4662.27, -1028.59, 4831.15] — km, ITRF
console.log(velocity.map(toKilometerPerSecond)) // [3.8830, 5.7151, -2.5222] — km/s, relative to the rotating Earth

// A position alone, and without polar motion.
console.log(temeToItrf(teme[0], tle.epoch, false).map(toKilometer)) // [4662.27, -1028.59, 4831.15] — km

// Back to TEME.
console.log(itrfToTeme([position, velocity], tle.epoch)[0].map(toKilometer)) // [-3737.79, 2970.46, 4831.15] — km, the SGP4 state

// With a sidereal angle you already have, e.g. GMST from the library.
console.log(temeToItrfByGmst(teme, greenwichMeanSiderealTime(tle.epoch))[0].map(toKilometer)) // [4662.27, -1028.59, 4831.15] — km
```

### Time-Constraint Intervals

Many questions about a target are "when are all of these true at once": the target is above 30° altitude, the Sun is below −18°, the Moon is far away. Each condition can be written as a continuous scalar margin that is non-negative while the condition holds, so the answer is the set of time intervals where every margin is at least zero.

`searchIntervals(margins, start, stop, options?)` takes an array of functions of `Time`, each returning a margin, and returns the chronological `TimeInterval`s (`{ start, end }`) clipped to the window where all are non-negative. The margins are sampled together at each coarse step so you can share a geometry evaluation; the sign changes of each are refined independently with Brent's method, and the pieces between the refined crossings are kept when every margin is non-negative at their midpoint, with adjacent pieces joined. An empty array accepts the whole window, and a window of zero or negative length returns `[]`. `options.step` is the coarse step in days (default 1/24) and `options.tolerance` the refinement tolerance in days (default 1e-6, about 0.09 s). The step must resolve every crossing: a tangency, or an interval shorter than one step, can be missed. A step too small to advance the window throws a `RangeError`. For single crossings or extrema use Time-Domain Event Search and Time-Domain Extrema Search.

```ts
import { searchIntervals } from 'nebulosa/src/astronomy/events/search'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { TAU } from 'nebulosa/src/core/constants'

const start = timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.TT)
const days = (time: Time) => timeSubtract(time, start)

// Two margins over three days: sin(2πd) >= 0 (the first half of each day) and 0.75 - frac(d) >= 0.
const intervals = searchIntervals([(time) => Math.sin(TAU * days(time)), (time) => 0.75 - (days(time) % 1)], start, timeShift(start, 3), { step: 0.05 })

console.log(intervals.map((i) => [days(i.start), days(i.end)])) // [[0, 0.5], [1, 1.5], [2, 2.5]] — days from the start

// No margins: the whole window. A margin that is never non-negative: nothing.
console.log(searchIntervals([], start, timeShift(start, 1)).map((i) => [days(i.start), days(i.end)])) // [[0, 1]]
console.log(searchIntervals([() => -1], start, timeShift(start, 1))) // []
```

### Time-Domain Event Search

Many almanac events are instants where some quantity crosses a value: sunrise is where the Sun's altitude crosses zero, a conjunction where an angular difference crosses zero, a station where a rate crosses zero. Writing the quantity minus the target as a continuous function of time turns the event into a root of that function.

`searchRoots(f, start, stop, options?)` samples `f(time)` from `start` to `stop` at a coarse step, finds each sign change between consecutive samples, and refines it with Brent's method, returning the root instants in chronological order. A sample that is exactly zero is reported, and not double-counted. `options.step` is the coarse step in days (default 1/24, suitable for diurnal events) and must be finer than the spacing of the roots, since two roots inside one step are missed; `options.tolerance` is the refinement tolerance in days (default 1e-6, about 0.09 s). A window of zero or negative length returns `[]`, and a step too small to advance the window throws a `RangeError`. `f` must be continuous over the window. A quantity that wraps (right ascension, longitude, hour angle) must be unwrapped by the caller, for example with `normalizePI` around the target, or the jump at the seam looks like a crossing. This is the foundation of the higher-level event finders in this module, such as Rise, Transit, and Set and Planetary Oppositions.

```ts
import { searchRoots } from 'nebulosa/src/astronomy/events/search'
import { type Time, Timescale, timeShift, timeSubtract, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { TAU } from 'nebulosa/src/core/constants'

const start = timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.TT)

// A quantity that crosses zero every half day.
const f = (time: Time) => Math.sin(TAU * timeSubtract(time, start))

// Window of 2.2 days, scanned every 0.1 day.
const roots = searchRoots(f, start, timeShift(start, 2.2), { step: 0.1 })

console.log(roots.map((time) => timeSubtract(time, start))) // [0, 0.5, 1, 1.5, 2] — days from the start (within about 1e-15)

// A function that never changes sign has no roots.
console.log(searchRoots(() => 1, start, timeShift(start, 30))) // []

// A window of zero or negative length is empty.
console.log(searchRoots(f, timeShift(start, 1), start)) // []
```

### Time-Domain Extrema Search

Maxima and minima mark events such as greatest elongation, perihelion and aphelion, the Moon's perigee and apogee, and transit (the maximum altitude). They are the points where a scalar function of time has a local extremum, which a root search cannot find because the function does not change sign there.

`searchExtrema(f, start, stop, options?)` samples `f(time)` at a coarse step and, for each triple of consecutive samples whose middle value is strictly lower or strictly higher than both neighbours, refines the extremum with Brent's minimizer (a maximum minimizes the negated function). It returns chronological `TimeExtremum`s of `{ time, value, kind }`, where `kind` is `'minimum'` or `'maximum'` and `value` is the refined function value, not its negation. `options.step` (days, default 1/24) must be fine enough that the neighbouring samples sit on each side of the extremum, and `options.tolerance` (days, default 1e-6) is the refinement tolerance. An extremum flatter than a step, or sitting on the window's first or last sample, is not reported. A window of zero or negative length returns `[]` and a step too small to advance throws a `RangeError`. `f` must be continuous over the window, with wrapping quantities unwrapped by the caller.

```ts
import { searchExtrema } from 'nebulosa/src/astronomy/events/search'
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { type Time, Timescale, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const start = timeYMDHMS(2025, 9, 1, 0, 0, 0, Timescale.TT)
const stop = timeYMDHMS(2025, 10, 1, 0, 0, 0, Timescale.TT)

// The geocentric Moon-Earth distance (AU): its minimum is perigee and its maximum is apogee.
const distance = (time: Time) => Math.hypot(...moon(time)[0])

for (const extremum of searchExtrema(distance, start, stop, { step: 0.25 })) {
	console.log(extremum.kind, timeToDate(extremum.time).slice(0, 5), toKilometer(extremum.value))
}
// minimum [2025, 9, 10, 12, 10] 364777 — perigee, TT, km
// maximum [2025, 9, 26, 9, 47] 405548 — apogee, TT, km
```

### TLE, OMM, and SGP4 Record Construction

Satellite orbital data comes as a two-line element set (TLE), a text format used by NORAD and Space-Track, or as an Orbit Mean-Elements Message (OMM), a JSON or XML form with the same mean elements, used by CelesTrak and Space-Track. To propagate either with SGP4, the elements are converted once into a `SatRec` record that holds the initialized model state. Reusing that record for many propagation times is much cheaper than rebuilding it for each call (see SGP4/SDP4 Propagation).

`parseTLE(line1, line2, name?)` parses a TLE into a structured `TLE` with the epoch as a UTC `Time` and angles in radians; `meanMotion` stays in revolutions per day as published, `bstar` is in inverse Earth radii, and the eccentricity is read from its implied decimal point. It checks only that line 1 starts with `1` and line 2 with `2`; it does not validate the checksums. `recordFromTLE(tle, gravity?)` and `recordFromOMM(omm, opsmode?, gravity?)` build the record from a parsed TLE or an OMM object, converting revolutions per day to radians per minute and degrees to radians at that boundary. An OMM epoch must be ISO-8601 (`YYYY-MM-DDThh:mm:ss[.sss]`, with an optional `Z`), or an `Error` is thrown; numeric fields may be numbers or strings. `recordFromSgp4Elements(elements, options?)` builds a record directly from typed mean elements (`epoch`, `eccentricity`, angles in radians, `meanMotion` in radians per minute, optional `bstar` and `satelliteNumber`) when you have neither text format; these must be SGP4 mean elements, not osculating ones. `gravity` selects the constant set bound to the record: `SGP4_WGS72` (the default and the one operational data was generated with), `SGP4_WGS72_OLD`, or `SGP4_WGS84`. `opsmode` or `options.operationMode` is `'i'` (improved, the default) or `'a'` (the legacy AFSPC mode). The record reports `method` as `'n'` for near-Earth or `'d'` for deep space.

```ts
import { parseTLE, recordFromOMM, recordFromSgp4Elements, recordFromTLE, sgp4, SGP4_WGS84, type OMM } from 'nebulosa/src/astronomy/orbits/propagation/sgp4'
import { timeToDate } from 'nebulosa/src/astronomy/time/time'
import { DAYMIN, DEG2RAD, TAU } from 'nebulosa/src/core/constants'
import { toKilometer } from 'nebulosa/src/math/units/distance'
import { toDeg } from 'nebulosa/src/math/units/angle'

// A TLE, as published: two lines and an optional name.
const tle = parseTLE('1 25544U 98067A   23231.51768399  .00014050  00000+0  25837-3 0  9996', '2 25544  51.6415  14.7889 0003559 325.3396 149.4637 15.49477580411611', 'ISS (ZARYA)')

console.log(tle.satelliteNumber, tle.epochYear, tle.epochDays) // 25544 23 231.51768399
console.log(timeToDate(tle.epoch)) // [2023, 8, 19, 12, 25, 27, 896] — UTC
console.log(toDeg(tle.inclination), tle.eccentricity, tle.meanMotion) // 51.6415 0.0003559 15.4947758 — degrees, -, rev/day
console.log(tle.bstar) // 0.00025837 — inverse Earth radii

// A reusable record; propagate it as often as needed.
const record = recordFromTLE(tle)

console.log(record.satnum, record.method) // 25544 n

// The same orbit from an OMM (numbers or strings); CelesTrak and Space-Track JSON use these field names.
const omm: OMM = {
	OBJECT_NAME: 'ISS (ZARYA)',
	OBJECT_ID: '1998-067A',
	EPOCH: '2023-08-19T12:25:27.896736',
	MEAN_MOTION: 15.4947758, // rev/day
	ECCENTRICITY: 0.0003559,
	INCLINATION: 51.6415, // degrees
	RA_OF_ASC_NODE: 14.7889,
	ARG_OF_PERICENTER: 325.3396,
	MEAN_ANOMALY: 149.4637,
	EPHEMERIS_TYPE: 0,
	NORAD_CAT_ID: 25544,
	ELEMENT_SET_NO: 999,
	REV_AT_EPOCH: 41161,
	BSTAR: 0.00025837,
	MEAN_MOTION_DOT: 0.0001405,
	MEAN_MOTION_DDOT: 0,
}

console.log(sgp4(tle.epoch, recordFromOMM(omm))[0].map(toKilometer)) // [-3737.79, 2970.46, 4831.15] — km, matches the TLE record

// Directly from typed mean elements: angles in radians and the mean motion in radians per minute.
const direct = recordFromSgp4Elements({
	satelliteNumber: '25544',
	epoch: tle.epoch,
	eccentricity: 0.0003559,
	inclination: 51.6415 * DEG2RAD,
	rightAscensionOfAscendingNode: 14.7889 * DEG2RAD,
	argumentOfPerigee: 325.3396 * DEG2RAD,
	meanAnomaly: 149.4637 * DEG2RAD,
	meanMotion: (15.4947758 * TAU) / DAYMIN,
	bstar: 0.00025837,
})

console.log(sgp4(tle.epoch, direct)[0].map(toKilometer)) // [-3737.79, 2970.46, 4831.15] — km

// A different gravity model, and a malformed input.
console.log(recordFromTLE(tle, SGP4_WGS84).gravity.name) // wgs84
parseTLE('2 1', '2 2') // Error: TLE line 1 must start with "1"
```

### Topocentric Observed Place

The observed place of a source is where an observer on the Earth's surface sees it: azimuth and altitude after the Earth's motion, rotation, polar motion, and optionally atmospheric refraction. It is computed with the ERFA astrometry pipeline: the observer's context (location, Earth state, Earth orientation, atmosphere) is set up once, the ICRS direction is corrected for light deflection and aberration, and the result is rotated into the local horizon frame with refraction applied.

`icrsToObserved(icrs, time, ebpv, ehp, refraction, location)` does the full chain. `icrs` is a Cartesian vector or `[ra, dec]` in radians, assumed to have no parallax or proper motion. `ebpv` is the Earth's barycentric `[position, velocity]` (AU, AU/day) and `ehp` its heliocentric position (defaults to `ebpv[0]`). `refraction` is `{ pressure (hPa), temperature (°C), relativeHumidity (0..1), wl (µm) }` with missing fields from `DEFAULT_REFRACTION_PARAMETERS` (1013.25 hPa, 15 °C, 0.5, 0.55 µm), or `false` to disable it; zero pressure also disables it. `location` is a geodetic position and defaults to `time.location`, which throws if missing. The result is an `Observed` with `azimuth` (north through east, radians), `altitude` (radians, negative below the horizon), `hourAngle`, topocentric `rightAscension` and `declination`, and `equationOfOrigins`. The stages are available separately: `icrsToCirs` and `cirsToIcrs` (geocentric, from the Earth state only), and `cirsToObserved` and `observedToCirs` (from the site and the atmosphere). They take and return `[ra, dec]` in radians (a Cartesian vector is accepted as input). Each accepts a precomputed ERFA `astrom` as the last argument to reuse across many calls. `refractedAltitude(altitude, refraction?)` and `unrefractedAltitude(apparent, refraction?)` apply only the refraction step of the same bounded model, in radians, and are inverses of each other.

UT1 and polar motion come from the loaded Earth orientation data; without it UT1 equals UTC, so the outputs below are good to a few arcseconds (see Earth Orientation Parameters). For a quick refraction estimate without pressure or temperature, see Approximate Atmospheric Refraction.

```ts
import { cirsToObserved, icrsToCirs, icrsToObserved, observedToCirs, refractedAltitude, unrefractedAltitude } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { eraEpv00 } from 'nebulosa/src/astronomy/coordinates/erfa/earth'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { tdb, Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, hour, toDeg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const location = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400)) // longitude, latitude, elevation
const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)

// Earth's [heliocentric, barycentric] state at the TDB instant.
const t = tdb(time)
const [heliocentric, barycentric] = eraEpv00(t.day, t.fraction)

// ICRS RA 16 h, Dec -26°, with the default refraction.
const star = [hour(16), deg(-26)] as const
const observed = icrsToObserved(star, time, barycentric, heliocentric[0], undefined, location)

console.log(toDeg(observed.azimuth)) // 271.54 — degrees, north through east (west)
console.log(toDeg(observed.altitude)) // 66.71 — degrees, refracted
console.log(toDeg(observed.hourAngle)) // 26.11 — degrees, positive west

// Without refraction the altitude is the geometric one.
console.log(toDeg(icrsToObserved(star, time, barycentric, heliocentric[0], false, location).altitude)) // 66.70 — degrees

// Stage by stage: ICRS -> CIRS -> observed, and back. The altitude matches the one-step result above.
const cirs = icrsToCirs(star, time, barycentric, heliocentric[0])

console.log(cirs.map(toDeg)) // [240.0674, -26.0767] — degrees
console.log(toDeg(cirsToObserved(cirs, time, undefined, location).altitude)) // 66.71 — degrees
console.log(observedToCirs(observed.azimuth, observed.altitude, time, undefined, location).map(toDeg)) // [240.0674, -26.0767] — degrees

// Refraction alone: true altitude 10° -> apparent, and back.
console.log(toDeg(refractedAltitude(deg(10)))) // 10.0861 — degrees
console.log(toDeg(unrefractedAltitude(refractedAltitude(deg(10))))) // 10.0000 — degrees
console.log(toDeg(refractedAltitude(deg(10), { pressure: 700, temperature: -5 }))) // 10.0642 — degrees, thinner and colder air
```

### Transit Altitude and Hour Angle

For a target of known declination, the geometry of the diurnal circle gives two quick planning numbers without any time scale or ephemeris: the altitude at upper transit, which is the highest the target gets, and the hour angle at which it crosses a chosen altitude, which sets the time it spends above that altitude. Both assume a fixed declination and ignore refraction unless you fold it into the target altitude.

`altitudeAtTransit(latitude, declination)` returns `90° − |latitude − declination|` in radians, the altitude of the upper culmination; it is negative when the target never clears the horizon. `hourAngleAtAltitude(declination, latitude, targetAltitude)` returns the non-negative hour angle `H` in radians at which the body crosses `targetAltitude`, from `cos H = (sin h − sin φ sin δ) / (cos φ cos δ)`. The body is at that altitude at hour angle `−H` (rising, east of the meridian) and `+H` (setting, west), so the time above it is `2H` of hour angle. For rise and set use a small negative altitude that folds in refraction and semidiameter, such as −34′ for a point source. It returns `undefined` when the body never reaches that altitude (it stays above it, as circumpolar targets do, or stays below), and at the geographic poles, where the formula degenerates. All angles are radians. For actual rise, transit, and set instants from an ephemeris, see Rise, Transit, and Set.

```ts
import { altitudeAtTransit, hourAngleAtAltitude } from 'nebulosa/src/astronomy/formulas'
import { deg, toDeg, toHour } from 'nebulosa/src/math/units/angle'

const latitude = deg(-29.2563)
const declination = deg(7.407)

// Highest altitude of a target at declination +7.407° seen from latitude -29.2563°.
console.log(toDeg(altitudeAtTransit(latitude, declination))) // 53.34 — degrees

// A declination past the pole side culminates below the horizon from the opposite hemisphere.
console.log(toDeg(altitudeAtTransit(deg(80), deg(-85)))) // -75 — degrees, never visible

// Hour angle at the horizon with -34' of refraction: the target is up between -H and +H.
const h = hourAngleAtAltitude(declination, latitude, deg(-34 / 60))!

console.log(toDeg(h)) // 86.48 — degrees
console.log(toHour(h)) // 5.7654 — hours, so it rises about 5.77 h of sidereal time before transit

// Circumpolar at latitude +80° for declination +85°: never reaches the horizon.
console.log(hourAngleAtAltitude(deg(85), deg(80), 0)) // undefined

// At the equator, a body on the celestial equator crosses the horizon at H = 90°.
console.log(toDeg(hourAngleAtAltitude(0, 0, 0)!)) // 90
```

### Tube Flexure Pointing Error

Gravity bends the telescope tube, so the optical axis sags away from the zenith by an amount that grows toward the horizon. The sag is `flexure · sin z`, with `z` the zenith distance and `flexure` the droop at the horizon, and it acts along the vertical. Converting a vertical displacement to equatorial coordinates uses the parallactic angle `q`:

```text
Δδ = −flexure·sin z·cos q
ΔH = +flexure·sin z·sin q / cos δ
```

This is the TF term of the TPoint model and is a property of gravity, not of the mount's axes, so it is kept apart from the geometric terms of Equatorial Mount Geometric Pointing Errors.

`tubeFlexureError(hourAngle, declination, latitude, flexure)` returns `[ΔH, Δδ]` in radians on the same convention as `equatorialPointingError`, so the two can be summed away from the poles. `applyTubeFlexureError(ra, dec, lst, latitude, flexure)` returns the direction the axis really points, `[RA − ΔH, dec + Δδ]`, with the right ascension wrapped to `[0, 2π)`. All angles are radians. A zero `flexure` returns exactly `[0, 0]` (or the input). The `cos δ` division uses a declination clamped to 89.9°; within that of the pole `applyTubeFlexureError` applies the droop as a great-circle offset, so the east-west part is kept. An optional last argument `o` receives the result and is returned.

```ts
import { applyTubeFlexureError, tubeFlexureError } from 'nebulosa/src/astronomy/coordinates/pointing'
import { arcsec, deg, hour, toArcsec, toDeg, toHour } from 'nebulosa/src/math/units/angle'

const latitude = deg(-29.2563)
const flexure = arcsec(120) // droop at the horizon

// Hour angle 3 h, declination -20°.
const [deltaHourAngle, deltaDeclination] = tubeFlexureError(hour(3), deg(-20), latitude, flexure)

console.log(toArcsec(deltaHourAngle)) // 78.78 — arcseconds in hour angle
console.log(toArcsec(deltaDeclination)) // 29.79 — arcseconds in declination

// Apply to RA 10 h, Dec -20° at LST 13 h (hour angle 3 h).
const [ra, dec] = applyTubeFlexureError(hour(10), deg(-20), hour(13), latitude, flexure)

console.log(toHour(ra), toDeg(dec)) // 9.99854 -19.99173 — hours, degrees

// At the zenith there is no sag.
console.log(tubeFlexureError(0, latitude, latitude, flexure)) // [0, -0]
```

### Twilight and Darkness Windows

Twilight is the interval around sunrise and sunset when the Sun is below the horizon but still lights the sky, and it is classified by how far the Sun's center is below the geometric horizon: civil below −6°, nautical below −12°, and astronomical below −18°, when the sky is dark enough for faint-object work. Dark time for deep-sky imaging usually also asks for the Moon to be down or faint.

`darknessWindows(sunAt, location, start, end, options?)` returns four lists of `{ start, end }` intervals clipped to the window: `civil`, `nautical`, and `astronomical` (Sun altitude below −6°, −12°, and −18°) and `dark`, which is the astronomical night, further restricted by the Moon when asked. `sunAt` returns the J2000/ICRS geocentric direction of the Sun at a time, `location` is the observer, and `start` and `end` bound the search. The Sun's altitude is geometric and geocentric, as in Rise, Transit, and Set. `options.moonAt` (a Moon direction callback) keeps only the time when the Moon's altitude is at or below `options.maximumMoonAltitude` (radians, default the horizon); `options.moonIlluminationAt` with `options.maximumMoonIllumination` keeps only times when the illuminated fraction, in `[0, 1]`, is at most the limit. A lunar altitude limit without `moonAt`, or an illumination limit without `moonIlluminationAt`, throws a `RangeError` rather than being ignored. `options.step` and `options.tolerance` are the search step and tolerance in days; the step must resolve every crossing. A single night can give two intervals when the window spans an evening and the next morning, and the first and last intervals are clipped at the window edges. It is built on Time-Constraint Intervals.

```ts
import { earth, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { moon } from 'nebulosa/src/astronomy/ephemeris/models/analytical/elpmpp02'
import { darknessWindows } from 'nebulosa/src/astronomy/events/darkness'
import { geodeticLocation } from 'nebulosa/src/astronomy/observer/location'
import { type Time, Timescale, timeShift, timeToDate, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { vecMinus } from 'nebulosa/src/math/linear-algebra/vec3'
import { deg } from 'nebulosa/src/math/units/angle'
import { meter } from 'nebulosa/src/math/units/distance'

const site = geodeticLocation(deg(-70.7313), deg(-29.2563), meter(2400)) // La Silla
const start = timeYMDHMS(2025, 9, 28, 0, 0, 0, Timescale.UTC)
const end = timeShift(start, 1)

// Geocentric ICRS directions to the Sun and the Moon.
const sunAt = (time: Time) => vecMinus(sun(time)[0], earth(time)[0])
const moonAt = (time: Time) => moon(time)[0]

const fmt = (intervals: readonly { start: Time; end: Time }[]) => intervals.map((i) => [timeToDate(i.start).slice(0, 5), timeToDate(i.end).slice(0, 5)])

const windows = darknessWindows(sunAt, site, start, end)

console.log(fmt(windows.civil)) // [[[2025, 9, 28, 0, 0], [2025, 9, 28, 10, 1]], [[2025, 9, 28, 23, 6], [2025, 9, 29, 0, 0]]] — UTC
console.log(fmt(windows.nautical)) // [[..0:00, ..9:33], [..23:34, ..0:00]]
console.log(fmt(windows.astronomical)) // [[[2025, 9, 28, 0, 1], [2025, 9, 28, 9, 5]]]
console.log(fmt(windows.dark)) // same as astronomical without a Moon

// Require the Moon below the horizon as well.
console.log(fmt(darknessWindows(sunAt, site, start, end, { moonAt }).dark)) // [[[2025, 9, 28, 4, 15], [2025, 9, 28, 9, 5]]]

// Or allow it up to 10° above the horizon.
console.log(fmt(darknessWindows(sunAt, site, start, end, { moonAt, maximumMoonAltitude: deg(10) }).dark)) // [[[2025, 9, 28, 3, 21], [2025, 9, 28, 9, 5]]]

darknessWindows(sunAt, site, start, end, { maximumMoonAltitude: 0 }) // RangeError: moon direction is required when a lunar altitude limit is set
```

### Two-Body Kepler Propagation

Propagating a state under the Sun's gravity alone is the two-body problem: given a position and velocity at one epoch, the state at any other time follows from Kepler's laws, with no perturbations from planets. The library solves it with universal variables and Stumpff functions, a single formulation that holds for elliptic, parabolic, and hyperbolic orbits, forward or backward in time. It suits asteroids and comets over short spans or at moderate accuracy; it is not a substitute for a numerically integrated ephemeris over long intervals (see SPK State Kernels).

`orbit.at(time)` returns `[position (AU), velocity (AU/day)]` at any `Time`, as a fresh pair, propagating from the orbit's epoch. The elapsed time is measured in TT. The state is rotated by the orbit's `rotation`, by default from heliocentric ecliptic J2000 into equatorial J2000; pass `matIdentity()` as the rotation when building the orbit to keep the input axes. `orbit.positionAtTrueAnomaly(v)` returns the point on the orbit at a true anomaly `v` (radians), a purely geometric curve that is independent of the epoch and rotated like `at`. Propagating to the epoch reproduces the input state, and one period later returns to it for a bound orbit. The call throws an `Error` for a state with no angular momentum (`motion is not conical`) or an interval beyond the representable range. `stumpff(x)` exposes the four Stumpff functions `c0` to `c3` of the universal-variable method at one argument, as `[c0, c1, c2, c3]`; an optional second argument receives them.

```ts
import { comet, KeplerOrbit, stumpff } from 'nebulosa/src/astronomy/orbits/asteroid'
import { Timescale, time, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { GM_SUN_PITJEVA_2005 } from 'nebulosa/src/core/constants'
import { matIdentity } from 'nebulosa/src/math/linear-algebra/mat3'
import { deg } from 'nebulosa/src/math/units/angle'

// Vesta's heliocentric state at 2025-04-21 12:00 TDB (AU, AU/day), kept in the input axes with an identity rotation.
const position = [-1.70317472297052, -1.333843040283118, -0.3086709149679688] as const
const velocity = [0.007882762615954012, -0.008079478592200335, -0.004254433056153772] as const
const epoch = time(2460787, 0, Timescale.TDB)
const orbit = new KeplerOrbit(position, velocity, epoch, GM_SUN_PITJEVA_2005, matIdentity())

// One year later (365 days).
const [p, v] = orbit.at(time(2460787 + 365, 0, Timescale.TDB))

console.log(p) // [2.0377, -0.86910, -0.61354] — AU
console.log(v) // [0.0059944, 0.0093565, 0.0029453] — AU/day

// Backward in time works too.
console.log(orbit.at(time(2460787 - 365, 0, Timescale.TDB))[0]) // [-1.1587, 2.0111, 0.95372] — AU

// One period later, a bound orbit returns to its starting point.
console.log(orbit.at(time(2460787 + orbit.periodInDays, 0, Timescale.TDB))[0]) // [-1.7032, -1.3338, -0.30867] — AU

// The orbit as a curve: perihelion and aphelion, independent of the epoch.
console.log(orbit.positionAtTrueAnomaly(0)) // [-0.53792, -1.9555, -0.70925] — AU, 2.1486 AU from the Sun

// Default rotation: the orbit is propagated in ecliptic axes and returned in equatorial J2000.
const halley = comet(0.5839719999999998 * 1.967311, 0.967311, deg(162.2146), deg(59.6368), deg(112.547), timeYMDHMS(2061, 8, 31, 19, 50, 18, Timescale.TT))

console.log(halley.at(timeYMDHMS(2025, 4, 21, 12, 0, 0, Timescale.TT))[0]) // [-19.630, 29.058, 1.8353] — AU, equatorial J2000

// A hyperbolic orbit (e = 1.5) keeps flying outward.
const hyperbolic = KeplerOrbit.meanAnomaly(1.5, 1.5, deg(10), deg(20), deg(30), 0, epoch)

console.log(hyperbolic.at(time(2460787 + 100, 0, Timescale.TDB))[0]) // [-2.2033, 0.80822, 0.67784] — AU

// Stumpff functions c0..c3 at x = 0.5.
console.log(stumpff(0.5)) // [0.76024, 0.91873, 0.47951, 0.16255]
```

### Uranian Satellite Theory (GUST86)

GUST86 (Laskar and Jacobson) is the analytical theory of the five major Uranian satellites. Each body builds equinoctial elements from shared fundamental arguments (mean longitude, eccentricity and inclination phasors), converts them to rectangular coordinates, and rotates the result into the J2000 equatorial frame.

`ariel`, `umbriel`, `titania`, `oberon`, and `miranda` take a `Time` (any scale; converted to TT) and return the Uranicentric position in AU and velocity in AU/day, in J2000 equatorial axes. `gust86(time, index)` is the shared function, with `index` 0 for Ariel, 1 Umbriel, 2 Titania, 3 Oberon, and 4 Miranda. The returned vectors alias internal buffers, so copy them before computing another state. Add the result to Uranus's barycentric state for an inertial position.

```ts
import { ariel, gust86, miranda, oberon, titania, umbriel } from 'nebulosa/src/astronomy/ephemeris/models/analytical/gust86'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { toKilometer } from 'nebulosa/src/math/units/distance'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

const [position, velocity] = ariel(time)

console.log(position) // [-0.0011777, 0.00035847, -0.00033843] — AU, Uranicentric
console.log(velocity) // [-0.0010278, -0.00058557, 0.0029526] — AU/day
console.log(toKilometer(Math.hypot(...position))) // 190990 — km

console.log(toKilometer(Math.hypot(...miranda(time)[0]))) // 129996 — km
console.log(toKilometer(Math.hypot(...umbriel(time)[0]))) // 266023 — km
console.log(toKilometer(Math.hypot(...titania(time)[0]))) // 435595 — km
console.log(toKilometer(Math.hypot(...oberon(time)[0]))) // 583551 — km

// gust86(time, index): index 0 is Ariel.
console.log(gust86(time, 0)[0]) // [-0.0011777, 0.00035847, -0.00033843] — AU
```

### VSOP87E Planetary Theory

VSOP87 is the Bretagnon and Francou analytical theory of the motion of the Sun and the eight planets. Version E gives barycentric rectangular coordinates: for each body a table of periodic terms (amplitude, phase, frequency) per power of time and per coordinate is summed, and its time derivative gives the velocity. It needs no data files, and it is accurate enough for planning, finders, and most apparent-place work, though not a substitute for a numerically integrated JPL kernel when sub-arcsecond planetary astrometry is needed.

`sun`, `mercury`, `venus`, `earth`, `mars`, `jupiter`, `saturn`, `uranus`, and `neptune` share one signature: `body(time, frame?, out?)`. They return `[position (AU), velocity (AU/day)]` with the origin at the solar-system barycenter. The time is converted to TT. `frame` is `'icrf'` (the default, ICRF equatorial axes) or `'eclipticJ2000'` (the theory's native dynamical ecliptic and equinox of J2000); both keep the barycentric origin. By default a fresh pair is returned; with `out` the result is written there and the return value aliases it. Pluto is not part of VSOP87: see Pluto Short Analytical Theory. For a Moon state see ELP/MPP02 Lunar Theory, which is geocentric.

```ts
import { zeroPositionAndVelocity } from 'nebulosa/src/astronomy/coordinates/astrometry'
import { earth, jupiter, sun } from 'nebulosa/src/astronomy/ephemeris/models/analytical/vsop87e'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'

const time = timeYMDHMS(2025, 9, 28, 12, 0, 0, Timescale.TT)

// Earth, barycentric, ICRF equatorial axes (the defaults).
const [position, velocity] = earth(time)

console.log(position) // [0.99399, 0.079296, 0.034528] — AU
console.log(velocity) // [-0.0018575, 0.015660, 0.0067880] — AU/day

// The same position in the dynamical ecliptic and equinox of J2000.
console.log(earth(time, 'eclipticJ2000')[0]) // [0.99399, 0.086487, 0.00013679] — AU

// The Sun and Jupiter, barycentric.
console.log(sun(time)[0]) // [-0.0037637, -0.0051097, -0.0020576] — AU
console.log(jupiter(time)[0]) // [-1.0007, 4.6557, 2.0200] — AU

// Reusing an output state: it is overwritten and returned.
const out = zeroPositionAndVelocity()

console.log(earth(time, 'icrf', out) === out) // true
```

### Zenith and Celestial Circle Intersections

Some points on the sky are defined by the observer's meridian rather than by a catalog position: the zenith, the point where the local meridian crosses the celestial equator, and the point where it crosses the ecliptic. They are expressed as equatorial coordinates of date, and their right ascension is always the local apparent sidereal time.

`zenith(longitude, latitude, time?)` returns `[lst, latitude]`. `meridianEquator(longitude, time?)` returns `[lst, 0]`. `meridianEcliptic(longitude, time?)` returns `[lst, declination]` where the declination solves `tan(dec) = sin(ra) · tan(ε)` with the true obliquity of date. `equatorEcliptic(longitude, time?)` returns whichever equinox node (RA 0 or π, declination 0) lies within a quarter turn of the meridian. Angles are radians, longitude is east-positive, and `time` defaults to the current instant. Convert to azimuth and altitude with Local Horizon Coordinates when needed.

```ts
import { equatorEcliptic, meridianEcliptic, meridianEquator, zenith } from 'nebulosa/src/astronomy/coordinates/coordinate'
import { Timescale, timeYMDHMS } from 'nebulosa/src/astronomy/time/time'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

const time = timeYMDHMS(2026, 6, 29, 4, 0, 0, Timescale.UTC)
const longitude = deg(-70.7313)
const latitude = deg(-29.2563)

console.log(zenith(longitude, latitude, time).map(toDeg)) // [266.527, -29.256] — degrees, RA = LST and Dec = latitude
console.log(meridianEquator(longitude, time).map(toDeg)) // [266.527, 0] — degrees
console.log(meridianEcliptic(longitude, time).map(toDeg)) // [266.527, -23.399] — degrees
console.log(equatorEcliptic(longitude, time).map(toDeg)) // [180, 0] — degrees, the nearer equinox node
```

## 📐 Astrometry

### ASTAP Plate Solving

`astapPlateSolve(input, options?, signal?)` solves an image with the local ASTAP command-line program and returns a `PlateSolution` (see Plate Solution), or `undefined` when ASTAP exits with an error or writes no WCS. It spawns `astap` with `-wcs`, reads the WCS file that ASTAP writes to the temporary directory, builds the solution from it with `plateSolutionFrom`, and always deletes the temporary files. It needs the ASTAP binary and one of its star databases, which are not part of the library; the default executable is `C:\Program Files\astap\astap.exe` on Windows and `astap` on the `PATH` elsewhere, and `options.executable` overrides it. `input` is a path to a FITS or image file readable by ASTAP.

The options extend `PlateSolveOptions`. `rightAscension` and `declination` (radians) are sent only when both are given, and replace the position in the FITS header; `radius` (radians, rounded up to whole degrees and limited to 0–180) is the search radius, 180° when omitted. When a radius is given without a center, ASTAP takes the center from the FITS header. `fov` (radians) is the field-of-view hint, where 0, the default, lets ASTAP find it. `downsample` is the integer downsampling factor (0 is automatic), `timeout` is in milliseconds (default 300000, 5 minutes) and `sip` (default true) asks for the SIP distortion terms, although the current ASTAP versions may not write them. An aborted `signal` stops ASTAP and the call returns `undefined`.

```ts
import { astapPlateSolve } from 'nebulosa/src/astrometry/solvers/astap'
import { deg, hour, toArcmin, toArcsec, toDeg, toHour } from 'nebulosa/src/math/units/angle'

// A solve with hints for the center, the search radius and the field of view.
const solution = await astapPlateSolve('data/NGC3372--32.1.fit', { rightAscension: hour(10.7345), declination: deg(-59.6022), radius: deg(4), fov: deg(0.54) })

if (solution) {
	console.log(toHour(solution.rightAscension), toDeg(solution.declination)) // 10.7345062 -59.6019829
	console.log(toDeg(solution.orientation), toArcsec(solution.scale), solution.parity) // 110.1218553 2.7361834 NORMAL
	console.log(toArcmin(solution.width), toArcmin(solution.height), toArcmin(solution.radius)) // 47.2839347 32.2001423 28.6034073
	console.log(solution.widthInPixels, solution.heightInPixels, solution.CTYPE1, solution.CRPIX1) // 1037 706 RA---TAN 519
}

// A blind solve with a radius only: ASTAP takes the center from the FITS header, and SIP is turned off.
const blind = await astapPlateSolve('data/NGC3372--32.1.fit', { radius: deg(10), sip: false, timeout: 60000 })
console.log(blind && [toDeg(blind.rightAscension), toDeg(blind.declination), blind.CTYPE1]) // [ 161.0175934, -59.6019821, 'RA---TAN' ]

// It can be cancelled: the process is stopped and the result is undefined.
const controller = new AbortController()
setTimeout(() => controller.abort(), 200)
console.log(await astapPlateSolve('data/NGC3372--32.1.fit', { fov: deg(0.54) }, controller.signal)) // undefined
```

### ASTAP Star Detection

`astapDetectStars(input, options?, signal?)` detects the stars of an image with the `-extract` mode of the local ASTAP program and returns them as `DetectedStar` records (`x`, `y`, `hfd`, `snr`, `flux`), the same shape as the built-in detector of the library. It runs `astap` on `input` (a path to a FITS or image file), parses the CSV that ASTAP writes next to the input and deletes it. The ASTAP binary is required (default `C:\Program Files\astap\astap.exe` on Windows, `astap` on the `PATH` elsewhere, or `options.executable`).

The pixel coordinates are converted from the 1-based pixels of ASTAP to 0-based array indices. `minSNR` is the minimum signal-to-noise ratio passed to ASTAP (default 0), `maxStars` keeps only the brightest stars by SNR (0, the default, keeps all) and `timeout` is in milliseconds (default 300000). Failures do not throw: a missing input file, an ASTAP error or an empty list of stars give an empty array after a message on the console, and an aborted `signal` stops ASTAP and also gives an empty array.

```ts
import { astapDetectStars } from 'nebulosa/src/astrometry/solvers/astap'

// The five stars with the highest SNR of an image (file of the repository).
const stars = await astapDetectStars('data/apod4.jpg', { maxStars: 5 })
console.log(stars.length) // 5
console.log(stars[0]) // { x: 464.9656, y: 119.9062, hfd: 7.5315, snr: 295, flux: 3022214 }

// A filter on the signal-to-noise ratio, and a time limit.
const bright = await astapDetectStars('data/apod4.jpg', { minSNR: 30, timeout: 60000 })
console.log(bright.every((star) => star.hfd > 0 && star.flux > 0)) // true

// A missing file gives an empty list.
console.log(await astapDetectStars('data/missing.fit')) // []
```

### Astrometry.net Index Selection

An astrometry.net solver needs index files, each of which stores star quads whose diameters fall in a narrow interval, and a field is solvable when the indexes hold quads of roughly 10 % to 100 % of the image size. `selectAstrometryIndexes(request)` computes the minimum practical set of index files for a camera and telescope, so that a downloader can fetch only what the solver will use. It is a pure computation: it never reads the filesystem or the network, and it only returns descriptors.

The request is `focalLength` (millimeters, including reducers and extenders), `pixelPitch` (micrometers, including binning), `width` and `height` (pixels), and optionally `center` (an `EquatorialCoordinate` in radians, in the frame of the index catalog), `pointingUncertainty` (radians, default 0), `safetyMargin` (radians, default 0.25°), `minQuadFraction` (default 0.10) and `maxQuadFraction` (default 1.00) of the largest image axis. The plan holds the `pixelScale` (radians per pixel at the center), the sensor size in millimeters, the rectilinear `fieldWidth` and `fieldHeight`, `largestFieldDimension` (the largest axis, not the diagonal), `fieldCornerRadius`, the interval of quad diameters it requires, the `coverage` against the manifest (`'complete'`, `'partial'` or `'none'`, with the supported minimum and maximum), the selected `scales` and the `files`. The inputs must be finite and positive, and the selector throws for an invalid request.

The manifest has 20 scales, numbered 0 to 19: the 5200 series (5200 to 5206, quads from 2′ to 22′) is tiled in HEALPix XY tiles at resolution 2 (48 tiles per scale), and the 4100 series (4107 to 4119, from 22′ to 2000′) is all-sky with one file per scale. A file is `index-5202-00.fits` for a tile and `index-4107.fits` for an all-sky scale. Without a `center` every tile of each selected tiled scale is included (reason `'no-field-center'`); with a `center` only the tiles that intersect the search disc are kept (reason `'tile-intersects-search-disc'`), where the radius of the disc is the corner radius of the field plus the pointing uncertainty plus the safety margin, limited to π. The tile numbers are the HEALPix XY identifiers of astrometry.net, which are not the RING or NESTED numbers of standard HEALPix.

`coordinateToTile(rightAscension, declination, resolution)` gives the tile id of a position, `distanceToTile(tileId, resolution, rightAscension, declination)` the angular distance (radians) from a position to a tile, which is zero inside it, and `tileIntersectsDisc(tileId, resolution, rightAscension, declination, radius)` whether a disc of that radius touches the tile. `ASTROMETRY_INDEX_MANIFEST` is the list of scales, with `scale`, `family`, `indexNumber`, the minimum and maximum quad diameters in radians and, for the tiled families, `tileResolution`.

```ts
import { ASTROMETRY_INDEX_MANIFEST, coordinateToTile, distanceToTile, selectAstrometryIndexes, tileIntersectsDisc } from 'nebulosa/src/astrometry/solvers/astrometrynet.index'
import { deg, hour, toArcmin, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

// The scales of the manifest, with the quad diameters in arcminutes.
console.log(ASTROMETRY_INDEX_MANIFEST.length) // 20
console.log(ASTROMETRY_INDEX_MANIFEST.map((s) => `${s.indexNumber}:${toArcmin(s.minimumQuadDiameter).toFixed(1)}-${toArcmin(s.maximumQuadDiameter).toFixed(1)}`).join(' '))
// 5200:2.0-2.8 5201:2.8-4.0 5202:4.0-5.6 5203:5.6-8.0 5204:8.0-11.0 5205:11.0-16.0 5206:16.0-22.0 4107:22.0-30.0 4108:30.0-42.0 4109:42.0-60.0 4110:60.0-85.0 4111:85.0-120.0 4112:120.0-170.0 4113:170.0-240.0 4114:240.0-340.0 4115:340.0-480.0 4116:480.0-680.0 4117:680.0-1000.0 4118:1000.0-1400.0 4119:1400.0-2000.0

// A 1000 mm telescope with a 3.76 µm camera of 4144 × 2822 pixels, with no position known.
const plan = selectAstrometryIndexes({ focalLength: 1000, pixelPitch: 3.76, width: 4144, height: 2822 })
console.log(toArcsec(plan.pixelScale), plan.sensorWidth, plan.sensorHeight) // 0.7755557 15.58144 10.61072
console.log(toDeg(plan.fieldWidth), toDeg(plan.fieldHeight), toDeg(plan.fieldCornerRadius)) // 0.8927327 0.6079438 0.5400318
console.log(toArcmin(plan.minimumRequiredQuadDiameter), toArcmin(plan.maximumRequiredQuadDiameter), plan.coverage.status) // 5.3563961 53.5639614 complete
console.log(plan.scales.map((s) => s.indexNumber)) // [ 5202, 5203, 5204, 5205, 5206, 4107, 4108, 4109 ]
console.log(plan.files.length, plan.files[0].filename, plan.files[0].reason) // 243 index-5202-00.fits no-field-center

// The same camera pointed near the Carina Nebula, with 1° of pointing error: only the tiles near the field are needed.
const center = { rightAscension: hour(10.7345), declination: deg(-59.6022) }
const near = selectAstrometryIndexes({ focalLength: 1000, pixelPitch: 3.76, width: 4144, height: 2822, center, pointingUncertainty: deg(1), safetyMargin: deg(0.25) })
console.log(toDeg(near.tileSearchRadius!), near.files.length) // 1.7900318 13
console.log(near.files.map((f) => f.filename).join(' ')) // index-5202-36.fits index-5202-38.fits index-5203-36.fits ... index-4107.fits index-4108.fits index-4109.fits

// The tiles themselves: the tile of the position, its distance (0 inside) and the intersection with a small disc.
const tile = coordinateToTile(center.rightAscension, center.declination, 2)
console.log(tile, distanceToTile(tile, 2, center.rightAscension, center.declination), tileIntersectsDisc(tile, 2, center.rightAscension, center.declination, 0.01)) // 38 0 true

// A 50 mm lens needs quads larger than the manifest holds for part of the interval, so the coverage is partial.
const wide = selectAstrometryIndexes({ focalLength: 50, pixelPitch: 5, width: 6000, height: 4000 })
console.log(
	wide.coverage.status,
	wide.scales.map((s) => s.indexNumber),
	wide.files.length,
) // partial [ 4113, 4114, 4115, 4116, 4117, 4118, 4119 ] 7

// A very long focal length gives a field so small that no scale reaches it.
const tiny = selectAstrometryIndexes({ focalLength: 8000, pixelPitch: 2.4, width: 1000, height: 1000, minQuadFraction: 0.2, maxQuadFraction: 0.8 })
console.log(tiny.coverage.status, tiny.scales.length, tiny.files.length) // none 0 0
```

### Catalog Crossmatching

`crossMatchStars(detectedStars, catalog, options)` pairs detected image stars with the stars of a `StarCatalog` and recovers an approximate plate solution without a WCS. It queries a cone of the catalog around an approximate pointing, projects the catalog stars on a gnomonic plane (see Sky Projections) centered there, fits the detections to them with the geometric matcher of Star Pattern Matching and then moves the projection center to the fitted image center, repeating until the center moves less than 1″ or the iterations run out. It resolves to a `StarCrossmatchResult` and never throws for a failed match: `success` is false and `failureReason` says `'no detected stars'`, `'no catalog stars in query region'` or `'no geometric catalog match found'`.

The options are `centerRA` and `centerDEC` (radians, the approximate center of the field, with a declination in [−π/2, π/2]), `radius` (radians, the cone radius, below π/2) and `camera`, with `width` and `height` in pixels and optionally `pixelSize` (micrometers) and `focalLength` (millimeters), which give the nominal scale; without them the scale comes from the cone footprint. The cone has to cover the field and the pointing error. `refinementIterations` (default 2), `centerTolerance` (radians, default 1″), `maxCatalogStars` (the brightest kept, default and minimum 6), `projectionPaddingFactor` (the margin outside the frame, as a fraction of the larger image side) and `matchingConfig` (a `StarMatchingConfig` of the matcher) are tuning knobs. Image coordinates have the origin at the top-left corner with y increasing downward; the detections need `x`, `y` and `flux`, which orders them from the brightest, and the catalog entries need a position (a magnitude, when there is one, orders the catalog the same way).

The `solution` holds the image-center `rightAscension` and `declination`, the `scale` (radians per pixel), the `rotation` (radians), `mirrored` (parity) and `fieldRadius` (half the diagonal, radians). It is a similarity fit on a tangent plane, not a WCS with distortion, so it is a starting point for a refined solve. `matches` has one record per detection, in input order, with `status` (`'matched'` or `'unmatched'`), the `catalogStar` and `catalogIndex` of the cone query, the `residual` in pixels and the `skySeparation` in radians. `summary` counts the detected, matched, unmatched, catalog, projected and inlier stars and gives the mean and median residual and separation, `catalogStars` is the query result and `starMatch` is the matcher result of the best attempt.

```ts
import { crossMatchStars } from 'nebulosa/src/astrometry/matching/star.crossmatching'
import { Gnomonic } from 'nebulosa/src/astronomy/projections/projection'
import type { StarCatalog, StarCatalogEntry } from 'nebulosa/src/catalogs/stars/catalog'
import type { DetectedStar } from 'nebulosa/src/imaging/stars/detector'
import { sphericalSeparation } from 'nebulosa/src/math/numerical/geometry'
import { arcsec, deg, hour, toArcsec, toDeg, toHour } from 'nebulosa/src/math/units/angle'

// A catalog held in memory; the crossmatcher only calls queryCone.
class ListCatalog implements StarCatalog {
	constructor(readonly stars: readonly StarCatalogEntry[]) {}

	queryCone(ra: number, dec: number, radius: number) {
		return this.stars.filter((star) => sphericalSeparation(ra, dec, star.rightAscension, star.declination) <= radius)
	}

	queryRegion() {
		return this.stars
	}

	queryTriangle() {
		return this.stars
	}

	queryBox() {
		return this.stars
	}

	queryPolygon() {
		return this.stars
	}

	*streamRegion() {
		yield* this.stars
	}
}

// A 1600 × 1200 image of 2″/pixel centered at RA 5.5 h, Dec −5°, north up, with 16 stars at these pixel offsets from the center.
const width = 1600
const height = 1200
const scale = arcsec(2)
const center = { rightAscension: hour(5.5), declination: deg(-5) }
const plane = new Gnomonic(center.rightAscension, center.declination)
const offsets = [
	[-500, -300],
	[-420, 250],
	[-300, -80],
	[-150, 330],
	[-60, -380],
	[0, 40],
	[90, -220],
	[180, 300],
	[260, -60],
	[340, 200],
	[420, -330],
	[510, 60],
	[-210, -250],
	[150, 110],
	[-380, 10],
	[300, -290],
]
const catalog: StarCatalogEntry[] = []
const detected: DetectedStar[] = []

offsets.forEach(([dx, dy], i) => {
	const sky = plane.unproject(dx * scale, -dy * scale)!
	catalog.push({ rightAscension: sky.x, declination: sky.y, magnitude: 9 + i * 0.2 })
	detected.push({ x: width / 2 + dx, y: height / 2 + dy, flux: 5000 - i * 100, snr: 40, hfd: 2.5 })
})

// The pointing is 20″ off in RA and 15″ off in Dec, and the cone has a 1° radius.
const result = await crossMatchStars(detected, new ListCatalog(catalog), { centerRA: center.rightAscension + arcsec(20), centerDEC: center.declination - arcsec(15), radius: deg(1), camera: { width, height, pixelSize: 3.76, focalLength: 387 } })
console.log(result.success, result.failureReason) // true undefined

const solution = result.solution!
console.log(toHour(solution.rightAscension).toFixed(6), toDeg(solution.declination).toFixed(6)) // 5.500000 -5.000000
console.log(toArcsec(solution.scale).toFixed(6), toDeg(solution.rotation).toFixed(6), solution.mirrored, toDeg(solution.fieldRadius).toFixed(4)) // 2.000000 0.000000 false 0.5556

console.log(result.summary.totalDetected, result.summary.matchedCount, result.summary.catalogCount, result.summary.projectedCatalogCount, result.summary.inlierCount) // 16 16 16 16 16
console.log(result.summary.medianResidual! < 1e-6, result.summary.medianSkySeparation! < 1e-12) // true true (exact synthetic data)

const first = result.matches[0]
console.log(first.status, first.detectedIndex, first.catalogIndex, first.residual! < 1e-6, first.skySeparation! < 1e-12) // matched 0 0 true true
console.log(result.catalogStars.length, result.starMatch!.inlierCount) // 16 16

// The failures resolve with success false.
const noStars = await crossMatchStars([], new ListCatalog(catalog), { centerRA: center.rightAscension, centerDEC: center.declination, radius: deg(1), camera: { width, height } })
console.log(noStars.success, noStars.failureReason) // false no detected stars

const noCatalog = await crossMatchStars(detected, new ListCatalog([]), { centerRA: center.rightAscension, centerDEC: center.declination, radius: deg(1), camera: { width, height } })
console.log(noCatalog.success, noCatalog.failureReason) // false no catalog stars in query region
```

### FITS TAN and SIP Coordinate Mapping

The functions of `fits.wcs` convert between the sky and the pixels of an image whose FITS header holds a gnomonic WCS: `RA---TAN` and `DEC--TAN`, or the same with the `-SIP` suffix for the Simple Imaging Polynomial distortion. They take a plain `FitsHeader` object (keys are the FITS keywords, with numeric or text values), so the header can come from a file or be written by hand. Other projections (`SIN`, `ARC`, `TPV`...) are not handled and give `undefined`; see WCSLIB Equatorial Projection for them. Pixel coordinates are the FITS ones: 1-based, with the center of the first pixel at (1, 1), and `CRPIX` is in the same frame. Angles in the results are radians, the header values are degrees, and the CD matrix is in degrees per pixel.

The linear part is read from one of three conventions, and `matrixKind(header)` says which: `'cd'` (any `CDi_j` key), `'pc'` (`CDELT1` and `CDELT2` with a `PCi_j` key, whose missing terms are the identity), `'crota'` (`CDELT1`, `CDELT2` and `CROTA2`) or `'none'`; `hasCd(header)` is true unless it is `'none'`. `cdMatrix(header, kind?)` returns the row-major `[cd11, cd12, cd21, cd22]` and `cd(header, i, j)` one element with 1-based indices. `cdFromCdelt(cdelt1, cdelt2, crota, flipH?, flipV?)` builds the matrix of the CDELT + CROTA form (`crota` in radians; a flip negates the scale of its axis) and `pc2cd(pc11, pc12, pc21, pc22, cdelt1, cdelt2)` scales a PC matrix by the CDELT of each row.

`tanHeader(header)` packs the WCS into a 15-element tuple (`crpix1`, `crpix2`, `crval1`, `crval2` in radians, `cd11`, `cd12`, `cd21`, `cd22`, the determinant, the cosine and sine of the pole rotation derived from `LONPOLE`, and the SIP orders `A`, `B`, `AP` and `BP`) and returns `undefined` for a non-TAN axis, a missing reference value or a singular matrix. A missing `LONPOLE` is 180° unless `CRVAL2` is 90° or more, which is 0°, as in the FITS WCS standard. `tanProject(header, ra, dec)` gives the pixel `[x, y]` of a position, or `undefined` for a position on the far side of the tangent plane (the denominator is not positive) and for an invalid header. `tanUnproject(header, x, y)` gives `[rightAscension, declination]` with the right ascension in 0..2π, and the reference position for the reference pixel. SIP: `A_ORDER`, `B_ORDER` and the `A_p_q` and `B_p_q` coefficients apply to the pixel offsets from `CRPIX` before the CD matrix, in `tanUnproject`; `tanProject` uses the `AP` and `BP` inverse polynomials when both orders are positive, and otherwise inverts the forward polynomial by a fixed-point iteration (at most 20 steps, 1e-9 pixel), so the round trip is exact only as far as the inverse polynomials or that iteration allow. The SIP terms are used only when both `CTYPE`s end with `-SIP`.

`RA_TAN`, `RA_TAN_SIP`, `DEC_TAN` and `DEC_TAN_SIP` are the `CTYPE` strings, and `isWcsFitsKeyword(key)` tells whether a header key is a WCS keyword of this module (`CTYPEn`, `CRPIXn`, `CRVALn`, `CDi_j`, `PCi_j`, `CDELTn`, `CROTAn`, `PVi_m`, `PSi_m`, `RADESYS`, `LONPOLE`, `LATPOLE`, `EQUINOX`, `WCSAXES`, `CUNITn` and the SIP keywords), for example to copy only those cards.

```ts
import { cd, cdFromCdelt, cdMatrix, DEC_TAN, DEC_TAN_SIP, hasCd, isWcsFitsKeyword, matrixKind, pc2cd, RA_TAN, RA_TAN_SIP, tanHeader, tanProject, tanUnproject } from 'nebulosa/src/astrometry/wcs/fits.wcs'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

console.log(RA_TAN, RA_TAN_SIP, DEC_TAN, DEC_TAN_SIP) // RA---TAN RA---TAN-SIP DEC--TAN DEC--TAN-SIP

// A TAN header of 0.0005°/pixel (1.8″), centered at RA 83.8°, Dec -5.4°, with the reference pixel at (500.5, 400.5).
const header = { CTYPE1: RA_TAN, CTYPE2: DEC_TAN, CRPIX1: 500.5, CRPIX2: 400.5, CRVAL1: 83.8, CRVAL2: -5.4, CD1_1: -0.0005, CD1_2: 0, CD2_1: 0, CD2_2: 0.0005 }
console.log(matrixKind(header), hasCd(header), cdMatrix(header), cd(header, 1, 1), cd(header, 2, 2)) // cd true [ -0.0005, 0, 0, 0.0005 ] -0.0005 0.0005

// The other two conventions, and a header without a linear part.
console.log(matrixKind({ CDELT1: -0.0005, CDELT2: 0.0005, PC1_1: 1 }), matrixKind({ CDELT1: -0.0005, CDELT2: 0.0005, CROTA2: 30 }), matrixKind({ CRVAL1: 1 }), hasCd({})) // pc crota none false
console.log(cdMatrix({ CDELT1: -0.0005, CDELT2: 0.0005, PC1_1: 1, PC1_2: 0.1, PC2_1: -0.1, PC2_2: 1 })) // [ -0.0005, -0.00005, -0.00005, 0.0005 ]
console.log(cdMatrix({ CDELT1: -0.0005, CDELT2: 0.0005, CROTA2: 30 })) // [ -0.000433, -0.00025, -0.00025, 0.000433 ] (rounded)
console.log(cdFromCdelt(-0.0005, 0.0005, deg(30))) // the same matrix, from the angle in radians
console.log(cdFromCdelt(-0.0005, 0.0005, deg(30), true, false)) // [ 0.000433, -0.00025, 0.00025, 0.000433 ] (rounded; the x scale is flipped)
console.log(pc2cd(1, 0.1, -0.1, 1, -0.0005, 0.0005)) // [ -0.0005, -0.00005, -0.00005, 0.0005 ]

// The packed descriptor: crpix, crval (radians), the CD matrix, its determinant, the pole rotation and the four SIP orders.
console.log(tanHeader(header)) // [ 500.5, 400.5, 1.4625859, -0.0942478, -0.0005, 0, 0, 0.0005, -2.5e-7, 1, 0, 0, 0, 0, 0 ] (rounded)
console.log(tanHeader({ ...header, CTYPE1: 'RA---SIN' }), tanHeader({ ...header, CD1_1: 0, CD2_2: 0 }), tanHeader({ CTYPE1: RA_TAN, CTYPE2: DEC_TAN })) // undefined undefined undefined

// Sky to pixel and back.
const [x, y] = tanProject(header, deg(83.85), deg(-5.3))!
console.log(x, y) // 400.9273535770926 600.4961898691276
const [ra, dec] = tanUnproject(header, x, y)!
console.log(toDeg(ra), toDeg(dec)) // 83.85 -5.300000000000001 (to rounding)
console.log(tanUnproject(header, 500.5, 400.5)!.map(toDeg)) // [ 83.8, -5.4 ] (the reference position)
console.log(tanProject(header, deg(83.8 + 180), deg(5.4))) // undefined (the antipode is not on the tangent plane)

// The same header with a SIP distortion of order 2 in both axes.
const sip = { ...header, CTYPE1: RA_TAN_SIP, CTYPE2: DEC_TAN_SIP, A_ORDER: 2, B_ORDER: 2, A_2_0: 1e-5, A_1_1: -2e-6, B_0_2: 1.5e-5, B_1_1: 3e-6 }
const [sx, sy] = tanProject(sip, deg(83.85), deg(-5.3))!
console.log(sx, sy) // 400.7881521810434 599.9590962083622 (no AP/BP: the forward polynomial is inverted by iteration)
const [sra, sdec] = tanUnproject(sip, sx, sy)!
console.log(toDeg(sra), toDeg(sdec)) // 83.85 -5.3000000000000025
console.log(tanProject({ ...sip, AP_ORDER: 2, BP_ORDER: 2, AP_2_0: -1e-5 }, deg(83.85), deg(-5.3))) // [ 400.828206457936, 600.4961898691276 ] (with an `AP_2_0` term only, so the inverse differs from the iteration)

// The keywords that belong to the WCS.
console.log(['CRPIX1', 'CD1_1', 'A_2_0', 'BP_ORDER', 'DATE-OBS', 'NAXIS1', 'CTYPE2', 'PV1_2', 'A_DMAX', 'CROTA2'].map((key) => isWcsFitsKeyword(key))) // [ true, true, true, true, false, false, true, true, true, true ]
```

### FITS WCS Geometry Updates

`reflectFitsWcs` and `scaleAndCropFitsWcs` rewrite the WCS keywords of a header when the image itself is flipped, resized or cropped, so that the same sky position still falls on the same star. Both change the header object in place and return that same object, so clone it first (`{ ...header }`) to keep the original. They work on the primary two-axis linear WCS, TAN or TAN-SIP, and use the FITS 1-based pixel frame, where the center of the first pixel is (1, 1) and `CRPIX` follows it.

`reflectFitsWcs(header, width, height, horizontal, vertical)` mirrors the solution for an image of `width` × `height` pixels (positive integers, otherwise it throws a `RangeError`) flipped across the x axis (`horizontal`), the y axis (`vertical`) or both. `CRPIX1` becomes `width + 1 − CRPIX1` and `CRPIX2` becomes `height + 1 − CRPIX2`. The linear matrix is rewritten in its own convention: the `CD` columns, the `PC` columns, or the sign of `CDELT1` and `CDELT2`, and every SIP coefficient (`A_p_q`, `B_p_q`, `AP_p_q`, `BP_p_q`) gets the sign that its axis and the parities of `p` and `q` require. With both flags false it returns the header unchanged. After a horizontal flip a star at pixel x is at `width + 1 − x`, and after a vertical one at `height + 1 − y`, with the other coordinate unchanged.

`scaleAndCropFitsWcs(header, scaleX, scaleY, left, top)` resizes and then crops. `scaleX` and `scaleY` are positive output samples per input pixel (0.5 halves the image) and `left` and `top` are the pixels removed from the left and top of the resized grid. `CRPIX` becomes `(CRPIX − 0.5)·scale + 0.5 − offset`, so a pixel center stays a pixel center, the matrix is divided by the scales and always written as a `CD` matrix (the `PC`, `CDELT` and `CROTA` keys are removed), and the SIP coefficients and `A_DMAX` and `B_DMAX` are rescaled. Defaults of the standard (`CRPIX` and `CRVAL` 0, `CDELT` 1, `PC` the identity) apply to the axes the header declares. Alternate solutions (keys with a letter suffix) are always removed, a header without any axis keyword gets no solution, and a WCS that cannot be resized exactly (a distortion table, `PV` or `PS` terms, `-TPV`, `-TAB` and similar projections, a SIP that is incomplete or inconsistent, or a singular matrix) loses all its WCS keywords instead of staying as a wrong linear TAN. The new width and height of the image are not in the WCS, so `NAXIS1` and `NAXIS2` are left to the caller.

```ts
import { DEC_TAN, DEC_TAN_SIP, RA_TAN, RA_TAN_SIP, reflectFitsWcs, scaleAndCropFitsWcs, tanProject } from 'nebulosa/src/astrometry/wcs/fits.wcs'
import { deg } from 'nebulosa/src/math/units/angle'

// A 1000 × 800 image with a TAN-SIP solution of 0.0005°/pixel, with a small rotation term and an order-2 distortion.
const header = { CTYPE1: RA_TAN_SIP, CTYPE2: DEC_TAN_SIP, CRPIX1: 500.5, CRPIX2: 400.5, CRVAL1: 83.8, CRVAL2: -5.4, CD1_1: -0.0005, CD1_2: 0.00005, CD2_1: 0.00005, CD2_2: 0.0005, A_ORDER: 2, B_ORDER: 2, A_2_0: 1e-5, A_1_1: -2e-6, B_0_2: 1.5e-5, B_1_1: 3e-6 }
const [x, y] = tanProject(header, deg(83.85), deg(-5.3))!
console.log(x, y) // 421.61990320356387 607.7792875222979

// A horizontal flip: x goes to 1001 - x, y stays, and the coefficients change sign as needed.
const horizontal = reflectFitsWcs({ ...header }, 1000, 800, true, false)
console.log(horizontal.CRPIX1, horizontal.CD1_1, horizontal.CD1_2, horizontal.CD2_1, horizontal.CD2_2) // 500.5 0.0005 0.00005 -0.00005 0.0005
console.log(horizontal.A_2_0, horizontal.A_1_1, horizontal.B_0_2, horizontal.B_1_1) // -0.00001 -0.000002 0.000015 -0.000003
console.log(tanProject(horizontal, deg(83.85), deg(-5.3))) // [ 579.3800967964362, 607.7792875222979 ] = [ 1001 - x, y ]

// A vertical flip: y goes to 801 - y.
console.log(tanProject(reflectFitsWcs({ ...header }, 1000, 800, false, true), deg(83.85), deg(-5.3))) // [ 421.61990320356387, 193.22071247770208 ] = [ x, 801 - y ]

// No flip returns the very same header, and an invalid size throws.
console.log(reflectFitsWcs(header, 1000, 800, false, false) === header) // true
try {
	reflectFitsWcs({ ...header }, 0, 800, true, false)
} catch (e) {
	console.log((e as Error).message) // WCS reflection width must be a positive integer: 0
}

// The CDELT + CROTA and the PC conventions are mirrored in their own keywords.
console.log(reflectFitsWcs({ CTYPE1: RA_TAN, CTYPE2: DEC_TAN, CRPIX1: 500.5, CRPIX2: 400.5, CRVAL1: 83.8, CRVAL2: -5.4, CDELT1: -0.0005, CDELT2: 0.0005, CROTA2: 20 }, 1000, 800, true, true)) // CDELT1 0.0005, CDELT2 -0.0005, CRPIX unchanged (500.5, 400.5)
console.log(reflectFitsWcs({ CRPIX1: 1, CRPIX2: 1, CRVAL1: 1, CRVAL2: 1, CDELT1: -0.0005, CDELT2: 0.0005, PC1_1: 1, PC1_2: 0.1, PC2_1: -0.1, PC2_2: 1 }, 10, 10, true, false)) // CRPIX1 10, PC1_1 -1, PC1_2 0.1, PC2_1 0.1, PC2_2 1

// Halving the image and then cropping 10 columns and 20 rows: the pixels of a star follow (p - 0.5)·0.5 + 0.5 - offset.
const half = scaleAndCropFitsWcs({ ...header }, 0.5, 0.5, 10, 20)
console.log(half.CRPIX1, half.CRPIX2, half.CD1_1, half.CD1_2, half.A_2_0, half.B_0_2) // 240.5 180.5 -0.001 0.0001 0.00002 0.00003
console.log(tanProject(half, deg(83.85), deg(-5.3))) // [ 201.05995160178193, 284.13964376114893 ] = [ (x - 0.5)·0.5 + 0.5 - 10, (y - 0.5)·0.5 + 0.5 - 20 ]

// A crop alone only moves the reference pixel.
const crop = scaleAndCropFitsWcs({ ...header }, 1, 1, 100, 50)
console.log(crop.CRPIX1, crop.CRPIX2) // 400.5 350.5

// A PC header comes out as a CD matrix; an unsupported WCS loses its keywords; a header with no WCS is left alone.
console.log(scaleAndCropFitsWcs({ CRPIX1: 1, CRPIX2: 1, CRVAL1: 1, CRVAL2: 1, CDELT1: -0.0005, CDELT2: 0.0005, PC1_1: 1, PC1_2: 0.1, PC2_1: -0.1, PC2_2: 1 }, 2, 2, 0, 0)) // { CRPIX1: 1.5, CRPIX2: 1.5, CRVAL1: 1, CRVAL2: 1, CD1_1: -0.00025, CD1_2: -0.000025, CD2_1: -0.000025, CD2_2: 0.00025 }
console.log(Object.keys(scaleAndCropFitsWcs({ ...header, PV1_1: 1 }, 2, 2, 0, 0))) // []
console.log(scaleAndCropFitsWcs({ DATE_OBS: 'x', EXPTIME: 5 }, 2, 2, 0, 0)) // { DATE_OBS: "x", EXPTIME: 5 }
```

### Local Astrometry.net Plate Solving

`localAstrometryNetPlateSolve(input, options, signal?)` solves an image with the `solve-field` command-line program of the astrometry.net package and returns a `PlateSolution` (see Plate Solution), or `undefined` when `solve-field` exits with an error or writes no WCS. `input` is a path (a Blob is not accepted), `options.executable` is required (the path or name of `solve-field`), and the program needs its own index files (see Astrometry.net Index Selection). Star detection happens inside `solve-field`. The call writes its output to a temporary directory that is always removed, and it builds the solution from the WCS file with `plateSolutionFrom`.

The command line is fixed except for the hints: `--overwrite --crpix-center --no-verify --no-plots --skip-solved --no-remove-lines --uniformize 0`, `--downsample` (the `downsample` option, default 2, at least 1) and `--cpulimit` (the `timeout` in whole seconds when it is at least 1000 ms, otherwise 300). The scale comes from `fov` (radians): when it is positive the scale is limited to between 0.7 and 1.3 times the field width in degrees (`--scale-units degwidth`), and with `fov` 0 or omitted `--guess-scale` is used. The position window (`--ra`, `--dec`, `--radius`) is sent only when `rightAscension`, `declination` and `radius` are all given, the radius rounded up to whole degrees and limited to 0–180; a radius alone or a center alone is ignored. The spawned process is killed after `timeout` milliseconds (default 300000), and an aborted `signal` stops it.

```ts
import { localAstrometryNetPlateSolve } from 'nebulosa/src/astrometry/solvers/astrometrynet'
import { deg, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

// Not run here: it needs solve-field and its index files.
async function solve() {
	// A blind solve: the scale is guessed and the sky is not constrained.
	const blind = await localAstrometryNetPlateSolve('image.fits', { executable: 'solve-field' })

	// A solve with a field of view of 1° (scale between 0.7° and 1.3°) inside a 2.2° radius, which becomes 3° around RA 10°, Dec +20°.
	const hinted = await localAstrometryNetPlateSolve('image.fits', { executable: 'solve-field', fov: deg(1), rightAscension: deg(10), declination: deg(20), radius: deg(2.2), downsample: 4, timeout: 90000 })

	if (hinted) console.log(toDeg(hinted.rightAscension), toDeg(hinted.declination), toArcsec(hinted.scale), hinted.parity)

	return blind
}

// The command line of each call above, observed by replacing solve-field with a program that records its arguments and fails:
// --out nebulosa --overwrite --dir <temporary directory> --cpulimit 300 --crpix-center --downsample 2 --no-verify --no-plots --skip-solved --no-remove-lines --uniformize 0 --guess-scale image.fits
// --out nebulosa --overwrite --dir <temporary directory> --cpulimit 90 --crpix-center --downsample 4 --no-verify --no-plots --skip-solved --no-remove-lines --uniformize 0 --scale-units degwidth --scale-low 0.7 --scale-high 1.3 --ra 10 --dec 20 --radius 3 image.fits
// A failing program gives undefined, and a center without a radius sends no window at all.
console.log(typeof solve) // function
```

### Native libastrometry Plate Solving

`libAstrometryNetPlateSolve(stars, width, height, options, signal?)` solves an image through the astrometry.net solver compiled as `native/libastrometry.shared` and loaded with `bun:ffi`, so no external program is spawned. It does not detect stars: `stars` are already measured sources (`x` and `y` in pixels, 0-based with the origin at the top-left pixel, and `flux`, which orders the field from the brightest), typically from `detectStars`, and `width` and `height` are the image size in pixels. The result is a `PlateSolution` (see Plate Solution), or `undefined` when no index file is found, there are fewer than three stars or the field does not match. An aborted `signal` throws, and a damaged index throws while it is loaded. The library must exist for the platform (`load()` fails otherwise), and the solver runs synchronously inside the native call, so a blind solve against many indexes blocks the thread for as long as it takes.

`options.indexes` is required: a path, a directory scanned recursively for `index-*.fit`, `.fits` or `.fits.fz` files, or a list of them (see Astrometry.net Index Selection to choose them). The search is narrowed with `fov` (radians, the width of the field, which gives a scale of `fov / width`), `scale` (radians per pixel, which wins over `fov`) and `scaleError` (fractional, default 0.3), or with explicit `scaleLow` and `scaleHigh`. A position window needs `rightAscension`, `declination` and `radius` together (radians, the radius limited to 0–180°) and is ignored otherwise. `parity` is `'NORMAL'`, `'FLIPPED'`, `'BOTH'` or 0, 1, 2. `tweakOrder` is the SIP order (default 2, `false` disables the refinement and gives a plain TAN solution), `crpixCenter` and `crpix` set the reference pixel, and `verifyPixelSigma`, `codeTolerance`, `logOddsToKeep` (natural log, default `Math.log(1e9)`, as in `solve-field`), `maxQuads` and `maxMatches` tune the matching. The star options of `detectStars` are accepted in the same object, and `maxStars` limits the field.

`AstrometryNet` is the class behind the function: it owns one native solver, which is released by `dispose()` or `using`, and `solve` (same arguments) can be called again on the same instance. `open()` creates a fresh handle of the library, `load()` returns the cached one and `unload()` forgets it, and `astrometryNetIndexFiles(indexes)` resolves the index input to a sorted, deduplicated list of existing paths, skipping the ones that are missing.

```ts
import { AstrometryNet, astrometryNetIndexFiles, libAstrometryNetPlateSolve } from 'nebulosa/src/bindings/astrometry/libastrometry'
import { readImageFromJpeg } from 'nebulosa/src/imaging/model/image'
import { detectStars } from 'nebulosa/src/imaging/stars/detector'
import { deg, toArcsec, toDeg, toHour } from 'nebulosa/src/math/units/angle'

// 719 × 507 JPEG of the northern sky, with the 4116 index (quads from 480′ to 680′).
const image = readImageFromJpeg(Buffer.from(await Bun.file('data/apod4.jpg').arrayBuffer()), undefined, 'GRAY')!
const stars = detectStars(image, { maxStars: 500 })
console.log(stars.length, image.metadata.width, image.metadata.height) // 488 719 507

// Index files from a directory, skipping the path that does not exist.
console.log(await astrometryNetIndexFiles(['data', 'missing'])) // [ "data\\index-4116.fits" ] (on Windows; the directory is scanned for index-*.fits)

// A hinted solve: a field of 34° wide, ±20 % on the scale, SIP order 2.
const solution = await libAstrometryNetPlateSolve(stars, image.metadata.width, image.metadata.height, { indexes: 'data/index-4116.fits', fov: deg(34), scaleError: 0.2, tweakOrder: 2, maxStars: 500 })

if (solution) {
	console.log(toHour(solution.rightAscension), toDeg(solution.declination)) // 12.4786264 56.7123822 (hours, degrees, J2000)
	console.log(toArcsec(solution.scale), toDeg(solution.orientation), toDeg(solution.width)) // 170.856082 58.502268 34.092733
	console.log(solution.parity, solution.CTYPE1) // NORMAL RA---TAN-SIP
}

// The class, reused for several solves and released at the end of the scope.
using solver = new AstrometryNet()

// Fewer than 3 stars, an index path that does not exist, and a position window on the wrong part of the sky: all of them give undefined.
console.log(await solver.solve(stars.slice(0, 2), 719, 507, { indexes: 'data/index-4116.fits' })) // undefined
console.log(await solver.solve(stars, 719, 507, { indexes: 'nowhere' })) // undefined
console.log(await solver.solve(stars, 719, 507, { indexes: 'data/index-4116.fits', rightAscension: deg(10), declination: deg(-80), radius: deg(5), fov: deg(34) })) // undefined
```

### Nova Astrometry.net Plate Solving

`novaAstrometryNetPlateSolve(input, options?, signal?)` solves an image with the web service nova.astrometry.net and returns a `PlateSolution` (see Plate Solution), or `undefined` on a failure, a failed job or a timeout. `input` is a URL (sent with `url_upload`) or a `Blob` (multipart `upload`). The call logs in (unless `options.session` is given), uploads, polls the submission and then the job, downloads the WCS file and builds the solution with `plateSolutionFrom`. It needs the network and, for anything beyond the anonymous key, `options.apiKey`; the image is sent to a third-party service, as a private submission with no permission for commercial use or modification unless `publiclyVisible`, `allowCommercialUse` and `allowModifications` say otherwise. The poll waits 15 seconds between rounds. `options.timeout` (milliseconds, default 300000) bounds the whole solve and maps to `undefined`; an aborted `signal` throws.

The hints are those of `Upload`. The sky window is `rightAscension`, `declination` and `radius` (radians, sent in degrees), each sent when set, and a radius does not need a center. The scale is `scaleUnits` (`'degwidth'` by default, `'arcminwidth'` or `'arcsecperpix'`) with `scaleLower` and `scaleUpper` (radians, converted to the units; with `'degwidth'` and no bounds the service defaults of 0.1 and 180 are sent, and with the other units a missing bound is omitted), or, with `scaleType: 'ev'`, `scaleEstimated` and the fractional `scaleError`. `downsample` is at least 1 (default 2), `tweakOrder` is the SIP order (default 2), `crpixCenter` (default true) puts the reference pixel at the center and `parity` is 0 (normal), 1 (flipped) or 2 (try both, the default).

The steps are exported so that a solve can be driven by hand: `login(options?, signal?)` returns a `Session` (`status` and `session`), `upload(upload, signal?)` returns a `Submission` (`status`, `subid`), `submissionStatus(submission, { session, apiUrl? }, signal?)` returns the `jobs` slots (an entry is `null` until the job exists), `jobStatus(jobId, { session, apiUrl? }, signal?)` returns the `status` (`'solving'`, `'success'` or `'failure'`) and `wcsFile(jobId, { session, apiUrl? }, signal?)` returns the WCS FITS as a `Blob`. Each of them returns `undefined` for a non-OK response. `NOVA_ASTROMETRY_NET_URL` and `NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY` are the defaults of `apiUrl` and `apiKey`. The end-to-end function passes `apiUrl` to the login and the upload only, and the polling and the download use the default URL, so drive the steps by hand to talk to another server.

```ts
import { jobStatus, login, NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY, NOVA_ASTROMETRY_NET_URL, novaAstrometryNetPlateSolve, submissionStatus, upload, wcsFile } from 'nebulosa/src/astrometry/solvers/astrometrynet'
import { deg, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

console.log(NOVA_ASTROMETRY_NET_URL, NOVA_ASTROMETRY_NET_ANONYMOUS_API_KEY) // https://nova.astrometry.net XXXXXXXX

// Not run here: it uploads an image to the public service.
async function solve(file: Blob) {
	// An image from a URL, with a 1° search radius, and then a Blob.
	const fromUrl = await novaAstrometryNetPlateSolve('https://example.com/image.jpg', { radius: deg(1), timeout: 120000 })
	const fromBlob = await novaAstrometryNetPlateSolve(file, { scaleUnits: 'arcsecperpix', scaleLower: deg(1 / 3600), scaleUpper: deg(3 / 3600), parity: 0 })

	if (fromUrl) console.log(toDeg(fromUrl.rightAscension), toDeg(fromUrl.declination), toArcsec(fromUrl.scale))

	// The steps by hand against a server of your own.
	const apiUrl = 'http://localhost:8080'
	const session = await login({ apiUrl })
	const submission = await upload({ input: file, session, apiUrl, downsample: 4, tweakOrder: 3 })
	const status = await submissionStatus(submission!, { session, apiUrl })
	const jobId = status?.jobs.find((id) => typeof id === 'number')
	const job = jobId === undefined ? undefined : await jobStatus(jobId, { session, apiUrl })
	const wcs = job?.status === 'success' ? await wcsFile(jobId!, { session, apiUrl }) : undefined

	return [fromBlob, wcs]
}

// The JSON request that upload sent in a run against a local server of the same shape, with a URL, a center and a scale in arcsec/pixel:
// POST /api/url_upload {"session":"abc","url":"https://example.com/image.jpg","allow_commercial_use":"n","allow_modifications":"n","publicly_visible":"n","scale_units":"arcsecperpix","scale_lower":1,"scale_upper":3,"scale_type":"ul","center_ra":350,"center_dec":20,"radius":2,"downsample_factor":2,"tweak_order":2,"crpix_center":true,"parity":0}
console.log(typeof solve) // function
```

### Planar Similarity and Affine Transforms

The 2D transforms of the star matcher (see Star Pattern Matching) are plain objects in image pixels. A `SimilarityTransform` has `a`, `b`, `tx`, `ty` and `mirrored`: with `a = scale·cos(rotation)` and `b = scale·sin(rotation)` the forward map is `x' = a·x − b·y + tx`, `y' = b·x + a·y + ty`, and a mirrored transform flips the sign of the y-row rotation, `x' = a·x + b·y + tx`, `y' = b·x − a·y + ty`. An `AffineTransform` has `m00`, `m01`, `tx`, `m10`, `m11` and `ty`: `x' = m00·x + m01·y + tx`, `y' = m10·x + m11·y + ty`. The scale is `√(a² + b²)` and the rotation `atan2(b, a)` in radians, in the pixel frame of the points.

The fits take two lists of matched points of the same length, `current` (the source) and `reference` (the target), and find the least-squares transform that sends the first to the second. `fitSimilarityTransform(current, reference, mirrored?, weights?)` needs 2 or more pairs, fits the mirrored branch when `mirrored` is true (default false) and accepts optional per-pair `weights`; `fitAffineTransform(current, reference, weights?)` needs 3 or more pairs and gives the full affine map, with shear. Both return `undefined` when the lists differ in length or are too short, and collinear or coincident points give a degenerate fit, so the caller must provide a spread of points.

`applySimilarityTransformToPoint(x, y, transform)` and `applyAffineTransformToPoint(x, y, transform)` map one point to a new `{ x, y }`, `applyTransformToPoint(x, y, transform)` chooses by the shape of the transform (a `mirrored` key means a similarity) and `applyTransformToStars(stars, transform)` returns a new array in which every item keeps its other fields and has the new position. The inversions `invertSimilarityTransform`, `invertAffineTransform` and `invertTransform` return the transform that goes back, or `undefined` when it is singular: a zero scale for a similarity and a determinant below 1e-12 in absolute value for an affine.

```ts
import { applyAffineTransformToPoint, applySimilarityTransformToPoint, applyTransformToPoint, applyTransformToStars, fitAffineTransform, fitSimilarityTransform, invertAffineTransform, invertSimilarityTransform, invertTransform } from 'nebulosa/src/astrometry/matching/star.matching'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// Eight reference points, and the points rotated by 10°, scaled by 1.05 and shifted by (30, -20).
const reference = [
	[100, 120],
	[420, 80],
	[760, 200],
	[240, 400],
	[520, 360],
	[880, 520],
	[150, 700],
	[460, 640],
].map(([x, y]) => ({ x, y }))
const c = Math.cos(deg(10)) * 1.05
const s = Math.sin(deg(10)) * 1.05
const current = reference.map(({ x, y }) => ({ x: c * x - s * y + 30, y: s * x + c * y - 20 }))

// The similarity from reference to current: a = 1.05·cos(10°), b = 1.05·sin(10°).
const similarity = fitSimilarityTransform(reference, current)!
console.log(similarity.a.toFixed(6), similarity.b.toFixed(6), similarity.tx.toFixed(4), similarity.ty.toFixed(4), similarity.mirrored) // 1.034048 0.182331 30.0000 -20.0000 false
console.log(Math.hypot(similarity.a, similarity.b).toFixed(6), toDeg(Math.atan2(similarity.b, similarity.a)).toFixed(4)) // 1.050000 10.0000

// The same points with weights, and with the mirrored branch for a frame flipped in x.
console.log(fitSimilarityTransform(reference, current, false, [1, 2, 3, 4, 5, 6, 7, 8])!.a.toFixed(6)) // 1.034048
const flipped = current.map(({ x, y }) => ({ x: 1200 - x, y }))
const mirrored = fitSimilarityTransform(reference, flipped, true)!
console.log(mirrored.a.toFixed(6), mirrored.b.toFixed(6), mirrored.tx.toFixed(4), mirrored.mirrored) // -1.034048 0.182331 1170.0000 true

// The affine fit recovers a pure similarity as m00 = m11 = a, m01 = -b, m10 = b.
const affine = fitAffineTransform(reference, current)!
console.log(affine.m00.toFixed(6), affine.m01.toFixed(6), affine.m10.toFixed(6), affine.m11.toFixed(6), affine.tx.toFixed(4), affine.ty.toFixed(4)) // 1.034048 -0.182331 0.182331 1.034048 30.0000 -20.0000

// Applying the transforms to a point and to stars.
console.log(applySimilarityTransformToPoint(100, 120, similarity)) // { x: 111.5251..., y: 122.3188... }
console.log(applyAffineTransformToPoint(100, 120, affine)) // { x: 111.5251..., y: 122.3188... }
console.log(applyTransformToPoint(1, 2, similarity), applyTransformToPoint(1, 2, affine)) // { x: 30.6693..., y: -17.7495... } twice (the same point)
console.log(applyTransformToStars([{ x: 100, y: 120, flux: 9000 }], similarity)) // [ { x: 111.5251..., y: 122.3188..., flux: 9000 } ]

// The inverses, which bring the point back.
const inverse = invertSimilarityTransform(similarity)!
console.log(applySimilarityTransformToPoint(111.52514368024852, 122.3188355345657, inverse)) // { x: 100, y: 120 } (to rounding)
console.log(invertAffineTransform(affine)!.m00.toFixed(6), invertTransform(similarity)!.mirrored) // 0.937912 false

// Not enough points, a zero scale and a singular matrix give undefined.
console.log(fitSimilarityTransform([{ x: 0, y: 0 }], [{ x: 1, y: 1 }]), fitAffineTransform(reference.slice(0, 2), current.slice(0, 2))) // undefined undefined
console.log(invertSimilarityTransform({ a: 0, b: 0, tx: 1, ty: 1, mirrored: false }), invertTransform({ m00: 1, m01: 2, tx: 0, m10: 2, m11: 4, ty: 0 })) // undefined undefined
```

### Plate Solution

A plate solution is the summary of where an image points, as every solver of the library returns it. `plateSolutionFrom(header)` distills the WCS keywords of a FITS header into a `PlateSolution` and returns `undefined` when the header cannot define one: no `CRVAL1`/`CRVAL2`, or a CD matrix that is singular or not finite. The solution is the whole `FitsHeader` (so the WCS keywords, `CTYPE1`, `CRPIX1` and the SIP terms stay available) plus the derived fields: `rightAscension` and `declination` (the reference point `CRVAL1`/`CRVAL2`, radians), `orientation` (field rotation from the CD matrix, radians), `scale` (radians per pixel), `width`, `height` and `radius` (the field size and the half-diagonal, radians), `parity` and the image size in pixels (`widthInPixels` and `heightInPixels`, from `NAXIS1` and `NAXIS2`).

The CD matrix comes from `cdMatrix` (see FITS TAN and SIP Coordinate Mapping), so `CD`, `PC` with `CDELT` and `CROTA2` headers are all accepted. The `scale` is the square root of the absolute determinant of the CD matrix, the geometric mean of the two pixel scales, so it stays meaningful for non-square or sheared pixels; `width` and `height` use the length of each CD column times the image size. `parity` is `'NORMAL'` when the determinant of the CD matrix is not negative and `'FLIPPED'` otherwise, and the `orientation` is measured from the second axis in either case. The reference point is the reference of the WCS, not necessarily the image center.

`EMPTY_PLATE_SOLUTION` is a zeroed solution that serves as a neutral value before a solve, `Parity` is `'NORMAL' | 'FLIPPED'` and `PlateSolveOptions` are the hints that the solvers accept (`rightAscension`, `declination`, `radius`, `downsample`, `timeout`); each solver decides which of them it uses (see ASTAP Plate Solving, Local Astrometry.net Plate Solving, Nova Astrometry.net Plate Solving and Native libastrometry Plate Solving).

```ts
import { EMPTY_PLATE_SOLUTION, plateSolutionFrom } from 'nebulosa/src/astrometry/solvers/platesolver'
import { toArcmin, toArcsec, toDeg } from 'nebulosa/src/math/units/angle'

// A header with a CD matrix: 1.8″ pixels, a 1000 × 800 image around RA 83.8221°, Dec −5.3911°.
const header = { NAXIS1: 1000, NAXIS2: 800, CRVAL1: 83.8221, CRVAL2: -5.3911, CD1_1: -0.0005, CD1_2: 0, CD2_1: 0, CD2_2: 0.0005 }
const solution = plateSolutionFrom(header)!
console.log(toDeg(solution.rightAscension), toDeg(solution.declination)) // 83.8221 -5.3911
console.log(toArcsec(solution.scale), toArcmin(solution.width), toArcmin(solution.height), toArcmin(solution.radius)) // 1.8 30 24 19.2093727
console.log(toDeg(solution.orientation), solution.parity) // 180 FLIPPED — a negative determinant
console.log(solution.widthInPixels, solution.heightInPixels) // 1000 800

// Inverting one axis flips the parity.
const mirrored = plateSolutionFrom({ ...header, CD1_1: 0.0005 })!
console.log(mirrored.parity, toDeg(mirrored.orientation)) // NORMAL 0

// The classic CDELT/CROTA2 form is accepted too: the rotation is −150° here.
console.log(toDeg(plateSolutionFrom({ CRVAL1: 10, CRVAL2: 20, CDELT1: -0.001, CDELT2: 0.001, CROTA2: 30, NAXIS1: 100, NAXIS2: 50 })!.orientation)) // -150

// No reference point or a singular matrix gives undefined.
console.log(plateSolutionFrom({ NAXIS1: 10, NAXIS2: 10 })) // undefined
console.log(plateSolutionFrom({ ...header, CD1_1: 0, CD2_2: 0 })) // undefined

// The neutral value.
console.log(EMPTY_PLATE_SOLUTION.parity, EMPTY_PLATE_SOLUTION.scale, EMPTY_PLATE_SOLUTION.widthInPixels) // NORMAL 0 0
```

### SIP Distortion Fitting

`fitSipDistortion(matchedStars, wcs, options)` fits the forward SIP (Simple Imaging Polynomial) distortion of a TAN solution from matched stars, so that a plain gnomonic WCS becomes `RA---TAN-SIP` (see FITS TAN and SIP Coordinate Mapping). Each `MatchedStar` has the measured pixel `x`, `y`, the reference pixel `xRef`, `yRef` where the star should be according to the linear WCS and the catalog position, and an optional `weight`. The fit is a weighted least squares, in the centered offsets `u = x − CRPIX1` and `v = y − CRPIX2`, of the corrections `xRef − x` and `yRef − y` against the polynomial terms `u^i·v^j` with `2 ≤ i + j ≤ order`, solved by QR with scaled columns, one polynomial for `A` (x) and one for `B` (y), followed by iterative sigma clipping. The linear terms belong to the CD matrix, so the model has no terms of degree 0 or 1. Pixels are in the frame used by the header, and the reference pixel is the one of the linear WCS; the model describes the distortion of that frame only and should be refit if `CRPIX` changes.

`wcs` is either a `SipFitsHeader` (`crpix1`, `crpix2` and optionally the `width` and `height` in pixels, used to check the spread of the stars) or a `FitsHeader`, from which `CRPIX1`, `CRPIX2` and the image size are read. The options are `order` (an integer from 2 to 5), `maxIterations` (default 5) and `sigmaClip` (default 3, in units of the robust scatter) for the clipping, `minStars` (default the number of coefficients plus one), `minStarRatio` (default 2 stars per coefficient) and `requireRecommendedStarCount` (a warning, or an error when true, below that ratio), `weighting` (`'auto'`, `'none'` or `'star'`), `scatter` (`'mad'` or `'standardDeviation'`), `spatialDistribution` (`'off'`, `'warn'` or `'fail'`, the default being `'fail'` when the size is known), `allowPoorDistribution` (the same as `'warn'`), `spatialGridSize` (default 2), `minOccupiedCells` and `minOccupiedQuadrants` (default 3 each), `width` and `height` (which override the header) and `maxConditionNumber` (default 1e12). The fit throws a `SipFitError`, an `Error` with a `code` of `'invalidOrder'`, `'invalidCoordinate'`, `'invalidWeight'`, `'invalidOption'`, `'insufficientStars'`, `'poorSpatialDistribution'`, `'singularMatrix'`, `'illConditionedFit'` or `'excessiveOutlierRejection'`.

The result has the `order`, `A_ORDER`, `B_ORDER`, the coefficient maps `A` and `B` (keys such as `A_2_0`), a `model` (`SipModel`, which is what the other functions take), `rmsTotal`, `rmsX` and `rmsY` in pixels over the used stars, the star counts and `rejectedStarIndices`, one `residuals` entry per input star (`dx`, `dy`, `predDx`, `predDy`, the residuals `rx`, `ry` and `r`, `used`, `rejected` and `rejectedIteration`) and the `diagnostics` (`coefficientCount`, `iterations`, `scatter`, `conditionNumber`, `weighted`, `rawRmsTotal` before the fit, the median, 90th and 95th percentile and maximum residual, the `spatialDistribution` counts and the `warnings`). `countSipTerms(order)` gives the number of terms per axis, `3` for order 2, and `listSipTerms(order)` lists them as `{ i, j }` in increasing degree. `buildSipDesignMatrix(stars, wcs, order)` returns the unweighted system of the fit (`matrix` with one row per star and one column per term, `terms`, the targets `residualX` and `residualY` and the centered `centeredX` and `centeredY`). `evaluateSipCorrection(x, y, model, wcs)` returns `{ dx, dy }`, the pixel correction at a measured pixel, `applySipCorrection` returns the corrected `{ x, y }`, and `sipModelIntoFitsHeader(model, header)` writes `A_ORDER`, `B_ORDER` and every coefficient into the header (removing the old SIP keywords, including the `AP` and `BP` inverse terms) and promotes a `TAN` `CTYPE` to `TAN-SIP`, returning the same header. It does not fit the inverse polynomials, so the sky-to-pixel direction of the header is then computed by iteration.

```ts
import { applySipCorrection, buildSipDesignMatrix, countSipTerms, evaluateSipCorrection, fitSipDistortion, listSipTerms, type MatchedStar, SipFitError, sipModelIntoFitsHeader } from 'nebulosa/src/astrometry/wcs/sip.fit'
import { mulberry32 } from 'nebulosa/src/math/numerical/random'

console.log(countSipTerms(2), countSipTerms(3), countSipTerms(5)) // 3 7 18
console.log(listSipTerms(2)) // [ { i: 2, j: 0 }, { i: 1, j: 1 }, { i: 0, j: 2 } ]

// 60 stars on a 1000 × 800 image, displaced by a known distortion of order 2 and a noise of ±0.02 pixel, with one 6-pixel outlier.
const wcs = { crpix1: 500.5, crpix2: 400.5, width: 1000, height: 800 }
const random = mulberry32(7)
const distortionX = (u: number, v: number) => 2e-6 * u * u - 1e-6 * u * v
const distortionY = (u: number, v: number) => 1.5e-6 * v * v + 5e-7 * u * v
const stars: MatchedStar[] = []

for (let i = 0; i < 60; i++) {
	const x = 20 + random() * 960
	const y = 20 + random() * 760
	const u = x - wcs.crpix1
	const v = y - wcs.crpix2
	stars.push({ x, y, xRef: x + distortionX(u, v) + (random() - 0.5) * 0.04, yRef: y + distortionY(u, v) + (random() - 0.5) * 0.04 })
}

stars[5] = { ...stars[5], xRef: stars[5].xRef + 6 }

const fit = fitSipDistortion(stars, wcs, { order: 2 })
console.log(Object.entries(fit.A).map(([key, value]) => `${key}=${value.toExponential(3)}`)) // [ "A_2_0=2.022e-6", "A_1_1=-9.580e-7", "A_0_2=7.635e-9" ]
console.log(Object.entries(fit.B).map(([key, value]) => `${key}=${value.toExponential(3)}`)) // [ "B_2_0=6.347e-8", "B_1_1=4.811e-7", "B_0_2=1.547e-6" ]
console.log(fit.rmsTotal.toFixed(4), fit.rmsX.toFixed(4), fit.rmsY.toFixed(4)) // 0.0144 0.0102 0.0102
console.log(fit.inputStarCount, fit.usedStarCount, fit.rejectedStarCount, fit.rejectedStarIndices) // 60 49 11 [ 5, 7, 9, 19, 24, 27, 34, 35, 43, 52, 57 ] (the outlier and ten noise samples that the iterated clipping removes)
console.log(fit.residuals[5].rejected, fit.residuals[5].rejectedIteration, fit.residuals[5].r.toFixed(3)) // true 1 5.989

const diagnostics = fit.diagnostics
console.log(diagnostics.coefficientCount, diagnostics.iterations, diagnostics.scatterMode, diagnostics.weighted, diagnostics.conditionNumber.toFixed(3)) // 3 3 mad false 4.717
console.log(diagnostics.rawRmsTotal.toFixed(4), diagnostics.medianResidual.toFixed(4), diagnostics.p95Residual.toFixed(4), diagnostics.maxResidual.toFixed(4)) // 0.8258 0.0131 0.0200 0.0260
console.log(diagnostics.spatialDistribution, diagnostics.warnings) // { checked: true, width: 1000, height: 800, gridSize: 2, occupiedCells: 4, occupiedQuadrants: 4, minOccupiedCells: 3, minOccupiedQuadrants: 3 } []

// The correction of the model at a pixel far from the center, against the true distortion (0.1996, 0.1944), and the corrected pixel.
const { dx, dy } = evaluateSipCorrection(900, 700, fit.model, wcs)
console.log(dx.toFixed(4), dy.toFixed(4), distortionX(399.5, 299.5).toFixed(4), distortionY(399.5, 299.5).toFixed(4)) // 0.2088 0.2065 0.1996 0.1944
const corrected = applySipCorrection(900, 700, fit.model, wcs)
console.log(corrected.x.toFixed(2), corrected.y.toFixed(2)) // 900.21 700.21

// The design matrix of the first four stars: 4 rows, 3 terms.
const design = buildSipDesignMatrix(stars.slice(0, 4), wcs, 2)
console.log(design.matrix.rows, design.matrix.cols, design.terms.length, design.centeredX[0].toFixed(1), design.centeredY[0].toFixed(1), design.residualX[0].toFixed(3)) // 4 3 3 -469.3 -333.4 0.303

// Another configuration: order 3, no weights, standard deviation as scatter, a 2.5σ clip in 3 iterations and a minimum of 20 stars.
const cubic = fitSipDistortion(stars, wcs, { order: 3, weighting: 'none', scatter: 'standardDeviation', sigmaClip: 2.5, maxIterations: 3, minStars: 20 })
console.log(cubic.rmsTotal.toFixed(4), cubic.diagnostics.coefficientCount, cubic.usedStarCount, cubic.rejectedStarIndices) // 0.0139 7 59 [ 5 ]

// With weights, 'auto' uses them and 'none' ignores them; a FITS header can supply the reference pixel and the size.
const weighted = stars.map((star, i) => ({ ...star, weight: 1 + (i % 3) }))
console.log(fitSipDistortion(weighted, wcs, { order: 2 }).diagnostics.weighted, fitSipDistortion(weighted, wcs, { order: 2, weighting: 'none' }).diagnostics.weighted) // true false
console.log(fitSipDistortion(stars, { CRPIX1: 500.5, CRPIX2: 400.5, NAXIS1: 1000, NAXIS2: 800 }, { order: 2 }).usedStarCount) // 49

// The model into a TAN header: stale terms are removed and the CTYPEs become TAN-SIP.
const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 500.5, CRPIX2: 400.5, A_ORDER: 5, A_4_1: 3 }
sipModelIntoFitsHeader(fit.model, header)
console.log(Object.keys(header).join(' '), header.A_ORDER) // CTYPE1 CTYPE2 CRPIX1 CRPIX2 A_ORDER B_ORDER A_2_0 B_2_0 A_1_1 B_1_1 A_0_2 B_0_2 2
console.log(header.CTYPE1, 'A_4_1' in header) // RA---TAN-SIP false

// The failures are SipFitError with a code.
const crowded = stars.filter((star) => star.x < 400 && star.y < 300)
const attempts: [string, () => unknown][] = [
	['order 6', () => fitSipDistortion(stars, wcs, { order: 6 })],
	['3 stars', () => fitSipDistortion(stars.slice(0, 3), wcs, { order: 2 })],
	['one corner', () => fitSipDistortion(crowded, wcs, { order: 2 })],
	[
		'negative weight',
		() =>
			fitSipDistortion(
				stars.map((star) => ({ ...star, weight: -1 })),
				wcs,
				{ order: 2 },
			),
	],
	['5 stars, ratio required', () => fitSipDistortion(stars.slice(0, 5), wcs, { order: 2, requireRecommendedStarCount: true, spatialDistribution: 'off' })],
]

for (const [label, attempt] of attempts) {
	try {
		attempt()
	} catch (e) {
		console.log(label, e instanceof SipFitError, (e as SipFitError).code) // order 6 true invalidOrder; 3 stars true insufficientStars; one corner true poorSpatialDistribution; negative weight true invalidWeight; 5 stars, ratio required true insufficientStars
	}
}

// A poor distribution only warns with allowPoorDistribution, and the check is skipped with 'off'.
const warned = fitSipDistortion(crowded, wcs, { order: 2, allowPoorDistribution: true })
console.log(warned.diagnostics.warnings.length, warned.diagnostics.spatialDistribution?.occupiedCells, fitSipDistortion(crowded, wcs, { order: 2, spatialDistribution: 'off' }).diagnostics.spatialDistribution) // 2 1 { checked: false }
```

### Star Pattern Matching

`matchStars(referenceStars, currentStars, config?)` registers two lists of detected stars without knowing which star is which. It ranks the stars of each list by quality (`snr · √flux / hfd`), drops duplicates closer than `dedupeDistance`, keeps the best `maxStars` and builds local triangles from the nearest neighbors of each star. A triangle is reduced to a descriptor that does not change with scale or rotation, `[shortest/longest, middle/longest, area ratio]`, plus its chirality (a mirrored field flips it). Triangles with close descriptors vote for star pairs, the best hypotheses are scored on the whole frame and refined with outlier clipping, and the result is a similarity transform (rotation, uniform scale, optional mirror and translation), or an affine one when it fits materially better. It is deterministic and meant for tens to a few hundred stars with a scale ratio between 0.8 and 1.2 by default.

The transform maps the `currentStars` into the frame of the `referenceStars`, in pixels, so a scale below 1 means that the current frame is the larger one. The stars need `x`, `y`, `flux`, `snr` and `hfd` (stars with a non-positive one of the last three are ignored) and the pixel origin and axis directions only have to be the same in both lists. The result has `success`, `model`, `similarity` (the transform plus its `scale` and `rotation` in radians) or `affine`, the `matches` (`currentIndex`, `referenceIndex` into the input arrays and the `residual` in pixels), `inlierCount`, `rmsError`, `medianError`, `score` and, on a failure, `failureReason`: `'too few usable reference stars'`, `'too few usable current stars'` (fewer than `minStars`, default 6) or `'too few stable local patterns'`, with others for the later stages. A failure is a result, not an exception. The limits are a triangle-only matcher, a bound on the scale and rotation, and the quality of the field: nearly collinear or symmetric fields give few stable patterns.

`config` is a `StarMatchingConfig`; the defaults are `maxStars` 96, `minStars` 6, `allowMirror` true, `initialMatchRadius` 10 px, `finalMatchRadius` 2.5 px, `minScaleRatio` 0.8, `maxScaleRatio` 1.2, `maxRotation` null (any), `ransacIterations` 96, `minInliers` 6, `maxResidual` 3 px, `useWeightedFit` true, `refineIterations` 4, `descriptorTolerance` 0.025, `localNeighborCount` 7, `preferCompactPatterns` true, `modelPreference` `'similarity'`, `allowAffineFallback` true, `dedupeDistance` 2 px, `minPatternSide` 6 px, `minPatternAreaRatio` 0.015, `symmetricPatternTolerance` 0.018, `maxPatternMatchesPerPattern` 4 and `maxHypotheses` 128. Partial configs are merged with the defaults. `buildTrianglePatterns(stars, config?)` returns the triangle patterns of one list (`starIndices`, which are positions in the ranked and deduplicated list and not in the input, `descriptor`, `chirality`, the centroid, `maxRadius`, `areaScore`, `compactness` and `qualityScore`), and `canonicalTrianglePattern(points, indices, config?)` canonicalizes a single triangle, returning `undefined` for a degenerate one. The transforms are in Planar Similarity and Affine Transforms.

```ts
import { buildTrianglePatterns, canonicalTrianglePattern, matchStars } from 'nebulosa/src/astrometry/matching/star.matching'
import type { DetectedStar } from 'nebulosa/src/imaging/stars/detector'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// 15 reference stars, and the same field rotated by 10°, scaled by 1.05 and shifted by (30, -20) pixels, plus a faint extra star.
const positions = [
	[100, 120],
	[420, 80],
	[760, 200],
	[240, 400],
	[520, 360],
	[880, 520],
	[150, 700],
	[460, 640],
	[700, 760],
	[980, 300],
	[320, 880],
	[830, 900],
	[600, 500],
	[50, 450],
	[990, 700],
]
const reference: DetectedStar[] = positions.map(([x, y], i) => ({ x, y, flux: 9000 - i * 300, snr: 50 - i, hfd: 2 + (i % 3) * 0.2 }))
const c = Math.cos(deg(10)) * 1.05
const s = Math.sin(deg(10)) * 1.05
const current: DetectedStar[] = reference.map((star) => ({ ...star, x: c * star.x - s * star.y + 30, y: s * star.x + c * star.y - 20 }))
current.push({ x: 500, y: 500, flux: 400, snr: 8, hfd: 3 })

const match = matchStars(reference, current)
console.log(match.success, match.model, match.inlierCount, match.failureReason) // true similarity 15 undefined
console.log(match.similarity!.scale.toFixed(6), toDeg(match.similarity!.rotation).toFixed(4), match.similarity!.mirrored) // 0.952381 -10.0000 false (1 / 1.05, back to the reference)
console.log(match.rmsError! < 1e-9, match.matches[0].currentIndex, match.matches[0].referenceIndex, match.matches.length) // true 0 0 15 (the extra star is not matched)

// A mirrored current frame is found, unless the mirror is not allowed.
const mirrored = current.map((star) => ({ ...star, x: 1200 - star.x }))
console.log(matchStars(reference, mirrored).similarity!.mirrored, matchStars(reference, mirrored, { allowMirror: false }).success) // true false

// A rotation limit of 5° rejects the 10° field.
console.log(matchStars(reference, current, { maxRotation: deg(5) }).success) // false

// Too few stars.
console.log(matchStars(reference.slice(0, 4), current).failureReason) // too few usable reference stars
console.log(matchStars(reference, current.slice(0, 4)).failureReason) // too few usable current stars

// The triangle patterns of the reference list, and one canonical triangle.
const patterns = buildTrianglePatterns(reference)
console.log(
	patterns.length,
	patterns[0].starIndices,
	patterns[0].descriptor.map((v) => v.toFixed(4)),
	patterns[0].chirality,
) // 165 [ 0, 1, 2 ] [ "0.8526", "0.8784", "0.7062" ] -1

const triangle = canonicalTrianglePattern([reference[0], reference[1], reference[3]], [0, 1, 3])!
console.log(
	triangle.starIndices,
	triangle.descriptor.map((v) => v.toFixed(4)),
	triangle.chirality,
) // [ 0, 3, 1 ] [ "0.8526", "0.8784", "0.7062" ] -1
console.log(
	canonicalTrianglePattern(
		[
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 20, y: 0 },
		],
		[0, 1, 2],
	),
) // undefined (collinear)
```

### WCSLIB Equatorial Projection

`Wcs` is a binding to the native WCSLIB (`native/libwcs.shared`, loaded with `bun:ffi`) that parses the WCS keywords of a `FitsHeader` and converts between pixels and equatorial coordinates for any projection that WCSLIB knows (`TAN`, `SIN`, `ARC`, `ZEA`, `AIT`...), where the pure TypeScript `tanProject` and `tanUnproject` of FITS TAN and SIP Coordinate Mapping only know the gnomonic one. The sky side is always `[rightAscension, declination]` in radians, whatever the order of the FITS axes, and the pixel side is the FITS one: 1-based, with the center of the first pixel at (1, 1). The class owns native memory, so it implements `Disposable`: release it with `using` or `[Symbol.dispose]()`. The library must exist for the platform.

`new Wcs(header?)` parses the header when one is given and throws `Error('failed to initialize WCS from header')` when it cannot be used. `load(header)` does the same and returns a boolean; it accepts a single two-axis solution whose axes are `RA---` and `DEC--` in either order, and returns false, keeping the solution that was loaded before, for a header with other celestial frames (`GLON`, `GLAT`...), linear or more than two axes, no WCS keywords or several alternate solutions. Only the WCS keywords of the header are sent to the library. `pixToSky(x, y)` and `skyToPix(ra, dec)` return `[Angle, Angle]` and `[x, y]`, or `undefined` when nothing is loaded, the class is disposed, or the native call fails, which also writes the WCSLIB status to `console.error`. A `-SIP` header is parsed, but the transforms fail with that status (5 in the run below), so SIP is not applied by this class: use `tanProject` and `tanUnproject` for TAN-SIP.

`open()` returns a fresh `dlopen` handle (with `wcspih`, `wcsp2s`, `wcss2p` and `wcsvfree`), `load()` the symbols of a handle that is cached for the process, and `unload()` closes that handle; a `Wcs` created afterwards opens it again.

```ts
import { tanProject, tanUnproject } from 'nebulosa/src/astrometry/wcs/fits.wcs'
import { load, open, unload, Wcs } from 'nebulosa/src/bindings/astrometry/libwcs'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// A TAN header of 0.0005°/pixel with a small rotation term, centered at RA 83.8°, Dec -5.4°.
const header = { CTYPE1: 'RA---TAN', CTYPE2: 'DEC--TAN', CRPIX1: 500.5, CRPIX2: 400.5, CRVAL1: 83.8, CRVAL2: -5.4, CD1_1: -0.0005, CD1_2: 0.00005, CD2_1: 0.00005, CD2_2: 0.0005, RADESYS: 'ICRS', EQUINOX: 2000 }
using wcs = new Wcs(header)

// Pixel to sky agrees with the TypeScript implementation, and the reference pixel is the reference position.
console.log(wcs.pixToSky(700, 600)!.map(toDeg)) // [ 83.70984119484692, -5.290268621632361 ]
console.log(tanUnproject(header, 700, 600)!.map(toDeg)) // [ 83.70984119484692, -5.290268621632354 ]
console.log(wcs.pixToSky(500.5, 400.5)!.map(toDeg)) // [ 83.8, -5.400000000000006 ]

// Sky to pixel, which is the inverse, and again agrees with tanProject.
const [ra, dec] = wcs.pixToSky(700, 600)!
console.log(wcs.skyToPix(ra, dec)) // [ 699.9999999999877, 599.9999999999987 ]
console.log(wcs.skyToPix(deg(83.85), deg(-5.3)), tanProject(header, deg(83.85), deg(-5.3))) // [ 421.7148243207994, 608.3747074370472 ] [ 421.7148243207974, 608.374707437048 ]

// Other projections: the same header with SIN or ARC axes.
using sin = new Wcs({ ...header, CTYPE1: 'RA---SIN', CTYPE2: 'DEC--SIN' })
console.log(sin.pixToSky(700, 600)!.map(toDeg), sin.skyToPix(deg(83.85), deg(-5.3))) // [ 83.70984091889542, -5.290268285694518 ] [ 421.7149740557992, 608.3743123612096 ]
using arc = new Wcs({ ...header, CTYPE1: 'RA---ARC', CTYPE2: 'DEC--ARC' })
console.log(arc.pixToSky(700, 600)!.map(toDeg)) // [ 83.70984101087964, -5.2902683976742795 ]

// DEC before RA in the FITS axes: the result is still [RA, Dec].
using swapped = new Wcs({ ...header, CTYPE1: 'DEC--TAN', CTYPE2: 'RA---TAN', CRVAL1: -5.4, CRVAL2: 83.8, CD1_1: 0.0005, CD1_2: 0.00005, CD2_1: 0.00005, CD2_2: -0.0005 })
console.log(swapped.pixToSky(500.5, 400.5)!.map(toDeg)) // [ 83.8, -5.400000000000006 ]

// A TAN-SIP header is parsed but not applied: the transforms fail and give undefined (WCSLIB status 5 on stderr).
using sip = new Wcs({ ...header, CTYPE1: 'RA---TAN-SIP', CTYPE2: 'DEC--TAN-SIP', A_ORDER: 2, B_ORDER: 2, A_2_0: 1e-5, B_0_2: 1.5e-5 })
console.log(sip.pixToSky(700, 600), sip.skyToPix(deg(83.85), deg(-5.3))) // undefined undefined

// load() on one instance: an empty one, headers that are refused (the previous solution is kept) and a valid one.
const loaded = new Wcs()
console.log(loaded.pixToSky(1, 1), loaded.skyToPix(0, 0)) // undefined undefined
console.log(loaded.load({ ...header, CTYPE1: 'GLON-TAN', CTYPE2: 'GLAT-TAN' }), loaded.load({ SIMPLE: true }), loaded.load(header)) // false false true
console.log(loaded.load({ ...header, CTYPE1: 'GLON-TAN' }), loaded.pixToSky(500.5, 400.5)!.map(toDeg)) // false [ 83.8, -5.400000000000006 ]
loaded[Symbol.dispose]()
console.log(loaded.pixToSky(1, 1)) // undefined

try {
	new Wcs({ SIMPLE: true })
} catch (e) {
	console.log((e as Error).message) // failed to initialize WCS from header
}

// The cached library handle, released and opened again by the next Wcs, and a separate handle.
console.log(typeof load().wcspih, load() === load()) // function true
unload()
using again = new Wcs(header)
console.log(again.pixToSky(500.5, 400.5)!.map(toDeg)) // [ 83.8, -5.400000000000006 ]
const handle = open()
console.log(Object.keys(handle.symbols)) // [ "wcspih", "wcsp2s", "wcss2p", "wcsvfree" ]
handle.close()
```

## 🖼️ Imaging

Plan telescope and camera combinations, then work with captured or synthetic images.

### Aberration Inspector

### Arcsinh Stretch

`arcsinhStretch(image, options?)` applies the PixInsight-style arcsinh stretch to the normalized 0..1 buffer of an `Image`, in place, and returns the same image. A mono image is stretched per sample. An RGB image is stretched through its luminance (the mean of the three channels, or the weights of `rgbWorkingSpace` when `useRgbWorkingSpace` is set), and the three channels are multiplied by the same factor, so the color ratios above the black point are kept. `stretchFactor` (1 or more, 1 by default) sets the strength and `blackPoint` (0..1, 0 by default) is clipped to 0 and the remaining range is renormalized to 0..1 before the stretch. With `protectHighlights` the pixels that exceed 1 after the stretch are not clipped per channel: the whole image is divided by the largest value, so the ratios survive at the cost of a darker image. Non-finite options fall back to the defaults, and a stretch factor of 1 with a black point of 0 returns the image untouched (`DEFAULT_ARCSINH_STRETCH_OPTIONS`). The image is not validated: it must be a mono or interleaved RGB buffer in 0..1.

`approximateArcsinhStretchParameters(midtone?, shadow?, highlight?)` searches the `stretchFactor` and `blackPoint` whose mono arcsinh curve is the closest (RMS over 129 samples in 0..1) to the screen transfer function with that midtone, shadow and highlight (see Screen Transfer Function), so an STF that is displayed can be turned into a stretch that preserves color. The black point is searched between 0 and the shadow, and the strength is solved for each candidate so that the STF midpoint lands at 0.5. The result is an approximation of the curve, not an exact match, and the neutral STF (0.5, 0, 1) gives a factor of 1 and a black point of 0.

```ts
import { approximateArcsinhStretchParameters, arcsinhStretch, DEFAULT_ARCSINH_STRETCH_OPTIONS } from 'nebulosa/src/imaging/processing/arcsinh'
import type { Image } from 'nebulosa/src/imaging/model/types'

const ramp = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: 5, NAXIS2: 1 },
	metadata: { width: 5, height: 1, channels: 1, pixelCount: 5, stride: 5, strideInBytes: 40, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0, 0.05, 0.1, 0.5, 1]),
})

const pixels = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 3, NAXIS1: 2, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 2, height: 1, channels: 3, pixelCount: 2, stride: 6, strideInBytes: 48, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0.2, 0.1, 0.05, 0.9, 0.6, 0.3]),
})

const round = (values: ArrayLike<number>) => Array.from(values, (value) => Number(value.toFixed(4)))

// A mono ramp: the faint samples are lifted much more than the bright ones, and 0 and 1 are fixed.
console.log(round(arcsinhStretch(ramp(), { stretchFactor: 20 }).raw)) // [ 0, 0.4437, 0.5716, 0.8709, 1 ]

// The black point clips the shadows and renormalizes the rest.
console.log(round(arcsinhStretch(ramp(), { stretchFactor: 20, blackPoint: 0.05 }).raw)) // [ 0, 0, 0.4531, 0.8609, 1 ]

// Color: the channels of a pixel are scaled by the same factor, so their ratios do not change.
const color = arcsinhStretch(pixels(), { stretchFactor: 10 })
console.log(round(color.raw)) // [ 0.8992, 0.4496, 0.2248, 1, 0.8865, 0.4433 ] (the second pixel is clipped at 1 in red)
console.log(round([color.raw[0] / color.raw[1], color.raw[1] / color.raw[2]])) // 2 2 (the ratios of the first pixel)

// A bright pixel exceeds 1: it is clipped per channel by default, and rescaled as a whole with protectHighlights.
const bright = (): Image => ({ ...pixels(), raw: new Float64Array([0.9, 0.4, 0.1, 0.05, 0.02, 0.01]) })
console.log(round(arcsinhStretch(bright(), { stretchFactor: 30 }).raw)) // [ 1, 0.7457, 0.1864, 0.7195, 0.2878, 0.1439 ] (the first pixel is clipped, so its ratios change)
console.log(round(arcsinhStretch(bright(), { stretchFactor: 30, protectHighlights: true }).raw)) // [ 1, 0.4444, 0.1111, 0.4288, 0.1715, 0.0858 ] (the ratios of both pixels are kept)

// The luminance of an RGB working space instead of the channel mean.
console.log(round(arcsinhStretch(pixels(), { stretchFactor: 10, useRgbWorkingSpace: true, rgbWorkingSpace: 'BT709' }).raw)) // [ 0.8948, 0.4474, 0.2237, 1, 0.8425, 0.4212 ]

// The defaults, a factor of 1 and a black point of 0 leave the image untouched and return it.
const same = ramp()
console.log(arcsinhStretch(same) === same, arcsinhStretch(same, DEFAULT_ARCSINH_STRETCH_OPTIONS) === same, round(same.raw)) // true true [ 0, 0.05, 0.1, 0.5, 1 ]

// The arcsinh parameters that approximate an STF.
console.log(approximateArcsinhStretchParameters()) // { stretchFactor: 1, blackPoint: 0 }
console.log(approximateArcsinhStretchParameters(0.15)) // { stretchFactor: 5.656532158010995, blackPoint: 0 }
console.log(approximateArcsinhStretchParameters(0.1, 0.02, 0.9)) // { stretchFactor: 12.697700249709829, blackPoint: 0.02 }
```

### Automatic Background Extraction

`automaticBackgroundExtraction(image, options?)` models the smooth sky background of a normalized 0..1 `Image` (a gradient, light pollution or vignetting) and removes it. It is the composition of three steps that are also exported: `fitBackgroundSurface(image, options?)` fits the model without touching the pixels and returns a `BackgroundModel`, `evaluateBackgroundModel(model, image)` materializes it as a fresh image with the shape of `image` (the pixels of `image` are not read), and `applyBackground(image, background, options?)` removes it in place and returns the per-channel `{ min, max }` of the corrected values before clipping. The result of the orchestrator has the corrected `image` (the same object, modified, unless `correction` is `'none'`), the `background` image and one entry in `channels` per image channel with the coefficients, the accepted and rejected sample counts, the robust `residual` dispersion, the `samples` of the grid and the pre-clip `outputMin` and `outputMax`.

The fit samples a grid of `gridSize` boxes along the longer axis (2 to 128, 24 by default) with the median of each box of `boxSize` pixels (half a cell by default), discards the boxes whose dispersion is too high (`tolerance`), and fits a weighted surface to the others, rejecting iteratively the samples above the surface by `rejectionHigh` robust sigmas (2.5), those below by `rejectionLow` (4), for `rejectionIterations` rounds (2). The `model` is a Chebyshev `'polynomial'` of `degree` 1 to 6 (4 by default), good for smooth gradients and vignetting, or a smoothing `'thinPlateSpline'` (`smoothing` 0.1, 0 interpolates every sample) that follows irregular backgrounds at a higher cost. An RGB image is fitted per channel (`'perChannel'`, the default) or with one shared surface on the luminance (`colorMode: 'luminance'`). The correction is `'subtract'` (additive, the default), `'divide'` (multiplicative, with a guard near zero) or `'none'`, and the level `targetBackground` (0..1, the mean of the model by default) is restored afterwards. Out-of-range values are handled by `clipping`: `'truncate'` (the default), `'rescale'` or `'rescaleAsNeeded'`. An `Error` is thrown when a channel has fewer clean samples than the polynomial needs or when the `exclusionMask` does not have `width * height` entries; the box median does not model extended nebulosity, so an object that fills most of the frame is absorbed by the background unless it is excluded.

`backgroundExclusionMaskFromStars(width, height, stars, options?)` builds a `Uint8Array` mask (1 is excluded) with a disk around each detected star, of radius `max(minRadius, radiusScale * hfd)` pixels (4 and 1.5 by default), to pass as `exclusionMask`. `DEFAULT_BACKGROUND_EXTRACTION_OPTIONS` holds the defaults.

```ts
import { applyBackground, automaticBackgroundExtraction, backgroundExclusionMaskFromStars, DEFAULT_BACKGROUND_EXTRACTION_OPTIONS, evaluateBackgroundModel, fitBackgroundSurface } from 'nebulosa/src/imaging/processing/background'
import type { DetectedStar } from 'nebulosa/src/imaging/stars/detector'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 96x64 frame: a sky of 0.10, a linear gradient up to +0.20 along x and two Gaussian stars.
const width = 96
const height = 64
const stars = [
	{ x: 30, y: 20, hfd: 3, snr: 50, flux: 100 },
	{ x: 70, y: 44, hfd: 3, snr: 50, flux: 100 },
] satisfies DetectedStar[]
const frame = (): Image => {
	const raw = new Float64Array(width * height)
	for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) raw[i] = 0.1 + (0.2 * x) / (width - 1) + stars.reduce((sum, s) => sum + 0.5 * Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / 4), 0)
	return {
		header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: width, NAXIS2: height },
		metadata: { width, height, channels: 1, pixelCount: width * height, stride: width, strideInBytes: width * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
		raw,
	}
}

const round = (value: number) => Number(value.toFixed(4))
const row = (image: Image, y: number, xs: number[]) => xs.map((x) => round(image.raw[y * width + x]))

// The columns before the correction: the gradient is 0.10 at the left edge and 0.30 at the right.
console.log(row(frame(), 5, [0, 24, 48, 72, 95])) // [ 0.1, 0.1505, 0.2011, 0.2516, 0.3 ]

// The default correction subtracts the model and restores its mean level (about 0.2), so the sky becomes flat.
const result = automaticBackgroundExtraction(frame())
console.log(row(result.image, 5, [0, 24, 48, 72, 95])) // [ 0.2, 0.2, 0.2, 0.2, 0.2 ]
console.log(row(result.background, 5, [0, 24, 48, 72, 95])) // [ 0.1, 0.1505, 0.2011, 0.2516, 0.3 ] (the model follows the gradient)
console.log(result.channels.length, result.channels[0].acceptedSamples, result.channels[0].rejectedSamples, round(result.channels[0].residual)) // 1 325 59 0 (the residual of this noiseless frame is below 0.00005)
console.log(round(result.channels[0].outputMin!), round(result.channels[0].outputMax!), result.channels[0].samples.length, result.channels[0].samples.filter((s) => s.accepted).length) // 0.2 0.7 384 325 (outputMax is the star peak; 384 grid samples, 325 accepted)

// The star pixels stay above the sky (the star at (30, 20) peaks 0.5 above it).
console.log(round(result.image.raw[20 * width + 30] - result.image.raw[20 * width + 40])) // 0.5

// Fit, evaluate and apply as separate steps, with a fixed pedestal and a mask that keeps the stars out of the samples.
const mask = backgroundExclusionMaskFromStars(width, height, stars)
console.log(mask.reduce((sum, v) => sum + v, 0)) // 138
const image = frame()
const model = fitBackgroundSurface(image, { degree: 2, gridSize: 16, exclusionMask: mask })
console.log(model.type, model.colorMode, model.degree, model.channelCount, model.surfaces[0].coefficients.length) // polynomial perChannel 2 1 6 (a degree 2 surface has 6 coefficients)
const background = evaluateBackgroundModel(model, image)
const ranges = applyBackground(image, background, { correction: 'subtract', targetBackground: 0.1, clipping: 'truncate' })
console.log(
	row(image, 5, [0, 24, 48, 72, 95]),
	ranges.map((r) => [round(r.min), round(r.max)]),
) // [ 0.1, 0.1, 0.1, 0.1, 0.1 ] [ [ 0.1, 0.6 ] ]

// A multiplicative correction, a thin-plate spline and the 'none' correction, which leaves the image untouched.
const divided = automaticBackgroundExtraction(frame(), { correction: 'divide', targetBackground: 0.2 })
console.log(row(divided.image, 5, [0, 24, 48, 72, 95])) // [ 0.2, 0.2, 0.2, 0.2, 0.2 ]
const spline = automaticBackgroundExtraction(frame(), { model: 'thinPlateSpline', smoothing: 1, gridSize: 12 })
console.log(row(spline.image, 5, [0, 24, 48, 72, 95]), spline.channels[0].coefficients.length) // [ 0.2001, 0.2, 0.2, 0.2001, 0.2001 ] 87 (3 affine terms and 84 control points)
const original = frame()
const kept = automaticBackgroundExtraction(original, { correction: 'none' })
console.log(kept.image === original, kept.channels[0].outputMin, row(kept.image, 5, [0, 95])) // true undefined [ 0.1, 0.3 ]

console.log(DEFAULT_BACKGROUND_EXTRACTION_OPTIONS) // { gridSize: 24, boxSize: 0, model: 'polynomial', colorMode: 'perChannel', degree: 4, smoothing: 0.1, tolerance: 3, rejectionHigh: 2.5, rejectionLow: 4, rejectionIterations: 2, correction: 'subtract', clipping: 'truncate' }

// A mask of the wrong length is rejected.
try {
	fitBackgroundSurface(frame(), { exclusionMask: new Uint8Array(10) })
} catch (e) {
	console.log((e as Error).message) // exclusionMask length must be 6144 (width*height), got 10
}
```

### Backfocus Correction Estimates

### Background Estimate

`estimateBackground(image)` returns a robust `{ background, noise, snr }` of one frame, for a quick quality check that does not need star detection. The frame is split into a grid of at most 8 by 8 cells (fewer for a frame that is smaller than 8 pixels on a side), a regular lattice of at most `floor(4096 / cells)` pixels is read in each cell, and the `background` is the median of the cell medians, in the sample scale of the image. `noise` is the normalized median absolute deviation (scaled to a Gaussian standard deviation) of all the sampled pixels about the background, and `snr` is the median of the brightest cell minus the background, in units of that noise: 0 when the excess is not positive, and `Infinity` when it is positive and the noise is 0. At most 4096 pixels are examined, so the cost does not grow with the frame and the result is a deterministic approximation; a star smaller than the lattice step can be missed. A color image is read through its BT.709 luminance, a raw CFA mosaic is read as raw photosite values (the colors of the pattern are not separated, so a strongly colored mosaic widens the noise), non-finite samples are skipped, and an empty frame returns zeros. Because the background is a median of cells, a nebula or a gradient that covers most of the frame raises it.

```ts
import { estimateBackground } from 'nebulosa/src/imaging/analysis/background'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A deterministic generator of roughly Gaussian noise (the sum of four uniforms, standard deviation 0.01).
let seed = 12345
const noise = () => {
	let sum = 0
	for (let i = 0; i < 4; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		sum += seed / 4294967296
	}
	return ((sum - 2) / Math.sqrt(4 / 12)) * 0.01
}

const frame = (width: number, height: number, channels: 1 | 3, value: (x: number, y: number) => number): Image => {
	const raw = new Float32Array(width * height * channels)
	for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++, i++) raw[i] = value(x, y) + noise()
	return {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: channels === 1 ? 2 : 3, NAXIS1: width, NAXIS2: height },
		metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
		raw,
	}
}

const round = (value: number) => Number(value.toFixed(4))
const show = (image: Image) => {
	const { background, noise, snr } = estimateBackground(image)
	return [round(background), round(noise), round(snr)]
}

// A flat sky of 0.2 with a noise of about 0.01: the background and noise are recovered and no cell stands out much.
console.log(show(frame(400, 300, 1, () => 0.2))) // [ 0.1998, 0.0107, 0.463 ]

// A bright nebula in one corner makes the brightest cell stand out, while the background stays at the sky level.
console.log(show(frame(400, 300, 1, (x, y) => 0.2 + (x > 300 && y < 75 ? 0.3 : 0)))) // [ 0.1998, 0.0112, 26.9899 ]

// A gradient of 0.1 across the frame raises the noise, because the samples scatter about the median.
console.log(show(frame(400, 300, 1, (x) => 0.2 + (0.1 * x) / 399))) // [ 0.2487, 0.0368, 1.3086 ]

// An RGB frame goes through its luminance, a tiny frame is estimated from all its pixels and an empty one returns zeros.
console.log(show(frame(200, 150, 3, () => 0.2)), show(frame(4, 3, 1, () => 0.5))) // [ 0.2001, 0.0077, 0.4345 ] [ 0.5005, 0.0075, 2.3394 ]
console.log(estimateBackground({ ...frame(1, 1, 1, () => 0), metadata: { ...frame(1, 1, 1, () => 0).metadata, width: 0 } })) // { background: 0, noise: 0, snr: 0 }

// A perfectly flat frame has no noise: the excess is not positive, and a single hot cell with no noise gives an infinite ratio.
const flat = frame(80, 80, 1, () => 0.25)
flat.raw.fill(0.25)
console.log(estimateBackground(flat)) // { background: 0.25, noise: 0, snr: 0 }
flat.raw.fill(0.9, 0, 10 * 80)
console.log(estimateBackground(flat)) // { background: 0.25, noise: 0, snr: Infinity }
```

### Background Neutralization

`backgroundNeutralization(image, options?)` removes a color cast from the sky of an interleaved RGB image of normalized 0..1 samples, in place, and returns the same image. For each channel it takes the median of the samples that lie above `lowerLimit` and up to `upperLimit` (the reference range, 0..1; samples exactly at the lower limit, which are clipped blacks, are excluded, with a tiny tolerance of 1e-7 for Float32 and 1e-12 for Float64 buffers), and adds `target - median` to the whole channel, the additive form of the PixInsight tool, so the three channel medians land at the same level. A mono or other non-RGB image is returned unchanged. The shift moves values out of 0..1, and `mode` says what happens next: `'rescaleAsNeeded'` (the default) rescales the whole image affinely from its minimum and maximum to 0..1 only if some value left the range, `'rescale'` always does it, `'truncate'` clamps to 0..1 and the target of the shift is a median of 0 (the background goes to black), and `'targetBackground'` places the common median at `targetBackground` (0.05 by default) and then clamps. The limits are swapped when `lowerLimit` is above `upperLimit`, non-finite options fall back to the defaults, and a `TypeError` is thrown when a channel has no sample in the reference range. The reference range is a brightness range and not a region of the image, so the median is of the whole frame within that range; choose a narrow range around the sky level on an image with large bright areas. A scratch buffer of one 64-bit value per pixel is allocated for the medians.

```ts
import { backgroundNeutralization, DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS } from 'nebulosa/src/imaging/processing/neutralization'
import type { Image } from 'nebulosa/src/imaging/model/types'

// Five pixels over a sky with a magenta cast: the medians are (0.20, 0.10, 0.16), and one pixel is a bright star.
const pixels = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 3, NAXIS1: 5, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 5, height: 1, channels: 3, pixelCount: 5, stride: 15, strideInBytes: 120, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0.19, 0.09, 0.15, 0.2, 0.1, 0.16, 0.21, 0.11, 0.17, 0.2, 0.1, 0.16, 0.9, 0.7, 0.8]),
})

const round = (values: ArrayLike<number>) => Array.from(values, (value) => Number(value.toFixed(4)))

// The default: the medians go to 0 and the image is rescaled to the full 0..1 range because the values left it.
console.log(round(backgroundNeutralization(pixels()).raw)) // [ 0, 0, 0, 0.0141, 0.0141, 0.0141, 0.0282, 0.0282, 0.0282, 0.0141, 0.0141, 0.0141, 1, 0.8592, 0.9155 ]

// The background pinned at 0.05, with the other values clamped (the star is not rescaled).
console.log(round(backgroundNeutralization(pixels(), { mode: 'targetBackground', targetBackground: 0.05 }).raw)) // [ 0.04, 0.04, 0.04, 0.05, 0.05, 0.05, 0.06, 0.06, 0.06, 0.05, 0.05, 0.05, 0.75, 0.65, 0.69 ]

// Truncate: the medians go to 0, the negative values are clamped and nothing is rescaled.
console.log(round(backgroundNeutralization(pixels(), { mode: 'truncate' }).raw)) // [ 0, 0, 0, 0, 0, 0, 0.01, 0.01, 0.01, 0, 0, 0, 0.7, 0.6, 0.64 ]

// Rescale always maps the minimum and the maximum to 0 and 1.
console.log(round(backgroundNeutralization(pixels(), { mode: 'rescale' }).raw)) // [ 0, 0, 0, 0.0141, 0.0141, 0.0141, 0.0282, 0.0282, 0.0282, 0.0141, 0.0141, 0.0141, 1, 0.8592, 0.9155 ] (the same as the default here)

// A reference range around the sky excludes the star from the medians.
console.log(round(backgroundNeutralization(pixels(), { mode: 'targetBackground', lowerLimit: 0.05, upperLimit: 0.3, targetBackground: 0.1 }).raw)) // [ 0.09, 0.09, 0.09, 0.1, 0.1, 0.1, 0.11, 0.11, 0.11, 0.1, 0.1, 0.1, 0.8, 0.7, 0.74 ]

// The defaults, and a mono image that is returned untouched.
console.log(DEFAULT_BACKGROUND_NEUTRALIZATION_OPTIONS) // { lowerLimit: 0, upperLimit: 1, targetBackground: 0.05, mode: 'rescaleAsNeeded' }
const image = pixels()
const mono: Image = { ...image, metadata: { ...image.metadata, channels: 1, stride: 5 }, raw: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]) }
console.log(backgroundNeutralization(mono) === mono, round(mono.raw)) // true [ 0.1, 0.2, 0.3, 0.4, 0.5 ]

// No sample of a channel in the reference range.
try {
	backgroundNeutralization(pixels(), { lowerLimit: 0.95, upperLimit: 1 })
} catch (e) {
	console.log((e as Error).message) // background neutralization requires at least one significant RED sample in the reference area
}
```

### Bahtinov Chromatic Comparison

### Bahtinov Focus Analysis

### Bahtinov Overlay Geometry

### Bounded Robust Sampling

`RobustReservoir` is the fixed-memory sampler that the analysis modules use to take the median, the median absolute deviation and a robust standard deviation of an image of any size. `new RobustReservoir(populationCapacity)` allocates room for `min(populationCapacity, ROBUST_SAMPLE_CAPACITY)` values (65536, at least 1) and throws a `RangeError` when the capacity is not a non-negative safe integer. `push(value)` considers one value and ignores non-finite ones: the first values are stored exactly, and once the reservoir is full each new value replaces a random retained one with the probability of a uniform reservoir, drawn from a deterministic xorshift generator that `reset()` restores, so the same sequence always gives the same sample. `seenCount` counts every finite value considered, `retainedCount` those that are kept and `approximate` tells whether the retained values are a sample (more values seen than retained). `median()` returns the median of the retained values and `mad(normalized?, scratch?)` their median absolute deviation (`normalized` multiplies it by the Gaussian factor 1.4826), `madAround(center, normalized?, scratch?)` computes it around a median that is already known, and `robustStandardDeviation()` is the population standard deviation after the samples more than five normalized MADs from the median are dropped. All return `NaN` when nothing has been pushed. The values are reordered by the selection of the median, which is not a problem for the statistics but means the reservoir does not preserve the order of arrival. The scratch passed to `mad` or `madAround` must hold every retained value (a `RangeError` otherwise). Once the reservoir is full the statistics are estimates from at most 65536 values, so they differ slightly from the exact ones.

```ts
import { ROBUST_SAMPLE_CAPACITY, RobustReservoir } from 'nebulosa/src/imaging/analysis/robust'

// A small population is kept exactly.
const small = new RobustReservoir(8)
for (const value of [5, 1, 4, 2, 3, Number.NaN, Number.POSITIVE_INFINITY]) small.push(value)
console.log(small.seenCount, small.retainedCount, small.approximate, small.median()) // 5 5 false 3 (the NaN and the Infinity are ignored)
console.log(small.mad(), small.mad(true), small.madAround(3), small.robustStandardDeviation()) // 1 1.482602218505602 1 1.4142135623730951

// Outliers: the median and the MAD ignore them, and the robust standard deviation drops what is beyond five MADs.
const outliers = new RobustReservoir(16)
for (const value of [10, 11, 9, 10, 12, 8, 10, 11, 9, 1000]) outliers.push(value)
console.log(outliers.median(), outliers.mad(true), outliers.robustStandardDeviation()) // 10 1.482602218505602 1.154700538379252 (the 1000 is dropped by the standard deviation)

// A caller-owned scratch buffer avoids the allocation of the MAD.
const scratch = new Float64Array(16)
console.log(outliers.mad(false, scratch)) // 1
try {
	outliers.mad(false, new Float64Array(2))
} catch (e) {
	console.log((e as Error).message) // robust MAD scratch must hold every retained sample
}

// A large population is sampled: the capacity is bounded, the result is approximate and reproducible.
const large = new RobustReservoir(1_000_000)
for (let i = 0; i < 300_000; i++) large.push(i % 1000)
console.log(ROBUST_SAMPLE_CAPACITY, large.seenCount, large.retainedCount, large.approximate, large.median()) // 65536 300000 65536 true 500

large.reset()
console.log(large.seenCount, large.retainedCount, large.median()) // 0 0 NaN
for (let i = 0; i < 300_000; i++) large.push(i % 1000)
console.log(large.median()) // 500 (the same after the reset)

// The capacity of the storage and the invalid arguments.
console.log(new RobustReservoir(0).retainedCount, new RobustReservoir(10).approximate) // 0 false
try {
	new RobustReservoir(-1)
} catch (e) {
	console.log((e as Error).message) // robust reservoir population capacity must be a non-negative safe integer
}
```

### Celestial Streak Tracks

### Collimation Sequence Summary

### Cosmetic Correction

`cosmeticCorrection(image, options?)` finds isolated sensor defects (hot, cold or dead pixels, and known bad pixels, columns and rows) in a normalized 0..1 `Image` and replaces each one with the median of its neighbourhood, in place. It returns `{ image, corrected, hot, cold, dark, defect }`: the same image and the number of samples replaced in total and by each detector (a sample counts for the first detector that flags it, in the order defect, dark, hot, cold, so the four counts add up to `corrected`). Every channel is processed on its own, and the repair value is always taken from the original plane, so one repair does not feed another.

There are three detectors. The automatic one flags a pixel that is more than `hotSigma` (3 by default) noise units above, or `coldSigma` (3) below, the median of the window of radius `windowRadius` (1, a 3x3 window), where the noise is the normalized MAD of the channel (its standard deviation when the MAD is 0), and only if it is isolated: when an immediate neighbour is itself elevated, the pixel is considered part of a real source and is kept, which protects the peak of a star whose profile spills into the adjacent pixels. A star confined to one pixel cannot be told from a hot pixel in a single frame; pass `protect`, a mask of `width * height` entries whose nonzero pixels are never touched by the automatic detector (an `Error` is thrown for a mask of another length). A value of 0 for `hotSigma` or `coldSigma` turns that side off. The master-dark detector (`masterDark`, which must have the same width, height and channels, otherwise it is ignored) flags the pixels of the dark that are above its median by `darkHotSigma` (5) noise units, and the `defects` map (`pixels` as `[x, y]` pairs, `columns` and `rows`, 0-based, out-of-range entries ignored) is repaired unconditionally; both ignore the isolation test and the protection mask. `amount` (0..1, 1 by default) blends the repair with the original value, and 0 changes nothing.

On a CFA mosaic (a single channel with `metadata.bayer`) the neighbourhood and the statistics are computed per color phase, at a stride of 2 pixels, so that the alternating colors of a uniform scene are not taken for defects. The method repairs single pixels and thin lines, not clusters, and a window radius larger than the defect cluster is needed to fill a cluster; the repair is a median, so it does not recover the detail that was under the pixel. `DEFAULT_COSMETIC_CORRECTION_OPTIONS` holds the numeric defaults.

```ts
import { cosmeticCorrection, DEFAULT_COSMETIC_CORRECTION_OPTIONS } from 'nebulosa/src/imaging/processing/cosmetic'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A deterministic noise (sum of four uniforms, standard deviation 0.01) over a sky of 0.2.
let seed = 777
const noise = () => {
	let sum = 0
	for (let i = 0; i < 4; i++) {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
		sum += seed / 4294967296
	}
	return ((sum - 2) / Math.sqrt(4 / 12)) * 0.01
}

const size = 32
const make = (sky: number, extra: (x: number, y: number) => number = () => 0): Image => {
	const raw = new Float32Array(size * size)
	for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++, i++) raw[i] = sky + noise() + extra(x, y)
	return {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: size, NAXIS2: size },
		metadata: { width: size, height: size, channels: 1, pixelCount: size * size, stride: size, strideInBytes: size * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
		raw,
	}
}

// A star with a 2-pixel sigma at (25, 25) over the sky; the defects are added by hand afterwards.
const star = (x: number, y: number) => 0.5 * Math.exp(-((x - 25) ** 2 + (y - 25) ** 2) / 8)
const frame = () => {
	seed = 777
	const image = make(0.2, star)
	image.raw[10 * size + 10] = 0.9 // a hot pixel at (10, 10)
	image.raw[12 * size + 20] = 0 // a dead pixel at (20, 12)
	return image
}
const at = (image: Image, x: number, y: number) => Number(image.raw[y * size + x].toFixed(4))

// The defaults repair the hot and the dead pixel with the median of their 3x3 neighbourhood and leave the star alone.
const image = frame()
const peak = at(image, 25, 25)
const result = cosmeticCorrection(image)
console.log(result.corrected, result.hot, result.cold, result.dark, result.defect) // 2 1 1 0 0 (a hot and a cold pixel)
console.log(at(image, 10, 10), at(image, 20, 12), at(image, 25, 25) === peak, result.image === image) // 0.2095 0.2022 true true (the repaired values are the neighbourhood medians)

// Only the hot side, and a half-strength repair that blends the median with the original value.
console.log(cosmeticCorrection(frame(), { coldSigma: 0 }).cold) // 0
const half = frame()
cosmeticCorrection(half, { amount: 0.5 })
console.log(at(half, 10, 10)) // 0.5547 (halfway between the original 0.9 and the median)

// A known bad column and bad pixels are repaired unconditionally, even where there is no outlier to detect.
const mapped = frame()
mapped.raw.fill(0.7, 5 * size + 3, 5 * size + 4)
const withMap = cosmeticCorrection(mapped, {
	hotSigma: 0,
	coldSigma: 0,
	defects: {
		pixels: [
			[3, 5],
			[999, 0],
		],
		columns: [8],
		rows: [],
	},
})
console.log(withMap.corrected, withMap.defect, at(mapped, 3, 5)) // 33 33 0.2031 (the 32 pixels of the column and the pixel; the out-of-range entry is ignored)

// A master dark with a fixed hot pixel at (3, 3), which is only 0.05 above the sky in the light frame, with the automatic detector off.
seed = 4242
const masterDark = make(0.05, (x, y) => (x === 3 && y === 3 ? 0.4 : 0))
const dark = frame()
dark.raw[3 * size + 3] += 0.05
const withDark = cosmeticCorrection(dark, { hotSigma: 0, coldSigma: 0, masterDark })
console.log(withDark.dark, withDark.corrected, at(dark, 3, 3)) // 1 1 0.1986

// A mask protects a one-pixel star from the automatic detector.
const protect = new Uint8Array(size * size)
protect[10 * size + 10] = 1
const protectedResult = cosmeticCorrection(frame(), { protect })
console.log(protectedResult.hot, protectedResult.cold) // 0 1 (the hot pixel is protected, the dead one is not)

// An amount of 0 changes nothing, and so do thresholds of 0 with no other detector.
console.log(cosmeticCorrection(frame(), { amount: 0 }).corrected, cosmeticCorrection(frame(), { hotSigma: 0, coldSigma: 0 }).corrected) // 0 0
console.log(DEFAULT_COSMETIC_CORRECTION_OPTIONS) // { hotSigma: 3, coldSigma: 3, windowRadius: 1, amount: 1, darkHotSigma: 5 }

try {
	cosmeticCorrection(frame(), { protect: new Uint8Array(10) })
} catch (e) {
	console.log((e as Error).message) // protect mask length must be 1024 (width*height), got 10
}
```

### Critical Focus Planning Estimate

### Critical Focus Zone

### Curves

`curvesTransformation(image, options)` applies tone curves to a normalized `Image` in place, as the Curves tool of PixInsight does, and returns the same image. Each entry of `options.curves` is a `CurvesTransformationCurve`: the `channel` it acts on (`'RED'`, `'GREEN'` or `'BLUE'` for a single channel of an RGB image, or a luminance-style `'GRAY'`, `'BT709'`, `'RMY'`, `'Y'` or explicit weights that sum to 1, for the whole pixel), the control points `x` (strictly increasing after clamping to 0..1) and `y` (the output at each one), which are clamped to 0..1, and the end points (0, 0) and (1, 1) are added when they are missing. The curves are applied in order, an `undefined` entry or an identity curve is skipped, and a curve for a color channel is ignored in a mono image (a luminance or `'GRAY'` curve is applied to its samples). The curve of a luminance channel preserves the color ratios of the pixel: it is evaluated on the weighted luminance, the pixel is scaled by the ratio when the curve darkens it and blended toward white when it brightens it, so the requested luminance is reached; a black pixel becomes gray.

The curve is evaluated through a lookup table of `2^bits` entries (`bits` is clamped to 8..24 and the table is capped at 16 bits, 16 by default) with linear interpolation between the entries, built with one of four splines from `interpolation`: `'cubicHermite'` (the default, monotone), `'akima'`, `'catmullRom'` and `'naturalCubic'`. The table is clipped to 0..1 and made monotone in the direction of the control points, so a spline overshoot cannot invert the tones of a monotone curve. `DEFAULT_CURVES_TRANSFORMATION_OPTIONS` is the no-op configuration. An unknown interpolation, an unknown channel, weights that do not sum to 1, arrays of different length, non-finite control points or x values that are not increasing throw before the image is changed.

```ts
import { curvesTransformation, DEFAULT_CURVES_TRANSFORMATION_OPTIONS } from 'nebulosa/src/imaging/processing/curves'
import type { Image } from 'nebulosa/src/imaging/model/types'

const ramp = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: 5, NAXIS2: 1 },
	metadata: { width: 5, height: 1, channels: 1, pixelCount: 5, stride: 5, strideInBytes: 40, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0, 0.25, 0.5, 0.75, 1]),
})

const pixel = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 3, NAXIS1: 1, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 1, height: 1, channels: 3, pixelCount: 1, stride: 3, strideInBytes: 24, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0.6, 0.3, 0.1]),
})

const round = (values: ArrayLike<number>) => Array.from(values, (value) => Number(value.toFixed(4)))

// A curve through (0.5, 0.75) lifts the midtones: the end points are added, and the output is smooth and monotone.
const lifted = curvesTransformation(ramp(), { curves: [{ channel: 'GRAY', x: [0.5], y: [0.75] }] })
console.log(round(lifted.raw)) // [ 0, 0.4531, 0.75, 0.9219, 1 ]

// The splines differ between the control points: eleven samples from 0 to 1 and three control points.
for (const interpolation of ['cubicHermite', 'akima', 'catmullRom', 'naturalCubic'] as const) {
	const steps = ramp()
	const image: Image = { ...steps, metadata: { ...steps.metadata, width: 11, pixelCount: 11, stride: 11 }, raw: Float64Array.from({ length: 11 }, (_, i) => i / 10) }
	console.log(interpolation, round(curvesTransformation(image, { interpolation, curves: [{ channel: 'GRAY', x: [0.2, 0.5], y: [0.1, 0.8] }] }).raw).join(' ')) // cubicHermite 0 0.0303 0.1 0.3004 0.6038 0.8 0.8672 0.9227 0.9644 0.9908 1 (the four splines agree at the control points and differ between them, and the table is clipped to 0..1)
}

// An S-curve with several points and a lower LUT depth.
console.log(round(curvesTransformation(ramp(), { bits: 8, curves: [{ channel: 'GRAY', x: [0.25, 0.5, 0.75], y: [0.15, 0.5, 0.85] }] }).raw).join(' ')) // [ 0, 0.15, 0.5, 0.85, 1 ]

// A curve of one color channel changes only that channel, and several curves are applied in order.
console.log(
	round(
		curvesTransformation(pixel(), {
			curves: [
				{ channel: 'RED', x: [0.6], y: [0.3] },
				{ channel: 'BLUE', x: [0.1], y: [0.5] },
			],
		}).raw,
	).join(' '),
) // [ 0.3, 0.3, 0.5 ]

// A luminance curve keeps the color ratios while it darkens, and blends toward white while it brightens.
const darker = curvesTransformation(pixel(), { curves: [{ channel: 'BT709', x: [0.3], y: [0.15] }] })
console.log(round(darker.raw), round(darker.raw.map((value, i) => value / pixel().raw[i]))) // [ 0.318, 0.159, 0.053 ] [ 0.53, 0.53, 0.53 ] (the pixel is scaled by the same ratio)
console.log(round(curvesTransformation(pixel(), { curves: [{ channel: 'BT709', x: [0.3], y: [0.6] }] }).raw).join(' ')) // 0.7827 0.6198 0.5112

// The identity curves, the empty list and the default options leave the image untouched.
console.log(round(curvesTransformation(ramp(), { curves: [{ channel: 'GRAY', x: [0, 1], y: [0, 1] }, undefined] }).raw), round(curvesTransformation(ramp(), DEFAULT_CURVES_TRANSFORMATION_OPTIONS).raw), round(curvesTransformation(ramp()).raw)) // [ 0, 0.25, 0.5, 0.75, 1 ] [ 0, 0.25, 0.5, 0.75, 1 ] [ 0, 0.25, 0.5, 0.75, 1 ]

// The errors: an x that is not increasing, arrays of different lengths, and an unknown channel.
for (const curve of [
	{ channel: 'GRAY', x: [0.5, 0.4], y: [0.5, 0.6] },
	{ channel: 'GRAY', x: [0.5], y: [0.5, 0.6] },
	{ channel: 'LUMA', x: [0.5], y: [0.5] },
]) {
	try {
		curvesTransformation(ramp(), { curves: [curve as never] })
	} catch (e) {
		console.log((e as Error).message) // curves transformation x coordinates must be strictly increasing after clamping, curves transformation x and y arrays must have the same length and unsupported curves transformation channel: LUMA
	}
}
```

### Dark Current

`measureSensorDarkCurrent(darks, conversionGain, options?)` estimates the dark current of a sensor, in electrons per pixel per second, from dark frames taken at several exposure times. `darks` is a list of `SensorFrameSet` (`frames` with at least two `DigitalImage` taken under identical conditions, the `exposure` in seconds, and optionally `temperature` or `operatingPoint.temperature` in degrees Celsius); `conversionGain` is the conversion gain in electrons per DN (the `conversion` of the photon transfer fit, see Photon Transfer and Read Noise). The frames must be undebayered single-channel digital-number images (`sampleScale: 'digital'`, as read with that option in Scientific Image Loading and Export), all with the same geometry. Consecutive frames of a set are paired (1 with 2, 3 with 4, an odd last frame is not used), each pair gives a mean and a temporal variance, the pairs with the same exposure are aggregated, and at least three distinct exposures are required (a `RangeError` otherwise, as for a non-finite or non-positive gain, an exposure that is negative or not finite, or frames of different shapes).

Two independent weighted regressions against the exposure, with an unknown intercept (the bias level and the read noise), give the result. `mean` is the slope of the mean signal times the gain, clamped to 0 (a negative slope is noise). `variance` is the slope of the temporal variance times the gain squared, because the shot noise of the accumulated dark electrons adds a variance equal to their number, and is `undefined` when that slope is not positive; the two estimates should agree for a clean sensor, and a disagreement suggests a bad gain or a non-Poisson contribution. `meanFit` and `varianceFit` report each regression (`r`, `r2`, `rss`, `rmsd`, `pointCount`, `weighted` and the standard errors of the slope and the intercept), `temperature` is the mean of the recorded temperatures when there are any, and `ampGlow` is a map of the slope per tile of `options.tile` (64 by 64 output pixels by default): `current` per tile, its `median`, `maximum`, `excess` (maximum minus median) and `ratio` (maximum over median when the median is positive), which exposes localized amplifier glow without allocating a full-resolution map. The other `options` are those of paired measurements: an inclusive-exclusive `area`, the `plane` of a CFA mosaic (`'red'`, `'green1'`, `'green2'` or `'blue'`, required for a mosaic, together with an integer `cfaOffset` for the tile analysis; `'mono'` otherwise), a known `digitalClip` in DN and a `mask` of `width * height` bytes whose nonzero entries are skipped. The model is linear in the exposure, so it does not hold at an exposure where the pixels clip or the dark signal is not linear, and the regression on the variance needs frames whose noise is not dominated by quantization.

```ts
import { measureSensorDarkCurrent } from 'nebulosa/src/imaging/analysis/sensor/dark'
import type { SensorFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

// A 4x4 digital image, optionally a RGGB mosaic.
const digital = (raw: Float64Array, bayer?: 'RGGB'): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 4, BAYERPAT: bayer },
	raw,
	metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// A pair with an exact mean and temporal variance (DN and DN squared): the frames differ by +-sqrt(2 variance) / 2 about the mean.
const pair = (mean: number, variance: number, bayer?: 'RGGB'): [DigitalImage, DigitalImage] => {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(16)
	const second = new Float64Array(16)
	for (let i = 0; i < 16; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}
	return [digital(first, bayer), digital(second, bayer)]
}

// A dark current of 5 DN/s with a conversion gain of 2 e-/DN is 10 e-/pixel/s from the mean slope;
// the variance grows by 2.5 DN^2/s, which times the gain squared (4) is also 10 e-/pixel/s.
const darks: SensorFrameSet[] = [0, 10, 20, 40, 80, 120].map((exposure) => ({ frames: pair(100 + 5 * exposure, 4 + 2.5 * exposure), exposure, temperature: -10 }))
const result = measureSensorDarkCurrent(darks, 2, { tile: { width: 2, height: 2 } })
console.log(result.mean, result.variance, result.temperature) // 10 9.99999999999994 -10
console.log(result.meanFit.r2, result.meanFit.pointCount, result.meanFit.weighted, result.varianceFit?.r2) // 1 6 true 1
console.log(result.ampGlow?.columns, result.ampGlow?.rows, result.ampGlow?.median, result.ampGlow?.maximum, result.ampGlow?.excess, result.ampGlow?.ratio) // 2 2 10 10 0 1

// A constant mean gives no dark current, and the variance slope is then not positive.
const constant: SensorFrameSet[] = [0, 10, 20].map((exposure) => ({ frames: pair(100, 4), exposure }))
const flat = measureSensorDarkCurrent(constant, 2)
console.log(flat.mean, flat.variance, flat.varianceFit, flat.temperature) // 0 undefined undefined undefined

// Localized amp glow: the upper right quadrant warms four times faster than the rest, and the tiles show it.
const glow: SensorFrameSet[] = [0, 10, 20, 40].map((exposure) => {
	const frames = pair(0, 4)
	for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) for (const frame of frames) frame.raw[y * 4 + x] += 100 + (x >= 2 && y < 2 ? 20 : 5) * exposure
	return { frames, exposure }
})
const glowing = measureSensorDarkCurrent(glow, 2, { tile: { width: 2, height: 2 } })
console.log(Array.from(glowing.ampGlow!.current), glowing.ampGlow!.median, glowing.ampGlow!.ratio) // [ 10, 40, 10, 10 ] 10 4

// A region of interest and a mask restrict the samples (the frames are uniform, so the result does not change), and a mosaic needs its plane.
const masked = new Uint8Array(16)
masked[5] = 1
console.log(measureSensorDarkCurrent(darks, 2, { area: { left: 0, top: 0, right: 4, bottom: 2 }, mask: masked, tile: { width: 4, height: 2 } }).mean) // 10
const mosaics: SensorFrameSet[] = [0, 10, 20, 40].map((exposure) => ({ frames: pair(100 + 3 * exposure, 4 + exposure, 'RGGB'), exposure }))
console.log(measureSensorDarkCurrent(mosaics, 2, { plane: 'green1', cfaOffset: [0, 0], tile: { width: 4, height: 4 } }).mean) // 6

// Errors: fewer than three exposures, and a CFA mosaic without a plane.
for (const run of [() => measureSensorDarkCurrent(darks.slice(0, 2), 2), () => measureSensorDarkCurrent(mosaics, 2), () => measureSensorDarkCurrent(darks, 0)]) {
	try {
		run()
	} catch (e) {
		console.log((e as Error).message) // dark-current regression requires at least three distinct exposure times, then a CFA image requires an explicit color sensor plane, then dark-current conversion gain must be finite and positive
	}
}
```

### Debayering

`debayer(image, pattern?)` reconstructs a three-channel RGB image from a single-channel CFA mosaic (the raw output of a one-shot color sensor), and `bayer(image, pattern)` does the opposite, sampling one color per pixel from an RGB image. Both allocate fresh buffers, keep the sample type (Float32 or Float64) and do not change their input. The patterns are the eight `CfaPattern` values (`'RGGB'`, `'BGGR'`, `'GBRG'`, `'GRBG'`, `'GRGB'`, `'GBGR'`, `'RGBG'` and `'BGRG'`), read as the colors of the 2x2 block at the origin of the buffer, row by row; the origin already includes any region-of-interest phase shift. `debayer` takes the pattern from `image.metadata.bayer` when it is omitted, returns `undefined` for an image that is not mono, has no pattern or is smaller than 2x2, and fills each missing color of a pixel with the average of the nearest samples of that color in its 3x3 neighbourhood (bilinear interpolation), using the available neighbours at the borders. The pixel that already has a sample of a color keeps it. This is a plain bilinear interpolation: no edge-directed or frequency-domain algorithm is applied, so sharp color edges show zippering. The result has `bayer: undefined` and a header without `BAYERPAT`; `bayer` returns `undefined` for an image that is not RGB and sets the pattern in the metadata.

```ts
import { bayer, debayer } from 'nebulosa/src/imaging/processing/debayer'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 4x4 uniform orange frame (R 0.8, G 0.4, B 0.2) sampled with RGGB.
const rgb: Image = {
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 3, NAXIS1: 4, NAXIS2: 4, NAXIS3: 3 },
	metadata: { width: 4, height: 4, channels: 3, pixelCount: 16, stride: 12, strideInBytes: 48, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
	raw: Float32Array.from({ length: 48 }, (_, i) => [0.8, 0.4, 0.2][i % 3]),
}

const mosaic = bayer(rgb, 'RGGB')!
console.log(mosaic.metadata.channels, mosaic.metadata.bayer, mosaic.header.BAYERPAT, mosaic.raw) // 1 RGGB RGGB Float32Array(16) [ 0.8, 0.4, 0.8, 0.4, 0.4, 0.2, 0.4, 0.2, 0.8, 0.4, 0.8, 0.4, 0.4, 0.2, 0.4, 0.2 ] (32-bit floats: 0.8 is stored as 0.800000011920929)

// Debayering restores a uniform image exactly (the bilinear average of equal samples).
const restored = debayer(mosaic)!
console.log(restored.metadata.channels, restored.metadata.bayer, restored.header.BAYERPAT, restored.raw.slice(0, 6), restored.raw.length) // 3 undefined undefined Float32Array(6) [ 0.8, 0.4, 0.2, 0.8, 0.4, 0.2 ] 48 (the same 32-bit rounding)

// A pattern passed explicitly overrides the metadata: with the wrong phase the colors are swapped.
console.log(debayer(mosaic, 'BGGR')!.raw.slice(0, 3)) // Float32Array(3) [ 0.2, 0.4, 0.8 ]

// A horizontal gradient shows the interpolation: the missing red and green of the blue pixel at (1, 1) are averages of its neighbours.
const gradient: Image = {
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: 4, NAXIS2: 4 },
	metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, stride: 4, strideInBytes: 16, pixelSizeInBytes: 4, bitpix: -32, bayer: 'RGGB' },
	raw: Float32Array.from({ length: 16 }, (_, i) => (i % 4) / 3),
}
const pixel = debayer(gradient)!.raw.slice((1 * 4 + 1) * 3, (1 * 4 + 1) * 3 + 3)
console.log(Array.from(pixel, (value) => Number(value.toFixed(4)))) // [ 0.3333, 0.3333, 0.3333 ]

// The unsupported inputs return undefined.
console.log(debayer(rgb), debayer({ ...gradient, metadata: { ...gradient.metadata, bayer: undefined } }), bayer(gradient, 'RGGB')) // undefined undefined undefined
```

### Defocused Annular Geometry Analysis

### Diffraction and Seeing Sampling

### Display Stretch Parameter Estimation

### Drizzle Integration

### Elliptical Moffat Fitting

### Eyepiece Magnification and Exit Pupil

### FFT Image Filter

`fft(image, workspace, filterType, cutoff, weight)` filters a normalized `Image` in place with a centered radial Butterworth mask in the frequency domain (`'lowPass'` keeps the large structures and blurs the noise, `'highPass'` keeps the small ones) and returns the same image; every channel is filtered on its own. The image is padded with its border pixels to the next power of two in each axis (so a star near an edge is not duplicated by a mirror) and transformed with a radix-2 FFT, and non-finite samples are read as 0. `cutoff` is the normalized radius of the −3 dB point of the second-order Butterworth amplitude response, where 0 is the center (zero frequency) and 1 is the Nyquist frequency of each axis (the radius is scaled by axis, so the mask is circular in that normalized frequency even on a rectangular grid); it defaults to 1 for `'lowPass'` (no change) and 0 for `'highPass'` (no change), a cutoff of 0 keeps only the mean in a low-pass and everything but the mean in a high-pass, and a value outside 0..1 is clamped. `weight`, from 0 to 1 (clamped, 1 by default), blends the original and the filtered image, and 0 returns the image untouched. The low-pass result is stretched back to the minimum and maximum of the input channel (a "range restoration" in the style of MaxIm DL), unless the filtered range is less than 1% of the input range; the high-pass result is not restored, so it has the scale of the filtered signal: the mask removes the zero frequency, the mean of the output is close to 0 (the pixels are positive and negative) and nothing is clipped.

`FFTWorkspace(width, height)` holds the reusable buffers of the transform for an image up to that size: `width` and `height` are rounded up to powers of two (read them back from the instance) and the same workspace serves any image that fits, with a cached radial mask for the last filter type and cutoff (`mask(filterType, cutoff)`). Create one and reuse it for a batch of frames; a workspace smaller than the image makes `fft` throw an `Error`. The transform allocates nothing per call besides what the workspace owns, and its cost grows as N log N with the padded pixel count.

```ts
import { fft, FFTWorkspace } from 'nebulosa/src/imaging/processing/fft'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 30x20 gray frame with a smooth horizontal gradient plus a pseudo-random pattern (fixed seed, so the numbers repeat).
const width = 30
const height = 20
let seed = 12345
const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 0.2

const make = (): Image => {
	const raw = new Float64Array(width * height)
	seed = 12345
	for (let y = 0, i = 0; y < height; y++) for (let x = 0; x < width; x++, i++) raw[i] = 0.3 + (0.4 * x) / width + random()
	return {
		header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: width, NAXIS2: height },
		metadata: { width, height, channels: 1, pixelCount: width * height, stride: width, strideInBytes: width * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
		raw,
	}
}

// The roughness: the RMS difference between horizontally adjacent pixels, which the noise dominates.
const roughness = (image: Image) => {
	let sum = 0
	let n = 0
	for (let y = 0; y < height; y++) for (let x = 1; x < width; x++, n++) sum += (image.raw[y * width + x] - image.raw[y * width + x - 1]) ** 2
	return Math.sqrt(sum / n)
}

// The workspace pads 30x20 to 32x32 and is reused below.
const workspace = new FFTWorkspace(width, height)
console.log(workspace.width, workspace.height) // 32 32

const original = make()
console.log(roughness(original).toFixed(4)) // 0.0860

// A low-pass with a small cutoff removes the noise but keeps the gradient and the range of the input.
const low = fft(make(), workspace, 'lowPass', 0.15)
console.log(roughness(low).toFixed(4), Math.min(...low.raw).toFixed(4), Math.max(...low.raw).toFixed(4), Math.min(...original.raw).toFixed(4), Math.max(...original.raw).toFixed(4)) // 0.0317 0.2041 0.7764 0.2041 0.7764

// A high-pass keeps the noise and removes the gradient and the mean, so the result has a mean close to 0.
const high = fft(make(), workspace, 'highPass', 0.5)
console.log(roughness(high).toFixed(4), (high.raw.reduce((sum, value) => sum + value, 0) / high.raw.length).toFixed(4)) // 0.0811 -0.0046

// Weight: half of the filtered image blended with the original; weight 0 and the default cutoffs change nothing.
const half = fft(make(), workspace, 'lowPass', 0.15, 0.5)
console.log(
	roughness(half).toFixed(4),
	fft(make(), workspace, 'lowPass', 0.15, 0).raw.every((value, i) => value === original.raw[i]),
	fft(make(), workspace).raw.every((value, i) => Math.abs(value - original.raw[i]) < 1e-9),
) // 0.0625 true true

// A cutoff of 0 in a low-pass keeps only the mean (of the padded image, which repeats the border pixels), so the result is flat.
const mean = original.raw.reduce((sum, value) => sum + value, 0) / original.raw.length
const flat = fft(make(), workspace, 'lowPass', 0)
console.log(roughness(flat) < 1e-9, Math.abs(flat.raw[0] - mean) < 0.05) // true true

// An image larger than the workspace.
try {
	fft({ ...original, metadata: { ...original.metadata, width: 40, height: 20 } }, workspace)
} catch (e) {
	console.log((e as Error).message) // FFT workspace 32x32 is smaller than image 40x20
}
```

### Flat Exposure Estimate

### Flat Sequence Stability

### Flat-Frame Quality

### Focus Curve Fitting

### Focus Field Curvature

### Focus Surface Analysis

### Frame Saturation

`analyzeSaturation(image, options?)` counts the saturated pixels of a frame without modifying it. A pixel is saturated when any of its channels is at or above `options.level` (1 by default, the top of the normalized scale; for a camera whose full well is reached below the digital maximum, pass the clipping level in the same scale as the samples). The result has the `saturatedPixels`, the `fraction` of the frame (0 for an empty one), a row-major `mask` of `width * height` bytes where 1 marks a saturated pixel, and `saturatedStars`, the number of positions in `options.stars` (objects with `x` and `y` centroids in pixels, origin at the top left) whose nearest pixel is saturated; a star outside the frame is not counted. The star test examines only that one pixel, not the flux of the star, so a star that is saturated in a pixel beside its centroid is not counted. A raw CFA mosaic is analyzed as it is, photosite by photosite, so a saturated pixel of one color is a pixel of the mask; an image that is already stretched will have its own clipping.

```ts
import { analyzeSaturation } from 'nebulosa/src/imaging/analysis/saturation'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 6x4 mono frame with a saturated 2x2 core at (2..3, 1..2) and one pixel at 0.97.
const frame = (): Image => {
	const raw = new Float32Array(24).fill(0.2)
	for (const [x, y] of [
		[2, 1],
		[3, 1],
		[2, 2],
		[3, 2],
	])
		raw[y * 6 + x] = 1
	raw[0] = 0.97
	return {
		header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: 6, NAXIS2: 4 },
		metadata: { width: 6, height: 4, channels: 1, pixelCount: 24, stride: 6, strideInBytes: 24, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
		raw,
	}
}

const result = analyzeSaturation(frame())
console.log(result.saturatedPixels, result.fraction, result.saturatedStars) // 4 0.16666666666666666 0
console.log(result.mask) // Uint8Array(24) [ 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0 ]

// A lower level takes the 0.97 pixel too, and the stars are tested at their nearest pixel.
const stars = [
	{ x: 2.4, y: 1.6 },
	{ x: 0, y: 0 },
	{ x: 5, y: 3 },
	{ x: -1, y: 0 },
	{ x: 10, y: 10 },
]
console.log(analyzeSaturation(frame(), { stars }).saturatedStars, analyzeSaturation(frame(), { level: 0.95, stars }).saturatedStars) // 1 2 (only the star at (2.4, 1.6) at the default level, and the one at (0, 0) too at 0.95)
console.log(analyzeSaturation(frame(), { level: 0.95 }).saturatedPixels) // 5

// An RGB pixel is saturated when any channel reaches the level.
const rgb: Image = {
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 3, NAXIS1: 2, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 2, height: 1, channels: 3, pixelCount: 2, stride: 6, strideInBytes: 24, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
	raw: new Float32Array([0.5, 1, 0.5, 0.5, 0.5, 0.5]),
}
console.log(analyzeSaturation(rgb).saturatedPixels, analyzeSaturation(rgb).mask) // 1 Uint8Array(2) [ 1, 0 ]

// The frame is not modified, and a frame with no saturated pixel gives zeros.
console.log(frame().raw[2 * 6 + 2], analyzeSaturation({ ...frame(), raw: new Float32Array(24).fill(0.5) }).saturatedPixels) // 1 0
```

### Global Image Normalization

Before a set of registered frames is combined, each one is matched photometrically to a reference with a linear transform, `reference ≈ scale * current + offset`, in the units of the image (normalized 0..1 for `Image`, see Scientific Image Model), with no clamping. `solveGlobalNormalization(reference, current, mode)` solves it from two arrays of the same size, the overlapping pixel values of the reference and of the frame. The distributions are matched by quantile and not pixel by pixel, which tolerates a residual misregistration that would bias a paired regression over the whole frame. The `mode` chooses the estimator: `'scale'` is multiplicative only, the ratio of the medians (offset 0, scale 1 when the median of the current is zero); `'background-scale'` matches the 25th percentile (the background level) and the 25th to 75th percentile span; `'percentile'` matches the 10th percentile and the 10th to 90th percentile span, which tolerates bright structure better. A collapsed distribution carries no scale information, so only its level is matched (scale 1) and an empty input returns the identity.

`solveGlobalNormalizationPlanes(currentRaw, valid, referenceRaw, channels, width, height, mode, colorMode, sampleCounts?)` runs it on the raw buffers of two frames of the same geometry: it collects at most `NORMALIZATION_SAMPLE_LIMIT` (8192) pairs of finite pixels where `valid` (a byte per pixel, nonzero is usable, or `undefined` for all) allows, retries the dense scan when the lattice leaves fewer than `MIN_GLOBAL_NORMALIZATION_SAMPLES` (32), and returns one `{ scale, offset }` per plane, either one per interleaved channel (`colorMode` `'per-channel'`) or a single one derived from the luminance (`'luminance'`, falling back to per-channel for non-RGB images); `sampleCounts` is resized and filled with the number of pairs fitted per plane, and a plane without overlap gets the identity. `broadcastNormalizationPlanes(planes, channels)` expands the planes to the `scales` and `offsets` arrays per channel, and `applyGlobalNormalizationInPlace(raw, valid, channels, scales, offsets)` applies `value * scale + offset` to the pixels of `raw` whose `valid` byte is nonzero. The quantile estimators need a reference and a frame that show the same sky: a different field of view, a satellite trail or a cloud over a large part of the frame bias them; for a differential gradient see Local Image Normalization.

```ts
import { applyGlobalNormalizationInPlace, broadcastNormalizationPlanes, MIN_GLOBAL_NORMALIZATION_SAMPLES, NORMALIZATION_SAMPLE_LIMIT, solveGlobalNormalization, solveGlobalNormalizationPlanes } from 'nebulosa/src/imaging/processing/normalization'

// A reference ramp 0.1 .. 0.5 and a frame that is the same sky at 0.8 of the gain, plus a pedestal of 0.05.
const reference = Array.from({ length: 101 }, (_, i) => 0.1 + (0.4 * i) / 100)
const current = reference.map((value) => (value - 0.05) / 0.8)
for (const mode of ['scale', 'background-scale', 'percentile'] as const) console.log(mode, solveGlobalNormalization(reference, current, mode)) // scale { scale: 0.96, offset: 0 } (ratio of medians only, so the pedestal is not removed)
console.log(solveGlobalNormalization([], [], 'scale'), solveGlobalNormalization([0.2, 0.2, 0.2], [0.1, 0.1, 0.1], 'percentile')) // background-scale { scale: 0.8, offset: 0.05 }

// Two RGB frames: the whole analysis works on the raw buffers.
const width = 16
const height = 16
const pixels = width * height
const referenceRaw = new Float64Array(pixels * 3)
const currentRaw = new Float64Array(pixels * 3)
for (let i = 0; i < pixels; i++) {
	for (let channel = 0; channel < 3; channel++) {
		const sky = 0.1 + (0.3 * ((i * 7 + channel * 3) % 50)) / 50
		referenceRaw[i * 3 + channel] = sky
		currentRaw[i * 3 + channel] = (sky - 0.02 * (channel + 1)) / (0.5 + 0.25 * channel)
	}
}
const counts: number[] = []
const planes = solveGlobalNormalizationPlanes(currentRaw, undefined, referenceRaw, 3, width, height, 'background-scale', 'per-channel', counts)
console.log(planes, counts) // percentile { scale: 0.8, offset: 0.05 }
const luminance = solveGlobalNormalizationPlanes(currentRaw, undefined, referenceRaw, 3, width, height, 'scale', 'luminance')
console.log(luminance, broadcastNormalizationPlanes(luminance, 3)) // { scale: 1, offset: 0 } { scale: 1, offset: 0.1 } (an empty input is the identity, and a collapsed distribution matches only its level)

// Applying the per-channel solution to the valid pixels (the mask skips the first pixel) recovers the reference.
const valid = new Uint8Array(pixels).fill(1)
valid[0] = 0
const { scales, offsets } = broadcastNormalizationPlanes(planes, 3)
const before = currentRaw[0]
applyGlobalNormalizationInPlace(currentRaw, valid, 3, scales, offsets)
let worst = 0
for (let i = 3; i < currentRaw.length; i++) worst = Math.max(worst, Math.abs(currentRaw[i] - referenceRaw[i]))
console.log(currentRaw[0] === before, worst < 1e-12) // scales 0.5, 0.75, 1 and offsets 0.02, 0.04, 0.06 per channel, and 256 pairs in each plane
console.log(NORMALIZATION_SAMPLE_LIMIT, MIN_GLOBAL_NORMALIZATION_SAMPLES) // 8192 32
```

### Grayscale Image Conversion

`grayscale(image, channel?)` converts an interleaved RGB image into a fresh single-channel image (the input is not modified), or returns a mono input unchanged (the same object). `channel` selects a color channel (`'RED'`, `'GREEN'` or `'BLUE'`), which is extracted without weighting, or a luminance: the named weights `'BT709'` (the default, 0.2125, 0.7154, 0.0721), `'Y'` (NTSC, 0.299, 0.587, 0.114), `'RMY'` (0.5, 0.419, 0.081) and `'GRAY'` (BT.709), or explicit `{ red, green, blue }` weights, whose sum must be 1 within 1e-6 (a `RangeError` otherwise). The raw buffer of the result has the precision of the input, and the header loses the third axis (`NAXIS3` and the keywords tied to it, such as `CTYPE3` and `CRPIX3`), `WCSAXES` becomes 2, `NAXIS` becomes 2 and `BAYERPAT` is removed. The weights are the constants of Scientific Image Model.

```ts
import { grayscale } from 'nebulosa/src/imaging/processing/geometry'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 2x1 RGB image: a pure red pixel and a (0, 0.5, 1) one.
const rgb: Image = {
	header: { BITPIX: -32, NAXIS: 3, NAXIS1: 2, NAXIS2: 1, NAXIS3: 3, WCSAXES: 3, CTYPE3: 'RGB' },
	metadata: { width: 2, height: 1, channels: 3, pixelCount: 2, stride: 6, strideInBytes: 24, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
	raw: new Float32Array([1, 0, 0, 0, 0.5, 1]),
}

// The luminance with the default (BT.709) weights, and the named weights.
console.log(grayscale(rgb).raw) // Float32Array(2) [ 0.2125, 0.4298 ] (stored as 32-bit floats)
console.log(grayscale(rgb, 'Y').raw, grayscale(rgb, 'RMY').raw) // Float32Array(2) [ 0.299, 0.4075 ] Float32Array(2) [ 0.5, 0.2905 ] (stored as 32-bit floats)

// A channel is extracted, not weighted.
console.log(grayscale(rgb, 'RED').raw, grayscale(rgb, 'GREEN').raw, grayscale(rgb, 'BLUE').raw) // Float32Array(2) [ 1, 0 ] Float32Array(2) [ 0, 0.5 ] Float32Array(2) [ 0, 1 ]

// Explicit weights that sum to one.
console.log(grayscale(rgb, { red: 0.5, green: 0.5, blue: 0 }).raw) // Float32Array(2) [ 0.5, 0.25 ]

// The geometry of the result: one channel, the stride of a mono row and a header with two axes.
const mono = grayscale(rgb)
console.log(mono.metadata.channels, mono.metadata.stride, mono.header) // 1 2 { BITPIX: -32, NAXIS: 2, NAXIS1: 2, NAXIS2: 1, WCSAXES: 2 }
console.log(rgb.metadata.channels, grayscale(mono) === mono) // 3 true

try {
	grayscale(rgb, { red: 1, green: 1, blue: 1 })
} catch (e) {
	console.log((e as Error).message) // grayscale weights must sum to one: 3
}
```

### Image Analysis Planes

The quantitative image analyses (the sensor characterization, the flat and saturation checks) work on one plane of a `DigitalImage` (see Scientific Image Loading and Export) at a time, without luminance conversion or debayering, and share the helpers of `imaging/analysis/plane`. An `ImageAnalysisPlane` is `'mono'`, one of the interleaved RGB planes (`'red'`, `'green'`, `'blue'`) or one of the planes of a non-debayered color filter array (CFA) mosaic (`'red'`, `'green1'`, `'green2'`, `'blue'`); the canonical lists are `MONO_ANALYSIS_PLANES`, `RGB_ANALYSIS_PLANES` and `CFA_ANALYSIS_PLANES`, and `resolveImageAnalysisPlanes(image)` picks the one that fits the layout of an image after validating it. Rectangles are `Rect` values with inclusive `left` and `top` and exclusive `right` and `bottom`, in image pixels, and the CFA pattern of the metadata is image-local: `cfaOffset` (`[x, y]` in unbinned sensor pixels, applied once) shifts the pattern of a full-sensor frame to the origin of a crop.

`validateDigitalImageLayout(image)` throws when the layout is not the dense, row-major and interleaved one that these analyses assume: `sampleScale` other than `'digital'`, a raw buffer that is not a `Float32Array` or a `Float64Array` or is shorter than `stride * height`, dimensions that are not positive integers, `channels` other than 1 or 3, an inconsistent `pixelCount` or `stride`, a CFA mosaic with several channels, a non-finite or unordered `digitalRange` and a non-positive `quantizationStep`. `resolveAnalysisArea(area, width, height)` returns the area, or the whole frame when it is omitted, and throws unless it is a non-empty rectangle of integers inside the extent. `resolveLocalCfaPattern(image, cfaOffset?)` returns the image-local pattern, shifted by the offset when there is one (a `RangeError` when the image is not a mosaic).

`resolveImagePlaneGeometry(image, area, plane, cfaOffset?)` maps a plane inside an area to an `ImagePlaneGeometry`: the first source pixel (`sourceLeft`, `sourceTop`), the `step` between samples in the source (1 for mono and RGB, 2 for a CFA), the `width` and `height` in samples, and the raw-buffer layout (`rawStart`, `rawColumnStep`, `rawRowStep`, so that sample `(x, y)` is `raw[rawStart + y * rawRowStep + x * rawColumnStep]`), with the `cfaPattern` that selected it. A mosaic plane that has no sample in a tiny area is an error here and `undefined` in `resolveOptionalImagePlaneGeometry`, which still throws for an invalid layout, area, offset or plane; `imagePlaneGeometry(metadata, area, plane, pattern?)` is the lower-level function that expects a validated layout and area.

```ts
import { CFA_ANALYSIS_PLANES, imagePlaneGeometry, MONO_ANALYSIS_PLANES, resolveAnalysisArea, resolveImageAnalysisPlanes, resolveImagePlaneGeometry, resolveLocalCfaPattern, resolveOptionalImagePlaneGeometry, RGB_ANALYSIS_PLANES, validateDigitalImageLayout } from 'nebulosa/src/imaging/analysis/plane'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

// A 6x4 digital image: mono, interleaved RGB or an RGGB mosaic.
const make = (channels: 1 | 3, bayer?: 'RGGB'): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 6, NAXIS2: 4 },
	raw: new Float64Array(6 * 4 * channels),
	metadata: { width: 6, height: 4, channels, pixelCount: 24, pixelSizeInBytes: 2, strideInBytes: 6 * channels * 8, stride: 6 * channels, bitpix: 16, bayer },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

const mono = make(1)
const rgb = make(3)
const mosaic = make(1, 'RGGB')
console.log(resolveImageAnalysisPlanes(mono), resolveImageAnalysisPlanes(rgb), resolveImageAnalysisPlanes(mosaic)) // ['mono'] ['red', 'green', 'blue'] ['red', 'green1', 'green2', 'blue']
console.log(MONO_ANALYSIS_PLANES === resolveImageAnalysisPlanes(mono), RGB_ANALYSIS_PLANES.length, CFA_ANALYSIS_PLANES.length) // true 3 4

// The area defaults to the whole frame and is checked against the extent.
const whole = resolveAnalysisArea(undefined, 6, 4)
console.log(whole) // { left: 0, top: 0, right: 6, bottom: 4 }
console.log(resolveAnalysisArea({ left: 1, top: 1, right: 5, bottom: 3 }, 6, 4)) // { left: 1, top: 1, right: 5, bottom: 3 } (the same rectangle)

// Plane geometry: the whole mono image, the green samples of an RGB image and each plane of the mosaic.
console.log(resolveImagePlaneGeometry(mono, whole, 'mono')) // { sourceLeft: 0, sourceTop: 0, step: 1, width: 6, height: 4, rawStart: 0, rawColumnStep: 1, rawRowStep: 6 }
console.log(resolveImagePlaneGeometry(rgb, whole, 'green')) // { sourceLeft: 0, sourceTop: 0, step: 1, width: 6, height: 4, rawStart: 1, rawColumnStep: 3, rawRowStep: 18 }
for (const plane of CFA_ANALYSIS_PLANES) {
	const g = resolveImagePlaneGeometry(mosaic, whole, plane)
	console.log(plane, g.sourceLeft, g.sourceTop, g.step, g.width, g.height, g.rawStart, g.rawColumnStep, g.rawRowStep) // red: source (0, 0), step 2, 3x2 samples, rawStart 0, steps 2 and 12
}

// Sample (1, 1) of the blue plane is raw[rawStart + rawRowStep + rawColumnStep], the source pixel (3, 3), that is raw index 21.
const blue = resolveImagePlaneGeometry(mosaic, whole, 'blue')
console.log(blue.rawStart + 1 * blue.rawRowStep + 1 * blue.rawColumnStep) // green1: source (1, 0), step 2, 3x2 samples, rawStart 1, steps 2 and 12

// A crop of a full-sensor mosaic that starts at an odd column swaps the pattern: the offset shifts it once.
console.log(resolveLocalCfaPattern(mosaic), resolveLocalCfaPattern(mosaic, [1, 0]), resolveLocalCfaPattern(mono)) // green2: source (0, 1), step 2, 3x2 samples, rawStart 6, steps 2 and 12
console.log(resolveImagePlaneGeometry(mosaic, whole, 'red', [1, 0]).sourceLeft) // blue: source (1, 1), step 2, 3x2 samples, rawStart 7, steps 2 and 12

// A mosaic plane without samples in a tiny area: an error, or undefined from the optional variant.
const tiny = { left: 0, top: 0, right: 1, bottom: 1 }
console.log(resolveOptionalImagePlaneGeometry(mosaic, tiny, 'blue')) // undefined
console.log(imagePlaneGeometry(mosaic.metadata, tiny, 'red')?.width) // 21

for (const run of [
	() => resolveImagePlaneGeometry(mosaic, tiny, 'blue'),
	() => resolveImagePlaneGeometry(mono, whole, 'red'),
	() => resolveImagePlaneGeometry(rgb, whole, 'mono'),
	() => resolveAnalysisArea({ left: 0, top: 0, right: 7, bottom: 4 }, 6, 4),
	() => resolveLocalCfaPattern(mono, [1, 0]),
	() => validateDigitalImageLayout({ ...mono, sampleScale: 'normalized' } as never),
	() => validateDigitalImageLayout({ ...mono, quantizationStep: 0 }),
	() => validateDigitalImageLayout({ ...mono, raw: new Float64Array(4) }),
]) {
	try {
		run()
	} catch (e) {
		console.log((e as Error).message) // RGGB GRBG undefined
	}
}
```

### Image Arithmetic

The arithmetic functions combine two images or an image and a scalar sample by sample, in the full floating-point range and without clipping, so results may leave 0..1 and the caller decides when to clamp or renormalize. Every operation takes `out` as its last argument, the image of the result: it defaults to the first image, which is then modified in place, and an exact alias of an input is accepted, but a buffer that partially overlaps an input (a shifted view of the same memory) throws an `Error`. The operands of the image form must have the same width, height, channels and CFA pattern and a dense buffer that agrees with the metadata (`checkDimensions(a, b)` runs that check and throws a message that names the first mismatch); the scalar must be finite and the divisor of `divideScalar` non-zero. `divide` writes 0 for every sample whose divisor is 0, instead of an infinity. The functions return `out`.

`plus`, `subtract`, `multiply` and `divide` take two images, and `plusScalar`, `subtractScalar`, `multiplyScalar` and `divideScalar` an image and a number. Cloning and copying are in Image Cloning and Copying.

```ts
import { checkDimensions, divide, divideScalar, multiply, multiplyScalar, plus, plusScalar, subtract, subtractScalar } from 'nebulosa/src/imaging/processing/arithmetic'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 2x1 gray frame, with the header and the metadata that a reader would give.
const frame = (values: number[], bayer?: Image['metadata']['bayer']): Image => ({
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: values.length, NAXIS2: 1 },
	metadata: { width: values.length, height: 1, channels: 1, pixelCount: values.length, stride: values.length, strideInBytes: values.length * 4, pixelSizeInBytes: 4, bitpix: -32, bayer },
	raw: new Float32Array(values),
})

const a = frame([1, 2])
const b = frame([4, 0])

// With an explicit output the inputs are kept; without it the first image is overwritten.
console.log(plus(a, b, frame([0, 0])).raw, a.raw) // Float32Array(2) [ 5, 2 ] Float32Array(2) [ 1, 2 ]
console.log(subtract(a, b, frame([0, 0])).raw, multiply(a, b, frame([0, 0])).raw) // Float32Array(2) [ -3, 2 ] Float32Array(2) [ 4, 0 ]
console.log(divide(a, b, frame([0, 0])).raw) // Float32Array(2) [ 0.25, 0 ] (the divisor 0 gives 0)

// The scalar forms, and the in-place use.
console.log(plusScalar(a, 0.5, frame([0, 0])).raw, subtractScalar(a, 0.5, frame([0, 0])).raw) // Float32Array(2) [ 1.5, 2.5 ] Float32Array(2) [ 0.5, 1.5 ]
console.log(multiplyScalar(a, 3, frame([0, 0])).raw, divideScalar(a, 4, frame([0, 0])).raw) // Float32Array(2) [ 3, 6 ] Float32Array(2) [ 0.25, 0.5 ]
console.log(plus(a, b) === a, a.raw) // true Float32Array(2) [ 5, 2 ]

// The geometry check.
try {
	checkDimensions(a, frame([1, 2, 3]))
} catch (e) {
	console.log((e as Error).message) // width does not match: 2 != 3
}

try {
	checkDimensions(a, frame([1, 2], 'RGGB'))
} catch (e) {
	console.log((e as Error).message) // CFA patterns do not match: none != RGGB
}

// A scalar that is not finite, a null divisor, and an output that is a shifted view of an input.
try {
	multiplyScalar(a, Infinity)
} catch (e) {
	console.log((e as Error).message) // scalar must be finite: Infinity
}

try {
	divideScalar(a, 0)
} catch (e) {
	console.log((e as Error).message) // scalar must be non-zero: 0
}

const memory = new Float32Array(4)
const view = (offset: number): Image => ({ ...frame([0, 0]), raw: memory.subarray(offset, offset + 2) })

try {
	plus(view(0), b, view(1))
} catch (e) {
	console.log((e as Error).message) // first image and output raw buffers partially overlap
}
```

### Image Calibration

`calibrate(light, options?)` applies the bias, dark and flat master frames to a light frame in one pass, and modifies `light` in place and returns the same object. The masters are raw, as stacked, in the normalized 0..1 units of `Image` (see Scientific Image Model): the `dark` and the `darkFlat` still contain their bias pedestal and the `flat` contains its bias and dark current, the result is `(light - dark) * mean(flat') / flat'`, with `flat'` the flat minus its `darkFlat` (or its `bias`). Without a `flat` the light is just reduced by the dark (or by the bias alone when it is the only master). When the exposures differ, `darkScaling: 'exposure'` (the default) scales only the dark current, `bias + (dark - bias) * exposure(light) / exposure(dark)`, which requires a `bias`, and finite positive `EXPTIME` or `EXPOSURE` keywords in seconds in the headers of both frames (the same for the flat and its dark-flat); `'none'` uses the masters as they are, for exposure-matched masters or for a sensor whose dark signal does not scale linearly. The mean of the corrected flat, the normalization, is computed independently for each interleaved channel of a color image and for each of the four phases of an undebayered CFA mosaic. The result is not clipped, so the noise around zero keeps its sign, and a corrected flat sample at or below `minimumFlat` (zero by default, a normalized value) is rejected before the light is touched.

Everything is validated before the first pixel is written: each master has the geometry and channels of the light, a CFA pattern equal to it (a flat must have the pattern, the others may have none), and the same `XBINNING`, `YBINNING`, `XORGSUBF`, `YORGSUBF`, `XBAYROFF`, `YBAYROFF`, `GAIN` and `OFFSET` header values when both frames have them. Each failure is an `Error` that names the master, as is a dark-flat without a flat, an unsupported scaling and a `minimumFlat` that is negative or not finite. With no dark, flat or bias the light is returned unchanged. The master frames are never modified, and the scaling assumes a dark current linear in time and the same temperature, which the function cannot check.

```ts
import { calibrate } from 'nebulosa/src/imaging/processing/calibration'
import type { Image } from 'nebulosa/src/imaging/model/types'

const make = (width: number, height: number, channels: number, values: number[], header: Image['header'] = {}, bayer?: 'RGGB'): Image => ({
	header,
	raw: Float64Array.from(values),
	metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: -64, bayer },
})

// An exposure-matched dark and a flat corrected by the bias: (L - D) * mean(F - B) / (F - B).
const light = make(2, 1, 1, [0.6, 0.4], { EXPTIME: 30 })
const dark = make(2, 1, 1, [0.1, 0.1], { EXPTIME: 30 })
const flat = make(2, 1, 1, [0.4, 0.8])
const bias = make(2, 1, 1, [0.05, 0.05])
console.log(calibrate(light, { dark, flat, bias }) === light, light.raw) // true [0.7857, 0.22]

// Only a bias, and only an exposure-matched dark.
console.log(calibrate(make(2, 1, 1, [0.6, 0.4]), { bias: make(2, 1, 1, [0.1, 0.05]) }).raw) // [0.5, 0.35]
console.log(calibrate(make(2, 1, 1, [0.6, 0.4], { EXPTIME: 30 }), { dark: make(2, 1, 1, [0.1, 0.2], { EXPTIME: 30 }) }).raw) // [0.5, 0.2]

// A 10 s dark for a 30 s light: only the dark current (dark - bias) is tripled, and the bias is needed.
const scaled = calibrate(make(2, 1, 1, [0.41, 0.7], { EXPTIME: 30 }), { dark: make(2, 1, 1, [0.07, 0.1], { EXPTIME: 10 }), bias: make(2, 1, 1, [0.05, 0.04]) })
console.log(scaled.raw) // [0.3, 0.48] (L - B) - (D - B) * 3
console.log(calibrate(make(1, 1, 1, [0.41], { EXPOSURE: 30 }), { dark: make(1, 1, 1, [0.07], { EXPOSURE: 10 }), bias: make(1, 1, 1, [0.05]) }).raw) // [0.3]
console.log(calibrate(make(2, 1, 1, [0.41, 0.7], { EXPTIME: 30 }), { dark: make(2, 1, 1, [0.07, 0.1], { EXPTIME: 10 }), darkScaling: 'none' }).raw) // [0.34, 0.6] (the dark is subtracted as it is, with no scaling)

// The negative residuals are kept, and a dark-flat is subtracted from the flat before it is normalized.
console.log(calibrate(make(2, 1, 1, [0.04, 0.06], { EXPTIME: 10 }), { dark: make(2, 1, 1, [0.05, 0.05], { EXPTIME: 10 }) }).raw) // [-0.01, 0.01]
const withDarkFlat = calibrate(make(2, 1, 1, [0.6, 0.4], { EXPTIME: 30 }), { dark: make(2, 1, 1, [0.1, 0.1], { EXPTIME: 30 }), flat: make(2, 1, 1, [0.45, 0.85], { EXPTIME: 2 }), darkFlat: make(2, 1, 1, [0.07, 0.07], { EXPTIME: 2 }) })
console.log(withDarkFlat.raw) // [0.7632, 0.2231]

// An RGB image is normalized per channel; a RGGB mosaic per phase, so a flat with one sample per phase leaves a uniform light unchanged.
const rgb = calibrate(make(2, 1, 3, [0.5, 0.4, 0.3, 0.5, 0.4, 0.3]), { flat: make(2, 1, 3, [0.2, 0.4, 0.8, 0.4, 0.8, 0.8]) })
console.log(rgb.raw) // [0.75, 0.6, 0.3, 0.375, 0.3, 0.3] (each channel is divided by its own normalized flat)
const mosaic = calibrate(make(2, 2, 1, [0.5, 0.5, 0.5, 0.5], {}, 'RGGB'), { flat: make(2, 2, 1, [0.2, 0.4, 0.4, 0.8], {}, 'RGGB') })
console.log(mosaic.raw) // [0.5, 0.5, 0.5, 0.5]

for (const run of [
	() => calibrate(make(2, 1, 1, [0.5, 0.5]), { darkFlat: make(2, 1, 1, [0.1, 0.1]) }),
	() => calibrate(make(2, 1, 1, [0.5, 0.5], { EXPTIME: 30 }), { dark: make(2, 1, 1, [0.1, 0.1], { EXPTIME: 10 }) }),
	() => calibrate(make(2, 1, 1, [0.5, 0.5]), { dark: make(3, 1, 1, [0.1, 0.1, 0.1]) }),
	() => calibrate(make(2, 1, 1, [0.5, 0.5], { GAIN: 100 }), { bias: make(2, 1, 1, [0.1, 0.1], { GAIN: 200 }) }),
	() => calibrate(make(2, 1, 1, [0.5, 0.5]), { flat: make(2, 1, 1, [0.1, 0]) }),
	() => calibrate(make(2, 1, 1, [0.5, 0.5]), { minimumFlat: -1 }),
]) {
	try {
		run()
	} catch (e) {
		console.log((e as Error).message) // darkFlat requires a flat master
	}
}
```

### Image Cloning and Copying

`clone(image)` returns an independent `Image`: the header, the metadata and the raw buffer are copied (the buffer with the same precision, through `slice`), so changing the result never touches the source, and any other property of the image, such as the sample scale, is carried over. `copyInto(from, to)` copies the samples of an image into another one of the same width, height, channels and CFA pattern, leaves the header and the metadata of the destination alone, and returns the destination; copying a buffer over itself, or over a shifted view of the same memory, keeps the values, because the copy is done by `TypedArray.set`. The destination must already have the dense geometry of the source (Image Arithmetic describes the check, which is `checkDimensions`), or the call throws.

```ts
import { clone, copyInto } from 'nebulosa/src/imaging/processing/arithmetic'
import type { Image } from 'nebulosa/src/imaging/model/types'

const frame = (values: number[]): Image => ({
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: values.length, NAXIS2: 1 },
	metadata: { width: values.length, height: 1, channels: 1, pixelCount: values.length, stride: values.length, strideInBytes: values.length * 4, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
	raw: new Float32Array(values),
})

const source = frame([1, 2])
const copy = clone(source)
copy.raw[0] = 9
copy.header.NAXIS1 = 99
console.log(source.raw, source.header.NAXIS1, copy.raw.constructor === source.raw.constructor) // Float32Array(2) [ 1, 2 ] 2 true

// Copy the samples into an existing image of the same shape: the metadata of the destination is kept.
const target = frame([0, 0])
console.log(copyInto(source, target) === target, target.raw) // true Float32Array(2) [ 1, 2 ]

try {
	copyInto(source, frame([0, 0, 0]))
} catch (e) {
	console.log((e as Error).message) // width does not match: 2 != 3
}
```

### Image Convolution

`convolution(image, kernel, options)` applies a spatial kernel to a normalized `Image` in place (a mono or an interleaved color image: every channel is convolved on its own) and returns the same image. A `ConvolutionKernel` is the row-major `kernel` weights, its odd `width` and `height` (3 to 99; an even or out-of-range size throws) and a `divisor`; `convolutionKernel(weights, width, height = width, divisor?)` builds one and takes the sum of the weights as the divisor when it is omitted. The pixels outside the image are not read: at a border the kernel is truncated. With the default options the divisor is recomputed for every pixel as the sum of the weights that fall inside the image (`dynamicDivisorForEdges: true`), so a smoothing kernel keeps its gain at the borders, and with `false` the divisor of the kernel is used and the border is darker. A divisor that is negative is made positive and `1` is added to the result when `normalize` is `true` (the default), and a divisor of 0, the case of the edge and emboss kernels, is replaced by 1 and `0.5` is added, so those filters are centered at 0.5 (and the truncated border rows and columns of a zero-sum kernel do not have a zero divisor, and are not reliable). The result is not clipped.

The named filters apply a fixed kernel with `ConvolutionOptions`: `edges` (the 3x3 Laplacian), `emboss`, `sharpen`, the box blurs `mean3x3`, `mean5x5`, `mean7x7`, and the pyramid blurs `blur3x3`, `blur5x5` and `blur7x7`, the last ones with weights that grow linearly to the center (divisors 16, 81 and 256). `mean(image, size, options)` and `blur(image, size, options)` take any odd size from 3 to 99, using the fixed kernel for 3, 5 and 7 and building it otherwise with `meanConvolutionKernel(size)` and `blurConvolutionKernel(size)`. `gaussianBlurKernel(sigma = 1.4, size = 5)` samples the continuous Gaussian density (sigma in pixels, 0.5 to 5; size odd) and the kernel divisor is the sum of the samples, and `gaussianBlur(image, { sigma, size, ...options })` applies it. `DEFAULT_CONVOLUTION_OPTIONS` and `DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS` hold the defaults.

`separableSmoothing(source, output, intermediate, metadata, kernel, options)` is the cheaper path for a dilated ("à trous") smoothing, used by the multiscale transforms: it applies a one-dimensional `SeparableSmoothingKernel` (odd length of at least 3, built by `separableSmoothingKernel(weights, divisor?)`) along rows and then columns, with taps `step` pixels apart (default 1) and the same border rule (`dynamicDivisorForEdges`). The three buffers are separate typed arrays of the same precision and of the length of the image (`metadata.stride * metadata.height`), the result is `output`, and the work is linear in the size of the image whatever the step. `shift(buffer)` is the helper that rotates the row buffer of `convolution` by one slot.

```ts
import {
	blur,
	blur3x3,
	blur5x5,
	blur7x7,
	blurConvolutionKernel,
	convolution,
	convolutionKernel,
	DEFAULT_CONVOLUTION_OPTIONS,
	DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS,
	edges,
	emboss,
	gaussianBlur,
	gaussianBlurKernel,
	mean,
	mean3x3,
	mean5x5,
	mean7x7,
	meanConvolutionKernel,
	separableSmoothing,
	separableSmoothingKernel,
	shift,
	sharpen,
} from 'nebulosa/src/imaging/processing/convolution'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 5x5 gray image with a single bright pixel in the center (an impulse), and a printer for its rows.
const frame = (values: number[]): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: 5, NAXIS2: 5 },
	metadata: { width: 5, height: 5, channels: 1, pixelCount: 25, stride: 5, strideInBytes: 40, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array(values),
})

const impulse = () => frame(Array.from({ length: 25 }, (_, i) => (i === 12 ? 1 : 0)))
const row = (image: Image, y: number) => Array.from(image.raw.slice(y * 5, y * 5 + 5), (value) => Number(value.toFixed(4)))

// The impulse response of the box and the pyramid blurs: the kernel itself divided by its divisor.
console.log(row(mean3x3(impulse()), 2), row(blur3x3(impulse()), 2)) // [ 0, 0.1111, 0.1111, 0.1111, 0 ] [ 0, 0.125, 0.25, 0.125, 0 ]
console.log(row(sharpen(impulse()), 2), row(edges(impulse()), 2)) // [ 0, -1, 5, -1, 0 ] [ 0, -0.5, 4.5, -0.5, 0 ]
console.log(row(emboss(impulse()), 2)) // [ 0, 0.5, 0.5, 0.5, 1 ]
console.log(row(gaussianBlur(impulse()), 2), row(gaussianBlur(impulse(), { sigma: 0.8, size: 3 }), 2)) // [ 0.0516, 0.0814, 0.0935, 0.0814, 0.0516 ] [ 0, 0.1248, 0.2725, 0.1248, 0 ]

// The sizes with a fixed kernel and the others: all the same operation with a kernel of a given size, in place.
console.log(row(mean5x5(impulse()), 2), row(mean(impulse(), 5), 2), row(blur(impulse(), 5), 2)) // [ 0.04, 0.04, 0.04, 0.04, 0.04 ] [ 0.04, 0.04, 0.04, 0.04, 0.04 ] [ 0.037, 0.0741, 0.1111, 0.0741, 0.037 ]
console.log(row(blur5x5(impulse()), 2), row(mean7x7(impulse()), 2), row(blur7x7(impulse()), 2)) // [ 0.0556, 0.0833, 0.1111, 0.0833, 0.0556 ] [ 0.05, 0.04, 0.04, 0.04, 0.05 ] [ 0.0571, 0.0659, 0.0816, 0.0659, 0.0571 ]

// The kernels: weights, size and divisor.
const kernel = gaussianBlurKernel(1, 3)
console.log(
	kernel.width,
	kernel.height,
	kernel.divisor.toFixed(4),
	Array.from(kernel.kernel, (value) => Number(value.toFixed(4))),
) // 3 3 0.7795 [ 0.0585, 0.0965, 0.0585, 0.0965, 0.1592, 0.0965, 0.0585, 0.0965, 0.0585 ]
console.log(meanConvolutionKernel(9).divisor, blurConvolutionKernel(9).divisor, Array.from(blurConvolutionKernel(5).kernel).join(' ')) // 81 625 1 2 3 2 1 2 4 6 4 2 3 6 9 6 3 2 4 6 4 2 1 2 3 2 1
console.log(convolutionKernel([1, 2, 1, 2, 4, 2, 1, 2, 1], 3).divisor, convolutionKernel([1, 1, 1, 1, 1, 1, 1, 1, 1], 3, 3, 3).divisor) // 16 3

// A custom kernel through convolution(), and the border rule: a 3x3 image of ones.
const ones = () => ({ ...frame([]), metadata: { ...frame([]).metadata, width: 3, height: 3, pixelCount: 9, stride: 3 }, raw: new Float64Array(9).fill(1) })
console.log(Array.from(convolution(ones(), convolutionKernel(new Array(9).fill(1), 3)).raw, (value) => Number(value.toFixed(3)))) // [ 1, 1, 1, 1, 1, 1, 1, 1, 1 ] (the divisor follows the truncated border)
console.log(Array.from(convolution(ones(), convolutionKernel(new Array(9).fill(1), 3), { dynamicDivisorForEdges: false }).raw, (value) => Number(value.toFixed(3)))) // [ 0.444, 0.667, 0.444, 0.667, 1, 0.667, 0.444, 0.667, 0.444 ]
console.log(DEFAULT_CONVOLUTION_OPTIONS, DEFAULT_GAUSSIAN_BLUR_CONVOLUTION_OPTIONS) // { dynamicDivisorForEdges: true, normalize: true } and the same with sigma 1.4 and size 5

// The separable smoothing with the binomial kernel [1, 4, 6, 4, 1] / 16, and with a dilation of 2 pixels.
const source = new Float64Array(25)
source[12] = 1
const output = new Float64Array(25)
const intermediate = new Float64Array(25)
const metadata = impulse().metadata
const smoothing = separableSmoothingKernel([1, 4, 6, 4, 1])
console.log(
	smoothing.divisor,
	separableSmoothing(source, output, intermediate, metadata, smoothing) === output,
	Array.from(output.slice(10, 15), (value) => Number(value.toFixed(4))),
) // 16 true [ 0.0341, 0.1, 0.1406, 0.1, 0.0341 ]
separableSmoothing(source, output, intermediate, metadata, separableSmoothingKernel([1, 2, 1]), { step: 2, dynamicDivisorForEdges: false })
console.log(Array.from(output.slice(10, 15))) // [ 0.125, 0, 0.25, 0, 0.125 ]

// The row buffer rotation.
const rows = [[1], [2], [3]]
shift(rows)
console.log(rows) // [ [ 2 ], [ 3 ], [ 1 ] ]

// An even kernel, a sigma outside 0.5..5, and a one-dimensional kernel of even length.
for (const action of [() => convolution(impulse(), convolutionKernel([1, 1, 1, 1], 2)), () => gaussianBlurKernel(6, 5), () => separableSmoothingKernel([1, 1]), () => meanConvolutionKernel(4)]) {
	try {
		action()
	} catch (e) {
		console.log((e as Error).message) // kernel size must be odd, kernel size bust be in range [0.5..5], separable kernel length must be odd and at least 3 and size must be odd
	}
}
```

### Image Intensity Inversion

`invert(image)` replaces every sample `v` of a normalized image with `1 - v`, in place, and returns the same image. It is the negative of an image whose full scale is 1 (the usual input of the processing functions); a sample outside 0..1 maps outside it as well, and the function does not clip. The image must be dense mono or interleaved RGB (1 or 3 channels), with the stride and the buffer length that agree with the geometry, or it throws an `Error`. Applying it twice gives back the original samples up to the rounding of the sample type.

```ts
import { invert } from 'nebulosa/src/imaging/processing/geometry'
import type { Image } from 'nebulosa/src/imaging/model/types'

const image: Image = {
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: 3, NAXIS2: 2 },
	metadata: { width: 3, height: 2, channels: 1, pixelCount: 6, stride: 3, strideInBytes: 12, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
	raw: new Float64Array([0, 0.1, 0.2, 0.3, 0.4, 1.5]),
}

console.log(invert(image) === image, image.raw) // true Float64Array(6) [ 1, 0.9, 0.8, 0.7, 0.6, -0.5 ]
console.log(invert(image).raw) // Float64Array(6) [ 0, 0.09999999999999998, 0.19999999999999996, 0.30000000000000004, 0.4, 1.5 ]

try {
	invert({ ...image, metadata: { ...image.metadata, channels: 2 } })
} catch (e) {
	console.log((e as Error).message) // image channels must be 1 or 3: 2
}
```

### Image Mirroring

`horizontalFlip(image)` mirrors an image across its vertical axis (the columns are reversed, left becomes right) and `verticalFlip(image)` across its horizontal axis (the rows are reversed, the first row becomes the last), both in place, for a dense mono or interleaved RGB image, returning the same image. A flip also keeps the metadata that describes the pixels consistent with them: the FITS WCS keywords of the header (`CRPIX` and the linear transformation terms) are reflected, so the sky coordinates of each star are unchanged after the flip, and the CFA pattern of a raw mosaic is shifted when the reflection moves its origin to an odd pixel (an even width makes the new origin an odd pixel, so `RGGB` becomes `GRBG` after a horizontal flip, and an even height does the same, in rows, for a vertical flip). The header `BAYERPAT` is updated with the metadata. Two flips along the same axis restore the image.

```ts
import { horizontalFlip, verticalFlip } from 'nebulosa/src/imaging/processing/geometry'
import { clone } from 'nebulosa/src/imaging/processing/arithmetic'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 4x2 raw mosaic with a simple WCS: the reference pixel is the first one (FITS counts from 1) and the axes are mirrored in RA.
const mosaic: Image = {
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: 4, NAXIS2: 2, CRPIX1: 1, CRPIX2: 1, CD1_1: -0.001, CD1_2: 0, CD2_1: 0, CD2_2: 0.001, BAYERPAT: 'RGGB' },
	metadata: { width: 4, height: 2, channels: 1, pixelCount: 8, stride: 4, strideInBytes: 16, pixelSizeInBytes: 4, bitpix: -32, bayer: 'RGGB' },
	raw: new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]),
}

const h = horizontalFlip(clone(mosaic))
console.log(h.raw, h.header.CRPIX1, h.header.CD1_1, h.metadata.bayer, h.header.BAYERPAT) // Float32Array(8) [ 3, 2, 1, 0, 7, 6, 5, 4 ] 4 0.001 GRBG GRBG

const v = verticalFlip(clone(mosaic))
console.log(v.raw, v.header.CRPIX2, v.header.CD2_2, v.metadata.bayer) // Float32Array(8) [ 4, 5, 6, 7, 0, 1, 2, 3 ] 2 -0.001 GBRG

// An image with an odd width keeps its CFA phase in a horizontal flip (the new origin is an even pixel).
const odd: Image = { ...mosaic, header: { ...mosaic.header, NAXIS1: 3 }, metadata: { ...mosaic.metadata, width: 3, pixelCount: 6, stride: 3, strideInBytes: 12 }, raw: new Float32Array([0, 1, 2, 3, 4, 5]) }
console.log(horizontalFlip(odd).raw, odd.metadata.bayer) // Float32Array(6) [ 2, 1, 0, 5, 4, 3 ] RGGB

// Flipping twice restores the image.
const twice = horizontalFlip(horizontalFlip(clone(mosaic)))
console.log(
	twice.raw.every((value, i) => value === mosaic.raw[i]),
	twice.metadata.bayer,
	twice.header.CRPIX1,
) // true RGGB 1
```

### Image Scale and Field of View

### Image Stacking

### Image Statistics

### Image Warp

`warpImage(source, reference, inverseTransform, options?)` resamples `source` onto the pixel grid of `reference`, with no normalization or combination of samples (see Image Stacking for the whole pipeline and Star List Registration for the transform fit). `inverseTransform` maps coordinates of the reference grid to coordinates of the source, in pixels, and is either a `SimilarityTransform` (`a`, `b`, `tx`, `ty` and `mirrored`: `x' = a x - b y + tx`, `y' = b x + a y + ty`, the y row of the mirrored form being flipped) or an `AffineTransform` (`m00`, `m01`, `tx`, `m10`, `m11`, `ty`); `toAffineMatrix(transform)` converts the first to the second (an affine transform is returned as it is). Pixel coordinates are in pixel units with an integer at the center of a pixel and the origin at the center of the first pixel, so a pure translation `tx = 2` makes output pixel `x` the source pixel `x + 2`. The result is a `WarpedImage`: a fresh `image` with the geometry of the reference (its width, height, channels and CFA metadata) whose samples are Float32 or Float64 as the source or as `outputPrecision` asks, a `validityMask` of one byte per output pixel (1 where the whole interpolation kernel falls inside the source and no rejected pixel touches it), the number of output centers that fall in the source domain (`coveredPixels`) and of those with an unmasked kernel (`validPixels`). The samples where the mask is zero are zero, and the pixels near the borders of the source are not valid for the bilinear and bicubic kernels, as their support is not complete.

The `interpolationMode` is `'nearest'`, `'bilinear'` (the default) or `'bicubic'`; the interpolation attenuates the noise by an amount that depends on the subpixel phase, which matters for any later noise statistics (see Local Image Normalization). The `rejectionMask` is one byte per source pixel, nonzero invalidates every output whose kernel support contains it, in every channel, without renormalizing the weights (streak or cosmic-ray masks, for example). `outputRaw` and `validityMask` can be given to reuse the buffers between warps (they are used only when their lengths match the reference, and are overwritten) and then the `image` aliases `outputRaw`. `finitePairSupport` (`limit` positive and `luminance` for one BT.709 plane of an RGB image) additionally counts, per plane and up to `limit`, the pixels where both the warped and the reference samples are finite, before the rejection mask, and returns them as `finitePairCounts`; the count stops as soon as every plane reaches the limit. A singular transform is not detected and produces whatever mapping the matrix defines.

```ts
import { toAffineMatrix, warpImage } from 'nebulosa/src/imaging/processing/registration'
import type { Image } from 'nebulosa/src/imaging/model/types'

const make = (width: number, height: number, value: (x: number, y: number) => number, channels = 1): Image => {
	const raw = new Float64Array(width * height * channels)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < channels; c++) raw[(y * width + x) * channels + c] = value(x, y) + c
	return { header: {}, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: width * channels * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined } }
}

// The source value is x + 10 y, and the reference is any 6x4 grid.
const source = make(6, 4, (x, y) => x + 10 * y)
const reference = make(6, 4, () => 0)
const first = (image: Image) => Array.from(image.raw.slice(0, 6))

// A translation of 2 pixels: output x is source x + 2, and the last two columns fall outside the source.
const shifted = warpImage(source, reference, { a: 1, b: 0, tx: 2, ty: 0, mirrored: false })
console.log(first(shifted.image), Array.from(shifted.validityMask.slice(0, 6)), shifted.coveredPixels, shifted.validPixels) // [2, 3, 4, 5, 0, 0] [1, 1, 1, 1, 0, 0] 16 16

// A half-pixel shift with each kernel: nearest takes the closest pixel, bilinear interpolates, bicubic is close to the bilinear on a ramp.
const half = { a: 1, b: 0, tx: 0.5, ty: 0, mirrored: false }
console.log(first(warpImage(source, reference, half, { interpolationMode: 'nearest' }).image)) // [1, 2, 3, 4, 5, 0]
console.log(first(warpImage(source, reference, half).image)) // [0.5, 1.5, 2.5, 3.5, 4.5, 0]
console.log(first(warpImage(source, reference, half, { interpolationMode: 'bicubic' }).image)) // [0.4375, 1.5, 2.5, 3.5, 4.5625, 0]

// A mirror (a = -1) and a quarter turn, as similarity transforms; the affine matrix is the equivalent.
console.log(first(warpImage(source, reference, { a: -1, b: 0, tx: 5, ty: 0, mirrored: false }).image)) // [5, 4, 3, 2, 1, 0]
const turn = { a: 0, b: 1, tx: 0, ty: 0, mirrored: false }
console.log(toAffineMatrix(turn), toAffineMatrix({ a: 1, b: 0, tx: 0, ty: 0, mirrored: true })) // { m00: 0, m01: -1, tx: 0, m10: 1, m11: 0, ty: 0 } { m00: 1, m01: 0, tx: 0, m10: 0, m11: -1, ty: 0 }
const affine = { m00: 1, m01: 0, tx: 1, m10: 0, m11: 1, ty: 1 }
console.log(toAffineMatrix(affine) === affine, first(warpImage(source, reference, affine).image)) // true [11, 12, 13, 14, 15, 0]

// A rejection mask on the source invalidates the outputs whose kernel includes it, and a smaller reference changes the output grid.
const rejected = new Uint8Array(24)
rejected[3] = 1
const masked = warpImage(source, reference, { a: 1, b: 0, tx: 0, ty: 0, mirrored: false }, { rejectionMask: rejected })
console.log(Array.from(masked.validityMask.slice(0, 6)), masked.coveredPixels, masked.validPixels) // [1, 1, 1, 0, 1, 1] 24 23
const small = warpImage(
	source,
	make(3, 2, () => 0),
	{ a: 1, b: 0, tx: 1, ty: 1, mirrored: false },
)
console.log(small.image.metadata.width, small.image.metadata.height, Array.from(small.image.raw)) // 3 2 [11, 12, 13, 21, 22, 23]

// Output precision, reusable buffers (the image aliases the raw buffer) and an RGB image.
const reused = new Float32Array(24)
const buffer = new Uint8Array(24)
const again = warpImage(source, reference, half, { outputRaw: reused, validityMask: buffer, outputPrecision: 32 })
console.log(again.image.raw === reused, again.validityMask === buffer, again.image.raw.constructor.name, warpImage(source, reference, half, { outputPrecision: 32 }).image.raw.constructor.name) // true true Float32Array Float32Array
const rgb = warpImage(
	make(6, 4, (x, y) => x + 10 * y, 3),
	make(6, 4, () => 0, 3),
	{ a: 1, b: 0, tx: 1, ty: 0, mirrored: false },
)
console.log(rgb.image.metadata.channels, rgb.image.raw.length, Array.from(rgb.image.raw.slice(0, 6))) // 3 72 [1, 2, 3, 2, 3, 4]

// Finite pairs against the reference, capped at the limit (the reference has a NaN).
const withNaN = make(6, 4, () => 0)
withNaN.raw[0] = Number.NaN
console.log(warpImage(source, withNaN, half, { finitePairSupport: { limit: 10 } }).finitePairCounts, warpImage(source, withNaN, half, { finitePairSupport: { limit: 1000 } }).finitePairCounts) // [10] [19]
console.log(warpImage(source, reference, half).finitePairCounts) // undefined
```

### Live Stacking

### Local Image Normalization

Local normalization matches a registered frame to a reference when the difference between them is not the same everywhere, as with moonlight, drifting light pollution or a transparency that changes across the field, where one global scale and offset (see Global Image Normalization) is right on average and wrong in the corners. `fitLocalNormalization(reference, current, options?)` fits a `LocalNormalizationModel` and `applyLocalNormalization(image, model, validityMask?)` applies it in place and returns the same image; `localNormalization(reference, current, options?)` does both and returns `{ image, model, applied }`. Both images are `Image` values already registered onto the same grid, with the same width, height and channel count (a documented precondition, not a checked one); the reference is only read. The model keeps the global solution as an anchor and describes only the smooth residual: the frame is divided into a grid of cells (`gridSize` cells on the longer axis, 16 by default), each cell estimates its residual offset (and, if it has enough dynamic range, its gain) from paired statistics of the same pixels (never from independent quantiles, because the resampling of the registered frame attenuates the noise by a factor that varies across the frame), and polynomial surfaces are fitted over the cells with outlier rejection. The gain surface is applied only when it is significant, and the local gain is limited to `relativeScaleRange` around the anchor (`[0.8, 1.25]`), so a legitimate global exposure difference is never truncated.

`options` extends the options of the global estimator (`estimator`, `'background-scale'` by default) with `colorMode` (`'per-channel'`, or `'luminance'` with one model for the three channels of an RGB image), a `validityMask` (a byte per pixel, nonzero is usable, which is also left untouched when applying), the cell geometry (`boxSize`, `maxSamplesPerCell`, `minSamplesPerCell`, `minValidFraction`), the gain gate (`dynamicRangeSigma`, in multiples of the paired noise) and significance (`scaleSignificance`), the surfaces (`surfaceModel`, `offsetDegree` 3, `scaleDegree` 1, `smoothing` for the spline), the outlier rejection (`rejectionSigma`, `rejectionIterations`), the evaluation node spacing and the `fallback` policy for a plane that cannot be modeled: `'global'` (the default, the anchor alone), `'identity'` (the plane is left alone) or `'reject'`, under which `localNormalization` applies nothing and returns `applied: false` so that the caller can drop the frame. `DEFAULT_LOCAL_NORMALIZATION_OPTIONS` has every default and `resolveLocalNormalizationOptions(options)` merges and clamps them (a non-finite `gridSize` is a `TypeError`, a `relativeScaleRange` that is not `0 < min <= 1 <= max` is a `RangeError`). The model records per-plane diagnostics, which `localNormalizationSummary(model)` reduces to a compact record that is cheap to keep for every frame of a stack, `isLocalNormalizationFallback(model)` says whether any plane fell back and `localNormalizationFailureReason(model)` returns the first reason (`'no-valid-overlap'`, `'invalid-global-solution'`, `'insufficient-valid-cells'`, `'insufficient-spatial-coverage'` or `'surface-fit-failed'`). The lower-level `fitLocalNormalizationRaw` and `applyLocalNormalizationInPlace` take raw buffers and a validity mask, and applying a model to an image of another geometry is an `Error`. The fit needs a smooth residual and clean sky: a nebula that fills the frame, or frames that are not registered, will be modeled as gradient.

```ts
import { applyLocalNormalization, DEFAULT_LOCAL_NORMALIZATION_OPTIONS, fitLocalNormalization, isLocalNormalizationFallback, localNormalization, localNormalizationFailureReason, localNormalizationSummary, resolveLocalNormalizationOptions } from 'nebulosa/src/imaging/processing/normalization'
import type { Image } from 'nebulosa/src/imaging/model/types'

const width = 320
const height = 320

let seed = 7
const noise = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0
	return (seed / 0xffffffff - 0.5) * 0.004
}

const make = (value: (x: number, y: number) => number): Image => {
	const raw = new Float64Array(width * height)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = value(x, y)
	return { header: {}, raw, metadata: { width, height, channels: 1, pixelCount: raw.length, stride: width, strideInBytes: width * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined } }
}

// A reference with a faint structure and noise, and a frame with the same signal plus a sky gradient from 0 to 0.1 across the field.
const structure = (x: number, y: number) => 0.1 + 0.02 * Math.sin(x / 30) * Math.cos(y / 25)
const reference = make((x, y) => structure(x, y) + noise())
const frame = () => make((x, y) => structure(x, y) + 0.1 * (x / (width - 1)) + noise())
const rms = (image: Image) => Math.sqrt(image.raw.reduce((sum, value, i) => sum + (value - reference.raw[i]) ** 2, 0) / image.raw.length)
console.log(rms(frame())) // 0.0579 (the RMS difference to the reference before the correction)

// Fit and apply in one step: the RMS difference to the reference falls from 0.058 to about 0.007, what the smooth fit leaves of the structure.
const result = localNormalization(reference, frame())
console.log(result.applied, rms(result.image)) // true 0.00715
console.log(result.model.width, result.model.height, result.model.channelCount, result.model.estimator, result.model.surfaceModel, result.model.fallback) // 320 320 1 'background-scale' 'polynomial' 'global' (the fallback policy)
console.log(localNormalizationSummary(result.model)) // 256 candidate and accepted cells, 0 rejected, 0 scale cells (offset only, residual 0.00696), fallback false
console.log(isLocalNormalizationFallback(result.model), localNormalizationFailureReason(result.model)) // false undefined

// The two steps apart: the model is tied to the grid, and it can be applied to another frame of the same geometry.
const model = fitLocalNormalization(reference, frame(), { gridSize: 8, offsetDegree: 2 })
const other = applyLocalNormalization(frame(), model)
console.log(rms(other), model.diagnostics[0].acceptedCells, model.diagnostics[0].scaleCells) // 0.00716 64 0 (a gridSize of 8 gives 64 cells)

// A validity mask excludes pixels from the fit and leaves them untouched in the output (the first 64 rows), so the RMS over the whole frame stays higher.
const mask = new Uint8Array(width * height).fill(1)
for (let y = 0; y < 64; y++) for (let x = 0; x < width; x++) mask[y * width + x] = 0
const original = frame()
const masked = localNormalization(reference, frame(), { validityMask: mask })
console.log(masked.image.raw[0] !== original.raw[0], rms(masked.image)) // true 0.0266

// A frame without any valid pixel cannot be modeled: the policies are global, identity and reject.
const empty = new Uint8Array(width * height)
for (const fallback of ['global', 'identity', 'reject'] as const) {
	const failed = localNormalization(reference, frame(), { validityMask: empty, fallback })
	console.log(fallback, failed.applied, localNormalizationFailureReason(failed.model), rms(failed.image)) // global true 'no-valid-overlap' 0.0578 (the anchor is applied), identity true 'no-valid-overlap' 0.0578 (left alone), reject false 'no-valid-overlap' 0.0578 (nothing applied)
}

// An RGB image can use a single luminance model.
const color: Image = { header: {}, raw: new Float64Array(width * height * 3), metadata: { width, height, channels: 3, pixelCount: width * height, stride: width * 3, strideInBytes: width * 24, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined } }
for (let i = 0; i < width * height; i++) for (let c = 0; c < 3; c++) color.raw[i * 3 + c] = reference.raw[i] * (1 + 0.1 * c)
const colorModel = fitLocalNormalization(color, color, { colorMode: 'luminance' })
console.log(colorModel.channelCount, colorModel.diagnostics.length) // 3 1 (a luminance model has one plane)

console.log(resolveLocalNormalizationOptions({ gridSize: 4.9, relativeScaleRange: [0.5, 2] }).gridSize, DEFAULT_LOCAL_NORMALIZATION_OPTIONS.gridSize, DEFAULT_LOCAL_NORMALIZATION_OPTIONS.fallback) // 4 16 'global' (a gridSize of 4.9 is truncated)
for (const run of [() => resolveLocalNormalizationOptions({ gridSize: Number.NaN }), () => resolveLocalNormalizationOptions({ relativeScaleRange: [1.5, 2] }), () => applyLocalNormalization(color, model)]) {
	try {
		run()
	} catch (e) {
		console.log((e as Error).message) // gridSize must be a finite number, relativeScaleRange must satisfy 0 < min <= 1 <= max, and local normalization model geometry (320x320x1) does not match image (320x320x3)
	}
}
```

### Multiscale Linear Transform

`multiscaleLinearTransform(image, options?)` is the redundant à trous wavelet transform (undecimated, so every layer has the size of the image) with a cubic B-spline scaling function, the five-tap kernel `[1, 4, 6, 4, 1] / 16` applied along each axis and dilated by `2^layer` (the `step` between taps) on layer `layer`. It decomposes an `Image` (see Scientific Image Model; mono or interleaved color, `Float32Array` or `Float64Array`) into `layers` detail layers, `detail_k = smooth_k - smooth_(k+1)`, and a smooth residual, changes the coefficients of each layer and adds everything back, in place, returning the same image; with the default options the reconstruction is the original image up to floating-point rounding. The values are not clamped, so the result keeps its signed range and a sharpened or denoised image can leave 0..1. Layer 0 holds the finest detail (about 1 to 2 pixels) and each following layer doubles the scale, so the layers are, roughly, noise and small stars, then larger stars and fine structure, then nebulosity, and the residual is the large-scale background. The number of layers is limited to `ceil(log2(max(width, height)))`, since beyond that the kernel is larger than the image; `layers` of zero (or a one-pixel image) returns the image untouched.

The `options` are `layers` (3 by default, a non-finite value takes the default and a fraction is truncated), `residualGain` (a gain applied to the smooth residual, 1 by default, 0 removes the large-scale component) and `detailLayers`, an array indexed from the finest layer of partial `MultiscaleLinearTransformLayerOptions`: `threshold`, the denoise limit as a multiple of the robust standard deviation of the layer (the median absolute coefficient times 1.4826, per channel, falling back to the RMS when the median is zero), `amount`, the fraction in 0..1 that is removed from the coefficients at or below that limit (1 by default), and `bias`, so that the coefficients are multiplied by `1 + bias` (a positive bias sharpens the layer, a negative one softens it, -1 removes it). Values that are not finite take the default, a negative threshold is zero and the amount is clamped to 0..1. `DEFAULT_MLT_OPTIONS` and `DEFAULT_MLT_LAYER_OPTIONS` hold the defaults, and a layer is denoised only when both `threshold` and `amount` are positive. The helpers shared with the median transform (`resolveMultiscaleLayers`, `resolveMultiscaleResidualGain`, `resolveMultiscaleLayer`, `multiscaleNeedsDenoise` and `multiscaleDetailScales`) live in `imaging/processing/multiscale`; the last one throws a `RangeError` for inconsistent buffers or workspaces. Memory is three copies of the buffer and, for the denoising, one workspace of `pixelCount` values. The transform is linear in the image only without the denoise threshold, which is a soft per-coefficient decision.

```ts
import { DEFAULT_MLT_LAYER_OPTIONS, DEFAULT_MLT_OPTIONS, multiscaleLinearTransform } from 'nebulosa/src/imaging/processing/mlt'
import { multiscaleDetailScales, multiscaleNeedsDenoise, resolveMultiscaleLayer, resolveMultiscaleLayers, resolveMultiscaleResidualGain } from 'nebulosa/src/imaging/processing/multiscale'
import type { Image } from 'nebulosa/src/imaging/model/types'

let seed = 99
const noise = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0
	return (seed / 0xffffffff - 0.5) * 0.02
}

// A 32x32 image (the same noise at every call): a background of 0.2 with noise, a faint ramp (large scale) and a star of 0.5 at (16, 16).
const make = (precision: 32 | 64 = 64): Image => {
	seed = 99
	const width = 32
	const height = 32
	const raw = precision === 64 ? new Float64Array(width * height) : new Float32Array(width * height)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) raw[y * width + x] = 0.2 + 0.1 * (x / width) + noise() + 0.5 * Math.exp(-((x - 16) ** 2 + (y - 16) ** 2) / 4)
	}
	return { header: {}, raw, metadata: { width, height, channels: 1, pixelCount: width * height, stride: width, strideInBytes: (width * precision) / 8, pixelSizeInBytes: precision / 8, bitpix: precision === 64 ? -64 : -32, bayer: undefined } }
}
const maxDifference = (a: Image, b: Image) => a.raw.reduce((worst, value, i) => Math.max(worst, Math.abs(value - b.raw[i])), 0)
const reference = make()
const star = 16 * 32 + 16

// The default options reconstruct the image (the layers and the residual add up to the original).
const same = multiscaleLinearTransform(make())
console.log(same.raw[star] === make().raw[star], maxDifference(same, reference) < 1e-12) // true true

// Sharpening the finest layers: bias +1 doubles the coefficients of the layers 0 and 1, and the star peak rises.
const sharp = multiscaleLinearTransform(make(), { layers: 4, detailLayers: [{ bias: 1 }, { bias: 1 }] })
console.log(reference.raw[star], sharp.raw[star]) // 0.752 1.118 (the star peak before and after)

// Removing the finest layer (bias -1) smooths the noise: compare the spread of a flat corner before and after.
const spread = (image: Image) => {
	let sum = 0
	let sumSquares = 0
	for (let y = 0; y < 8; y++) for (let x = 24; x < 32; x++) ((sum += image.raw[y * 32 + x]), (sumSquares += image.raw[y * 32 + x] ** 2))
	return Math.sqrt(sumSquares / 64 - (sum / 64) ** 2)
}
const soft = multiscaleLinearTransform(make(), { layers: 3, detailLayers: [{ bias: -1 }] })
console.log(spread(reference), spread(soft)) // 0.00936 0.00754 (the standard deviation of the corner before and after)

// A denoise threshold of 3 sigma with a full amount removes the small coefficients of the first layer but keeps the star.
const denoised = multiscaleLinearTransform(make(), { layers: 3, detailLayers: [{ threshold: 3, amount: 1 }] })
console.log(spread(denoised), denoised.raw[star] > 0.5) // 0.00754 true (the thresholded layer gives the same spread as the removed one here)

// The residual gain scales the large-scale component: 0 removes the background, so the mean falls.
const mean = (image: Image) => image.raw.reduce((sum, value) => sum + value, 0) / image.raw.length
console.log(mean(reference), mean(multiscaleLinearTransform(make(), { layers: 5, residualGain: 0 })), mean(multiscaleLinearTransform(make(), { layers: 5, residualGain: 2 }))) // 0.2543 -0.0013 0.5100 (the mean with the background removed and doubled)

// No layers is a no-op, a Float32 image is processed in its own precision and the layer count is limited by the image size.
console.log(multiscaleLinearTransform(make(), { layers: 0 }).raw[star] === reference.raw[star], multiscaleLinearTransform(make(32), { layers: 100 }).raw.constructor.name) // true 'Float32Array'

// The option helpers.
console.log(DEFAULT_MLT_OPTIONS, DEFAULT_MLT_LAYER_OPTIONS) // { layers: 3, detailLayers: [], residualGain: 1 } { threshold: 0, amount: 1, bias: 0 }
console.log(resolveMultiscaleLayers(2.7, 3), resolveMultiscaleLayers(Number.NaN, 3), resolveMultiscaleLayers(-4, 3), resolveMultiscaleResidualGain(undefined, 1)) // 2 3 0 1
console.log(resolveMultiscaleLayer({ threshold: -1, amount: 5, bias: 0.5 }, DEFAULT_MLT_LAYER_OPTIONS), multiscaleNeedsDenoise([{}, { threshold: 2 }], 2, DEFAULT_MLT_LAYER_OPTIONS)) // { threshold: 0, amount: 1, gain: 1.5 } true

// The robust per-channel scale of the detail between a buffer and its smoothed version.
const current = Float64Array.from([0, 1, 0, -1, 0, 1, 0, -1])
const smooth = new Float64Array(8)
console.log(multiscaleDetailScales(current, smooth, 1, new Float64Array(8), new Float64Array(1))) // [0.7413] (1.4826 times the median absolute coefficient of 0.5)
try {
	multiscaleDetailScales(current, smooth, 1, new Float64Array(4), new Float64Array(1))
} catch (e) {
	console.log((e as Error).message) // invalid multiscale detail workspaces
}
```

### Multiscale Median Transform

`multiscaleMedianTransform(image, options?)` is the median counterpart of the Multiscale Linear Transform, similar to the multiscale median transform of PixInsight. It has the same decomposition and the same options (`layers`, `residualGain` and `detailLayers` with `threshold`, `amount` and `bias`, resolved by the shared helpers of `imaging/processing/multiscale`), but each smoothed layer is a sliding square median of radius `2^layer` pixels (windows of 3x3, 5x5, 9x9 and so on, truncated at the borders) instead of the B-spline, so `detail_k = smooth_k - smooth_(k+1)` where `smooth_(k+1)` is the median of `smooth_k`. The median does not blur the edges and ignores isolated outliers, so the layers are better suited to the separation of structure from noise and stars from a smooth background, and the detail of a small bright object is not spread to its surroundings; the price is a transform that is not linear even without thresholds and a layer whose coefficients are not exactly zero-mean. As in the linear transform, the image (mono or interleaved color, `Float32Array` or `Float64Array`, see Scientific Image Model) is modified in place and returned, nothing is clamped, with the default options the reconstruction is the original, and `layers` of zero returns the image untouched.

The median is computed with a quantized Huang-style histogram: each channel is quantized with 14 bits between its minimum and maximum, and a two-level (fine and coarse) histogram is updated as the window slides, so the cost per pixel does not depend on the radius beyond the update of one window column. The quantization is the precision limit of each median: it is exact to 1 / 16383 of the range of the channel, so an image with a very large dynamic range (a bright star over a faint background) has a coarser median of the background and a layer split that is correspondingly coarse, although the layers still add up exactly to the image (the sum telescopes). A constant channel is returned as it is. `DEFAULT_MMT_OPTIONS` and `DEFAULT_MMT_LAYER_OPTIONS` are the same defaults as the linear transform (three layers, unit residual gain, no denoise, unit gain), and the denoise limit is `threshold` times the robust standard deviation of the layer, as there.

```ts
import { DEFAULT_MMT_LAYER_OPTIONS, DEFAULT_MMT_OPTIONS, multiscaleMedianTransform } from 'nebulosa/src/imaging/processing/mmt'
import type { Image } from 'nebulosa/src/imaging/model/types'

let seed = 99
const noise = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0
	return (seed / 0xffffffff - 0.5) * 0.02
}

// A 32x32 image (the same noise at every call): a background of 0.2 with noise, a faint ramp and a star of 0.5 at (16, 16).
const make = (precision: 32 | 64 = 64, channels = 1): Image => {
	seed = 99
	const width = 32
	const height = 32
	const raw = precision === 64 ? new Float64Array(width * height * channels) : new Float32Array(width * height * channels)
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			for (let c = 0; c < channels; c++) raw[(y * width + x) * channels + c] = 0.2 + 0.1 * (x / width) + noise() + 0.5 * Math.exp(-((x - 16) ** 2 + (y - 16) ** 2) / 4)
		}
	}
	return { header: {}, raw, metadata: { width, height, channels, pixelCount: width * height, stride: width * channels, strideInBytes: (width * channels * precision) / 8, pixelSizeInBytes: precision / 8, bitpix: precision === 64 ? -64 : -32, bayer: undefined } }
}
const maxDifference = (a: Image, b: Image) => a.raw.reduce((worst, value, i) => Math.max(worst, Math.abs(value - b.raw[i])), 0)
const reference = make()
const star = 16 * 32 + 16

// The default options reconstruct the image: the layers and the residual add up to it.
const same = multiscaleMedianTransform(make())
console.log(maxDifference(same, reference) < 1e-12, same === same) // true true

// Removing the finest layer (bias -1) lowers the spread of the noise; the star loses its finest-scale detail and so part of its peak.
const spread = (image: Image) => {
	let sum = 0
	let sumSquares = 0
	for (let y = 0; y < 8; y++) for (let x = 24; x < 32; x++) ((sum += image.raw[y * 32 + x]), (sumSquares += image.raw[y * 32 + x] ** 2))
	return Math.sqrt(sumSquares / 64 - (sum / 64) ** 2)
}
const soft = multiscaleMedianTransform(make(), { layers: 3, detailLayers: [{ bias: -1 }] })
console.log(spread(reference), spread(soft), reference.raw[star], soft.raw[star]) // 0.00936 0.00784 0.752 0.629 (spread before and after, star peak before and after)

// Sharpening the second layer, and a thresholded denoise of the first.
const sharp = multiscaleMedianTransform(make(), { layers: 4, detailLayers: [{}, { bias: 1 }] })
const denoised = multiscaleMedianTransform(make(), { layers: 3, detailLayers: [{ threshold: 3, amount: 1 }] })
console.log(sharp.raw[star], spread(denoised), denoised.raw[star] > 0.5) // 0.985 0.00784 true (the star peak after sharpening layer 1, the spread after the denoise, the star kept)

// The residual gain scales the large-scale component of the last layer.
const mean = (image: Image) => image.raw.reduce((sum, value) => sum + value, 0) / image.raw.length
console.log(mean(reference), mean(multiscaleMedianTransform(make(), { layers: 5, residualGain: 0 })), mean(multiscaleMedianTransform(make(), { layers: 5, residualGain: 2 }))) // 0.2543 0.0036 0.5051 (the mean with the large-scale component removed and doubled)

// Color images are processed channel by channel; Float32 stays Float32; a constant image is a fixed point; no layers is a no-op.
const color = multiscaleMedianTransform(make(64, 3), { layers: 2, detailLayers: [{ bias: -1 }] })
console.log(color.raw.length, color.raw[star * 3] > 0.5) // 3072 true (3 channels x 1024 pixels)
console.log(multiscaleMedianTransform(make(32)).raw.constructor.name, multiscaleMedianTransform(make(), { layers: 0 }).raw[star] === reference.raw[star]) // Float32Array true
const constant = make()
constant.raw.fill(0.25)
console.log(multiscaleMedianTransform(constant, { layers: 3 }).raw.every((value) => Math.abs(value - 0.25) < 1e-12)) // true
console.log(DEFAULT_MMT_OPTIONS, DEFAULT_MMT_LAYER_OPTIONS) // { layers: 3, detailLayers: [], residualGain: 1 } { threshold: 0, amount: 1, bias: 0 }
```

### Photon Transfer and Read Noise

The temporal part of the sensor characterization works on pairs of frames in digital numbers (DN). Two frames taken under the same conditions differ only by their temporal noise, so `measureSensorPair(first, second, options?)` reduces a pair to a `SensorPairStatistics`: the `mean` of the two frame means (DN), the temporal `variance` (DN squared, the population variance of the difference divided by 2, which cancels the fixed pattern), the signed `drift` between the frame means, the `sampleCount` of finite unmasked samples, the `rejectedCount`, and the `saturatedCount` and `clippedFraction` of the samples at or above the optional `digitalClip`. The frames must be `DigitalImage` values (see Scientific Image Loading and Export), undebayered single-channel and with the same geometry, and `options` selects an inclusive-exclusive integer `area`, the `plane` of a CFA mosaic (`'red'`, `'green1'`, `'green2'` or `'blue'`, with the integer `cfaOffset` of the origin; `'mono'` otherwise) and a `mask` of `width * height` bytes whose nonzero entries are skipped. `aggregateSensorPairs(pairs)` combines independent pair reports weighted by their sample counts and adds the `pairCount` and the scatter between pairs (`meanScatter` in DN squared, `varianceScatter` in DN to the fourth power).

`measureSensorReadNoise(pairs, conversionGain?, quantizationStep?)` turns the pairs of short dark or bias frames into a `SensorReadNoise`: the RMS noise in DN (`digital`), the `deviation` of the per-pair RMS, and, when the `conversionGain` (electrons per DN) is positive, `totalElectrons` (including the quantization noise) and, when the `quantizationStep` (DN) is also given, `sensorElectrons` after removing the uniform quantization noise `step^2 / 12`. `fitPhotonTransferGain(points, range?)` fits the photon transfer curve (variance against signal, with a free intercept) to the valid, unclipped `PhotonTransferPoint` values whose signal lies in the fraction `range` of the largest valid signal (`[0.05, 0.7]` by default, a `RangeError` for a range that is not increasing within 0..1), and returns `[points, gain]`: the points annotated with `selectedForGainFit` and the `fitRejectionReasons` (`'invalidPoint'`, `'nonPositiveSignal'`, `'nonPositiveVariance'`, `'clipped'`, `'outsideFitRange'`, `'insufficientSamples'`), and a `SensorGain` with the `system` gain in DN per electron (the slope), the `conversion` gain in electrons per DN (its inverse), the `intercept` in DN squared, the weighted regression report `fit` and the signal `range` that was fitted, or `undefined` when fewer than two points are selected, they all have the same signal or the slope is not positive. This is the shot-noise model, in which the variance of a Poisson signal in DN is the signal times the system gain, so it does not hold for a sensor that is not linear or whose variance includes a pixel-response non-uniformity that was not removed.

`characterizeSensorTemporal(bias, flats, options?)` runs the whole chain for one plane and returns `{ bias, photonTransfer, gain, readNoise }`. `bias` is a `SensorFrameSet` of the shortest exposures and `flats` a list of `SensorFlatFrameSet` at increasing illumination, each optionally with its own `darkFrames` at the same exposure (otherwise the bias pair aggregate is the reference). Each flat gives a point with the dark-corrected `signal` and `variance`, the `snr`, the clipped fraction and a `stimulus` (the `photons` when every level has them, otherwise the exposure times the relative `intensity`), the points are sorted by signal, and the read noise is taken from the bias pairs with the gain found. Every set needs at least one complete pair, a frame of another size or CFA pattern is rejected with a `RangeError`, and an odd last frame of a set is not used. The options are those of a pair plus `gainRange`. All the numbers returned are finite or omitted.

```ts
import { aggregateSensorPairs, measureSensorPair } from 'nebulosa/src/imaging/analysis/sensor/pair'
import { characterizeSensorTemporal, fitPhotonTransferGain, measureSensorReadNoise } from 'nebulosa/src/imaging/analysis/sensor/ptc'
import type { SensorFlatFrameSet, SensorFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

const digital = (raw: Float64Array): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 4 },
	raw,
	metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// A pair with an exact mean and temporal variance: the frames differ by +-sqrt(2 variance) / 2 about the mean.
const pair = (mean: number, variance: number): [DigitalImage, DigitalImage] => {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(16)
	const second = new Float64Array(16)
	for (let i = 0; i < 16; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}
	return [digital(first), digital(second)]
}

// One pair: its mean, temporal variance, drift (the second frame is 2 DN brighter) and the clipped fraction at a clip of 1002 DN.
const [a, b] = pair(1000, 4)
b.raw.forEach((value, i) => (b.raw[i] = value + 2))
const one = measureSensorPair(a, b, { digitalClip: 1002 })
console.log(one.mean, one.variance, one.drift, one.sampleCount, one.saturatedCount, one.clippedFraction) // 1001 4 -2 16 8 0.5 (the variance prints as 4.000000000000065)

// A mask and a region of interest reduce the samples, and the aggregate of two pairs weights them by their sample counts.
const mask = new Uint8Array(16)
mask[0] = 1
const masked = measureSensorPair(...pair(1000, 4), { mask, area: { left: 0, top: 0, right: 4, bottom: 2 } })
console.log(masked.sampleCount, masked.rejectedCount) // 7 1
const total = aggregateSensorPairs([measureSensorPair(...pair(1000, 4)), measureSensorPair(...pair(1002, 6))])
console.log(total.mean, total.variance, total.pairCount, total.meanScatter, total.varianceScatter) // 1001 5 2 1 1 (rounded: the variance prints as 4.999999999999901)

// Read noise from bias pairs: 2 DN RMS, 4 electrons at 2 e-/DN, and 3.96 after the quantization noise of a 1 DN step.
const biasPairs = [measureSensorPair(...pair(1000, 4)), measureSensorPair(...pair(1000, 4))]
console.log(measureSensorReadNoise(biasPairs)) // { digital: 2, totalElectrons: undefined, sensorElectrons: undefined, pairCount: 2, deviation: 0 } (2.000000000000016 DN)
console.log(measureSensorReadNoise(biasPairs, 2, 1)) // { digital: 2, totalElectrons: 4, sensorElectrons: 3.958, pairCount: 2, deviation: 0 }

// A photon transfer set: the variance is 4 DN^2 of read noise plus 0.5 DN per DN of signal, so the system gain is 0.5 DN/e- and the conversion gain 2 e-/DN.
const bias: SensorFrameSet = { frames: pair(1000, 4), exposure: 0 }
const flats: SensorFlatFrameSet[] = [100, 400, 800, 1600, 3200, 6400].map((signal, level) => ({ frames: pair(1000 + signal, 4 + 0.5 * signal), darkFrames: pair(1000, 4), exposure: level + 1 }))
const result = characterizeSensorTemporal(bias, flats, { digitalClip: 60000 })
console.log(result.gain?.system, result.gain?.conversion, result.gain?.intercept, result.gain?.range, result.gain?.fit.r2) // 0.5 2 0 [ 400, 3200 ] 1 (the intercept prints as 3.5e-12 DN^2: the read noise is not in it because the dark pair variance is subtracted)
console.log(result.bias, result.readNoise) // { mean: 1000, drift: 0, sampleCount: 16 } { digital: 2, totalElectrons: 4, sensorElectrons: 3.958, pairCount: 1, deviation: 0 }
console.log(result.photonTransfer.map((point) => [point.signal, point.variance, point.selectedForGainFit, point.fitRejectionReasons.join('|')])) // [ [ 100, 50, false, 'outsideFitRange' ], [ 400, 200, true, '' ], [ 800, 400, true, '' ], [ 1600, 800, true, '' ], [ 3200, 1600, true, '' ], [ 6400, 3200, false, 'outsideFitRange' ] ]
console.log(result.photonTransfer[2].snr, result.photonTransfer[2].stimulus) // 39.80 3 (the stimulus is the exposure of the level, as the levels have no photons)

// The gain fit alone, with a narrower range that rejects the faint and bright levels.
const [points, gain] = fitPhotonTransferGain(result.photonTransfer, [0.1, 0.3])
console.log(
	points.map((point) => point.selectedForGainFit),
	gain?.system,
) // [ false, false, true, true, false, false ] 0.5

// With a single usable level the gain is undefined, and an invalid range is rejected.
console.log(fitPhotonTransferGain(result.photonTransfer.slice(0, 1))[1])
try {
	fitPhotonTransferGain(result.photonTransfer, [0.5, 0.2])
} catch (e) {
	console.log((e as Error).message) // gain range must be an increasing fraction within 0..1
}
```

### Pixel Sigma Clipping and Background Levels

### PSF Filter

`psf(image)` applies the point-spread-function matched filter of the KStars internal guider: a fixed 9x9 stencil (radius 4 pixels) that responds to a star-sized peak and rejects a flat background. The stencil is the sum of rings around the pixel with the weights of KStars (1 for the center, 0.678 for the four nearest neighbours, down to 0.02 for the outermost ring) minus a constant outer weight that makes the sum of all the weights zero, so a uniform region gives 0 (up to rounding) and the result is not a brightness image: it is positive on a star, around zero on the sky and negative next to bright structure. The image is modified in place and the same object is returned; each channel of an RGB image is filtered on its own, the four-pixel border keeps the original values (the stencil does not fit there), and an image smaller than 9x9 is returned unchanged. The image must be a dense mono or interleaved RGB intensity image: a raw CFA mosaic, a stride or buffer that does not agree with the geometry, or a channel count other than 1 or 3 throws an `Error`, because a mosaic has to be converted to a coherent intensity image first. The work is linear in the number of samples, with a sliding sum for the 81 values and a small row buffer.

```ts
import { psf } from 'nebulosa/src/imaging/processing/psf'
import type { Image } from 'nebulosa/src/imaging/model/types'

const size = 21
const frame = (channels: 1 | 3, value: (x: number, y: number, channel: number) => number): Image => {
	const raw = new Float64Array(size * size * channels)
	for (let y = 0, i = 0; y < size; y++) for (let x = 0; x < size; x++) for (let c = 0; c < channels; c++, i++) raw[i] = value(x, y, c)
	return {
		header: { SIMPLE: true, BITPIX: -64, NAXIS: channels === 1 ? 2 : 3, NAXIS1: size, NAXIS2: size },
		metadata: { width: size, height: size, channels, pixelCount: size * size, stride: size * channels, strideInBytes: size * channels * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
		raw,
	}
}

// A flat background gives 0 inside the image and the border is left alone.
const flat = psf(frame(1, () => 0.2))
console.log(Math.abs(flat.raw[10 * size + 10]) < 1e-12, flat.raw[0], flat.raw[3 * size + 3], Math.abs(flat.raw[4 * size + 4]) < 1e-12) // true 0.2 0.2 true

// A star (a Gaussian of sigma 1.2 pixels, at (10, 10)) on that background: the response peaks on its center and goes negative a few pixels away.
const star = (x: number, y: number) => 0.2 + 0.6 * Math.exp(-((x - 10) ** 2 + (y - 10) ** 2) / (2 * 1.2 * 1.2))
const filtered = psf(frame(1, star))
console.log(Array.from(filtered.raw.slice(10 * size + 5, 10 * size + 16), (value) => Number(value.toFixed(3)))) // [ -0.155, -0.225, 0.004, 0.699, 1.595, 2.024, 1.595, 0.699, 0.004, -0.225, -0.155 ]
console.log(filtered.raw[10 * size + 10] > filtered.raw[10 * size + 9], filtered.raw[10 * size + 10] > filtered.raw[10 * size + 14]) // true true

// The same star in the three channels, with different amplitudes: each channel is filtered on its own.
const color = psf(frame(3, (x, y, c) => 0.1 + ((c + 1) / 3) * 0.6 * Math.exp(-((x - 10) ** 2 + (y - 10) ** 2) / (2 * 1.2 * 1.2))))
const center = (10 * size + 10) * 3
console.log(Array.from(color.raw.slice(center, center + 3), (value) => Number(value.toFixed(3)))) // [ 0.675, 1.35, 2.024 ] (proportional to the amplitudes 0.2, 0.4 and 0.6)

// A frame smaller than the stencil is returned untouched.
const tiny = frame(1, () => 0.5)
const small: Image = { ...tiny, metadata: { ...tiny.metadata, width: 5, height: 5, pixelCount: 25, stride: 5 }, raw: new Float64Array(25).fill(0.5) }
console.log(psf(small) === small, small.raw[12]) // true 0.5

// A raw mosaic is rejected.
try {
	psf({ ...tiny, metadata: { ...tiny.metadata, bayer: 'RGGB' } })
} catch (e) {
	console.log((e as Error).message) // PSF filtering requires a non-CFA intensity image
}
```

### Scalar Surface Fitting

### Scientific Image Loading and Export

The readers turn a FITS, XISF or JPEG source into an `Image` (or a `DigitalImage`, see Scientific Image Model) and the writers serialize an `Image` back. A reader takes either the legacy positional `raw` argument (an existing `Float32Array` or `Float64Array`, or the precision `32`, `64` or `'auto'`, which is a 32-bit buffer for 8-bit sources and a 64-bit one for the others) or an options object `{ raw, sampleScale }`, where `sampleScale: 'digital'` keeps the digital numbers after the scaling of the format, and the default `'normalized'` rescales a source whose samples are outside 0..1 by its minimum and maximum. A buffer supplied by the caller is reused (the image is a view of its first samples) and must have room for `width * height * channels` samples; a smaller one makes the reader return `undefined`, as does a source that is not an image, and JPEG has no digital mode. The first HDU that is a Rice-compressed image or an uncompressed 2-D IMAGE or primary raster is the one that is read.

The readers differ in what they receive: `readImageFromFits(fits, source, options)` and `readImageFromXisf(xisf, source, options)` take the already parsed container together with its seekable source, `readImageFromJpeg(buffer, raw, format)` takes the bytes of a JPEG (the optional TurboJPEG pixel `format`, such as `'GRAY'` or `'RGB'`, forces the channels), and `readImageFromSource`, `readImageFromBuffer`, `readImageFromFileHandle` and `readImageFromPath` detect FITS, XISF or JPEG by their content. The writers are `writeImageToFormat(image, 'jpeg', options)`, which returns a JPEG `Buffer` (the samples are scaled from 0..1 to 0..255 and clamped, with the `quality` of 0 to 100 and the `chrominanceSubsampling`, 100 and `'4:4:4'` by default), `writeImageToFits(image, output)` and `writeImageToXisf(image, output, format)`, where the output is a `Buffer` that must be large enough, or any `Sink`, and the XISF `format` has the `byteOrder` (`'little'` by default), the `pixelStorage` (`'Planar'` by default) and the `compression` (`false` by default). `truncatePixel(p, max)` is the helper that maps a normalized sample to an integer from 0 to `max`.

```ts
import { readImageFromBuffer, readImageFromFileHandle, readImageFromFits, readImageFromJpeg, readImageFromPath, readImageFromSource, readImageFromXisf, truncatePixel, writeImageToFits, writeImageToFormat, writeImageToXisf } from 'nebulosa/src/imaging/model/image'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { readFits } from 'nebulosa/src/io/formats/fits/fits'
import { readXisf } from 'nebulosa/src/io/formats/xisf/xisf'
import { bufferSink, bufferSource } from 'nebulosa/src/io/io'
import fs from 'fs/promises'

// By path: the format is detected from the content, and 'auto' gives a 64-bit buffer for a 16-bit file.
const image = (await readImageFromPath('data/NGC3372-16.3.fit'))!
console.log(image.metadata.width, image.metadata.height, image.metadata.channels, image.raw.constructor.name) // 1037 706 3 Float64Array

// The precision and the digital numbers.
console.log((await readImageFromPath('data/NGC3372-16.3.fit', 32))!.raw.constructor.name, (await readImageFromPath('data/NGC3372-8.1.fit'))!.raw.constructor.name) // Float32Array Float32Array
const digital = (await readImageFromPath('data/NGC3372-16.1.xisf', { sampleScale: 'digital', raw: 32 }))!
console.log(digital.sampleScale, digital.digitalRange, digital.quantizationStep, digital.raw.constructor.name) // digital [ 0, 65535 ] 1 Float32Array

// A buffer, a file handle and a source.
const bytes = Buffer.from(await Bun.file('data/NGC3372-16.1.fit').arrayBuffer())
console.log((await readImageFromBuffer(bytes))!.metadata.channels, (await readImageFromBuffer(Buffer.from('not an image'))) === undefined) // 1 true

const handle = await fs.open('data/NGC3372-16.1.xisf')
console.log((await readImageFromFileHandle(handle))!.metadata.width) // 1037
await handle.close()

console.log((await readImageFromSource(bufferSource(bytes), { raw: 64, sampleScale: 'normalized' }))!.raw.constructor.name) // Float64Array

// A caller buffer larger than the image is reused: the image is a view of its first samples.
const shared = new Float32Array(1037 * 706 + 10)
const reused = (await readImageFromBuffer(bytes, shared))!
console.log(reused.raw.length, reused.raw.buffer === shared.buffer) // 732122 true
console.log(await readImageFromBuffer(bytes, new Float32Array(10))) // undefined

// The parsed containers: the FITS HDUs, and the XISF images.
{
	await using source = fileHandleSource(await fs.open('data/NGC3372-16.3.fit'))
	const fits = (await readFits(source))!
	console.log(fits.hdus.length, (await readImageFromFits(fits, source, 32))!.metadata.channels) // 1 3
	console.log((await readImageFromFits(fits.hdus[0], source))!.metadata.height) // 706
}

{
	await using source = fileHandleSource(await fs.open('data/NGC3372-16.1.xisf'))
	const xisf = (await readXisf(source))!
	console.log((await readImageFromXisf(xisf, source))!.metadata.width) // 1037
	console.log((await readImageFromXisf(xisf.images[0], source, { sampleScale: 'digital' }))!.digitalRange) // [ 0, 65535 ]
}

// JPEG: normalized 8-bit samples, a layout chosen by the file or forced.
const jpeg = Buffer.from(await Bun.file('data/apod4.jpg').arrayBuffer())
const color = readImageFromJpeg(jpeg)!
console.log(color.metadata.width, color.metadata.height, color.metadata.channels, color.raw.constructor.name, color.header.NAXIS3) // 719 507 3 Float32Array 3
console.log(readImageFromJpeg(jpeg, 64, 'GRAY')!.metadata.channels, readImageFromJpeg(Buffer.from('JFIF?')) === undefined) // 1 true

// Writers: a JPEG at full or reduced quality, FITS and XISF in a buffer or a sink, and a round trip.
console.log(writeImageToFormat(image)!.length, writeImageToFormat(image, 'jpeg', { jpeg: { quality: 80, chrominanceSubsampling: '4:2:0' } })!.length) // 107146 18176

const fitsOut = Buffer.alloc(8e6)
await writeImageToFits(image, fitsOut)
const sink = bufferSink(Buffer.alloc(8e6))
await writeImageToFits(image, sink)
console.log(sink.position, (await readImageFromBuffer(fitsOut))!.raw[1000] === image.raw[1000]) // 4400640 true

const xisfOut = Buffer.alloc(8e6)
const size = await writeImageToXisf(image, xisfOut, { pixelStorage: 'Normal', compression: false })
console.log(size, Math.abs((await readImageFromBuffer(xisfOut.subarray(0, size)))!.raw[1000] - image.raw[1000]) < 1e-9) // 4396602 true

// truncatePixel: truncates and clamps.
console.log(truncatePixel(0.5, 255), truncatePixel(1.5, 255), truncatePixel(-1, 255), truncatePixel(0.999, 255)) // 127 255 0 254
```

### Scientific Image Model

Every imaging function works on an `Image`: a FITS-compatible `header`, the `metadata` that the header implies and a flat `raw` buffer (`Float32Array` or `Float64Array`) of the samples. The layout is row-major, with the origin at the first sample of the first row of the buffer and the channels of a pixel interleaved (`raw[(y * width + x) * channels + c]`, so `stride` is `width * channels`); an image has 1 (grayscale) or 3 (RGB) channels, or a single channel that is a color filter array mosaic when `metadata.bayer` is set. The samples of an `Image` are in a normalized full-scale unit, where 0..1 is the nominal range of an input, and the results of processing may leave that range. A `DigitalImage` is the read-only counterpart for measurements: its samples keep the digital numbers of the source after the scaling of the format (`BZERO` and `BSCALE` of FITS), with the representable `digitalRange` and the `quantizationStep` (both in DN, and only for integer sources). It is not an input of the writers, and `isImage` is `false` for it.

`ImageMetadata` has `width`, `height`, `channels`, `stride` (samples of a row), `pixelCount` (per channel), `strideInBytes` and `pixelSizeInBytes` (of the source), `bitpix` (the FITS code of the source) and `bayer`. The configuration types are the tuples that the operations share: `ImageChannel` (`'RED'`, `'GREEN'` or `'BLUE'`), `ImageChannelOrGray`, `GrayscaleAlgorithm` (`'BT709'`, `'RMY'`, `'Y'` or explicit weights), `CfaPattern` (the 2x2 tile read row by row, like `'RGGB'`), `ImageRawType`, `ImageRawPrecision` (`32`, `64` or `'auto'`) and the options of the readers and the writers. The helpers are `isImage(value)`, `channelIndex(channel)` (0 for red, gray or undefined, 1 for green, 2 for blue), `grayscaleFromChannel(channel)` (the weights of a channel or named algorithm, BT.709 by default), `makeImageRawTypedArray(source, size)` (a new zeroed buffer of the precision of a typed array or of 32 or 64), `cfaChannelAt(pattern, x, y)` (the channel 0, 1 or 2 of a raw coordinate, the pattern describing the origin of the buffer) and `shiftCfaPattern(pattern, offsetX, offsetY)` (the pattern of an image whose origin is moved by an integer offset of unbinned pixels, which throws a `RangeError` for a fraction), and the constants `BT709_GRAYSCALE`, `RMY_GRAYSCALE`, `Y_GRAYSCALE`, `RED_GRAYSCALE`, `GREEN_GRAYSCALE`, `BLUE_GRAYSCALE`, `DEFAULT_GRAYSCALE`, `GRAYSCALES` and `DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS`.

```ts
import { readImageFromPath } from 'nebulosa/src/imaging/model/image'
import {
	BLUE_GRAYSCALE,
	BT709_GRAYSCALE,
	cfaChannelAt,
	channelIndex,
	DEFAULT_GRAYSCALE,
	DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS,
	grayscaleFromChannel,
	GRAYSCALES,
	GREEN_GRAYSCALE,
	isImage,
	makeImageRawTypedArray,
	RED_GRAYSCALE,
	RMY_GRAYSCALE,
	shiftCfaPattern,
	Y_GRAYSCALE,
	type Image,
} from 'nebulosa/src/imaging/model/types'

// A color image of 16 bits per sample: 1037x706 pixels, three interleaved channels.
const image = (await readImageFromPath('data/NGC3372-16.3.fit'))!
console.log(image.metadata) // { width: 1037, height: 706, channels: 3, pixelCount: 732122, pixelSizeInBytes: 2, strideInBytes: 2074, stride: 3111, bitpix: 16, bayer: undefined }
console.log(image.raw.constructor.name, image.raw.length, image.header.BITPIX, image.header.NAXIS3) // Float64Array 2196366 16 3

// The value of the channel c of the pixel (x, y).
const x = 500
const y = 300
const green = image.raw[(y * image.metadata.width + x) * image.metadata.channels + channelIndex('GREEN')]
console.log(green >= 0 && green <= 1) // true (normalized samples)

// A DigitalImage keeps the digital numbers (here, a 16-bit unsigned range) and is not an Image.
const digital = (await readImageFromPath('data/NGC3372-16.3.fit', { sampleScale: 'digital' }))!
console.log(digital.sampleScale, digital.digitalRange, digital.quantizationStep, isImage(digital), isImage(image), isImage(undefined)) // digital [ 0, 65535 ] 1 false true false

// A gray image from a mosaic image: its metadata carries the CFA pattern.
const mosaic = (await readImageFromPath('data/GRBG-16.1.fit'))!
console.log(mosaic.metadata.channels, mosaic.metadata.bayer) // 1 GRBG

// The channels and the weights.
console.log(channelIndex('RED'), channelIndex('GREEN'), channelIndex('BLUE'), channelIndex('GRAY'), channelIndex()) // 0 1 2 0 0
console.log(grayscaleFromChannel(), grayscaleFromChannel('Y'), grayscaleFromChannel({ red: 1, green: 1, blue: 1 })) // BT.709, NTSC and the given weights
console.log(DEFAULT_GRAYSCALE === BT709_GRAYSCALE, GRAYSCALES.RMY === RMY_GRAYSCALE, GRAYSCALES.RED === RED_GRAYSCALE, GRAYSCALES.GREEN === GREEN_GRAYSCALE, GRAYSCALES.BLUE === BLUE_GRAYSCALE, GRAYSCALES.GRAY === DEFAULT_GRAYSCALE, Y_GRAYSCALE.green, BLUE_GRAYSCALE.blue) // true true true true true true 0.587 1
console.log(DEFAULT_WRITE_IMAGE_TO_FORMAT_OPTIONS) // { jpeg: { quality: 100, chrominanceSubsampling: "4:4:4" } }

// The CFA: the channel of each raw coordinate of an RGGB tile, and the pattern after a crop with an odd origin.
console.log(cfaChannelAt('RGGB', 0, 0), cfaChannelAt('RGGB', 1, 0), cfaChannelAt('RGGB', 0, 1), cfaChannelAt('RGGB', 1, 1), cfaChannelAt('RGGB', 3, 2)) // 0 1 1 2 1
console.log(shiftCfaPattern('RGGB', 1, 0), shiftCfaPattern('RGGB', 0, 1), shiftCfaPattern('RGGB', 1, 1), shiftCfaPattern('RGGB', 2, 4), shiftCfaPattern(undefined, 1, 1)) // GRBG GBRG BGGR RGGB undefined

try {
	shiftCfaPattern('RGGB', 0.5, 0)
} catch (e) {
	console.log((e as Error).message) // CFA offsets must be integers
}

// Zeroed buffers of a precision, or of the precision of another buffer.
console.log(makeImageRawTypedArray(32, 4), makeImageRawTypedArray(64, 2), makeImageRawTypedArray(new Float32Array(1), 3)) // Float32Array(4) [ 0, 0, 0, 0 ] Float64Array(2) [ 0, 0 ] Float32Array(3) [ 0, 0, 0 ]

// An Image of a 2x2 gray frame built by hand: the header has the geometry, the metadata derives from it.
const small: Image = {
	header: { SIMPLE: true, BITPIX: -32, NAXIS: 2, NAXIS1: 2, NAXIS2: 2 },
	metadata: { width: 2, height: 2, channels: 1, pixelCount: 4, stride: 2, strideInBytes: 8, pixelSizeInBytes: 4, bitpix: -32, bayer: undefined },
	raw: new Float32Array([0, 0.25, 0.5, 1]),
}

console.log(isImage(small), small.raw[1 * small.metadata.stride + 1]) // true 1
```

### SCNR

`scnr(image, channel?, amount?, method?)` is the Subtractive Chromatic Noise Reduction of PixInsight: it attenuates the excess of one color (green by default, `'RED'` and `'BLUE'` are also accepted) in an interleaved RGB image of normalized 0..1 samples, in place, and returns the same image. `amount` (0.5 by default) is the strength from 0 (nothing changes) to 1. The `method` decides how the other two channels protect the pixel: with `'MAXIMUM_MASK'` (the default) and `'ADDITIVE_MASK'` the selected channel `a` becomes `a (1 - amount)(1 - m) + m a`, where `m` is the larger of the other two channels, or their sum clipped to 1, so bright neighbours keep the value and dark ones let it be reduced. The `'AVERAGE_NEUTRAL'`, `'MAXIMUM_NEUTRAL'` and `'MINIMUM_NEUTRAL'` methods only touch the pixels where the selected channel is above the mean, the maximum or the minimum of the other two, and blend it toward that reference by `amount`. A mono image or an `amount` of 0 returns the image unchanged. The layout is validated (positive integer geometry, 1 or 3 channels, a `pixelCount` and `raw` length that agree, and a CFA mosaic must have one channel), and an `Error` is thrown otherwise. The function does not rebalance the other channels or the luminance, so the pixel gets darker where the cast is removed.

```ts
import { scnr } from 'nebulosa/src/imaging/processing/scnr'
import type { Image } from 'nebulosa/src/imaging/model/types'

// Three pixels: a green-cast sky, a neutral gray and a saturated green one.
const pixels = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 3, NAXIS1: 3, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 3, height: 1, channels: 3, pixelCount: 3, stride: 9, strideInBytes: 72, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0.1, 0.2, 0.1, 0.5, 0.5, 0.5, 0.05, 0.9, 0.05]),
})

const round = (values: ArrayLike<number>) => Array.from(values, (value) => Number(value.toFixed(4)))

// The defaults: green, 0.5 and the maximum mask.
console.log(round(scnr(pixels()).raw)) // [ 0.1, 0.11, 0.1, 0.5, 0.375, 0.5, 0.05, 0.4725, 0.05 ] (the gray pixel is attenuated by its own maximum mask)

// The protection methods with the full amount.
for (const method of ['MAXIMUM_MASK', 'ADDITIVE_MASK', 'AVERAGE_NEUTRAL', 'MAXIMUM_NEUTRAL', 'MINIMUM_NEUTRAL'] as const) {
	console.log(method, round(scnr(pixels(), 'GREEN', 1, method).raw).join(' ')) // one line per method: MAXIMUM_MASK gives 0.1 0.02 0.1 0.5 0.25 0.5 0.05 0.045 0.05, ADDITIVE_MASK 0.1 0.04 0.1 0.5 0.5 0.5 0.05 0.09 0.05, and the three neutral methods 0.1 0.1 0.1 0.5 0.5 0.5 0.05 0.05 0.05
}

// Another channel: a red-cast pixel (0.8, 0.3, 0.2) with the neutral methods.
const cast = (): Image => ({ ...pixels(), metadata: { ...pixels().metadata, width: 1, pixelCount: 1, stride: 3 }, raw: new Float64Array([0.8, 0.3, 0.2]) })
console.log(round(scnr(cast(), 'RED', 1, 'AVERAGE_NEUTRAL').raw), round(scnr(cast(), 'RED', 1, 'MAXIMUM_NEUTRAL').raw), round(scnr(cast(), 'RED', 0.5, 'MINIMUM_NEUTRAL').raw)) // [ 0.25, 0.3, 0.2 ] [ 0.3, 0.3, 0.2 ] [ 0.5, 0.3, 0.2 ]

// An amount of 0 and a mono image return the same object untouched.
const image = pixels()
console.log(scnr(image, 'GREEN', 0) === image, round(image.raw)) // true [ 0.1, 0.2, 0.1, 0.5, 0.5, 0.5, 0.05, 0.9, 0.05 ]
const mono: Image = { ...image, metadata: { ...image.metadata, channels: 1, stride: 3 }, raw: new Float64Array([0.1, 0.2, 0.3]) }
console.log(scnr(mono) === mono, round(mono.raw)) // true [ 0.1, 0.2, 0.3 ]

// A buffer that does not match the geometry is rejected.
try {
	scnr({ ...image, raw: new Float64Array(4) })
} catch (e) {
	console.log((e as Error).message) // image raw length does not match metadata: 4 != 9
}
```

### Screen Transfer Function

`stf(image, midtone?, shadow?, highlight?, options?)` applies the PixInsight screen transfer function (the midtones transfer function with shadows and highlights clipping) to the normalized 0..1 buffer of an `Image`, in place, and returns the same image. A sample at or below `shadow` becomes 0, at or above `highlight` becomes 1, and a value between them is rescaled to `d = (v - shadow) / (highlight - shadow)` and mapped by `(midtone - 1) d / ((2 midtone - 1) d - midtone)`, which sends the rescaled value equal to `midtone` to 0.5 (with the full range, `midtone` itself goes to 0.5). `midtone` below 0.5 brightens (the usual autostretch uses values around 0.1 to 0.25), above 0.5 darkens, and 0.5 is the identity. The three arguments are finite values in 0..1 with `shadow <= highlight` (a `RangeError` otherwise). The defaults (0.5, 0, 1) return the image without touching it, and a midtone of 1 sends everything below the highlight to 0.

`options.channel` selects what is transformed: `'RED'`, `'GREEN'` or `'BLUE'` transform only that channel of an RGB image, and any other value (the default `'GRAY'`) transforms every stored sample. The curve is evaluated exactly for each sample, with no lookup table, in a single pass, so it also applies to a Float64 buffer without quantization. The function does not estimate the parameters from the data (for that, see Display Stretch Parameter Estimation), and it destroys the linear data, so it is applied on a copy used for display.

```ts
import { DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS, stf } from 'nebulosa/src/imaging/processing/stf'
import type { Image } from 'nebulosa/src/imaging/model/types'

const ramp = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: 6, NAXIS2: 1 },
	metadata: { width: 6, height: 1, channels: 1, pixelCount: 6, stride: 6, strideInBytes: 48, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0, 0.02, 0.1, 0.25, 0.5, 1]),
})

const pixel = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 3, NAXIS1: 1, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 1, height: 1, channels: 3, pixelCount: 1, stride: 3, strideInBytes: 24, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0.1, 0.2, 0.4]),
})

const round = (values: ArrayLike<number>) => Array.from(values, (value) => Number(value.toFixed(4)))

// A midtone below 0.5 brightens the faint samples, and 0 and 1 stay fixed.
console.log(round(stf(ramp(), 0.15).raw)) // [ 0, 0.1037, 0.3864, 0.6538, 0.85, 1 ]

// The midtone value is sent to 0.5: with a midtone of 0.1, the sample 0.1 becomes 0.5.
console.log(round(stf(ramp(), 0.1).raw)) // [ 0, 0.1552, 0.5, 0.75, 0.9, 1 ]

// A midtone above 0.5 darkens.
console.log(round(stf(ramp(), 0.8).raw)) // [ 0, 0.0051, 0.027, 0.0769, 0.2, 1 ]

// Shadows and highlights clip, and the range between them is rescaled before the curve.
console.log(round(stf(ramp(), 0.25, 0.02, 0.5).raw)) // [ 0, 0, 0.375, 0.734, 1, 1 ]

// One channel only, or all of them.
console.log(round(stf(pixel(), 0.2, 0, 1, { channel: 'RED' }).raw)) // [ 0.3077, 0.2, 0.4 ]
console.log(round(stf(pixel(), 0.2).raw)) // [ 0.3077, 0.5, 0.7273 ]

// The neutral parameters and the defaults return the same image untouched.
const same = ramp()
console.log(stf(same) === same, DEFAULT_APPLY_SCREEN_TRANSFER_FUNCTION_OPTIONS, round(same.raw)) // true { channel: 'GRAY' } [ 0, 0.02, 0.1, 0.25, 0.5, 1 ]

// A midtone of 1 sends everything below the highlight to 0.
console.log(round(stf(ramp(), 1).raw)) // [ 0, 0, 0, 0, 0, 1 ]

try {
	stf(ramp(), 0.25, 0.8, 0.2)
} catch (e) {
	console.log((e as Error).message) // shadow must be less than or equal to highlight
}
```

### Sensor Characterization

`characterizeSensor(input, options?)` is the entry point of the EMVA-inspired sensor characterization: from the digital frames acquired at one operating point of a camera it returns the gain, read noise, saturation and dynamic range, linearity, quantum efficiency, dark current and the spatial noise and defects, one result per plane (`'mono'`, or `'red'`, `'green1'`, `'green2'` and `'blue'` for an undebayered CFA mosaic), and never throws for a data problem: recoverable failures become entries of `diagnostics`. The `input` has the expected `operatingPoint` (gain, offset, temperature in degrees Celsius, readout mode, binning, sensor origin and so on, all optional, merged with those of the frame sets and compared with a temperature tolerance), the `bias` frame set (at least two frames at the shortest exposure), the `flats` (`SensorFlatFrameSet` at increasing illumination, each with an exposure in seconds, optionally the `photons` per pixel and `wavelength` in nanometres of a calibrated source and `darkFrames` at the same exposure), the optional `darks` at several exposures for the dark current (three distinct exposures at least), and the optional `spatial` pair of a `dark` and a `flat` stack of the same exposure for the fixed-pattern noise and the defects. Every frame is a single-channel `DigitalImage` (see Scientific Image Loading and Export); the stages are described in Photon Transfer and Read Noise, Sensor Linearity, Dark Current, Sensor Fixed-Pattern Noise and Sensor Stack Defects.

The result has the `operatingPoint` that was merged, the `acquisition` summary (width, height, the `roi` as an inclusive-exclusive rectangle, the counts of bias frames, flat levels and dark levels and the `[minimum, maximum]` temperatures) and the `planes`, each with `bias`, `gain` (`system` in DN per electron and `conversion` in electrons per DN), `readNoise`, `saturation`, `dynamicRange`, `linearity`, `photonTransfer` (the points, each with its `saturationFraction`), `responsivity`, `quantumEfficiency`, `darkCurrent`, `dsnu`, `prnu` and `defects`. A field is `undefined` when its stage could not run (for example the dark current without darks, or any electron quantity when the gain fit failed). A diagnostic has a `severity` (`'info'`, `'warning'` or `'error'`), a stable `code`, a `message` and, where it applies, the `plane` and the zero-based `level`; they report too few levels (`insufficientBiasFrames`, `insufficientFlatLevels` with nine recommended, `insufficientDarkLevels` with six recommended, `insufficientSpatialFrames` with 100 recommended), a mixed geometry, CFA pattern or operating point, a temperature drift above the tolerance, and the quality of the fits: a gain fit with r2 below 0.98 or a residual above 3 percent of the fitted span, no saturation found, a mean linearity error above 1 percent, a dark current from the mean and from the variance that differ by more than half, an amp glow of more than 1.5 times the median tile, a clipped level (more than 1 percent of the samples) and a response that falls, a missing wavelength or a quantum efficiency outside 0..1. A structural error (frames that are not single-channel digital images, of different sizes or CFA patterns, an exposure that is not finite and non-negative, an unknown CFA origin) returns no planes. A mosaic needs an integer sensor origin in the operating point or consistent Bayer offsets in the frames, and binned mosaics are rejected.

`options` adds an `area` (an inclusive-exclusive rectangle), the `planes` to analyze, a known `digitalClip` in DN (the lowest upper bound declared by the frames when omitted), the fractional `gainRange` and `linearityRange`, the `temperatureTolerance` in degrees Celsius (0.5), the `rejectionSigma` for defects (5), the `spatialDetrend` for the PRNU, the `maps` to retain (`'none'`, `'defects'` or `'all'`), the caller-owned `spatialBuffers` and the `tile` size; `DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS` has the defaults. A non-finite clip, a negative or non-finite temperature tolerance and a non-positive rejection sigma throw a `RangeError`. The analysis is synchronous and the frames are not modified, but it reads every pixel of every frame, so a full-resolution characterization is a long task that is better run away from a UI thread.

```ts
import { characterizeSensor } from 'nebulosa/src/imaging/analysis/sensor/characterization'
import { DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { SensorFlatFrameSet, SensorFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

const digital = (raw: Float64Array): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 4 },
	raw,
	metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// A pair with an exact mean and temporal variance (the frames differ by +-sqrt(2 variance) / 2).
const pair = (mean: number, variance: number): [DigitalImage, DigitalImage] => {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(16)
	const second = new Float64Array(16)
	for (let i = 0; i < 16; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}
	return [digital(first), digital(second)]
}

// A camera with a system gain of 0.5 DN/e-, a read noise of 2 DN, a pedestal of 1000 DN and a dark current of 5 DN/s.
const bias: SensorFrameSet = { frames: pair(1000, 4), exposure: 0 }
const flats: SensorFlatFrameSet[] = [100, 200, 400, 800, 1200, 1600, 2400, 3200, 4800, 6400].map((signal, i) => ({ frames: pair(1000 + signal, 4 + 0.5 * signal), darkFrames: pair(1000, 4), exposure: i + 1, photons: signal * 4, wavelength: 550 }))
const darks: SensorFrameSet[] = [0, 10, 20, 40, 80, 120].map((exposure) => ({ frames: pair(1000 + 5 * exposure, 4 + 2.5 * exposure), exposure, temperature: -10 }))

const result = characterizeSensor({ operatingPoint: { gain: 100, temperature: -10 }, bias, flats, darks }, { digitalClip: 65535, tile: { width: 2, height: 2 } })
const [mono] = result.planes
console.log(result.planes.length, mono.plane, result.acquisition) // 1 mono, a 4x4 roi (0, 0, 4, 4), 2 bias frames, 10 flat levels, 6 dark levels, temperatures [-10, -10]
console.log(mono.gain?.system, mono.gain?.conversion, mono.readNoise.digital, mono.readNoise.sensorElectrons) // 0.5 2 2 3.958 (DN/e-, e-/DN, DN, e-)
console.log(mono.saturation?.method, mono.saturation?.signal, mono.saturation?.capacity) // digitalRange 64535 129070 (the clip at 65535 is the only evidence, so the capacity is in electrons)
console.log(mono.dynamicRange?.practical.stops, mono.linearity?.error, mono.responsivity, mono.quantumEfficiency) // 14.98 stops, 0 (linear), 0.25 DN/photon, 0.5 (quantum efficiency)
console.log(mono.darkCurrent?.mean, mono.darkCurrent?.variance, mono.darkCurrent?.temperature, mono.dsnu, mono.defects) // 10 e-/pixel/s from the mean, 10 from the variance, -10 degrees Celsius, no spatial results
console.log(result.operatingPoint, result.diagnostics) // the declared gain and temperature, and no diagnostics ([])

// Fewer levels and no darks: the diagnostics say what is short, and the stages that cannot run are omitted.
const short = characterizeSensor({ operatingPoint: {}, bias, flats: flats.slice(0, 4) })
console.log(
	short.planes[0].darkCurrent,
	short.diagnostics.map((d) => `${d.severity} ${d.code}`),
) // undefined, warning insufficientFlatLevels and warning poorLinearityFit

// A structural problem returns no plane: a single bias frame.
const broken = characterizeSensor({ operatingPoint: {}, bias: { frames: [bias.frames[0]] as unknown as SensorFrameSet['frames'], exposure: 0 }, flats })
console.log(broken.planes.length, broken.diagnostics) // 0 planes and the error insufficientBiasFrames

// A frame set that contradicts the declared operating point (a temperature 10 degrees away).
const mixed = characterizeSensor({ operatingPoint: { temperature: 0 }, bias: { ...bias, temperature: 10 }, flats })
console.log(
	mixed.planes.length,
	mixed.diagnostics.map((d) => d.code),
) // 0 planes and mixedOperatingPoint

console.log(DEFAULT_SENSOR_CHARACTERIZATION_OPTIONS) // gainRange [0.05, 0.7], linearityRange [0.05, 0.95], temperatureTolerance 0.5, rejectionSigma 5, spatialDetrend 'emvaHighpass', maps 'none'

try {
	characterizeSensor({ operatingPoint: {}, bias, flats }, { rejectionSigma: 0 })
} catch (e) {
	console.log((e as Error).message) // sensor rejection sigma must be finite and positive
}
```

### Sensor Fixed-Pattern Noise

`measureSensorSpatial(dark, flat, conversionGain, options?)` measures the fixed-pattern noise of one plane of a sensor from a dark and a bright (flat) stack of digital frames with the same non-negative `exposure` in seconds (see Scientific Image Loading and Export for `DigitalImage`, and Sensor Stack Defects for the stack arguments), following the EMVA 1288 spatial analysis. The stack means remove the temporal noise (the residual temporal variance of the average is subtracted), and the spatial part is the high-pass residual after the EMVA 7x7 and 11x11 box filters and a binomial 3x3 smoothing, so a slow gradient of illumination or of the dark signal does not count as noise. The result has the `dsnu` (dark signal non-uniformity) in electrons RMS, using the `conversionGain` in electrons per DN (see Photon Transfer and Read Noise), and the `prnu` (photo response non-uniformity) as a dimensionless fraction of the mean bright-minus-dark `signal` in DN; both split into `overall`, `rows` (row-correlated), `columns` (column-correlated) and `pixels` (what remains), over the `sampleCount` pixels of the plane. The `prnu` has the EMVA components (`emva`), the `undetrended` components of the raw bright-minus-dark response, which include any illumination gradient, and, when `spatialDetrend` is `'plane'` or `'polynomial'`, the `corrected` components after removing a fitted plane (three terms) or a second-order polynomial (six terms), the practical figure for a flat that is not perfectly uniform. The default `spatialDetrend` is `'emvaHighpass'`, `'none'` skips the correction, and the `rowProfile` and `columnProfile` are the unfiltered mean profiles by row and column in DN.

The analysis is tiled: every tile of `options.tile` pixels (256 by 256 by default, each with a nine-pixel halo) reads the frames again, so memory does not grow with the image, but the cost is a full read of the stacks per pass. `maps: 'all'` adds the `Float32Array` residual `map` of the DSNU (electrons) and PRNU (fraction) on the plane grid; the `spatialBuffers` option takes caller-owned `mean`, `variance` and `mask` arrays that are overwritten for the plane (see Sensor Stack Defects). The `area`, `plane` and `cfaOffset` options are as in the other sensor analyses, and a `RangeError` reports a conversion gain that is not positive and finite, different or invalid exposures, an unknown detrend mode, tile dimensions that are not positive integers and buffers that are too small. A stack of few frames leaves temporal noise in the means, and the correction cannot make up for it: a spatial analysis wants tens of frames (the characterization in Sensor Characterization warns below 100), and the figures only mean something for a linear, unsaturated flat.

```ts
import { measureSensorSpatial } from 'nebulosa/src/imaging/analysis/sensor/spatial'
import type { SensorFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

const width = 32

const image = (raw: Float64Array): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: width },
	raw,
	metadata: { width, height: width, channels: 1, pixelCount: raw.length, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// Two identical frames, so the temporal variance is exactly zero and only the fixed pattern remains.
const stack = (raw: Float64Array): SensorFrameSet => ({ frames: [image(raw.slice()), image(raw.slice())], exposure: 10 })

// A checkerboard dark of +-2 DN (2 DN RMS, so 4 e- at 2 e-/DN) and a flat at 1000 DN above the dark.
const darkRaw = new Float64Array(width * width)
const flatRaw = new Float64Array(width * width)
for (let y = 0; y < width; y++) {
	for (let x = 0; x < width; x++) {
		darkRaw[y * width + x] = 100 + (((x + y) & 1) === 0 ? 2 : -2)
		flatRaw[y * width + x] = darkRaw[y * width + x] + 1000
	}
}
const result = measureSensorSpatial(stack(darkRaw), stack(flatRaw), 2, { tile: { width: 8, height: 8 } })
console.log(result.dsnu.overall, result.dsnu.rows, result.dsnu.columns, result.dsnu.pixels) // 4.0018 e- overall and in the pixels, about 0 in rows and columns (a checkerboard is neither)
console.log(result.prnu.emva.overall, result.prnu.undetrended.overall, result.prnu.corrected, result.signal, result.sampleCount) // about 0 (1.5e-10), 0, undefined (no corrected components), 1000 DN, 1024 pixels
console.log(result.dsnu.rowProfile?.length, result.dsnu.map) // 32 undefined (a profile per row, no map without maps: 'all')

// A PRNU of +-2 % over an illumination gradient: the EMVA high-pass sees about 2 %, the undetrended figure includes the gradient (5.2 %), and only plane or polynomial add the corrected components.
const gradientDark = new Float64Array(width * width).fill(100)
const gradientFlat = new Float64Array(width * width)
for (let y = 0; y < width; y++) {
	for (let x = 0; x < width; x++) gradientFlat[y * width + x] = 100 + (1000 + 5 * x + 3 * y) * (((x + y) & 1) === 0 ? 1.02 : 0.98)
}
for (const spatialDetrend of ['emvaHighpass', 'none', 'plane', 'polynomial'] as const) {
	const prnu = measureSensorSpatial(stack(gradientDark), stack(gradientFlat), 2, { spatialDetrend, tile: { width: 16, height: 16 } }).prnu
	console.log(spatialDetrend, prnu.emva.overall, prnu.undetrended.overall, prnu.corrected?.overall) // emvaHighpass 0.0202 0.0519 undefined
}

// Maps, a region of interest, and caller buffers.
const mean = new Float64Array(width * width)
const variance = new Float64Array(width * width)
const mask = new Uint8Array(width * width)
const full = measureSensorSpatial(stack(darkRaw), stack(flatRaw), 2, { maps: 'all', spatialBuffers: { mean, variance, mask }, tile: { width: 16, height: 16 } })
console.log(full.dsnu.map?.length, full.prnu.map?.length, mean[0], variance[0]) // none 0.0202 0.0519 undefined
console.log(measureSensorSpatial(stack(darkRaw), stack(flatRaw), 2, { area: { left: 0, top: 0, right: 16, bottom: 16 } }).sampleCount) // plane 0.0202 0.0519 0.0200

for (const run of [
	() => measureSensorSpatial(stack(darkRaw), stack(flatRaw), 0),
	() => measureSensorSpatial(stack(darkRaw), { ...stack(flatRaw), exposure: 5 }, 2),
	() => measureSensorSpatial(stack(darkRaw), stack(flatRaw), 2, { tile: { width: 0, height: 4 } }),
	() => measureSensorSpatial(stack(darkRaw), stack(flatRaw), 2, { spatialDetrend: 'cubic' as never }),
]) {
	try {
		run()
	} catch (e) {
		console.log((e as Error).message) // polynomial 0.0202 0.0519 0.0200
	}
}
```

### Sensor Linearity

`measureSensorLinearity(points, flats, saturation, gain, range?)` checks how linear the response of one sensor plane is, from the dark-corrected photon transfer points of `characterizeSensorTemporal` (see Photon Transfer and Read Noise, where `points` come from the `photonTransfer` field) and the flat sets that produced them (`flats[point.level]` supplies the exposure, the relative `intensity`, the incident `photons` per pixel and the `wavelength` in nanometres). It keeps the valid, unclipped points whose signal lies in the fraction `range` of the saturation signal (`[0.05, 0.95]` by default; the saturation signal of `saturation` when it is given, the largest valid unclipped signal otherwise; a `RangeError` for a range that is not increasing within 0..1) and fits `signal = slope * input + intercept` by weighted least squares with inverse-square weights, so the residuals are minimized in relative terms across the interval. The input is the incident photons per pixel when every selected level has them, otherwise exposure times intensity (the intensity is 1 when absent). The result is `{ linearity, responsivity, quantumEfficiency, quantumEfficiencyUnavailable }`, all omitted when fewer than two points are usable or the slope is not positive. `linearity` has the `slope` (DN per input unit), the `intercept` (DN), the signed relative residuals `minimum` and `maximum` (as fractions, for example 0.01 is 1 percent), their `rms` and mean absolute `error`, the selected `points` (`input`, `measured`, `predicted` and the relative `error`, in ascending input order) and the regression report `fit`. `responsivity` is the slope in DN per photon when all the levels are photon calibrated, and `quantumEfficiency` is the responsivity divided by the system gain of `gain` (DN per electron, so electrons per photon) when all the levels also share one wavelength; it is only reported when it falls within 0..1, otherwise `quantumEfficiencyUnavailable` says `'missingSpectralCalibration'` (no common wavelength) or `'outOfRange'`. The relative residual measures non-linearity only within the selected range, so a response that bends below the range or above it is not seen, and the quantum efficiency depends on the calibration of the photon counts as much as on the sensor.

`detectSensorSaturation(points, gain?, digitalSignalLimit?)` finds the output saturation of the plane and returns a `SensorSaturation` or `undefined`: the dark-corrected `signal` in DN, the `capacity` in electrons (signal times the conversion gain, when a gain is given), the `index` of the level and the `method` and `confidence` of the evidence, in order of precedence: `'unclippedLevel'` (0.95: the level before the first one with more than 1 percent of the pixels at the digital clip), `'variance'` (0.75: the level at the maximum of the variance, when a later level has a variance below 90 percent of it, the collapse of the photon transfer curve at saturation), `'response'` (0.65: the level before the response slope drops below a quarter of the previous one), `'plateau'` (0.5: the signal stops growing at the last levels) and `'digitalRange'` (0.2: the `digitalSignalLimit` in DN, when nothing else is found). The confidence is a heuristic rank of the evidence, not a probability, and the capacity is the charge observed at the output saturation, not a claim about the physical full well.

`computeSensorDynamicRange(saturation, readNoise)` returns the `practical` dynamic range (capacity divided by the total read noise in electrons) and the `emva` one (capacity divided by the absolute sensitivity threshold `sqrt(noise^2 + 1/4) + 1/2`), each as a `ratio`, the base-2 `stops` and the amplitude `decibels` (20 log10 of the ratio), or `undefined` when the capacity or the total noise in electrons is missing or not positive.

```ts
import { measureSensorLinearity } from 'nebulosa/src/imaging/analysis/sensor/linearity'
import { characterizeSensorTemporal } from 'nebulosa/src/imaging/analysis/sensor/ptc'
import { computeSensorDynamicRange, detectSensorSaturation } from 'nebulosa/src/imaging/analysis/sensor/saturation'
import type { SensorFlatFrameSet, SensorFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

const digital = (raw: Float64Array): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 4 },
	raw,
	metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// A pair with an exact mean and temporal variance (the frames differ by +-sqrt(2 variance) / 2).
const pair = (mean: number, variance: number): [DigitalImage, DigitalImage] => {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(16)
	const second = new Float64Array(16)
	for (let i = 0; i < 16; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}
	return [digital(first), digital(second)]
}

// Six levels of a sensor with a system gain of 0.5 DN/e-, a quantum efficiency of 0.5 (so 0.25 DN per photon) and a read noise of 2 DN,
// with the photons per pixel and the wavelength of a 550 nm source known; the response is linear.
const bias: SensorFrameSet = { frames: pair(1000, 4), exposure: 0 }
const levels = [100, 400, 800, 1600, 3200, 6400]
const flats: SensorFlatFrameSet[] = levels.map((signal, i) => ({ frames: pair(1000 + signal, 4 + 0.5 * signal), darkFrames: pair(1000, 4), exposure: i + 1, photons: signal * 4, wavelength: 550 }))
const { photonTransfer, gain, readNoise } = characterizeSensorTemporal(bias, flats)

const response = measureSensorLinearity(photonTransfer, flats, undefined, gain)
console.log(response.linearity?.slope, response.linearity?.intercept, response.linearity?.points.length) // 0.25 0 4 (the 400, 800, 1600 and 3200 DN levels are inside 5 to 95 percent of the largest signal)
console.log(response.linearity?.minimum, response.linearity?.maximum, response.linearity?.rms, response.linearity?.fit.r2) // 0 0 0 1
console.log(response.responsivity, response.quantumEfficiency, response.quantumEfficiencyUnavailable) // 0.25 0.5 undefined (0.25 DN per photon, divided by the system gain of 0.5 DN/e-)

// Without the photon calibration the input is the exposure times the intensity: only the slope has other units and no efficiency is reported.
const relative = measureSensorLinearity(
	photonTransfer,
	flats.map(({ photons, wavelength, ...rest }) => rest),
	undefined,
	gain,
)
console.log(
	relative.linearity?.points.map((point) => point.input),
	relative.responsivity,
	relative.quantumEfficiency,
) // [ 2, 3, 4, 5 ] undefined undefined (the exposures of the selected levels)

// A compressed response: the last level is 5 percent low, and the range [0.05, 0.95] keeps it in the fit.
const bent: SensorFlatFrameSet[] = flats.map((flat, i) => (i === 4 ? { ...flat, frames: pair(1000 + 3040, 4 + 0.5 * 3040), darkFrames: pair(1000, 4) } : flat))
const bentPoints = characterizeSensorTemporal(bias, bent).photonTransfer
const nonLinear = measureSensorLinearity(bentPoints, bent, undefined, gain).linearity
console.log(nonLinear?.minimum, nonLinear?.maximum, nonLinear?.rms, nonLinear?.error) // -0.0237 0.0224 0.0179 0.0166
console.log(measureSensorLinearity(bentPoints, bent, undefined, gain, [0.05, 0.3]).linearity?.rms) // 0 (the three faintest levels are still on the line)

// A quantum efficiency above 1 (a photon count that is too low) is reported as out of range.
const miscounted = measureSensorLinearity(
	photonTransfer,
	flats.map((flat) => ({ ...flat, photons: flat.photons! / 4 })),
	undefined,
	gain,
)
console.log(miscounted.responsivity, miscounted.quantumEfficiency, miscounted.quantumEfficiencyUnavailable) // 1 undefined 'outOfRange' (a responsivity of 1 DN per photon would be a quantum efficiency of 2)

// The saturation: a clipped level, a variance collapse and a response that stops growing.
const point = (signal: number, variance: number, clippedFraction = 0) => ({ ...photonTransfer[0], signal, variance, clippedFraction })
const rising = [point(100, 50), point(400, 200), point(800, 400), point(1600, 800)]
console.log(detectSensorSaturation([...rising, point(3000, 1500, 0.5)], gain)) // { signal: 1600, capacity: 3200, index: 0, method: 'unclippedLevel', confidence: 0.95 } (the index is 0 because the synthetic points all reuse the first level)
console.log(
	detectSensorSaturation(
		[...rising, point(2000, 100)].map((p, i) => ({ ...p, exposure: i + 1, stimulus: undefined })),
		gain,
	),
) // { signal: 1600, capacity: 3200, index: 0, method: 'variance', confidence: 0.75 }
console.log(detectSensorSaturation(rising, gain, 4095)?.method, detectSensorSaturation(rising, gain)) // digitalRange undefined

// The dynamic range from the capacity and the total read noise in electrons.
const saturation = detectSensorSaturation([...rising, point(3000, 1500, 0.5)], gain)!
console.log(computeSensorDynamicRange(saturation, readNoise)) // { practical: { ratio: 800, stops: 9.644, decibels: 58.06 }, emva: { ratio: 706.2, stops: 9.464, decibels: 56.98 } }
console.log(computeSensorDynamicRange(saturation, { digital: 2, pairCount: 1, deviation: 0 })) // undefined (no noise in electrons)

try {
	measureSensorLinearity(photonTransfer, flats, undefined, gain, [0.9, 0.1])
} catch (e) {
	console.log((e as Error).message) // linearity range must be an increasing fraction within 0..1
}
```

### Sensor Operating-Point Series

`characterizeSensorSeries(profiles, options?)` compares the `SensorCharacterization` results of the same camera at several configured gain settings (see Sensor Characterization) and, when the measured system gain crosses one DN per electron, interpolates the configured gain where it happens, which is the usual "unity gain" setting of a CMOS camera. The result is a `SensorProfileSeries` with the `profiles` sorted by configured gain, an optional `unityGain` (`configuredGain`, in the units of the device setting, and the `lower` and `upper` operating points that bracket it, equal for an exact measured point) and the `diagnostics`, whose `code` is one of `'insufficientProfiles'`, `'incompatibleProfiles'`, `'invalidConfiguredGain'`, `'ambiguousPlane'`, `'missingPlaneGain'`, `'nonMonotonicGainSeries'`, `'regimeChangeDetected'` and `'unityGainNotBracketed'`. Every profile needs a finite and unique `operatingPoint.gain`; they must share the camera, offset, readout mode, bit depth, binning, sensor origin, size, image dimensions and region of interest, and their temperatures (when recorded, and recorded for all or none) must span no more than `temperatureTolerance` degrees Celsius (0.5 by default). The `plane` of the comparison defaults to `'mono'` or to the only plane that every profile has, and the measured system gain (DN per electron) of that plane must be valid and strictly monotonic in the configured gain.

The unity gain is only interpolated, never extrapolated: the measured points must bracket 1, and the interpolation is linear between the two points around the crossing. It is refused with `'regimeChangeDetected'` when the slope there differs from the slope of an adjacent interval by more than `regimeSlopeRatio` (5 by default, a `RangeError` for a value that is not finite and greater than one; a `temperatureTolerance` that is negative or not finite is also a `RangeError`), as cameras that switch to a high conversion gain mode at some setting have a step that a straight line cannot describe. The estimate is therefore as good as the measured gains and the assumption of a smooth curve between two points, and it is not a substitute for measuring the profile at the interpolated setting.

```ts
import { characterizeSensor } from 'nebulosa/src/imaging/analysis/sensor/characterization'
import { characterizeSensorSeries } from 'nebulosa/src/imaging/analysis/sensor/series'
import type { SensorFlatFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

const digital = (raw: Float64Array): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: 4, NAXIS2: 4 },
	raw,
	metadata: { width: 4, height: 4, channels: 1, pixelCount: 16, pixelSizeInBytes: 2, strideInBytes: 8, stride: 4, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// A pair with an exact mean and temporal variance (DN and DN squared).
const pair = (mean: number, variance: number): [DigitalImage, DigitalImage] => {
	const difference = Math.sqrt(2 * variance)
	const first = new Float64Array(16)
	const second = new Float64Array(16)
	for (let i = 0; i < 16; i++) {
		const signed = (i & 1) === 0 ? difference : -difference
		first[i] = mean + signed / 2
		second[i] = mean - signed / 2
	}
	return [digital(first), digital(second)]
}

// The profile of a camera set to the configured gain with the given system gain in DN/e-.
function profile(configured: number, system: number, temperature = -10) {
	const flats: SensorFlatFrameSet[] = [100, 200, 400, 800, 1200, 1600, 2400, 3200, 4800, 6400].map((signal, i) => ({ frames: pair(1000 + signal, 4 + system * signal), darkFrames: pair(1000, 4), exposure: i + 1 }))
	return characterizeSensor({ operatingPoint: { gain: configured, offset: 10, temperature }, bias: { frames: pair(1000, 4), exposure: 0 }, flats }, { digitalClip: 65535 })
}

// The measured system gain rises from 0.5 to 1.25 DN/e- with the configured gain, so unity is between 100 and 200.
const profiles = [profile(200, 1.25), profile(0, 0.5), profile(100, 0.8)]
console.log(profiles.map((p) => p.planes[0].gain?.system)) // [1.25, 0.5, 0.8] (the fitted DN/e- of the profiles, in the order given)
const series = characterizeSensorSeries(profiles)
console.log(
	series.profiles.map((p) => p.operatingPoint.gain),
	series.diagnostics,
) // [0, 100, 200] and no diagnostics (sorted by configured gain)
console.log(series.unityGain?.configuredGain, series.unityGain?.lower.gain, series.unityGain?.upper.gain) // 144.4 (between the settings 100 and 200)

// A measured gain that is exactly 1 returns that operating point as lower and upper; the fitted gains carry rounding error, so here the crossing is interpolated.
const exact = characterizeSensorSeries([profile(0, 0.5), profile(100, 1), profile(200, 2)])
console.log(exact.unityGain?.configuredGain, exact.unityGain?.lower === exact.unityGain?.upper) // 100.00000000000104 false

// Points that do not bracket one DN/e- are not extrapolated.
console.log(characterizeSensorSeries([profile(0, 0.5), profile(100, 0.8)]).diagnostics.map((d) => d.code)) // ['unityGainNotBracketed']

// A slope change across the bracket is a regime change: the curve is flat and then jumps.
console.log(characterizeSensorSeries([profile(0, 0.5), profile(100, 0.55), profile(200, 1.5)]).diagnostics.map((d) => d.code)) // ['regimeChangeDetected']
console.log(characterizeSensorSeries([profile(0, 0.5), profile(100, 0.55), profile(200, 1.5)], { regimeSlopeRatio: 50 }).unityGain?.configuredGain) // 147.4 (interpolated once the slope limit is relaxed)

// Incompatible acquisitions, duplicated gains, a non-monotonic curve and an empty list.
console.log(characterizeSensorSeries([profile(0, 0.5), profile(100, 0.8, 10)]).diagnostics.map((d) => d.code)) // ['incompatibleProfiles']
console.log(characterizeSensorSeries([profile(0, 0.5), profile(0, 0.8)]).diagnostics.map((d) => d.code)) // ['invalidConfiguredGain']
console.log(characterizeSensorSeries([profile(0, 0.5), profile(100, 0.8), profile(200, 0.6)]).diagnostics.map((d) => d.code)) // ['nonMonotonicGainSeries']
console.log(characterizeSensorSeries([]).diagnostics.map((d) => d.code)) // ['insufficientProfiles']

try {
	characterizeSensorSeries(profiles, { regimeSlopeRatio: 1 })
} catch (e) {
	console.log((e as Error).message) // series regime slope ratio must be finite and greater than one
}
```

### Sensor Stack Defects

`measureSensorDefects(dark, flat, options?)` classifies the defective pixels of one plane of a sensor from two matched stacks of digital frames (see Scientific Image Loading and Export): `dark` and `flat`, both `SensorFrameSet` values with the same non-negative `exposure` in seconds, at least two frames each and the same geometry. For every pixel it computes the stack mean and the unbiased temporal variance (DN and DN squared, non-finite samples ignored), takes the robust median of each statistic over the plane and its median absolute deviation (MAD), and flags with `rejectionSigma` (5 by default) MADs: `hot` pixels (dark mean above the limit), `cold` pixels (flat minus dark response below the limit), `noisy` pixels (dark variance above the limit), the `unstable` ones among the noisy (a dark series with at least eight finite samples whose excess kurtosis or whose occupancy within half a standard deviation of the mean is not Gaussian, as with a random telegraph signal) and `saturated` pixels (some flat sample at or above the known `digitalClip` in DN). A row or a column is reported in `rows` and `columns` (indices on the plane grid) when at least a quarter of its pixels, and no fewer than two, have a hot, cold, noisy or unstable flag, or when its mean response, computed without the flagged pixels, deviates from the median of the profiles by more than `rejectionSigma` MADs. The thresholds come from the plane itself, so a sensor that is mostly defective, or a flat that has a strong illumination gradient, shifts the medians and the classification with them; the flat should be uniform, and the stacks should contain tens of frames for the temporal tests to mean anything.

The result is `undefined` unless something retains the data: `maps` set to `'defects'` or `'all'` returns the `mask`, a `Uint8Array` on the plane grid (row-major, width times height of the plane in the area) of the bits `SENSOR_DEFECT_HOT`, `SENSOR_DEFECT_COLD`, `SENSOR_DEFECT_NOISY`, `SENSOR_DEFECT_UNSTABLE` and `SENSOR_DEFECT_SATURATED`; the counts `hot`, `cold`, `noisy` and `unstable` are always returned. The `spatialBuffers` option takes caller-owned `mean`, `variance` and `mask` arrays (at least as long as the plane, overwritten with the dark-corrected response in DN, the sum of the dark and flat temporal variances and the mask), which also enable the classification when `maps` is `'none'` and are the way to reuse memory between calls. Memory is bounded: the robust medians use `RobustReservoir` (see Bounded Robust Sampling) and three passes reread the stacks. The `area` is an inclusive-exclusive rectangle of the image, the `plane` and `cfaOffset` select one CFA plane of a mosaic as in Dark Current, and a `RangeError` rejects dark and flat exposures that differ or are invalid, a non-finite clip, a non-positive sigma, a buffer smaller than the plane and stacks without any finite statistics.

```ts
import { measureSensorDefects, SENSOR_DEFECT_COLD, SENSOR_DEFECT_HOT, SENSOR_DEFECT_NOISY, SENSOR_DEFECT_SATURATED, SENSOR_DEFECT_UNSTABLE } from 'nebulosa/src/imaging/analysis/sensor/defects'
import type { SensorFrameSet } from 'nebulosa/src/imaging/analysis/sensor/types'
import type { DigitalImage } from 'nebulosa/src/imaging/model/types'

const width = 12
const height = 10

const image = (raw: Float64Array): DigitalImage => ({
	header: { SIMPLE: true, BITPIX: 16, NAXIS: 2, NAXIS1: width, NAXIS2: height },
	raw,
	metadata: { width, height, channels: 1, pixelCount: raw.length, pixelSizeInBytes: 2, strideInBytes: width * 2, stride: width, bitpix: 16, bayer: undefined },
	sampleScale: 'digital',
	digitalRange: [0, 65535],
	quantizationStep: 1,
})

// 16 dark frames at 100 DN and 16 flat frames at 1100 DN, with a hot row (+40 DN), a cold column (400 DN in the flat),
// a noisy pixel (a Gaussian-like series) and a two-level pixel (+-30 DN) that is also unstable.
const noisyIndex = 3 * width + 8
const unstableIndex = 7 * width + 9
const gaussianLike = [-22, -15, -11.5, -9, -6.5, -4.5, -2.5, -0.8, 0.8, 2.5, 4.5, 6.5, 9, 11.5, 15, 22]
const darkFrames: DigitalImage[] = []
const flatFrames: DigitalImage[] = []
for (let frame = 0; frame < 16; frame++) {
	const dark = new Float64Array(width * height).fill(100)
	const flat = new Float64Array(width * height).fill(1100)
	for (let x = 0; x < width; x++) {
		dark[width + x] += 40
		flat[width + x] += 40
	}
	for (let y = 0; y < height; y++) flat[y * width + 4] = 400
	dark[noisyIndex] += gaussianLike[frame]
	dark[unstableIndex] += (frame & 1) === 0 ? -30 : 30
	darkFrames.push(image(dark))
	flatFrames.push(image(flat))
}
const dark: SensorFrameSet = { frames: darkFrames as unknown as SensorFrameSet['frames'], exposure: 10 }
const flat: SensorFrameSet = { frames: flatFrames as unknown as SensorFrameSet['frames'], exposure: 10 }

const result = measureSensorDefects(dark, flat, { maps: 'defects' })!
console.log(result.hot, result.cold, result.noisy, result.unstable) // 12 10 2 1 (hot, cold, noisy and unstable)
console.log(result.rows, result.columns) // [1] [4] (the hot row and the cold column)
console.log(result.mask![width + 2] === SENSOR_DEFECT_HOT, (result.mask![5 * width + 4] & SENSOR_DEFECT_COLD) !== 0, (result.mask![noisyIndex] & SENSOR_DEFECT_NOISY) !== 0, (result.mask![unstableIndex] & SENSOR_DEFECT_UNSTABLE) !== 0) // true true true true
console.log(result.mask!.length, [SENSOR_DEFECT_HOT, SENSOR_DEFECT_COLD, SENSOR_DEFECT_NOISY, SENSOR_DEFECT_UNSTABLE, SENSOR_DEFECT_SATURATED]) // 120 [1, 2, 4, 8, 16]

// Without maps and buffers nothing is retained, so the result is undefined; caller buffers enable it and receive the response and variance.
console.log(measureSensorDefects(dark, flat, { maps: 'none' })) // undefined
const capacity = width * height
const buffers = { mean: new Float64Array(capacity), variance: new Float64Array(capacity), mask: new Uint8Array(capacity) }
const reused = measureSensorDefects(dark, flat, { spatialBuffers: buffers })!
console.log(reused.mask, reused.hot, buffers.mean[0], buffers.mean[width + 2], buffers.variance[0]) // undefined 12 1000 1000 0 (no mask retained, the response is 1000 DN and the dark-pixel variance 0 for this constant stack)

// A known clip flags the saturated flat pixels (here every flat pixel at or above 1100 DN); the MAD of this synthetic plane is zero, so the sigma changes nothing; a region of interest limits the plane.
console.log(measureSensorDefects(dark, flat, { maps: 'defects', digitalClip: 1100 })!.mask!.filter((value) => (value & SENSOR_DEFECT_SATURATED) !== 0).length) // 110
const tolerant = measureSensorDefects(dark, flat, { maps: 'defects', rejectionSigma: 1000 })!
console.log(tolerant.hot, tolerant.cold, tolerant.noisy) // 12 10 2 (unchanged)
const part = measureSensorDefects(dark, flat, { maps: 'defects', area: { left: 0, top: 0, right: 6, bottom: 5 } })!
console.log(part.mask!.length, part.hot, part.cold, part.columns) // 30 6 5 [4] (a 6x5 plane, with the hot row cut to 6 pixels and the cold column to 5)

for (const run of [() => measureSensorDefects(dark, { ...flat, exposure: 20 }), () => measureSensorDefects(dark, flat, { maps: 'defects', rejectionSigma: 0 }), () => measureSensorDefects(dark, flat, { spatialBuffers: { ...buffers, mask: new Uint8Array(4) } })]) {
	try {
		run()
	} catch (e) {
		console.log((e as Error).message) // defect dark and flat stacks must have matching finite non-negative exposure
	}
}
```

### Sensor Tilt Estimator

### Signal-to-Noise and Dynamic Range Estimates

### Single-Frame Bad-Pixel Map

`detectBadPixels(image, options?)` finds the isolated hot and cold pixels of one frame, without dark or flat calibration frames (for the stacks, see Sensor Stack Defects), and returns a `BadPixelMap`: a row-major `mask` of `width * height` bytes (`0` clean, `BAD_PIXEL_HOT` is 1, `BAD_PIXEL_COLD` is 2) and the counts `hot` and `cold`. The frame is an `Image` in normalized 0..1 samples (see Scientific Image Model) and is not modified. A pixel is a candidate when it exceeds, or falls below, the median of its neighbors by `hotSigma` or `coldSigma` robust noise sigmas (5 by default, zero disables that class), where the noise comes from the background estimate of the frame (see Background Estimate); it is kept only when it is isolated, that is, when no neighbor reaches halfway from the local median to the pixel, which is what tells a one-pixel defect from the peak of a star. The neighborhood is the square of `radius` pixels (1 by default, a value below one is taken as one), a pixel needs at least four finite neighbors (the corners of a radius-1 window are left clean), a color frame is judged on its BT.709 luminance (or the `channel` of the option: `'RED'`, `'GREEN'`, `'BLUE'`, `'GRAY'` or another grayscale weighting) and a Bayer mosaic is judged per color phase with the noise of that phase, so the different pedestals of the colors are not defects.

It is a heuristic for a single frame: a defect that sits next to another one (a cluster, a column) is not isolated and is not flagged, an undersampled star can be mistaken for a hot pixel, and a very noisy or empty frame makes the noise estimate unreliable. A flat image has zero noise, so any pixel that differs from its neighborhood is flagged, however slightly.

```ts
import { BAD_PIXEL_COLD, BAD_PIXEL_HOT, detectBadPixels } from 'nebulosa/src/imaging/analysis/badpixel'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A 16x16 frame at 0.2 with a deterministic noise of about +-0.01.
let seed = 12345
const noise = () => {
	seed = (seed * 1664525 + 1013904223) >>> 0
	return (seed / 0xffffffff - 0.5) * 0.02
}

const make = (width: number, height: number, bayer?: 'RGGB', pedestal = (x: number, y: number) => 0.2): Image => {
	const raw = new Float64Array(width * height)
	for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) raw[y * width + x] = pedestal(x, y) + noise()
	return { header: {}, raw, metadata: { width, height, channels: 1, pixelCount: raw.length, stride: width, strideInBytes: width * 8, pixelSizeInBytes: 8, bitpix: -64, bayer } }
}

const image = make(16, 16)
image.raw[5 * 16 + 5] = 1
image.raw[10 * 16 + 3] = 0
const found = detectBadPixels(image)
console.log(found.hot, found.cold, found.mask[5 * 16 + 5] === BAD_PIXEL_HOT, found.mask[10 * 16 + 3] === BAD_PIXEL_COLD, found.mask.length) // 1 1 true true 256

// A star (a bright pixel with bright neighbors) is not isolated, so it is not a defect.
const star = make(16, 16)
star.raw[8 * 16 + 8] = 1
star.raw[8 * 16 + 7] = 0.8
star.raw[8 * 16 + 9] = 0.8
console.log(detectBadPixels(star).hot) // 0 (the star is not isolated)

// A threshold of zero disables a class, and a larger sigma only keeps the strongest outliers.
console.log(detectBadPixels(image, { hotSigma: 0 }).hot, detectBadPixels(image, { coldSigma: 0 }).cold) // 0 0 (the defect of that class is not reported)
image.raw[2 * 16 + 12] = 0.25
console.log(detectBadPixels(image, { hotSigma: 3 }).hot, detectBadPixels(image, { hotSigma: 50 }).hot) // 2 1 (the weak 0.25 pixel passes only the lower threshold)
console.log(detectBadPixels(image, { radius: 2 }).hot) // 2

// A Bayer mosaic with four very different pedestals: the defects are found against their own color phase.
const pedestals = [0.2, 0.45, 0.55, 0.8]
const mosaic = make(16, 16, 'RGGB', (x, y) => pedestals[(y & 1) * 2 + (x & 1)])
mosaic.raw[4 * 16 + 4] = 1
mosaic.raw[5 * 16 + 5] = 0
const phased = detectBadPixels(mosaic)
console.log(phased.hot, phased.cold, phased.mask[4 * 16 + 4], phased.mask[5 * 16 + 5]) // 1 1 1 2 (BAD_PIXEL_HOT and BAD_PIXEL_COLD against their own phase)

// A color frame is judged on the luminance of the selected channel.
const color: Image = { header: {}, raw: new Float64Array(16 * 16 * 3), metadata: { width: 16, height: 16, channels: 3, pixelCount: 256, stride: 48, strideInBytes: 48 * 8, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined } }
for (let i = 0; i < color.raw.length; i++) color.raw[i] = 0.3 + noise()
color.raw[(7 * 16 + 7) * 3 + 1] = 1
console.log(detectBadPixels(color, { channel: 'GREEN' }).hot, detectBadPixels(color, { channel: 'RED' }).hot) // 1 0 (the defect is in the green channel only)
```

### Star Detection

### Star List Registration

### Star Profile Measurement

### Star Shape Statistics

### Straight Streak Detection

### Streak Classification

### Streak-Aware Stacking

### Subframe Selector

### Sub-Exposure and Integration Planning

### Synthetic Bahtinov Spikes

### Synthetic Defocused Collimation Patterns

### Synthetic Flats

### Synthetic Image Noise

### Synthetic Optical Aberration

### Synthetic Star Fields

### Synthetic Straight Streaks

### Telescope Resolution and Light Grasp

### Tone Mapping

The tone functions adjust a normalized `Image` in place and return the same object. They work on a dense mono or interleaved RGB image (another channel count, a buffer that does not match the geometry or a CFA image with three channels throws an `Error`) and clip the output to 0..1, so they are meant for the display-ready range after a stretch and not for linear data that must keep values outside it. `brightness(image, value)` multiplies every sample by a finite non-negative factor (1 changes nothing, 0 gives black). `linear(image, slope, intercept)` evaluates `slope * v + intercept` (a slope of 0 fills the image with the clipped intercept). `contrast(image, value)` is the linear map that scales the distance to mid-gray 0.5 by the factor (`linear(image, value, 0.5 - 0.5 * value)`, so 1 changes nothing and 0 gives a flat 0.5). `gamma(image, value)` applies the inverse-gamma encoding `v^(1/value)` to the samples clamped to 0..1, so a value above 1 brightens the midtones (2 is a square root) and a value below 1 darkens them; 0 and negative values are outside its domain. `saturation(image, value, channel = 'GRAY')` scales the chroma of an RGB image around a luminance reference: `gray + (c - gray) * value` for each channel, where `gray` is the weighted sum of the pixel with the weights of `channel` (a named grayscale as in Scientific Image Model, or explicit weights that sum to 1, otherwise a `RangeError`), 1 changes nothing and 0 gives the gray image; a mono image is returned unchanged.

```ts
import { brightness, contrast, gamma, linear, saturation } from 'nebulosa/src/imaging/processing/tone'
import type { Image } from 'nebulosa/src/imaging/model/types'

// A mono ramp of five samples and a one-pixel RGB image, built with the metadata of a reader.
const ramp = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 2, NAXIS1: 5, NAXIS2: 1 },
	metadata: { width: 5, height: 1, channels: 1, pixelCount: 5, stride: 5, strideInBytes: 40, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0, 0.1, 0.25, 0.5, 1]),
})

const pixel = (): Image => ({
	header: { SIMPLE: true, BITPIX: -64, NAXIS: 3, NAXIS1: 1, NAXIS2: 1, NAXIS3: 3 },
	metadata: { width: 1, height: 1, channels: 3, pixelCount: 1, stride: 3, strideInBytes: 24, pixelSizeInBytes: 8, bitpix: -64, bayer: undefined },
	raw: new Float64Array([0.8, 0.4, 0.2]),
})

console.log(brightness(ramp(), 1.5).raw) // Float64Array(5) [ 0, 0.15000000000000002, 0.375, 0.75, 1 ] (clipped at 1)
console.log(linear(ramp(), 0.5, 0.25).raw, contrast(ramp(), 2).raw) // Float64Array(5) [ 0.25, 0.3, 0.375, 0.5, 0.75 ] Float64Array(5) [ 0, 0, 0, 0.5, 1 ]
console.log(gamma(ramp(), 2).raw, gamma(ramp(), 0.5).raw) // Float64Array(5) [ 0, 0.31622776601683794, 0.5, 0.7071067811865476, 1 ] Float64Array(5) [ 0, 0.010000000000000002, 0.0625, 0.25, 1 ]

// The same object is returned and modified, and the neutral values do nothing.
const image = ramp()
console.log(brightness(image, 1) === image, gamma(image, 1) === image, contrast(image, 1) === image, linear(image, 1, 0) === image, image.raw) // true true true true Float64Array(5) [ 0, 0.1, 0.25, 0.5, 1 ]

// Saturation: boosted, removed (the BT.709 luminance of the pixel), with other weights, and on a mono image.
console.log(saturation(pixel(), 2).raw) // Float64Array(3) [ 1, 0.32942000000000005, 0 ] (the red channel is clipped at 1 and the blue one at 0)
console.log(saturation(pixel(), 0).raw, saturation(pixel(), 0, 'Y').raw) // Float64Array(3) [ 0.47058, 0.47058, 0.47058 ] Float64Array(3) [ 0.4968, 0.4968, 0.4968 ] (the luminance of the pixel, BT.709 and NTSC)
console.log(saturation(pixel(), 0.5, { red: 0.5, green: 0.5, blue: 0 }).raw) // Float64Array(3) [ 0.7, 0.5, 0.4 ]
const mono = ramp()
console.log(saturation(mono, 2) === mono, mono.raw[2]) // true 0.25

try {
	saturation(pixel(), 2, { red: 1, green: 1, blue: 1 })
} catch (e) {
	console.log((e as Error).message) // grayscale weights must sum to one: 3
}
```

### Tracking Quality

### Trailing and Smear Limits

## 🔭 Observation

Evaluate observing conditions and target suitability before scheduling or controlling an observation.

### Autofocus

### Challis Polar Alignment

### DARV Exposure Planning

### DARV Image Analysis

### DARV Polar Error Estimation

### Direction Alignment

### Dither Guide Pulses

### Dither Offsets

### Dome Slit Geometry

### Focuser Backlash Calibration

### Focuser Backlash Compensation

### Guide Pulse Loop

### Guide Star Tracking

### Guiding Assistant

### Guiding Calibration

### iPolar Alignment

### Local Pointing Residuals

### Meridian Flip Lifecycle

### Meridian Flip Planning

### Mosaic Framing

### Mount Axis Limits

### Mount Kinematics

### Mount Tracking Rates

### Non-Sidereal Guide Tracking

### Observation Scores

### Pointing Model Fit and Correction

### Polar Alignment Exposure Estimator

### Polar Alignment Geometry

### Polar Alignment Overlay

### Taki Mount Geometry

### Three-Point Polar Alignment

### Tracking Rate Correction

### Tracking Rate Estimation

### Weather Quality

## 📖 Catalogs

### ASTAP Tiled Catalog

ASTAP (the plate solver and photometry program) distributes its star databases `d05`, `d20`, `d50` and `d80` as `.1476` files: the sky is cut in 1476 tiles of about 5° (36 declination bands of 5.143° with 1, 3, 9... 69... 3, 1 right ascension cells, and caps of 2.571°), and each tile `<database>_BBCC.1476` holds the Gaia stars of that region, sorted from the brightest, in the packed record format that Tiled Sky Catalog describes (ASTAP uses the HNSKY layout). The databases differ in the star density and the limiting magnitude (`d05` is the smallest), and the magnitude of a record is the Gaia BP one. The file header carries the epoch (`Epoch=2025` in the d05 sample) and, for the Gaia color variant (version byte 2, 6-byte records), a Johnson B−V color in units of 1/50 mag. Positions have the epoch of the tile and no proper motion.

The tile functions: `astap1476AreaFile(area)` returns the `{ area, ring, index, fileName, fraction }` of an area from 1 to 1476 (the band is 1-based from the south, and a `RangeError` is thrown outside the range), `ASTAP_1476_DEC_BOUNDARIES` holds the 37 band boundaries in radians, `findAstap1476Areas(ra, dec, radius)` gives the 1 to 4 tiles of a square field of half width `radius` (radians), `readAstap1476Header(buffer)` parses the 110 bytes of a tile (and throws for an unsupported record size), `readAstap1476Area(header, buffer, area, query)` yields the `Astap1476Star` (`area`, `rightAscension`, `declination` in radians, `magnitude`, and `bv` when there is one) of a tile inside a square field `{ rightAscension, declination, radius, magnitudeLimit? }`, and `findAstap1476Region(files, database, query)` and `findAstap1476Stars(files, database, query)` do it for the files of a collection, a `Map` or an object keyed `d05_0101.1476` of buffers or `File` objects, and return `{ areas, headers, stars }` or just the stars sorted from the brightest, skipping tiles that are not in the collection. The square field is `|Δα·cos δ| < radius` and `|Δδ| < radius`, which is not a cone.

`AstapCatalog` exposes the tiles through the star catalog interface (Star Catalog Interface and Spatial Query): `new AstapCatalog().open(files, database)` (or `openAstapCatalog(files, database)`, which does both) reads the files lazily and throws when the collection has none of the database, the queries (`queryCone`, `queryBox`, `queryTriangle`, `queryPolygon`, `queryRegion`, `streamRegion`) are asynchronous and return `AstapCatalogEntry` objects with `epoch`, `area`, `recordNumber`, `rightAscension`, `declination`, `magnitude` and `bv`, `get(database, area, recordNumber)` returns a star by its identifier, and `close()` or `using` releases the cached tiles. Queries are exact (a cone is a cone), but they return only what the tiles in the collection have, so the result of a field whose tiles are not loaded is empty or partial without an error.

```ts
import { astap1476AreaFile, ASTAP_1476_DEC_BOUNDARIES, AstapCatalog, findAstap1476Areas, findAstap1476Region, findAstap1476Stars, openAstapCatalog, readAstap1476Area, readAstap1476Header } from 'nebulosa/src/catalogs/stars/astap'
import { deg, hour, normalizeAngle, toDeg } from 'nebulosa/src/math/units/angle'
import { PIOVERTWO, TAU } from 'nebulosa/src/core/constants'

// The tiling: band 18 holds 69 cells and starts at the area 670, and the caps are tiles of their own.
console.log(astap1476AreaFile(1), astap1476AreaFile(670).fileName, astap1476AreaFile(738).fileName, astap1476AreaFile(1476).fileName) // { area: 1, ring: 1, index: 1, fileName: "0101.1476", fraction: 0 } 1801.1476 1869.1476 3601.1476
console.log(ASTAP_1476_DEC_BOUNDARIES.length, toDeg(ASTAP_1476_DEC_BOUNDARIES[1]), toDeg(ASTAP_1476_DEC_BOUNDARIES[18]), toDeg(ASTAP_1476_DEC_BOUNDARIES[19])) // 37 -87.42857143 0 5.142857143

// The tiles of a field: the caps, and an equatorial field that touches several cells.
console.log(
	findAstap1476Areas(deg(0), deg(-89.9), deg(0.5)).map((area) => area.fileName),
	findAstap1476Areas(deg(0), deg(89.9), deg(0.5)).map((area) => area.fileName),
) // [ "0101.1476" ] [ "3601.1476" ]
console.log(findAstap1476Areas(deg(0.1), deg(0), deg(1)).map((area) => [area.fileName, Number(area.fraction.toFixed(2))])) // [ [ "1901.1476", 0.27 ], [ "1969.1476", 0.23 ], [ "1801.1476", 0.27 ], [ "1869.1476", 0.23 ] ]

// The real d05 south polar cap: header, epoch and the stars of a field.
const file = Buffer.from(await Bun.file('data/d05_0101.1476').arrayBuffer())
const header = readAstap1476Header(file)
console.log(header.recordSize, header.version, header.epoch) // 5 32 2025

const files = { 'd05_0101.1476': file }
const region = await findAstap1476Region(files, 'd05', { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5) })
console.log(region.areas.length, region.headers[0].fileName, region.headers[0].epoch, region.stars.length, region.stars[0]) // 1 0101.1476 2025 483 { area: 1, rightAscension: 0.19923288233539038, declination: -1.5562937276489432, magnitude: 9.8, bv: undefined }
const bright = await findAstap1476Stars(files, 'd05', { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5), magnitudeLimit: 10.5 })
console.log(
	bright.length,
	bright.every((star) => star.magnitude <= 10.5),
) // 4 true
console.log((await findAstap1476Stars(new Map(), 'd05', { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5) })).length) // 0 (no file of the field)

// A synthetic tile of the Gaia color variant (6-byte records, version 2): a header record, then one star inside a field of 1° and one outside.
const scale = { ra: TAU / 0xffffff, dec: PIOVERTWO / 0x7fffff }
const tileHeader = Buffer.alloc(110, 0x20)
tileHeader.write('synthetic, Epoch=2020', 'ascii')
tileHeader[108] = 2
tileHeader[109] = 6

const sentinel = Buffer.alloc(6)

sentinel.writeUIntLE(0xffffff, 0, 3)
sentinel[3] = Math.floor(deg(2.1) / scale.dec / 65536) + 128 // the shared high byte of the declination of the stars that follow
sentinel[4] = Math.round(7.3 * 10) + 16 // the shared magnitude, in tenths
sentinel.writeInt8(0, 5)

const star = (ra: number, dec: number, bv: number) => {
	const buffer = Buffer.alloc(6)
	buffer.writeUIntLE(Math.round(normalizeAngle(ra) / scale.ra), 0, 3)
	const decRaw = Buffer.alloc(3)
	decRaw.writeIntLE(Math.round(dec / scale.dec), 0, 3)
	decRaw.copy(buffer, 3, 0, 2)
	buffer.writeInt8(Math.round(bv * 50), 5)
	return buffer
}

const tile = Buffer.concat([tileHeader, sentinel, star(hour(2.02), deg(2.1), 0.62), star(hour(4), deg(2.12), -0.2)])
const synthetic = readAstap1476Header(tile)
console.log(synthetic.recordSize, synthetic.version, synthetic.epoch) // 6 2 2020
const inField = [...readAstap1476Area(synthetic, tile, 760, { rightAscension: hour(2), declination: deg(2), radius: deg(1) })]
console.log(inField.length, inField[0].area, toDeg(inField[0].declination).toFixed(4), inField[0].magnitude.toFixed(1), inField[0].bv?.toFixed(2)) // 1 760 2.1000 7.3 0.62

// The catalog: a cone, a box, the identifier of a star and the errors. A catalog is closed with `using`.
{
	using catalog = openAstapCatalog(files, 'd05')
	console.log((await catalog.queryCone(0, deg(-89.5), deg(0.5))).length, (await catalog.queryCone(0, deg(-88.5), deg(1))).length) // 374 1468
	const cap = await catalog.queryBox(0, deg(360), deg(-90), deg(-87.42857143))
	console.log(
		cap.length,
		cap.every((entry) => entry.area === 1 && entry.epoch === 2025 && entry.bv === undefined),
		cap[0].magnitude <= cap[1].magnitude,
	) // 10387 true true
	console.log(await catalog.get('d05', 1, 2), await catalog.get('d05', 1, 99999)) // { epoch: 2025, recordNumber: 2, area: 1, rightAscension: 5.536277059095688, declination: -1.5525832988238188, magnitude: 5.5, bv: undefined } undefined
	console.log(await Array.fromAsync(catalog.streamRegion({ kind: 'cone', centerRA: 0, centerDEC: deg(-89.9), radius: deg(0.05) })).then((entries) => entries.length)) // 4
}

try {
	openAstapCatalog({ 'd20_0101.1476': file }, 'd05')
} catch (e) {
	console.log((e as Error).message) // no .1476 files were found for d05
}

const closed = new AstapCatalog().open(files, 'd05')
closed.close()

try {
	await closed.queryCone(0, 0, 0.1)
} catch (e) {
	console.log((e as Error).message) // ASTAP .1476 catalog is not open
}

try {
	astap1476AreaFile(1477)
} catch (e) {
	console.log((e as Error).message) // invalid .1476 area: 1477
}
```

### Hipparcos Catalog

The ESA Hipparcos main catalog (`hip_main.dat`, CDS I/239) has about 118 thousand stars measured by the satellite, with positions, parallaxes and proper motions at the epoch J1991.25. `readHipparcosCatalog(source)` streams the usable rows of the pipe-delimited file from a `Source` in constant reader memory and yields `HipparcosCatalogEntry` objects: `id` (the HIP number), `epoch` (always `1991.25`), `rightAscension` and `declination` (ICRS, radians), and, when the row has them, `magnitude` (V), `parallax` (radians, a negative value is kept as measured), `pmRA` and `pmDEC` (radians per Julian year). The catalog publishes μα* = dα/dt·cos δ, and the reader divides by cos δ so that `pmRA` is dα/dt, as the other catalogs and `star` expect; at a pole that direction is undefined and `pmRA` is left out. Rows with a missing or invalid identifier or position are skipped, and blank or non-numeric optional fields are `undefined`. There is no radial velocity.

`HipparcosCatalog` is a `HealpixIndex` of those entries, so it has the query methods of HEALPix Object Index and of Star Catalog Interface and Spatial Query (`queryCone`, `queryBox`, `queryTriangle`, `queryPolygon`, `queryRegion`, `streamRegion`), where each result is an index entry whose `metadata` is the `HipparcosCatalogEntry`. `new HipparcosCatalog({ nside, ordering })` defaults to NSIDE 8, `load(source)` reads and indexes every entry, and `get(id)`, `size` and `add` behave as in the index. The positions are the ones at J1991.25: to compare them with a J2000 or current-date sky, apply the proper motion first (see Stellar Space Motion).

```ts
import { HipparcosCatalog, readHipparcosCatalog } from 'nebulosa/src/catalogs/stars/hipparcos'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { bufferSource } from 'nebulosa/src/io/io'
import { deg, toMas } from 'nebulosa/src/math/units/angle'
import fs from 'fs/promises'

// Stream the file: nothing but the entry being read is kept in memory.
let count = 0

await using source = fileHandleSource(await fs.open('data/hip_main.dat', 'r'))

for await (const entry of readHipparcosCatalog(source)) {
	if (entry.id === 32349) console.log(entry.epoch, entry.magnitude, toMas(entry.parallax!), toMas(entry.pmDEC!), toMas(entry.pmRA! * Math.cos(entry.declination))) // 1991.25 -1.44 379.21 -1223.08 -546.01 (Sirius, μα* in mas/yr)
	count++
}

console.log(count) // 117955

// An index of the whole catalog, and a cone of 5° around Sirius.
await using file = fileHandleSource(await fs.open('data/hip_main.dat', 'r'))
const catalog = new HipparcosCatalog({ nside: 16 })
await catalog.load(file)
console.log(catalog.size) // 117955

const stars = catalog.queryCone(deg(101.28854105), deg(-16.71314306), deg(5))
console.log(
	stars.length,
	stars.filter((star) => star.metadata!.magnitude! < 2).map((star) => star.id),
) // 255 [ 32349 ]
console.log(catalog.get(32349)?.metadata?.magnitude, catalog.get(421)) // -1.44 undefined

// Rows with a blank position or a bad number are skipped, a blank field is undefined, and the pole has no pmRA.
const row = (id: number, ra: string, dec: string, magnitude = '', parallax = '', pmRA = '', pmDEC = '') => {
	const fields = new Array<string>(78).fill('')
	fields[0] = 'H'
	fields[1] = String(id)
	fields[5] = magnitude
	fields[8] = ra
	fields[9] = dec
	fields[11] = parallax
	fields[12] = pmRA
	fields[13] = pmDEC
	return fields.join('|')
}

const bytes = Buffer.from(`${row(1, '12.5', '-4.5')}\n${row(2, '', '20')}\n${row(3, 'NaN', '20')}\n${row(4, '33', '90', '5', '-2', '10', '3')}\n${row(0, '10', '10')}\n`)
const entries = []

for await (const entry of readHipparcosCatalog(bufferSource(bytes))) entries.push(entry)

console.log(entries.map((entry) => entry.id)) // [ 1, 4 ]
console.log(entries[0].magnitude, entries[0].pmRA, entries[1].magnitude, entries[1].pmRA, toMas(entries[1].pmDEC!), toMas(entries[1].parallax!)) // undefined undefined 5 undefined 3 -2

const small = new HipparcosCatalog()
await small.load(bufferSource(bytes))
console.log(
	small.size,
	small.queryBox(deg(12), deg(13), deg(-5), deg(-4)).map((star) => star.id),
) // 2 [ 1 ]
console.log([...small.streamRegion({ kind: 'cone', centerRA: deg(12.5), centerDEC: deg(-4.5), radius: deg(0.1) })].map((star) => star.id)) // [ 1 ]
```

### HNSKY Tiled Catalog

HNSKY (and the Cartes du Ciel / SkyChart programs) use the `.290` star databases `g14` and `g16`, which hold the Gaia stars up to magnitude 14 and 16: the sky is cut in 290 tiles (18 declination bands of 1, 4, 8... 32, 32... 8, 4, 1 right ascension cells, with caps of 4.8° and equatorial bands of 12.8°) and each file `<database>_BBCC.290` holds the stars of one tile, sorted from the brightest, in the packed format described in Tiled Sky Catalog. A tile of the 5- or 9-byte format has no color, 6 has a Gaia BP−RP color in tenths of a magnitude (the byte −128 means missing), the 7-byte format carries no color, and the 9, 10 and 11-byte formats carry a packed designation that is a Tycho-2 (`TYC 1234-42-1`) or a UCAC4 (`UCAC4 321-12345`) identifier. The magnitude is the Gaia BP one, the epoch of the positions is the `Epoch=` tag of the file or J2000, and there is no proper motion.

The functions are the ones of ASTAP Tiled Catalog with `Hnsky290` names: `hnsky290AreaFile(area)` describes a tile from 1 to 290 (`RangeError` otherwise), `HNSKY_290_DEC_BOUNDARIES` has the 19 band edges in radians, `findHnsky290Areas(ra, dec, radius)` gives the 1 to 4 tiles of a square field of half width `radius` (radians), `readHnsky290Header(buffer)` parses the 110 bytes, `decodeHnsky290Designation(value)` decodes a packed identifier, `readHnsky290Area(header, buffer, area, query)` yields the `Hnsky290Star` (`area`, `rightAscension`, `declination` in radians, `magnitude`, `bpRp` and `designation` when present) inside the field `{ rightAscension, declination, radius, magnitudeLimit? }` (the field is `|Δα·cos δ| < radius` and `|Δδ| < radius`, not a cone), and `findHnsky290Region(files, database, query)` and `findHnsky290Stars(files, database, query)` read the touched tiles of a `Map` or object of files keyed `g14_0201.290` and return `{ areas, headers, stars }` or the stars sorted from the brightest. `HnskyCatalog` and `openHnskyCatalog(files, database)` expose the tiles through the star catalog interface (Star Catalog Interface and Spatial Query): asynchronous queries return `HnskyCatalogEntry` objects (`epoch`, `area`, `recordNumber`, `rightAscension`, `declination`, `magnitude`, `bpRp`, `designation`), `get(database, area, recordNumber)` returns one star, and `close()` or `using` frees the cached tiles. A tile that is not in the collection is skipped without an error, so a field whose tiles are missing is empty or partial.

```ts
import { decodeHnsky290Designation, findHnsky290Areas, findHnsky290Region, findHnsky290Stars, HNSKY_290_DEC_BOUNDARIES, HnskyCatalog, hnsky290AreaFile, openHnskyCatalog, readHnsky290Area, readHnsky290Header } from 'nebulosa/src/catalogs/stars/hnsky'
import { PIOVERTWO, TAU } from 'nebulosa/src/core/constants'
import { deg, hour, normalizeAngle, toDeg } from 'nebulosa/src/math/units/angle'

// The tiling: 290 tiles, the file names and the band edges.
console.log(hnsky290AreaFile(1), hnsky290AreaFile(146).fileName, hnsky290AreaFile(290).fileName) // { area: 1, ring: 1, index: 1, fileName: "0101.290", fraction: 0 } 1001.290 1801.290
console.log(HNSKY_290_DEC_BOUNDARIES.length, HNSKY_290_DEC_BOUNDARIES.map((value) => Number(toDeg(value).toFixed(2))).slice(0, 4)) // 19 [ -90, -85.23, -75.66, -65.99 ]

// A field across a right ascension cell border, and the pole caps.
console.log(findHnsky290Areas(deg(11.1), deg(5), deg(4)).map((area) => area.fileName)) // [ "1002.290", "1001.290" ]
console.log(
	findHnsky290Areas(0, deg(-89.9), deg(0.5)).map((area) => area.fileName),
	findHnsky290Areas(0, deg(89.9), deg(0.5)).map((area) => area.fileName),
) // [ "0101.290" ] [ "1801.290" ]

// The real g14 database in its tar archive (290 files): a field of 0.5° half width at RA 0, Dec 0.
const archive = new Bun.Archive(await Bun.file('data/HNSKY_g14.tar').arrayBuffer())
const files = await archive.files() // a Map of File objects keyed g14_0201.290
console.log(files.size, [...files.keys()].slice(0, 2)) // 290 [ "g14_0201.290", "g14_0202.290" ]

const stars = await findHnsky290Stars(files, 'g14', { rightAscension: 0, declination: 0, radius: deg(0.5) })
console.log(stars.length, stars[0].magnitude, stars[0].area, stars[0].bpRp, stars[0].designation?.label) // 97 7.1 145 undefined undefined
console.log((await findHnsky290Stars(files, 'g14', { rightAscension: 0, declination: 0, radius: deg(0.5), magnitudeLimit: 10 })).length) // 9

const region = await findHnsky290Region(files, 'g14', { rightAscension: 0, declination: 0, radius: deg(0.5) })
console.log(
	region.areas.map((area) => area.fileName),
	region.headers.map((header) => [header.recordSize, header.epoch]),
) // [ "1001.290", "1032.290", "0901.290", "0932.290" ] [ [ 5, 2025 ], [ 5, 2025 ], [ 5, 2025 ], [ 5, 2025 ] ]

// The header of a real tile, with its description.
const tile = Buffer.from(await files.get('g14_1001.290')!.arrayBuffer())
const header = readHnsky290Header(tile)
console.log(header.recordSize, header.version, header.epoch, header.description) // 5 0 2025 GAIA eDR3, stars up to BP magnitude 14.0, Epoch=2025. Including 82 bright Tycho2 stars. Magnitude is BP

// The catalog: a cone, a box and the star of a record.
{
	using catalog = openHnskyCatalog(files, 'g14')
	const cone = await catalog.queryCone(0, 0, deg(0.5))
	console.log(cone.length, cone[0].epoch, cone[0].recordNumber, cone[0].area) // 84 2025 121 114
	console.log((await catalog.queryBox(deg(359.5), deg(0.5), deg(-0.25), deg(0.25))).length) // 58
	console.log((await catalog.get('g14', cone[0].area, cone[0].recordNumber))?.magnitude === cone[0].magnitude) // true
}

// A synthetic tile of 11-byte records (a designation, the position, the high byte of the declination and the magnitude in tenths): one UCAC4 star in the field and one outside.
const scale = { ra: TAU / 0xffffff, dec: PIOVERTWO / 0x7fffff }
const header110 = Buffer.alloc(110, 0x20)
header110.write('synthetic', 'ascii')
header110[109] = 11

const record = (designation: number, ra: number, dec: number, magnitude: number) => {
	const buffer = Buffer.alloc(11)
	const decRaw = Buffer.alloc(3)
	decRaw.writeIntLE(Math.round(dec / scale.dec), 0, 3)
	buffer.writeInt32LE(designation, 0)
	buffer.writeUIntLE(Math.round(normalizeAngle(ra) / scale.ra), 4, 3)
	decRaw.copy(buffer, 7, 0, 2)
	buffer.writeInt8(decRaw.readInt8(2), 9)
	buffer.writeInt8(Math.round(magnitude * 10), 10)
	return buffer
}

const synthetic = Buffer.concat([header110, record((321 << 20) | 12345, hour(2.02), deg(5.1), 1.4), record((321 << 20) | 12346, hour(4), deg(5.12), 1.4)])
const syntheticHeader = readHnsky290Header(synthetic)
const inField = [...readHnsky290Area(syntheticHeader, synthetic, 146, { rightAscension: hour(2), declination: deg(5), radius: deg(1) })]
console.log(syntheticHeader.recordSize, syntheticHeader.epoch, inField.length, inField[0].magnitude.toFixed(1), inField[0].designation?.label, inField[0].bpRp) // 11 2000 1 1.4 UCAC4 321-12345 undefined

// The designations: UCAC4 for a non-negative value, Tycho-2 and its component otherwise.
console.log(decodeHnsky290Designation((321 << 20) | 12345).label, decodeHnsky290Designation(-((1234 << 16) | 42)).label, decodeHnsky290Designation(-((200 << 16) | 55 | 0x40000000)).label) // UCAC4 321-12345 TYC 1234-42-1 TYC 200-55-2

// A collection with that synthetic tile as the area 148 (RA 22.5° to 33.75°, Dec 0° to 12.8°) of a g16 database.
using small = openHnskyCatalog({ [`g16_${hnsky290AreaFile(148).fileName}`]: synthetic }, 'g16')
const found = await small.queryCone(hour(2.02), deg(5.1), deg(0.1))
console.log(small.database, found.length, found[0].designation?.label, found[0].area, found[0].recordNumber) // g16 1 UCAC4 321-12345 148 1

try {
	openHnskyCatalog({ [`g16_${hnsky290AreaFile(148).fileName}`]: synthetic }, 'g14')
} catch (e) {
	console.log((e as Error).message) // no .290 files were found for g14
}

const closed = new HnskyCatalog().open({ [`g14_${hnsky290AreaFile(148).fileName}`]: synthetic }, 'g14')
closed.close()

try {
	await closed.queryCone(0, 0, 0.1)
} catch (e) {
	console.log((e as Error).message) // HNSKY .290 catalog is not open
}

try {
	hnsky290AreaFile(291)
} catch (e) {
	console.log((e as Error).message) // invalid .290 area: 291
}
```

### HYG Catalog

The HYG database merges the Hipparcos, Yale Bright Star and Gliese catalogs into one CSV of about 119 thousand stars with identifiers and physical data, which makes it the catalog to use when a star needs a name. `readHygCatalog(source)` streams the CSV of a `Source` (the `hyg_v42.csv` layout, with its header line) and yields one `HygCatalogEntry` per row, without validating or skipping rows. The entry has the astrometry at J2000 (`epoch` 2000, `rightAscension` and `declination` in radians, `pmRA` and `pmDEC` in radians per year, and `rv` in AU per day, converted from the km/s of the file), the `magnitude` (99 when blank), and the cross-references `hip`, `hd` and `hr` (0 when the star has none), `bayer`, `flamsteed` (0 when none), `name` and `spType` (when present), the `constellation` as an uppercase IAU abbreviation and the `distance` in AU. The file publishes μα* = dα/dt·cos δ and the reader divides by cos δ, so `pmRA` is dα/dt; at a pole, where that is undefined, it is 0. A blank, zero or out-of-range distance (of 100000 pc or more) gives a `distance` of 0, and a blank radial velocity gives 0 as well, so these two cannot be told from a measured zero. There is no parallax.

`HygCatalog` is a `HealpixIndex<HygCatalogEntry>` and so has the queries of HEALPix Object Index and Star Catalog Interface and Spatial Query, with the entry in the `metadata` of each result. `new HygCatalog({ nside, ordering })` uses NSIDE 8 by default, and `load(source)` reads and indexes every row, keyed by the HYG `id` (which is not the HIP number).

```ts
import { HygCatalog, readHygCatalog } from 'nebulosa/src/catalogs/stars/hyg'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { deg, formatDEC, formatRA, toMas } from 'nebulosa/src/math/units/angle'
import { toKilometerPerSecond } from 'nebulosa/src/math/units/velocity'
import fs from 'fs/promises'

// Stream until Sirius, the star with the HYG id 32263.
await using source = fileHandleSource(await fs.open('data/hyg_v42.csv', 'r'))

for await (const star of readHygCatalog(source)) {
	if (star.id !== 32263) continue

	console.log(star.name, star.hip, star.hd, star.hr, star.bayer, star.flamsteed, star.constellation, star.spType) // Sirius 32349 48915 2491 Alp 9 CMA A0m...
	console.log(star.epoch, star.magnitude, formatRA(star.rightAscension), formatDEC(star.declination)) // 2000 -1.44 06 45 08.93 -16 42 58.02
	console.log(toMas(star.pmRA * Math.cos(star.declination)), toMas(star.pmDEC)) // -546.0099 -1223.0799 (μα* in mas/yr)
	console.log(toKilometerPerSecond(star.rv), star.distance / 206264.806) // -9.4 2.637 (km/s, parsec)
	break
}

// The index of all the rows, a cone of 1° around the Orion Nebula and a lookup by HYG id.
await using file = fileHandleSource(await fs.open('data/hyg_v42.csv', 'r'))
const catalog = new HygCatalog()
await catalog.load(file)

console.log(catalog.size) // 119626
console.log(catalog.get(0)?.metadata?.name, catalog.get(32263)?.metadata?.name) // Sol Sirius

const field = catalog.queryCone(deg(83.8), deg(-5.39), deg(1))
console.log(field.length) // 22
console.log(field.map((star) => star.metadata!.name).filter(Boolean)) // [ "Hatysa" ]
```

### SAO Catalog

The Smithsonian Astrophysical Observatory (SAO) star catalog has about 259 thousand stars to roughly magnitude 9, and is distributed as the binary file `SAO.pc.dat` (the Harvard TDC layout, little endian for the PC files and big endian for the UNIX ones). `readSaoCatalog(source, bigEndian)` streams the file from a `Source` and yields `SaoCatalogEntry` objects: `id` (the SAO number), `epoch` (always `'B1950'`, a string), `rightAscension` and `declination` in radians, the `magnitude`, the two-character `spType` and, when the header says that the file has them, `pmRA` and `pmDEC` in radians per year. The positions are B1950 mean positions, not J2000, and must be precessed before they are compared with a modern frame or catalog. The proper motion of the file is already dα/dt, so unlike the other catalogs it is not divided by cos δ. The first 28 bytes are a header that gives the numbering, whether the proper motion and the identifiers are present, and the size of an entry; the reader derives the entry size from those flags, a file shorter than the header gives no entries and a truncated final entry is dropped. A source that returns partial reads is retried.

`SaoCatalog` is a `HealpixIndex<SaoCatalogEntry>`, with the queries of HEALPix Object Index and Star Catalog Interface and Spatial Query (the entry is the `metadata` of each result), and a cone is therefore a cone in the B1950 frame. `new SaoCatalog({ nside, ordering })` defaults to NSIDE 8 and `load(source, bigEndian)` reads and indexes every star, keyed by the SAO number.

```ts
import { readSaoCatalog, SaoCatalog } from 'nebulosa/src/catalogs/stars/sao'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { bufferSource } from 'nebulosa/src/io/io'
import { deg, formatDEC, formatRA, toMas } from 'nebulosa/src/math/units/angle'
import fs from 'fs/promises'

// The first star and the one of Groombridge 1830 (SAO 62738).
await using source = fileHandleSource(await fs.open('data/SAO.pc.dat'))
let count = 0

for await (const star of readSaoCatalog(source, false)) {
	count++

	if (star.id === 1)
		console.log(star.epoch, formatRA(star.rightAscension), formatDEC(star.declination), star.magnitude, star.spType) // B1950 00 00 05.10 +82 41 41.82 7.2 A0
	else if (star.id === 62738) console.log(toMas(star.pmRA!), toMas(star.pmDEC!), toMas(star.pmRA! * Math.cos(star.declination))) // about 5080.5 -5806 3999.25 (the last is μα* in mas/yr)
}

console.log(count) // 258997

// An index of the whole file: a cone of 1° around the Orion Nebula, in B1950 coordinates.
await using file = fileHandleSource(await fs.open('data/SAO.pc.dat'))
const catalog = new SaoCatalog()
await catalog.load(file, false)

console.log(catalog.size, catalog.queryCone(deg(83.8), deg(-5.39), deg(1)).length) // 258997 55
console.log(catalog.get(62738)?.metadata?.magnitude, catalog.get(62738)?.metadata?.spType) // 6.5 G5

// A hand-made file of two stars: a 28-byte header (star0, first number, count, identifiers present, proper motion, magnitudes, bytes per entry) and 28-byte entries.
const header = Buffer.alloc(28)
;[0, 1, 2, 0, 1, 1, 28].forEach((value, i) => header.writeInt32LE(value, i * 4))

const entry = (ra: number, dec: number, sp: string, magnitude: number, pmRA: number, pmDEC: number) => {
	const buffer = Buffer.alloc(28)
	buffer.writeDoubleLE(ra, 0)
	buffer.writeDoubleLE(dec, 8)
	buffer.write(sp, 16, 'ascii')
	buffer.writeInt16LE(Math.round(magnitude * 100), 18)
	buffer.writeFloatLE(pmRA, 20)
	buffer.writeFloatLE(pmDEC, 24)
	return buffer
}

const bytes = Buffer.concat([header, entry(1, 0.5, 'K0', 5.5, 1e-6, -2e-6), entry(2, -0.5, 'B2', 3.25, 0, 0)])
const stars = []

for await (const star of readSaoCatalog(bufferSource(bytes), false)) stars.push(star)

console.log(stars.map((star) => [star.id, star.rightAscension, star.declination, star.spType, star.magnitude])) // [ [ 1, 1, 0.5, "K0", 5.5 ], [ 2, 2, -0.5, "B2", 3.25 ] ]
console.log(stars[0].pmRA, stars[0].pmDEC) // about 1e-6 -2e-6 (stored as 32-bit floats)

// A truncated last entry is dropped, and a file shorter than the header gives nothing.
const cut = []
for await (const star of readSaoCatalog(bufferSource(bytes.subarray(0, bytes.length - 5)), false)) cut.push(star.id)
console.log(cut, (await Array.fromAsync(readSaoCatalog(bufferSource(bytes.subarray(0, 20)), false))).length) // [ 1 ] 0

const small = new SaoCatalog({ nside: 4 })
await small.load(bufferSource(bytes), false)
console.log(
	small.size,
	small.queryCone(1, 0.5, 0.01).map((star) => star.id),
) // 2 [ 1 ]
```

### Star Catalog Interface and Spatial Query

Every star catalog of the toolkit, local or remote, answers the same `StarCatalog` interface, so the code that consumes stars (crossmatching, framing, annotation) does not depend on where they come from. A `StarCatalogEntry` is an equatorial position, `rightAscension` and `declination` in radians (J2000 unless the catalog says otherwise), plus the optional `epoch` (Julian year), `magnitude`, proper motions `pmRA` and `pmDEC` (radians per year), radial velocity `rv` and `parallax` (radians). The interface has `queryCone(centerRA, centerDEC, radius)`, `queryTriangle(a, b, c)`, `queryBox(minRA, maxRA, minDEC, maxDEC)`, `queryPolygon(vertices)`, `queryRegion(query)` for any of them as a tagged `StarCatalogQuery` (`kind` is `'cone'`, `'triangle'`, `'box'` or `'polygon'`), which return an array (or a promise of one), and `streamRegion(query)`, which yields the same entries one by one as an iterable or async iterable. A `Vertex` is `[rightAscension, declination]` in radians.

The geometry is exact and the same for every catalog. A cone is a spherical cap (a radius of 0 to π; the boundary counts as inside, within 1e-12 rad). A box covers `minDEC` to `maxDEC` (inclusive, with `minDEC <= maxDEC`) and a right ascension span that may wrap across 0, as in `359.7°` to `0.3°`. A triangle and a polygon (convex, three vertices or more, in either winding, and a repeated first vertex is accepted) are tested on a tangent plane centered on the vertices, so they are best for fields of tens of degrees or less, except that a region that contains or touches a pole is tested with great-circle edges. Vertices on the boundary count as inside. The ranges are not validated beyond the failures below, and a non-convex polygon gives whatever the ray casting gives.

`BaseStarCatalog<T>` is the base class of the concrete catalogs: a subclass implements only `streamCandidateEntries(query)`, which yields the entries that fall in the `preselectionBoxes` of a `NormalizedStarCatalogQuery` (one or two non-wrapping boxes in radians that cover the region, with `minRA <= maxRA` in 0..2π), and the base class applies the exact test, and implements the five query methods and `streamRegion`. The provider has to be tolerant at the edge of a box, since the exact test is the one that decides. `normalizeStarCatalogQuery(query)` is that normalization, with `geometryMode` (`'spherical'` or `'planarTangent'`), `wrapAround`, `preselectionBoxes` and `sortAnchor`; it throws an `Error` for a cone radius outside [0, π] or non-finite, a polygon of fewer than three vertices, an inverted declination range and an unknown kind. `splitRaBox(minRA, maxRA, minDEC, maxDEC)` returns the one or two boxes of a span, one full-circle box when the span is 2π or more, and `projectPolygonVertex(ra, dec, centerRA, centerDEC)` returns the tangent-plane `[Δra·cos(centerDEC), dec − centerDEC]` of a vertex in radians, with the right ascension difference taken the short way around.

```ts
import { BaseStarCatalog, type NormalizedStarCatalogQuery, normalizeStarCatalogQuery, projectPolygonVertex, splitRaBox, type StarCatalogEntry, type StarCatalogRaDecBox } from 'nebulosa/src/catalogs/stars/catalog'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

interface Star extends StarCatalogEntry {
	readonly id: string
}

// An in-memory catalog: it streams the stars that fall in the preselection boxes, with a margin at the edges.
class ListCatalog extends BaseStarCatalog<Star> {
	constructor(readonly stars: readonly Star[]) {
		super()
	}

	protected *streamCandidateEntries(query: NormalizedStarCatalogQuery) {
		for (const star of this.stars) {
			if (query.preselectionBoxes.some((box) => insideBox(star.rightAscension, star.declination, box))) yield star
		}
	}
}

function insideBox(ra: number, dec: number, box: StarCatalogRaDecBox) {
	return ra >= box.minRA - 1e-12 && ra <= box.maxRA + 1e-12 && dec >= box.minDEC - 1e-12 && dec <= box.maxDEC + 1e-12
}

const catalog = new ListCatalog([
	{ id: 'a', rightAscension: deg(0.1), declination: deg(5) },
	{ id: 'b', rightAscension: deg(359.9), declination: 0 },
	{ id: 'c', rightAscension: deg(120), declination: 0 },
	{ id: 'd', rightAscension: deg(130), declination: 0 },
	{ id: 'e', rightAscension: deg(130.2), declination: 0 },
	{ id: 'f', rightAscension: deg(102), declination: deg(12) },
	{ id: 'g', rightAscension: deg(108), declination: deg(18) },
	{ id: 'n1', rightAscension: deg(10), declination: deg(88) },
	{ id: 'n2', rightAscension: deg(200), declination: deg(86) },
	{ id: 'n3', rightAscension: deg(100), declination: deg(70) },
])

const ids = (stars: readonly Star[]) =>
	stars
		.map((star) => star.id)
		.sort()
		.join(',')

// A cone of 10° around RA 120°, Dec 0°: the star at exactly 10° is inside and the one at 10.2° is not.
console.log(ids(await catalog.queryCone(deg(120), 0, deg(10)))) // c,d

// A box that wraps across RA = 0.
console.log(ids(await catalog.queryBox(deg(359.7), deg(0.3), deg(-0.1), deg(10)))) // a,b

// A triangle and a polygon (a square) in the same area.
console.log(ids(await catalog.queryTriangle([deg(100), deg(10)], [deg(110), deg(10)], [deg(100), deg(20)]))) // f
console.log(
	ids(
		await catalog.queryPolygon([
			[deg(100), deg(10)],
			[deg(110), deg(10)],
			[deg(110), deg(20)],
			[deg(100), deg(20)],
		]),
	),
) // f,g

// The tagged form, and the stream of a region.
console.log(ids(await catalog.queryRegion({ kind: 'cone', centerRA: deg(120), centerDEC: 0, radius: deg(11) }))) // c,d,e

const streamed: string[] = []

for await (const star of catalog.streamRegion({ kind: 'box', minRA: deg(90), maxRA: deg(140), minDEC: 0, maxDEC: deg(20) })) streamed.push(star.id)

console.log(streamed) // [ "c", "d", "e", "f", "g" ]

// Near the pole: a polygon that surrounds it, and cones centered on it.
console.log(
	ids(
		await catalog.queryPolygon([
			[0, deg(80)],
			[deg(90), deg(80)],
			[deg(180), deg(80)],
			[deg(270), deg(80)],
		]),
	),
) // n1,n2
console.log(ids(await catalog.queryCone(0, deg(90), deg(5))), ids(await catalog.queryCone(0, deg(90), deg(25)))) // n1,n2 n1,n2,n3

// What a provider receives: the boxes that cover a cone centered at RA -10° (normalized to 350°), Dec 40°, with a radius of 5°.
const cone = normalizeStarCatalogQuery({ kind: 'cone', centerRA: deg(-10), centerDEC: deg(40), radius: deg(5) })
console.log(
	cone.kind,
	cone.geometryMode,
	cone.wrapAround,
	cone.preselectionBoxes.map((box) => [box.minRA, box.maxRA, box.minDEC, box.maxDEC].map(toDeg)),
	cone.sortAnchor?.map(toDeg),
) // cone spherical false [ [ 343.4670985802534, 356.5329014197467, 35, 45 ] ] [ 350, 40 ]

// A cone at RA 2° reaches across 0, so it is split in two boxes.
const wrapped = normalizeStarCatalogQuery({ kind: 'cone', centerRA: deg(2), centerDEC: deg(40), radius: deg(5) })
console.log(wrapped.wrapAround, wrapped.preselectionBoxes.length) // true 2

// A polygon around the pole is tested with great circles and covers every right ascension.
const polar = normalizeStarCatalogQuery({
	kind: 'polygon',
	vertices: [
		[0, deg(80)],
		[deg(90), deg(80)],
		[deg(180), deg(80)],
		[deg(270), deg(80)],
	],
})
console.log(
	polar.geometryMode,
	polar.preselectionBoxes.map((box) => [box.minRA, box.maxRA, box.minDEC, box.maxDEC].map(toDeg)),
) // spherical [ [ 0, 360, 80, 90 ] ]
console.log(normalizeStarCatalogQuery({ kind: 'triangle', a: [deg(100), deg(10)], b: [deg(110), deg(10)], c: [deg(100), deg(20)] }).geometryMode) // planarTangent

// The helpers: the boxes of a span, and the tangent-plane position of a vertex (a position 1° east and 1° north of the center, and another 2° west of RA 1°).
console.log(
	splitRaBox(deg(350), deg(10), -1, 1).map((box) => [box.minRA, box.maxRA].map(toDeg)),
	splitRaBox(0, deg(360), -1, 1).length,
	splitRaBox(deg(10), deg(20), -1, 1).length,
) // [ [ 0, 10 ], [ 350, 360 ] ] 1 1
console.log(projectPolygonVertex(deg(11), deg(21), deg(10), deg(20)).map(toDeg), projectPolygonVertex(deg(359), deg(20), deg(1), deg(20)).map(toDeg)) // [ 0.9396926207859083, 1.0000000000000013 ] [ -1.8793852415717955, 0 ]

// The failures of the normalization.
const invalid = [
	{ kind: 'cone', centerRA: 0, centerDEC: 0, radius: -1 },
	{ kind: 'polygon', vertices: [[0, 0]] },
	{ kind: 'box', minRA: 0, maxRA: 1, minDEC: 1, maxDEC: 0 },
] as const

for (const query of invalid) {
	try {
		normalizeStarCatalogQuery(query)
	} catch (e) {
		console.log((e as Error).message) // invalid cone radius: -1. Expected a finite value in [0, pi]; polygon queries require at least three vertices; invalid declination range: [1, 0]
	}
}
```

### Stellarium Catalog

Stellarium's deep-sky catalog is a binary `catalog.dat` of about 95 thousand objects (galaxies, clusters, nebulae and some stars) with their cross-identifiers, and `names.dat` is the text file with the common names of some of them. `readCatalogDat(source)` streams the big-endian records of a `Source` and yields `StellariumCatalogEntry` objects: `id` (the record number of the file, not an NGC or Messier number), `epoch` (2000), `rightAscension` and `declination` in radians, the `magnitude` (the V magnitude, or B when V is absent, or `undefined` when there is neither), the `type` (a `StellariumObjectType`, an enum that is 0 for `UNKNOWN`, with `GALAXY`, `OPEN_STAR_CLUSTER`, `PLANETARY_NEBULA`, `HII_REGION` and others), the `mType` morphological text when present, `majorAxis`, `minorAxis` and `orientation` in radians (0 when unknown), `redshift` (99 when unknown), `parallax` in radians, `distance` in AU (0 when unknown), and the identifiers `ngc`, `ic`, `m` (Messier), `c`, `b`, `sh2`, `vdb`, `rcw`, `ldn`, `lbn`, `cr`, `mel`, `pgc`, `ugc`, `arp`, `vv`, `dwb`, `tr`, `st`, `ru` and `vdbha` (numbers, 0 when the object has no such designation) and `ced`, `pk`, `png`, `snrg`, `aco`, `hcg`, `eso` and `vdbh` (text, `undefined` when none). The file has no proper motion. The reader keeps a 64 KiB buffer, and it ends at the end of the source.

`readNamesDat(source)` streams the names text, skips the lines that start with `#` and the lines that do not have the form `_("name")`, and yields `{ prefix, id, name }` where `prefix` is the catalog (`NGC`, `M`, `IC`... or empty), `id` the designation as text and `name` the translatable name; an object can have several names. `StellariumCatalog` is a `HealpixIndex<StellariumCatalogEntry>` with the queries of HEALPix Object Index and Star Catalog Interface and Spatial Query; `new StellariumCatalog({ nside, ordering })` defaults to NSIDE 8 and `load(source)` indexes every entry by its `id`, with the entry as `metadata` of each result. Large objects are indexed by their center only, so a cone selects an object when its center is inside, even if its extent crosses the border.

```ts
import { readCatalogDat, readNamesDat, StellariumCatalog, StellariumObjectType } from 'nebulosa/src/catalogs/stars/stellarium'
import { fileHandleSource } from 'nebulosa/src/io/file'
import { BufferSource } from 'nebulosa/src/io/io'
import { deg, formatDEC, formatRA, toArcmin } from 'nebulosa/src/math/units/angle'
import { toLightYear } from 'nebulosa/src/math/units/distance'
import fs from 'fs/promises'

// Read the whole catalog and count the objects of each type.
await using source = fileHandleSource(await fs.open('data/catalog.dat'))
const entries = []

for await (const entry of readCatalogDat(source)) entries.push(entry)

console.log(entries.length) // 94899

const types = new Map<string, number>()
for (const entry of entries) types.set(StellariumObjectType[entry.type], (types.get(StellariumObjectType[entry.type]) ?? 0) + 1)
console.log([...types].sort((a, b) => b[1] - a[1]).slice(0, 3)) // [ [ "GALAXY", 75025 ], [ "CLUSTER_OF_GALAXIES", 5246 ], [ "INTERACTING_GALAXY", 2474 ] ]

// The Orion Nebula (M 42 = NGC 1976) and the Andromeda Galaxy (M 31).
const m42 = entries.find((entry) => entry.m === 42)!
console.log(m42.id, m42.ngc, m42.sh2, m42.ced, m42.magnitude, StellariumObjectType[m42.type], m42.mType) // 1879 1976 281 55d 4 HII_REGION EN+RN; 3, 2, 3
console.log(formatRA(m42.rightAscension), formatDEC(m42.declination), toArcmin(m42.majorAxis), toArcmin(m42.minorAxis), Math.round(toLightYear(m42.distance))) // 05 35 17.30 -05 23 27.96 90 60 1344

const m31 = entries.find((entry) => entry.m === 31)!
console.log(m31.id, StellariumObjectType[m31.type], m31.mType, m31.magnitude?.toFixed(1), toArcmin(m31.majorAxis).toFixed(1), toArcmin(m31.minorAxis).toFixed(1), m31.ngc, m31.pgc, m31.redshift.toFixed(4)) // 255 GALAXY SA(s)b 3.4 189.1 61.7 224 2557 -0.0010

// A 0 identifier means none, and a missing magnitude is undefined (NGC 281 has none).
console.log(entries.find((entry) => entry.ngc === 281)?.magnitude) // undefined

// An index of the catalog: a cone of 1° around the Orion Nebula, with the entry as the metadata of each result.
await using file = fileHandleSource(await fs.open('data/catalog.dat'))
const catalog = new StellariumCatalog()
await catalog.load(file)

const field = catalog.queryCone(deg(83.8), deg(-5.39), deg(1))
console.log(catalog.size, field.length) // 94899 11
console.log(field.filter((object) => object.metadata!.ngc).map((object) => `NGC ${object.metadata!.ngc} ${StellariumObjectType[object.metadata!.type]}`)) // [ "NGC 1976 HII_REGION", "NGC 1980 STAR_CLUSTER", "NGC 1982 HII_REGION", "NGC 1973 BIPOLAR_NEBULA", "NGC 1975 BIPOLAR_NEBULA", "NGC 1977 BIPOLAR_NEBULA", "NGC 1981 STAR_CLUSTER" ] (in index order, which may differ)

// The common names: several names for one object, and the filter by catalog.
await using namesFile = fileHandleSource(await fs.open('data/names.dat'))
const names = []

for await (const name of readNamesDat(namesFile)) names.push(name)

console.log(names.length) // 1388
console.log(names.filter((name) => name.prefix === 'NGC' && name.id === '1976').map((name) => name.name)) // [ "Great Orion Nebula", "Orion Nebula", "Orion A" ]
console.log(names.filter((name) => name.prefix === 'M' && name.id === '8').map((name) => name.name)) // [ "Lagoon Nebula", "Hourglass Region" ]

// A small text: comments and lines without the _("...") form are skipped, and the prefix may be empty.
const line = (prefix: string, id: string, name: string) => `${prefix.padEnd(5)}${id.padEnd(15)}${name}`
const text = ['# comment', line('NGC', '40', '_("Bow-Tie Nebula")'), line('IC', '1', 'Plain text name'), line('', '49', '_("Norma Star Cloud") # note')].join('\n') + '\n'
console.log(await Array.fromAsync(readNamesDat(new BufferSource(Buffer.from(text))))) // [ { prefix: "NGC", id: "40", name: "Bow-Tie Nebula" }, { prefix: "", id: "49", name: "Norma Star Cloud" } ]
```

### Tiled Sky Catalog

HNSKY and ASTAP distribute their star databases as thousands of small binary files, one per tile of the sky, so that a query reads only the few tiles that it touches. The module `tiled.catalog` is the engine shared by the two formats (the concrete ones are ASTAP Tiled Catalog and HNSKY Tiled Catalog): it describes a tiling, finds the tiles of a field, decodes the packed records and exposes the result as a star catalog. A tiling (`TiledSkyGeometry`) is a list of declination bands from the south to the north pole, each divided in a number of equal right ascension cells; the tiles are numbered from 1, band after band, and a tile file is named by its 1-based band and cell as `BBCC` plus the extension (`0203.1476`). Inside a database the file key is `<database>_<file name>` (`d05_0203.1476`).

Each tile file has a 110-byte header (a description of 108 bytes, the version byte and the record size byte, which is 5, 6, 7, 9, 10 or 11, with `0x20` read as 11) followed by records that are sorted by magnitude. A record has a 24-bit right ascension (`raRaw`, a full circle over 2²⁴−1, so `TILED_STAR_RA_SCALE` radians per unit) and a signed 24-bit declination (`decRaw`, a quarter circle over 2²³−1, `TILED_STAR_DEC_SCALE`), with the magnitude and the high byte of the declination shared with the next records through special header records; larger sizes also carry a color byte and a packed designation. The epoch of the positions is the `Epoch=` tag of the header description, or the default of the format.

`createTiledSkyGeometry(ringCounts, decBoundaries, extension)` builds a tiling from the cells of each band and the `ringCounts.length + 1` declination boundaries in radians (it throws an `Error` for another count) and precomputes `areas`, `areaBounds` and `areaOffsets`. `lookupTiledStarArea(geometry, area)` returns the shared descriptor of an area number and throws a `RangeError` when it is not an integer from 1 to `areaCount`, and `tiledStarAreaFile` returns a copy. `findTiledStarAreas(geometry, ra, dec, radius)` returns the 1 to 4 tiles that a square field of half width `radius` (radians, a square in declination and in right ascension times cos δ, so the longitude span grows by 1/cos δ toward the poles) touches, each with the `fraction` of the field that it covers (tiles that cover less than 1% are dropped, and the fractions of a field on a border are estimates that may overlap). `readTiledStarHeader(buffer, defaultEpoch, label)` parses the header and throws for an unsupported record size, `createTiledStarRawRecord()` and `scanTiledStarRecords(header, buffer, cursor)` walk the records of a tile through one reused cursor (`recordNumber`, `raRaw`, `decRaw`, `magnitude`, and `designationValue` and `colorRaw` with their `has` flags), so the cursor must be consumed before the iterator advances. `readTiledStarArea(header, buffer, area, query, materialize)` yields the records of a tile inside a square field (`rightAscension`, `declination`, `radius`, and an optional `magnitudeLimit`, which ends the scan at the first fainter record), `findTiledStarRegion(files, database, geometry, query, defaultEpoch, label, materialize)` reads the touched tiles in parallel, skips the missing ones and returns `{ areas, headers, stars }` with the stars sorted by magnitude, `decodeTiledStarDesignation(value)` turns a packed identifier into a Tycho-2 or UCAC4 designation, `bufferFromTiledStarFile(file)` normalizes a `Buffer`, typed array, `ArrayBuffer` or `File`, `touchedTiledStarAreas(geometry, query)` lists the areas that the preselection boxes of a normalized query touch, `matchesPreselectionBoxes(ra, dec, boxes)` is the point test with a 1e-12 rad tolerance and `validateTiledStarRecordNumber(n)` throws a `RangeError` unless `n` is an integer of at least 1.

`TiledStarCatalog<T, DB>` is the abstract `BaseStarCatalog` of the tiles: a subclass calls the protected constructor with a geometry, a default epoch, a label for the messages and a default database, and implements `buildEntry(record, header, area)`. `open(files, database?)` takes a `Map` or an object of files (the tile contents are read when first needed) and throws when none has the database prefix and the extension, `close()` and `[Symbol.dispose]()` drop the cached tiles, `get(database, area, recordNumber)` returns one entry or `undefined`, `loadArea(area)` loads and caches a tile (concurrent calls share one read, a missing file is cached as `undefined` and a failure is not), `hasAnyAreaFile()` tells whether the open collection has a tile, and the region queries of Star Catalog Interface and Spatial Query read the touched tiles and keep the stars that pass the exact test. A query on a catalog that was not opened or was closed throws. The positions have the epoch of the tile and are not moved by any proper motion.

```ts
import {
	createTiledStarRawRecord,
	createTiledSkyGeometry,
	bufferFromTiledStarFile,
	decodeTiledStarDesignation,
	findTiledStarAreas,
	findTiledStarRegion,
	lookupTiledStarArea,
	matchesPreselectionBoxes,
	readTiledStarArea,
	readTiledStarHeader,
	scanTiledStarRecords,
	TILED_STAR_DEC_SCALE,
	TILED_STAR_RA_SCALE,
	TiledStarCatalog,
	type TiledStarRawRecord,
	tiledStarAreaFile,
	touchedTiledStarAreas,
	validateTiledStarRecordNumber,
	type TiledStarFileHeader,
} from 'nebulosa/src/catalogs/stars/tiled.catalog'
import { normalizeStarCatalogQuery, type StarCatalogEntry } from 'nebulosa/src/catalogs/stars/catalog'
import { PIOVERTWO } from 'nebulosa/src/core/constants'
import { deg, toDeg } from 'nebulosa/src/math/units/angle'

// A tiling of three bands: a south cap of 1 cell, a band with 4 cells of 90° between -30° and +30°, and a north cap.
const geometry = createTiledSkyGeometry([1, 4, 1], [-PIOVERTWO, -deg(30), deg(30), PIOVERTWO], '.demo')
console.log(
	geometry.areaCount,
	geometry.areaOffsets,
	geometry.areas.map((area) => area.fileName),
) // 6 [ 0, 1, 5 ] [ "0101.demo", "0201.demo", "0202.demo", "0203.demo", "0204.demo", "0301.demo" ]
console.log(geometry.areaBounds[2]) // { minRA: 1.5707963267948966, maxRA: 3.141592653589793, minDEC: -0.5235987755982988, maxDEC: 0.5235987755982988 }
console.log(lookupTiledStarArea(geometry, 3), tiledStarAreaFile(geometry, 6)) // { area: 3, ring: 2, index: 2, fileName: "0202.demo", fraction: 0 } { area: 6, ring: 3, index: 1, fileName: "0301.demo", fraction: 0 }

// The tiles of a square field of 2° of half width: inside one tile, across the border of two, and at a corner of three.
const tiles = (ra: number, dec: number) => findTiledStarAreas(geometry, deg(ra), deg(dec), deg(2)).map((area) => [area.area, area.fileName, Number(area.fraction.toFixed(3))])
console.log(tiles(100, 0)) // [ [ 3, "0202.demo", 1 ] ]
console.log(tiles(89.5, 0)) // [ [ 3, "0202.demo", 0.75 ], [ 2, "0201.demo", 1 ] ] (the fractions overlap at the border)
console.log(tiles(0.5, 29)) // [ [ 6, "0301.demo", 0.5 ], [ 2, "0201.demo", 0.459 ], [ 5, "0204.demo", 0.291 ] ]

for (const attempt of [() => createTiledSkyGeometry([1, 1], [0, 1], '.x'), () => lookupTiledStarArea(geometry, 7), () => validateTiledStarRecordNumber(0)]) {
	try {
		attempt()
	} catch (e) {
		console.log((e as Error).message) // invalid tiling: 2 bands need 3 boundaries, got 2; invalid .demo area: 7; invalid record number: 0
	}
}

// The packed designations: UCAC4 when the value is not negative, Tycho-2 (with its component) otherwise.
console.log(decodeTiledStarDesignation((5 << 20) | 1234).label, decodeTiledStarDesignation(-((100 << 16) | 0x8000 | 55)).label, decodeTiledStarDesignation(-((100 << 16) | 0x40000000 | 55)).label) // UCAC4 5-1234 TYC 100-55-3 TYC 100-55-2
console.log(TILED_STAR_RA_SCALE, TILED_STAR_DEC_SCALE) // 3.7450705061475256e-7 1.8725353646855748e-7

// A real tile: the south polar cap of the ASTAP d05 database (5-byte records, 10387 stars).
const buffer = Buffer.from(await Bun.file('data/d05_0101.1476').arrayBuffer())
const header = readTiledStarHeader(buffer, 2000, 'ASTAP .1476')
console.log(header.recordSize, header.version, header.epoch, header.description) // 5 32 2025 GAIA DR3, density<=500 stars/sqr(degree), Epoch=2025. Including 82 bright Tycho2 stars. Magnitude is BP

const cursor = createTiledStarRawRecord()
let count = 0

for (const record of scanTiledStarRecords(header, buffer, cursor)) {
	if (count++ === 0) console.log(record.recordNumber, record.raRaw, record.decRaw, record.magnitude, record.hasColor, record.hasDesignation) // 2 14782838 -8291343 5.5 false false (the cursor is reused: copy what you need)
}

console.log(count) // 10387

// The stars of a square field of 1° half width around the pole of the tile, and with a magnitude limit.
const materialize = (area: number, record: Readonly<TiledStarRawRecord>) => ({ area, magnitude: record.magnitude, rightAscension: record.raRaw * TILED_STAR_RA_SCALE, declination: record.decRaw * TILED_STAR_DEC_SCALE })
const field = [...readTiledStarArea(header, buffer, 1, { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5) }, materialize)]
console.log(field.length, field[0].magnitude, toDeg(field[0].declination).toFixed(3)) // 483 9.8 -89.169 (the field has no star brighter than magnitude 9.8)
console.log([...readTiledStarArea(header, buffer, 1, { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5), magnitudeLimit: 8 }, materialize)].length) // 0

// The same through a one-tile tiling (the cap) and a collection of files, which can be a Map or an object.
const cap = createTiledSkyGeometry([1, 1], [-PIOVERTWO, deg(-87.42857143), PIOVERTWO], '.1476')
const found = await findTiledStarRegion({ 'd05_0101.1476': buffer }, 'd05', cap, { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5) }, 2000, 'ASTAP .1476', materialize)
console.log(found.areas.length, found.headers.length, found.stars.length, found.stars[0].magnitude <= found.stars[1].magnitude) // 1 1 483 true
console.log((await findTiledStarRegion(new Map(), 'd05', cap, { rightAscension: 0, declination: deg(-89.5), radius: deg(0.5) }, 2000, 'x', materialize)).stars.length) // 0 (a missing tile is skipped)

// bufferFromTiledStarFile accepts a Buffer, a typed array, an ArrayBuffer or a File-like.
console.log(await bufferFromTiledStarFile(new Uint8Array([1, 2, 3])), await bufferFromTiledStarFile(new Uint8Array([1, 2, 3]).buffer), await bufferFromTiledStarFile(new Blob([new Uint8Array([9, 8])]) as unknown as File)) // <Buffer 01 02 03> <Buffer 01 02 03> <Buffer 09 08>

// Which tiles a normalized query touches, and the point test of the preselection boxes.
const query = normalizeStarCatalogQuery({ kind: 'box', minRA: deg(100), maxRA: deg(200), minDEC: deg(-10), maxDEC: deg(10) })
console.log(touchedTiledStarAreas(geometry, query)) // [ 3, 4 ]
console.log(matchesPreselectionBoxes(1, 0.5, [{ minRA: 0.9, maxRA: 1.1, minDEC: 0.4, maxDEC: 0.6 }]), matchesPreselectionBoxes(2, 0.5, [{ minRA: 0.9, maxRA: 1.1, minDEC: 0.4, maxDEC: 0.6 }])) // true false

// A catalog on top of the engine: only buildEntry is needed.
class DemoCatalog extends TiledStarCatalog<StarCatalogEntry & { area: number }, 'd05'> {
	constructor() {
		super(cap, 2000, 'demo .1476', 'd05')
	}

	protected buildEntry(record: Readonly<TiledStarRawRecord>, header: TiledStarFileHeader, area: number) {
		return { epoch: header.epoch, area, rightAscension: record.raRaw * TILED_STAR_RA_SCALE, declination: record.decRaw * TILED_STAR_DEC_SCALE, magnitude: record.magnitude }
	}
}

const catalog = new DemoCatalog()

try {
	await catalog.queryCone(0, deg(-89.5), deg(0.5))
} catch (e) {
	console.log((e as Error).message) // demo .1476 catalog is not open
}

try {
	catalog.open({ 'other_0101.1476': buffer })
} catch (e) {
	console.log((e as Error).message) // no .1476 files were found for d05
}

catalog.open({ 'd05_0101.1476': buffer })
console.log(catalog.database, catalog.hasAnyAreaFile(), (await catalog.loadArea(1))?.header.epoch, (await catalog.loadArea(1)) === (await catalog.loadArea(1))) // d05 true 2025 true
console.log(await catalog.loadArea(2)) // undefined (no file in the collection)
console.log((await catalog.queryCone(0, deg(-89.5), deg(0.5))).length, (await catalog.queryCone(0, deg(-88.5), deg(1))).length) // 374 1468
console.log(await catalog.get('d05', 1, 2), await catalog.get('d05', 1, 99999), await catalog.get('d04' as 'd05', 1, 2)) // { epoch: 2025, area: 1, rightAscension: 5.536277059095688, declination: -1.5525832988238188, magnitude: 5.5 } undefined undefined
catalog.close()

try {
	await catalog.queryCone(0, deg(-89.5), deg(0.5))
} catch (e) {
	console.log((e as Error).message) // demo .1476 catalog is not open
}
```

### UCAC4 Catalog

UCAC4 (the fourth USNO CCD Astrograph Catalog) has about 113 million stars to roughly magnitude 16, and its native distribution is a directory of 900 binary zone files `z001` to `z900`, each one a strip of 0.2° of declination (zone = floor((δ + 90°) / 0.2°) + 1, with 900 for the north pole) whose records of 78 bytes are sorted by right ascension. The catalog does not load the files in memory: `Ucac4Catalog` opens the root directory, finds the zone files in the root or in the `u4b`, `u4s` and `u4n` subdirectories, reads only the records that the preselection of a query may touch and caches the file handles. The optional `u4index.unf` (in the root or in `u4i`) is a table of the first record and the count for each cell of 0.25° of right ascension of each zone, which narrows the records read from a zone; without it every record of the touched zones is read. The optional `u4hpm.dat` supplies the proper motion of the stars whose stored motion is the sentinel 32767 (more than 3276.7 mas/yr).

`ucac4ZoneForDec(dec)` gives the zone of a declination in radians. `openUcac4Catalog(root)` creates a `Ucac4Catalog` and opens it, and `catalog.open(root)` does the same for an existing instance, throwing when the root is empty or missing, when it is not accessible, when no zone file is found, when the index file does not have the size of 900 × 1440 pairs of 32-bit integers, and when `u4hpm.dat` has a row that does not have eight integers. The queries are the ones of Star Catalog Interface and Spatial Query (`queryCone`, `queryBox`, `queryTriangle`, `queryPolygon`, `queryRegion` and `streamRegion`), are asynchronous, and return `Ucac4CatalogEntry` objects with the fields of the interface (`rightAscension` and `declination` in radians, J2000 ICRS, at the epoch of the catalog; `pmRA` and `pmDEC` in radians per year, where `pmRA` is the dα/dt obtained from the stored μα·cos δ; `magnitude`, the UCAC aperture magnitude, or the model one, or the 2MASS J, in this order, when it is not missing) plus the native `zone` and `recordNumber` (starting at 1) of the star. A star whose proper motion is the sentinel and is not in `u4hpm.dat` has `pmRA` and `pmDEC` `undefined`. `get(zone, recordNumber)` returns one entry, or `undefined` for a record beyond the end of the zone, and throws for a zone outside 1 to 900 or a record number that is not an integer of at least 1; `readRawRecord(zone, recordNumber)` is the same lookup, which `get` wraps. `hasAnyZoneFile()` is the asynchronous scan that `open` uses to find zone files and caches them, so it reports only zones not yet discovered and is `false` on an opened catalog, `root` is the opened path, and `close()` releases the handles. A query of a closed catalog throws `UCAC4 catalog is not open`, and a record with a right ascension outside 0° to 360° or a south pole distance outside 0° to 180° throws `invalid UCAC4 coordinates`. The files of the real catalog have to be downloaded from USNO, and the examples below use a small synthetic root built with the layout of the readme of the catalog.

```ts
import { openUcac4Catalog, ucac4ZoneForDec } from 'nebulosa/src/catalogs/stars/ucac4'
import { deg, toDeg, toMas } from 'nebulosa/src/math/units/angle'
import fs from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

// The zone of a declination: 0.2° strips from the south pole.
console.log(ucac4ZoneForDec(deg(-90)), ucac4ZoneForDec(deg(0)), ucac4ZoneForDec(deg(0.19)), ucac4ZoneForDec(deg(0.2)), ucac4ZoneForDec(deg(90))) // 1 451 451 452 900

// A synthetic root: the zone 451 (Dec 0° to 0.2°) with three stars sorted by right ascension, the high proper motion sentinel on the third.
const RECORD_SIZE = 78

const record = (buffer: Buffer, index: number, ra: number, dec: number, apertureMag: number, pmRA: number, pmDEC: number, id: number) => {
	const offset = index * RECORD_SIZE
	buffer.writeInt32LE(Math.round(toMas(ra)), offset) // RA in mas
	buffer.writeInt32LE(Math.round(toMas(dec)) + 324000000, offset + 4) // south pole distance in mas
	buffer.writeInt16LE(20000, offset + 8) // no model magnitude
	buffer.writeInt16LE(Math.round(apertureMag * 1000), offset + 10)
	buffer.writeInt16LE(Math.round(pmRA * 10), offset + 24) // μα·cos δ in tenths of mas/yr
	buffer.writeInt16LE(Math.round(pmDEC * 10), offset + 26)
	buffer.writeInt16LE(11000, offset + 34) // J = 11
	buffer.writeInt32LE(id, offset + 68)
}

const root = await fs.mkdtemp(join(tmpdir(), 'ucac4-'))
const zone = Buffer.alloc(RECORD_SIZE * 3)
record(zone, 0, deg(10), deg(0.05), 12.5, 40, -10, 451001)
record(zone, 1, deg(10.01), deg(0.1), 14, -3.5, 2.5, 451002)
record(zone, 2, deg(200), deg(0.15), 9.25, 3276.7, 3276.7, 451003)
await fs.writeFile(join(root, 'z451'), zone)

// The motion supplement: unique number, zone, record in the zone, μα·cos δ and μδ in tenths of mas/yr, RA, SPD and magnitude (the last three are unused).
await fs.writeFile(join(root, 'u4hpm.dat'), '451003 451 3 41087 -31413 0 0 9250\n')

const catalog = await openUcac4Catalog(root)
console.log(catalog.root === root, await catalog.hasAnyZoneFile()) // true false (the zone was already found by open)

// A cone of 0.1°: two stars, the entries carry the zone and the record.
const cone = await catalog.queryCone(deg(10), deg(0.07), deg(0.1))
console.log(cone.map((entry) => [entry.zone, entry.recordNumber, entry.magnitude])) // [ [ 451, 1, 12.5 ], [ 451, 2, 14 ] ]

// The proper motion: μα* in mas/yr is dα/dt times cos δ.
const star = (await catalog.get(451, 1))!
console.log(toMas(star.pmRA!) * Math.cos(star.declination), toMas(star.pmDEC!), toDeg(star.declination)) // 40 -10 0.05

// The sentinel resolved from the supplement, and the record that does not exist.
const fast = (await catalog.get(451, 3))!
console.log(toMas(fast.pmRA!) * Math.cos(fast.declination), toMas(fast.pmDEC!), fast.magnitude) // 4108.7 -3141.3 9.25
console.log(await catalog.get(451, 4), (await catalog.readRawRecord(451, 2))?.recordNumber) // undefined 2

// A box and a stream: the region form is the one of the star catalog interface.
console.log((await catalog.queryBox(deg(199), deg(201), deg(0.1), deg(0.2))).map((entry) => entry.recordNumber)) // [ 3 ]
const streamed = []
for await (const entry of catalog.streamRegion({ kind: 'cone', centerRA: deg(10), centerDEC: deg(0.07), radius: deg(1) })) streamed.push(entry.recordNumber)
console.log(streamed) // [ 1, 2 ]

// The errors.
try {
	await catalog.get(901, 1)
} catch (e) {
	console.log((e as Error).message) // invalid UCAC4 zone number: 901
}

try {
	await openUcac4Catalog(join(root, 'missing'))
} catch (e) {
	console.log((e as Error).message.startsWith('unable to access UCAC4 root')) // true
}

await catalog.close()
await fs.rm(root, { recursive: true, force: true })
```

## 🖲️ Devices

### ASCOM Alpaca Device Adapter

### ASCOM Alpaca Discovery Client

### ASCOM Alpaca Discovery Server

### ASCOM Alpaca REST API

### ASCOM Alpaca Server

### Firmata Accelerometer

### Firmata Ammeter

### Firmata Analog Thermometer

### Firmata Barometer and Altimeter

### Firmata Character Display

### Firmata DAC

### Firmata Digital Thermometer

### Firmata FM Receivers

### Firmata FM Transmitter

### Firmata Hygrometer

### Firmata IO Expander

### Firmata Light Sensors

### Firmata Magnetometer

### Firmata Peripheral Base

### Firmata Real-Time Clock

### Firmata-to-INDI Bridge

### INDI Camera Control

### INDI Camera Simulator

### INDI Client Simulator

### INDI Cover

### INDI Cover Simulator

### INDI Dew Heater

### INDI Dome and Roof

### INDI Dome Simulator

### INDI Filter Wheel

### INDI Filter Wheel Simulator

### INDI Flat Panel

### INDI Flat Panel Simulator

### INDI Focuser Control

### INDI Focuser Simulator

### INDI Guide Output

### INDI Mount Alignment Subsystem

### INDI Mount Control

### INDI Mount Simulator

### INDI Power Channels

### INDI Protocol Client

### INDI Rotator

### INDI Rotator Simulator

### INDI Safety Monitor

### INDI Safety Simulator

### INDI Thermometer

### INDI Weather

### INDI Weather Simulator

## 🌐 External Services

### ADES Codec

### AstroBin Equipment API

### Close Approach Data

### Gaia DR3 Star Catalog

### HiPS Survey Discovery

### HiPS2FITS Cutouts

### IAU Meteor Data Center catalog

### JPL Horizons Observer Tables

### JPL Horizons Orbital Elements

### JPL Horizons SPK Downloads

### JPL Horizons State Vectors

### JPL Small-Body Lookup

### Minor Planet Center API

### MPC1992 Codec

### SIMBAD Object Types

### SIMBAD Star Catalog

### SIMBAD TAP Queries

### Small-Body Identification

### VizieR TAP Queries

## 💾 I/O and Data Formats

### Buffer Byte I/O

### Byte Reading, Writing, and Transfer

### Byte Shuffling

### Byte-Stream Contracts

### CRC Checksums

### CSV Parsing

### Deflate Compression

### File-Handle Byte I/O

### FITS Containers and HDUs

### FITS Header Cards and Metadata

### FITS Pixel I/O and Rice Tiles

### FITS Rice Compression

### Growable Binary Buffers

### HTTP Range Byte Sources

### JPEG via TurboJPEG

### ReadableStream Byte Sources

### Streaming Base64

### Streaming Text Lines

### XISF Containers and Metadata

### XISF Pixel I/O and Compression

### XML Parsing

## 🔢 Numerical

### 2D Vectors

### 2x2 Matrices

### 3D Vectors

### 3x3 Matrices

### Angle Parsing and Formatting

### Angle Units and Wrapping

### Barometric Pressure and Altitude

### Clamping and Tolerant Equality

### Dense Linear System Solvers

### Dense Matrix Operations

### Descriptive Statistics

### Distance Units

### Ellipse Containment Geometry

### Ellipse Fitting

### Error-Free Floating-Point Arithmetic

### Exponential and Power Regression

### Great-Circle Geometry

### Histogram Analysis

### Hyperbolic Regression

### Line Intersection with Spheres and Ellipsoids

### Linear Least Squares

### Linear Regression

### Multivariate Minimization

### Modulo and Integer Division

### Nonlinear Least Squares

### Number Array Type and Detection

### Planar Points and Rectangles

### Polynomial and Chebyshev Regression

### Pressure Units

### Probability Distribution Functions

### Quickselect Order Statistics

### Random Distributions and Shuffling

### Rigid Transforms

### Rounding and Integer Conversion

### Scalar Interpolation and Remapping

### Scalar Minimization

### Scalar Root Finding

### Seeded Random Sources

### Spherical Mount Bases

### Spherical Tangent Planes

### Spherical Triangles and Polygons

### Splines and Interpolation

### Temperature Units

### Trend-Line Regression

### Velocity Units

## 💻 Protocols

### Firmata Board Client

### Firmata DHT

### Firmata Encoders

### Firmata Frequency Measurement

### Firmata I2C

### Firmata One-Wire

### Firmata Scheduler

### Firmata Serial

### Firmata SPI

### Firmata Stepper

### Firmata Wire Protocol

### LX200 Telescope Protocol

### PHD2 Client

### Stellarium Telescope Control Protocol
