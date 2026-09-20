import { ELLIPSOID_PARAMETERS } from '../../core/constants'
import { matMulVec } from '../../math/linear-algebra/mat3'
import type { Vec3 } from '../../math/linear-algebra/vec3'
import { intersectSegmentEllipsoid } from '../../math/numerical/geometry'
import { Ellipsoid } from '../observer/location'
import { gcrsToItrsRotationMatrix, type Time } from '../time/time'

// Solid-Earth occultation of a finite geocentric target by a selected reference ellipsoid.
// Input positions are AU in GCRS/ICRS-oriented axes at the same reception time; the result describes
// the closed observer-to-target segment in ITRS. No atmosphere, terrain, or solar shadow is modeled.

// Contact of a finite target's line of sight with the solid Earth.
export interface EarthOccultation {
	// Whether the closed observer-to-target segment touches or enters the ellipsoid.
	readonly occulted: boolean
	// First contact along observer + t * (target - observer), with t in [0, 1].
	readonly intersection?: number
	// Whether the contact is tangent within coefficient-scaled numerical tolerance.
	readonly tangent: boolean
}

// Tests a finite geocentric target against the Earth ellipsoid at reception time.
// Both positions use AU and GCRS/ICRS-oriented axes; the ellipsoid defaults to IERS2010.
// The observer must be outside the solid Earth. A surface contact counts as occultation.
export function earthOccultation(observer: Vec3, target: Vec3, time: Time, ellipsoid: Ellipsoid = Ellipsoid.IERS2010): EarthOccultation {
	const rotation = gcrsToItrsRotationMatrix(time)
	const observerItrs = matMulVec(rotation, observer)
	const targetItrs = matMulVec(rotation, target)
	const { radius, oneMinusFlattening } = ELLIPSOID_PARAMETERS[ellipsoid]
	const contact = intersectSegmentEllipsoid(observerItrs, targetItrs, radius, radius * oneMinusFlattening)
	return { occulted: contact.intersects, intersection: contact.intersection, tangent: contact.tangent }
}
