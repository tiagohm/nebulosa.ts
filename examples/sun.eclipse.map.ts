import { deg } from '../src/angle'
import { TAU, PIOVERTWO } from '../src/constants'
import { PlateCarree } from '../src/projection'
import { nearestSolarEclipse } from '../src/sun'
import { type SolarEclipseMapSvgPaths, type SolarEclipseMapPoints, computeSunMoonPositionAt, type SolarEclipseMapGeometryOptions, computePolynomialBesselianElements, computeSolarEclipseMapGeometry, solarEclipseMapToSvgPaths } from '../src/sun.eclipse'
import { timeYMD, timeToDate, type Time } from '../src/time'
import * as vsop87e from '../src/vsop87e'
import * as elpmpp02 from '../src/elpmpp02'

function makeSvg(paths: SolarEclipseMapSvgPaths, width: number, height: number) {
	function marker(point: SolarEclipseMapPoints[keyof SolarEclipseMapPoints], label: string, color: string) {
		return point ? `<circle cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="3" fill="${color}" /><text x="${(point.x + 5).toFixed(2)}" y="${(point.y - 5).toFixed(2)}">${label}</text>` : ''
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
<style>
.ocean { fill: #103099; }
.umbra { fill: none; stroke: #FFE66D; stroke-width: 2; stroke-linecap: round; }
.center { fill: none; stroke: #FF2ED1; stroke-width: 2; stroke-linecap: round; }
.penumbra { fill: none; stroke: #FF9F1C; stroke-width: 2; stroke-linecap: round; }
.riseset { fill: none; stroke: #00E5FF; stroke-width: 2; }
text { font: 14px sans-serif; font-weight: bold; fill: #fff; }
</style>
<rect class="ocean" x="0" y="0" width="${width}" height="${height}" />
<path class="penumbra" d="${paths.penumbraNorth}" />
<path class="penumbra" d="${paths.penumbraSouth}" />
<path class="riseset" d="${paths.riseSetCurves}" />
<path class="umbra" d="${paths.umbraNorth}" />
<path class="umbra" d="${paths.umbraSouth}" />
<path class="center" d="${paths.centerLine}" />
${marker(paths.points.P1, 'P1', '#FF9F1C')}
${marker(paths.points.P4, 'P4', '#FF9F1C')}
${marker(paths.points.P2, 'P2', '#FF9F1C')}
${marker(paths.points.P3, 'P3', '#FF9F1C')}
${marker(paths.points.U1, 'U1', '#FFE66D')}
${marker(paths.points.U4, 'U4', '#FFE66D')}
${marker(paths.points.U2, 'U2', '#FFE66D')}
${marker(paths.points.U3, 'U3', '#FFE66D')}
${marker(paths.points.C1, 'C1', '#FF7BEA')}
${marker(paths.points.C2, 'C2', '#FF7BEA')}
${marker(paths.points.N1, 'N1', '#35FF7A')}
${marker(paths.points.N2, 'N2', '#35FF7A')}
${marker(paths.points.S1, 'S1', '#FF4D4D')}
${marker(paths.points.S2, 'S2', '#FF4D4D')}
${marker(paths.points.Max, 'Max', '#FFFFFF')}
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

function pad(number: number) {
	return number.toFixed(0).padStart(2, '0')
}

const HASHES: Readonly<Record<string, string>> = {
	'2000-02-05': 'bf0bd227bb220e05f7176d0f0721d3215a2598ea08e11563a81c16c0608f5df0',
	'2000-07-01': '81c18e29e0c54ad51a27b2fb3c827e9b9c99f3d311709b583a732ac7c5773ff2',
	'2000-07-31': 'bc9d8aec234b7bb8c3f74e79dc85c78a28421fb6ee82204bf1373dad1ca69971',
	'2000-12-25': '78c9ff997696f3b2dd21ce67c263c45c1194de97a4cc57bedfe883698de688bc',
	'2001-06-21': 'a6e04d709051e39c947d493cdf5a9c46ad97245d0838422239c4593e6a192dd6',
	'2001-12-14': '01477091f8cd42a53d5797662485d88ff8e08a4f64a617f316d35c3ea4a12c1f',
	'2002-06-10': '0bc57ce19dbadd81c1aa4fd26d857982a746f7406c2a0f32746dbdba1485a0c4',
	'2002-12-04': 'd3733f17f7c00dccd831d16b69450975d76352efedac0ef5871caca4ffb8f8b6',
	'2003-05-31': 'c8f331e2c08c88fbc9518e262872cbcec741bc0535c26f2348bdb57e73e8e475',
	'2003-11-23': '3c03b3ccef920194ba232978b884bc9e611ec3d8faa17680a76293072cc10991',
	'2004-04-19': 'bafb02e1df3b8ca0fc00d51a44b64e4c08434d8aa00b42937376df94fecacda1',
	'2004-10-14': 'f6e2a9ce8c326d57906ae8df8fbeec20a1bb081c7d26465db5de0cc19eec095b',
	'2005-04-08': 'e58c1bf3ab5f32b90bb659a0f2f0d217d8b3978efff96b7396b47ae611cc94df',
	'2005-10-03': '1d987e6b5d851c47be8a4aca864f16ecd0596e26308e090000c6e7f6cd3b1f4f',
	'2006-03-29': 'e3346e44a487682ff5723edbc7725bf9378230b394ba65cec73d7de14fac083a',
	'2006-09-22': '29cc0c74f1faade99df665a9b00ab6d03792245cc233c70891b989e4acfbb3eb',
	'2007-03-19': '1c65029dcf3641f6c54f2b28210ec072f45a8acce0f8f1750d577c4a0eab6f0f',
	'2007-09-11': '6d5e34d7bb81b786bf5a2669d620ced5af3d83c0151845b3afa5f446893570bb',
	'2008-02-07': 'b0fed906d37624a83d8b0454daa5ad4aad87de28ec2c26989b5aafe7b013864f',
	'2008-08-01': '4de6c6601e66ee27ce1cef1e7b252a42df84e4709dc6d8ba8d8fca61e3d6b7f8',
	'2009-01-26': '2afe7ba14371f5a4263431da855970037f051fdd57ccf00e14d43c63df616455',
	'2009-07-22': 'beae2e5f8bb7c7d5cc8039518eaea46ea088e1815e3313780a1933ba3d3f57e5',
	'2010-01-15': 'c66fc5c7de2540a185d63f08605d22044de29940ecc504409b12730494763fda',
	'2010-07-11': '2e62966768a972e157ac5d129aacde4bfcb528ded210591bc36861af78b30932',
	'2011-01-04': 'f834840fef2e1d3e929286a769276f2f93b335e90ff833d057a3ef8e31f67de8',
	'2011-06-01': '2c302c54613695b8abd48c1712b4d67ebc25340febfa8eac51c8f15838a5d62e',
	'2011-07-01': 'a1425c9e7d50cf8223b2b2c48d638b658d151bce29f40560a9023fe386bde489',
	'2011-11-25': '59dd245273a5f01607908ec78ed6b89b712064f31107ebfbd67640337f4d480a',
	'2012-05-20': 'b8b519a4e09d10b6651af5c8511dbf835b34421565ded73d6330f16c6a0290b5',
	'2012-11-13': 'f1e6a06f8426ee5a7332d2eb8eece440d736b5f436f668b30cbd51952c9f5d92',
	'2013-05-10': '9e0ec7805e721c0727cf63a8dadd011298f53b1deecfca0aa3721ddb6f3d0c66',
	'2013-11-03': '1aca5fae4217be2a35e09ee2d28fbc1f41a8815663f2ed5690289859e47b1e8b',
	'2014-04-29': '7885245cb157ba16125f84df31d821c6bc26de9f918fe6aae305984068c394c7',
	'2014-10-23': '331776057c2b5bec8dcc517daee38df8eeae4302909e1ccacc6a00b265cbc444',
	'2015-03-20': 'b3f37996a2a0772a5126e636ab93b5b005d8cfa941452972e823dc99b75ac330',
	'2015-09-13': '23bf91b7972ddf3fcf6423eea685c06ad8365a77ee4f76cd8129f836b13ded37',
	'2016-03-09': '0dee8ebeefdcb502013809f9ba3439ef1d7511db1227cd2b321449561b02a785',
	'2016-09-01': 'e4ce3c6fc8c69059f3717e441ccecef57a680c75cedb39e33feb53438ff5eb84',
	'2017-02-26': '1f492bf62c4c824c577d925fc4df78812e69c138bc535ef66c5c0379d3fa534a',
	'2017-08-21': '4e7a030c5d9a62a7bef78d3e94ea3b4e3c7a172faace6a9247d2d5a4854284f4',
	'2018-02-15': '6d779fd09cf06f00cdd8af94fd4068b088e6305c839d525e61c583e6a41c7061',
	'2018-07-13': '2aabe8995b6413bca1a6498f25ca0eb2cb38439f4937f367fdf7f56a2f57a72a',
	'2018-08-11': '3839ea71a51c56248851a8e819c2fcca47d35e615806fae80518e11f0823b8b3',
	'2019-01-06': '1def55d7f63de16763eab8fe88bc8b65c501a791d87704059af2e43ca37f90b4',
	'2019-07-02': '00d347af4a61c8992ec270bd4b8607d2282f2c24d3896406e236629edda14801',
	'2019-12-26': 'e3b02525772c8aff0edd6e260e1c722a45c0369a8bdc48df3571c1946554958d',
	'2020-06-21': '0f24e9fdc102734211ef5e0c64bc26f2d5f4a3c072cf3de84419a48649375500',
	'2020-12-14': '3bcc648d023c90df2cf7fef0cbe3d90c83769459394f6ead514160c2d596bbb3',
	'2021-06-10': 'cd690b446912fa39728e59705461505f7653c39dbf63284324f78fbb3f9b80e6',
	'2021-12-04': '21e654c02ebd8f63414b884f5e165c7c4d61b9a55655ddc2ca270e50b65f75c0',
	'2022-04-30': 'd3cd64bc71dc78a5eb4b3f5ad90aacf52645094919858fdac4d8096bcade0ba2',
	'2022-10-25': '48cc95e5a449c1ffb0cabd05399a3b4e0f35110452d4745a1afb2c3fcc2fa85d',
	'2023-04-20': '5ea9f17ada4e22a190a941d9a97335aace5a916fa7521ab8fed55df5ead3e101',
	'2023-10-14': '7448966c7e86917252a1355d95cdd950385b174ce89c0353203da0c29107df9a',
	'2024-04-08': '08e5d5cf26033bc9cd9aa6b849fc369d1f6d053fc56c03bfdd18b95584bc3ee3',
	'2024-10-02': '7b881a76866ffd1728ef904596597dccb94388eaa4aa5a72774e925838559924',
	'2025-03-29': '86cc8d239e1ad1900393f6c9b113816b8e872a728041d39e2b58d8dc1f2502d6',
	'2025-09-21': '324a9f24f2c7b6b0419e0d0095f6904503113ced18175c50e1898520270fcf4b',
	'2026-02-17': 'baca574c6cffd441e37af8af61d9234f0e81bee327db910730ca677d7e48d2da',
	'2026-08-12': '67baddaaf4a65ba6dbf85189edd5fea882ed681e289b1f82c8be609e44ca9484',
	'2027-02-06': 'b9d37acaa74db9bd06679910d5049a4a9c77d68c95d63fc627110fdc8389b025',
	'2027-08-02': 'edc9e2591d994862c3d63b2ebae3f993ad94edf7f23599f57ca713f5b5d97a9e',
	'2028-01-26': '44fd4ebdcb25ba59424bfb291e6ed37ca51a3dd6be94a809f3e459b77ffab0f6',
	'2028-07-22': '05957cd344d5fec298992b74e69600e0943d143a169162f4f5431d7673cea40e',
	'2029-01-14': '61e029cec0315ed1b8b05711bbe9274e9c2da13d2a1af8aeba9e979c7b90ded6',
	'2029-06-12': 'b012c3f432b949c52edc488f730d524cbd39c678f87e3a743e6086e1c7f61cfb',
	'2029-07-11': '375c82c730b54acd05dc4dc544335005ca2c3267dc9ee298631d336037786bf5',
	'2029-12-05': '479daeba7d0666c0efb0bc02aa47b590a964e80fc12674f6192af0ceb32fc487',
	'2030-06-01': '8507f53339da94b868e2334bf6e30776c9e54854d4b459181535f2222095484b',
	'2030-11-25': 'd4e7948024f77d522659c64ddaee4b70ee89f151b7883583b0f5a528e4ed219e',
}

console.time('solar eclipses')

const TASKS: Promise<unknown>[] = []
const MESSAGES: string[] = []

while (date[0] <= 2030) {
	const eclipse = solarEclipse
	const { maximalTime } = eclipse
	const id = `${date[0]}-${pad(date[1])}-${pad(date[2])}`
	const name = `solar-eclipse-${id}`

	if (!process.argv[2] || process.argv[2] === id) {
		const pbe = computePolynomialBesselianElements(maximalTime, getSunMoonPosition)
		const geo = computeSolarEclipseMapGeometry(eclipse, pbe, options)
		const paths = solarEclipseMapToSvgPaths(geo, projection)
		const svg = makeSvg(paths, WIDTH, HEIGHT)

		async function execute() {
			await Bun.write(`data/${name}.svg`, svg)
			const hash = Bun.SHA256.hash(await Bun.file(`data/${name}.svg`).arrayBuffer(), 'hex')
			MESSAGES.push(`'${id}': '${hash}', // ` + (HASHES[id] === hash ? '✅ ' : '❌ '))
		}

		TASKS.push(Promise.try(execute))
	}

	solarEclipse = nearestSolarEclipse(maximalTime, true)
	date = timeToDate(solarEclipse.maximalTime)
}

await Promise.all(TASKS)

for (const message of MESSAGES.sort((a, b) => a.localeCompare(b))) console.info(message)

console.timeEnd('solar eclipses')
