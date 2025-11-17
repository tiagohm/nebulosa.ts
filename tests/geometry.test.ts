import { expect, test } from 'bun:test'
import { rectIntersection } from '../src/geometry'

test('rectangle intersection', () => {
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 5, top: 5, right: 15, bottom: 15 })).toEqual({ left: 5, right: 10, top: 5, bottom: 10 })
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 11, top: 11, right: 15, bottom: 15 })).toBeUndefined()
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 5, top: 5, right: 8, bottom: 8 })).toEqual({ left: 5, right: 8, top: 5, bottom: 8 })
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 9.99, top: 9.99, right: 15, bottom: 15 })).toEqual({ left: 9.99, right: 10, top: 9.99, bottom: 10 })
	expect(rectIntersection({ left: 0, right: 10, top: 0, bottom: 10 }, { left: 10, top: 10, right: 15, bottom: 15 })).toBeUndefined()
})
