import { expect, test } from 'bun:test'
import { kilometer } from './distance'
import { eraC2teqx, eraCalToJd, eraDat, eraDtDb, eraEors, eraEra00, eraFad03, eraFae03, eraFaf03, eraFaju03, eraFal03, eraFalp03, eraFama03, eraFame03, eraFaom03, eraFapa03, eraFasa03, eraFaur03, eraFave03, eraFw2m, eraGc2Gde, eraGd2Gce, eraGmst06, eraGst06, eraGst06a, eraJdToCal, eraNut00a, eraNut00b, eraNut06a, eraObl06, eraPfw06, eraPmat06, eraPnm06a, eraPom00, eraS06, eraSp00, eraTaiTt, eraTaiUt1, eraTaiUtc, eraTcbTdb, eraTcgTt, eraTdbTcb, eraTdbTt, eraTtTai, eraTtTcg, eraTtTdb, eraUt1Tai, eraUt1Utc, eraUtcTai, eraUtcUt1 } from './erfa'
import type { Mat3 } from './matrix'

test('eraTaiUt1', () => {
	const [a, b] = eraTaiUt1(2453750.5, 0.892482639, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045614537037037, 12)
})

test('eraUt1Tai', () => {
	const [a, b] = eraUt1Tai(2453750.5, 0.892104561, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826385462962963, 12)
})

test('eraTaiUtc', () => {
	const [a, b] = eraTaiUtc(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006945555555556, 12)
})

test('eraUtcTai', () => {
	const [a, b] = eraUtcTai(2453750.5, 0.892100694)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826384444444444, 12)
})

test('eraUtcUt1', () => {
	const [a, b] = eraUtcUt1(2453750.5, 0.892100694, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045608981481481, 12)
})

test('eraUt1Utc', () => {
	const [a, b] = eraUt1Utc(2453750.5, 0.892104561, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006941018518519, 12)
})

test('eraTaiTt', () => {
	const [a, b] = eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 12)
})

test('eraTtTai', () => {
	const [a, b] = eraTtTai(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892110139, 12)
})

test('eraTaiTt', () => {
	const [a, b] = eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 12)
})

test('eraTtTdb', () => {
	const [a, b] = eraTtTdb(2453750.5, 0.892855139, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551366736111111, 12)
})

test('eraTdbTt', () => {
	const [a, b] = eraTdbTt(2453750.5, 0.892855137, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551393263888889, 12)
})

test('eraTcbTdb', () => {
	const [a, b] = eraTcbTdb(2453750.5, 0.893019599)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551362746343397, 12)
})

test('eraTcgTt', () => {
	const [a, b] = eraTcgTt(2453750.5, 0.892862531)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551387488816828, 12)
})

test('eraTdbTcb', () => {
	const [a, b] = eraTdbTcb(2453750.5, 0.892855137)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8930195997253656716, 12)
})

test('eraTtTcg', () => {
	const [a, b] = eraTtTcg(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924900312508587113, 12)
})

test('eraDat', () => {
	expect(eraDat(2003, 6, 1, 0)).toBe(32)
	expect(eraDat(2008, 1, 17, 0)).toBe(33)
	expect(eraDat(2017, 9, 1, 0)).toBe(37)
})

test('eraCalToJd', () => {
	expect(eraCalToJd(2003, 6, 1)).toBe(52791)
})

test('eraJdToCal', () => {
	const [y, m, d, f] = eraJdToCal(2400000.5, 50123.9999)
	expect(y).toBe(1996)
	expect(m).toBe(2)
	expect(d).toBe(10)
	expect(f).toBeCloseTo(0.9999, 7)
})

test('eraSp00', () => {
	expect(eraSp00(2400000.5, 52541)).toBeCloseTo(-0.6216698469981019309e-11, 12)
})

test('eraDtDb', () => {
	expect(eraDtDb(2448939.5, 0.123, 0.76543, 5.0123, kilometer(5525.242), kilometer(3190))).toBeCloseTo(-0.1280368005936998991e-2, 15)
})

test('eraGst06a', () => {
	expect(eraGst06a(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754166137675019159, 12)
})

test('eraGst06', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(eraGst06(2453736, 0.5, 2453736, 0.5, rnpb)).toBeCloseTo(1.754166138018167568, 12)
})

