import { expect, test } from 'bun:test'
import { deg, type Angle } from '../src/angle'
import { TAU } from '../src/constants'
import { sphericalSeparation } from '../src/geometry'
import { mosaicBasis, planMosaic, type MosaicBasis, type MosaicCoordinate, type MosaicPlan, type MosaicPlanInput } from '../src/mosaic.plan'

interface PlanePoint {
	readonly x: number
	readonly y: number
}

const CENTER: MosaicCoordinate = { ra: deg(120), dec: deg(-20) }

function planeSize(angle: Angle) {
	return 2 * Math.tan(angle / 2)
}

function coordinateVector(coordinate: MosaicCoordinate) {
	const cosDec = Math.cos(coordinate.dec)
	return {
		x: cosDec * Math.cos(coordinate.ra),
		y: cosDec * Math.sin(coordinate.ra),
		z: Math.sin(coordinate.dec),
	}
}

function projectToPlane(basis: MosaicBasis, coordinate: MosaicCoordinate): PlanePoint {
	const p = coordinateVector(coordinate)
	const denominator = p.x * basis.cx + p.y * basis.cy + p.z * basis.cz

	return {
		x: (p.x * basis.ux + p.y * basis.uy + p.z * basis.uz) / denominator,
		y: (p.x * basis.vx + p.y * basis.vy + p.z * basis.vz) / denominator,
	}
}

function expectCoordinateValid(coordinate: MosaicCoordinate) {
	expect(Number.isFinite(coordinate.ra)).toBeTrue()
	expect(Number.isFinite(coordinate.dec)).toBeTrue()
	expect(coordinate.ra).toBeGreaterThanOrEqual(0)
	expect(coordinate.ra).toBeLessThan(TAU)
	expect(coordinate.dec).toBeGreaterThanOrEqual(-Math.PI / 2)
	expect(coordinate.dec).toBeLessThanOrEqual(Math.PI / 2)
}

function expectPlanFinite(plan: MosaicPlan) {
	for (const panel of plan.panels) {
		expectCoordinateValid(panel.center)
		expectCoordinateValid(panel.footprint.northWest)
		expectCoordinateValid(panel.footprint.northEast)
		expectCoordinateValid(panel.footprint.southEast)
		expectCoordinateValid(panel.footprint.southWest)
	}
}

function expectPlanePointClose(actual: PlanePoint, x: number, y: number, digits: number = 14) {
	expect(actual.x).toBeCloseTo(x, digits)
	expect(actual.y).toBeCloseTo(y, digits)
}

function defaultInput(input: Partial<MosaicPlanInput> = {}): MosaicPlanInput {
	return {
		center: CENTER,
		panel: { width: deg(2), height: deg(1) },
		region: { width: deg(2), height: deg(1) },
		...input,
	}
}

test('single panel is centered and footprint uses the shared plane', () => {
	const plan = planMosaic(defaultInput())
	const basis = mosaicBasis(plan.center, plan.positionAngle)
	const halfWidth = planeSize(plan.panel.width) / 2
	const halfHeight = planeSize(plan.panel.height) / 2

	expect(plan.columns).toBe(1)
	expect(plan.rows).toBe(1)
	expect(plan.panels).toHaveLength(1)
	expect(sphericalSeparation(plan.center.ra, plan.center.dec, plan.panels[0].center.ra, plan.panels[0].center.dec)).toBeCloseTo(0, 14)
	expect(plan.coverage.width).toBeCloseTo(plan.panel.width, 14)
	expect(plan.coverage.height).toBeCloseTo(plan.panel.height, 14)
	expectPlanePointClose(projectToPlane(basis, plan.panels[0].footprint.northWest), -halfWidth, halfHeight)
	expectPlanePointClose(projectToPlane(basis, plan.panels[0].footprint.northEast), halfWidth, halfHeight)
	expectPlanePointClose(projectToPlane(basis, plan.panels[0].footprint.southEast), halfWidth, -halfHeight)
	expectPlanePointClose(projectToPlane(basis, plan.panels[0].footprint.southWest), -halfWidth, -halfHeight)
})

test('overlap determines counts and coverage on the shared plane', () => {
	const plan = planMosaic(defaultInput({ region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 } }))
	const coverageWidth = planeSize(plan.coverage.width)
	const coverageHeight = planeSize(plan.coverage.height)

	expect(plan.columns).toBe(3)
	expect(plan.rows).toBe(3)
	expect(coverageWidth).toBeGreaterThanOrEqual(planeSize(plan.region.width) - Number.EPSILON)
	expect(coverageHeight).toBeGreaterThanOrEqual(planeSize(plan.region.height) - Number.EPSILON)
})

