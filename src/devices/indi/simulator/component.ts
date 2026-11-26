import { type DefNumberVector, type DefSwitchVector, makeNumberVector, makeSwitchVector, type NewNumberVector, type NewSwitchVector } from '../types'
import type { SimulatorProperty } from './types'

// Building blocks of a simulated device: a device is a board of independent circuits, each owning its
// INDI properties, its state and the commands addressed to those properties. The device only routes
// commands to its circuits, publishes what they notify and drives their clock, so every circuit can be
// constructed and exercised alone, with a fake bus and an explicit time, without a client or a timer.

// What a circuit is wired to on its device: where it publishes a property that changed, and the clock
// it reads. Times are milliseconds since the Unix epoch on whichever clock the device runs on.
export interface ComponentBus {
	// Publishes the current state of one of the circuit's properties.
	readonly notify: (property: SimulatorProperty) => void
	// Current time, milliseconds.
	readonly now: () => number
}

// A circuit of a simulated device.
//
// Subclasses declare the properties they define and publish, the subset that must not be persisted,
// and override the handlers of the commands they understand. A handler returns whether the command was
// addressed to this circuit, which is what lets the device stop routing it.
export abstract class SimulatorComponent {
	// Properties this circuit defines on connection, in publication order.
	abstract readonly properties: readonly SimulatorProperty[]
	// Properties excluded from persistence: read-only readings and momentary commands.
	readonly transient: readonly SimulatorProperty[] = []

	// `bus` is where the circuit publishes and reads the time.
	constructor(protected readonly bus: ComponentBus) {}

	// Handles a number command, returning whether it was addressed to this circuit.
	handleNumber(vector: NewNumberVector): boolean {
		return false
	}

	// Handles a switch command, returning whether it was addressed to this circuit.
	handleSwitch(vector: NewSwitchVector): boolean {
		return false
	}

	// Advances the circuit to `now`, milliseconds. Called on every tick of the device while connected.
	tick(now: number) {
		// A circuit without dynamics has nothing to advance.
	}

	// Returns the circuit to rest when the device disconnects: momentary activity stops, configuration
	// is kept.
	reset() {
		// A circuit without momentary activity has nothing to stop.
	}

	// Called once persisted values were written straight into the properties, bypassing the handlers,
	// so a circuit caching anything derived from them rebuilds it.
	loaded() {
		// A circuit that reads its properties directly has nothing to rebuild.
	}
}

// Assigns the device name to every property of the circuits, which are created before they know it.
export function assignComponentDevice(components: readonly SimulatorComponent[], device: string) {
	for (const component of components) {
		for (const property of component.properties) property.device = device
	}
}

// Properties of every circuit, in circuit order.
export function componentProperties(components: readonly SimulatorComponent[]) {
	return components.flatMap((component) => component.properties)
}

// Non-persisted properties of every circuit, in circuit order.
export function transientComponentProperties(components: readonly SimulatorComponent[]) {
	return components.flatMap((component) => component.transient)
}

// Routes a number command to the first circuit that handles it, returning whether one did.
export function routeNumber(components: readonly SimulatorComponent[], vector: NewNumberVector) {
	for (const component of components) {
		if (component.handleNumber(vector)) return true
	}

	return false
}

// Routes a switch command to the first circuit that handles it, returning whether one did.
export function routeSwitch(components: readonly SimulatorComponent[], vector: NewSwitchVector) {
	for (const component of components) {
		if (component.handleSwitch(vector)) return true
	}

	return false
}

// One element of a number property bound to the numeric setting `key`: element name, label, setting,
// minimum, maximum, step and printf format.
export type NumberBinding<K extends string> = readonly [element: string, label: string, key: K, min: number, max: number, step: number, format: string]

// One element of a non-exclusive switch property bound to the boolean setting `key`.
export type FlagBinding<K extends string> = readonly [element: string, label: string, key: K]

// One element of an exclusive switch property standing for the choice `value`.
export type ChoiceBinding<V extends string> = readonly [element: string, label: string, value: V]

// Builds a read-write number property in `group` whose elements start at the bound settings of `values`.
export function makeBoundNumberVector<K extends string>(name: string, label: string, group: string, bindings: readonly NumberBinding<K>[], values: Readonly<Record<K, number>>) {
	return makeNumberVector('', name, label, group, 'rw', ...bindings.map(([element, elementLabel, key, min, max, step, format]) => [element, elementLabel, values[key], min, max, step, format] as [string, string, number, number, number, number, string]))
}

// Reads the bound settings back out of a number property built by makeBoundNumberVector.
export function readBoundNumberVector<K extends string>(vector: DefNumberVector, bindings: readonly NumberBinding<K>[]) {
	const values = {} as Record<K, number>
	for (const [element, , key] of bindings) values[key] = vector.elements[element].value
	return values
}

// Builds a read-write AnyOfMany switch property in `group` whose elements start at the bound flags.
export function makeFlagVector<K extends string>(name: string, label: string, group: string, bindings: readonly FlagBinding<K>[], values: Readonly<Record<K, boolean>>) {
	return makeSwitchVector('', name, label, group, 'AnyOfMany', 'rw', ...bindings.map(([element, elementLabel, key]) => [element, elementLabel, values[key]] as [string, string, boolean]))
}

// Reads the bound flags back out of a switch property built by makeFlagVector.
export function readFlagVector<K extends string>(vector: DefSwitchVector, bindings: readonly FlagBinding<K>[]) {
	const values = {} as Record<K, boolean>
	for (const [element, , key] of bindings) values[key] = vector.elements[element].value
	return values
}

// Builds a read-write OneOfMany switch property in `group` with `selected` on.
export function makeChoiceVector<V extends string>(name: string, label: string, group: string, choices: readonly ChoiceBinding<V>[], selected: V) {
	return makeSwitchVector('', name, label, group, 'OneOfMany', 'rw', ...choices.map(([element, elementLabel, value]) => [element, elementLabel, value === selected] as [string, string, boolean]))
}

// Reads the selected choice out of a switch property built by makeChoiceVector, the first choice when
// none is on.
export function readChoiceVector<V extends string>(vector: DefSwitchVector, choices: readonly ChoiceBinding<V>[]) {
	for (const [element, , value] of choices) if (vector.elements[element]?.value) return value
	return choices[0][2]
}
