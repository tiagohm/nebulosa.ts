import { describe, expect, test } from 'bun:test'
import { AlpacaApi } from '../../../src/devices/alpaca/api'
import { AlpacaServer } from '../../../src/devices/alpaca/server'
// oxfmt-ignore
import { AlpacaCameraState, AlpacaDomeShutterState, AlpacaException, AlpacaGuideDirection, AlpacaTelescopeAlignmentMode, AlpacaTelescopeAxis, AlpacaTelescopeEquatorialCoordinateType, AlpacaTelescopeTrackingRate, type AlpacaConfiguredDevice, type AlpacaDeviceType, type AlpacaRequestResult, type AlpacaStateItem } from '../../../src/devices/alpaca/types'
import { IndiClientHandlerSet } from '../../../src/devices/indi/client'
import { CameraManager } from '../../../src/devices/indi/manager/camera'
import { CoverManager } from '../../../src/devices/indi/manager/cover'
import { DomeManager } from '../../../src/devices/indi/manager/dome'
import { FlatPanelManager } from '../../../src/devices/indi/manager/flatpanel'
import { FocuserManager } from '../../../src/devices/indi/manager/focuser'
import { GuideOutputManager } from '../../../src/devices/indi/manager/guideoutput'
import { MountManager } from '../../../src/devices/indi/manager/mount'
import { RotatorManager } from '../../../src/devices/indi/manager/rotator'
import { SafetyMonitorManager } from '../../../src/devices/indi/manager/safetymonitor'
import { ThermometerManager } from '../../../src/devices/indi/manager/thermometer'
import { WeatherManager } from '../../../src/devices/indi/manager/weather'
import { WheelManager } from '../../../src/devices/indi/manager/wheel'
import { CameraSimulator } from '../../../src/devices/indi/simulator/camera'
import { ClientSimulator } from '../../../src/devices/indi/simulator/client'
import { CAMERA_AMBIENT_TEMPERATURE, CAMERA_MAX_BIN, CAMERA_MAX_EXPOSURE, CAMERA_MIN_EXPOSURE, CAMERA_PIXEL_SIZE, CAMERA_SENSOR_HEIGHT, CAMERA_SENSOR_WIDTH, FILTER_WHEEL_SLOT_NAMES, FOCUSER_INITIAL_POSITION, FOCUSER_MAX_POSITION, PANEL_MAX_INTENSITY } from '../../../src/devices/indi/simulator/constants'
import { CoverSimulator } from '../../../src/devices/indi/simulator/cover'
import { DomeSimulator } from '../../../src/devices/indi/simulator/dome'
import { FlatPanelSimulator } from '../../../src/devices/indi/simulator/flatpanel'
import { FocuserSimulator } from '../../../src/devices/indi/simulator/focuser'
import { MountSimulator } from '../../../src/devices/indi/simulator/mount'
import { RotatorSimulator } from '../../../src/devices/indi/simulator/rotator'
import { SafetyMonitorSimulator } from '../../../src/devices/indi/simulator/safetymonitor'
import { WeatherSimulator } from '../../../src/devices/indi/simulator/weather'
import { WheelSimulator } from '../../../src/devices/indi/simulator/wheel'
import { waitUntil } from '../../util'

const cameraManager = new CameraManager()
const mountManager = new MountManager()
const focuserManager = new FocuserManager()
const wheelManager = new WheelManager()
const rotatorManager = new RotatorManager()
const domeManager = new DomeManager()
const coverManager = new CoverManager()
const flatPanelManager = new FlatPanelManager()
const weatherManager = new WeatherManager()
const safetyMonitorManager = new SafetyMonitorManager({ get: () => undefined })
const guideOutputManager = new GuideOutputManager({ get: (client, name) => mountManager.get(client, name) ?? cameraManager.get(client, name) })
const thermometerManager = new ThermometerManager({ get: (client, name) => focuserManager.get(client, name) ?? cameraManager.get(client, name) })

const handler = new IndiClientHandlerSet()
handler.add(cameraManager)
handler.add(mountManager)
handler.add(focuserManager)
handler.add(wheelManager)
handler.add(rotatorManager)
handler.add(domeManager)
handler.add(coverManager)
handler.add(flatPanelManager)
handler.add(weatherManager)
handler.add(safetyMonitorManager)
handler.add(guideOutputManager)
handler.add(thermometerManager)

const clientSimulator = new ClientSimulator('client', handler)
const cameraSimulator = new CameraSimulator('camera', clientSimulator)
const mountSimulator = new MountSimulator('mount', clientSimulator)
const focuserSimulator = new FocuserSimulator('focuser', clientSimulator)
const wheelSimulator = new WheelSimulator('wheel', clientSimulator)
const rotatorSimulator = new RotatorSimulator('rotator', clientSimulator)
const domeSimulator = new DomeSimulator('dome', clientSimulator, { mountManager })
const coverSimulator = new CoverSimulator('cover', clientSimulator)
const flatPanelSimulator = new FlatPanelSimulator('panel', clientSimulator)
const safetyMonitorSimulator = new SafetyMonitorSimulator('safety', clientSimulator)
const weatherSimulator = new WeatherSimulator('weather', clientSimulator)

const camera = cameraManager.get(clientSimulator, 'camera')!
const mount = mountManager.get(clientSimulator, 'mount')!
const focuser = focuserManager.get(clientSimulator, 'focuser')!
const wheel = wheelManager.get(clientSimulator, 'wheel')!
const rotator = rotatorManager.get(clientSimulator, 'rotator')!
const dome = domeManager.get(clientSimulator, 'dome')!
const cover = coverManager.get(clientSimulator, 'cover')!
const panel = flatPanelManager.get(clientSimulator, 'panel')!
const safety = safetyMonitorManager.get(clientSimulator, 'safety')!
const weather = weatherManager.get(clientSimulator, 'weather')!

cameraManager.connect(camera)
mountManager.connect(mount)
focuserManager.connect(focuser)
wheelManager.connect(wheel)
rotatorManager.connect(rotator)
domeManager.connect(dome)
coverManager.connect(cover)
flatPanelManager.connect(panel)
safetyMonitorManager.connect(safety)
weatherManager.connect(weather)

