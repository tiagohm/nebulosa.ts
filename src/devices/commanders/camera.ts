import type { Camera } from '../indi/device'
import type { CameraManager } from '../indi/manager/camera'
import { failedOperationResult, successfulOperationResult, type OperationResult, type OperationScope } from '../orchestration/operation'
import { resourceKey } from '../orchestration/resource'

// Coordinated thermal mutations of a camera.
// Exposures are owned by CameraCapturer, so what is left here is the cooling control: switching the cooler
// and setting its target. Neither waits for the sensor to reach the setpoint, which takes minutes and is
// reported continuously as a device update; they only dispatch the command. Both acquire the camera all the
// same, because changing the thermal state of a sensor that is integrating alters the dark current of the
// frame being exposed, and the resulting image would look plausible while being uncalibratable.
// Temperatures are degrees Celsius.

// Owns every thermal mutation of a camera.
// Each command opens its own nested scope holding the camera, so a direct endpoint runs it as a whole
// operation tree while a composite feature, passing its own context, inherits the camera it already owns.
export class CameraCommander {
	// Keeps the manager the commands are dispatched through.
	constructor(readonly cameraManager: CameraManager) {}

	// Switches the cooler on or off.
	async cooler(scope: OperationScope, camera: Camera, enabled: boolean): Promise<OperationResult<void>> {
		return await scope.start<void>('cameraCooler', [{ key: resourceKey(camera), device: camera }], () => {
			if (!camera.connected) return failedOperationResult('disconnected')
			if (!camera.hasCoolerControl) return failedOperationResult('unexpectedState', `camera ${camera.name} cannot switch its cooler`)

			this.cameraManager.cooler(camera, enabled)

			return successfulOperationResult(undefined)
		}).result
	}

	// Sets the cooling target, in degrees Celsius. The driver publishes no range for it, so a target the
	// sensor cannot reach is simply one the cooler keeps working towards.
	async temperature(scope: OperationScope, camera: Camera, value: number): Promise<OperationResult<void>> {
		return await scope.start<void>('cameraTemperature', [{ key: resourceKey(camera), device: camera }], () => {
			if (!camera.connected) return failedOperationResult('disconnected')
			if (!camera.canSetTemperature) return failedOperationResult('unexpectedState', `camera ${camera.name} cannot set its temperature`)

			this.cameraManager.temperature(camera, value)

			return successfulOperationResult(undefined)
		}).result
	}
}
