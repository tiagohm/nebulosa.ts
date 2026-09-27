---
title: Local Solar Eclipse Circumstances
layout: default
parent: Astronomy
nav_order: 550
description: Resolves local eclipse contacts, visibility, durations, and diagram geometry for a geographic site.

doc_kind: topic

sources:
    - src/astronomy/events/eclipse/solar/local.ts

api:
    - computeLocalSolarEclipseCircumstances
    - computeLocalSolarEclipseViewGeometry
    - listLocalSolarEclipses
    - computeGreatestEclipseCircumstances
    - computeGreatestDurationCircumstances
    - localVisibilityText
    - LocalSolarEclipseCircumstances
    - LocalSolarEclipseCircumstancesOptions
    - LocalSolarEclipseEvent
    - LocalSolarEclipseViewOptions
    - LocalSolarEclipseViewGeometry
    - LocalSolarEclipseListEntry
    - SolarEclipseExtremeCircumstances
---

# Local Solar Eclipse Circumstances

`computeLocalSolarEclipseCircumstances` resolves a solar eclipse at one geographic point from fitted Besselian elements. It reports local contacts, magnitude, phase durations, solar altitude, visibility, and contact position angles. A separate call builds SVG-ready disk and horizon geometry from those events.

## Basic usage

```ts
import { nearestSolarEclipse } from '../src/astronomy/bodies/sun';
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse';
import { computeLocalSolarEclipseCircumstances, computeLocalSolarEclipseViewGeometry } from '../src/astronomy/events/eclipse/solar/local';
import { computePolynomialBesselianElements } from '../src/astronomy/events/eclipse/solar/map';
import { timeYMD } from '../src/astronomy/time/time';
import { deg } from '../src/math/units/angle';

const eclipse = nearestSolarEclipse(timeYMD(2024, 4, 8), true);
const elements = computePolynomialBesselianElements(eclipse.maximalTime, sunMoonPosition);
const circumstances = computeLocalSolarEclipseCircumstances(elements, deg(-106.4), deg(23.25), { sunMoonPosition });
const diagram = computeLocalSolarEclipseViewGeometry(circumstances);
console.log(circumstances.visibility.centralPhaseKind, circumstances.visibility.kind, diagram.selectedEvent);
// total completelyVisible MAX
```

Longitude is **east-positive** and latitude is **geodetic**, both in radians. Build `PolynomialBesselianElements` with a Sun/Moon provider and pass that same provider through `sunMoonPosition` for the event solar altitudes and the diagram's solar angular radius. Without the option, solar altitude uses a Besselian approximation and the solar angular radius uses a fixed mean fallback; contact geometry still comes from the supplied Besselian elements. `horizonAltitude` is the observer's visibility threshold in radians and defaults to **0**; it does not add atmospheric refraction or a local terrain model.

## Contacts and visibility

The `events` object may contain `C1`, `MAX`, and `C4` for a partial eclipse, plus `C2` and `C3` when a local total or annular phase is resolved. Contacts are geometric and may occur below the selected horizon. Each event includes a `Time`, Julian Day, solar altitude in radians, magnitude, an `observable` flag, and a `visibility` value derived from the horizon threshold. Event times follow the time scale of the supplied Besselian elements; the example's `nearestSolarEclipse` pipeline uses **TT**.

At C1–C4, the optional `positionAngle` measures the **solar limb contact point** from celestial north toward east, wrapped to **[0, 2π)**; at `MAX` it uses the lunar-center direction. `zenithAngle` expresses the corresponding direction in the local zenith frame. For total C2/C3 the limb-contact direction is opposite the lunar-center direction. These angles may be `undefined` near a coincident Sun/Moon center, where the direction is ill-defined.

`visibility.hasGeometricEclipse` distinguishes a local overlap from an eclipse missed by the site. `hasObservableEclipse` checks whether any part rises above the selected horizon, including a possible interval between below-horizon contacts. `visibility.kind` distinguishes no eclipse, geometry wholly below the horizon, partial visibility, complete visibility, visible central phase, and an eclipse whose partial phase alone is visible. The `completeness` flags report whether both partial and, where applicable, both central contacts were resolved. A geometric central phase can exist even if its C2/C3 contacts or its visible portion are absent.

`details.maximalMagnitude` and `moonSunDiameterRatio` describe the local maximum. `partialPhaseDuration` is **C4 − C1** and `centralPhaseDuration` is **C3 − C2**, both in **seconds** when both respective contacts exist. `shadowPathWidthKm` is the central-shadow chord across the observer's location on a spherical Earth, in **km**; it can be absent and is not necessarily the width on the central line.

## Local view and related searches

`computeLocalSolarEclipseViewGeometry` returns plain SVG-oriented shapes, not markup or labels. By default it selects `MAX`, uses a **450 × 160** pixel canvas with a **34 px** solar radius, puts zenith up and east right, and includes ghost Moon disks and the horizon. `orientationMode: 'north'` puts celestial north up; `handedness: 'eastLeft'` mirrors the horizontal axis. If the requested contact is absent, `selectedEvent` reports the event actually drawn. Shape coordinates are SVG pixels, with X right and Y down.

`listLocalSolarEclipses` walks a time range **(start, end]** and returns geometrically relevant eclipses with reusable fitted elements; it does not filter by horizon visibility. `computeGreatestEclipseCircumstances` and `computeGreatestDurationCircumstances` instead locate distinguished points on the eclipse path. Those points need not be the caller's site or coincide with each other. Their central-path widths and durations may be `undefined` where no central phase is available.

## Accuracy and limits

The local contact search starts within **±3.5 hours** of the Besselian maximum, samples at **60 seconds**, and can expand to **±5 hours** for missing contacts. The fit itself uses a shorter interval, so contacts far outside it should not be extrapolated as reliable circumstances. A grazing contact or incomplete event set may leave a contact or duration undefined. The results depend on the supplied Sun/Moon provider, Besselian fit, and horizon threshold; no universal contact-time accuracy is implied.

See [Solar Eclipse Search and Classification]({% link astronomy/solar-eclipse-search-and-classification.md %}) for candidate eclipses and the global type. The local diagram describes eclipse disks; [Planetary Disk Transits]({% link astronomy/planetary-disk-transits.md %}) solves a different apparent-disk event.
