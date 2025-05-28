# Nebulosa

Elegant astronomy for TypeScript. Supercharged by Bun.

[![Active Development](https://img.shields.io/badge/Maintenance%20Level-Actively%20Developed-brightgreen.svg)](https://gist.github.com/cheerfulstoic/d107229326a01ff0f333a1d3476e068d)
[![CI](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml)

## API

### Angle

```ts
normalizeAngle(TAU + PI) // Normalize the angle in radians
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
formatHms(PI) // Format the angle as 00:00:00.00
formatDms(PI) // Format the angle as 00d00m00.00s
formatSignedDms(PI) // Format the angle as +00d00m00.00s
```

### Astap

```ts
const stars = astapDetectStars(path, options) // Detect stars on image using astap
const solution = astapPlateSolve(path, options) // Plate solve the image using astap
```

### Asteroid

```ts
const ceres = asteroid(semiMajorAxis, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, meanAnomaly, epoch) // Kepler Orbit from asteroid's orbital elements
const ceres = mpcAsteroid(mpcorb) // Kepler Orbit given its MPC orbit
const [p, v] = ceres.at(time) // ICRF position & velocity cartesian coordinate at time

const halley = comet(semiLatusRectum, eccentricity, inclination, longitudeOfAscendingNode, argumentOfPerihelion, epoch) // Keplet Orbit from comet's orbital elements
const halley = mpcComet(mpcorb) // Kepler Orbit given its MPC orbit
const [p, v] = halley.at(time) // ICRF position & velocity cartesian coordinate at time

// Osculating orbital elements from position & velocity at epoch
const vesta = new KeplerOrbit(position, velocity, epoch)
vesta.apoapsisDistance // Farthest distance in AU between the orbiting body and the central body in its orbit
vesta.argumentOfLatitude // Angle from the ascending node to the orbiting body’s current position
vesta.argumentOfPeriapsis // Angle from the ascending node to the periapsis
vesta.eccentricAnomaly // Angular parameter that defines a point in the elliptical orbit as a function of time
vesta.eccentricity // How much the orbit deviates from a perfect circle
vesta.inclination // Tilt of the orbit's plane relative to the reference plane
vesta.longitudeOfAscendingNode // Angle from a fixed reference direction to the ascending node of the orbit
vesta.longitudeOfPeriapsis // Angle from the reference direction to the periapsis, combining the longitude of the ascending node and the argument of periapsis
vesta.meanAnomaly // A measure of time in the orbit, representing where the object would be if it moved at constant speed in a circular orbit
vesta.meanLongitude // Sum of the longitude of the ascending node, argument of periapsis, and mean anomaly
vesta.meanMotionPerDay // Average rate (in radians per day) at which the orbiting body progresses along its orbit
vesta.periapsisDistance // Shortest distance in AU between the orbiting body and the central body in its orbit
vesta.periapsisTime // Time at which the orbiting body passes closest to the central body
vesta.periodInDays // Orbital period in days
vesta.semiLatusRectum // A geometric parameter related to the shape of the orbit
vesta.semiMajorAxis // Half of the longest diameter of the elliptical orbit
vesta.semiMinorAxis // Half of the shortest diameter of the ellipse
vesta.trueAnomaly // Angle between the direction of periapsis and the current position of the body, measured at the focus of the ellipse
vesta.trueLongitude // Angle from the reference direction to the body's current position, combining several angular parameters
```

### Astrobin

```ts
sensors(page) // List sensors
sensor(id) // Get sensor by id
cameras(page) // List cameras
camera(id) // Get camera by id
telescopes(page) // List telescopes
telescope(id) // Get telescope by id
```

### Astrometry

```ts
distance(p) // Distance in AU
lightTime(p) // Days of light travel time
equatorial(p) // Transform to equatorial coordinate
parallacticAngle(ha, dec, latitude) // The deviation between zenith angle and north angle
separationFrom(a, b) // Angle between the positions
gcrs(icrs, time, [ebp, ebv], ehp) // Compute the GCRS cartesian coordinate from ICRS at time
cirs(icrs, time, [ebp, ebv], ehp) // Compute the CIRS cartesian coordinate from ICRS at time
hadec(icrs, time, [ebp, ebv], ehp, { pressure, temperature, relativeHumidity, wl }) // Compute the HA/DEC spherical coordinate from ICRS
altaz(icrs, time, [ebp, ebv], ehp, { pressure, temperature, relativeHumidity, wl }) // Compute the AZ/ALT spherical coordinate from ICRS
```

### Constellation

```ts
constellation(ra, dec, equinox) // Constellation at RA/DEC coordinate
```

### Csv

```ts
const [header, ...data] = readCsv(lines, options) // Read CSV file
```

### Daf

```ts
readDaf(source) // Read NASA DAF file
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

### ELPMPP02

```ts
const [p, v] = moon(time) // Geocentric cartesian position & velocity of Moon at time
```

### Erfa

```ts
TODO
```

### Firmata

```ts
const client = new FirmataClient(handler)
await client.connectTcp(host, port) // Connect to Firmata Device via TCP
client.disconnect() // Disconnect from current connection
client.process(buffer) // Process the buffer
client.processByte(byte) // Process the byte
```

### Fits

```ts
readFits(source) // Read FITS file from source
writeFits(sink, fits) // Write FITS file to sink
```

### FK5

```ts
fk5(ra, dec, distance) // FK5 coordinate from given spherical coordinate
fk5ToIcrs(frame) // Convert FK5 coordinate to ICRS coordinate
precessFk5(frame, from, to) // Precess the FK5 coordinate from equinox to other
precessFk5FromJ2000(frame, equinox) // Precess the FK5 coordinate from J2000 to equinox
precessFk5ToJ2000(frame, equinox) // Precess the FK5 coordinate from equinox to J2000
```

### Hips2Fits

```ts
hips2Fits(survey, ra, dec, options) // Extract a FITS image from a HiPS 
hipsSurveys() // List available HiPS
```

### Horizons

```ts
observer(command, center, coord, startTime, endTime, quantities, options)
observerWithOsculatingElements(parameters, coord, startTime, endTime, quantities, options)
observerWithTle(tle, coord, startTime, endTime, quantities, options)
spkFile(id, startTime, endTime)
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
readImageFromFits(fits) // Read image from FITS file
writeImageToFormat(image, path, format) // Write image to path as png, jpeg, webp, etc
writeImageToFits(image, sink) // Write image to sink as FITS format
stf(image, midtone, shadow, highlight, channel) // Apply STF to image
adf(image, channel, meanBackground, clippingPoint) // Calculate the STF parameters
debayer(image) // Debayer the image
scnr(image, channel, amount, method) // Apply SCNR to image
horizontalFlip(image) // Horizontal flip the image
verticalFlip(image) // Vertical flip the image
histogram(image, channel) // Generate the histogram from image
median(image, channel) // Calculate the median from image
medianAbsoluteDiviation(image, channel) // Calculate the MAD from image
```

### INDI

```ts
const client = new IndiClient({ handler })
await client.connect(host, port)
client.close()
client.getProperties()
client.enableBlob(command)
client.sendText(vector)
client.sendNumber(vector)
client.sendSwitch(vector)
```

### IO

```ts
bufferSink(buffer) // Create a seekable sink from Buffer
fileHandleSink(handle) // Create a seekable sink from FileHandle
base64Sink(sink) // Create a sink that base64 encodes to sink
bufferSource(buffer) // Create a seekable source from Buffer
fileHandleSource(handle) // Create a seekable source from FileHandle
readableStreamSource(stream) // Create a source from ReadableStream
base64Source(source) // Create a source that decodes a base64-encoded source
readUntil(source, buffer, size, offset) // Read n bytes from source
readLines(source, chunkSize) // Read lines from source
sourceTransferToSink(source, sink) // Transfer from source to sink
```

### ITRS

```ts
itrs(location) // ITRS xyz position for location
itrsRotationAt(time) // ITRS rotation matrix at time
```

### Location

```ts
geodeticLocation(longitude, latitude, elevation, Ellipsoid.IERS2010) // Location from longitude, latitude, elevation and ellipsoid form
geocentricLocation(x, y, z, Ellipsoid.IERS2010) // Location from |xyz| geocentric coordinate and ellipsoid form
lst(location, time, false, false) // Mean/apparent Local Sidereal Time
polarRadius(Ellipsoid.IERS2010) // Earth's polar radius
gcrsRotationAt(location, time) // GCRS rotation of the location at time
```

### Lx200

```ts
const server = new Lx200ProtocolServer(host, port, options)
server.start() // Start server
server.stop() // Stop server
```

### Math

```ts
pmod(-PI, TAU) // Modulo where the result is always non-negative
divmod(10, 4) // The quotient and the remainder of division
floorDiv(10, 4) // The integer floor of the fractional value (x / y)
roundToNearestWholeNumber(5.6)
twoSum(0.1, 0.2) // Sum both exactly in two 64-bit floats
split(0.5) // Split in two aligned parts
twoProduct(0.5, 0.4) // Multiply both exactly in two 64-bit floats
```

### Matrix

```ts
const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
Matrix3.zero() // Matrix filled with zeroes
Matrix3.identity() // Identity matrix
Matrix3.rotX(PI, m) // Rotate the matrix around x-axis
Matrix3.rotY(PI, m) // Rotate the matrix around y-axis
Matrix3.rotZ(PI, m) // Rotate the matrix around z-axis
Matrix3.clone(m) // Clone the matrix
Matrix3.copy(m, n) // Copy the matrix to another matrix
Matrix3.determinant(m) // Determinant of the matrix
Matrix3.trace(m) // Trace of the matrix
Matrix3.transpose(m) // Transpose the matrix
Matrix3.flipX(m) // Flip the x-axis of the matrix
Matrix3.flipY(m) // Flip the y-axis of the matrix
Matrix3.negate(m) // Negate the matrix
Matrix3.plusScalar(m, 2) // Sum the matrix by a scalar
Matrix3.minusScalar(m, 2) // Subtract the matrix by a scalar
Matrix3.mulScalar(m, 2) // Multiply the matrix by a scalar
Matrix3.divScalar(m, 2) // Divide the matrix by a scalar
Matrix3.plus(m, n) // Sum two matrices
Matrix3.minus(m, n) // Subtract two matrices
Matrix3.mul(m, n) // Multiply two matrices
Matrix3.mulVec(m, v) // Multiply the matrix by a vector
Matrix3.mulTransposeVec3(m, v) // Multiply the transpose of the matrix by a vector

const LU = new LuDecomposition(m)
LU.determinant // Determinant of the matrix
LU.invert() // Invert the matrix
LU.solve(v) // Solve A*x=B

const QR = new QrDecomposition(m)
QR.solve(v) // Solve A*x=B
```

### Meeus

```ts
TODO
```

### MPCORB

```ts
mpcorb(line) // Asteroid orbital elements from MPCORB database
mpcorbComet(line) // Comet orbital elements from MPCORB database
unpackDate('K01AM') // Packed date to year-month-day
packDate(year, month, day) // year-month-day to packed date format
```

### PHD2

```ts
const client = new PHD2Client({ handler })
await client.connect(host, port)
client.close()
await client.findStar(roi)
await client.startCapture(exposure, roi)
await client.stopCapture()
await client.clearCalibration()
await client.deselectStar()
await client.dither(amount, raOnly, roi)
await client.flipCalibration()
await client.getAlgorithmParam(axis, name)
await client.getAlgorithmParamNames(axis)
await client.getAppState()
await client.getCalibrated()
await client.getCalibrationData()
await client.getCameraBinning()
await client.getCameraFrameSize()
await client.getConnected()
await client.getCurrentEquipment()
await client.getDeclinationGuideMode()
await client.getExposure()
await client.getExposureDurations()
await client.getGuideOutputEnabled()
await client.getLockPosition()
await client.getLockShiftEnabled()
await client.getLockShiftParams()
await client.getPaused()
await client.getPixelScale()
await client.getProfile()
await client.getProfiles()
await client.getSearchRegion()
await client.getSettling()
await client.getStarImage()
await client.getUseSubframes()
await client.guide(recalibrate, roi, settle)
await client.guidePulse(amount, direction, which)
await client.loop()
await client.saveImage()
await client.setAlgorithmParam(axis, name, value)
await client.setConnected(connected)
await client.setDeclinationGuideMode(mode)
await client.setExposure(exposure)
await client.setGuideOutputEnabled(enabled)
await client.setLockPosition(x, y, exact)
await client.setLockShiftEnabled(enabled)
await client.setLockShiftParams(params)
await client.setPaused(paused, full)
await client.setProfile(profile)
await client.shutdown()
```

### Pressure

```ts
pascal(1) // Convert pascal to millibar
atm(1) // Convert atm to millibar
toPascal(1) // Convert millibar to pascal
toAtm(1) // Convert millibar to atm
```

### Random

```ts
const random = mulberry32(seed)
uniform(random, min, max)
bernoulli(random, p)
weibull(random, lambda, k)
exponential(random, lambda)
geometric(random, p)
pareto(random, alpha)
normal(random, mu, sigma)
```

### Regression

```ts
const regresion = simpleLinearRegression(x, y) // Compute OLS regression
const regression = polynomialRegression(x, y, degree, interceptAtZero) // Compute polynomial regression

regression.predict(x) // Compute y at x

const { r, r2, chi2, rmsd } = regressionScore(regression, x, y)
```

### Small Body Database

```ts
search('C/2017 K2')
identify(date, longitude, latitude, elevation, fovRa, fovDec, fovRaWidth, fovDecWidth, magLimit, magRequired)
closeApproaches(dateMin, dateMax, distance)
```

### Simbad

```ts
const [header, ...data] = simbadQuery(query) // Search on Simbad TAP service
```

### Spk

```ts
const s = await readSpk(daf) // Read a SPK file
await s.segment(Naif.SSB, Naif.EMB)!.at(time) // Compute the position and velocity at time
```

### Star

```ts
const sirius = star(ra, dec, pmRA, pmDEC, parallax, rv, epoch) // ICRS cartesian coordinate from star parameters
bcrs(sirius, time) // BCRS cartesian coordinate at time
```

### Statistics

```ts
const h = new Histogram(frequencies) // Create histogram from frequency array
h.mode() // Most common value of data
h.count() // Sum of data
h.mean() // Arithmetic mean of data
h.variance() // (Population) variance of data
h.standardDeviation() // (Population) standard deviation of data
h.median() // Median (middle value with interpolation) of data
```

### Stellarium

```ts
const server = new StellariumProtocolServer(host, port, options)
server.start() // Start server
server.send(ra, dec) // Send the current coordinate
server.stop() // Stop server
readCatalogDat(source) // Read Stellarium's catalog.dat file
searchAround(catalog, ra, dec, fov) // Search around coordinate
```

### Temperature

```ts
fahrenheit(1) // Convert fahrenheit to celsius
kelvin(1) // Convert Kelvin to celsius
toFahrenheit(1) // Convert celsius to fahrenheit
toKelvin(1) // Convert celsius to Kelvin
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
timeYMD(2024, 12, 25, Timescale.UTC) // Time from year, month and day
timeYMDF(2024, 12, 25, 0.5, Timescale.UTC) // Time from year, month, day and fraction of day
timeGPS(630720013) // Time from GPS seconds
normalizeTime(2460650, 8.37456, 0, Timescale.UTC) // Normalize day and fraction
subtractTime(a, b) // Subtract two Times
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
nutationAngles(time) // Nutation angles at time
precessionMatrix(time) // Precession matrix at time
precessionNutationMatrix(time) // Precession-Nutation matrix at time
equationOfOrigins(time) // Equation of Origins matrix at time
pmAngles(time) // Polar Motion angles at time
pmMatrix(time) // Polar Motion matrix at time
```

### TIRS

```ts
tirsRotationAt(time) // TIRS rotation matrix at time
```

### Vector

```ts
Vector3.zero() // Vector filled with zeroes
Vector3.xAxis() // X-axis vector
Vector3.yAxis() // Y-axis vector
Vector3.zAxis() // Z-axis vector
Vector3.clone(v) // Clone the vector
Vector3.normalize(v) // Normalize the vector
Vector3.length(v) // Length of the vector
Vector3.distance(v, u) // Distance between vectors
Vector3.angle(v, u) // Angle between vectors
Vector3.dot(v, u) // Dot product between vectors
Vector3.cross(v, u) // Cross product between vectors
Vector3.latitude(v)
Vector3.longitude(v)
Vector3.negate(v) // Negate the vector
Vector3.plusScalar(v, 2) // Sum the vector by a scalar
Vector3.minusScalar(v, 2) // Subtract the vector by a scalar
Vector3.mulScalar(v, 2) // Multiply the vector by a scalar
Vector3.divScalar(v, 2) // Divide the vector by a scalar
Vector3.plus(v, u) // Sum two vectors
Vector3.minus(v, u) // Subtract two vectors
Vector3.mul(v, u) // Multiply two vectors
Vector3.div(v, u) // Divide two vectors
Vector3.rotateByRodrigues(v, axis, PI / 4) // Rotate the vector around an axis
Vector3.plane(v, u, w) // Vector from plane of three vectors
```

### Velocity

```ts
kilometerPerSecond(10) // Convert km/s to AU/d
meterPerSecond(1000) // Convert m/s to AU/d
toKilometerPerSecond(1) // Convert AU/d to km/s
toMeterPerSecond(1) // Convert AU/d to m/s
```

### Vizier

```ts
const [header, ...data] = vizierQuery(query) // Search on Vizier TAP service
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

### WCS

```ts
using wcs = new Wcs(headers)
const [ra, dec] = wcs.pixToSky(x, y)
const [x, y] = wcs.skyToPix(ra, dec)
```

### Xisf

```ts
byteShuffle(input, output, itemSize)
byteUnshuffle(input, output, itemSize)
```

### XML

```ts
const parser = new SimpleXmlParser()
const tags = parser.parse(xml) // Parse one or more XML tags
```

## Inspired by

Thanks to all these projects:

- [Skyfield](https://github.com/skyfielders/python-skyfield)
- [Astropy](https://github.com/astropy/astropy)
- [ERFA](https://github.com/liberfa/erfa)
- [Astronomia](https://github.com/commenthol/astronomia)