test('no-overlap count covers a smaller than two-panel span with two panels', () => {
	const plan = planMosaic(defaultInput({ panel: { width: deg(2), height: deg(2) }, region: { width: deg(3.8), height: deg(3.8) } }))

	expect(plan.columns).toBe(2)
	expect(plan.rows).toBe(2)
})

test('exact count boundary does not create a spurious extra panel', () => {
	const panelWidth = deg(2)
	const twoPanelRegionWidth = 2 * Math.atan(planeSize(panelWidth))
	const plan = planMosaic(defaultInput({ panel: { width: panelWidth, height: deg(2) }, region: { width: twoPanelRegionWidth, height: deg(2) } }))

	expect(plan.columns).toBe(2)
	expect(plan.rows).toBe(1)
})

test('odd grid has a central panel at the mosaic center', () => {
	const plan = planMosaic(defaultInput({ region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 } }))
	const centerPanel = plan.panels.find((panel) => panel.row === 1 && panel.column === 1)!

	expect(sphericalSeparation(plan.center.ra, plan.center.dec, centerPanel.center.ra, centerPanel.center.dec)).toBeCloseTo(0, 14)
})

test('even grid is centered around the requested target', () => {
	const plan = planMosaic(defaultInput({ panel: { width: deg(2), height: deg(2) }, region: { width: deg(3.8), height: deg(3.8) } }))
	const basis = mosaicBasis(plan.center, plan.positionAngle)
	let sumX = 0
	let sumY = 0

	for (const panel of plan.panels) {
		const point = projectToPlane(basis, panel.center)
		sumX += point.x
		sumY += point.y
		expect(sphericalSeparation(plan.center.ra, plan.center.dec, panel.center.ra, panel.center.dec)).toBeGreaterThan(0)
	}

	expect(sumX / plan.panels.length).toBeCloseTo(0, 14)
	expect(sumY / plan.panels.length).toBeCloseTo(0, 14)
})

test('zero position angle increases columns east and rows south', () => {
	const plan = planMosaic(defaultInput({ center: { ra: deg(10), dec: 0 }, panel: { width: deg(2), height: deg(2) }, region: { width: deg(3.8), height: deg(3.8) } }))
	const basis = mosaicBasis(plan.center, plan.positionAngle)
	const first = projectToPlane(basis, plan.panels[0].center)
	const nextColumn = projectToPlane(basis, plan.panels[1].center)
	const lastRow = projectToPlane(basis, plan.panels[2].center)

	expect(nextColumn.x).toBeGreaterThan(first.x)
	expect(lastRow.y).toBeLessThan(first.y)
	expect(plan.panels[0].center.dec).toBeGreaterThan(plan.panels[2].center.dec)
})

test('ninety-degree rotation makes increasing columns move approximately south', () => {
	const plan = planMosaic(defaultInput({ center: { ra: deg(10), dec: 0 }, panel: { width: deg(2), height: deg(2) }, region: { width: deg(3.8), height: deg(2) }, positionAngle: Math.PI / 2 }))

	expect(plan.panels[1].center.dec).toBeLessThan(plan.panels[0].center.dec)
})

test('right ascension wraps to the positive range', () => {
	const plan = planMosaic(defaultInput({ center: { ra: TAU - deg(0.1), dec: 0 }, panel: { width: deg(2), height: deg(1) }, region: { width: deg(4), height: deg(1) } }))
	let hasSmallPositiveRa = false

	for (const panel of plan.panels) {
		const coordinates = [panel.center, panel.footprint.northWest, panel.footprint.northEast, panel.footprint.southEast, panel.footprint.southWest]
		for (const coordinate of coordinates) {
			expectCoordinateValid(coordinate)
			hasSmallPositiveRa ||= coordinate.ra > 0 && coordinate.ra < deg(1)
		}
	}

	expect(hasSmallPositiveRa).toBeTrue()
})

