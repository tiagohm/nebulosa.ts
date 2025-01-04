import { expect, test } from 'bun:test'
import { arcsec, toArcsec } from './angle'
import { kilometer } from './distance'
import * as erfa from './erfa'
import type { Mat3, MutMat3 } from './matrix'
import type { MutVec3, Vec3 } from './vector'
import { kilometerPerSecond, toKilometerPerSecond } from './velocity'

test('eraP2s', () => {
	const [theta, phi, distance] = erfa.eraP2s(100, -50, 25)
	expect(theta).toBeCloseTo(-0.4636476090008061162, 12)
	expect(phi).toBeCloseTo(0.2199879773954594463, 12)
	expect(distance).toBeCloseTo(114.5643923738960002, 9)
})

test('eraS2c', () => {
	const [theta, phi, distance] = erfa.eraS2c(3.0123, -0.999)
	expect(theta).toBeCloseTo(-0.5366267667260523906, 12)
	expect(phi).toBeCloseTo(0.0697711109765145365, 12)
	expect(distance).toBeCloseTo(-0.8409302618566214041, 12)
})

test('eraC2s', () => {
	const [theta, phi] = erfa.eraC2s(100, -50, 25)
	expect(theta).toBeCloseTo(-0.4636476090008061162, 12)
	expect(phi).toBeCloseTo(0.2199879773954594463, 12)
})

test('eraTaiUt1', () => {
	const [a, b] = erfa.eraTaiUt1(2453750.5, 0.892482639, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045614537037037, 12)
})

test('eraUt1Tai', () => {
	const [a, b] = erfa.eraUt1Tai(2453750.5, 0.892104561, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826385462962963, 12)
})

test('eraTaiUtc', () => {
	const [a, b] = erfa.eraTaiUtc(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006945555555556, 12)
})

test('eraUtcTai', () => {
	const [a, b] = erfa.eraUtcTai(2453750.5, 0.892100694)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826384444444444, 12)
})

test('eraUtcUt1', () => {
	const [a, b] = erfa.eraUtcUt1(2453750.5, 0.892100694, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045608981481481, 12)
})

test('eraUt1Utc', () => {
	const [a, b] = erfa.eraUt1Utc(2453750.5, 0.892104561, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006941018518519, 12)
})

test('eraTaiTt', () => {
	const [a, b] = erfa.eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 12)
})

test('eraTtTai', () => {
	const [a, b] = erfa.eraTtTai(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892110139, 12)
})

test('eraTaiTt', () => {
	const [a, b] = erfa.eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 12)
})

test('eraTtTdb', () => {
	const [a, b] = erfa.eraTtTdb(2453750.5, 0.892855139, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551366736111111, 12)
})

test('eraTdbTt', () => {
	const [a, b] = erfa.eraTdbTt(2453750.5, 0.892855137, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551393263888889, 12)
})

test('eraTcbTdb', () => {
	const [a, b] = erfa.eraTcbTdb(2453750.5, 0.893019599)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551362746343397, 12)
})

test('eraTcgTt', () => {
	const [a, b] = erfa.eraTcgTt(2453750.5, 0.892862531)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551387488816828, 12)
})

test('eraTdbTcb', () => {
	const [a, b] = erfa.eraTdbTcb(2453750.5, 0.892855137)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8930195997253656716, 12)
})

test('eraTtTcg', () => {
	const [a, b] = erfa.eraTtTcg(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924900312508587113, 12)
})

test('eraDat', () => {
	expect(erfa.eraDat(2003, 6, 1, 0)).toBe(32)
	expect(erfa.eraDat(2008, 1, 17, 0)).toBe(33)
	expect(erfa.eraDat(2017, 9, 1, 0)).toBe(37)
})

test('eraCalToJd', () => {
	expect(erfa.eraCalToJd(2003, 6, 1)).toBe(52791)
})

test('eraJdToCal', () => {
	const [y, m, d, f] = erfa.eraJdToCal(2400000.5, 50123.9999)
	expect(y).toBe(1996)
	expect(m).toBe(2)
	expect(d).toBe(10)
	expect(f).toBeCloseTo(0.9999, 7)
})

