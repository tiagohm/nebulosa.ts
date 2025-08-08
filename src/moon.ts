import { ASEC2RAD, AU_KM, MOON_SINODIC_DAYS } from './constants'
import type { Distance } from './distance'
import type { Time } from './time'

export enum LunationSystem {
	BROWN,
	MEEUS,
	GOLDSTINE,
	HEBREW,
	ISLAMIC,
	THAI,
}

// Computes the parallax of the Moon at a given distance
export function moonParallax(distance: Distance) {
	return Math.asin(6378.14 / AU_KM / distance)
}

// Computes the semi-diameter of the Moon at a given distance
export function moonSemidiameter(distance: Distance) {
	return ((358473400 / AU_KM) * ASEC2RAD) / distance
}

// Computes the lunation number for a given time and system
export function lunation(time: Time, system: LunationSystem = LunationSystem.BROWN) {
	// The first New Moon of 2000 (6th January, ~ 18:14 UTC)
	const LN = Math.round((time.day - 2451550 + (time.fraction - 0.25972)) / MOON_SINODIC_DAYS - 0.25) || 0

	if (system === LunationSystem.MEEUS) return LN
	else if (system === LunationSystem.GOLDSTINE) return LN + 37105
	else if (system === LunationSystem.HEBREW) return LN + 71234
	else if (system === LunationSystem.ISLAMIC) return LN + 17038
	else if (system === LunationSystem.THAI) return LN + 16843
	else return LN + 953
}
