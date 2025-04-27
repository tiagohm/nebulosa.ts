import { test } from 'bun:test'
import { PHD2Client } from '../src/phd2'

test.skip('client', async () => {
	const client = new PHD2Client({
		handler: {
			event: (_, event) => {
				console.info('EVENT:', event)
			},
		},
	})

	await client.connect('0.0.0.0')

	await Bun.sleep(1000)

	console.info('FIND_STAR:', await client.findStar())
	console.info('GET_ALGORITHM_PARAM_NAMES(RA):', await client.getAlgorithmParamNames('RA'))
	console.info('GET_ALGORITHM_PARAM_NAMES(DEC):', await client.getAlgorithmParamNames('DEC'))
	console.info('GET_ALGORITHM_PARAM(RA, NAME):', await client.getAlgorithmParam('RA', 'algorithmName'))
	console.info('GET_ALGORITHM_PARAM(DEC, NAME):', await client.getAlgorithmParam('DEC', 'algorithmName'))
	console.info('GET_APP_STATE:', await client.getAppState())
	console.info('GET_CALIBRATED:', await client.getCalibrated())
	console.info('GET_CALIBRATION_DATA(MOUNT):', await client.getCalibrationData('MOUNT'))
	console.info('GET_CAMERA_BINNING:', await client.getCameraBinning())
	console.info('GET_CAMERA_FRAME_SIZE:', await client.getCameraFrameSize())
	console.info('GET_CONNECTED:', await client.getConnected())
	console.info('GET_CURRENT_EQUIPMENT:', await client.getCurrentEquipment())
	console.info('GET_DECLINATION_GUIDE_MODE:', await client.getDeclinationGuideMode())
	console.info('GET_EXPOSURE:', await client.getExposure())
	console.info('GET_EXPOSURE_DURATIONS:', await client.getExposureDurations())
	console.info('GET_GUIDE_OUTPUT_ENABLED:', await client.getGuideOutputEnabled())
	console.info('GET_LOCK_POSITION:', await client.getLockPosition())
	console.info('GET_LOCK_SHIFT_ENABLED:', await client.getLockShiftEnabled())
	console.info('GET_LOCK_SHIFT_PARAMS:', await client.getLockShiftParams())
	console.info('GET_PAUSED:', await client.getPaused())
	console.info('GET_PIXEL_SCALE:', await client.getPixelScale())
	console.info('GET_PROFILE:', await client.getProfile())
	console.info('GET_PROFILES:', await client.getProfiles())
	console.info('GET_SEARCH_REGION:', await client.getSearchRegion())
	console.info('GET_SETTLING:', await client.getSettling())
	console.info('GET_STAR_IMAGE:', await client.getStarImage())
	console.info('GET_USE_SUBFRAMES:', await client.getUseSubframes())
}, 5000)
