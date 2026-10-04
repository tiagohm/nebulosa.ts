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

### Astrometric Sample-Grid Interpolation

### Astronomical State Ownership

### Astronomical Time Arithmetic

### Astronomical Time Representation and Epochs

### Astronomical Time-Scale Conversion

### B-Plane

### Barycentric and Heliocentric Light-Time Correction

### Binary PCK Rotation

### Body-Surface Solar Illumination

### Carrington Rotation

### Celestial and Terrestrial Reference Frames

### Civil UTC Timestamps

### Constellations

### DAF Binary Containers

### Delta T

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

### Differential Refraction and Atmospheric Dispersion

### Earth Occultation of a Finite Target

### Earth Orientation Parameters

### Elliptic Elements to Rectangular State

### ELP/MPP02 Lunar Theory

### Ephemeris Observed Positions

### Ephemeris Path Adapters

### Ephemeris Path Composition

### Equation of Time

### Equatorial Ephemeris Interpolation

### Equatorial Mount Geometric Pointing Errors

### Equinoxes and Solstices

### ERFA / SOFA Algorithms

### FK5 Precession and ICRS Frame Bias

### Galactocentric Frame

### Galilean Satellite Theory (L1.2)

### Gauss Angles-Only Orbit Determination

### GCRS to ITRS Rotation

### Geographic Observer

### Geographic Sub-point

### Gibbs Orbit Determination

### Great Red Spot Transits

### Greatest Solar Eclipse Circumstances

### HEALPix Object Index

### HEALPix Pixelization and Covers

### Heliacal Events

### Herrick-Gibbs Orbit Determination

### Hour-Angle Windows

### IAU Body Orientation

### Instantaneous Earth Spin

### Jupiter Central Meridian

### Kepler Anomalies and Periapsis Timing

### Light-Time Solution

### Local ENU Frames

### Local Horizon Coordinates

### Local Horizon Mask

### Local Lunar Eclipse Search

### Local Lunar Eclipse View Geometry

### Local Solar Eclipse Circumstances

### Local Solar Eclipse Search

### Local Solar Eclipse View Geometry

### Local Standard of Rest Frames

### Local Taki Frames

### Location GCRS Frame

### Low-Precision Earth Ephemeris

### Low-Precision Lunar Ephemeris

### Lunar Apsides

### Lunar Declination Extrema and Standstills

### Lunar Eclipse Local Circumstances

### Lunar Eclipse Map SVG Paths

### Lunar Eclipse Search

### Lunar Eclipse Visibility Geometry

### Lunar Libration Extrema

### Lunar Parallax and Semidiameter

### Lunar Phase and Lunation

### Lunar Nodes

### Lunar Saros Index

### Martian Satellite Theory (MARSSAT)

### Meeus Algorithms

### Meteor Activity Profiles

### Meteor Observing Windows

### Meteor Orbit Reconstruction

### Meteor Orbit Similarity

### Meteor Radiants

### Meteor Shower State

### Meteor Solar Longitude

### Meteor Track Association

### Meteor Trajectory Correction

### Meteor Visual Rates

### Minimum Orbit Intersection Distance

### MPCORB Parsing

### Mutual Planetary-Satellite Events

### Nutation and Celestial Orientation

### Obliquity and Ecliptic Orientation

### Observed Catalog Star

### Observing Visibility Windows

### Orbit Covariance Propagation

### Osculating Orbital Elements

### Planetary Apparent Magnitudes (Mallama and Hilton)

### Planetary Closest Approaches

### Planetary Conjunctions

### Planetary Disk Transits

### Planetary Greatest Elongations

### Planetary Oppositions

### Planetary Quadratures

### Planetary Stations

### Planetary Surface Locations

### Pluto Short Analytical Theory

### Polar Motion

### Precession Matrices

### Projected Paths and Polygons

### Radial Doppler Shift

### Radial Velocity Correction

### Refractive Displacement

### Rise, Transit, and Set

### Sampled Angular Motion

### Satellite Conjunctions

### Satellite Eclipses

### Satellite Look Angles

### Satellite Ground Footprint

### Satellite Orbit Beta Angle

### Satellite Passes

### Satellite Sub-point

### Satellite Tracking Rates

### Satellite Trail Prediction

