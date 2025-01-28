// Represents a temperature quantity in celsius.
export type Temperature = number

// Creates a new Temperature from Fahrenheit.
export function fahrenheit(value: number): Temperature {
	return (value - 32) * (5 / 9)
}

// Creates a new Temperature from Kelvin.
export function kelvin(value: number): Temperature {
	return value - 273.15
}

// Converts the temperature to Fahrenheit.
export function toFahrenheit(value: Temperature): number {
	return value * 1.8 + 32
}

// Converts the temperature to Kelvin.
export function toKelvin(value: Temperature): number {
	return value + 273.15
}