test('eraSp00', () => {
	expect(erfa.eraSp00(2400000.5, 52541)).toBeCloseTo(-0.6216698469981019309e-11, 12)
})

test('eraDtDb', () => {
	expect(erfa.eraDtDb(2448939.5, 0.123, 0.76543, 5.0123, kilometer(5525.242), kilometer(3190))).toBeCloseTo(-0.1280368005936998991e-2, 15)
})

test('eraGst06a', () => {
	expect(erfa.eraGst06a(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754166137675019159, 12)
})

test('eraGst06', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(erfa.eraGst06(2453736, 0.5, 2453736, 0.5, rnpb)).toBeCloseTo(1.754166138018167568, 12)
})

test('eraGmst06', () => {
	expect(erfa.eraGmst06(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754174971870091203, 12)
})

test('eraEra00', () => {
	expect(erfa.eraEra00(2454388, 0.5)).toBeCloseTo(0.4022837240028158102, 12)
})

test('eraEra00', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(erfa.eraEors(rnpb, -0.1220040848472271978e-7)).toBeCloseTo(-0.1332882715130744606e-2, 14)
})

test('eraS06', () => {
	expect(erfa.eraS06(2400000.5, 53736, 0.5791308486706011e-3, 0.4020579816732961219e-4)).toBeCloseTo(-0.1220032213076463117e-7, 18)
})

test('eraObl06', () => {
	expect(erfa.eraObl06(2400000.5, 54388)).toBeCloseTo(0.4090749229387258204, 14)
})

test('eraFal03', () => {
	expect(erfa.eraFal03(0.8)).toBeCloseTo(5.13236975110868415, 12)
})

test('eraFaf03', () => {
	expect(erfa.eraFaf03(0.8)).toBeCloseTo(0.2597711366745499518, 11)
})

test('eraFaom03', () => {
	expect(erfa.eraFaom03(0.8)).toBeCloseTo(-5.973618440951302183, 12)
})

test('eraFapa03', () => {
	expect(erfa.eraFapa03(0.8)).toBeCloseTo(0.195088476224e-1, 12)
})

test('eraFame03', () => {
	expect(erfa.eraFame03(0.8)).toBeCloseTo(5.417338184297289661, 12)
})

test('eraFave03', () => {
	expect(erfa.eraFave03(0.8)).toBeCloseTo(3.424900460533758, 12)
})

test('eraFae03', () => {
	expect(erfa.eraFae03(0.8)).toBeCloseTo(1.744713738913081846, 12)
})

test('eraFama03', () => {
	expect(erfa.eraFama03(0.8)).toBeCloseTo(3.275506840277781492, 12)
})

test('eraFaju03', () => {
	expect(erfa.eraFaju03(0.8)).toBeCloseTo(5.275711665202481138, 12)
})

test('eraFasa03', () => {
	expect(erfa.eraFasa03(0.8)).toBeCloseTo(5.371574539440827046, 12)
})

test('eraFaur03', () => {
	expect(erfa.eraFaur03(0.8)).toBeCloseTo(5.180636450180413523, 12)
})

test('eraFalp03', () => {
	expect(erfa.eraFalp03(0.8)).toBeCloseTo(6.226797973505507345, 12)
})

test('eraFad03', () => {
	expect(erfa.eraFad03(0.8)).toBeCloseTo(1.946709205396925672, 12)
})

test('eraFw2m', () => {
	const m = erfa.eraFw2m(-0.2243387670997992368e-5, 0.4091014602391312982, -0.9501954178013015092e-3, 0.4091014316587367472)
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
	const a = erfa.eraPfw06(2400000.5, 50123.9999)
	expect(a[0]).toBeCloseTo(-0.224338767099799569e-5, 16)
	expect(a[1]).toBeCloseTo(0.4091014602391312808, 12)
	expect(a[2]).toBeCloseTo(-0.9501954178013031895e-3, 14)
	expect(a[3]).toBeCloseTo(0.4091014316587367491, 12)
})

test('eraPnm06a', () => {
	const m = erfa.eraPnm06a(2400000.5, 50123.9999)
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
	const m = erfa.eraPmat06(2400000.5, 50123.9999)
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
	const a = erfa.eraNut06a(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9630912025820308797e-5, 13)
	expect(a[1]).toBeCloseTo(0.4063238496887249798e-4, 13)
})