test('eraGmst06', () => {
	expect(eraGmst06(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754174971870091203, 12)
})

test('eraEra00', () => {
	expect(eraEra00(2454388, 0.5)).toBeCloseTo(0.4022837240028158102, 12)
})

test('eraEra00', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(eraEors(rnpb, -0.1220040848472271978e-7)).toBeCloseTo(-0.1332882715130744606e-2, 14)
})

test('eraS06', () => {
	expect(eraS06(2400000.5, 53736, 0.5791308486706011e-3, 0.4020579816732961219e-4)).toBeCloseTo(-0.1220032213076463117e-7, 18)
})

test('eraObl06', () => {
	expect(eraObl06(2400000.5, 54388)).toBeCloseTo(0.4090749229387258204, 14)
})

test('eraFal03', () => {
	expect(eraFal03(0.8)).toBeCloseTo(5.13236975110868415, 12)
})

test('eraFaf03', () => {
	expect(eraFaf03(0.8)).toBeCloseTo(0.2597711366745499518, 11)
})

test('eraFaom03', () => {
	expect(eraFaom03(0.8)).toBeCloseTo(-5.973618440951302183, 12)
})

test('eraFapa03', () => {
	expect(eraFapa03(0.8)).toBeCloseTo(0.195088476224e-1, 12)
})

test('eraFame03', () => {
	expect(eraFame03(0.8)).toBeCloseTo(5.417338184297289661, 12)
})

test('eraFave03', () => {
	expect(eraFave03(0.8)).toBeCloseTo(3.424900460533758, 12)
})

test('eraFae03', () => {
	expect(eraFae03(0.8)).toBeCloseTo(1.744713738913081846, 12)
})

test('eraFama03', () => {
	expect(eraFama03(0.8)).toBeCloseTo(3.275506840277781492, 12)
})

test('eraFaju03', () => {
	expect(eraFaju03(0.8)).toBeCloseTo(5.275711665202481138, 12)
})

test('eraFasa03', () => {
	expect(eraFasa03(0.8)).toBeCloseTo(5.371574539440827046, 12)
})

test('eraFaur03', () => {
	expect(eraFaur03(0.8)).toBeCloseTo(5.180636450180413523, 12)
})

test('eraFalp03', () => {
	expect(eraFalp03(0.8)).toBeCloseTo(6.226797973505507345, 12)
})

test('eraFad03', () => {
	expect(eraFad03(0.8)).toBeCloseTo(1.946709205396925672, 12)
})

test('eraFw2m', () => {
	const m = eraFw2m(-0.2243387670997992368e-5, 0.4091014602391312982, -0.9501954178013015092e-3, 0.4091014316587367472)
	expect(m[0]).toBeCloseTo(0.9999995505176007047, 12)
	expect(m[1]).toBeCloseTo(0.8695404617348192957e-3, 12)
	expect(m[2]).toBeCloseTo(0.3779735201865582571e-3, 12)
	expect(m[3]).toBeCloseTo(-0.8695404723772016038e-3, 12)
	expect(m[4]).toBeCloseTo(0.9999996219496027161, 12)
	expect(m[5]).toBeCloseTo(-0.1361752496887100026e-6, 12)
	expect(m[6]).toBeCloseTo(-0.377973495703408279e-3, 12)
	expect(m[7]).toBeCloseTo(-0.1924880848087615651e-6, 12)
	expect(m[8]).toBeCloseTo(0.9999999285679971958, 12)
})

test('eraPfw06', () => {
	const a = eraPfw06(2400000.5, 50123.9999)
	expect(a[0]).toBeCloseTo(-0.224338767099799569e-5, 16)
	expect(a[1]).toBeCloseTo(0.4091014602391312808, 12)
	expect(a[2]).toBeCloseTo(-0.9501954178013031895e-3, 14)
	expect(a[3]).toBeCloseTo(0.4091014316587367491, 12)
})

test('eraPnm06a', () => {
	const m = eraPnm06a(2400000.5, 50123.9999)
	expect(m[0]).toBeCloseTo(0.9999995832794205484, 12)
	expect(m[1]).toBeCloseTo(0.8372382772630962111e-3, 14)
	expect(m[2]).toBeCloseTo(0.3639684771140623099e-3, 14)
	expect(m[3]).toBeCloseTo(-0.8372533744743683605e-3, 14)
	expect(m[4]).toBeCloseTo(0.9999996486492861646, 12)
	expect(m[5]).toBeCloseTo(0.4132905944611019498e-4, 14)
	expect(m[6]).toBeCloseTo(-0.3639337469629464969e-3, 14)
	expect(m[7]).toBeCloseTo(-0.4163377605910663999e-4, 14)
	expect(m[8]).toBeCloseTo(0.9999999329094260057, 12)
})