test('near-pole panels remain finite and locally ordered', () => {
	const plan = planMosaic(defaultInput({ center: { ra: deg(40), dec: deg(89) }, region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 } }))
	const basis = mosaicBasis(plan.center, plan.positionAngle)

	expectPlanFinite(plan)
	for (const panel of plan.panels) {
		const northWest = projectToPlane(basis, panel.footprint.northWest)
		const northEast = projectToPlane(basis, panel.footprint.northEast)
		const southEast = projectToPlane(basis, panel.footprint.southEast)
		const southWest = projectToPlane(basis, panel.footprint.southWest)

		expect(northWest.x).toBeLessThan(northEast.x)
		expect(southWest.x).toBeLessThan(southEast.x)
		expect(northWest.y).toBeGreaterThan(southWest.y)
		expect(northEast.y).toBeGreaterThan(southEast.y)
	}
})

test('footprint corners match the central panel and diagonals are longer', () => {
	const plan = planMosaic(defaultInput({ region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 } }))
	const basis = mosaicBasis(plan.center, plan.positionAngle)
	const panel = plan.panels.find((candidate) => candidate.row === 1 && candidate.column === 1)!
	const halfWidth = planeSize(plan.panel.width) / 2
	const halfHeight = planeSize(plan.panel.height) / 2
	const adjacent = sphericalSeparation(panel.footprint.northWest.ra, panel.footprint.northWest.dec, panel.footprint.northEast.ra, panel.footprint.northEast.dec)
	const diagonal = sphericalSeparation(panel.footprint.northWest.ra, panel.footprint.northWest.dec, panel.footprint.southEast.ra, panel.footprint.southEast.dec)

	expectPlanePointClose(projectToPlane(basis, panel.footprint.northWest), -halfWidth, halfHeight)
	expectPlanePointClose(projectToPlane(basis, panel.footprint.northEast), halfWidth, halfHeight)
	expectPlanePointClose(projectToPlane(basis, panel.footprint.southEast), halfWidth, -halfHeight)
	expectPlanePointClose(projectToPlane(basis, panel.footprint.southWest), -halfWidth, -halfHeight)
	expect(diagonal).toBeGreaterThan(adjacent)
})

test('traversal orders panels in row-major and serpentine order', () => {
	const rowMajor = planMosaic(defaultInput({ region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 } }))
	const serpentine = planMosaic(defaultInput({ region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 }, traversal: 'SERPENTINE' }))

	expect(rowMajor.panels.map((panel) => [panel.row, panel.column])).toEqual([
		[0, 0],
		[0, 1],
		[0, 2],
		[1, 0],
		[1, 1],
		[1, 2],
		[2, 0],
		[2, 1],
		[2, 2],
	])
	expect(serpentine.panels.map((panel) => [panel.row, panel.column])).toEqual([
		[0, 0],
		[0, 1],
		[0, 2],
		[1, 2],
		[1, 1],
		[1, 0],
		[2, 0],
		[2, 1],
		[2, 2],
	])

	for (let index = 0; index < rowMajor.panels.length; index++) {
		expect(rowMajor.panels[index].index).toBe(index)
		expect(serpentine.panels[index].index).toBe(index)
	}
})

test('input right ascension is normalized without mutating input objects', () => {
	const input = defaultInput({ center: { ra: TAU + deg(15), dec: deg(12) }, positionAngle: Math.PI, overlap: { x: 0.2 } })
	const snapshot = structuredClone(input)
	Object.freeze(input.center)
	Object.freeze(input.panel)
	Object.freeze(input.region)
	Object.freeze(input.overlap)
	Object.freeze(input)

	const plan = planMosaic(input)

	expect(plan.center.ra).toBeCloseTo(deg(15), 14)
	expect(plan.positionAngle).toBe(Math.PI)
	expect(input).toEqual(snapshot)
	expect(plan.center).not.toBe(input.center)
	expect(plan.panel).not.toBe(input.panel)
	expect(plan.region).not.toBe(input.region)
	expect(plan.overlap).not.toBe(input.overlap)
})

test('footprint corners follow celestial directions at zero position angle', () => {
	const plan = planMosaic(defaultInput({ center: { ra: deg(10), dec: 0 }, panel: { width: deg(2), height: deg(2) } }))
	const { footprint, center } = plan.panels[0]

	// North corners must lie north of the center and south corners south of it.
	expect(footprint.northWest.dec).toBeGreaterThan(center.dec)
	expect(footprint.northEast.dec).toBeGreaterThan(center.dec)
	expect(footprint.southEast.dec).toBeLessThan(center.dec)
	expect(footprint.southWest.dec).toBeLessThan(center.dec)

	// East corners must lie at greater right ascension and west corners at smaller.
	expect(footprint.northEast.ra).toBeGreaterThan(center.ra)
	expect(footprint.southEast.ra).toBeGreaterThan(center.ra)
	expect(footprint.northWest.ra).toBeLessThan(center.ra)
	expect(footprint.southWest.ra).toBeLessThan(center.ra)
})

