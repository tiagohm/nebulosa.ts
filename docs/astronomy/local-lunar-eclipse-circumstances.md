---
title: Local Lunar Eclipse Circumstances
layout: default
parent: Astronomy
nav_order: 570
description: Classifies lunar-eclipse visibility, local Moon angles, observable duration, and diagram geometry at a site.

doc_kind: topic

sources:
    - src/astronomy/events/eclipse/lunar/local.ts

api:
    - computeLocalLunarEclipseCircumstances
    - computeLocalLunarEclipseViewGeometry
    - listLocalLunarEclipses
    - moonAltitudeAt
    - localLunarVisibilityText
    - LocalLunarEclipseCircumstances
    - LocalLunarEclipseCircumstancesOptions
    - LocalLunarEclipseEvent
    - LocalLunarEclipseViewOptions
    - LocalLunarEclipseViewGeometry
    - LocalLunarEclipseListEntry
---

# Local Lunar Eclipse Circumstances

`computeLocalLunarEclipseCircumstances` adds one observer's horizon visibility, topocentric Moon position, and view angles to a **global** lunar eclipse. It also estimates how long the Moon is above the selected horizon during the eclipse. A separate function builds SVG-ready Moon and shadow geometry.

## Basic usage

```ts
import { nearestLunarEclipse } from '../src/astronomy/bodies/moon';
import { sunMoonPosition } from '../src/astronomy/events/eclipse/eclipse';
import { computeLocalLunarEclipseCircumstances, computeLocalLunarEclipseViewGeometry } from '../src/astronomy/events/eclipse/lunar/local';
import { timeYMD } from '../src/astronomy/time/time';
import { deg } from '../src/math/units/angle';

const eclipse = nearestLunarEclipse(timeYMD(2025, 3, 1), true);
const circumstances = computeLocalLunarEclipseCircumstances(eclipse, deg(-106.4), deg(35), sunMoonPosition);
const diagram = computeLocalLunarEclipseViewGeometry(circumstances, eclipse);
console.log(eclipse.type, circumstances.visibility.kind, circumstances.events.MAX?.observable, diagram.selectedEvent);
// TOTAL completelyVisible true MAX
```

Longitude is **east-positive** and latitude is **geodetic**, in radians. The required Sun/Moon provider supplies compatible geocentric equatorial coordinates and distances in Earth equatorial radii; the included `sunMoonPosition` supplies apparent positions. The supplied `LunarEclipse` holds the contact instants and global shadow geometry. The local function does not search for new contact times.

## Contacts and local measurements

The `events` object contains the contacts available for the eclipse type: `P1`, `U1`, `U2`, `MAX`, `U3`, `U4`, and `P4` for a total eclipse, with umbral or totality contacts absent for partial or penumbral cases as appropriate. Those contact times are **TT** and are shared by observers; the site's location changes the `observable` flag and the measured angles. The Moon's `altitude` and `azimuth` are **topocentric**, include diurnal parallax, and are in radians. Azimuth runs from **north through east** in **[0, 2π)**.

At P1/P4 and U1/U4, `positionAngle` is the lunar-limb contact direction toward the geocentric shadow center, measured from celestial north toward east in **[0, 2π)**. At a total eclipse's U2/U3 internal contacts it points the opposite way; at `MAX` it uses the shadow-center direction. `zenithAngle` rotates the corresponding direction into the observer's zenith frame using the topocentric parallactic angle. Both are in radians. Event `umbralMagnitude` and `penumbralMagnitude` come from the global shadow model at that event, not from site-dependent contact timing.

`horizonAltitude` is an angular visibility threshold, defaulting to **0 radians**. The code compares it with the Moon's topocentric center altitude; it does not apply an atmospheric-refraction or terrain model. `altitudeSamples` defaults to **48** intervals across P1–P4. The scan can detect an above-horizon interval even when every named contact lies below the threshold. `visibility.kind` distinguishes no eclipse, an eclipse wholly below the horizon, penumbral-only visibility, umbral partial visibility, visible totality, and complete visibility through the entire penumbral interval.

`details.penumbralPhaseDuration` (**P4 − P1**), `partialPhaseDuration` (**U4 − U1**), and `totalPhaseDuration` (**U3 − U2**) are in **seconds**; the latter two are absent if those contacts do not exist. `observableDuration` is the estimated number of seconds above the selected horizon within P1–P4. The global phase durations are not shortened to the site's visible portion.

## Local view and eclipse lists

`computeLocalLunarEclipseViewGeometry` returns plain circles, lines, paths, and polygons for SVG rendering, without labels or UI. Defaults are a **300 × 300** pixel diagram, `MAX` selected, zenith up, east right, **70 px** umbral radius, ghost Moon disks, and a horizon. `orientationMode: 'north'` puts celestial north up; `handedness: 'eastLeft'` mirrors the horizontal axis. Pass the **same `horizonAltitude`** used for the circumstances when drawing an obstructed horizon, so the displayed horizon agrees with event observability.

`listLocalLunarEclipses` searches **(start, end]** by global maximum time, in TT, and returns only eclipses whose penumbral phase is observable at the site. Each entry includes the `LunarEclipse` and its already-computed local circumstances. A lunar eclipse can be geometrically real but absent from this site-filtered list when the Moon stays below the threshold.

For a single instant without an eclipse, `moonAltitudeAt` computes the Moon's topocentric center altitude in radians from the same kind of provider and site coordinates.

## Accuracy and limits

Contact times and shadow magnitudes inherit the Meeus lunar-eclipse model in the supplied `LunarEclipse`. Local altitude depends on the Sun/Moon provider, ΔT, the topocentric parallax calculation, and the horizon threshold. The sampling controls and horizon refinements estimate observable duration; they are not a uniform timing guarantee for a grazing moonrise or moonset. This is a local view of a lunar eclipse, not a ground shadow track like [Solar Eclipse Besselian Geometry]({% link astronomy/solar-eclipse-besselian-geometry.md %}).
