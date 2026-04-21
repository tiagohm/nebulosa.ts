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
normalizeAngle(TAU + PI) // Normalize the angle to [0..TAU)
normalizePI(-TAU) // Normalize the angle to [-PI..PI)
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
formatDEC(PI) // Format the angle in degrees as +00 00 00.00
formatAZ(PI) // Format the angle in degrees as 000 00 00.00
formatALT(PI) // Format the angle in degrees as +00 00 00.00
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
login({ apiKey }) // Start a nova.astrometry.net session
upload({ input, session, rightAscension, declination, radius }) // Submit an image path, URL, or Blob for solving
submissionStatus(submission, { session }) // Inspect submission jobs and progress
wcsFile(jobId, { session }) // Download the solved WCS FITS blob
novaAstrometryNetPlateSolve(input, options)
localAstrometryNetPlateSolve(input, options)
```

### AutoFocus ![](bun.webp) ![](browser.webp)

```ts
const autoFocus = new AutoFocus({ fittingMode: 'TREND_PARABOLIC', initialOffsetSteps: 5, stepSize: 100, maxPosition: 100000, reversed: false, rmsdThreshold: 0.15 })
const step = autoFocus.add(focusPosition, hfd)
```

### Compression ![](bun.webp)

```ts
compressRice(input, blockSize, initialCapacity)
decompressRice(input, output, blockSize)
inflate(input) // Decompress deflate-compressed bytes
deflate(input) // Compress bytes with deflate
```

### Constellation ![](bun.webp) ![](browser.webp)

```ts
constellation(ra, dec, equinox) // Constellation at RA/DEC coordinate
```

### Coordinate ![](bun.webp) ![](browser.webp)

```ts
angularDistance(ra0, dec0, ra1, dec1) // Angular separation between two equatorial coordinates
equatorialFromJ2000(raJ2000, decJ2000, time) // Convert J2000 RA/DEC to the current equatorial frame
equatorialToJ2000(ra, dec, time) // Convert current RA/DEC to J2000
equatorialToHorizontal(ra, dec, latitude, lst) // Convert equatorial to azimuth/altitude
equatorialToEclipticJ2000(ra, dec) // Convert J2000 equatorial to J2000 ecliptic
equatorialToEcliptic(ra, dec, time) // Convert current equatorial to current ecliptic
eclipticJ2000ToEquatorial(longitude, latitude) // Convert J2000 ecliptic to J2000 equatorial
eclipticToEquatorial(longitude, latitude, time) // Convert current ecliptic to current equatorial
galacticToEquatorial(longitude, latitude) // Convert galactic to equatorial
equatorialToGalatic(ra, dec) // Convert equatorial to galactic
zenith(longitude, latitude, time) // Current equatorial coordinates of the local zenith
meridianEquator(longitude, time) // Current equatorial coordinates where the meridian crosses the celestial equator
meridianEcliptic(longitude, time) // Current equatorial coordinates where the meridian crosses the ecliptic
equatorEcliptic(longitude, time) // Nearer equinox node where the equator crosses the ecliptic
```

### CRC ![](bun.webp) ![](browser.webp)

```ts
CRC.crc3gsm.compute(data)
CRC.crc4itu.compute(data)
CRC.crc4interlaken.compute(data)
CRC.crc5epc.compute(data)
CRC.crc5itu.compute(data)
CRC.crc5usb.compute(data)
CRC.crc6cdma2000a.compute(data)
CRC.crc6cdma2000b.compute(data)
CRC.crc6darc.compute(data)
CRC.crc6gsm.compute(data)
CRC.crc6itu.compute(data)
CRC.crc7.compute(data)
CRC.crc7umts.compute(data)
CRC.crc8.compute(data)
CRC.crc8cdma2000.compute(data)
CRC.crc8darc.compute(data)
CRC.crc8dvbs2.compute(data)
CRC.crc8ebu.compute(data)
CRC.crc8icode.compute(data)
CRC.crc8itu.compute(data)
CRC.crc8maxim.compute(data)
CRC.crc8rohc.compute(data)
CRC.crc8wcdma.compute(data)
CRC.crc10.compute(data)
CRC.crc10cdma2000.compute(data)
CRC.crc10gsm.compute(data)
CRC.crc11.compute(data)
CRC.crc12.compute(data)
CRC.crc12cdma2000.compute(data)
CRC.crc12gsm.compute(data)
CRC.crc13bbc.compute(data)
CRC.crc14darc.compute(data)
CRC.crc14gsm.compute(data)
CRC.crc15can.compute(data)
CRC.crc15mpt1327.compute(data)
CRC.crc16.compute(data)
CRC.crc16ccittfalse.compute(data)
CRC.crc16augccitt.compute(data)
CRC.crc16buypass.compute(data)
CRC.crc16cdma2000.compute(data)
CRC.crc16dds110.compute(data)
CRC.crc16dectr.compute(data)
CRC.crc16dectx.compute(data)
CRC.crc16dnp.compute(data)
CRC.crc16en13757.compute(data)
CRC.crc16genibus.compute(data)
CRC.crc16maxim.compute(data)
CRC.crc16mcrf4cc.compute(data)
CRC.crc16riello.compute(data)
CRC.crc16t10dif.compute(data)
CRC.crc16teledisk.compute(data)
CRC.crc16tms13157.compute(data)
CRC.crc16usb.compute(data)
CRC.crca.compute(data)
CRC.crc16kermit.compute(data)
CRC.crc16modbus.compute(data) // Compute CRC-16/MODBUS using a built-in preset
CRC.crc16x25.compute(data)
CRC.crc16xmodem.compute(data)
CRC.crc17can.compute(data)
CRC.crc21can.compute(data)
CRC.crc24.compute(data)
CRC.crc24ble.compute(data)
CRC.crc24flexraya.compute(data)
CRC.crc24flexrayb.compute(data)
CRC.crc24ltea.compute(data)
CRC.crc24lteb.compute(data)
CRC.crc24os9.compute(data)
CRC.crc30cdma.compute(data)
CRC.crc32.compute(data) // Compute CRC-32 using a built-in preset
CRC.crc32mhash.compute(data)
CRC.crc32bzip2.compute(data)
CRC.crc32c.compute(data)
CRC.crc32d.compute(data)
CRC.crc32mpeg2.compute(data)
CRC.crc32posix.compute(data)
CRC.crc32q.compute(data)
CRC.crc32jamcrc.compute(data)
CRC.crc32xfer.compute(data)
CRC.crc32.compute(chunk, previous) // Continue an incremental CRC calculation

