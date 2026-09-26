// Firmata wire command IDs, operation bits and parser bounds shared by incoming
// message parsing and outgoing codecs. Values follow the Firmata protocol.
// https://github.com/firmata/protocol/blob/master/protocol.md

// Standard digital port report command; low nibble is the port index.
export const DIGITAL_MESSAGE = 0x90

// Standard analog channel report command; low nibble is the channel index.
export const ANALOG_MESSAGE = 0xe0

// Enable or disable reporting for one analog channel.
export const REPORT_ANALOG = 0xc0

// Enable or disable reporting for one eight-pin digital port.
export const REPORT_DIGITAL = 0xd0

// Assign one physical pin to a reported Firmata mode.
export const SET_PIN_MODE = 0xf4

// Write a zero or one value to one digital pin.
export const SET_DIGITAL_PIN_VALUE = 0xf5

// Query or report the two-byte protocol version.
export const REPORT_VERSION = 0xf9

// Reset the firmware state without a SysEx envelope.
export const SYSTEM_RESET = 0xff

// Begin a feature-specific SysEx message.
export const START_SYSEX = 0xf0

// Terminate a feature-specific SysEx message.
export const END_SYSEX = 0xf7

// Serial 1.0 configuration, control, data and reply feature ID.
export const SERIAL_MESSAGE = 0x60

// Encoder attachment, position and reporting feature ID.
export const ENCODER_DATA = 0x61

// AccelStepper and MultiStepper command and reply feature ID.
export const ACCELSTEPPER_DATA = 0x62

// Report an analog sample wider than the standard 14-bit message.
export const EXTENDED_REPORT_ANALOG = 0x64

// Query or set a typed firmware system variable.
export const SYSTEM_VARIABLE = 0x66

// Configure SPI and exchange words with a selected device.
export const SPI_DATA = 0x68

// Configure servo pulse widths in microseconds.
export const SERVO_CONFIG = 0x70

// Carry text as pairs of seven-bit bytes.
export const STRING_DATA = 0x71

// Carry 1-Wire bus commands and replies.
export const ONE_WIRE_DATA = 0x73

// Attach, detach and report DHT temperature and humidity.
export const DHTSENSOR_DATA = 0x74

// Issue an I2C read, write or stop command.
export const TWO_WIRE_REQUEST = 0x76

// Report I2C address, register and received bytes.
export const TWO_WIRE_REPLY = 0x77

// Set the I2C read delay in microseconds.
export const TWO_WIRE_CONFIG = 0x78

// Write an analog value wider than the standard 14-bit message.
export const EXTENDED_ANALOG = 0x6f

// Request the current mode and value of one pin.
export const PIN_STATE_QUERY = 0x6d

// Report the current mode and value of one pin.
export const PIN_STATE_RESPONSE = 0x6e

// Request the supported modes and resolutions of all pins.
export const CAPABILITY_QUERY = 0x6b

// Report per-pin modes and resolutions.
export const CAPABILITY_RESPONSE = 0x6c

// Request analog-channel-to-physical-pin mapping.
export const ANALOG_MAPPING_QUERY = 0x69

// Report analog-channel-to-physical-pin mapping.
export const ANALOG_MAPPING_RESPONSE = 0x6a

// Query or report firmware version and name.
export const REPORT_FIRMWARE = 0x79

// Configure or report board sampling interval in milliseconds.
export const SAMPLING_INTERVAL = 0x7a

// Create, fill, schedule and inspect firmware tasks.
export const SCHEDULER_DATA = 0x7b

// Query the current sampling interval in milliseconds.
export const SAMPLING_INTERVAL_QUERY = 0x7c

// Configure and report raw edge-count samples.
export const FREQUENCY_COMMAND = 0x7d

// Firmware marker for a pin excluded from capability and state tracking.
export const PIN_MODE_IGNORE = 0x7f

// I2C request operation bits for a write.
export const TWO_WIRE_WRITE = 0x00

// I2C request operation bits for a single read.
export const TWO_WIRE_READ = 0x08

// I2C request operation bits for repeated reads.
export const TWO_WIRE_READ_CONTINUOUS = 0x10

// I2C request operation bits to stop repeated reads.
export const TWO_WIRE_STOP_READ = 0x18

// Request all ROM addresses on a 1-Wire bus.
export const ONE_WIRE_SEARCH_REQUEST = 0x40

// Select the power mode of a 1-Wire bus.
export const ONE_WIRE_CONFIG_REQUEST = 0x41

// Identify an all-ROM search reply.
export const ONE_WIRE_SEARCH_REPLY = 0x42

// Identify a correlated read reply.
export const ONE_WIRE_READ_REPLY = 0x43

// Request only alarm-signalling 1-Wire ROM addresses.
export const ONE_WIRE_SEARCH_ALARMS_REQUEST = 0x44

// Identify an alarm-ROM search reply.
export const ONE_WIRE_SEARCH_ALARMS_REPLY = 0x45

// Request a bus reset before the 1-Wire operation.
export const ONE_WIRE_RESET_REQUEST_BIT = 0x01

// Broadcast the 1-Wire operation with SKIP ROM.
export const ONE_WIRE_SKIP_REQUEST_BIT = 0x02

// Select a specific eight-byte 1-Wire ROM address.
export const ONE_WIRE_SELECT_REQUEST_BIT = 0x04

// Read a correlated number of bytes after the 1-Wire command.
export const ONE_WIRE_READ_REQUEST_BIT = 0x08

// Delay the 1-Wire command before reading.
export const ONE_WIRE_DELAY_REQUEST_BIT = 0x10

// Write raw bytes during the 1-Wire command.
export const ONE_WIRE_WRITE_REQUEST_BIT = 0x20

// Smallest board sampling interval, in milliseconds.
export const MIN_SAMPLING_INTERVAL = 1

// Largest sampling interval representable in two seven-bit bytes, in milliseconds.
export const MAX_SAMPLING_INTERVAL = 16383

// Initial per-message parser scratch capacity, in bytes.
export const INITIAL_FIRMATA_BUFFER_SIZE = 256

// Largest SysEx scratch capacity, in bytes; oversized frames are discarded.
export const MAX_FIRMATA_BUFFER_SIZE = 1 << 20