test('eraPmat06', () => {
	const m = eraPmat06(2400000.5, 50123.9999)
	expect(m[0]).toBeCloseTo(0.9999995505176007047, 12)
	expect(m[1]).toBeCloseTo(0.8695404617348208406e-3, 14)
	expect(m[2]).toBeCloseTo(0.3779735201865589104e-3, 14)
	expect(m[3]).toBeCloseTo(-0.8695404723772031414e-3, 14)
	expect(m[4]).toBeCloseTo(0.9999996219496027161, 12)
	expect(m[5]).toBeCloseTo(-0.1361752497080270143e-6, 14)
	expect(m[6]).toBeCloseTo(-0.377973495703408949e-3, 14)
	expect(m[7]).toBeCloseTo(-0.1924880847894457113e-6, 14)
	expect(m[8]).toBeCloseTo(0.9999999285679971958, 12)
})

test('eraNut06a', () => {
	const a = eraNut06a(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9630912025820308797e-5, 13)
	expect(a[1]).toBeCloseTo(0.4063238496887249798e-4, 13)
})

test('eraNut00a', () => {
	const a = eraNut00a(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9630909107115518431e-5, 13)
	expect(a[1]).toBeCloseTo(0.406323917400167871e-4, 13)
})

test('eraNut00b', () => {
	const a = eraNut00b(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9632552291148362783e-5, 13)
	expect(a[1]).toBeCloseTo(0.4063197106621159367e-4, 13)
})

test('eraPom00', () => {
	const m = eraPom00(2.55060238e-7, 1.860359247e-6, -0.136717458072889146e-10)
	expect(m[0]).toBeCloseTo(0.9999999999999674721, 12)
	expect(m[1]).toBeCloseTo(-0.1367174580728846989e-10, 12)
	expect(m[2]).toBeCloseTo(0.2550602379999972345e-6, 12)
	expect(m[3]).toBeCloseTo(0.1414624947957029801e-10, 12)
	expect(m[4]).toBeCloseTo(0.9999999999982695317, 12)
	expect(m[5]).toBeCloseTo(-0.1860359246998866389e-5, 12)
	expect(m[6]).toBeCloseTo(-0.2550602379741215021e-6, 12)
	expect(m[7]).toBeCloseTo(0.1860359247002414021e-5, 12)
	expect(m[8]).toBeCloseTo(0.9999999999982370039, 12)
})

test('eraC2teqx', () => {
	const rbpn: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	const rpom: Mat3 = [0.9999999999999674705, -0.1367174580728847031e-10, 0.2550602379999972723e-6, 0.1414624947957029721e-10, 0.9999999999982694954, -0.1860359246998866338e-5, -0.2550602379741215275e-6, 0.1860359247002413923e-5, 0.9999999999982369658]

	const m = eraC2teqx(rbpn, 1.754166138040730516, rpom)
	expect(m[0]).toBeCloseTo(-0.181033212852868573, 12)
	expect(m[1]).toBeCloseTo(0.9834769806897685071, 12)
	expect(m[2]).toBeCloseTo(0.6555535639982634449e-4, 12)
	expect(m[3]).toBeCloseTo(-0.9834768134095211257, 12)
	expect(m[4]).toBeCloseTo(-0.18103322038710238, 12)
	expect(m[5]).toBeCloseTo(0.5749801116126438962e-3, 12)
	expect(m[6]).toBeCloseTo(0.5773474014081539467e-3, 12)
	expect(m[7]).toBeCloseTo(0.3961832391768640871e-4, 12)
	expect(m[8]).toBeCloseTo(0.9999998325501691969, 12)
})

test('eraGc2Gde', () => {
	const [a, b, c] = eraGc2Gde(6378137, 1 / 298.257223563, 2e6, 3e6, 5.244e6)
	expect(a).toBeCloseTo(0.982793723247329068, 14)
	expect(b).toBeCloseTo(0.97160184819075459, 14)
	expect(c).toBeCloseTo(331.4172461426059892, 8)
})

test('eraGd2Gce', () => {
	const [x, y, z] = eraGd2Gce(6378137, 1 / 298.257223563, 3.1, -0.5, 2500.0)
	expect(x).toBeCloseTo(-5599000.5577049947, 7)
	expect(y).toBeCloseTo(233011.67223479203, 7)
	expect(z).toBeCloseTo(-3040909.4706983363, 7)
})
