---
title: Meeus Mars Disk
layout: default
parent: Meeus Algorithms
grand_parent: Astronomy
nav_order: 270
description: Computes the Meeus physical ephemeris of Mars, including pole, central meridian, disk size, and illuminated fraction.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Mars
---

# Meeus Mars Disk

`Mars.physical(jde)` computes the chapter 42 appearance of the Martian disk at a numeric **TT Julian ephemeris day (JDE)**. Use it to annotate a Meeus-style Mars drawing with sub-Earth and sub-solar latitudes, central meridian, pole orientation, and illumination geometry. It returns a fresh eight-element tuple; angles are **radians** except for its dimensionless illuminated fraction.

## Basic usage

```ts
import { Mars } from '../src/astronomy/ephemeris/meeus';
import { toArcsec, toDeg } from '../src/math/units/angle';

const [earthDeclination, sunDeclination, centralMeridian, poleAngle, defectAngle, diameter, litFraction, defect] = Mars.physical(2448935.500683);
console.log(toDeg(earthDeclination), toDeg(sunDeclination), toDeg(centralMeridian), toDeg(poleAngle));
console.log(toDeg(defectAngle), toArcsec(diameter), litFraction, toArcsec(defect));
```

The chapter test gives approximately `[+12.44°, −2.76°, 111.55°, 347.64°, 279.91°, 10.75″, 0.9012, 1.06″]` after converting the angular results to degrees or arcseconds as shown. The angular defect is `(1 − litFraction) × angularDiameter`.

## Result order and meaning

| Index | Value                              | Meaning                                                                                        |
| ----- | ---------------------------------- | ---------------------------------------------------------------------------------------------- |
| 0     | Earth declination `DE`             | Planetocentric latitude of Earth relative to Mars's equator; positive toward the north pole.   |
| 1     | Solar declination `DS`             | Planetocentric latitude of the Sun relative to Mars's equator; positive toward the north pole. |
| 2     | Central meridian `omega`           | Martian longitude at the apparent disk center, wrapped to `[0, 2π)`.                           |
| 3     | Pole position angle `P`            | Apparent sky-plane position angle of the Martian north pole, wrapped to `[0, 2π)`.             |
| 4     | Greatest-defect position angle `Q` | Sky-plane direction of the greatest phase defect, wrapped to `[0, 2π)`.                        |
| 5     | Angular diameter `d`               | Apparent full-disk diameter in radians.                                                        |
| 6     | Illuminated fraction `k`           | Dimensionless fraction of the apparent disk that is lit.                                       |
| 7     | Angular defect `q`                 | Missing illuminated width, `(1 − k) × d`, in radians.                                          |

The pole and defect angles describe different directions on the apparent disk. Convert angles to degrees or arcseconds only for display; the returned tuple remains in radians. The central meridian is a Meeus chapter 42 rotation coordinate, not an IAU body-fixed prime-meridian angle.

## Model and limitations

The implementation forms a geocentric Mars direction from VSOP87E Earth and Mars positions, with **two light-time refinements** for Mars. It then applies the chapter's rotation and solar-axis formulas, FK5 conversion, nutation, and low-order aberration where used by the reduction. The illuminated fraction comes from the Sun–Mars–Earth distance triangle. The result does not include an observing site's parallax, atmosphere, surface feature map, or a claimed accuracy bound over arbitrary epochs.

The separate `MARS_ROTATION` cartographic model uses different pole and prime-meridian constants. Its current implementation is linear and also omits the IAU 2015 periodic refinements; it is not interchangeable with the Meeus chapter 42 central meridian. Use an IAU body-fixed orientation workflow when those axes are required.

## Related topics

- [Meeus Illuminated Fraction]({% link astronomy/meeus-algorithms/illuminated-fraction.md %}) explains the disk-fraction geometry used here.
- [Meeus Geocentric Planet Positions]({% link astronomy/meeus-algorithms/geocentric-planet-positions.md %}) describes the planetary series that feed the reduction.
- [Meeus Calendar]({% link astronomy/meeus-algorithms/calendar.md %}) covers numeric TT JDE and calendar labels.
