export type PropertyState = 'Idle' | 'Ok' | 'Busy' | 'Alert'

export type SwitchRule = 'OneOfMany' | 'AtMostOne' | 'AnyOfMany'

export type PropertyPermission = 'ro' | 'wo' | 'rw'

export type BlobEnable = 'Never' | 'Also' | 'Only'

export type VectorType = 'Text' | 'Number' | 'Switch' | 'Light' | 'BLOB'

export type ValueType = string | number | boolean

// Commands from Device to Client:

// Command to enable snooping messages from other devices. Once enabled, defXXX and setXXX messages
// for the Property with the given name and other messages from the device will be sent to this
// driver channel. Enables messages from all devices if device is not specified, and all Properties
// for the given device if name is not specified. Specifying name without device is not defined.
export interface GetProperties {
	device?: string
	name?: string
}

// Define a property that holds one or more text elements.
export interface DefTextVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, DefText>
}

// Define one member of a text vector.
export interface DefText {
	name: string
	label?: string
	value: string
}

// Define a property that holds one or more numeric values.
export interface DefNumberVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, DefNumber>
}

// Define one member of a number vector.
export interface DefNumber {
	name: string
	label?: string
	format: string
	min: number
	max: number
	step: number
	value: number
}

// Define a collection of switches. Rule is only a hint for use by a GUI to decide a suitable
// presentation style. Rules are actually implemented wholly within the Device.
export interface DefSwitchVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	rule: SwitchRule
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, DefSwitch>
}

// Define one member of a switch vector.
export interface DefSwitch {
	name: string
	label?: string
	value: boolean
}

// Define a collection of passive indicator lights.
export interface DefLightVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	timestamp?: string
	message?: string
	elements: Record<string, DefLight>
}

// Define one member of a light vector.
export interface DefLight {
	name: string
	label?: string
	value: PropertyState
}

// Define a property that holds one or more Binary Large Objects, BLOBs.
export interface DefBlobVector {
	device: string
	name: string
	label?: string
	group?: string
	state: PropertyState
	permission: PropertyPermission
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, DefBlob>
}

// Define one member of a BLOB vector. Unlike other defXXX elements, this does not contain an
// initial value for the BLOB.
export interface DefBlob {
	name: string
	label?: string
	value?: never
}

export type DefVector = DefTextVector | DefNumberVector | DefSwitchVector | DefLightVector | DefBlobVector
export type DefElement = DefText | DefNumber | DefSwitch | DefLight | DefBlob

// Send a new set of values for a Text vector, with optional new timeout, state and message.
export interface SetTextVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneText>
}

// Send a new set of values for a Number vector, with optional new timeout, state and message.
export interface SetNumberVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneNumber>
}

// Send a new set of values for a Switch vector, with optional new timeout, state and message.
export interface SetSwitchVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneSwitch>
}

// Send a new set of values for a Light vector, with optional new state and message.
export interface SetLightVector {
	device: string
	name: string
	state?: PropertyState
	timestamp?: string
	message?: string
	elements: Record<string, OneLight>
}

// Send a new set of values for a BLOB vector, with optional new timeout, state and message.
export interface SetBlobVector {
	device: string
	name: string
	state?: PropertyState
	timeout?: number
	timestamp?: string
	message?: string
	elements: Record<string, OneBlob>
}

export type SetVector = SetTextVector | SetNumberVector | SetSwitchVector | SetLightVector | SetBlobVector

// Send a message associated with a device or entire system.
export interface Message {
	id: string
	device?: string
	timestamp?: string
	message: string
}

// Delete the given property, or entire device if no property is specified.
export interface DelProperty {
	device: string
	name?: string
	timestamp?: string
	message?: string
}

// Send a message to specify state of one member of a Light vector.
export interface OneLight {
	name: string
	value: PropertyState
}

// Commands from Client to Device:

// Command to control whether setBLOBs should be sent to this channel from a given Device. They can
// be turned off completely by setting Never (the default), allowed to be intermixed with other INDI
// commands by setting Also or made the only command by setting Only.
export interface EnableBlob {
	device: string
	name?: string
	value: BlobEnable
}

// Commands to inform Device of new target values for a Property. After sending, the Client must set
// its local state for the Property to Busy, leaving it up to the Device to change it when it sees
// fit.

export interface NewTextVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, string>
}

export interface NewNumberVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, number>
}

export interface NewSwitchVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, boolean>
}

export interface NewBlobVector {
	device: string
	name: string
	timestamp?: string
	elements: Record<string, OneBlob>
}

export type NewVector = NewTextVector | NewNumberVector | NewSwitchVector | NewBlobVector

// Elements describing a vector member value, used in both directions:

// One member of a Text vector.
export interface OneText {
	name: string
	value: string
}

// One member of a Number vector.
export interface OneNumber {
	name: string
	value: number
}

// One member of a Switch vector.
export interface OneSwitch {
	name: string
	value: boolean
}

// One member of a BLOB vector. The contents of this element must always be encoded using base647.
// The format attribute consists of one or more file name suffixes, each preceded with a period,
// which indicate how the decoded data is to be interpreted. For example .fits indicates the decoded
// BLOB is a FITS8 file, and .fits.z indicates the decoded BLOB is a FITS file compressed with
// zlib9. The INDI protocol places no restrictions on the contents or formats of BLOBs but at
// minimum astronomical INDI clients are encouraged to support the FITS image file format and the
// zlib compression mechanism. The size attribute indicates the number of bytes in the final BLOB
// after decoding and after any decompression. For example, if the format is .fits.z the size
// attribute is the number of bytes in the FITS file. A Client unfamiliar with the specified format
// may use the attribute as a simple string, perhaps in combination with the timestamp attribute, to
// create a file name in which to store the data without processing other than decoding the base64.
export interface OneBlob {
	name: string
	size: string
	format: string
	value: string | Buffer<ArrayBuffer> // Buffer is used by Alpaca to avoid base64 encoding
}

export type OneElement = OneText | OneNumber | OneSwitch | OneLight | OneBlob

export type TextVector = DefTextVector | SetTextVector | NewTextVector
export type NumberVector = DefNumberVector | SetNumberVector | NewNumberVector
export type SwitchVector = DefSwitchVector | SetSwitchVector | NewSwitchVector
export type LightVector = DefLightVector | SetLightVector
export type BlobVector = DefBlobVector | SetBlobVector | NewBlobVector

export type TextElement = OneText | DefText
export type NumberElement = OneNumber | DefNumber
export type SwitchElement = OneSwitch | DefSwitch
export type LightElement = OneLight | DefLight
export type BlobElement = OneBlob | DefBlob

export function findOnSwitch(vector: SwitchVector) {
	const { elements } = vector

	return Object.keys(vector.elements).filter((e) => {
		const value = elements[e]
		if (typeof value === 'boolean') return value
		return value.value
	})
}
