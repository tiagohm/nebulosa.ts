import { suffix } from 'bun:ffi'
import { $ } from 'bun'

await $`cp native/${process.platform}-${process.arch}/libwcs.${suffix} native/libwcs.shared`
await $`cp native/${process.platform}-${process.arch}/libturbojpeg.${suffix} native/libturbojpeg.shared`
