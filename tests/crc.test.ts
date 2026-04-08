import { describe, expect, test } from 'bun:test'
import { CRC, CRC_ALGORITHMS } from '../src/crc'

const buffer = Buffer.from('123456789', 'utf8')

test('crc3gsm', () => {
	expect(CRC.crc3gsm.compute(buffer)).toBe(0x04)
})

test('crc4itu', () => {
	expect(CRC.crc4itu.compute(buffer)).toBe(0x07)
})

test('crc4interlaken', () => {
	expect(CRC.crc4interlaken.compute(buffer)).toBe(0x0b)
})

test('crc5epc', () => {
	expect(CRC.crc5epc.compute(buffer)).toBe(0x00)
})

test('crc5itu', () => {
	expect(CRC.crc5itu.compute(buffer)).toBe(0x07)
})

test('crc5usb', () => {
	expect(CRC.crc5usb.compute(buffer)).toBe(0x19)
})

test('crc6cdma2000a', () => {
	expect(CRC.crc6cdma2000a.compute(buffer)).toBe(0x0d)
})

test('crc6cdma2000b', () => {
	expect(CRC.crc6cdma2000b.compute(buffer)).toBe(0x3b)
})

test('crc6darc', () => {
	expect(CRC.crc6darc.compute(buffer)).toBe(0x26)
})

test('crc6gsm', () => {
	expect(CRC.crc6gsm.compute(buffer)).toBe(0x13)
})

test('crc6itu', () => {
	expect(CRC.crc6itu.compute(buffer)).toBe(0x06)
})

test('crc7', () => {
	expect(CRC.crc7.compute(buffer)).toBe(0x75)
})

test('crc7umts', () => {
	expect(CRC.crc7umts.compute(buffer)).toBe(0x61)
})

test('crc8', () => {
	expect(CRC.crc8.compute(buffer)).toBe(0xf4)
})

test('crc8cdma2000', () => {
	expect(CRC.crc8cdma2000.compute(buffer)).toBe(0xda)
})

test('crc8darc', () => {
	expect(CRC.crc8darc.compute(buffer)).toBe(0x15)
})

test('crc8dvbs2', () => {
	expect(CRC.crc8dvbs2.compute(buffer)).toBe(0xbc)
})

test('crc8ebu', () => {
	expect(CRC.crc8ebu.compute(buffer)).toBe(0x97)
})

test('crc8icode', () => {
	expect(CRC.crc8icode.compute(buffer)).toBe(0x7e)
})

test('crc8itu', () => {
	expect(CRC.crc8itu.compute(buffer)).toBe(0xa1)
})

test('crc8maxim', () => {
	expect(CRC.crc8maxim.compute(buffer)).toBe(0xa1)
})

test('crc8rohc', () => {
	expect(CRC.crc8rohc.compute(buffer)).toBe(0xd0)
})

test('crc8wcdma', () => {
	expect(CRC.crc8wcdma.compute(buffer)).toBe(0x25)
})

test('crc10', () => {
	expect(CRC.crc10.compute(buffer)).toBe(0x0199)
})

test('crc10cdma2000', () => {
	expect(CRC.crc10cdma2000.compute(buffer)).toBe(0x0233)
})

test('crc10gsm', () => {
	expect(CRC.crc10gsm.compute(buffer)).toBe(0x012a)
})

test('crc11', () => {
	expect(CRC.crc11.compute(buffer)).toBe(0x05a3)
})

test('crc12', () => {
	expect(CRC.crc12.compute(buffer)).toBe(0x0f5b)
})

test('crc12cdma2000', () => {
	expect(CRC.crc12cdma2000.compute(buffer)).toBe(0x0d4d)
})

test('crc12gsm', () => {
	expect(CRC.crc12gsm.compute(buffer)).toBe(0x0b34)
})

test('crc13bbc', () => {
	expect(CRC.crc13bbc.compute(buffer)).toBe(0x04fa)
})

test('crc14darc', () => {
	expect(CRC.crc14darc.compute(buffer)).toBe(0x082d)
})

test('crc14gsm', () => {
	expect(CRC.crc14gsm.compute(buffer)).toBe(0x30ae)
})

test('crc15can', () => {
	expect(CRC.crc15can.compute(buffer)).toBe(0x059e)
})

test('crc15mpt1327', () => {
	expect(CRC.crc15mpt1327.compute(buffer)).toBe(0x2566)
})

test('crc16', () => {
	expect(CRC.crc16.compute(buffer)).toBe(0xbb3d)
})

test('crc16ccittfalse', () => {
	expect(CRC.crc16ccittfalse.compute(buffer)).toBe(0x29b1)
})

test('crc16augccitt', () => {
	expect(CRC.crc16augccitt.compute(buffer)).toBe(0xe5cc)
})

test('crc16buypass', () => {
	expect(CRC.crc16buypass.compute(buffer)).toBe(0xfee8)
})

test('crc16cdma2000', () => {
	expect(CRC.crc16cdma2000.compute(buffer)).toBe(0x4c06)
})

test('crc16dds110', () => {
	expect(CRC.crc16dds110.compute(buffer)).toBe(0x9ecf)
})

test('crc16dectr', () => {
	expect(CRC.crc16dectr.compute(buffer)).toBe(0x007e)
})

