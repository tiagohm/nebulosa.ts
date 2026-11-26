import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import { applyEquatorialPointingError, applyPolarAxisRotation, applySkyOffset, IDENTITY_EQUATORIAL_POINTING_MODEL, tubePositionAngle } from '../../../astronomy/coordinates/pointing'
import { type Angle, normalizeAngle } from '../../../math/units/angle'
import type { PierSide } from '../device'
import { MOUNT_TRAJECTORY_CAPACITY } from './constants'
import type { MountAlignment } from './mount.alignment'
import type { MountFlexure } from './mount.flexure'
import type { MountMechanics } from './mount.mechanics'
import type { MountPeriodicError } from './mount.periodic'
import type { MountSite } from './mount.site'
import type { MountTracking } from './mount.tracking'
import { boresightHistory, clearBoresightHistory, recordBoresightSample, sampleBoresightTrajectory } from './mount.trajectory'
import type { MountWind } from './mount.wind'

// Boresight circuit of the simulated mount: the optical chain from where the axes mechanically point
// to where the optical axis really points, the orientation of the tube, and the record of where the
// axis went that a camera integrates an exposure over. Angles are radians in the equatorial frame of
// date; times are milliseconds on the simulated clock.
//
// The chain, in order: the cone and non-perpendicularity act between the axes and the tube, in the
// mount's own frame; the polar axis carries that whole frame onto the sky; flexure bends the tube under
// gravity, by the side of the pier; the worm adds its periodic error; the drift of the drive and the
// residual of the home sensor are added; the wind deflects the axis along the sky.

// Circuits whose state the chain reads.
export interface MountBoresightCircuits {
	readonly site: MountSite
	readonly alignment: MountAlignment
	readonly flexure: MountFlexure
	readonly periodicError: MountPeriodicError
	readonly tracking: MountTracking
	readonly mechanics: MountMechanics
	readonly wind: MountWind
}

// Optical axis of the mount and its recorded trajectory.
export class MountBoresight {
	// Rolling record of where the optical axis pointed.
	readonly #history = boresightHistory(MOUNT_TRAJECTORY_CAPACITY)
	// Scratch tuple of the chain, reused because it runs on every tick.
	readonly #scratch: [Angle, Angle] = [0, 0]

	// `circuits` are read by the chain; `mechanical` gives the orientation of the axes.
	constructor(
		readonly circuits: MountBoresightCircuits,
		readonly mechanical: () => Readonly<EquatorialCoordinate>,
	) {}

	// Where the optical axis points with the axes at their current orientation on `pierSide`, the
	// sidereal angle taken at `time`. The declination is left unclamped: a polar error pushing it past
	// the pole is a real, if degenerate, configuration.
	at(time: number, pierSide: PierSide): EquatorialCoordinate {
		const { site, alignment, flexure, periodicError, tracking, mechanics, wind } = this.circuits
		const { rightAscension: mechanicalRightAscension, declination: mechanicalDeclination } = this.mechanical()
		const model = alignment.pointingModel
		const rotation = alignment.polarRotation(site.latitude)
		let rightAscension = mechanicalRightAscension
		let declination = mechanicalDeclination

		if (model !== IDENTITY_EQUATORIAL_POINTING_MODEL || rotation !== undefined || flexure.active) {
			const lst = site.siderealTimeAt(time)
			if (model !== IDENTITY_EQUATORIAL_POINTING_MODEL) [rightAscension, declination] = applyEquatorialPointingError(rightAscension, declination, lst, model)
			if (rotation !== undefined) [rightAscension, declination] = applyPolarAxisRotation(rightAscension, declination, lst, rotation)
			if (flexure.active) [rightAscension, declination] = flexure.apply(rightAscension, declination, lst, site.latitude, pierSide, this.#scratch)
		}

		// Held constant over a step: over the fraction of a second a caller extrapolates by, none of these
		// moves anything measurable.
		rightAscension += periodicError.error + tracking.offset + mechanics.homeScatterRightAscension
		declination += mechanics.homeScatterDeclination

		// The wind is an east and north angle on the sky, so it turns the axis along the tangent plane;
		// dividing east by the cosine of the declination would lose it at a pole.
		if (wind.state.rightAscension !== 0 || wind.state.declination !== 0) {
			;[rightAscension, declination] = applySkyOffset(rightAscension, declination, wind.state.rightAscension, wind.state.declination, this.#scratch)
		}

		return { rightAscension: normalizeAngle(rightAscension), declination }
	}

	// Position angle of the tube's up direction at the boresight, radians east of north in the frame of
	// date, at `time` with the tube on `pierSide`. The tube, and a camera fixed to it, turns with the
	// right-ascension axis about the mount's own axis, and half a revolution across a flip.
	orientation(time: number, pierSide: PierSide): Angle {
		const { site, alignment } = this.circuits
		const { rightAscension, declination } = this.mechanical()
		const boresight = this.at(time, pierSide)
		return tubePositionAngle(rightAscension, declination, site.siderealTimeAt(time), pierSide === 'WEST', boresight.rightAscension, boresight.declination, alignment.polarRotation(site.latitude))
	}

	// Appends where the optical axis points with the tube on `pierSide` under `time`. A sample at an
	// instant already recorded is appended after it, keeping a configuration jump as a discontinuity.
	record(time: number, pierSide: PierSide) {
		const { rightAscension, declination } = this.at(time, pierSide)
		recordBoresightSample(this.#history, time, rightAscension, declination)
	}

	// Drops the record and seeds it with the present, wherever the recorded past stops describing this
	// telescope: connecting, syncing and setting the clock the samples are indexed by.
	reset(time: number, pierSide: PierSide) {
		clearBoresightHistory(this.#history)
		this.record(time, pierSide)
	}

	// Writes `count` boresight right ascension and declination pairs, evenly spaced over
	// [`startTime`, `endTime`], into `out`, returning how many were written; 0 before anything was
	// recorded. Read from the record, because backlash, stiction and the guide queue have no closed
	// form to run backwards.
	sample(startTime: number, endTime: number, count: number, out: Float64Array) {
		return sampleBoresightTrajectory(this.#history, startTime, endTime, count, out)
	}
}
