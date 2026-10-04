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

### Great Red Spot Transits

### Greatest Solar Eclipse Circumstances

### HEALPix Object Index

### HEALPix Pixelization and Covers

### Heliacal Events

### Herrick-Gibbs Orbit Determination

### Hour-Angle Windows

### IAU Body Orientation

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

### Kepler Anomalies and Periapsis Timing

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

### Local Lunar Eclipse Search

### Local Lunar Eclipse View Geometry

### Local Solar Eclipse Circumstances

### Local Solar Eclipse Search

### Local Solar Eclipse View Geometry

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

### Two-Body Kepler Propagation

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
