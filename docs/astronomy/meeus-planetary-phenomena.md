---
title: Meeus Planetary Phenomena
layout: default
parent: Astronomy
nav_order: 410
description: Estimates selected planetary conjunctions, oppositions, Mercury elongations, and a Mars station from Meeus chapter 36 tables.

doc_kind: topic

sources:
    - src/astronomy/ephemeris/meeus.ts

api:
    - Planetary
---

# Meeus Planetary Phenomena

`Planetary` estimates selected conjunctions, oppositions, greatest elongations, and a station with the periodic formulas of Meeus chapter 36. Use these year-based estimates to find a likely event date without evaluating an orbit or searching a continuous ephemeris. Results are numeric **TT Julian ephemeris days (JDE)**; they are not observer-specific event times.

## Basic usage

```ts
import { Planetary } from '../src/astronomy/ephemeris/meeus';
import { toDeg } from '../src/math/units/angle';

const mercuryConjunctionJde = Planetary.mercuryInfConj(1993.75);
const [elongationJde, elongationRadians] = Planetary.mercuryWestElongation(1993.9);
const marsOppositionJde = Planetary.marsOpp(2026);
console.log(mercuryConjunctionJde, elongationJde, toDeg(elongationRadians), marsOppositionJde);
```

Each function takes a **decimal year** near the desired event. The implementation rounds that year to the nearest cycle of the event's table, then applies periodic corrections. The returned event can therefore fall outside the named calendar year, especially when the input is near a year boundary. Pass another year or a nearby fractional year to select a neighboring cycle.

## Available events

| Event                                          | Functions                                            | Return                                  |
| ---------------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| Mercury conjunction                            | `mercuryInfConj`, `mercurySupConj`                   | TT JDE                                  |
| Venus inferior conjunction                     | `venusInfConj`                                       | TT JDE                                  |
| Mars opposition                                | `marsOpp`                                            | TT JDE                                  |
| Jupiter, Saturn, Uranus, Neptune opposition    | `jupiterOpp`, `saturnOpp`, `uranusOpp`, `neptuneOpp` | TT JDE                                  |
| Saturn conjunction                             | `saturnConj`                                         | TT JDE                                  |
| Mercury greatest eastern or western elongation | `mercuryEastElongation`, `mercuryWestElongation`     | Fresh `[TT JDE, elongation in radians]` |
| Mars second station                            | `marsStation2`                                       | TT JDE                                  |

The elongation angle is a positive angular separation from the Sun; the function name supplies the eastern or western side. The two-element result is an array, while the other listed event functions return a single number. The helper functions `mean`, `sum`, `ms`, `sumA`, and `msa` expose the same table calculations for callers supplying coefficient arrays; ordinary event lookup uses the named functions above.

## Model and limitations

The implementation uses Meeus chapter 36 mean-event coefficients and periodic terms, including additional-angle terms for outer planets. It evaluates tables from the supplied year; it does not calculate planetary positions, solve a conjunction or opposition from an ephemeris, or account for an observing location. Its coverage is the events in the table above, so it does not offer every planet and event combination.

The chapter formulas are estimates. The implementation does not attach an uncertainty or a supported accuracy interval to a result. For a result tied to a particular ephemeris, an observer, or a guaranteed search window, use a suitable ephemeris and event-search workflow. Convert the TT JDE to the desired time scale before displaying a civil timestamp.

## Related topics

- [Meeus Geocentric Planet Positions]({% link astronomy/meeus-geocentric-planet-positions.md %}) describes the planetary position model available to other event calculations.
- [Meeus Apsis and Node Passages]({% link astronomy/meeus-apsis-and-node-passages.md %}) documents a separate family of chapter-style orbital events.
- [Meeus Calendar]({% link astronomy/meeus-calendar.md %}) covers calendar labels for numeric JDE.