const custom = new CRC(bit, polynomial, initial, reflect, finalXor)
custom.compute(data) // Compute a checksum using a custom CRC definition
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

### Delta T ![](bun.webp) ![](browser.webp)

```ts
parabolaOfStephensonMorrison2004.compute(year) // Historical quadratic Delta T model
parabolaOfStephensonMorrisonHohenkerk2016.compute(year) // Revised historical quadratic Delta T model
s15(year) // Delta T estimate from Stephenson et al. 2021
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

### Ephemeris ![](bun.webp) ![](browser.webp)

```ts
ellipticToRectangular(a, n, elements, dt) // Position and velocity from elliptic orbital elements
ellipticToRectangularN(mu, elements, dt) // Position and velocity using the mean-motion formulation
ellipticToRectangularA(mu, elements, dt) // Position and velocity using the semimajor-axis formulation
```

### Erfa ![](bun.webp) ![](browser.webp)

```ts
eraAnpm(angle) // Normalize an angle into [-PI..PI)
eraP2s(x, y, z) // Cartesian to spherical with radius
eraC2s(x, y, z) // Cartesian to spherical angles
eraS2c(theta, phi) // Spherical angles to Cartesian unit vector
eraS2p(theta, phi, r) // Spherical to Cartesian with radius

eraTaiUtc(tai1, tai2) // TAI to UTC two-part Julian date
eraUtcTai(utc1, utc2) // UTC to TAI two-part Julian date
eraUtcUt1(utc1, utc2, dut1) // UTC to UT1
eraUt1Utc(ut11, ut12, dut1) // UT1 to UTC
eraJdToCal(dj1, dj2) // Julian date to calendar date
eraCalToJd(year, month, day) // Calendar date to Julian date
eraDat(year, month, day, dayFraction) // TAI-UTC leap seconds at date

