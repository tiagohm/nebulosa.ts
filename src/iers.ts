import type { Angle } from './angle'
import type { PolarMotion, Time, TimeDelta } from './time'

export type Iers = TimeDelta & PolarMotion

export class IersA implements Iers {
	delta(time: Time): number {
		return 0
	}

	xy(time: Time): [Angle, Angle] {
		return [0, 0]
	}
}

export class IersB implements Iers {
	delta(time: Time): number {
		return 0
	}

	xy(time: Time): [Angle, Angle] {
		return [0, 0]
	}
}

export class IersAB implements Iers {
	constructor(readonly a: IersA, readonly b: IersB) {}

	delta(time: Time): number {
		return this.a.delta(time) || this.b.delta(time)
	}

	xy(time: Time): [Angle, Angle] {
		return [0, 0]
	}
}

export const iersa = new IersA()
export const iersb = new IersB()
export const iersab = new IersAB(iersa, iersb)
