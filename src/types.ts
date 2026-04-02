export type Brand<T, U> = T & { __brand: U }
export type DeepReadonly<T> = { readonly [K in keyof T]: T[K] extends object ? DeepReadonly<T[K]> : T[K] }
export type DeepRequired<T> = Required<{ [K in keyof T]: T[K] extends Required<T[K]> ? T[K] : DeepRequired<T[K]> }>
export type DeepWritable<T> = { -readonly [K in keyof T]: T[K] extends object ? DeepWritable<T[K]> : T[K] }
export type Exact<T extends object> = Brand<T, keyof T>
export type Nullable<T> = T | null
export type OmitByValue<T, V> = Pick<T, { [K in keyof T]-?: T[K] extends V ? never : K }[keyof T]>
export type OmitByValueExact<T, V> = Pick<T, { [K in keyof T]-?: [V] extends [T[K]] ? ([T[K]] extends [V] ? never : K) : K }[keyof T]>
export type PartialKeys<T extends object> = keyof { [K in keyof T as T extends Required<Pick<T, K>> ? never : K]: never }
export type PartialOnly<T extends object, K extends keyof T = keyof T> = Omit<T, K> & Partial<Pick<T, K>>
export type PickByValue<T, V> = Pick<T, { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T]>
export type PickByValueExact<T, V> = Pick<T, { [K in keyof T]-?: [V] extends [T[K]] ? ([T[K]] extends [V] ? K : never) : never }[keyof T]>
export type Prettify<T> = T extends (...args: never) => unknown ? T : { [K in keyof T]: T[K] }
export type Primitive = string | number | boolean | bigint | symbol | undefined | null
export type RequiredOnly<T extends object, K extends keyof T = keyof T> = Omit<T, K> & Required<Pick<T, K>>
export type Tuple<T = unknown> = [T?, ...T[]]
export type UnionKeys<T> = keyof UnionToIntersection<T extends T ? Record<keyof T, never> : never>
export type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never // https://stackoverflow.com/a/50375286
export type Writable<T extends object> = { -readonly [P in keyof T]: T[P] }

export interface Newable<T> {
	new (...args: unknown[]): T
}