eraEra00(ut11, ut12) // Earth rotation angle
eraGmst06(ut11, ut12, tt1, tt2) // Greenwich mean sidereal time
eraGst06a(ut11, ut12, tt1, tt2) // Greenwich apparent sidereal time
eraObl06(tt1, tt2) // Mean obliquity of the ecliptic
eraNut06a(tt1, tt2) // Nutation angles
eraPnm06a(tt1, tt2) // Precession-nutation matrix
eraC2i06a(tt1, tt2) // Celestial-to-intermediate matrix
eraC2t06a(tt1, tt2, ut11, ut12, xp, yp, sp) // Celestial-to-terrestrial matrix
eraPom00(xp, yp, sp) // Polar motion matrix

eraGc2Gde(radius, flattening, x, y, z) // Geocentric Cartesian to geodetic
eraGd2Gce(radius, flattening, longitude, latitude, height) // Geodetic to geocentric Cartesian
eraStarpv(ra, dec, pmRa, pmDec, parallax, rv) // Catalog star data to position/velocity
eraPvstar(p, v) // Position/velocity to catalog star parameters
eraSeps(al, ap, bl, bp) // Angular separation between spherical points
eraSepp(a, b) // Angular separation between Cartesian vectors
eraRefco(pressure, temperature, humidity, wavelength) // Atmospheric refraction coefficients

eraApci13(tdb1, tdb2, ebpv, ehp) // Astrometry parameters for ICRS to CIRS transforms
eraApco13(tt1, tt2, ut11, ut12, lon, lat, height, xp, yp, sp, pressure, temperature, humidity, wavelength, ebpv, ehp) // Astrometry parameters for observed-place transforms
eraApio13(tt1, tt2, ut11, ut12, lon, lat, height, xp, yp, sp, pressure, temperature, humidity, wavelength) // CIRS-to-observed-place parameters
eraAtci13(tdb1, tdb2, rc, dc, pr, pd, px, rv, ebpv, ehp) // ICRS to CIRS
eraAtco13(tt1, tt2, ut11, ut12, rc, dc, pr, pd, px, rv, lon, lat, height, xp, yp, sp, pressure, temperature, humidity, wavelength, ebpv, ehp) // ICRS to observed place
eraAtoc13(type, ob1, ob2, tt1, tt2, ut11, ut12, lon, lat, height, xp, yp, sp, pressure, temperature, humidity, wavelength, ebpv, ehp) // Observed place to ICRS
eraAticq(ri, di, astrom) // CIRS to ICRS using precomputed astrometry parameters
```

### Firmata ![](bun.webp)

```ts
const board = new ESP8266()
const client = new FirmataClient(transport, board)
const client = new FirmataClientOverTcp(board)

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
client.analogWrite(pin, value)
client.samplingInterval(ms)
client.twoWireConfig(us)
client.twoWireReadWrite(address, operationMode, data, addressMode, autoRestart)
client.twoWireRead(address, register, bytesToRead, continuous, addressMode, autoRestart)
client.twoWireWrite(address, data, addressMode)
client.twoWireStop(address, addressMode)
client.oneWireConfig(pin, powerMode)
client.oneWireSearch(pin, mode)
client.oneWireCommand(pin, options)
client.oneWireReset(pin)
client.oneWireWrite(pin, data, address)
client.oneWireRead(pin, bytesToRead, address, correlationId)
client.oneWireWriteAndRead(pin, data, bytesToRead, address, correlationId)

