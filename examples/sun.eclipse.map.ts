import { deg } from '../src/angle'
import { TAU, PIOVERTWO } from '../src/constants'
import { PlateCarree } from '../src/projection'
import { nearestSolarEclipse } from '../src/sun'
import { type SolarEclipseMapSvgPaths, type SolarEclipseMapPoints, computeSunMoonPositionAt, type SolarEclipseMapGeometryOptions, computePolynomialBesselianElements, computeSolarEclipseFillGeometry, computeSolarEclipseMapGeometry, geoPolygonsToSvgPathData, solarEclipseMapToSvgPaths } from '../src/sun.eclipse'
import { timeYMD, timeToDate, type Time } from '../src/time'
import * as vsop87e from '../src/vsop87e'
import * as elpmpp02 from '../src/elpmpp02'

function makeSvg(paths: SolarEclipseMapSvgPaths, fill: string, width: number, height: number) {
	function marker(point: SolarEclipseMapPoints[keyof SolarEclipseMapPoints], label: string, color: string) {
		return point ? `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="${color}" /><text x="${(point.x + 5).toFixed(2)}" y="${(point.y - 5).toFixed(2)}">${label}</text>` : ''
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<style>
.ocean { fill: #103099; }
.umbrafill { fill: rgba(250, 250, 250, 0.3); stroke: none; }
.umbra { fill: none; stroke: #CCC; stroke-width: 1; }
.center { fill: none; stroke: #000; stroke-width: 1; }
.penumbra { fill: none; stroke: #11c0cc; stroke-width: 0.8; }
.riseset { fill: none; stroke: orange; stroke-width: 0.8; }
text { font: 14px sans-serif; fill: #fff; }
</style>
<rect class="ocean" x="0" y="0" width="${width}" height="${height}" />
<path class="penumbra" d="${paths.penumbraNorth}" />
<path class="penumbra" d="${paths.penumbraSouth}" />
<path class="riseset" d="${paths.riseSetCurves}" />
<path class="umbrafill" d="${fill}" />
<path class="umbra" d="${paths.umbraNorth}" />
<path class="umbra" d="${paths.umbraSouth}" />
<path class="center" d="${paths.centerLine}" />
${marker(paths.points.P1, 'P1', '#11c0cc')}
${marker(paths.points.P4, 'P4', '#11c0cc')}
${marker(paths.points.P2, 'P2', '#11c0cc')}
${marker(paths.points.P3, 'P3', '#11c0cc')}
${marker(paths.points.U1, 'U1', '#11cc9d')}
${marker(paths.points.U4, 'U4', '#11cc9d')}
${marker(paths.points.U2, 'U2', '#11cc9d')}
${marker(paths.points.U3, 'U3', '#11cc9d')}
${marker(paths.points.C1, 'C1', '#cc0000')}
${marker(paths.points.C2, 'C2', '#cc0000')}
${marker(paths.points.N1, 'N1', '#11c0cc')}
${marker(paths.points.N2, 'N2', '#11c0cc')}
${marker(paths.points.S1, 'S1', '#11c0cc')}
${marker(paths.points.S2, 'S2', '#11c0cc')}
${marker(paths.points.Max, 'Max', '#e8a000')}
</svg>`
}

let solarEclipse = nearestSolarEclipse(timeYMD(2000, 1, 1), true)
let date = timeToDate(solarEclipse.maximalTime)

const getSunMoonPosition = (time: Time) => computeSunMoonPositionAt(time, vsop87e.sun, vsop87e.earth, elpmpp02.moon)
const options: SolarEclipseMapGeometryOptions = { longitudeStep: deg(0.5), maxAngularStep: deg(0.5), includeRiseSetCurves: true, riseSetStep: 600 }

const WIDTH = 2400 // 2520.631
const HEIGHT = 1200 // 1260.315

const projection = new PlateCarree(0, {
	// Longitude spans 2*PI across the full width, so one radian maps to width / TAU pixels.
	scale: WIDTH / TAU,
	falseEasting: WIDTH / 2,
	falseNorthing: HEIGHT / 2,
	yAxisDirection: 'southUp',
	centralMeridian: 0,
	longitudeWrapMode: 'pi',
	// Allow the full latitude range up to the poles; the default caps at the Web Mercator limit.
	maxLatitude: PIOVERTWO,
})

const IMAGEMAGICK_PATH = process.platform === 'win32' ? 'c:\\Program Files\\ImageMagick\\magick.exe' : 'magick'

function pad(number: number) {
	return number.toFixed(0).padStart(2, '0')
}

const HASHES: Readonly<Record<string, string>> = {
	'2000-02-05': 'bae2aa5e2882fddd97db177acdcd81964de59b34a5e778d3bb4c426ba0f263e2',
	'2000-07-01': '8996fbee4b779d8f775318fe848f03d5bc0fa3b57360171f1874bfdc2a47e6dd',
	'2000-07-31': '98273a98b2cd4732e68f8a2c1257dde6783eb6225c12441eeb45b0322cee9fa1',
	'2000-12-25': '823fd300fd8cd45834d1822ea15e129d5eb211f6b6ecdb1d998287d1a22f235b',
	'2001-06-21': '0d10ff7ebe3625f0b57ac89906bb23d96d68f527c845d1d0a0e70963fded670a',
	'2001-12-14': 'e0b0ceccfdbaecb26269e90f65e253856775d09f9446cf030a15f04764f12072',
	'2002-06-10': 'c8547a944263d46122c64debd2cfadd15e53050edfc6e915eb5ccb2af6f2bc98',
	'2002-12-04': 'f8b22b878d621d83218f8eba7aa1ea65bc057fbc2454ccba0bd5ba37d9e9ff9f',
	'2003-05-31': 'ef53de342936cc9383c9f8241d62aa3f0139a4a64127089dbb5306641b92265e',
	'2003-11-23': '9c4f05bc9db6a8706348458e03ca46607ffc220790e01977a4dadcd98de31660',
	'2004-04-19': '7f0b5e31ad3982e1771f963cd82c37634e7b0cfa06fde74119d66e83da848cfb',
	'2004-10-14': '90853ac750051525e69f4feea9eac63408ec2676b8d871a5195c41b51b1ca299',
	'2005-04-08': '6b8e12fe301d0a9731b8e2a5b60631883899462de8639b85b321549018415519',
	'2005-10-03': '85ac47c272a362032bb0fac3c52b24dac7ee9aeceae4960782155917d1365df7',
	'2006-03-29': 'f9560c952c027c8baed03b07b689c276216158c1b496f575b96880eed8687b17',
	'2006-09-22': '3a82c7b118c5989afc1213c18ca9d62e8447bca5f5771b4860ee6403eea1a425',
	'2007-03-19': '91cb0920d7265573db14863394c3749cb7875a380bd0655ddb1f5d39558c8cdf',
	'2007-09-11': '267e3365ba3db40b30ebdc9a4a18c7eff8146b68484c0833b6b8e8cf836d14aa',
	'2008-02-07': 'f3d8f68de461f8899eee7a2796d62553c2941821b0860e789c5d8434b12893d3',
	'2008-08-01': '1a68198105ae3ed46127784ae83759bdcf7c65bc42bd4d130ae2f68efe4e8581',
	'2009-01-26': 'cdfae74c7caa29a274804d9e81c055839e9ac58cf5443803312d96184182bdd5',
	'2009-07-22': 'e3706c89ec1a7b036b2a24e0392759db36ab38d06addcd31516d5232fa816e26',
	'2010-01-15': 'a6e19eabef89dcf35df2681716e6789eb8973a171f7df4a13f89dae3a6872ffb',
	'2010-07-11': '62cd1e21a1b063bd97ea81762d972048e1e11388266b6e14aeb58d9eaa1822e7',
	'2011-01-04': 'ffa5041e361dcc8086f750daebf8f989cd6bded62475b766fcb9b20ab66610e5',
	'2011-06-01': 'eb80e6edd53c3835a78b6e6726af5d7d5419c588077fc99e7cef678522a49100',
	'2011-07-01': '0c3bed7ce190c402f333c94883aa1d2ba94c38e003a8dc1bc9870eab990000b3',
	'2011-11-25': '6c05f73a4437b3510f14274b3a30bf61d8914930fa2caa4c9a69a4aba78865fd',
	'2012-05-20': '00a7078a64af9f0df3e61d0ca71e1be03f667a3dd52506f9d0848536cfd7a168',
	'2012-11-13': 'b9f83b29626d66debcbc69505fef37ec8988ded7ff82b34c665f8840562091c4',
	'2013-05-10': 'ee512baff9b6ab0799fe01ea64f17e801dee66aaf10ad79670e9fa855c3d4be1',
	'2013-11-03': '88439106d6a38847b807e2b86fefe5c3dbfa8fea50785ff942b43e4d6618a06c',
	'2014-04-29': '5a64341464ba7a47272c7cc02382030e3f7c51f91bbf2c70b630f4600e1227a0',
	'2014-10-23': '7afde29d3d745e9890e0b4555b4b480d8043ea5731ee80bfa769431f287fb49e',
	'2015-03-20': 'db031fcd085c7a6ee6b86fc740acf84fcbeba164089394ac159468a062f0d57c',
	'2015-09-13': '46d4549d27ca0ae7de611c9e758ee77148f6a11f5db7ef7713f8cabbd307c21e',
	'2016-03-09': '3b44ddfc53026bf05db1019e763904cf8932e3135478644553c9b113259aaeed',
	'2016-09-01': 'ba65f2f9407da5e7c036aded11b3bdb2592385c0426993418482981b36bbc579',
	'2017-02-26': 'af8cd8407e23f7d3e773ba6fce7a3dfb57c1beba93769e7e1e7c9c30461108f6',
	'2017-08-21': 'c5178c54321025222eb2bb001d3bf0f5bb2b7efb730efc3649e6dec7f6f25438',
	'2018-02-15': '61c90f00ec370b24b2d310932424eac99c16772d196a3be6ccb94007e06814bb',
	'2018-07-13': '8a670a9a541bf22b53edfed0ecf659b3ed9252464ae1d949f5aff530779b46b7',
	'2018-08-11': '496e89633b8d25b2b369980bbfb976e877cf5599252e11fc7af10564c13424f7',
	'2019-01-06': '21c4046fdc088e1008c0ebcb68734b74bdd9e92a05ac568dc818e2854213aa95',
	'2019-07-02': '5015789bf5d3f8fcdcd8230601559c79be2fb91be3111fc41f17a81b3c998ad1',
	'2019-12-26': '25538a281c6cdd05f7a7e201103d9cb7a52fba7dcfda7fe085f2d77544b2a368',
	'2020-06-21': 'c8d4bcac6bb667d0b3cdfc819567dee5c5aaa0cc94dd21a61479420f6be9affe',
	'2020-12-14': 'a2f27b529dabf450017ca77bdcc2a2dbe0ae5aec535c5f1580c35b6d7ea28283',
	'2021-06-10': '586818358bad4fa2b495a3c07777c67e2e542adb9be20c023078a2445f5b69d4',
	'2021-12-04': 'ab450ce812e18264d7d51589f8303f022c63756505cd9cc147e03d5f04709a6f',
	'2022-04-30': '5e578587bd557c721ae8a8edaeda611dbe18babf1567ab1ce09bc8f571f79153',
	'2022-10-25': 'e1ed3a733542716596ffe998bcc7e7144d5835e2f887c31d39e9efb33f1801d1',
	'2023-04-20': '48f520e000761568ed2f5ed4e016e59a21fef6ab2c14b57ea35e71b8dd944fe6',
	'2023-10-14': 'e923f7814ab4b28666c1dfb7a49de1c1811ab69b9cd2fb7c3c2a4e66c1d5f471',
	'2024-04-08': 'cfcbe3ff9809bb422faca4766d78f2af226fa52897f20010e3055101ab1e6f2d',
	'2024-10-02': '787825999e9829c894fdd8c078ba76dfac855c30d001a19a8dc889c32f1976c2',
	'2025-03-29': '78f620a5fcbef417540a6c0c1a3e2a8abc0e8f4ec054e95f0fa8ae2220c505aa',
	'2025-09-21': '5badfeb9c748f6034dd659dda7eb97ffdc46b183661c918f98bee2909844e6a2',
}

const TASKS: Promise<unknown>[] = []

console.time('solar eclipses')

while (date[0] <= 2025) {
	const eclipse = solarEclipse
	const { maximalTime } = eclipse
	const id = `${date[0]}-${pad(date[1])}-${pad(date[2])}`
	const name = `solar-eclipse-${id}`

	console.time(id)
	const pbe = computePolynomialBesselianElements(maximalTime, getSunMoonPosition)
	const geo = computeSolarEclipseMapGeometry(eclipse, pbe, options)
	const paths = solarEclipseMapToSvgPaths(geo, projection)
	// The visual-only totality/annularity fill is derived from the umbra limits, isolated from the physical lines.
	const fill = geoPolygonsToSvgPathData(computeSolarEclipseFillGeometry(geo), projection)
	const svg = makeSvg(paths, fill, WIDTH, HEIGHT)
	console.timeEnd(id)

	async function execute() {
		await Bun.write(`data/${name}.svg`, svg)
		await Bun.$`${IMAGEMAGICK_PATH} data/${name}.svg -strip data/${name}.png`
		const hash = Bun.SHA256.hash(await Bun.file(`data/${name}.png`).arrayBuffer(), 'hex')
		// console.info(`'${id}':`, "'" + hash + "',")
		console.info(id, HASHES[id] === hash ? '✅' : '❌ ' + hash)
	}

	TASKS.push(Promise.try(execute))

	solarEclipse = nearestSolarEclipse(maximalTime, true)
	date = timeToDate(solarEclipse.maximalTime)
}

await Promise.all(TASKS)

console.timeEnd('solar eclipses')
