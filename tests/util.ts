import { expect } from 'bun:test'
import type { Camera } from '../src/devices/indi/device'
import type { DeviceHandler } from '../src/devices/indi/manager'
import type { PropertyState, BlobEncoding } from '../src/devices/indi/types'
import type { NumberArray } from '../src/math/numerical/math'

export function isNetworkTestSkipped() {
	return Bun.env.RUN_NETWORK_TEST !== 'true'
}

export function isBinaryTestSkipped() {
	return Bun.env.RUN_BINARY_TEST !== 'true'
}

export function isTimeConsumingTestSkipped() {
	return Bun.env.RUN_TIME_CONSUMING_TEST !== 'true'
}

export function isPlatformDependentTestSkipped() {
	return Bun.env.RUN_PLATFORM_DEPENDENT_TEST !== 'true'
}

export function isLinuxSkipped() {
	return isPlatformDependentTestSkipped() || process.platform === 'linux'
}

export function isWindowsSkipped() {
	return isPlatformDependentTestSkipped() || process.platform === 'win32'
}

export function isNonLinuxSkipped() {
	return isPlatformDependentTestSkipped() || process.platform !== 'linux'
}

export function isNonWindowsSkipped() {
	return isPlatformDependentTestSkipped() || process.platform !== 'win32'
}

// Waits until a simulator state predicate succeeds or the timeout expires.
export async function waitUntil(predicate: () => boolean, timeout: number = 5000, step: number = 100): Promise<void> {
	while (!predicate()) {
		if (timeout <= 0) throw new Error('timeout waiting for condition')
		await Bun.sleep(step)
		timeout -= step
	}
}

export function expectNumberArrayToBeCloseTo(a: Readonly<NumberArray> | undefined | null, b: Readonly<NumberArray>, numDigits: number) {
	if (Object.is(a, b)) return
	if (a === undefined || a === null) return
	expect(a.length).toBeGreaterThanOrEqual(b.length)
	for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i], numDigits)
}

// Collects image BLOBs published by a simulated camera.
export class CameraFrameReceiver implements DeviceHandler<Camera> {
	readonly #frames: Buffer[] = []

	// Device registration does not require receiver-side state.
	added(device: Camera) {}

	// Property updates do not affect the accumulated image frames.
	updated(device: Camera, property: keyof Camera & string, state?: PropertyState) {}

	// Device removal leaves captured frames available to the test.
	removed(device: Camera) {}

	// Appends a completed image BLOB in acquisition order.
	blobReceived(device: Camera, data: Buffer, encoding: BlobEncoding) {
		this.#frames.push(data)
	}

	// Number of completed frames received so far.
	get length() {
		return this.#frames.length
	}

	// Most recently completed camera frame.
	get lastFrame() {
		return this.#frames.at(-1)!
	}
}
