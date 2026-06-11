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
.umbrafill { fill: gray; stroke: none; }
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
<path class="umbrafill" d="${fill}" />
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

const IMAGEMAGICK_PATH = process.platform === 'win32' ? 'c:\\Program Files\\ImageMagick\\magick.exe' : 'magick'

function pad(number: number) {
	return number.toFixed(0).padStart(2, '0')
}

const HASHES: Readonly<Record<string, string>> = {
	'2000-02-05': '823c5d31f0995e3c4b58451b76568a3ddd85aa655816d888270acc8e28286d95',
	'2000-07-01': 'f8c48a63aaa3f521b664b0b7722fd8f3447060e97ca838af39caf098686c06ff',
	'2000-07-31': '727d9692cdc42daeb4540b3b8df6a342939c8dc984e0a6d95130c63969c0f2fc',
	'2000-12-25': '9611d254e03195517b5a16a3f7f78a0b3384a8d91314835ee149a6be69768dc2',
	'2001-06-21': '8dccdbb275c366322eab796188d4ebd0cb0a49d7c5292b436ebb44da02e51d9b',
	'2001-12-14': '8853ab10419b38d2224ae9cebb0927df88d8b70a1f04189044742de1769f8054',
	'2002-06-10': 'c7d4beb941d248bc5b51bda8ff0074738045e52e9b0a9249a4249e77502b801b',
	'2002-12-04': 'c943a9e05d12ad6a6256d344119c5066e2a99cc6fd9c48f24bbc2d9c48b89332',
	'2003-05-31': 'a33c461c2d5bcb14e2d26ea1f7aae7193217607f0c5f57efd9c335963709aa8e',
	'2003-11-23': '7b98c505c9e76d0bda05720c9e8b651d98479488e4933f143fc583d9955c1e38',
	'2004-04-19': 'acd1a3ecacd5fd3427abdca6cede16e1dfec813b8c8bc638fdc52cddb3c4a0ef',
	'2004-10-14': '425bbcdb420edeb1fdb2686b8c8e73f8f8da8cd73b147f3f6395fe5656cfec0d',
	'2005-04-08': 'd19b9c9a5d0315bab659463fe4f75b890a56e3d538c4884cbd51ba3bc4b2e64a',
	'2005-10-03': '3910ce082ed7027736d95ce8bf68897ff705c5553e9a9fa6c76fbda8655f2692',
	'2006-03-29': '7a5df962c4dce7022e76a09983a7b3412b43fffeeabbdbffc0567071fd13de10',
	'2006-09-22': '99473e8850c00dd2cf42a90d745f3b0e12692d8161c06aee0cc803068da72e3f',
	'2007-03-19': 'fa19b5ce3a0d0557e998b53a8e6e6fe5a10e5b51301a780140a48b633aafe5c4',
	'2007-09-11': 'ece843b58cba239a1f0d5974abb87aac19b867c5fdb6812b0107882e9233b175',
	'2008-02-07': 'db355abe1da0b27b8f427968a669e884a028e8be90952179dbcd6ab39177891b',
	'2008-08-01': 'ff30f71abf4506c90be6c35c3f12a50486014fffc7ae2f24ac158b553d7e3c77',
	'2009-01-26': '1ab0cd1cee6a2cc76d4772b6ff82cefa7cb7f22f4f297cff5269002a515e2d6a',
	'2009-07-22': '15a106f7e64f909cc4d70b594a984430e32ba6163fdd1d47454819d2c66ca6d2',
	'2010-01-15': 'd6d0c9c00f26b433633589dd6994b95c0a4dc6f668977471bceb8a3df98d04a9',
	'2010-07-11': '156d6cb3b6884c820c3a6e8d5f330de74ebc33f07b70c6241d81f085ed91006a',
	'2011-01-04': '4c2826e20a00d45eb0e2167cabffa09b68f2e6563ae41a97b3c57e7b7d148f33',
	'2011-06-01': 'cfff24f537a3addbfa0782f4458aa8797de287a16094fc7b847bf1f1d684b179',
	'2011-07-01': '4e730779d6eeedf6af72763aebf99a3118bc2f7939997f26fc3ac7c371932ba0',
	'2011-11-25': '9ab5a9072eacd7e8a5d6008179a3fd4089f85e8f5e24c0da36eb29e779313dcb',
	'2012-05-20': 'cb946ced4b97dc6b18fe62b8d999f7a1ec47de47ccaa85642b622ed702d970b6',
	'2012-11-13': '28aa6ce464f791ed164faaba5ec43b89f4b8636fac8b301cfbc146732b80f5d3',
	'2013-05-10': 'd15de1e9bda7d59493fa23dd6d8e4acb5033898423f57077d589db3d06fca070',
	'2013-11-03': '0a5f12ed6e36d0b459708950fedc80fdc426d092ca13159f4b259eada5e8afec',
	'2014-04-29': '0b23701c1573a5f1a5a995cfa3ac70514de41a20370b040483bf304154692e99',
	'2014-10-23': 'f1b9f1775f061ced42505c88a1ceb22a5417854bedea834572c7b60eb9286839',
	'2015-03-20': '7a5a6ebc17651341cdac874f2a2bc3a7d6306699717ec212905b1fed60d92a35',
	'2015-09-13': '2a1fc14d3e02551b73f8fb9bebaf08ea8df91d24fc1f450460f07fb122527140',
	'2016-03-09': 'c6cfc166ab291ae27ff92d3b89ebcb39dcb3c54525916a2a23d7b5ff7d5da2b6',
	'2016-09-01': '2f5264c6d7921d228ba40fb777fc0e6074e655cbb1df7bbcb5267980c0565e24',
	'2017-02-26': 'ef55f681da70d2ca105f7c62324c95e3a5f004690d0629b43f68d95248522443',
	'2017-08-21': '119550491ab26dfe6e879a9fe99dc7b1e24f982bd372f722beddeeae1edc1211',
	'2018-02-15': 'ffefb5480fc549e9704ae542c05e09a12fe710cb34f9992139217c62e9292cad',
	'2018-07-13': '3059db7f7f202200ee216d26cb5ef3952846f2413a467bb7fd162da88f6ad7b8',
	'2018-08-11': '6be255bbd34824b04e1337692c96793598aa4d365cfcfb35a2385219e8e3184c',
	'2019-01-06': 'c6f783c02a8789e48708cea3c004901af57c01a625786f9ade1f6bdddd155bcd',
	'2019-07-02': 'c21db5e044cd9d6a67f8c5da3f32a1c9acb38e9b82d2b0a46d094089d0bca335',
	'2019-12-26': '50d389043912ecd1a46bc44c4d0b6c9eb78699b566adec998ea8b78672af051e',
	'2020-06-21': '3cb94d440d50b53c135a29657548c64ed6be35088374d8f5a4159b1533559f17',
	'2020-12-14': '44215136209f267a37b6ffa0720de14c21eee6520c57f80d7320827ae38aa1bf',
	'2021-06-10': '9919476a1cdd4bebbebd937a2ca8fbd3120b1f485b7539b63d25099e5d4cf2f7',
	'2021-12-04': '59e1405589c2b8744921830191a9f84758a7d0be261d160c3b1fd4b930f645ad',
	'2022-04-30': '0a10b1a4535f3765a7d662be89325c545a56abfd2ef1cdeb446c38d692b6818c',
	'2022-10-25': 'ade786059c28d08c613d250a5414006687f122bc815f009204147644b3d60abe',
	'2023-04-20': 'ce7a1e3b9a0467a6465428bd7d8bfe951ef92ba837aa07397b8ab1e2c6d1b4c1',
	'2023-10-14': 'fa2cc539949822e1884b5b748638fbd6e870e23b4880cb2d7e1f657b4065280b',
	'2024-04-08': '521c8d38937be234add9e762e53dbe039b0f2f461274e9ad8d2991ce083a8438',
	'2024-10-02': 'e566465620db674d06f18e9cef0647f5ce76b60e4144f35bf29d89997d15a5a1',
	'2025-03-29': 'e1ff7ce03d2efffb3018fbffc3146d1306d92d010a5ffdd1eed63eb06afba78a',
	'2025-09-21': '2ffb311cb6d1bb1bbfe460b08d9242ced39b07fe4cd0c33eac174b42a4895b6b',
}

