import type { SyntheticCollimationPattern } from '../src/imaging/synthetic/collimation'

export function collimationFixture(overrides: Partial<SyntheticCollimationPattern> = {}): SyntheticCollimationPattern {
	return {
		width: 160,
		height: 160,
		outer: { center: { x: 79.4, y: 80.2 }, semiMajor: 48, semiMinor: 48, theta: 0, softness: 0.75 },
		obstruction: { center: { x: 81.4, y: 81.2 }, semiMajor: 20, semiMinor: 20, theta: 0, softness: 0.75 },
		signal: 0.6 * Math.PI * (48 ** 2 - 20 ** 2),
		background: 0.05,
		noise: 0,
		seed: 7121,
		...overrides,
	}
}
