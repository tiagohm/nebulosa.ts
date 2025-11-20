import { type Rect, rectIntersection } from './geometry'
import type { Image } from './image'
import { histogram } from './image.computation'
import { grayscale, mean, psf } from './image.transformation'

export interface DetectedStar {
	readonly x: number
	readonly y: number
	readonly hfd: number
	readonly snr: number
	readonly flux: number
}

export interface DetectStarOptions {
	maxStars: number
	searchRegion?: number
}

const DEFAULT_DETECT_STARS_OPTIONS: Readonly<DetectStarOptions> = {
	maxStars: 500,
	searchRegion: 0,
}

export function detectStars(image: Image, { maxStars = 500, searchRegion = 0 }: Partial<DetectStarOptions> = DEFAULT_DETECT_STARS_OPTIONS): DetectedStar[] {
	image = grayscale(image)

	// Run a 3x3 median first to eliminate hot pixels
	image = mean(image)

	// Run the PSF convolution
	image = psf(image)

	const { raw, metadata } = image
	const { width, height, stride } = metadata
	const convRect: Rect = { left: 4, top: 4, right: width - 5, bottom: height - 5 }
	let rect: Rect = { left: 0, top: 0, bottom: 0, right: 0 }
	const hist = new Int32Array(1 << 18)
	const maxX = convRect.right - 4
	const maxY = convRect.bottom - 4
	const stars = new StarList(maxStars)

	// Find each local maximum
	for (let y = convRect.top + 4; y <= maxY; y++) {
		const sy = stride * y

		for (let x = convRect.left + 4; x <= maxX; x++) {
			const value = raw[sy + x]
			let isMax = false

			if (value > 0) {
				isMax = true

				for (let j = -4; j <= 4; j++) {
					const sj = sy + stride * j

					for (let i = -4; i <= 4; i++) {
						if (i === 0 && j === 0) continue

						if (raw[sj + x + i] > value) {
							isMax = false
							break
						}
					}

					if (!isMax) break
				}
			}

			if (!isMax) continue

			// Compare local maximum to mean value of surrounding pixels
			rect.left = x - 7
			rect.top = y - 7
			rect.right = x + 7
			rect.bottom = y + 7
			rect = rectIntersection(rect, convRect, rect)!
			const { mean, standardDeviation } = histogram(image, 'GRAY', undefined, rect, hist)

			// This is our measure of star intensity
			const h = (value - mean) / standardDeviation

			if (h < 0.1) continue

			stars.add(x, y, h)
		}
	}

	// Merge stars that are very close into a single star
	mergeVeryCloseStars(stars)

	if (searchRegion > 0) {
		// Exclude stars that would fit within a single search region box
		excludeStarsFitWithinRegion(stars, searchRegion)
	}

	let c = 0
	const res = new Array<DetectedStar>(stars.size)

	for (const s of stars) {
		res[c++] = { x: s.x, y: s.y, flux: s.h, hfd: 0, snr: 0 }
	}

	return res
}

export function mergeVeryCloseStars(stars: StarList, minLimitSq: number = 25) {
	if (stars.size <= 0) return

	let current = stars.iterator().next().value

	while (current !== undefined) {
		const a = current
		let b = a.next
		current = b

		while (b !== undefined) {
			const dx = a.x - b.x
			const dy = a.y - b.y
			const d2 = dx * dx + dy * dy

			b = b.next

			if (d2 < minLimitSq) {
				stars.delete(a)
				break
			}
		}
	}
}

export function excludeStarsFitWithinRegion(stars: StarList, searchRegion: number) {
	if (stars.size <= 0) return

	let current = stars.iterator().next()?.value
	const deleted = new Set<Star>()

	searchRegion += 5 // extra safety margin

	while (current !== undefined) {
		const a = current
		let b = a.next
		current = b

		while (b !== undefined) {
			const dx = Math.abs(a.x - b.x)
			const dy = Math.abs(a.y - b.y)

			if (dx <= searchRegion && dy <= searchRegion) {
				// stars closer than search region, exclude them both
				// but do not let a very dim star eliminate a very bright star
				if (b.h / a.h < 5) {
					deleted.add(a)
					deleted.add(b)
				}
			}

			b = b.next
		}
	}

	for (const s of deleted) {
		stars.delete(s)
	}
}

interface Star {
	readonly x: number
	readonly y: number
	readonly h: number
	next?: this
}

export class StarList implements Iterable<Star, Star | undefined, Star> {
	private head?: Star
	private tail?: Star
	size = 0

	constructor(private readonly capacity: number = 100) {}

	addLast(x: number, y: number, h: number) {
		const star: Star = { x, y, h }

		if (!this.head) {
			this.head = star
			this.tail = star
		} else if (this.tail) {
			this.tail.next = star
			this.tail = star
		}

		this.size++
	}

	addFirst(x: number, y: number, h: number) {
		const star: Star = { x, y, h }

		if (!this.head) {
			this.head = star
			this.tail = star
		} else {
			star.next = this.head
			this.head = star
		}

		this.size++
	}

	add(x: number, y: number, h: number) {
		if (!this.head || h <= this.head.h) this.size < this.capacity && this.addFirst(x, y, h)
		else if (!this.tail || h >= this.tail.h) this.addLast(x, y, h)
		else {
			const star: Star = { x, y, h }

			for (let a: Star | undefined = this.head; a; a = a.next) {
				if (a.next && h >= a.next.h) continue

				star.next = a.next
				a.next = star
				this.size++

				break
			}
		}

		if (this.size > this.capacity) {
			this.deleteFirst()
		}
	}

	deleteFirst() {
		if (!this.head) return false

		this.head = this.head.next
		if (!this.head) this.tail = undefined

		this.size--

		return true
	}

	delete(s: Star) {
		if (this.head && s === this.head) this.deleteFirst()
		else {
			for (let a: Star | undefined = this.head; a; a = a.next) {
				if (!a.next || s !== a.next) continue

				a.next = s.next
				this.size--

				break
			}
		}
	}

	clear() {
		this.head = undefined
		this.tail = undefined
		this.size = 0
	}

	array() {
		const n = this.size
		const data = new Array<Star>(n)
		for (let i = 0, s = this.head; i < n; i++, s = s!.next) data[i] = s!
		return data
	}

	iterator(): Iterator<Star, Star | undefined> {
		let current = this.head

		return {
			next: () => {
				if (current) {
					const value = current
					current = current.next
					return { value, done: false }
				} else {
					return { value: undefined, done: true }
				}
			},
		} as const
	}

	[Symbol.iterator]() {
		return this.iterator()
	}
}