test('eraNut00a', () => {
	const a = erfa.eraNut00a(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9630909107115518431e-5, 13)
	expect(a[1]).toBeCloseTo(0.406323917400167871e-4, 13)
})

test('eraNut00b', () => {
	const a = erfa.eraNut00b(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9632552291148362783e-5, 13)
	expect(a[1]).toBeCloseTo(0.4063197106621159367e-4, 13)
})

test('eraPom00', () => {
	const m = erfa.eraPom00(2.55060238e-7, 1.860359247e-6, -0.136717458072889146e-10)
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

	const m = erfa.eraC2teqx(rbpn, 1.754166138040730516, rpom)
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
	const [a, b, c] = erfa.eraGc2Gde(6378137, 1 / 298.257223563, 2e6, 3e6, 5.244e6)
	expect(a).toBeCloseTo(0.982793723247329068, 14)
	expect(b).toBeCloseTo(0.97160184819075459, 14)
	expect(c).toBeCloseTo(331.4172461426059892, 8)
})

test('eraGd2Gce', () => {
	const [x, y, z] = erfa.eraGd2Gce(6378137, 1 / 298.257223563, 3.1, -0.5, 2500)
	expect(x).toBeCloseTo(-5599000.5577049947, 7)
	expect(y).toBeCloseTo(233011.67223479203, 7)
	expect(z).toBeCloseTo(-3040909.4706983363, 7)
})

test('eraBp06', () => {
	const [rb, rp, rbp] = erfa.eraBp06(2400000.5, 50123.9999)

	expect(rb[0]).toBeCloseTo(0.9999999999999942497, 12)
	expect(rb[1]).toBeCloseTo(-0.7078368960971557145e-7, 14)
	expect(rb[2]).toBeCloseTo(0.8056213977613185606e-7, 14)
	expect(rb[3]).toBeCloseTo(0.7078368694637674333e-7, 14)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3305943742989134124e-7, 14)
	expect(rb[6]).toBeCloseTo(-0.8056214211620056792e-7, 14)
	expect(rb[7]).toBeCloseTo(-0.330594317274058695e-7, 14)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)

	expect(rp[0]).toBeCloseTo(0.9999995504864960278, 12)
	expect(rp[1]).toBeCloseTo(0.8696112578855404832e-3, 14)
	expect(rp[2]).toBeCloseTo(0.3778929293341390127e-3, 14)
	expect(rp[3]).toBeCloseTo(-0.8696112560510186244e-3, 14)
	expect(rp[4]).toBeCloseTo(0.999999621888045882, 12)
	expect(rp[5]).toBeCloseTo(-0.1691646168941896285e-6, 14)
	expect(rp[6]).toBeCloseTo(-0.3778929335557603418e-3, 14)
	expect(rp[7]).toBeCloseTo(-0.1594554040786495076e-6, 14)
	expect(rp[8]).toBeCloseTo(0.9999999285984501222, 12)

	expect(rbp[0]).toBeCloseTo(0.9999995505176007047, 12)
	expect(rbp[1]).toBeCloseTo(0.8695404617348208406e-3, 14)
	expect(rbp[2]).toBeCloseTo(0.3779735201865589104e-3, 14)
	expect(rbp[3]).toBeCloseTo(-0.8695404723772031414e-3, 14)
	expect(rbp[4]).toBeCloseTo(0.9999996219496027161, 12)
	expect(rbp[5]).toBeCloseTo(-0.1361752497080270143e-6, 14)
	expect(rbp[6]).toBeCloseTo(-0.377973495703408949e-3, 14)
	expect(rbp[7]).toBeCloseTo(-0.1924880847894457113e-6, 14)
	expect(rbp[8]).toBeCloseTo(0.9999999285679971958, 12)
})

test('eraS2pv', () => {
	const [p, v] = erfa.eraS2pv(-3.21, 0.123, 0.456, -7.8e-6, 9.01e-6, -1.23e-5)

	expect(p[0]).toBeCloseTo(-0.4514964673880165228, 12)
	expect(p[1]).toBeCloseTo(0.0309339427734258688, 12)
	expect(p[2]).toBeCloseTo(0.0559466810510877933, 12)
	expect(v[0]).toBeCloseTo(0.129227085066326017e-4, 16)
	expect(v[1]).toBeCloseTo(0.2652814182060691422e-5, 16)
	expect(v[2]).toBeCloseTo(0.2568431853930292259e-5, 16)
})