const sensor = new ACS712(client, pin, options)
const sensor = new AM2320(client, pollingInterval)
const sensor = new BH1750(client, address, pollingInterval, options)
const sensor = new LM35(client, pin, aref)
const sensor = new BMP180(client, mode, pollingInterval)
const sensor = new BMP280(client, address, pollingInterval, options)
const sensor = new DS18B20(client, pin, pollingInterval, options)
const sensor = new HMC5883L(client, address, pollingInterval, options)
const sensor = new MAX44009(client, address, pollingInterval, options)
const sensor = new MPU6050(client, address, pollingInterval, options)
const sensor = new SHT21(client, pollingInterval)
const sensor = new TEMT6000(client, pin, options)
const sensor = new TSL2561(client, address, pollingInterval, options)

const dac = new MCP4725(client, address, options)
dac.value = value
dac.powerDownMode = mode

const expander = new PCF8574(client, address, pollingInterval, options)
expander.pinMode(pin, mode)
expander.pinWrite(pin, value)
expander.pinRead(pin)

const display = new HD44780(expander, options)
display.begin(columns, rows)
display.clear()
display.home()
display.setCursor(column, row)
display.print(value)

const clock = new DS3231(client, address, pollingInterval)
const clock = new DS1307(client, address, pollingInterval)
clock.update(year, month, day, dayOfWeek, hour, minute, second, millisecond)
clock.sync(date)

const radio = new TEA5767(client, address, pollingInterval, options)
const radio = new RDA5807(client, address, pollingInterval, options)
radio.frequency = value
radio.frequencyUp()
radio.frequencyDown()
radio.volume = value
radio.mute()
radio.unmute()
radio.seek('up')

const transmitter = new KT0803L(client, address, options)
transmitter.frequency = value
transmitter.frequencyUp()
transmitter.frequencyDown()
transmitter.mute()
transmitter.unmute()

sensor.reset()
sensor.addListener(listener)
sensor.start()
sensor.stop()
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

### Guider ![](bun.webp)

```ts
validateCalibration(calibration) // Validate a guider calibration matrix
invertCalibration(calibration) // Invert image-motion calibration into axis space
applyCalibration(calibration, dx, dy) // Convert pixel error into RA/DEC axis error
filterGuideStars(frame, config) // Filter stars for guiding and compute frame quality
selectGuideStar(stars, width, height, image, options) // Pick the best lock star and alternatives
estimateTranslation(referenceStars, stars, maxMatchDistancePx, outlierSigma) // Measure frame drift between star lists
applyDeadband(error, minMove) // Suppress corrections smaller than the guiding deadband

const guider = new Guider(config)
const command = guider.processFrame(frame) // Compute RA/DEC guide pulses from a guide frame
guider.startDither(dx, dy)
guider.stopDither()
guider.lastDiagnostics()
guider.currentState

const calibrator = new GuidingCalibrator(config)
const step = calibrator.processFrame(frame) // Advance the calibration state machine
flipGuidingCalibration(calibration, reverseDecOutput) // Mirror a solved calibration after a meridian flip
calibrator.reset()
calibrator.lastDiagnostics()
calibrator.currentState

const client = new GuiderClient(cameraManager, guideOutputManager, options)
client.connect(camera, guideOutput, connectOptions)
client.findStar()
client.startCapture(exposure)
client.guide(recalibrate, settle)
client.dither(amount, raOnly, settle)
client.flipCalibration()
client.stopCapture()
client.disconnect()
```

### GUST86 ![](bun.webp) ![](browser.webp)

```ts
ariel(time) // Position and velocity of Ariel at given time
umbriel(time) // Position and velocity of Umbriel at given time
oberon(time) // Position and velocity of Oberon at given time
titania(time) // Position and velocity of Titania at given time
miranda(time) // Position and velocity of Miranda at given time
```

### HEALPix ![](bun.webp) ![](browser.webp)

```ts
const index = new HealpixIndex({ nside: 1024, ordering: 'nested' })
index.add(id, ra, dec, metadata)
index.addMany(objects)
index.get(id)
index.update(id, ra, dec, metadata)
index.remove(id)
index.queryCone(ra, dec, radius)
index.queryPolygon(vertices)
index.queryBox(minRa, maxRa, minDec, maxDec)
index.queryRegion(query)
index.clear()
```

