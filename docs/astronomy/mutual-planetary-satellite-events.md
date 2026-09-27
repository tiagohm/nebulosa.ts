---
title: Mutual Planetary-Satellite Events
layout: default
parent: Astronomy
nav_order: 460
description: Finds mutual occultations and eclipses among major Jovian and Saturnian moons.

doc_kind: topic

sources:
    - src/astronomy/events/mutual.ts

api:
    - galileanMutualEvents
    - saturnianMutualEvents
    - MutualEvent
    - MutualEventKind
    - GalileanMoon
    - SaturnianMoon
---

# Mutual Planetary-Satellite Events

`galileanMutualEvents` and `saturnianMutualEvents` find when one major moon passes in front of another as seen from Earth, or casts a shadow on it. Use them to identify mutual-event seasons and obtain the participating moons, contact times, and centrality of each modeled event.

## Basic usage

```ts
import { galileanMutualEvents } from '../src/astronomy/events/mutual';
import { timeYMDHMS, Timescale } from '../src/astronomy/time/time';

const start = timeYMDHMS(2026, 12, 5, 18, 0, 0, Timescale.UTC);
const stop = timeYMDHMS(2026, 12, 5, 21, 0, 0, Timescale.UTC);
const events = galileanMutualEvents(start, stop);
console.log(events.length, events[0]?.kind, events[0]?.front, events[0]?.back);
// 1 occultation europa ganymede
```

The Jupiter function searches all pairs of **Io, Europa, Ganymede, and Callisto**. The Saturn function searches pairs of **Mimas, Enceladus, Tethys, Dione, Rhea, Titan, and Iapetus**. The functions use internal satellite theories (L1.2 for Jupiter, TASS 1.7 for Saturn), VSOP87E positions for the planets and Earth, and built-in mean moon radii; callers supply a `Time` window, not ephemeris callbacks.

## Interpreting an event

For `kind: 'occultation'`, `front` is the moon nearer Earth and `back` is the one behind it. The pair is tested using their separately light-time-corrected **geocentric directions** and the sum of their angular radii. For `kind: 'eclipse'`, `front` is the moon casting the shadow and `back` is the shadowed moon. Eclipse geometry is evaluated at the physical instant using the Sun, caster, and shadowed body; an overlap with the modeled **penumbral** shadow qualifies. The eclipse times are then shifted by light travel time from the shadowed moon to Earth. These are geocentric events, without a particular observing site or horizon test.

`MutualEvent.middle` is the modeled minimum-separation instant. `start` and `end` are the first and last contacts when found inside the requested window; a contact outside it is `undefined`. Events overlapping a window can be returned even when `middle` falls just outside it, so compare the contact fields as well as `middle`. Results are sorted by `middle`. `impactParameter` is the minimum separation divided by the relevant contact-limit separation: **0** is central and values approaching **1** graze the limit. The ratio is dimensionless; occultation separations are angular, while eclipse shadow offsets are linear.

## Accuracy and limits

The optional `step` is the coarse minimum-search spacing in **days**, defaulting to **10 minutes**; `tolerance` is a numerical refinement tolerance in **days**. Events with a brief separation minimum can be missed if the step is too broad. Contacts are sought around each sampled minimum, and the result does not include a light curve, obscured-area fraction, magnitude drop, or an umbral-versus-penumbral classification. Predictions depend on the satellite theories, planet ephemerides, physical radii, and sampling; no uniform event-timing accuracy is guaranteed.

These mutual eclipses concern one moon shadowing another. [Lunar Eclipse Search]({% link astronomy/lunar-eclipse-search.md %}) models Earth's shadow on the Moon, while [Stellar and Asteroidal Occultations]({% link astronomy/stellar-and-asteroidal-occultations.md %}) screens a finite body against a fixed star from one site.
