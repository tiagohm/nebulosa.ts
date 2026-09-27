---
title: Meeus Globe Ellipsoid
layout: default
parent: Astronomy
nav_order: 250
description: Evaluates Meeus Earth-ellipsoid radii, parallax factors, and surface distances.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Globe
---

# Meeus Globe Ellipsoid

`Globe` supplies Earth-shape calculations used in Meeus chapter 11: observer parallax factors, latitude-dependent radii, and surface distances. Use it when reproducing those chapter calculations or supplying their geodetic inputs. The included `EARTH76` ellipsoid has an equatorial radius of **6378.14 km** and flattening **1/298.257**; its public distance values are in **AU**.

## Basic usage

```ts
import { Globe } from '../src/astronomy/ephemeris/meeus';
import { meter, toKilometer } from '../src/math/units/distance';
import { deg } from '../src/math/units/angle';

const [rhoSinPhiPrime, rhoCosPhiPrime] = Globe.EARTH76.parallaxConstants(deg(42), meter(1706));
const surfaceDistanceKm = toKilometer(Globe.EARTH76.distance(deg(0), deg(0), deg(1), deg(0)));
console.log(rhoSinPhiPrime, rhoCosPhiPrime, surfaceDistanceKm);
```

`Globe.Ellipsoid(equatorialRadius, flattening)` accepts radius in **AU** and dimensionless flattening. Its `A` and `B` getters return equatorial and polar radii in AU; `eccentricity` is dimensionless. Geodetic latitude and longitude arguments use **radians**. `parallaxConstants(latitude, height)` takes height in AU above the ellipsoid and returns dimensionless `[ρ sin φ′, ρ cos φ′]`, the geocentric observer components scaled by the equatorial radius. Use the same distance unit for height and ellipsoid radius.

`radiusAtLatitude(phi)` gives the radius of the parallel circle; `radiusOfCurvature(phi)` gives the meridional curvature radius. `oneDegreeOfLongitude` and `oneDegreeOfLatitude` multiply those radii by one degree in radians to return lengths in AU. `Ellipsoid.distance(lon1, lat1, lon2, lat2)` estimates surface distance in AU and returns zero for coincident points. `ROTATION_RATE_1996_5` is an angular rate in **radians/second**.

## Approximate alternatives and limits

`geocentricLatitudeDifference(phi)` estimates **geographic latitude minus geocentric latitude** in radians from fixed coefficients; it does not use a chosen `Ellipsoid`. `approxAngularDistance` returns the **cosine** of the central angle between two longitude/latitude pairs, rather than the angle itself. Applying `acos` to that cosine loses resolution at very small separations. `approxLinearDistance(angle)` treats Earth as a sphere of radius **6371 km**, multiplies by the central angle in radians, and returns AU.

The Meeus ellipsoid and approximations have no implementation-level accuracy bound across all locations. `EARTH76` is a different Earth model from the selectable ellipsoids used by the library's geographic observer APIs. Select a common ellipsoid, frame, and distance unit when comparing locations or parallax factors from the two paths.

## Related topics

- [Geographic Observer]({% link astronomy/coordinates-and-observers/geographic-observer.md %}) defines geodetic observing sites with selectable ellipsoids.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) provides the chapter-style Julian-day inputs used by nearby Meeus formulas.
