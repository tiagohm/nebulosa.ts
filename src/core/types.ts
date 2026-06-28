// Generic TypeScript utility types shared across the library: branded primitives, deep
// readonly/writable/required transforms, value-based key filtering, and union manipulation helpers.
// These are compile-time-only constructs with no runtime footprint.

// Nominally tags type `T` with marker `U` so structurally identical primitives stay distinguishable.
export type Brand<T, U> = T & { __brand: U }
// Recursively marks every property of `T` (and nested objects) as readonly.
export type DeepReadonly<T> = T extends Primitive ? T : { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] }
// Recursively marks every property of `T` (and nested objects) as required.
export type DeepRequired<T> = T extends Primitive ? T : Required<{ [K in keyof T]: T[K] extends Required<T[K]> ? T[K] : DeepRequired<T[K]> }>
// Recursively strips readonly from every property of `T` (and nested objects).
export type DeepWritable<T> = T extends Primitive ? T : { -readonly [K in keyof T]: T[K] extends object ? DeepWritable<T[K]> : T[K] }
// Brands `T` by its own keys so excess-property structural matches are rejected.
export type Exact<T extends object> = Brand<T, keyof T>
// `T` or `null`.
export type Nullable<T> = T | null
// Keeps only the properties of `T` whose value type is not assignable to `V`.
export type OmitByValue<T, V> = Pick<T, { [K in keyof T]-?: T[K] extends V ? never : K }[keyof T]>
// Like `OmitByValue` but using an exact (bidirectional) value-type match instead of assignability.
export type OmitByValueExact<T, V> = Pick<T, { [K in keyof T]-?: [V] extends [T[K]] ? ([T[K]] extends [V] ? never : K) : K }[keyof T]>
// Union of the keys of `T` that are optional.
export type PartialKeys<T extends object> = keyof { [K in keyof T as T extends Required<Pick<T, K>> ? never : K]: never }
// Makes only the keys `K` of `T` optional, leaving the rest unchanged.
export type PartialOnly<T extends object, K extends keyof T = keyof T> = Omit<T, K> & Partial<Pick<T, K>>
// Keeps only the properties of `T` whose value type is assignable to `V`.
export type PickByValue<T, V> = Pick<T, { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T]>
// Like `PickByValue` but using an exact (bidirectional) value-type match instead of assignability.
export type PickByValueExact<T, V> = Pick<T, { [K in keyof T]-?: [V] extends [T[K]] ? ([T[K]] extends [V] ? K : never) : never }[keyof T]>
// Flattens an intersection/mapped type into a plain object shape for clearer tooltips; leaves functions untouched.
export type Prettify<T> = T extends (...args: never) => unknown ? T : { [K in keyof T]: T[K] }
// The set of JavaScript primitive types.
export type Primitive = string | number | boolean | bigint | symbol | undefined | null
// Makes only the keys `K` of `T` required, leaving the rest unchanged.
export type RequiredOnly<T extends object, K extends keyof T = keyof T> = Omit<T, K> & Required<Pick<T, K>>
// A non-empty tuple whose first element is optional and tail is variadic.
export type Tuple<T = unknown> = [T?, ...T[]]
// Union of all keys appearing across the members of union `T`.
export type UnionKeys<T> = keyof UnionToIntersection<T extends T ? Record<keyof T, never> : never>
// Converts a union `U` into the intersection of its members.
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never // https://stackoverflow.com/a/50375286
// Strips readonly from the top-level properties of `T`.
export type Writable<T extends object> = { -readonly [P in keyof T]: T[P] }

// A constructor type producing instances of `T`.
export interface Newable<T> {
	new (...args: unknown[]): T
}
