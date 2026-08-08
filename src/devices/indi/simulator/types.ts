import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import type { AstronomicalImageStar } from '../../../imaging/synthetic/generator'
import type { Angle } from '../../../math/units/angle'
import { makeBlobVector, makeLightVector, makeNumberVector, makeSwitchVector, makeTextVector } from '../types'

// Public contracts shared by the in-process INDI device simulators.

// Whether an On Coord Set selects a slew-to or sync-to operation.
export type CoordSetMode = 'SLEW' | 'SYNC'

// Kind of automatic slew in progress.
export type SlewMode = 'GOTO' | 'HOME' | 'PARK'

// Manual-motion direction on one axis (-1, 0, +1).
export type AxisDirection = -1 | 0 | 1

// Image transfer/storage format produced by the camera simulator.
export type TransferFormat = 'FITS' | 'XISF'

// Camera readout mode: monochrome or colour.
export type ReadoutMode = 'MONO' | 'RGB'

// Star-field source for synthetic frames: the built-in 'RANDOM' generator or a named catalog source.
export type CatalogSourceType = 'RANDOM' | (string & {})

// Any property vector a simulator can own.
export type SimulatorProperty = ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector> | ReturnType<typeof makeTextVector> | ReturnType<typeof makeLightVector> | ReturnType<typeof makeBlobVector>

// A catalog star with sky coordinates instead of pixel coordinates.
export type CatalogSourceStar = Omit<AstronomicalImageStar, 'x' | 'y'> & Readonly<EquatorialCoordinate>

// Provides stars within a cone (RA, Dec, radius in radians) to render into a synthetic frame.
export type CatalogSource = (rightAscension: Angle, declination: Angle, radius: Angle) => PromiseLike<readonly CatalogSourceStar[]> | readonly CatalogSourceStar[]

// The three distinct directions a mount has at any instant, all in the equatorial frame of date.
//
// Keeping them apart is what makes guiding physically coherent: a correction acts on the mechanical
// axes, while a pointing error keeps reappearing in the boresight as residual drift. Collapsed into a
// single coordinate, a correction and the error it should cancel live in different spaces and never
// meet.
export interface MountPointingState {
	// Coordinate the controller believes it is pointing at, and the one published over INDI. Differs
	// from the mechanical orientation by whatever offset the last sync established.
	readonly reported: Readonly<EquatorialCoordinate>
	// True orientation of the mechanical axes, which is what tracking, slewing and guiding move.
	readonly mechanical: Readonly<EquatorialCoordinate>
	// Direction the optical axis really points, after the geometric pointing model and the periodic
	// error. This is what a camera images and what a plate solve would recover.
	readonly boresight: Readonly<EquatorialCoordinate>
}

// Persistence hooks shared by all simulators for saving/loading property snapshots.
export interface DeviceSimulatorOptions {
	readonly save?: (name: string, properties: readonly SimulatorProperty[]) => void
	readonly load?: (name: string) => PromiseLike<readonly SimulatorProperty[]> | readonly SimulatorProperty[]
}