test('coverage matches the shared-plane panel spacing', () => {
	const plan = planMosaic(defaultInput({ region: { width: deg(4), height: deg(2) }, overlap: { x: 0.1, y: 0.1 } }))
	const panelPlaneWidth = planeSize(plan.panel.width)
	const panelPlaneHeight = planeSize(plan.panel.height)
	const stepX = panelPlaneWidth * (1 - plan.overlap.x)
	const stepY = panelPlaneHeight * (1 - plan.overlap.y)
	const expectedWidth = 2 * Math.atan((panelPlaneWidth + (plan.columns - 1) * stepX) / 2)
	const expectedHeight = 2 * Math.atan((panelPlaneHeight + (plan.rows - 1) * stepY) / 2)

	expect(plan.coverage.width).toBeCloseTo(expectedWidth, 14)
	expect(plan.coverage.height).toBeCloseTo(expectedHeight, 14)
	expect(plan.coverage.width).toBeGreaterThanOrEqual(plan.region.width)
	expect(plan.coverage.height).toBeGreaterThanOrEqual(plan.region.height)
})

test('position angle is normalized into (-PI, PI]', () => {
	// The lower bound wraps to the upper bound, matching normalizePI and atan2.
	expect(planMosaic(defaultInput({ positionAngle: -Math.PI })).positionAngle).toBe(Math.PI)
	expect(planMosaic(defaultInput({ positionAngle: Math.PI })).positionAngle).toBe(Math.PI)
	expect(planMosaic(defaultInput({ positionAngle: Math.PI / 2 })).positionAngle).toBeCloseTo(Math.PI / 2, 14)
	expect(planMosaic(defaultInput({ positionAngle: TAU + deg(30) })).positionAngle).toBeCloseTo(deg(30), 14)
	expect(planMosaic(defaultInput({ positionAngle: -TAU - deg(30) })).positionAngle).toBeCloseTo(-deg(30), 14)
})

test('invalid inputs are rejected with field-specific range errors', () => {
	const invalidInputs: MosaicPlanInput[] = [
		defaultInput({ center: { ra: Number.NaN, dec: 0 } }),
		defaultInput({ center: { ra: 0, dec: Number.POSITIVE_INFINITY } }),
		defaultInput({ center: { ra: 0, dec: -Math.PI / 2 - Number.EPSILON } }),
		defaultInput({ center: { ra: 0, dec: Math.PI / 2 + Number.EPSILON } }),
		defaultInput({ panel: { width: 0, height: deg(1) } }),
		defaultInput({ panel: { width: -deg(1), height: deg(1) } }),
		defaultInput({ panel: { width: Math.PI, height: deg(1) } }),
		defaultInput({ panel: { width: Number.POSITIVE_INFINITY, height: deg(1) } }),
		defaultInput({ panel: { width: deg(1), height: 0 } }),
		defaultInput({ panel: { width: deg(1), height: -deg(1) } }),
		defaultInput({ panel: { width: deg(1), height: Math.PI } }),
		defaultInput({ region: { width: 0, height: deg(1) } }),
		defaultInput({ region: { width: -deg(1), height: deg(1) } }),
		defaultInput({ region: { width: Math.PI, height: deg(1) } }),
		defaultInput({ region: { width: Number.NaN, height: deg(1) } }),
		defaultInput({ region: { width: deg(1), height: 0 } }),
		defaultInput({ region: { width: deg(1), height: -deg(1) } }),
		defaultInput({ region: { width: deg(1), height: Math.PI } }),
		defaultInput({ overlap: { x: Number.NaN } }),
		defaultInput({ overlap: { x: -Number.EPSILON } }),
		defaultInput({ overlap: { x: 1 } }),
		defaultInput({ overlap: { x: 2 } }),
		defaultInput({ overlap: { y: Number.POSITIVE_INFINITY } }),
		defaultInput({ overlap: { y: -Number.EPSILON } }),
		defaultInput({ overlap: { y: 1 } }),
		defaultInput({ overlap: { y: 2 } }),
		defaultInput({ positionAngle: Number.NaN }),
		defaultInput({ traversal: 'DIAGONAL' as never }),
	]

	for (const input of invalidInputs) {
		expect(() => planMosaic(input)).toThrow(RangeError)
	}
})
