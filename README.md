# Nebulosa

The complete integrated solution for all of your astronomical imaging needs.

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
formatAngle(PI, { isHour: true }) // Format the angle to string
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

### IERS

```ts
iersa.load(await Bun.file('finals2000A.txt').arrayBuffer())
iersb.load(await Bun.file('eopc04.1962-now.txt').arrayBuffer())
delta(time) // UT1-UTC at time
xy(time) // Polar motion angles at time
```

### ITRS

```ts
itrs(location) // ITRS xyz position for location
rotationAt(time) // ITRS rotation matrix at time
dRdtTimesRtAt(time)
```

### Location

```ts
location(dms(10, 11, 12), dms(25, 26, 27), meter(123), Geoid.IERS2010) // Create new location from longitude, latitude, elevation and model
polarRadius(Geoid.IERS2010) // Earth's polar radius
rotationAt(location, time) // GCRS rotation of the location at time
dRdtTimesRtAt(location, time)
```

### Math

```ts
pmod(-PI, TAU)
divmod(10, 4)
roundToNearestWholeNumber(5.6)
twoSum(0.1, 0.2)
split(0.5)
twoProduct(0.5, 0.4)
```

### Matrix

```ts
const m: MutMat3 = [1, 2, 3, 4, 5, 6, 7, 8, 9]
zero()
identity()
rotX(PI, m)
rotY(PI, m)
rotZ(PI, m)
clone(m)
determinant(m)
trace(m)
transpose(m)
flipX(m)
flipY(m)
negate(m)
plusScalar(m, 2)
minusScalar(m, 2)
mulScalar(m, 2)
divScalar(m, 2)
plus(m, n)
minus(m, n)
mul(m, n)
mulVec(m, v)
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
pmAngles(iersab, time)
pmMatrix(iersab, time)
```

### TIRS

```ts
rotationAt(time) // TIRS rotation matrix at time
dRdtTimesRtAt(time)
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