### Hips2Fits ![](bun.webp) ![](browser.webp)

```ts
hips2Fits(survey, ra, dec, options) // Extract a FITS image from a HiPS 
hipsSurveys() // List available HiPS
```

### HNSKY ![](bun.webp)

```ts
const stars = await findHnsky290Stars(directory, database, query)
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
readImageFromXisf(fits) // Read image from XISF file
readImageFromSource(source) // Read FITS/XISF image from source
readImageFromBuffer(source) // Read FITS/XISF image from buffer
readImageFromFileHandle(source) // Read FITS/XISF image from file handle
readImageFromPath(source) // Read FITS/XISF image from file path
writeImageToFormat(image, path, format) // Write image to path as png, jpeg, webp, etc
writeImageToFits(image, sink) // Write image to sink as FITS format
writeImageToXisf(image, sink, format) // Write image to sink as XISF format
clone(image) // Clone the image
copyInto(from, to) // Copy one image into another
plus(a, b, out) // Add two images
plusScalar(a, scalar, out) // Add a scalar to an image
subtract(a, b, out) // Subtract one image from another
subtractScalar(a, scalar, out) // Subtract a scalar from an image
multiply(a, b, out) // Multiply two images
multiplyScalar(a, scalar, out) // Multiply image by scalar
divide(a, b, out) // Divide one image by another
divideScalar(a, scalar, out) // Divide image by scalar
stf(image, midtone, shadow, highlight, options) // Apply STF to image
arcsinhStretch(image, options) // Stretch image using arcsinh
approximateArcsinhStretchParameters(midtone, shadow, highlight) // Estimate arcsinh parameters from STF values
backgroundNeutralization(image, options) // Neutralize the image background
curvesTransformation(image, options) // Apply a curves transform
adf(image, options) // Calculate the STF parameters
bayer(image, pattern) // Bayer the image using the CFA pattern
debayer(image, pattern) // Debayer the image
scnrMaximumMask(a, b, c, amount) // Compute the SCNR maximum mask
scnrAdditiveMask(a, b, c, amount) // Compute the SCNR additive mask
scnrAverageNeutral(a, b, c, amount) // SCNR average neutralization
scnrMaximumNeutral(a, b, c, amount) // SCNR maximum neutralization
scnrMinimumNeutral(a, b, c, amount) // SCNR minimum neutralization
scnr(image, channel, amount, method) // Apply SCNR to image
horizontalFlip(image) // Horizontal flip the image
verticalFlip(image) // Vertical flip the image
invert(image) // Invert image values
grayscale(image, channel) // Convert image to grayscale
convolutionKernel(kernel, width, height, divisor) // Create a convolution kernel
convolution(image, kernel, options) // Apply a convolution kernel
gaussianBlurKernel(sigma, size) // Create a Gaussian blur kernel
edges(image, options) // Enhance image edges
emboss(image, options) // Emboss the image
meanConvolutionKernel(size) // Create a mean convolution kernel
mean(image, size, options) // Apply a mean filter
mean3x3(image, options) // Apply a 3x3 mean filter
mean5x5(image, options) // Apply a 5x5 mean filter
mean7x7(image, options) // Apply a 7x7 mean filter
sharpen(image, options) // Sharpen the image
blurConvolutionKernel(size) // Create a blur kernel
blur(image, size, options) // Apply a blur filter
blur3x3(image, options) // Apply a 3x3 blur filter
blur5x5(image, options) // Apply a 5x5 blur filter
blur7x7(image, options) // Apply a 7x7 blur filter
gaussianBlur(image, options) // Apply Gaussian blur
multiscaleMedianTransform(image, options) // Apply a multiscale median transform

const workspace = new FFTWorkspace(width, height)
workspace.mask(filterType, cutoff) // Generate a frequency-domain mask
fft(image, workspace, filterType, cutoff, weight) // Apply FFT filtering

psf(image) // Estimate the image point spread function
histogram(image, options) // Generate the histogram from image
median(image, options) // Calculate the median from image
medianAbsoluteDeviation(image, median, normalized, options) // Calculate the MAD from image
sigmaClip(image, options) // Generate rejection map using sigma-clip
estimateBackground(image, options) // Estimate the image background
estimateBackgroundUsingMode(image, options) // Estimate the background using the mode
brightness(image, value) // Adjust image brightness
saturation(image, value, channel) // Adjust image saturation
linear(image, slope, intercept) // Apply a linear transform
contrast(image, value) // Adjust image contrast
gamma(image, value) // Apply gamma correction
calibrate(light, dark, flat, bias, darkFlat) // Calibrate a light frame
generateNoiseImage(raw, width, height, channels, config)
generateStarImage(raw, width, height, channels, stars, noiseConfig, plotOptions)
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

### iPolar ![](bun.webp) ![](browser.webp)

```ts
solveSimilarityFixedPoint(transform) // Solve the fixed point from a similarity transform
projectGuidePoint(point, width, height, margin) // Project a guide point into image coordinates
celestialPoleVector(time, location, refraction) // Pole vector for the observer and time
decomposePolarError(axisVector, targetVector, time, refraction, location) // Convert axis error to altitude/azimuth components
solveImageFixedPoint(reference, current, initialGuess, tolerance) // Refine the fixed point from two images