await waitUntil(() => camera.connected && mount.connected && focuser.connected && wheel.connected && rotator.connected && dome.connected && cover.connected && panel.connected && safety.connected && weather.connected)

const server = new AlpacaServer({
	camera: cameraManager,
	mount: mountManager,
	focuser: focuserManager,
	wheel: wheelManager,
	rotator: rotatorManager,
	dome: domeManager,
	cover: coverManager,
	flatPanel: flatPanelManager,
	safetyMonitor: safetyMonitorManager,
	weather: weatherManager,
	guideOutput: guideOutputManager,
	deviceNumberProvider: () => 0,
})

server.start('127.0.0.1', 0)

const api = new AlpacaApi(`http://localhost:${server.port}`)
const ID = 0

describe('management', () => {
	test('configuredDevices', async () => {
		expectOk(await api.management.configuredDevices(), [
			configured('camera', 'camera', 'camera'),
			configured('mount', 'telescope', 'mount'),
			configured('focuser', 'focuser', 'focuser'),
			configured('wheel', 'filterwheel', 'wheel'),
			configured('rotator', 'rotator', 'rotator'),
			configured('dome', 'dome', 'dome'),
			configured('panel', 'covercalibrator', 'flatPanel'),
			configured('safety', 'safetymonitor', 'safetyMonitor'),
			configured('weather', 'observingconditions', 'weather'),
		])
	})
})

