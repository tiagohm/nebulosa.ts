import { meanOf } from '../../core/util'
import { exposureTimeKeyword } from '../../io/formats/fits/util'
import type { Image } from '../model/types'
import { clone, copyInto, divide, multiplyScalar, plusScalar, subtract } from './arithmetic'
import { estimateBackgroundUsingMode } from './computation'

// Frame calibration for astronomical images: computes (Light - Dark) / (Flat - Bias) * mean(Flat) in
// place on the light frame, with exposure-scaled dark background matching, building on the image
// arithmetic helpers.

// Calibrated = (Light - Dark) / (Flat - Bias) * mean(Flat)
export function calibrate(light: Image, dark?: Image, flat?: Image, bias?: Image, darkFlat?: Image) {
	let tmp: Image | undefined

	// DARK

	if (dark) {
		const TL = Math.trunc(exposureTimeKeyword(light.header, 0) * 1000000)
		const TD = Math.trunc(exposureTimeKeyword(dark.header, 0) * 1000000)

		if (TL !== TD) {
			// dark = linear(DARK - BIAS, TL / TD, 0)

			tmp = clone(light)

			if (bias) subtract(tmp, bias)
			const bgL = estimateBackgroundUsingMode(tmp)

			copyInto(dark, tmp)
			if (bias) subtract(tmp, bias)
			const bgD = estimateBackgroundUsingMode(tmp)

			plusScalar(tmp, bgL - bgD)
			subtract(light, tmp)
		} else {
			subtract(light, dark)
		}
	} else if (bias) {
		subtract(light, bias)
	}

	// FLAT

	if (flat) {
		if (bias || darkFlat) {
			if (tmp) copyInto(flat, tmp)
			else tmp = clone(flat)

			if (darkFlat) subtract(tmp, darkFlat)
			else if (bias) subtract(tmp, bias)

			flat = tmp
		}

		divide(light, flat)
		multiplyScalar(light, meanOf(flat.raw))
	}

	return light
}
