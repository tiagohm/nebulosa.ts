export type StarDetector = (input: string) => DetectedStar[]

export interface DetectedStar {
	readonly x: number
	readonly y: number
	readonly hfd: number
	readonly snr: number
	readonly flux: number
}
