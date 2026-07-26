import { ASEC2RAD, DAYSEC, DEG2RAD, MOON_SIDEREAL_DAYS, SIDEREAL_DAYSEC, SIDEREAL_RATE, TAU } from '../../../core/constants'

// Shared physical limits, timings, property groups, and presets for the INDI device simulators.

// Simulation tick period, milliseconds.
export const TICK_INTERVAL_MS = 100
// Tracking drift rates (radians/second) for each track mode: sidereal, solar, lunar, and King.
export const SIDEREAL_DRIFT_RATE = TAU / SIDEREAL_DAYSEC
export const SOLAR_DRIFT_RATE = TAU / (365.2422 * DAYSEC)
export const LUNAR_DRIFT_RATE = TAU / (MOON_SIDEREAL_DAYS * DAYSEC)
export const KING_DRIFT_RATE = (SIDEREAL_RATE - 15.0369) * ASEC2RAD
// Maximum guide rate as a fraction of sidereal.
export const MAX_GUIDE_RATE = 1
// Most guide pulses that can be outstanding on one axis at a time. Beyond this the queue is full and
// further commands are dropped, which is what a controller does when driven faster than it executes.
export const MAX_QUEUED_GUIDE_PULSES = 8
// Seed of the deterministic generator used for guide-latency jitter, so sessions are reproducible.
export const GUIDE_JITTER_SEED = 0x5f3a1c27
// Boresight samples a mount keeps for exposure integration. At the default tick this covers a bit
// over thirteen minutes; an exposure longer than that trails only over the retained window, with
// everything before it collapsed onto the oldest sample. Three Float64Array of this length cost about
// 197 KB per simulated mount.
//
// Sized for a DARV run rather than for an ordinary sub-exposure. A drift-alignment leg is chosen to
// make a small polar error visible, not to keep the field still, so its exposure runs to several
// minutes per leg and a window that merely spanned a typical sub-exposure truncated a third of the
// trail.
export const MOUNT_TRAJECTORY_CAPACITY = 8192
// Most positions an exposure is integrated over. Bounds the cost of a badly drifting mount, at the
// price of under-resolving a trail longer than half this many pixels.
//
// Known limit: a drift-alignment run deliberately sweeps the field hundreds of pixels, so its trail
// comes out as this many discrete images of each star rather than a continuous line. Rendering one
// faithfully would need a sample per pixel of trail, or segments instead of points in the image
// generator; neither is worth it for a case the rest of the simulator does not depend on.
export const MAX_TRAJECTORY_SAMPLES = 64
// Field displacement, in unbinned pixels, that each integration sample is allowed to cover. Half a
// pixel keeps a trail continuous without over-sampling a field that barely moves.
export const TRAJECTORY_PIXELS_PER_SAMPLE = 0.5
// Multiplier applied to the selected manual slew rate when running an automatic goto, home or park,
// so that a commanded slew is faster than nudging the axes by hand.
export const SLEW_SPEED_FACTOR = 3
// Simulated camera sensor geometry and limits: pixels, pixel size (µm), max binning, exposure bounds (s),
// ambient/default temperatures (°C), the deterministic scene RNG seed, and BLOB padding (bytes).
export const CAMERA_SENSOR_WIDTH = 1280
export const CAMERA_SENSOR_HEIGHT = 1024
export const CAMERA_PIXEL_SIZE = 5.2
export const CAMERA_MAX_BIN = 4
export const CAMERA_MIN_EXPOSURE = 0.001
export const CAMERA_MAX_EXPOSURE = 3600
export const CAMERA_AMBIENT_TEMPERATURE = 18
export const CAMERA_DEFAULT_TARGET_TEMPERATURE = 0
export const CAMERA_SCENE_SEED = 0x1d0f3a57
export const CAMERA_BLOB_PADDING = 16384
// Upper bound, in unbinned pixels, for the margin by which the synthetic star field extends beyond
// every sensor edge. The margin itself is derived from the configured pointing error, but the star
// count grows with the enlarged area, so a multi-degree error would otherwise generate millions of
// stars. Past this cap the trailing edge of a displaced field thins out, which is an acceptable
// trade for an error already far larger than the sensor itself.
export const CAMERA_MAX_SCENE_MARGIN = 1024
// Simulated focuser: travel range and initial position (steps), move rate (steps/second), and the
// temperature model (amplitude °C, period s) plus temperature-compensation gain (steps) and hysteresis (°C).
export const FOCUSER_MAX_POSITION = 100000
export const FOCUSER_INITIAL_POSITION = 50000
export const FOCUSER_MOVE_RATE = 20000
export const FOCUSER_TEMPERATURE_AMPLITUDE = 4
export const FOCUSER_TEMPERATURE_PERIOD_SECONDS = 40
export const FOCUSER_TEMPERATURE_COMPENSATION_STEPS = -250
export const FOCUSER_TEMPERATURE_COMPENSATION_HYSTERESIS = 0.05
// Simulated filter wheel slot labels and per-slot move time (ms).
export const FILTER_WHEEL_SLOT_NAMES = ['L', 'R', 'G', 'B', 'Ha', 'SII', 'OIII', 'Dark'] as const
export const FILTER_WHEEL_MOVE_TIME_MS = 250
// Simulated rotator slew rate (degrees/second).
export const ROTATOR_MOVE_RATE = 90
// Simulated cover open/close time (ms) and flat-panel maximum intensity.
export const COVER_MOVE_TIME_MS = 500
export const PANEL_MAX_INTENSITY = 255

// Mount slew-rate presets (name/label and angular speed in radians/second).
export const SLEW_RATES = [
	{ name: 'SPEED_1', label: ' 0.5°', speed: 0.5 * DEG2RAD },
	{ name: 'SPEED_2', label: ' 1.0°', speed: 1 * DEG2RAD },
	{ name: 'SPEED_3', label: ' 2.0°', speed: 2 * DEG2RAD },
	{ name: 'SPEED_4', label: ' 4.0°', speed: 4 * DEG2RAD },
	{ name: 'SPEED_5', label: ' 8.0°', speed: 8 * DEG2RAD },
	{ name: 'SPEED_6', label: '16.0°', speed: 16 * DEG2RAD },
	{ name: 'SPEED_7', label: '32.0°', speed: 32 * DEG2RAD },
] as const

// INDI property group labels shared by the simulated devices.
export const MAIN_CONTROL = 'Main Control'
export const GENERAL_INFO = 'General Info'
export const SIMULATION = 'Simulation'