test('eraStarpv', () => {
	const [p, v] = erfa.eraStarpv(0.01686756, -1.093989828, -1.78323516e-5, 2.336024047e-6, arcsec(0.74723), kilometerPerSecond(-21.6))

	expect(p[0]).toBeCloseTo(126668.5912743160601, 10)
	expect(p[1]).toBeCloseTo(2136.792716839935195, 12)
	expect(p[2]).toBeCloseTo(-245251.2339876830091, 10)
	expect(v[0]).toBeCloseTo(-0.4051854008955659551e-2, 13)
	expect(v[1]).toBeCloseTo(-0.625391975441477797e-2, 15)
	expect(v[2]).toBeCloseTo(0.1189353714588109341e-1, 13)
})

test('eraSepp', () => {
	expect(erfa.eraSepp([1, 0.1, 0.2], [-3, 1e-3, 0.2])).toBeCloseTo(2.860391919024660768, 12)
})

test('eraSeps', () => {
	expect(erfa.eraSeps(1, 0.1, 0.2, -3)).toBeCloseTo(2.346722016996998842, 14)
})

test('eraPpsp', () => {
	expect(erfa.eraPpsp([2, 2, 3], 5, [1, 3, 4])).toEqual([7, 17, 23])
})

test('eraPv2s', () => {
	const p: MutVec3 = [-0.4514964673880165, 0.03093394277342585, 0.05594668105108779]
	const v: MutVec3 = [1.29227085066326e-5, 2.652814182060692e-6, 2.568431853930293e-6]
	const [theta, phi, r, td, pd, rd] = erfa.eraPv2s(p, v)

	expect(theta).toBeCloseTo(3.073185307179586515, 12)
	expect(phi).toBeCloseTo(0.1229999999999999992, 12)
	expect(r).toBeCloseTo(0.4559999999999999757, 12)
	expect(td).toBeCloseTo(-0.7800000000000000364e-5, 16)
	expect(pd).toBeCloseTo(0.9010000000000001639e-5, 16)
	expect(rd).toBeCloseTo(-0.1229999999999999832e-4, 16)
})

test('eraPvstar', () => {
	const p: MutVec3 = [126668.5912743160601, 2136.792716839935195, -245251.2339876830091]
	const v: MutVec3 = [-0.4051854035740712739e-2, -0.6253919754866173866e-2, 0.1189353719774107189e-1]
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraPvstar(p, v) as Exclude<ReturnType<typeof erfa.eraPvstar>, false>

	expect(ra).toBeCloseTo(0.1686756e-1, 12)
	expect(dec).toBeCloseTo(-1.093989828, 12)
	expect(pmr).toBeCloseTo(-0.1783235160000472788e-4, 16)
	expect(pmd).toBeCloseTo(0.2336024047000619347e-5, 16)
	expect(toArcsec(px)).toBeCloseTo(0.74723, 12)
	expect(toKilometerPerSecond(rv)).toBeCloseTo(-21.6000001010730601, 13)
})

test('eraStarpm', () => {
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraStarpm(0.01686756, -1.093989828, -1.78323516e-5, 2.336024047e-6, arcsec(0.74723), kilometerPerSecond(-21.6), 2400000.5, 50083.0, 2400000.5, 53736.0) as Exclude<ReturnType<typeof erfa.eraStarpm>, false>

	expect(ra).toBeCloseTo(0.01668919069414256149, 13)
	expect(dec).toBeCloseTo(-1.093966454217127897, 13)
	expect(pmr).toBeCloseTo(-0.1783662682153176524e-4, 17)
	expect(pmd).toBeCloseTo(0.2338092915983989595e-5, 17)
	expect(toArcsec(px)).toBeCloseTo(0.7473533835317719243, 10)
	expect(toKilometerPerSecond(rv)).toBeCloseTo(-21.59905170476417175, 11)
})

