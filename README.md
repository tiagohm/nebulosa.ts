# Nebulosa

Elegant astronomy for TypeScript. Supercharged by Bun.

[![Active Development](https://img.shields.io/badge/Maintenance%20Level-Actively%20Developed-brightgreen.svg)](https://gist.github.com/cheerfulstoic/d107229326a01ff0f333a1d3476e068d)
[![CI](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml/badge.svg)](https://github.com/tiagohm/nebulosa.ts/actions/workflows/ci.yml)

## API

### Alpaca ![](bun.webp)

```ts
const server = new AlpacaServer({ camera, wheel, mount })
server.start(host, port)

const discoveryServer = new AlpacaDiscoveryServer(ports)
discoveryServer.addPort(server.port)
await discoveryServer.start(host, port)

const discoveryClient = new AlpacaDiscoveryClient()
await discoveryClient.discovery(callback, options)
discoveryClient.close()

const alpacaClient = new AlpacaClient(url, { handler })
await alpacaClient.start()

const alpacaTelescopeApi = new AlpacaTelescopeApi(url)
await alpacaTelescopeApi.connect(id)
```

### Angle ![](bun.webp) ![](browser.webp)

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
formatHMS(PI) // Format the angle as 00:00:00.00
formatDMS(PI) // Format the angle as 00d00m00.00s
formatSignedDMS(PI) // Format the angle as +00d00m00.00s
formatRA(PI) // Format the angle in hours as 00 00 00.00
formatDEC(PI) // Format the angle in degress as +00 00 00.00
formatAZ(PI) // Format the angle in degress as 000 00 00.00
formatALT(PI) // Format the angle in degress as +00 00 00.00
```

### Astap ![](bun.webp)

```ts
const stars = astapDetectStars(path, options) // Detect stars on image using astap
const solution = astapPlateSolve(path, options) // Plate solve the image using astap
```

### Asteroid ![](bun.webp) ![](browser.webp)

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

### Astrobin ![](bun.webp) ![](browser.webp)

```ts
sensors(page) // List sensors
sensor(id) // Get sensor by id
cameras(page) // List cameras
camera(id) // Get camera by id
telescopes(page) // List telescopes
telescope(id) // Get telescope by id
```

### Astrometry ![](bun.webp) ![](browser.webp)

```ts
distance(p) // Distance in AU
lightTime(p) // Days of light travel time
equatorial(p) // Transform to equatorial coordinate
parallacticAngle(ha, dec, latitude) // The deviation between zenith angle and north angle
separationFrom(a, b) // Angle between the positions
cirsToObserved(cirs, time, refraction) // Convert CIRS to observed coordinate
observedToCirs(az, alt, time, refraction) // Convert observed to CIRS coordinate
icrsToObserved(icrs, ebpv, ehp, time, refraction) // Convert ICRS to observed coordinate
equatorialToHorizontal(ra, dec, latitude, lst) // Convert equatorial to horizontal coordinate
refractedAltitude(altitude, refraction) // Compute the refracted altitude given the true altitude and refraction parameters
```

### Astrometry.net ![](bun.webp)

```ts
novaAstrometryNetPlateSolve(input, options)
localAstrometryNetPlateSolve(input, options)
```

### AutoFocus ![](bun.webp) ![](browser.webp)

```ts
const autoFocus = new AutoFocus({ fittingMode: 'TREND_PARABOLIC', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })
const step = autoFocus.add(focusPosition, hfd)
```

### Constellation ![](bun.webp) ![](browser.webp)

```ts
constellation(ra, dec, equinox) // Constellation at RA/DEC coordinate
```

### Csv ![](bun.webp) ![](browser.webp)

```ts
const [header, ...data] = readCsv(lines, options) // Read CSV file from lines
const rows = await readCsvStream(source, options) // Read CSV file from source
```

### Daf ![](bun.webp)

```ts
readDaf(source) // Read NASA DAF file
```

### Distance ![](bun.webp) ![](browser.webp)

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

### ELPMPP02 ![](bun.webp) ![](browser.webp)

```ts
const [p, v] = moon(time) // Geocentric cartesian position & velocity of Moon at time
```

### Erfa ![](bun.webp) ![](browser.webp)

```ts
TODO
```

### Firmata ![](bun.webp)

```ts
const client = new FirmataClient(transport)
client.addHandler(handler) // Add a handler for incoming messages
client.removeHandler(handler) // Remove a handler
client.disconnect() // Disconnect from current connection
client.process(buffer) // Process the buffer
client.processByte(byte) // Process the byte
client.reset()
client.requestFirmware()
client.requestPinCapability()
client.requestPinState(pin)
client.requestAnalogMapping()
client.requestDigitalReport(enable)
client.requestDigitalPinReport(pin, enable, mapper)
client.requestAnalogReport(enable)
client.requestAnalogPinReport(pin, enable, mapper)
client.pinMode(pin, mode)
client.digitalWrite(pin, value)
```

### Fits ![](bun.webp)

```ts
readFits(source) // Read FITS file from source
writeFits(sink, fits) // Write FITS file to sink
hasKeyword(header, keyword) // Check if the FITS header has a keyword
textKeyword(header, keyword) // Get the text value of a keyword from the FITS header
numericKeyword(header, keyword) // Get the number value of a keyword from the FITS header
booleanKeyword(header, keyword) // Get the boolean value of a keyword from the FITS header
bitpixKeyword(bitpix) // Get the bitpix value for a given FITS data type
bitpixInBytes(bitpix) // Get the number of bytes per pixel for a given bitpix
declinationKeyword(header) // Get the declination from the FITS header
rightAscensionKeyword(header) // Get the right ascension from the FITS header
numberOfAxesKeyword(header) // Get the NAXIS value from the FITS header
heightKeyword(header) // Get the height (NAXIS1) from the FITS header
widthKeyword(header) // Get the width (NAXIS2) from the FITS header
numberOfChannelsKeyword(header) // Get the number of channels (NAXIS3) from the FITS header
exposureTimeKeyword(header) // Get the exposure time from the FITS header
cfaPatternKeyword(header) // Get the CFA pattern from the FITS header
```

### FK5 ![](bun.webp) ![](browser.webp)

```ts
fk5(ra, dec, distance) // FK5 coordinate from given spherical coordinate
fk5ToIcrs(frame) // Convert FK5 coordinate to ICRS coordinate
precessFk5(frame, from, to) // Precess the FK5 coordinate from equinox to other
precessFk5FromJ2000(frame, equinox) // Precess the FK5 coordinate from J2000 to equinox
precessFk5ToJ2000(frame, equinox) // Precess the FK5 coordinate from equinox to J2000
```

### Frame ![](bun.webp) ![](browser.webp)

```ts
precessionMatrixCapitaine(from, to) // Precession matrix using Capitaine et al. 2003
frameAt(pv, frame, time) // Apply frame rotation to position and velocity at time
galactic(pv)
supergalactic(pv)
eclipticJ2000(pv)
ecliptic(pv, time)
```

### Geometry ![](bun.webp) ![](browser.webp)

```ts
const c = rectIntersection(a, b)
const [a, b] = intersectLineAndSphere(endpoint, center, radius)
```

### GUST86 ![](bun.webp) ![](browser.webp)

```ts
ariel(time) // Position and velocity of Ariel at given time
umbriel(time) // Position and velocity of Umbriel at given time
oberon(time) // Position and velocity of Oberon at given time
titania(time) // Position and velocity of Titania at given time
miranda(time) // Position and velocity of Miranda at given time
```

### Hips2Fits ![](bun.webp) ![](browser.webp)

```ts
hips2Fits(survey, ra, dec, options) // Extract a FITS image from a HiPS 
hipsSurveys() // List available HiPS
```

### Horizons ![](bun.webp) ![](browser.webp)

```ts
observer(input, center, coord, startTime, endTime, quantities, options)
vector(input, center, coord, startTime, endTime, options)
elements(input, center, startTime, endTime, options)
spkFile(id, startTime, endTime)
```

### HYG ![](bun.webp) ![](browser.webp)

```ts
const rows = await readHygDatabase(source) // Read HYG star database from source
```

### ICRS ![](bun.webp) ![](browser.webp)

```ts
icrs(ra, dec, distance) // ICRS coordinate from given spherical coordinate
icrsToFk5(frame) // Convert ICRS coordinate to FK5 coordinate
```

### IERS ![](bun.webp) ![](browser.webp)

```ts
iersa.load(source)
iersb.load(source)
delta(time) // UT1-UTC at time
xy(time) // Polar motion angles at time
```

### Image ![](bun.webp)

```ts
readImageFromFits(fits) // Read image from FITS file
writeImageToFormat(image, path, format) // Write image to path as png, jpeg, webp, etc
writeImageToFits(image, sink) // Write image to sink as FITS format
clone(image) // Clone the image
stf(image, midtone, shadow, highlight, channel) // Apply STF to image
adf(image, options) // Calculate the STF parameters
sigmaClip(image, options) // Generate rejection map using sigma-clip
debayer(image) // Debayer the image
scnr(image, channel, amount, method) // Apply SCNR to image
horizontalFlip(image) // Horizontal flip the image
verticalFlip(image) // Vertical flip the image
grayscale(image)
convolution(image)
edge(image)
emboss(image)
mean(image)
sharpen(image)
blur(image)
gaussianBlur(image)
psf(image)
histogram(image, options) // Generate the histogram from image
median(image, options) // Calculate the median from image
medianAbsoluteDiviation(image, normalize, options) // Calculate the MAD from image
brightness(image, value)
saturation(image, value, channel)
linear(image, slope, intercept)
contrast(image, value)
gamma(image, value)
estimateBackground(image)
estimateBackgroundUsingMode(image)
calibrate(image, dark, flat, bias, darkFlat)
```

### INDI ![](bun.webp)

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

### IO ![](bun.webp)

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

### ITRS ![](bun.webp) ![](browser.webp)

```ts
itrs(location) // ITRS xyz position for location
itrsRotationAt(time) // ITRS rotation matrix at time
```

### JPEG ![](bun.webp)

```ts
const jpeg = new Jpeg()
const compressed = jpeg.compress(data, width, height, format, chrominanceSubsampling, quality) // Compress raw image data to JPEG
```

### L12 ![](bun.webp) ![](browser.webp)

```ts
io(time) // Compute position and velocity of Io at given time
europa(time) // Compute position and velocity of Europa at given time
ganymede(time) // Compute position and velocity of Ganymede at given time
callisto(time) // Compute position and velocity of Calisto at given time
```

### Location ![](bun.webp) ![](browser.webp)

```ts
geodeticLocation(longitude, latitude, elevation, ellipsoid) // Location from longitude, latitude, elevation and ellipsoid form
geocentricLocation(x, y, z, ellipsoid) // Location from |xyz| geocentric coordinate and ellipsoid form
localSiderealTime(location, time, false, false) // Mean/apparent Local Sidereal Time
polarRadius(ellipsoid) // Earth's polar radius
gcrsRotationAt(location, time) // GCRS rotation of the location at time
subpoint(geocentric, time, ellipsoid)
```

### Lx200 ![](bun.webp)

```ts
const server = new Lx200ProtocolServer(host, port, options)
server.start() // Start server
server.stop() // Stop server
```

### MARSSAT ![](bun.webp) ![](browser.webp)

```ts
phobos(time) // Compute position and velocity of Phobos at given time
deimos(time) // Compute position and velocity of Deimos at given time
```

### Math ![](bun.webp) ![](browser.webp)

```ts
pmod(-PI, TAU) // Modulo where the result is always non-negative
amod(-PI, TAU) // Modulo where the result is always positive
divmod(10, 4) // The quotient and the remainder of division
floorDiv(10, 4) // The integer floor of the fractional value (x / y)
roundToNearestWholeNumber(5.6)
twoSum(0.1, 0.2) // Sum both exactly in two 64-bit floats
split(0.5) // Split in two aligned parts
twoProduct(0.5, 0.4) // Multiply both exactly in two 64-bit floats
```

### Matrix ![](bun.webp) ![](browser.webp)

```ts
const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
matZero() // Matrix filled with zeroes
matIdentity() // Identity matrix
matRotX(PI, m) // Rotate the matrix around x-axis
matRotY(PI, m) // Rotate the matrix around y-axis
matRotZ(PI, m) // Rotate the matrix around z-axis
matClone(m) // Clone the matrix
matCopy(m, n) // Copy the matrix to another matrix
matDeterminant(m) // Determinant of the matrix
matTrace(m) // Trace of the matrix
matTranspose(m) // Transpose the matrix
matFlipX(m) // Flip the x-axis of the matrix
matFlipY(m) // Flip the y-axis of the matrix
matNegate(m) // Negate the matrix
matPlusScalar(m, scalar) // Sum the matrix by a scalar
matMinusScalar(m, scalar) // Subtract the matrix by a scalar
matMulScalar(m, scalar) // Multiply the matrix by a scalar
matDivScalar(m, scalar) // Divide the matrix by a scalar
matPlus(m, n) // Sum two matrices
matMinus(m, n) // Subtract two matrices
matMul(m, n) // Multiply two matrices
matMulVec(m, v) // Multiply the matrix by a vector
matMulTransposeVec(m, v) // Multiply the transpose of the matrix by a vector
matRodriguesRotation(axis, angle) // Create a rotation matrix around an axis

const A = new Matrix(5, 5, data)
const LU = new LuDecomposition(A)
LU.determinant // Determinant of the matrix
LU.invert() // Invert the matrix
const x = LU.solve(B) // Solve A*x=B

const QR = new QrDecomposition(A)
const x = QR.solve(B) // Solve A*x=B

const x = gaussianElimination(A, B) // Solve A*x=B using Gaussian elimination
```

### Meeus ![](bun.webp) ![](browser.webp)

```ts
TODO
```

### Moon ![](bun.webp) ![](browser.webp)

```ts
moonParallax(distance) // Compute the moon parallax at a given distance
moonSemidiameter(distance) // Compute the moon semidiameter at a given distance
lunation(time, system) // Compute the lunation at a given time and system
nearestLunarPhase(time, phase, next) // Compute the nearest lunar phase at a given time
nearestLunarEclipse(time, next) // Compute the nearest lunar eclipse at a given time
lunarSaros(time) // Compute the saros series number for the lunar eclipse at time
nearestLunarApsis(time, apsis) // Compute the nearest lunar apsis at time
```

### MPCORB ![](bun.webp) ![](browser.webp)

```ts
mpcorb(line) // Asteroid orbital elements from MPCORB database
mpcorbComet(line) // Comet orbital elements from MPCORB database
unpackDate('K01AM') // Packed date to year-month-day
packDate(year, month, day) // year-month-day to packed date format
```

### PHD2 ![](bun.webp)

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

### Pluto ![](bun.webp) ![](browser.webp)

```ts
pluto(time) // Heliocentric ICRF cartesian position of Pluto at time
```

### Polar Alignment ![](bun.webp) ![](browser.webp)

```ts
const [ra, dec] = polarAlignmentError(ra, dec, latitude, lst, dAz, dAlt) // Compute the apparent RA/DEC of a star given polar alignment error
const result = threePointPolarAlignmentError(p1, p2, p3, refraction) // Compute the polar alignment error given three stars
const result = threePointPolarAlignmentErrorAfterAdjustment(result, p3, p4, refraction) // Compute the polar alignment error after azimuth/altitude adjustments and given a new star

const polarAlignment = new ThreePointPolarAlignment(refraction)
const result = polarAlignment.add(ra, dec, time)
```

### Pressure ![](bun.webp) ![](browser.webp)

```ts
pascal(1) // Convert pascal to millibar
atm(1) // Convert atm to millibar
toPascal(1) // Convert millibar to pascal
toAtm(1) // Convert millibar to atm
```

### Random ![](bun.webp) ![](browser.webp)

```ts
const random = mulberry32(seed)
const random = xorshift32(seed)
const random = splitmix32(seed)
const random = mt19937(seed)

uniform(random, min, max)
bernoulli(random, p)
weibull(random, lambda, k)
exponential(random, lambda)
geometric(random, p)
pareto(random, alpha)
normal(random, mu, sigma)
```

### Regression ![](bun.webp) ![](browser.webp)

```ts
const regression = simpleLinearRegression(x, y) // Compute linear regression using OLS
const regression = theilSenRegression(x, y) // Compute linear regression using Theil–Sen estimator
const regression = polynomialRegression(x, y, degree, interceptAtZero) // Compute polynomial regression
const regression = trendLineRegression(x, y, method) // Compute trendline regression
const regression = exponentialRegression(x, y) // Compute exponential regression for y = B * e^(A * x)
const regression = powerRegression(x, y) // Compute power regression for y = A * x^B
const regression = hyperbolicRegression(x, y) // Compute hyperbolic regression for y = b * sqrt(1 + ((x - c) / a)^2)

const y = regression.predict(x) // Compute y at x

const { r, r2, chi2, rmsd } = regressionScore(regression, x, y)

const [a, b, c] = levenbergMarquardt(x, y, model, [a0, b0, c0]) // Compute Levenberg-Marquardt regression coefficents
```

### SAO ![](bun.webp) ![](browser.webp)

```ts
readSaoCatalog(source, bigEndian) // Read SAO star catalog from source
```

### Small Body Database ![](bun.webp) ![](browser.webp)

```ts
search('C/2017 K2')
identify(date, longitude, latitude, elevation, fovRa, fovDec, fovRaWidth, fovDecWidth, magLimit, magRequired)
closeApproaches(dateMin, dateMax, distance)
```

### Simbad ![](bun.webp) ![](browser.webp)

```ts
const [header, ...data] = simbadQuery(query, options) // Search on Simbad TAP service
```

### Spk ![](bun.webp) ![](browser.webp)

```ts
const s = await readSpk(daf) // Read a SPK file
await s.segment(Naif.SSB, Naif.EMB)!.at(time) // Compute the position and velocity at time
```

### Star ![](bun.webp) ![](browser.webp)

```ts
const sirius = star(ra, dec, pmRA, pmDEC, parallax, rv, epoch) // BCRS cartesian coordinate from star parameters
spaceMotion(sirius, time) // BCRS cartesian coordinate at time applying space motion
sirius.observedAt(time, [ebp, ebv], ehp, refraction) // Observed spherical coordinate at time
```

### Statistics ![](bun.webp) ![](browser.webp)

```ts
const h = new Histogram(frequencies) // Create histogram from frequency array
h.mode // Most common value of data
h.count // Sum of data
h.mean // Arithmetic mean of data
h.variance // (Population) variance of data
h.standardDeviation // (Population) standard deviation of data
h.median // Median (middle value with interpolation) of data
```

### Stellarium ![](bun.webp)

```ts
const server = new StellariumProtocolServer(host, port, options)
server.start() // Start server
server.send(ra, dec) // Send the current coordinate
server.stop() // Stop server
readCatalogDat(source) // Read Stellarium's catalog.dat file
readNamesDat(source) // Read Stellarium's names.dat file
searchAround(catalog, ra, dec, fov) // Search around coordinate
```

### Sun ![](bun.webp) ![](browser.webp)

```ts
sunParallax(distance) // Compute the parallax of the Sun at a given distance
sunSemidiameter(distance) // Compute the semidiameter of the Sun at a given distance
carringtonRotationNumber(time) // Compute the Carrington rotation number of the Sun at time
season(year, name) // Compute the date of the solstice or equinox for a given year and season name
nearestSolarEclipse(time, next) // Nearest solar eclipse to time
solarSaros(time) // Compute the saros series number for the solar eclipse at time
```

### TASS17 ![](bun.webp) ![](browser.webp)

```ts
mimas(time) // Compute position and velocity of Mimas at given time
enceladus(time) // Compute position and velocity of Enceladus at given time
tethys(time) // Compute position and velocity of Tethys at given time
dione(time) // Compute position and velocity of Dione at given time
rhea(time) // Compute position and velocity of Rhea at given time
titan(time) // Compute position and velocity of Titan at given time
iapetus(time) // Compute position and velocity of Iapetus at given time
hyperion(time) // Compute position and velocity of Hyperion at given time
```

### Temperature ![](bun.webp) ![](browser.webp)

```ts
fahrenheit(1) // Convert fahrenheit to celsius
kelvin(1) // Convert Kelvin to celsius
toFahrenheit(1) // Convert celsius to fahrenheit
toKelvin(1) // Convert celsius to Kelvin
```

### Temporal ![](bun.webp) ![](browser.webp)

```ts
temporalNow() // Get the current temporal
temporalUnix(seconds) // Create a temporal from Unix timestamp
temporalFromDate(year, month, day, hour, minute, second, millisecond) // Create a temporal from year, month, day, hour, minute, second and millisecond
temporalFromTime(time) // Create a temporal from Time
temporalToDate(temporal) // Convert a temporal to year, month, day, hour, minute, second and millisecond
temporalAdd(temporal, duration, unit) // Add duration to temporal
temporalSubtract(temporal, duration, unit) // Subtract duration from temporal
temporalStartOfDay(temporal) // Get the start of the day for a temporal
temporalEndOfDay(temporal) // Get the end of the day for a temporal
temporalGet(temporal, unit) // Get a specific unit from a temporal
temporalSet(temporal, value, unit) // Set a specific unit in a temporal
formatTemporal(temporal, format) // Format a temporal to a string
parseTemportal(text, format) // Parse a temporal from a string
```

### Time ![](bun.webp) ![](browser.webp)

```ts
time(2460650, 0.37456, Timescale.UTC, true) // Time from day and fraction
timeUnix(1735133314, Timescale.UTC) // Time from unix seconds
timeNow() // Time from now
timeMJD(51544, Timescale.UTC) // Time from MJD date
timeJulianYear(2000.5, Timescale.UTC) // Time from Julian epoch year
timeBesselianYear(1950.5, Timescale.UTC) // Time from Besselian epoch year
timeYMDHMS(2024, 12, 25, 9, 10, 11.5, Timescale.UTC) // Time from year, month, day, hour, minute and second
timeYMD(2024, 12, 25, Timescale.UTC) // Time from year, month and day
timeYMDF(2024, 12, 25, 0.5, Timescale.UTC) // Time from year, month, day and fraction of day
timeGPS(630720013) // Time from GPS seconds
timeNormalize(2460650, 8.37456, 0, Timescale.UTC) // Normalize day and fraction
timeSubtract(a, b) // Subtract two Times
timeToDate(time) // Convert the time to year, month, day, hour, minute, second and nanosecond
toJulianDay(time) // Convert the time to Julian Day
timeToUnix(time) // Convert the time to Unix timestamp
timeToUnixMillis(time) // Convert the time to Unix milliseconds
timeToFractionOfYear(time) // Convert the time to fraction of year
ut1(time) // Convert the time to UT1 scale
utc(time) // Convert the time to UTC scale
tai(time) // Convert the time to TAI scale
tt(time) // Convert the time to TT scale
tcg(time) // Convert the time to TCG scale
tdb(time) // Convert the time to TDB scale
tcb(time) // Convert the time to TCB scale
greenwichApparentSiderealTime(time) // Greenwich Apparent Sidereal Time at time
greenwichMeanSiderealTime(time) // Greenwich Mean Sidereal Time at time
earthRotationAngle(time) // Earth Rotation Angle at time
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

### TIRS ![](bun.webp) ![](browser.webp)

```ts
tirsRotationAt(time) // TIRS rotation matrix at time
```

### Util ![](bun.webp) ![](browser.webp)

```ts
angularSizeOfPixel(focalLength, pixelSize) // CCD Resolution in arcsec/pixel
minOf(array) // Minimum value of the array
maxOf(array) // Maximum value of the array
meanOf(array) // Mean value of the array
medianOf(array) // Median value of the sorted array
binarySearch(array, value, options) // Binary search on a sorted array
```

### Vector ![](bun.webp) ![](browser.webp)

```ts
vecZero() // Vector filled with zeroes
vecXAxis() // X-axis vector
vecYAxis() // Y-axis vector
vecZAxis() // Z-axis vector
vecClone(v) // Clone the vector
vecNormalize(v) // Normalize the vector
vecLength(v) // Length of the vector
vecDistance(v, u) // Distance between vectors
vecAngle(v, u) // Angle between vectors
vecDot(v, u) // Dot product between vectors
vecCross(v, u) // Cross product between vectors
vecLatitude(v)
vecLongitude(v)
vecNegate(v) // Negate the vector
vecPlusScalar(v, 2) // Sum the vector by a scalar
vecMinusScalar(v, 2) // Subtract the vector by a scalar
vecMulScalar(v, 2) // Multiply the vector by a scalar
vecDivScalar(v, 2) // Divide the vector by a scalar
vecPlus(v, u) // Sum two vectors
vecMinus(v, u) // Subtract two vectors
vecMul(v, u) // Multiply two vectors
vecDiv(v, u) // Divide two vectors
vecRotateByRodrigues(v, axis, PI / 4) // Rotate the vector around an axis
vecPlane(v, u, w) // Vector from plane of three vectors
vecRotX(v, angle) // Rotate the vector around x-axis
vecRotY(v, angle) // Rotate the vector around y-axis
vecRotZ(v, angle) // Rotate the vector around z-axis
```

### Velocity ![](bun.webp) ![](browser.webp)

```ts
kilometerPerSecond(10) // Convert km/s to AU/d
meterPerSecond(1000) // Convert m/s to AU/d
toKilometerPerSecond(1) // Convert AU/d to km/s
toMeterPerSecond(1) // Convert AU/d to m/s
```

### Vizier ![](bun.webp) ![](browser.webp)

```ts
const [header, ...data] = vizierQuery(query, options) // Search on Vizier TAP service
```

### VSOP87E ![](bun.webp) ![](browser.webp)

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

### WCS ![](bun.webp)

```ts
using wcs = new Wcs(headers)
const [ra, dec] = wcs.pixToSky(x, y)
const [x, y] = wcs.skyToPix(ra, dec)
```

### Xisf ![](bun.webp)

```ts
byteShuffle(input, output, itemSize)
byteUnshuffle(input, output, itemSize)
```

### XML ![](bun.webp) ![](browser.webp)

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
- [Astrarium](https://github.com/Astrarium/Astrarium)
- [Iris](https://github.com/observerly/iris)
