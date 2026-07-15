import type { EquatorialCoordinate } from '../../../astronomy/coordinates/coordinate'
import type { AstronomicalImageStar } from '../../../imaging/synthetic/generator'
import type { Angle } from '../../../math/units/angle'
import { makeBlobVector, makeNumberVector, makeSwitchVector, makeTextVector } from '../types'

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
export type SimulatorProperty = ReturnType<typeof makeNumberVector> | ReturnType<typeof makeSwitchVector> | ReturnType<typeof makeTextVector> | ReturnType<typeof makeBlobVector>

// A catalog star with sky coordinates instead of pixel coordinates.
export type CatalogSourceStar = Omit<AstronomicalImageStar, 'x' | 'y'> & Readonly<EquatorialCoordinate>

// Provides stars within a cone (RA, Dec, radius in radians) to render into a synthetic frame.
export type CatalogSource = (rightAscension: Angle, declination: Angle, radius: Angle) => PromiseLike<readonly CatalogSourceStar[]> | readonly CatalogSourceStar[]

// Persistence hooks shared by all simulators for saving/loading property snapshots.
export interface DeviceSimulatorOptions {
	readonly save?: (name: string, properties: readonly SimulatorProperty[]) => void
	readonly load?: (name: string) => PromiseLike<readonly SimulatorProperty[]> | readonly SimulatorProperty[]
}