test('eraPmsafe', () => {
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraStarpm(1.234, 0.789, 1e-5, -2e-5, arcsec(1e-2), kilometerPerSecond(10), 2400000.5, 48348.5625, 2400000.5, 51544.5) as Exclude<ReturnType<typeof erfa.eraStarpm>, false>

	expect(ra).toBeCloseTo(1.234087484501017061, 12)
	expect(dec).toBeCloseTo(0.7888249982450468567, 12)
	expect(pmr).toBeCloseTo(0.9996457663586073988e-5, 12)
	expect(pmd).toBeCloseTo(-0.2000040085106754565e-4, 16)
	expect(toArcsec(px)).toBeCloseTo(0.9999997295356830666e-2, 12)
	expect(toKilometerPerSecond(rv)).toBeCloseTo(10.38468380293920069, 10)
})

test('eraPmpx', () => {
	const [x, y, z] = erfa.eraPmpx(1.234, 0.789, 1e-5, -2e-5, arcsec(1e-2), kilometerPerSecond(10), 8.75, [0.9, 0.4, 0.1])

	expect(x).toBeCloseTo(0.2328137623960308438, 12)
	expect(y).toBeCloseTo(0.6651097085397855328, 12)
	expect(z).toBeCloseTo(0.7095257765896359837, 12)
})

test('eraAb', () => {
	const pnat: Vec3 = [-0.76321968546737951, -0.60869453983060384, -0.21676408580639883]
	const v: Vec3 = [2.1044018893653786e-5, -8.9108923304429319e-5, -3.8633714797716569e-5]
	const [x, y, z] = erfa.eraAb(pnat, v, 0.99980921395708788, 0.99999999506209258)

	expect(x).toBeCloseTo(-0.7631631094219556269, 12)
	expect(y).toBeCloseTo(-0.6087553082505590832, 12)
	expect(z).toBeCloseTo(-0.2167926269368471279, 12)
})

test('eraLd', () => {
	const p: Vec3 = [-0.763276255, -0.608633767, -0.216735543]
	const q: Vec3 = [-0.763276255, -0.608633767, -0.216735543]
	const e: Vec3 = [0.76700421, 0.605629598, 0.211937094]
	const [x, y, z] = erfa.eraLd(0.00028574, p, q, e, 8.91276983, 3e-10)

	expect(x).toBeCloseTo(-0.7632762548968159627, 12)
	expect(y).toBeCloseTo(-0.6086337670823762701, 12)
	expect(z).toBeCloseTo(-0.2167355431320546947, 12)
})

test('eraLdSun', () => {
	const p: Vec3 = [-0.763276255, -0.608633767, -0.216735543]
	const e: Vec3 = [-0.973644023, -0.20925523, -0.0907169552]
	const [x, y, z] = erfa.eraLdSun(p, e, 0.999809214)

	expect(x).toBeCloseTo(-0.7632762580731413169, 12)
	expect(y).toBeCloseTo(-0.60863376352626479, 12)
	expect(z).toBeCloseTo(-0.2167355419322321302, 12)
})

test('eraLdn', () => {
	const b: erfa.LdBody[] = [
		{
			bm: 0.00028574,
			dl: 3e-10,
			p: [-7.81014427, -5.60956681, -1.98079819],
			v: [0.0030723249, -0.00406995477, -0.00181335842],
		},
		{
			bm: 0.00095435,
			dl: 3e-9,
			p: [0.738098796, 4.63658692, 1.9693136],
			v: [-0.00755816922, 0.00126913722, 0.000727999001],
		},
		{
			bm: 1.0,
			dl: 6e-6,
			p: [-0.000712174377, -0.00230478303, -0.00105865966],
			v: [6.29235213e-6, -3.30888387e-7, -2.96486623e-7],
		},
	]

	const ob: Vec3 = [-0.974170437, -0.2115201, -0.0917583114]
	const sc: Vec3 = [-0.763276255, -0.608633767, -0.216735543]

	const [x, y, z] = erfa.eraLdn(b, ob, sc)

	expect(x).toBeCloseTo(-0.7632762579693333866, 12)
	expect(y).toBeCloseTo(-0.608633763609300266, 12)
	expect(z).toBeCloseTo(-0.2167355420646328159, 12)
})