### Satellite Visibility Intervals

### Satellite Visual Magnitude

### Saturnian Satellite Theory (TASS1.7)

### SGP4/SDP4 Propagation

### Sidereal Time and Earth Rotation Angle

### Sky Projections

### Sky-Plane Uncertainty Ellipses

### Solar Eclipse Besselian Elements

### Solar Eclipse Ground-Track Geometry

### Solar Eclipse Map SVG Paths

### Solar Eclipse Search and Classification

### Solar Parallax and Semidiameter

### Solar Saros Index

### Spherical Coordinate Conversions

### Spherical State Rates

### SPICE Body Radii

### SPICE Frame Resolution

### SPICE Text Kernel Pools

### SPK State Kernels

### Starlight Deflection

### Stellar and Asteroidal Occultations

### Stellar Space Motion

### Sub-Observer and Sub-Solar Points

### TEME and ITRF Conversion

### Time-Constraint Intervals

### Time-Domain Event Search

### Time-Domain Extrema Search

### TLE, OMM, and SGP4 Record Construction

### Topocentric Observed Place

### Transit Altitude and Hour Angle

### Tube Flexure Pointing Error

### Twilight and Darkness Windows

### Two-Body Kepler Propagation

### Uranian Satellite Theory (GUST86)

### VSOP87E Planetary Theory

### Zenith and Celestial Circle Intersections

## 📐 Astrometry

### ASTAP Plate Solving

### ASTAP Star Detection

### Astrometry.net Index Selection

### Catalog Crossmatching

### FITS TAN and SIP Coordinate Mapping

### FITS WCS Geometry Updates

### Local Astrometry.net Plate Solving

### Native libastrometry Plate Solving

### Nova Astrometry.net Plate Solving

### Planar Similarity and Affine Transforms

### Plate Solution

### SIP Distortion Fitting

### Star Pattern Matching

### WCSLIB Equatorial Projection

## 🖼️ Imaging

Plan telescope and camera combinations, then work with captured or synthetic images.

### Aberration Inspector

### Arcsinh Stretch

### Automatic Background Extraction

### Backfocus Correction Estimates

### Background Estimate

### Background Neutralization

### Bahtinov Chromatic Comparison

### Bahtinov Focus Analysis

### Bahtinov Overlay Geometry

### Bounded Robust Sampling

### Celestial Streak Tracks

### Collimation Sequence Summary

### Cosmetic Correction

### Critical Focus Planning Estimate

### Critical Focus Zone

### Curves

### Dark Current

### Debayering

### Defocused Annular Geometry Analysis

### Diffraction and Seeing Sampling

### Display Stretch Parameter Estimation

### Drizzle Integration

### Elliptical Moffat Fitting

### Eyepiece Magnification and Exit Pupil

### FFT Image Filter

### Flat Exposure Estimate

### Flat Sequence Stability

### Flat-Frame Quality

### Focus Curve Fitting

### Focus Field Curvature

### Focus Surface Analysis

### Frame Saturation

### Global Image Normalization

### Grayscale Image Conversion

### Image Analysis Planes

### Image Arithmetic

### Image Calibration

### Image Cloning and Copying

### Image Convolution

### Image Intensity Inversion

### Image Mirroring

### Image Scale and Field of View

### Image Stacking

### Image Statistics

### Image Warp

### Live Stacking

### Local Image Normalization

### Multiscale Linear Transform

### Multiscale Median Transform

### Photon Transfer and Read Noise

### Pixel Sigma Clipping and Background Levels

### PSF Filter

### Scalar Surface Fitting

### Scientific Image Loading and Export

### Scientific Image Model

### SCNR

### Screen Transfer Function

### Sensor Characterization

### Sensor Fixed-Pattern Noise

### Sensor Linearity

### Sensor Operating-Point Series

### Sensor Stack Defects

### Sensor Tilt Estimator

### Signal-to-Noise and Dynamic Range Estimates

### Single-Frame Bad-Pixel Map

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

### Hipparcos Catalog

### HNSKY Tiled Catalog

### HYG Catalog

### SAO Catalog

### Star Catalog Interface and Spatial Query

### Stellarium Catalog

### Tiled Sky Catalog

### UCAC4 Catalog

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
