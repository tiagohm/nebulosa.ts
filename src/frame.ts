import { clone, identity, mul, rotX, type MutMat3 } from './matrix'
import { precessionNutation, trueObliquity, type Time } from './time'

// Reference frame of the Earth's mean equator and equinox at B1950.
export function b1950Frame(): MutMat3 {
	return [0.99992570795236291, 0.011178938126427691, 0.0048590038414544293, -0.011178938137770135, 0.9999375133499887, -2.715792625851078e-5, -0.0048590038153592712, -2.7162594714247048e-5, 0.9999881946023742]
}

// Ecliptic coordinates based upon the B1950 frame.
export function eclipticB1950Frame(): MutMat3 {
	return [0.99992570795236291, 0.011178938126427691, 0.0048590038414544293, -0.012189277138214926, 0.91736881787898283, 0.39785157220522011, -9.9405009203520217e-6, -0.3978812427417045, 0.91743692784599817]
}

// Ecliptic coordinates based upon the J2000 frame.
export function eclipticJ2000Frame(): MutMat3 {
	return [1, 0, 0, 0, 0.917482137086962521575615807374, 0.397776982901650696710316869067, 0, -0.397776982901650696710316869067, 0.917482137086962521575615807374]
}

// The FK4 referenceframe is derived from the [B1950] frame by
// applying the equinox offset determined by Fricke.
export function fk4Frame(): MutMat3 {
	return [0.9999256809514446605, 0.011181371756303229, 0.0048589607363144413, -0.011181372206268162, 0.999937486137318374, -0.000027073328547607, -0.0048589597008613673, -0.0000272585320447865, 0.9999881948141177111]
}

// The FK5 is an equatorial coordinate system(coordinate system linked to the Earth)
// based on its J2000 position. As any equatorial frame, the FK5-based follows
// the long-term Earth motion (precession).
export function fk5Frame(): MutMat3 {
	return [0.9999999999999928638, -0.0000001110223329741, -0.000000044118044981, 0.0000001110223372305, 0.9999999999999891831, 0.0000000964779225408, 0.0000000441180342698, -0.0000000964779274389, 0.9999999999999943728]
}

// Galactic System reference frame.
export function galacticFrame(): MutMat3 {
	return [-0.0548756577126196781, -0.8734370519557791298, -0.4838350736164183803, 0.4941094371971076412, -0.4448297212220537635, 0.7469821839845094133, -0.8676661375571625615, -0.1980763372750705946, 0.4559838136911523476]
}

// Supergalactic System reference frame.
export function supergalacticFrame(): MutMat3 {
	return [0.3750155557060191496, 0.3413588718572082374, 0.8618801851666388868, -0.8983204377254853439, -0.0957271002509969235, 0.4287851600069993011, 0.2288749093788964371, -0.9350456902643365859, 0.2707504994914917474]
}

// The dynamical frame of the Earth's true equator and equinox of date.
export function trueEquatorAndEquinoxOfDateFrame(time: Time): MutMat3 {
	return clone(precessionNutation(time))
}

// The International Celestial Reference System (ICRS).
export function icrs(): MutMat3 {
	return identity()
}

// Ecliptic coordinates at time.
export function eclipticFrame(time: Time): MutMat3 {
	const ecliptic = identity()
	return mul(rotX(-trueObliquity(time), ecliptic), precessionNutation(time), ecliptic)
}