const alignment = new IPolarPolarAlignment(config)
alignment.reset()
alignment.getState()
alignment.start(frameInput, observerContext)
alignment.confirm(frameInput)
alignment.update(frameInput)
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
Base.lightTime(distance) // Light-travel time in days
Base.illuminated(phaseAngle) // Illuminated fraction of a body's disk
Base.limb(bodyRa, bodyDec, sunRa, sunDec) // Position angle of the bright limb midpoint
Base.horner(x, coefficients) // Polynomial evaluation with Horner's method
```

### Moon ![](bun.webp) ![](browser.webp)

```ts
moonParallax(distance) // Compute the moon parallax at a given distance
moonSemidiameter(distance) // Compute the moon semidiameter at a given distance
lunation(time, system) // Compute the lunation at a given time and system
nearestLunarPhase(time, phase, next) // Compute the nearest lunar phase at a given time
nearestLunarEclipse(time, next) // Compute the nearest lunar eclipse at a given time
lunarSaros(time) // Compute the saros series number for the lunar eclipse at time
nearestLunarApsis(time, apsis, next) // Compute the nearest lunar apsis at time
```

### Mount Pointing ![](bun.webp) ![](browser.webp)

```ts
computePointingError(targetRa, targetDec, solvedRa, solvedDec) // Pointing error in tangent coordinates
fitPointingModel(samples, options) // Fit an empirical, semi-physical, or hybrid pointing model
predictPointingModelError(model, input) // Predict local pointing error for a new sample
correctPointingCoordinate(model, input) // Apply the fitted correction to a target coordinate

const pointing = new MountPointing(defaults)
pointing.add(sample)
const model = pointing.fit(options)
const predicted = pointing.predictError(input)
const corrected = pointing.correctCoordinate(input)
pointing.export() // Serialize the fitted model
pointing.import(model) // Restore a previously fitted model
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

### Platesolver ![](bun.webp) ![](browser.webp)

