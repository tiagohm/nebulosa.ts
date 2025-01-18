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
```

### Daf

```ts
read(source) // Read NASA DAF file
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

### Fits

```ts
read(source) // Read FITS file
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
iersa.load(source)
iersb.load(source)
delta(time) // UT1-UTC at time
xy(time) // Polar motion angles at time
```

### Image

```ts
fromFits(fits) // Create image from FITS file
toFormat(image, path, format) // Save image to path as png, jpeg, webp, etc
stf(image, midtone, shadow, highlight) // Apply STF to image
```

### IO

```ts
bufferSink(sink) // Create a seekable sink from Buffer
fileHandleSink(sink) // Create a seekable sink from FileHandle
bufferSource(buffer) // Create a seekable source from Buffer
fileHandleSource(handle) // Create a seekable source from FileHandle
readableStreamSource(stream) // Create a source from ReadableStream
readUntil(source, buffer, size, offset) // Read n bytes from source
readLines(source, chunkSize) // Read lines from source
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
copy(m, n) // Copy the matrix to another matrix
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

### Small Body Database

```ts
search('C/2017 K2')
identify(date, longitude, latitude, elevation, fovRa, fovDec, fovRaWidth, fovDecWidth, magLimit, magRequired)
closeApproaches(dateMin, dateMax, distance)
```

### Spk

```ts
const s = spk(daf) // Read a SPK file
s.segment(Naif.SSB, Naif.EMB)!.compute(time) // Compute the position and velocity at time
```

### Star

```ts
const sirius = star(ra, dec, pmRA, pmDEC, parallax, rv, epoch) // ICRS cartesian coordinate from star parameters
at(sirius, time) // BCRS cartesian coordinate at time
observedAt(sirius, time, [obp, obv]) // GCRS cartesian coordinate from observer at time
```

### Stellarium

```ts
const server = new StellariumProtocolServer('0.0.0.0', 10002, {})
server.start() // Start server
server.send(ra, dec) // Send the current coordinate
server.stop() // Stop server
catalog(source) // Read Stellarium's catalog.dat file
searchAround(catalog, ra, dec, fov) // Search around coordinate
```

### Time

```ts
time(2460650, 0.37456, Timescale.UTC, true) // Time from day and fraction
timeUnix(1735133314, Timescale.UTC) // Time from unix seconds
timeNow() // Time from now
timeMJD(51544, Timescale.UTC) // Time from MJD date
timeJulian(2000.5, Timescale.UTC) // Time from Julian date
timeBesselian(1950.5, Timescale.UTC) // Time from Besselian date
timeYMDHMS(2024, 12, 25, 9, 10, 11.5, Timescale.UTC) // Time from year, month, day, hour, minute and second
timeGPS(630720013) // Time from GPS seconds
normalize(2460650, 8.37456, 0, Timescale.UTC) // Normalize day and fraction
subtract(a, b) // Subtract two Times
toDate(time) // Convert the time to year, month, day, hour, minute, second and nanosecond
ut1(time) // Convert the time to UT1 scale
utc(time) // Convert the time to UTC scale
tai(time) // Convert the time to TAI scale
tt(time) // Convert the time to TT scale
tcg(time) // Convert the time to TCG scale
tdb(time) // Convert the time to TDB scale
tcb(time) // Convert the time to TCB scale
gast(time) // Greenwich Apparent Sidereal Time at time
gmst(time) // Greenwich Mean Sidereal Time at time
era(time) // Earth Rotation Angle at time
meanObliquity(time) // Mean Obliquity at time
trueObliquity(time) // True Oblioquity at time
trueEclipticRotation(time) // True Ecliptic Rotation matrix at time
nutation(time) // Nutation angles at time
precession(time) // Precession matrix at time
precessionNutation(time) // Precession-Nutation matrix at time
equationOfOrigins(time) // Equation of Origins matrix at time
pmAngles(time) // Polar Motion angles at time
pmMatrix(time) // Polar Motion matrix at time
```

### TIRS

```ts
rotationAt(time) // TIRS rotation matrix at time
```

### Vector

```ts
zero() // Vector filled with zeroes
xAxis() // X-axis vector
yAxis() // Y-axis vector
zAxis() // Z-axis vector
clone(v) // Clone the vector
normalize(v) // Normalize the vector
length(v) // Length of the vector
distance(v, u) // Distance between vectors
angle(v, u) // Angle between vectors
dot(v, u) // Dot product between vectors
cross(v, u) // Cross product between vectors
latitude(v)
longitude(v)
negate(v) // Negate the vector
plusScalar(v, 2) // Sum the vector by a scalar
minusScalar(v, 2) // Subtract the vector by a scalar
mulScalar(v, 2) // Multiply the vector by a scalar
divScalar(v, 2) // Divide the vector by a scalar
plus(v, u) // Sum two vectors
minus(v, u) // Subtract two vectors
mul(v, u) // Multiply two vectors
div(v, u) // Divide two vectors
rotateByRodrigues(v, axis, PI / 4) // Rotate the vector around an axis
plane(v, u, w) // Vector from plane of three vectors
```

### Velocity

```ts
kilometerPerSecond(10) // Convert km/s to AU/d
meterPerSecond(1000) // Convert m/s to AU/d
toKilometerPerSecond(1) // Convert AU/d to km/s
toMeterPerSecond(1) // Convert AU/d to m/s
```

### VSOP87E

```ts
sun(time) // Compute the position and velocity of the Sun
mercury(time) // Compute the position and velocity of Mercury
venus(time) // Compute the position and velocity of Venus
earth(time) // Compute the position and velocity of Earth
mars(time) // Compute the position and velocity of Mars
jupiter(time) // Compute the position and velocity of Jupiter
saturn(time) // Compute the position and velocity of Saturn
uranus(time) // Compute the position and velocity of Uranus
neptune(time) // Compute the position and velocity of Neptune
```

## Inspirations

- [Skyfield](https://github.com/skyfielders/python-skyfield)
- [Astropy](https://github.com/astropy/astropy)
- [ERFA](https://github.com/liberfa/erfa)
- [Astronomia](https://github.com/commenthol/astronomia)
