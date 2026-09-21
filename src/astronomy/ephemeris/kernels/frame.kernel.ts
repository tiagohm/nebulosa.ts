import { ASEC2RAD, DEG2RAD } from '../../../core/constants'
import { type Mat3, matIdentity, matMul, matMulTranspose, type MutMat3, matRotX, matRotY, matRotZ, matZero, matIsIdentity } from '../../../math/linear-algebra/mat3'
import { type Distance, kilometer } from '../../../math/units/distance'
import { ICRS, type Frame } from '../../coordinates/frame'
import type { Time } from '../../time/time'
import type { Pck } from './pck'
import type { SpiceKernelPool } from './text.kernel'

// Planetary-frame resolution from loaded FK/PCK text kernels and binary PCK segments.
// Looks up frames by SPICE name or integer id, chains class-4 TK frames (MATRIX and ANGLES)
// onto class-2 binary PCK orientation, and exposes the result as the existing Frame contract
// (base → body-fixed, with analytic W = dR/dt·Rᵀ per day). J2000 (id 1) is the library base.
// Body radii come from text-PCK `BODY{id}_RADII` values in km, returned in AU.

// NAIF integer id of the J2000 inertial frame, treated as the library base (identity).
const J2000_FRAME_ID = 1

// Tri-axial body radii from a text PCK, in AU, in the kernel's (x, y, z) order.
export interface BodyRadii {
	// X (typically equatorial) radius, in AU.
	readonly x: Distance
	// Y (typically equatorial) radius, in AU.
	readonly y: Distance
	// Z (typically polar) radius, in AU.
	readonly z: Distance
}

// Reads `BODY{body}_RADII` from `pool` and converts kilometres to AU.
// Returns undefined when the variable is missing or has fewer than three numbers.
export function bodyRadii(pool: SpiceKernelPool, body: number): BodyRadii | undefined {
	const radii = pool.numbers(`BODY${body}_RADII`)
	if (!radii || radii.length < 3) return undefined

	return {
		x: kilometer(radii[0]),
		y: kilometer(radii[1]),
		z: kilometer(radii[2]),
	}
}

// Resolves SPICE planetary frames from an explicit kernel pool and optional binary PCK.
export class SpiceFrames {
	readonly #pool: SpiceKernelPool
	readonly #pck?: Pck
	readonly #frames = new Map<number, Frame>()

	// Binds this resolver to `pool` and, when given, the binary PCK that backs class-2 frames.
	constructor(pool: SpiceKernelPool, pck?: Pck) {
		this.#pool = pool
		this.#pck = pck
	}

	// Returns the Frame for a SPICE frame name or integer id.
	// Class-2 chains initialize their PCK segment before the promise resolves so
	// rotationAt/dRdtTimesRtAt are then ordinary synchronous Frame methods.
	async frame(nameOrId: string | number): Promise<Frame> {
		return await this.#resolve(this.#frameId(nameOrId), new Set())
	}

	// Maps a name to FRAME_{name} or accepts an integer id. J2000 is built in.
	#frameId(nameOrId: string | number) {
		if (typeof nameOrId === 'number') return nameOrId

		const name = nameOrId.toUpperCase()
		if (name === 'J2000') return J2000_FRAME_ID

