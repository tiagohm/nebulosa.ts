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

### Differential Refraction and Atmospheric Dispersion

### Earth Occultation of a Finite Target

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

### ELP/MPP02 Lunar Theory

### Ephemeris Observed Positions

### Ephemeris Path Adapters

### Ephemeris Path Composition

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

### Equatorial Mount Geometric Pointing Errors

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

### Spherical Coordinate Conversions

### Spherical State Rates

### SPICE Body Radii

### SPICE Frame Resolution

### SPICE Text Kernel Pools

### SPK State Kernels

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
