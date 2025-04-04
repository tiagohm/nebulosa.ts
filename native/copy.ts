import { $ } from 'bun'
import { suffix } from 'bun:ffi'

await $`cp native/${process.platform}-${process.arch}/libwcs.${suffix} native/libwcs.shared`