		const values = this.#pool.numbers(`FRAME_${name}`)
		if (!values?.length) throw new Error(`unknown frame: ${nameOrId}`)
		return values[0]
	}

	// Resolves `id` with cycle detection, caching completed frames by integer id.
	async #resolve(id: number, visiting: Set<number>): Promise<Frame> {
		const cached = this.#frames.get(id)
		if (cached !== undefined) return cached

		if (id === J2000_FRAME_ID) {
			this.#frames.set(id, ICRS)
			return ICRS
		}

		if (visiting.has(id)) {
			throw new Error(`cyclic frame definition: ${id}`)
		}

		visiting.add(id)

		const frameClass = kernelNumber(this.#pool, `FRAME_${id}_CLASS`)
		if (frameClass === undefined) {
			throw new Error(`unknown frame: ${id}`)
		}

		const classId = kernelNumber(this.#pool, `FRAME_${id}_CLASS_ID`) ?? id
		let frame: Frame

		if (frameClass === 1) {
			throw new Error(`unsupported inertial frame ${id}`)
		} else if (frameClass === 2) {
			frame = await this.#class2(id, classId)
		} else if (frameClass === 4) {
			frame = await this.#class4(id, classId, visiting)
		} else {
			throw new Error(`unsupported frame class ${frameClass} for frame ${id}`)
		}

		visiting.delete(id)
		this.#frames.set(id, frame)
		return frame
	}

	// Builds a class-2 frame from the binary PCK segment whose class id is `classId`.
	async #class2(id: number, classId: number): Promise<Frame> {
		const segment = this.#pck?.segment(classId)
		if (!segment) throw new Error(`missing binary PCK segment for frame ${id}`)
		if (segment.inertialFrameId !== J2000_FRAME_ID) throw new Error(`PCK inertial frame ${segment.inertialFrameId} is not J2000`)
		await segment.initialize()
		return segment
	}

	// Builds a class-4 TK frame: a constant MATRIX or ANGLES rotation relative to another frame.
	async #class4(id: number, classId: number, visiting: Set<number>): Promise<Frame> {
		const spec = this.#tkString(classId, id, 'SPEC')
		if (!spec) throw new Error(`missing TKFRAME spec for frame ${id}`)

		const relativeName = this.#tkString(classId, id, 'RELATIVE')
		if (!relativeName) throw new Error(`missing TKFRAME relative frame for frame ${id}`)

		const relativeId = this.#frameId(relativeName)
		const relative = await this.#resolve(relativeId, visiting)
		const specKind = spec.toUpperCase()

		if (specKind === 'MATRIX') {
			const values = this.#tkNumbers(classId, id, 'MATRIX')
			if (!values || values.length < 9) throw new Error(`missing TKFRAME matrix for frame ${id}`)
			const matrix = values as MutMat3
			if (matIsIdentity(matrix)) return relative
			return tkFrame(relative, matrix)
		}

		if (specKind === 'ANGLES') {
			return tkFrame(relative, this.#tkAngleMatrix(id, classId))
		}

		throw new Error(`unsupported TKFRAME spec: ${spec}`)
	}

	// Constant rotation from TKFRAME ANGLES/AXES/UNITS, left-multiplied in listed order.
	#tkAngleMatrix(id: number, classId: number): MutMat3 {
		const angles = this.#tkNumbers(classId, id, 'ANGLES')
		const axes = this.#tkNumbers(classId, id, 'AXES')
		const units = this.#tkString(classId, id, 'UNITS')

		if (!angles?.length || !axes?.length || angles.length !== axes.length) throw new Error(`missing TKFRAME angles for frame ${id}`)
		if (!units) throw new Error(`missing TKFRAME units for frame ${id}`)

		const scale = tkAngleScale(units)
		const matrix = matIdentity()

		for (let i = 0; i < angles.length; i++) {
			// NAIF/Skyfield left-multiply active-sense rotations; matRot* is the
			// transpose convention, so the kernel angle is applied with opposite sign.
			const angle = -angles[i] * scale
			const axis = axes[i]
			if (axis === 1) matRotX(angle, matrix)
			else if (axis === 2) matRotY(angle, matrix)
			else if (axis === 3) matRotZ(angle, matrix)
			else throw new Error(`unsupported TKFRAME axis ${axis} for frame ${id}`)
		}

		return matrix
	}

	// TKFRAME_{classId|id}_{suffix} string, preferring the class id as NAIF does.
	#tkString(classId: number, frameId: number, suffix: string) {
		return kernelString(this.#pool, `TKFRAME_${classId}_${suffix}`) ?? kernelString(this.#pool, `TKFRAME_${frameId}_${suffix}`)
	}

	// TKFRAME_{classId|id}_{suffix} numbers, preferring the class id.
	#tkNumbers(classId: number, frameId: number, suffix: string) {
		return this.#pool.numbers(`TKFRAME_${classId}_${suffix}`) ?? this.#pool.numbers(`TKFRAME_${frameId}_${suffix}`)
	}
}

// First numeric assignment of `name`, or undefined when missing.
function kernelNumber(pool: SpiceKernelPool, name: string) {
	const values = pool.numbers(name)
	return values?.length ? values[0] : undefined
}

// First string assignment of `name`, or undefined when missing.
function kernelString(pool: SpiceKernelPool, name: string) {
	const values = pool.strings(name)
	return values?.length ? values[0] : undefined
}

// Radians per unit for a TKFRAME_UNITS value.
function tkAngleScale(units: string) {
	switch (units.toUpperCase()) {
		case 'RADIANS':
			return 1
		case 'DEGREES':
			return DEG2RAD
		case 'ARCSECONDS':
			return ASEC2RAD
		default:
			throw new Error(`unsupported TKFRAME units: ${units}`)
	}
}

// Constant TK rotation `matrix` (relative → this) composed with a relative Frame.
// R = M · R_rel; W = M · W_rel · Mᵀ when the relative frame rotates.
function tkFrame(relative: Frame, matrix: Mat3): Frame {
	const w: MutMat3 = matZero()

	const rotationAt = (time: Time) => matMul(matrix, relative.rotationAt(time))

	if (!relative.dRdtTimesRtAt) {
		return { rotationAt }
	}

	return {
		rotationAt,
		dRdtTimesRtAt: (time) => {
			matMul(matrix, relative.dRdtTimesRtAt!(time), w)
			return matMulTranspose(w, matrix)
		},
	}
}