```ts
plateSolutionFrom(header) // Convert FITS WCS keywords into a compact plate solution
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

### Projection ![](bun.webp) ![](browser.webp)

```ts
gnomonicProject(longitude, latitude, centerLongitude, centerLatitude) // Tangent-plane projection
gnomonicUnproject(x, y, centerLongitude, centerLatitude) // Inverse gnomonic projection
stereographicProject(longitude, latitude, centerLongitude, centerLatitude) // Stereographic projection
stereographicUnproject(x, y, centerLongitude, centerLatitude) // Inverse stereographic projection
orthographicProject(longitude, latitude, centerLongitude, centerLatitude) // Orthographic projection
orthographicUnproject(x, y, centerLongitude, centerLatitude) // Inverse orthographic projection
lambertAzimuthalEqualAreaProject(longitude, latitude, centerLongitude, centerLatitude) // Lambert azimuthal equal-area projection
lambertAzimuthalEqualAreaUnproject(x, y, centerLongitude, centerLatitude) // Inverse Lambert azimuthal equal-area projection
azimuthalEquidistantProject(longitude, latitude, centerLongitude, centerLatitude) // Azimuthal equidistant projection
azimuthalEquidistantUnproject(x, y, centerLongitude, centerLatitude) // Inverse azimuthal equidistant projection
```

### Random ![](bun.webp) ![](browser.webp)

```ts
const random = mulberry32(seed)
const random = sfc32(seed)
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
gaussian(random, sigma)
triangular(random, min, max, mode)
rayleigh(random, sigma)
logNormal(random, mu, sigma)
cauchy(random, x0, gamma)
shuffle(items, random)
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

### SGP4 ![](bun.webp) ![](browser.webp)

```ts
const source = parseTLE(line1, line2, name)
const source = recordFromTLE(tle)
const source = recordFromOMM(omm, opsmode)
const message = satelliteRecordErrorMessage(error)
const pv = sgp4(time, source)
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

### Spline ![](bun.webp) ![](browser.webp)

```ts
const s = spline(lower, upper, coefficients) // Polynomial spline over a normalized interval
s.compute(x)
s.derivative()
s.integral(constant)

splineGivenEnds(x0, y0, slope0, x1, y1, slope1) // Cubic spline constrained by endpoint values and slopes

const cubic = cubicHermiteSpline(x, y) // Shape-preserving cubic Hermite interpolation
const akima = akimaSpline(x, y) // Akima interpolation
const catmull = catmullRomSpline(x, y) // Catmull-Rom interpolation
const natural = naturalCubicSpline(x, y) // Natural cubic spline interpolation

cubic.compute(xi) // Evaluate an interpolating spline
cubicHermiteSplineLUT(x, y, size) // Dense lookup table sampled from a cubic Hermite spline
akimaSplineLUT(x, y, size) // Dense lookup table sampled from an Akima spline
catmullRomSplineLUT(x, y, size) // Dense lookup table sampled from a Catmull-Rom spline
naturalCubicSplineLUT(x, y, size) // Dense lookup table sampled from a natural cubic spline
```

### Star ![](bun.webp) ![](browser.webp)

```ts
const sirius = star(ra, dec, pmRA, pmDEC, parallax, rv, epoch) // BCRS cartesian coordinate from star parameters
spaceMotion(sirius, time) // BCRS cartesian coordinate at time applying space motion
sirius.observedAt(time, [ebp, ebv], ehp, refraction) // Observed spherical coordinate at time
plotStar(raw, width, height, channels, x, y, flux, hfd, snr, seeing, colorIndex, options)
matchStars(referenceStars, currentStars, options)
crossMatchStars(stars, catalog, options)
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

### Stacker ![](bun.webp) ![](browser.webp)

```ts
const live = new LiveStacker(options)
live.add(frame) // Add one frame to a live stack
const preview = live.snapshot() // Current live stacked image and diagnostics
live.reset()

const result = stackFrames(frames, options) // Full batch stack with diagnostics and coverage information
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
parseTemporal(text, format) // Parse a temporal from a string
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

### UCAC4 ![](bun.webp)

```ts
ucac4ZoneForDec(dec) // Native UCAC4 zone number for a declination

const catalog = await openUcac4Catalog(directory)
await catalog.get(zone, recordNumber) // Read a raw UCAC4 entry by native identifier
await catalog.queryCone(ra, dec, radius) // Search around a coordinate using the generic star-catalog API
await catalog.queryBox(minRa, maxRa, minDec, maxDec) // Search a RA/DEC box using the generic star-catalog API
await catalog.close()
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
readXisf(source)
writeXisf(sink, images, format)
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
