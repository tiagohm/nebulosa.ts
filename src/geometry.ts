export interface Rect {
	left: number
	top: number
	right: number
	bottom: number
}

// https://dreamswork.github.io/qt4/qrect_8cpp_source.html

export function rectIntersection(a: Rect, b: Rect) {
	let la = a.left
	let ra = a.left
	if (a.right - a.left < 0) la = a.right
	else ra = a.right

	let lb = b.left
	let rb = b.left
	if (b.right - b.left < 0) lb = b.right
	else rb = b.right

	if (la >= rb || lb >= ra) return undefined

	let ta = a.top
	let ba = a.top
	if (a.bottom - a.top < 0) ta = a.bottom
	else ba = a.bottom

	let tb = b.top
	let bb = b.top
	if (b.bottom - b.top < 0) tb = b.bottom
	else bb = b.bottom

	if (ta >= bb || tb >= ba) return undefined

	const left = Math.max(la, lb)
	const right = Math.min(ra, rb)
	const top = Math.max(ta, tb)
	const bottom = Math.min(ba, bb)

	return { left, right, top, bottom }
}
