# Nebulosa

Elegant astronomy for TypeScript. Supercharged by Bun.

[![Active Development](https://img.shields.io/badge/Maintenance%20Level-Actively%20Developed-brightgreen.svg)](https://gist.github.com/cheerfulstoic/d107229326a01ff0f333a1d3476e068d)
[![CI](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml/badge.svg?event=workflow_dispatch)](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml)

## API

### Angle

```ts
normalize(TAU + PI) // Normalize the angle in radians
deg(90) // Convert degree to radian
hour(22) // Convert hour to radian
arcmin(10) // Convert arcminute to radian
arcsec(45) // Convert arcsecond to radian
mas(300) // Convert milliarcsecond to radian
dms(86, 40, 17.5) // Convert degree-minute-second to radian
hms(22, 40, 17.5) // Convert hour-minute-second to radian
toDeg(PI) // Convert radian to degree
toHour(PI) // Convert radian to hour
toArcmin(PI) // Convert radian to arcminute
toArcsec(PI) // Convert radian to arcsecond
toMas(PI) // Convert radian to milliarcsecond
toDms(PI) // Convert radian to degree-minute-second
toHms(PI) // Convert radian to hour-minute-second
parseAngle('12h 45m 14.56s') // Parse the dms/hms angle represented as string
formatAngle(PI, { isHour: true }) // Format the angle with custom representation
formatHMS(PI) // Format the angle as 00:00:00.00
formatDMS(PI) // Format the angle as 00d00m00.00s
formatSignedDMS(PI) // Format the angle as +00d00m00.00s
```

### Astrometry

```ts
distance(p) // Distance in AU
lightTime(p) // Days of light travel time
equatorial(p) // Transform to equatorial coordinate
hourAngle(p, time) // Hour angle coordinate
parallacticAngle(p, time)
separationFrom(a, b) // Angle between the positions
astrometric(bcrs, mas(10), ebp) // Apply parallax correction to BCRS cartesian coordinate
```

### Distance

```ts
meter(800) // Convert m to AU
kilometer(300000) // Convert km to AU
lightYear(8.7) // Convert light year to AU
parsec(10) // Convert parsec to AU
toMeter(1) // Convert AU to m
toKilometer(1) // Convert AU to km
toLightYear(1) // Convert AU to light year
toParsec(1) // Convert AU to parsec
```

### Erfa

```
TODO
```

### FK5

```ts
fk5(ra, dec, distance) // FK5 coordinate from given spherical coordinate
fk5ToIcrs(frame) // Convert FK5 coordinate to ICRS coordinate
precessFk5(frame, from, to) // Precess the FK5 coordinate from equinox to other
precessFk5FromJ2000(frame, equinox) // Precess the FK5 coordinate from J2000 to equinox
precessFk5ToJ2000(frame, equinox) // Precess the FK5 coordinate from equinox to J2000
```

### ICRS

```ts
icrs(ra, dec, distance) // ICRS coordinate from given spherical coordinate
icrsToFk5(frame) // Convert ICRS coordinate to FK5 coordinate
```

### IERS

```ts
iersa.load(Bun.file('finals2000A.txt').stream())
iersb.load(Bun.file('eopc04.1962-now.txt').stream())
delta(time) // UT1-UTC at time
xy(time) // Polar motion angles at time
```

### ITRS

```ts
itrs(location) // ITRS xyz position for location
rotationAt(time) // ITRS rotation matrix at time
```

### Location

```ts
geodetic(longitude, latitude, elevation, Ellipsoid.IERS2010) // Location from longitude, latitude, elevation and ellipsoid form
geocentric(x, y, z, Ellipsoid.IERS2010) // Location from |xyz| geocentric coordinate and ellipsoid form
lst(location, time, false, false) // Mean/apparent Local Sidereal Time
polarRadius(Ellipsoid.IERS2010) // Earth's polar radius
rotationAt(location, time) // GCRS rotation of the location at time
```

### Math

```ts
pmod(-PI, TAU) // Modulo where the result is always non-negative
divmod(10, 4) // The quotient and the remainder of division
roundToNearestWholeNumber(5.6)
twoSum(0.1, 0.2) // Sum both exactly in two 64-bit floats
split(0.5) // Split in two aligned parts
twoProduct(0.5, 0.4) // Multiply both exactly in two 64-bit floats
```

### Matrix

```ts
const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
zero() // Matrix filled with zeroes
identity() // Identity matrix
rotX(PI, m) // Rotate the matrix around x-axis
rotY(PI, m) // Rotate the matrix around y-axis
rotZ(PI, m) // Rotate the matrix around z-axis
clone(m) // Clone the matrix
determinant(m) // Determinant of the matrix
trace(m) // Trace of the matrix
transpose(m) // Transpose the matrix
transposeMut(m) // Transpose the matrix on it
flipX(m) // Flip the x-axis of the matrix
flipXMut(m) // Flip the x-axis of the matrix on it
flipY(m) // Flip the y-axis of the matrix
flipYMut(m) // Flip the y-axis of the matrix on it
negate(m) // Negate the matrix
negateMut(m) // Negate the matrix on it
plusScalar(m, 2) // Sum the matrix by a scalar
minusScalar(m, 2) // Subtract the matrix by a scalar
mulScalar(m, 2) // Multiply the matrix by a scalar
divScalar(m, 2) // Divide the matrix by a scalar
plus(m, n) // Sum two matrices
minus(m, n) // Subtract two matrices
mul(m, n) // Multiply two matrices
mulVec(m, v) // Multiply the matrix by a vector
mulTransposeVec(m, v) // Multiply the transpose of the matrix by a vector
```

### Star

```ts
star(ra, dec, pmRA, pmDEC, parallax, rv, epoch) // Body from star parameters
```

### Time

```ts
time(2460650, 0.37456, Timescale.UTC)
timeUnix(1735133314, Timescale.UTC)
timeNow()
timeMJD(51544, Timescale.UTC)
timeJulian(2000.5, Timescale.UTC)
timeBesselian(1950.5, Timescale.UTC)
timeYMDHMS(2024, 12, 25, 9, 10, 11.5, Timescale.UTC)
timeGPS(630720013)
normalize(2460650, 8.37456, 0, Timescale.UTC)
ut1(time) // Convert the time to UT1 scale
utc(time) // Convert the time to UTC scale
tai(time) // Convert the time to TAI scale
tt(time) // Convert the time to TT scale
tcg(time) // Convert the time to TCG scale
tdb(time) // Convert the time to TDB scale
tcb(time) // Convert the time to TCB scale
gast(time)
gmst(time)
era(time)
meanObliquity(time)
trueObliquity(time)
trueEclipticRotation(time)
nutation(time)
precession(time)
precessionNutation(time)
equationOfOrigins(time)
pmAngles(xy, time)
pmMatrix(xy, time)
```

### TIRS

```ts
rotationAt(time) // TIRS rotation matrix at time
```

### Vector

```ts
zero()
xAxis()
yAxis()
zAxis()
clone(v)
normalize(v)
length(v)
distance(v, u)
angle(v, u)
dot(v, u)
cross(v, u)
latitude(v)
longitude(v)
negate(v)
plusScalar(v, 2)
minusScalar(v, 2)
mulScalar(v, 2)
divScalar(v, 2)
plus(v, u)
minus(v, u)
mul(v, u)
div(v, u)
rotateByRodrigues(v, axis, PI / 4)
plane(v, u, w)
```

### Velocity

```ts
kilometerPerSecond(10) // Convert km/s to AU/d
meterPerSecond(1000) // Convert m/s to AU/d
toKilometerPerSecond(1) // Convert AU/d to km/s
toMeterPerSecond(1) // Convert AU/d to m/s
```

## Inspirations

- [Skyfield](https://github.com/skyfielders/python-skyfield)
- [Astropy](https://github.com/astropy/astropy)
- [ERFA](https://github.com/liberfa/erfa)
- [Astronomia](https://github.com/commenthol/astronomia)