test('crc16dectx', () => {
	expect(CRC.crc16dectx.compute(buffer)).toBe(0x007f)
})

test('crc16dnp', () => {
	expect(CRC.crc16dnp.compute(buffer)).toBe(0xea82)
})

test('crc16en13757', () => {
	expect(CRC.crc16en13757.compute(buffer)).toBe(0xc2b7)
})

test('crc16genibus', () => {
	expect(CRC.crc16genibus.compute(buffer)).toBe(0xd64e)
})

test('crc16maxim', () => {
	expect(CRC.crc16maxim.compute(buffer)).toBe(0x44c2)
})

test('crc16mcrf4cc', () => {
	expect(CRC.crc16mcrf4cc.compute(buffer)).toBe(0x6f91)
})

test('crc16riello', () => {
	expect(CRC.crc16riello.compute(buffer)).toBe(0x63d0)
})

test('crc16t10dif', () => {
	expect(CRC.crc16t10dif.compute(buffer)).toBe(0xd0db)
})

test('crc16teledisk', () => {
	expect(CRC.crc16teledisk.compute(buffer)).toBe(0x0fb3)
})

test('crc16tms13157', () => {
	expect(CRC.crc16tms13157.compute(buffer)).toBe(0x26b1)
})

test('crc16usb', () => {
	expect(CRC.crc16usb.compute(buffer)).toBe(0xb4c8)
})

test('crca', () => {
	expect(CRC.crca.compute(buffer)).toBe(0xbf05)
})

test('crc16kermit', () => {
	expect(CRC.crc16kermit.compute(buffer)).toBe(0x2189)
})

test('crc16modbus', () => {
	expect(CRC.crc16modbus.compute(buffer)).toBe(0x4b37)
})

test('crc16x25', () => {
	expect(CRC.crc16x25.compute(buffer)).toBe(0x906e)
})

test('crc16xmodem', () => {
	expect(CRC.crc16xmodem.compute(buffer)).toBe(0x31c3)
})

test('crc17can', () => {
	expect(CRC.crc17can.compute(buffer)).toBe(0x004f03)
})

test('crc21can', () => {
	expect(CRC.crc21can.compute(buffer)).toBe(0x0ed841)
})

test('crc24', () => {
	expect(CRC.crc24.compute(buffer)).toBe(0x21cf02)
})

test('crc24ble', () => {
	expect(CRC.crc24ble.compute(buffer)).toBe(0xc25a56)
})

test('crc24flexraya', () => {
	expect(CRC.crc24flexraya.compute(buffer)).toBe(0x7979bd)
})

test('crc24flexrayb', () => {
	expect(CRC.crc24flexrayb.compute(buffer)).toBe(0x1f23b8)
})

test('crc24ltea', () => {
	expect(CRC.crc24ltea.compute(buffer)).toBe(0xcde703)
})

test('crc24lteb', () => {
	expect(CRC.crc24lteb.compute(buffer)).toBe(0x23ef52)
})

test('crc24os9', () => {
	expect(CRC.crc24os9.compute(buffer)).toBe(0x200fa5)
})

test('crc30cdma', () => {
	expect(CRC.crc30cdma.compute(buffer)).toBe(0x04c34abf)
})

test('crc32', () => {
	expect(CRC.crc32.compute(buffer)).toBe(0xcbf43926)
})

test('crc32mhash', () => {
	expect(CRC.crc32mhash.compute(buffer)).toBe(0x181989fc)
})

test('crc32bzip2', () => {
	expect(CRC.crc32bzip2.compute(buffer)).toBe(0xfc891918)
})

test('crc32c', () => {
	expect(CRC.crc32c.compute(buffer)).toBe(0xe3069283)
})

test('crc32d', () => {
	expect(CRC.crc32d.compute(buffer)).toBe(0x87315576)
})

test('crc32mpeg2', () => {
	expect(CRC.crc32mpeg2.compute(buffer)).toBe(0x0376e6e7)
})

test('crc32posix', () => {
	expect(CRC.crc32posix.compute(buffer)).toBe(0x765e7680)
})

test('crc32q', () => {
	expect(CRC.crc32q.compute(buffer)).toBe(0x3010bf7f)
})

test('crc32jamcrc', () => {
	expect(CRC.crc32jamcrc.compute(buffer)).toBe(0x340bc6d9)
})

test('crc32xfer', () => {
	expect(CRC.crc32xfer.compute(buffer)).toBe(0xbd0be338)
})

test('crc32 should match Bun.hash.crc32', () => {
	for (let i = 0; i < 1024; i++) {
		const buffer = Buffer.alloc(1 + Math.floor(Math.random() * 100))
		for (let i = 0; i < buffer.byteLength; i++) buffer[i] = Math.ceil(Math.random() * 256)
		expect(CRC.crc32.compute(buffer)).toBe(Bun.hash.crc32(buffer))
	}
})

describe('crc should support seed', () => {
	for (const algorithm of CRC_ALGORITHMS) {
		test(algorithm, () => {
			let checksum: number | undefined

			for (let i = 0; i < buffer.byteLength; i++) {
				checksum = CRC[algorithm].compute(buffer.subarray(i, i + 1), checksum)
			}

			expect(checksum).toBe(CRC[algorithm].compute(buffer))
		})
	}
})