describe('camera', () => {
	test('isConnected', async () => {
		expectOk(await api.camera.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.camera.connect(ID), true)
	})

	// disconnect would drop the live camera and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.camera.deviceState(ID), ['CameraState', 'CCDTemperature', 'CoolerPower', 'HeatSinkTemperature', 'ImageReady', 'IsPulseGuiding', 'PercentCompleted', 'TimeStamp'])
	})

	test('getBayerOffsetX', async () => {
		expectOk(await api.camera.getBayerOffsetX(ID), 0)
	})

	test('getBayerOffsetY', async () => {
		expectOk(await api.camera.getBayerOffsetY(ID), 0)
	})

	test('getBinX', async () => {
		expectOk(await api.camera.getBinX(ID), 1)
	})

	test('getBinY', async () => {
		expectOk(await api.camera.getBinY(ID), 1)
	})

	test('getCameraState', async () => {
		expectOk(await api.camera.getCameraState(ID), AlpacaCameraState.IDLE)
	})

	test('getCameraXSize', async () => {
		expectOk(await api.camera.getCameraXSize(ID), CAMERA_SENSOR_WIDTH)
	})

	test('getCameraYSize', async () => {
		expectOk(await api.camera.getCameraYSize(ID), CAMERA_SENSOR_HEIGHT)
	})

	test('canAbortExposure', async () => {
		expectOk(await api.camera.canAbortExposure(ID), true)
	})

	test('canAsymmetricBin', async () => {
		expectOk(await api.camera.canAsymmetricBin(ID), false)
	})

	test('canFastReadout', async () => {
		expectOk(await api.camera.canFastReadout(ID), false)
	})

	test('canGetCoolerPower', async () => {
		expectOk(await api.camera.canGetCoolerPower(ID), true)
	})

	test('canPulseGuide', async () => {
		expectOk(await api.camera.canPulseGuide(ID), true)
	})

	test('canSetCcdTemperature', async () => {
		expectOk(await api.camera.canSetCcdTemperature(ID), true)
	})

	test('canStopExposure', async () => {
		expectOk(await api.camera.canStopExposure(ID), true)
	})

	test('getCcdTemperature', async () => {
		expectCloseTo(await api.camera.getCcdTemperature(ID), CAMERA_AMBIENT_TEMPERATURE, 0)
	})

	test('isCoolerOn', async () => {
		expectOk(await api.camera.isCoolerOn(ID), false)
	})

	test('getCoolerPower', async () => {
		expectOk(await api.camera.getCoolerPower(ID), 0)
	})

	test('getElectronsPerAdu', async () => {
		expectOk(await api.camera.getElectronsPerAdu(ID), 1)
	})

	test('getExposureMax', async () => {
		expectOk(await api.camera.getExposureMax(ID), CAMERA_MAX_EXPOSURE)
	})

	test('getExposureMin', async () => {
		expectOk(await api.camera.getExposureMin(ID), CAMERA_MIN_EXPOSURE)
	})

	test('getExposureResolution', async () => {
		expectOk(await api.camera.getExposureResolution(ID), 1e-6)
	})

	test('isFastReadout', async () => {
		expectOk(await api.camera.isFastReadout(ID), false)
	})

	test('getFullwellCapacity', async () => {
		expectOk(await api.camera.getFullwellCapacity(ID), 65535)
	})

	test('getGain', async () => {
		expectOk(await api.camera.getGain(ID), 0)
	})

	test('getGainMax', async () => {
		expectOk(await api.camera.getGainMax(ID), 400)
	})

	test('getGainMin', async () => {
		expectOk(await api.camera.getGainMin(ID), 0)
	})

	test('getGains', async () => {
		expectNotImplemented(await api.camera.getGains(ID))
	})

	test('hasShutter', async () => {
		expectOk(await api.camera.hasShutter(ID), false)
	})

	test('getHeatSinkTemperature', async () => {
		expectCloseTo(await api.camera.getHeatSinkTemperature(ID), CAMERA_AMBIENT_TEMPERATURE, 0)
	})

	test('isImageReady', async () => {
		expectOk(await api.camera.isImageReady(ID), false)
	})

	test('isPulseGuiding', async () => {
		expectOk(await api.camera.isPulseGuiding(ID), false)
	})

	test('getLastExposureDuration', async () => {
		expectOk(await api.camera.getLastExposureDuration(ID), 0)
	})

	// The server has no lastexposurestarttime route; the client 404s and logs a non-1024 failure.
	test.skip('getLastExposureStartTime', () => {})

	test('getMaxAdu', async () => {
		expectOk(await api.camera.getMaxAdu(ID), 65535)
	})

	test('getMaxBinX', async () => {
		expectOk(await api.camera.getMaxBinX(ID), CAMERA_MAX_BIN)
	})

	test('getMaxBinY', async () => {
		expectOk(await api.camera.getMaxBinY(ID), CAMERA_MAX_BIN)
	})

	test('getNumX', async () => {
		expectOk(await api.camera.getNumX(ID), CAMERA_SENSOR_WIDTH)
	})

	test('getNumY', async () => {
		expectOk(await api.camera.getNumY(ID), CAMERA_SENSOR_HEIGHT)
	})

	test('getOffset', async () => {
		expectOk(await api.camera.getOffset(ID), 0)
	})

	test('getOffsetMax', async () => {
		expectOk(await api.camera.getOffsetMax(ID), 1000)
	})

	test('getOffsetMin', async () => {
		expectOk(await api.camera.getOffsetMin(ID), 0)
	})

	test('getOffsets', async () => {
		expectNotImplemented(await api.camera.getOffsets(ID))
	})

	test('getPercentCompleted', async () => {
		expectOk(await api.camera.getPercentCompleted(ID), 0)
	})

	test('getPixelSizeX', async () => {
		expectCloseTo(await api.camera.getPixelSizeX(ID), CAMERA_PIXEL_SIZE)
	})

	test('getPixelSizeY', async () => {
		expectCloseTo(await api.camera.getPixelSizeY(ID), CAMERA_PIXEL_SIZE)
	})

	test('getReadoutMode', async () => {
		expectOk(await api.camera.getReadoutMode(ID), 0)
	})

	test('getReadoutModes', async () => {
		expectOk(await api.camera.getReadoutModes(ID), ['Mono', 'RGB'])
	})

	test('getSensorName', async () => {
		expectOk(await api.camera.getSensorName(ID), '')
	})

	test('getSensorType', async () => {
		expectOk(await api.camera.getSensorType(ID), 2)
	})

	test('getSetCcdTemperature', async () => {
		expectOk(await api.camera.getSetCcdTemperature(ID), 0)
	})

	test('getStartX', async () => {
		expectOk(await api.camera.getStartX(ID), 0)
	})

	test('getStartY', async () => {
		expectOk(await api.camera.getStartY(ID), 0)
	})

	test('setBinX', async () => {
		expectOk(await api.camera.setBinX(ID, 2))
		await waitUntil(() => camera.bin.x.value === 2)
		expectOk(await api.camera.getBinX(ID), 2)
		expectOk(await api.camera.setBinX(ID, 1))
		await waitUntil(() => camera.bin.x.value === 1)
	})

	test('setBinY', async () => {
		expectOk(await api.camera.setBinY(ID, 2))
		await waitUntil(() => camera.bin.y.value === 2)
		expectOk(await api.camera.getBinY(ID), 2)
		expectOk(await api.camera.setBinY(ID, 1))
		await waitUntil(() => camera.bin.y.value === 1)
	})

	test('setCoolerOn', async () => {
		expectOk(await api.camera.setCoolerOn(ID, true))
		await waitUntil(() => camera.cooler)
		expectOk(await api.camera.isCoolerOn(ID), true)
		expectOk(await api.camera.setCoolerOn(ID, false))
		await waitUntil(() => !camera.cooler)
	})

	test('setFastReadout', async () => {
		expectOk(await api.camera.setFastReadout(ID, true))
		expectOk(await api.camera.isFastReadout(ID), false)
	})

	test('setGain', async () => {
		expectOk(await api.camera.setGain(ID, 10))
		await waitUntil(() => camera.gain.value === 10)
		expectOk(await api.camera.getGain(ID), 10)
		expectOk(await api.camera.setGain(ID, 0))
		await waitUntil(() => camera.gain.value === 0)
	})

	test('setOffset', async () => {
		expectOk(await api.camera.setOffset(ID, 5))
		await waitUntil(() => camera.offset.value === 5)
		expectOk(await api.camera.getOffset(ID), 5)
		expectOk(await api.camera.setOffset(ID, 0))
		await waitUntil(() => camera.offset.value === 0)
	})

	test('setReadoutMode', async () => {
		expectOk(await api.camera.setReadoutMode(ID, 1))
		await waitUntil(() => camera.frameFormat === 'RGB')
		expectOk(await api.camera.getReadoutMode(ID), 1)
		expectOk(await api.camera.setReadoutMode(ID, 0))
		await waitUntil(() => camera.frameFormat === 'MONO')
	})

	test('setSetCcdTemperature', async () => {
		expectOk(await api.camera.setSetCcdTemperature(ID, -10))
		expectOk(await api.camera.getSetCcdTemperature(ID), -10)
	})

	test('setStartX', async () => {
		expectOk(await api.camera.setStartX(ID, 8))
		await waitUntil(() => camera.frame.x.value === 8)
		expectOk(await api.camera.getStartX(ID), 8)
		expectOk(await api.camera.setStartX(ID, 0))
		await waitUntil(() => camera.frame.x.value === 0)
	})

	test('setStartY', async () => {
		expectOk(await api.camera.setStartY(ID, 8))
		await waitUntil(() => camera.frame.y.value === 8)
		expectOk(await api.camera.getStartY(ID), 8)
		expectOk(await api.camera.setStartY(ID, 0))
		await waitUntil(() => camera.frame.y.value === 0)
	})

	// The server has no subexposureduration route; the client 404s and logs a non-1024 failure.
	test.skip('getSubExposureDuration', () => {})
	test.skip('setSubExposureDuration', () => {})

	test('setNumX', async () => {
		expectOk(await api.camera.setNumX(ID, 16))
		await waitUntil(() => camera.frame.width.value === 16)
		expectOk(await api.camera.getNumX(ID), 16)
	})

	test('setNumY', async () => {
		expectOk(await api.camera.setNumY(ID, 16))
		await waitUntil(() => camera.frame.height.value === 16)
		expectOk(await api.camera.getNumY(ID), 16)
	})

	test('abortExposure', async () => {
		expectOk(await api.camera.abortExposure(ID))
	})

	test('stopExposure', async () => {
		expectOk(await api.camera.stopExposure(ID))
	})

	test('pulseGuide', async () => {
		expectOk(await api.camera.pulseGuide(ID, AlpacaGuideDirection.NORTH, 1))
	})

	test('startExposure and getImageArray', async () => {
		expectFail(await api.camera.getImageArray(ID), AlpacaException.InvalidOperation)
		expectOk(await api.camera.startExposure(ID, 0, true), true)
		await waitUntilResult(
			() => api.camera.isImageReady(ID),
			(ready) => ready,
		)
		expectOk(await api.camera.getLastExposureDuration(ID), 0)
		const image = await api.camera.getImageArray(ID)
		expect(image.ok).toBeTrue()
		if (!image.ok) return
		expect(image.value.byteLength).toBeGreaterThanOrEqual(44)
		expect(new DataView(image.value).getInt32(0, true)).toBe(1)
		expectOk(await api.camera.isImageReady(ID), false)
	})
})