console.time('solar eclipses')

while (date[0] <= 2025) {
	const eclipse = solarEclipse
	const { maximalTime } = eclipse
	const id = `${date[0]}-${pad(date[1])}-${pad(date[2])}`
	const name = `solar-eclipse-${id}`

	if (!process.argv[2] || process.argv[2] === id) {
		const pbe = computePolynomialBesselianElements(maximalTime, getSunMoonPosition)
		const geo = computeSolarEclipseMapGeometry(eclipse, pbe, options)
		const paths = solarEclipseMapToSvgPaths(geo, projection)
		// The visual-only totality/annularity fill is derived from the umbra limits, isolated from the physical lines.
		const fill = geoPolygonsToSvgPathData(computeSolarEclipseFillGeometry(geo), projection)
		const svg = makeSvg(paths, fill, WIDTH, HEIGHT)

		await Bun.write(`data/${name}.svg`, svg)
		await Bun.$`${IMAGEMAGICK_PATH} data/${name}.svg -strip data/${name}.png`
		const hash = Bun.SHA256.hash(await Bun.file(`data/${name}.png`).arrayBuffer(), 'hex')
		console.info(`'${id}': '${hash}', // ` + (HASHES[id] === hash ? '✅ ' : '❌ '))
	}

	solarEclipse = nearestSolarEclipse(maximalTime, true)
	date = timeToDate(solarEclipse.maximalTime)
}

console.timeEnd('solar eclipses')
