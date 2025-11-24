export interface Rect {
	left: number
	top: number
	right: number
	bottom: number
}

// https://dreamswork.github.io/qt4/qrect_8cpp_source.html

export function rectIntersection(a: Rect, b: Rect, out?: Rect) {
	let la = a.left
	let ra = a.left
	if (a.right < a.left) la = a.right
	else ra = a.right

	let lb = b.left
	let rb = b.left
	if (b.right < b.left) lb = b.right
	else rb = b.right

	if (la >= rb || lb >= ra) return undefined

	let ta = a.top
	let ba = a.top
	if (a.bottom < a.top) ta = a.bottom
	else ba = a.bottom

	let tb = b.top
	let bb = b.top
	if (b.bottom < b.top) tb = b.bottom
	else bb = b.bottom

	if (ta >= bb || tb >= ba) return undefined

	out ??= { left: 0, right: 0, top: 0, bottom: 0 }

	out.left = Math.max(la, lb)
	out.right = Math.min(ra, rb)
	out.top = Math.max(ta, tb)
	out.bottom = Math.min(ba, bb)

	return out
}