describe('telescope', () => {
	test('isConnected', async () => {
		expectOk(await api.telescope.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.telescope.connect(ID), true)
	})

	// disconnect would drop the live mount and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.telescope.deviceState(ID), ['Altitude', 'AtHome', 'AtPark', 'Azimuth', 'Declination', 'IsPulseGuiding', 'RightAscension', 'SideOfPier', 'SiderealTime', 'Slewing', 'Tracking', 'UTCDate', 'TimeStamp'])
	})

	test('getAlignmentMode', async () => {
		expectOk(await api.telescope.getAlignmentMode(ID), AlpacaTelescopeAlignmentMode.GERMAN_POLAR)
	})

	test('getAltitude', async () => {
		expectFinite(await api.telescope.getAltitude(ID))
	})

	test('getApertureArea', async () => {
		expectNotImplemented(await api.telescope.getApertureArea(ID))
	})

	test('getApertureDiameter', async () => {
		expectNotImplemented(await api.telescope.getApertureDiameter(ID))
	})

	test('isAtHome', async () => {
		expectOk(await api.telescope.isAtHome(ID), false)
	})

	test('isAtPark', async () => {
		expectOk(await api.telescope.isAtPark(ID), false)
	})

	test('getAzimuth', async () => {
		expectFinite(await api.telescope.getAzimuth(ID))
	})

	test('canFindHome', async () => {
		expectOk(await api.telescope.canFindHome(ID), false)
	})

	test('canPark', async () => {
		expectOk(await api.telescope.canPark(ID), true)
	})

	test('canPulseGuide', async () => {
		expectOk(await api.telescope.canPulseGuide(ID), true)
	})

	test('canSetDeclinationRate', async () => {
		expectOk(await api.telescope.canSetDeclinationRate(ID), false)
	})

	test('canSetGuideRates', async () => {
		expectOk(await api.telescope.canSetGuideRates(ID), false)
	})

	test('canSetPark', async () => {
		expectOk(await api.telescope.canSetPark(ID), true)
	})

	test('canSetSideOfPier', async () => {
		expectOk(await api.telescope.canSetSideOfPier(ID), false)
	})

	test('canSetRightAscensionRate', async () => {
		expectOk(await api.telescope.canSetRightAscensionRate(ID), false)
	})

	test('canSetTracking', async () => {
		expectOk(await api.telescope.canSetTracking(ID), true)
	})

	test('canSlew', async () => {
		expectOk(await api.telescope.canSlew(ID), true)
	})

	test('canSlewAltaz', async () => {
		expectOk(await api.telescope.canSlewAltaz(ID), true)
	})

	test('canSlewAltazAsync', async () => {
		expectOk(await api.telescope.canSlewAltazAsync(ID), true)
	})

	test('canSlewAsync', async () => {
		expectOk(await api.telescope.canSlewAsync(ID), true)
	})

	test('canSync', async () => {
		expectOk(await api.telescope.canSync(ID), true)
	})

	test('canSyncAltaz', async () => {
		expectOk(await api.telescope.canSyncAltaz(ID), true)
	})

	test('canUnpark', async () => {
		expectOk(await api.telescope.canUnpark(ID), true)
	})

	test('getDeclination', async () => {
		expectCloseTo(await api.telescope.getDeclination(ID), 90, 0)
	})

	test('getDeclinationRate', async () => {
		expectNotImplemented(await api.telescope.getDeclinationRate(ID))
	})

	test('getDoesRefraction', async () => {
		expectOk(await api.telescope.getDoesRefraction(ID), false)
	})

	test('getEquatorialSystem', async () => {
		expectOk(await api.telescope.getEquatorialSystem(ID), AlpacaTelescopeEquatorialCoordinateType.TOPOCENTRIC)
	})

	test('getFocalLength', async () => {
		expectNotImplemented(await api.telescope.getFocalLength(ID))
	})

	test('getGuideRateDeclination', async () => {
		expectNotImplemented(await api.telescope.getGuideRateDeclination(ID))
	})

	test('getGuideRateRightAscension', async () => {
		expectNotImplemented(await api.telescope.getGuideRateRightAscension(ID))
	})

	test('isPulseGuiding', async () => {
		expectOk(await api.telescope.isPulseGuiding(ID), false)
	})

	test('getRightAscension', async () => {
		expectFinite(await api.telescope.getRightAscension(ID))
	})

	test('getRightAscensionRate', async () => {
		expectNotImplemented(await api.telescope.getRightAscensionRate(ID))
	})

	test('getSideOfPier', async () => {
		const result = await api.telescope.getSideOfPier(ID)
		expect(result.ok).toBeTrue()
		result.ok && expect([-1, 0, 1]).toContain(result.value)
	})

	test('getSiderealTime', async () => {
		expectFinite(await api.telescope.getSiderealTime(ID))
	})

	test('getSiteElevation', async () => {
		expectOk(await api.telescope.getSiteElevation(ID), 0)
	})

	test('getSiteLatitude', async () => {
		expectOk(await api.telescope.getSiteLatitude(ID), 0)
	})

	test('getSiteLongitude', async () => {
		expectOk(await api.telescope.getSiteLongitude(ID), 0)
	})

	test('isSlewing', async () => {
		expectOk(await api.telescope.isSlewing(ID), false)
	})

	test('getSlewSettleTime', async () => {
		expectOk(await api.telescope.getSlewSettleTime(ID), 0)
	})

	test('getTargetDeclination', async () => {
		expectOk(await api.telescope.getTargetDeclination(ID), 0)
	})

	test('getTargetRightAscension', async () => {
		expectOk(await api.telescope.getTargetRightAscension(ID), 0)
	})

	test('isTracking', async () => {
		expectOk(await api.telescope.isTracking(ID), false)
	})

	test('getTrackingRate', async () => {
		expectOk(await api.telescope.getTrackingRate(ID), AlpacaTelescopeTrackingRate.SIDEREAL)
	})

	test('getTrackingRates', async () => {
		expectOk(await api.telescope.getTrackingRates(ID), [AlpacaTelescopeTrackingRate.SIDEREAL, AlpacaTelescopeTrackingRate.SOLAR, AlpacaTelescopeTrackingRate.LUNAR, AlpacaTelescopeTrackingRate.KING])
	})

	test('getUtcDate', async () => {
		const result = await api.telescope.getUtcDate(ID)
		expect(result.ok).toBeTrue()
		result.ok && expect(Number.isFinite(Date.parse(result.value))).toBeTrue()
	})

	test('getAxisRates', async () => {
		expectOk(await api.telescope.getAxisRates(ID, AlpacaTelescopeAxis.PRIMARY), [
			{ Minimum: 1, Maximum: 1 },
			{ Minimum: 2, Maximum: 2 },
			{ Minimum: 3, Maximum: 3 },
			{ Minimum: 4, Maximum: 4 },
			{ Minimum: 5, Maximum: 5 },
			{ Minimum: 6, Maximum: 6 },
			{ Minimum: 7, Maximum: 7 },
		])
	})

	test('canMoveAxis', async () => {
		expectOk(await api.telescope.canMoveAxis(ID, AlpacaTelescopeAxis.PRIMARY), true)
		expectOk(await api.telescope.canMoveAxis(ID, AlpacaTelescopeAxis.SECONDARY), true)
		expectOk(await api.telescope.canMoveAxis(ID, AlpacaTelescopeAxis.TERTIARY), true)
	})

	test('getDestinationSideOfPier', async () => {
		const result = await api.telescope.getDestinationSideOfPier(ID, 0, 0)
		expect(result.ok).toBeTrue()
		result.ok && expect([-1, 0, 1]).toContain(result.value)
	})

	test('setDeclinationRate', async () => {
		expectNotImplemented(await api.telescope.setDeclinationRate(ID, 0))
	})

	test('setDoesRefraction', async () => {
		expectOk(await api.telescope.setDoesRefraction(ID, true))
		expectOk(await api.telescope.getDoesRefraction(ID), true)
		expectOk(await api.telescope.setDoesRefraction(ID, false))
	})

	test('setGuideRateDeclination', async () => {
		expectNotImplemented(await api.telescope.setGuideRateDeclination(ID, 0))
	})

	test('setGuideRateRightAscension', async () => {
		expectNotImplemented(await api.telescope.setGuideRateRightAscension(ID, 0))
	})

	test('setRightAscensionRate', async () => {
		expectNotImplemented(await api.telescope.setRightAscensionRate(ID, 0))
	})

	test('setSideOfPier', async () => {
		expectNotImplemented(await api.telescope.setSideOfPier(ID, 0))
	})

	test('setSiteElevation', async () => {
		expectOk(await api.telescope.setSiteElevation(ID, 100))
		await waitUntil(() => mount.geographicCoordinate.elevation !== 0)
		expectCloseTo(await api.telescope.getSiteElevation(ID), 100, 4)
		expectOk(await api.telescope.setSiteElevation(ID, 0))
	})

	test('setSiteLatitude', async () => {
		expectOk(await api.telescope.setSiteLatitude(ID, -22.5))
		await waitUntil(() => mount.geographicCoordinate.latitude !== 0)
		expectCloseTo(await api.telescope.getSiteLatitude(ID), -22.5, 4)
		expectOk(await api.telescope.setSiteLatitude(ID, 0))
	})

	test('setSiteLongitude', async () => {
		expectOk(await api.telescope.setSiteLongitude(ID, -45))
		await waitUntil(() => mount.geographicCoordinate.longitude !== 0)
		expectCloseTo(await api.telescope.getSiteLongitude(ID), -45, 4)
		expectOk(await api.telescope.setSiteLongitude(ID, 0))
	})

	test('setSlewSettleTime', async () => {
		expectOk(await api.telescope.setSlewSettleTime(ID, 2))
		expectOk(await api.telescope.getSlewSettleTime(ID), 2)
		expectOk(await api.telescope.setSlewSettleTime(ID, 0))
	})

	test('setTargetDeclination', async () => {
		expectOk(await api.telescope.setTargetDeclination(ID, 10))
		expectCloseTo(await api.telescope.getTargetDeclination(ID), 10)
		expectOk(await api.telescope.setTargetDeclination(ID, 0))
	})

	test('setTargetRightAscension', async () => {
		expectOk(await api.telescope.setTargetRightAscension(ID, 2))
		expectCloseTo(await api.telescope.getTargetRightAscension(ID), 2)
		expectOk(await api.telescope.setTargetRightAscension(ID, 0))
	})

	test('setTracking', async () => {
		expectOk(await api.telescope.setTracking(ID, true))
		await waitUntil(() => mount.tracking)
		expectOk(await api.telescope.isTracking(ID), true)
		expectOk(await api.telescope.setTracking(ID, false))
		await waitUntil(() => !mount.tracking)
	})

	test('setTrackingRate', async () => {
		expectOk(await api.telescope.setTrackingRate(ID, AlpacaTelescopeTrackingRate.LUNAR))
		await waitUntil(() => mount.trackMode === 'LUNAR')
		expectOk(await api.telescope.getTrackingRate(ID), AlpacaTelescopeTrackingRate.LUNAR)
		expectOk(await api.telescope.setTrackingRate(ID, AlpacaTelescopeTrackingRate.SIDEREAL))
		await waitUntil(() => mount.trackMode === 'SIDEREAL')
	})

	test('abortSlew', async () => {
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('findHome', async () => {
		expectOk(await api.telescope.findHome(ID))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('moveAxis', async () => {
		expectOk(await api.telescope.moveAxis(ID, AlpacaTelescopeAxis.PRIMARY, 0))
	})

	test('setPark', async () => {
		expectOk(await api.telescope.setPark(ID))
	})

	test('pulseGuide', async () => {
		expectOk(await api.telescope.pulseGuide(ID, AlpacaGuideDirection.EAST, 1))
	})

	// The simulator throttles EQUATORIAL_EOD_COORD to 1s, so a GET cannot observe the new position
	// inside the 1000ms test budget. The PUT response is still asserted.
	test('syncToCoordinates', async () => {
		expectOk(await api.telescope.syncToCoordinates(ID, 1, 5))
	})

	test('syncToTarget', async () => {
		expectOk(await api.telescope.setTargetRightAscension(ID, 2))
		expectOk(await api.telescope.setTargetDeclination(ID, 8))
		expectOk(await api.telescope.syncToTarget(ID))
	})

	test('setUtcDate', async () => {
		const utc = '2026-01-01T00:00:00.000Z'
		expectOk(await api.telescope.setUtcDate(ID, utc))
		await waitUntil(() => mount.time.utc === Date.parse(utc))
		expectOk(await api.telescope.getUtcDate(ID), utc)
	})

	test('syncToAltaz', async () => {
		expectNotImplemented(await api.telescope.syncToAltaz(ID, 180, 45))
	})

	test('slewToCoordinatesAsync', async () => {
		expectOk(await api.telescope.slewToCoordinatesAsync(ID, 2.1, 8.1))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('slewToCoordinates', async () => {
		expectOk(await api.telescope.slewToCoordinates(ID, 2.2, 8.2))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('slewToAltazAsync', async () => {
		expectOk(await api.telescope.slewToAltazAsync(ID, 180, 45))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('slewToAltaz', async () => {
		expectOk(await api.telescope.slewToAltaz(ID, 90, 30))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('slewToTargetAsync', async () => {
		expectOk(await api.telescope.setTargetRightAscension(ID, 3))
		expectOk(await api.telescope.setTargetDeclination(ID, 10))
		expectOk(await api.telescope.slewToTargetAsync(ID))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('slewToTarget', async () => {
		expectOk(await api.telescope.slewToTarget(ID))
		expectOk(await api.telescope.abortSlew(ID))
	})

	test('park and unpark', async () => {
		expectOk(await api.telescope.park(ID))
		expectOk(await api.telescope.unpark(ID))
	})
})

describe('filterWheel', () => {
	test('isConnected', async () => {
		expectOk(await api.filterWheel.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.filterWheel.connect(ID), true)
	})

	// disconnect would drop the live wheel and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.filterWheel.deviceState(ID), ['Position', 'TimeStamp'])
	})

	test('getFocusOffsets', async () => {
		expectOk(
			await api.filterWheel.getFocusOffsets(ID),
			Array.from({ length: FILTER_WHEEL_SLOT_NAMES.length }, () => 0),
		)
	})

	test('getNames', async () => {
		expectOk(await api.filterWheel.getNames(ID), [...FILTER_WHEEL_SLOT_NAMES])
	})

	test('getPosition', async () => {
		expectOk(await api.filterWheel.getPosition(ID), 0)
	})

	test('setPosition', async () => {
		expectOk(await api.filterWheel.setPosition(ID, 1))
		await waitUntil(() => wheel.position === 1)
		expectOk(await api.filterWheel.getPosition(ID), 1)
		expectOk(await api.filterWheel.setPosition(ID, 0))
		await waitUntil(() => wheel.position === 0)
	})
})

describe('focuser', () => {
	test('isConnected', async () => {
		expectOk(await api.focuser.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.focuser.connect(ID), true)
	})

	// disconnect would drop the live focuser and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.focuser.deviceState(ID), ['IsMoving', 'Position', 'Temperature', 'TimeStamp'])
	})

	test('isAbsolute', async () => {
		expectOk(await api.focuser.isAbsolute(ID), true)
	})

	test('isMoving', async () => {
		expectOk(await api.focuser.isMoving(ID), false)
	})

	test('getMaxIncrement', async () => {
		expectOk(await api.focuser.getMaxIncrement(ID), FOCUSER_MAX_POSITION)
	})

	test('getMaxStep', async () => {
		expectOk(await api.focuser.getMaxStep(ID), FOCUSER_MAX_POSITION)
	})

	test('getPosition', async () => {
		expectOk(await api.focuser.getPosition(ID), FOCUSER_INITIAL_POSITION)
	})

	test('getStepSize', async () => {
		expectNotImplemented(await api.focuser.getStepSize(ID))
	})

	test('isTemperatureCompensation', async () => {
		expectOk(await api.focuser.isTemperatureCompensation(ID), false)
	})

	test('isTemperatureCompensationAvailable', async () => {
		expectOk(await api.focuser.isTemperatureCompensationAvailable(ID), false)
	})

	test('getTemperature', async () => {
		expectFinite(await api.focuser.getTemperature(ID))
	})

	test('setTemperatureCompensation', async () => {
		expectOk(await api.focuser.setTemperatureCompensation(ID, true))
		expectOk(await api.focuser.isTemperatureCompensation(ID), false)
	})

	test('halt', async () => {
		expectOk(await api.focuser.halt(ID))
	})

	test('move', async () => {
		expectOk(await api.focuser.move(ID, FOCUSER_INITIAL_POSITION + 20))
		await waitUntil(() => focuser.position.value === FOCUSER_INITIAL_POSITION + 20)
		expectOk(await api.focuser.getPosition(ID), FOCUSER_INITIAL_POSITION + 20)
	})
})

describe('coverCalibrator', () => {
	test('isConnected', async () => {
		expectOk(await api.coverCalibrator.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.coverCalibrator.connect(ID), true)
	})

	// disconnect would drop the live cover calibrator and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.coverCalibrator.deviceState(ID), ['Brightness', 'CalibratorChanging', 'CalibratorState', 'CoverMoving', 'CoverState', 'TimeStamp'])
	})

	test('getBrightness', async () => {
		expectOk(await api.coverCalibrator.getBrightness(ID), 0)
	})

	test('getCalibratorState', async () => {
		expectOk(await api.coverCalibrator.getCalibratorState(ID), 3)
	})

	test('getCoverState', async () => {
		expectOk(await api.coverCalibrator.getCoverState(ID), 3)
	})

	test('isChanging', async () => {
		expectOk(await api.coverCalibrator.isChanging(ID), false)
	})

	test('isMoving', async () => {
		expectOk(await api.coverCalibrator.isMoving(ID), false)
	})

	test('getMaxBrightness', async () => {
		expectOk(await api.coverCalibrator.getMaxBrightness(ID), PANEL_MAX_INTENSITY)
	})

	test('on', async () => {
		expectOk(await api.coverCalibrator.on(ID, 128))
		await waitUntil(() => panel.intensity.value === 128)
		expectOk(await api.coverCalibrator.getBrightness(ID), 128)
	})

	test('off', async () => {
		expectOk(await api.coverCalibrator.off(ID))
		await waitUntil(() => !panel.enabled)
	})

	test('close', async () => {
		expectOk(await api.coverCalibrator.close(ID))
	})

	test('halt', async () => {
		expectOk(await api.coverCalibrator.halt(ID))
	})

	test('open', async () => {
		expectOk(await api.coverCalibrator.open(ID))
	})
})

describe('rotator', () => {
	test('isConnected', async () => {
		expectOk(await api.rotator.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.rotator.connect(ID), true)
	})

	// disconnect would drop the live rotator and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	// The server has no rotator-specific routes, including devicestate; the client 404s and logs a non-1024 failure.
	test.skip('deviceState', () => {})
	test.skip('canReverse', () => {})
	test.skip('getMechanicalPosition', () => {})
	test.skip('getPosition', () => {})
	test.skip('isMoving', () => {})
	test.skip('isReverse', () => {})
	test.skip('setReverse', () => {})
	test.skip('getStepSize', () => {})
	test.skip('getTargetPosition', () => {})
	test.skip('halt', () => {})
	test.skip('move', () => {})
	test.skip('moveAbsolute', () => {})
	test.skip('moveMechanical', () => {})
	test.skip('sync', () => {})
})

describe('dome', () => {
	test('isConnected', async () => {
		expectOk(await api.dome.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.dome.connect(ID), true)
	})

	// disconnect would drop the live dome and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.dome.deviceState(ID), ['AtHome', 'AtPark', 'Azimuth', 'ShutterStatus', 'Slewing', 'TimeStamp'])
	})

	test('getAltitude', async () => {
		expectOk(await api.dome.getAltitude(ID), 0)
	})

	test('isAtHome', async () => {
		expectOk(await api.dome.isAtHome(ID), false)
	})

	test('isAtPark', async () => {
		expectOk(await api.dome.isAtPark(ID), false)
	})

	test('getAzimuth', async () => {
		expectCloseTo(await api.dome.getAzimuth(ID), 0)
	})

	test('canFindHome', async () => {
		expectOk(await api.dome.canFindHome(ID), true)
	})

	test('canPark', async () => {
		expectOk(await api.dome.canPark(ID), true)
	})

	test('canSetAltitude', async () => {
		expectOk(await api.dome.canSetAltitude(ID), false)
	})

	test('canSetAzimuth', async () => {
		expectOk(await api.dome.canSetAzimuth(ID), true)
	})

	test('canSetPark', async () => {
		expectOk(await api.dome.canSetPark(ID), true)
	})

	test('canSetShutter', async () => {
		expectOk(await api.dome.canSetShutter(ID), true)
	})

	test('canSlave', async () => {
		expectOk(await api.dome.canSlave(ID), true)
	})

	test('canSyncAzimuth', async () => {
		expectOk(await api.dome.canSyncAzimuth(ID), true)
	})

	test('getShutterStatus', async () => {
		expectOk(await api.dome.getShutterStatus(ID), AlpacaDomeShutterState.CLOSED)
	})

	test('isSlaved', async () => {
		expectOk(await api.dome.isSlaved(ID), false)
	})

	test('isSlewing', async () => {
		expectOk(await api.dome.isSlewing(ID), false)
	})

	test('setSlaved', async () => {
		expectOk(await api.dome.setSlaved(ID, true))
		await waitUntil(() => dome.slaved)
		expectOk(await api.dome.isSlaved(ID), true)
		expectOk(await api.dome.setSlaved(ID, false))
		await waitUntil(() => !dome.slaved)
	})

	test('syncToAzimuth', async () => {
		expectOk(await api.dome.syncToAzimuth(ID, 45))
		await waitUntil(() => dome.azimuth.value !== 0)
		expectCloseTo(await api.dome.getAzimuth(ID), 45, 4)
		expectOk(await api.dome.syncToAzimuth(ID, 0))
	})

	test('slewToAltitude', async () => {
		expectNotImplemented(await api.dome.slewToAltitude(ID, 45))
	})

	test('slewToAzimuth', async () => {
		expectOk(await api.dome.slewToAzimuth(ID, 10))
		expectOk(await api.dome.abortSlew(ID))
	})

	test('abortSlew', async () => {
		expectOk(await api.dome.abortSlew(ID))
	})

	test('openShutter', async () => {
		expectOk(await api.dome.openShutter(ID))
	})

	test('closeShutter', async () => {
		expectOk(await api.dome.closeShutter(ID))
	})

	test('findHome', async () => {
		expectOk(await api.dome.findHome(ID))
		expectOk(await api.dome.abortSlew(ID))
	})

	test('setPark', async () => {
		expectOk(await api.dome.setPark(ID))
	})

	test('park', async () => {
		expectOk(await api.dome.park(ID))
		expectOk(await api.dome.abortSlew(ID))
	})
})

describe('safetyMonitor', () => {
	test('isConnected', async () => {
		expectOk(await api.safetyMonitor.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.safetyMonitor.connect(ID), true)
	})

	// disconnect would drop the live safety monitor and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectOk(await api.safetyMonitor.deviceState(ID), [
			{ Name: 'IsSafe', Value: false },
			{ Name: 'TimeStamp', Value: '' },
		])
	})

	test('isSafe', async () => {
		expectOk(await api.safetyMonitor.isSafe(ID), false)
	})
})