test('eraC2tcio', () => {
	const rc2i: MutMat3 = [0.9999998323037164738, 0.5581526271714303683e-9, -0.5791308477073443903e-3, -0.2384266227524722273e-7, 0.9999999991917404296, -0.4020594955030704125e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	const rpom: Mat3 = [0.9999999999999674705, -0.1367174580728847031e-10, 0.2550602379999972723e-6, 0.1414624947957029721e-10, 0.9999999999982694954, -0.1860359246998866338e-5, -0.2550602379741215275e-6, 0.1860359247002413923e-5, 0.9999999999982369658]
	const r = erfa.eraC2tcio(rc2i, 1.75283325530307, rpom, rc2i)

	expect(r).toBe(rc2i)
	expect(r[0]).toBeCloseTo(-0.1810332128307110439, 12)
	expect(r[1]).toBeCloseTo(0.9834769806938470149, 12)
	expect(r[2]).toBeCloseTo(0.6555535638685466874e-4, 12)
	expect(r[3]).toBeCloseTo(-0.9834768134135996657, 12)
	expect(r[4]).toBeCloseTo(-0.1810332203649448367, 12)
	expect(r[5]).toBeCloseTo(0.5749801116141106528e-3, 12)
	expect(r[6]).toBeCloseTo(0.5773474014081407076e-3, 12)
	expect(r[7]).toBeCloseTo(0.3961832391772658944e-4, 12)
	expect(r[8]).toBeCloseTo(0.9999998325501691969, 12)
})

test('eraC2ixys', () => {
	const r = erfa.eraC2ixys(0.5791308486706011e-3, 0.4020579816732961219e-4, -0.1220040848472271978e-7)

	expect(r[0]).toBeCloseTo(0.9999998323037157138, 12)
	expect(r[1]).toBeCloseTo(0.5581984869168499149e-9, 12)
	expect(r[2]).toBeCloseTo(-0.579130849161128218e-3, 12)
	expect(r[3]).toBeCloseTo(-0.2384261642670440317e-7, 12)
	expect(r[4]).toBeCloseTo(0.9999999991917468964, 12)
	expect(r[5]).toBeCloseTo(-0.4020579110169668931e-4, 12)
	expect(r[6]).toBeCloseTo(0.5791308486706011e-3, 12)
	expect(r[7]).toBeCloseTo(0.4020579816732961219e-4, 12)
	expect(r[8]).toBeCloseTo(0.999999831495462759, 12)
})

test('eraC2i06a', () => {
	const r = erfa.eraC2i06a(2400000.5, 53736.0)

	expect(r[0]).toBeCloseTo(0.9999998323037159379, 12)
	expect(r[1]).toBeCloseTo(0.5581121329587613787e-9, 12)
	expect(r[2]).toBeCloseTo(-0.5791308487740529749e-3, 12)
	expect(r[3]).toBeCloseTo(-0.2384253169452306581e-7, 12)
	expect(r[4]).toBeCloseTo(0.9999999991917467827, 12)
	expect(r[5]).toBeCloseTo(-0.4020579392895682558e-4, 12)
	expect(r[6]).toBeCloseTo(0.5791308482835292617e-3, 12)
	expect(r[7]).toBeCloseTo(0.402058009945402031e-4, 12)
	expect(r[8]).toBeCloseTo(0.9999998314954628695, 12)
})

test('eraC2t06a', () => {
	const r = erfa.eraC2t06a(2400000.5, 53736.0, 2400000.5, 53736.0, 2.55060238e-7, 1.860359247e-6)

	expect(r[0]).toBeCloseTo(-0.1810332128305897282, 12)
	expect(r[1]).toBeCloseTo(0.9834769806938592296, 12)
	expect(r[2]).toBeCloseTo(0.6555550962998436505e-4, 12)
	expect(r[3]).toBeCloseTo(-0.9834768134136214897, 12)
	expect(r[4]).toBeCloseTo(-0.1810332203649130832, 12)
	expect(r[5]).toBeCloseTo(0.574980084490559411e-3, 12)
	expect(r[6]).toBeCloseTo(0.5773474024748545878e-3, 12)
	expect(r[7]).toBeCloseTo(0.3961816829632690581e-4, 12)
	expect(r[8]).toBeCloseTo(0.9999998325501747785, 12)
})