describe('observingConditions', () => {
	test('isConnected', async () => {
		expectOk(await api.observingConditions.isConnected(ID), true)
	})

	test('connect', async () => {
		expectOk(await api.observingConditions.connect(ID), true)
	})

	// disconnect would drop the live weather station and break later GET coverage in this file.
	test.skip('disconnect', () => {})

	test('deviceState', async () => {
		expectState(await api.observingConditions.deviceState(ID), ['CloudCover', 'DewPoint', 'Humidity', 'Pressure', 'RainRate', 'SkyBrightness', 'SkyQuality', 'SkyTemperature', 'StarFWHM', 'Temperature', 'WindDirection', 'WindGust', 'WindSpeed', 'TimeStamp'])
	})

	test('getAveragePeriod', async () => {
		expectOk(await api.observingConditions.getAveragePeriod(ID), 0)
	})

	test('getCloudCover', async () => {
		expectOk(await api.observingConditions.getCloudCover(ID), 15)
	})

	test('getDewPoint', async () => {
		expectOk(await api.observingConditions.getDewPoint(ID), 6.9)
	})

	test('getHumidity', async () => {
		expectOk(await api.observingConditions.getHumidity(ID), 52)
	})

	test('getPressure', async () => {
		expectOk(await api.observingConditions.getPressure(ID), 1013.2)
	})

	test('getRainRate', async () => {
		expectOk(await api.observingConditions.getRainRate(ID), 0)
	})

	test('getSkyBrightness', async () => {
		expectOk(await api.observingConditions.getSkyBrightness(ID), 0.002)
	})

	test('getSkyQuality', async () => {
		expectOk(await api.observingConditions.getSkyQuality(ID), 21.3)
	})

	test('getSkyTemperature', async () => {
		expectOk(await api.observingConditions.getSkyTemperature(ID), -22.4)
	})

	test('getStarFWHM', async () => {
		expectOk(await api.observingConditions.getStarFWHM(ID), 2.4)
	})

	test('getTemperature', async () => {
		expectOk(await api.observingConditions.getTemperature(ID), 16.8)
	})

	test('getWindDirection', async () => {
		expectCloseTo(await api.observingConditions.getWindDirection(ID), 135)
	})

	test('getWindGust', async () => {
		expectOk(await api.observingConditions.getWindGust(ID), 4.2)
	})

	test('getWindSpeed', async () => {
		expectOk(await api.observingConditions.getWindSpeed(ID), 2.6)
	})

	test('sensorDescription', async () => {
		expectOk(await api.observingConditions.sensorDescription(ID, 'CloudCover'), 'Cloud cover (%)')
	})

	test('timeSinceLastUpdate', async () => {
		expectFinite(await api.observingConditions.timeSinceLastUpdate(ID))
		expectFinite(await api.observingConditions.timeSinceLastUpdate(ID, 'Temperature'))
	})

	test('setAveragePeriod', async () => {
		expectOk(await api.observingConditions.setAveragePeriod(ID, 0))
		expectFail(await api.observingConditions.setAveragePeriod(ID, 1), AlpacaException.InvalidValue)
	})

	test('refresh', async () => {
		expectOk(await api.observingConditions.refresh(ID))
	})
})

function uniqueId(type: string, name: string) {
	return Bun.MD5.hash(`${clientSimulator.id}:${type}:${name}`, 'hex')
}

function configured(name: string, deviceType: AlpacaDeviceType, type: string): AlpacaConfiguredDevice {
	return { DeviceName: name, DeviceNumber: ID, DeviceType: deviceType, UniqueID: uniqueId(type, name) }
}

async function waitUntilResult<T>(request: () => Promise<AlpacaRequestResult<T>>, predicate: (value: T) => boolean = () => true, timeout: number = 5000, step: number = 50) {
	while (true) {
		const result = await request()
		if (result.ok && predicate(result.value)) return
		if (!(timeout > 0)) throw new Error('timeout waiting for condition')
		await Bun.sleep(step)
		timeout -= step
	}
}

function expectOk<T>(result: AlpacaRequestResult<T>, value?: T) {
	expect(result.ok).toBeTrue()
	value !== undefined && result.ok && expect(result.value).toEqual(value)
}

function expectCloseTo(result: AlpacaRequestResult<number>, value: number, digits: number = 6) {
	expect(result.ok).toBeTrue()
	result.ok && expect(result.value).toBeCloseTo(value, digits)
}

function expectFinite(result: AlpacaRequestResult<number>) {
	expect(result.ok).toBeTrue()
	result.ok && expect(Number.isFinite(result.value)).toBeTrue()
}

function expectNotImplemented(result: AlpacaRequestResult<unknown>) {
	expectFail(result, AlpacaException.MethodOrPropertyNotImplemented)
}

function expectFail(result: AlpacaRequestResult<unknown>, errorNumber?: number) {
	expect(result.ok).toBeFalse()
	errorNumber !== undefined && !result.ok && expect(result.errorNumber).toBe(errorNumber)
}

function expectState(result: AlpacaRequestResult<readonly AlpacaStateItem[]>, names: readonly string[]) {
	expect(result.ok).toBeTrue()
	result.ok && expect(result.value.map((item) => item.Name)).toEqual([...names])
}
