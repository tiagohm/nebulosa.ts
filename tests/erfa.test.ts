import { expect, test } from 'bun:test'
import { arcsec, toArcsec } from '../src/angle'
import { kilometer, meter } from '../src/distance'
import * as erfa from '../src/erfa'
import type { Mat3, MutMat3 } from '../src/mat3'
import { kilometerPerSecond, meterPerSecond, toKilometerPerSecond } from '../src/velocity'

test('eraP2s', () => {
	const [theta, phi, distance] = erfa.eraP2s(100, -50, 25)
	expect(theta).toBeCloseTo(-0.4636476090008061162, 13)
	expect(phi).toBeCloseTo(0.2199879773954594463, 13)
	expect(distance).toBeCloseTo(114.5643923738960002, 11)
})

test('eraS2c', () => {
	const [theta, phi, distance] = erfa.eraS2c(3.0123, -0.999)
	expect(theta).toBeCloseTo(-0.5366267667260523906, 13)
	expect(phi).toBeCloseTo(0.0697711109765145365, 13)
	expect(distance).toBeCloseTo(-0.8409302618566214041, 13)
})

test('eraC2s', () => {
	const [theta, phi] = erfa.eraC2s(100, -50, 25)
	expect(theta).toBeCloseTo(-0.4636476090008061162, 13)
	expect(phi).toBeCloseTo(0.2199879773954594463, 13)
})

test('eraTaiUt1', () => {
	const [a, b] = erfa.eraTaiUt1(2453750.5, 0.892482639, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045614537037037, 13)
})

test('eraUt1Tai', () => {
	const [a, b] = erfa.eraUt1Tai(2453750.5, 0.892104561, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826385462962963, 13)
})

test('eraTaiUtc', () => {
	const [a, b] = erfa.eraTaiUtc(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006945555555556, 13)
})

test('eraUtcTai', () => {
	const [a, b] = erfa.eraUtcTai(2453750.5, 0.892100694)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826384444444444, 13)
})

test('eraUtcUt1', () => {
	const [a, b] = erfa.eraUtcUt1(2453750.5, 0.892100694, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045608981481481, 13)
})

test('eraUt1Utc', () => {
	const [a, b] = erfa.eraUt1Utc(2453750.5, 0.892104561, 0.3341)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921006941018518519, 13)
})

test('eraTaiTt', () => {
	const [a, b] = erfa.eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 13)
})

test('eraTtTai', () => {
	const [a, b] = erfa.eraTtTai(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892110139, 13)
})

test('eraTaiTt', () => {
	const [a, b] = erfa.eraTaiTt(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.892855139, 13)
})

test('eraTtTdb', () => {
	const [a, b] = erfa.eraTtTdb(2453750.5, 0.892855139, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551366736111111, 13)
})

test('eraTdbTt', () => {
	const [a, b] = erfa.eraTdbTt(2453750.5, 0.892855137, -0.000201)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551393263888889, 13)
})

test('eraTcbTdb', () => {
	const [a, b] = erfa.eraTcbTdb(2453750.5, 0.893019599)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551362746343397, 13)
})

test('eraTcgTt', () => {
	const [a, b] = erfa.eraTcgTt(2453750.5, 0.892862531)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551387488816828, 13)
})

test('eraTdbTcb', () => {
	const [a, b] = erfa.eraTdbTcb(2453750.5, 0.892855137)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8930195997253656716, 13)
})

test('eraTtTcg', () => {
	const [a, b] = erfa.eraTtTcg(2453750.5, 0.892482639)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924900312508587113, 13)
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
	expect(f).toBeCloseTo(0.9999, 8)
})

test('eraSp00', () => {
	expect(erfa.eraSp00(2400000.5, 52541)).toBeCloseTo(-0.6216698469981019309e-11, 13)
})

test('eraDtDb', () => {
	expect(erfa.eraDtDb(2448939.5, 0.123, 0.76543, 5.0123, kilometer(5525.242), kilometer(3190))).toBeCloseTo(-0.1280368005936998991e-2, 16)
})

test('eraGst06a', () => {
	expect(erfa.eraGst06a(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754166137675019159, 13)
})

test('eraGst06', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(erfa.eraGst06(2453736, 0.5, 2453736, 0.5, rnpb)).toBeCloseTo(1.754166138018167568, 13)
})

test('eraGmst06', () => {
	expect(erfa.eraGmst06(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754174971870091203, 13)
})

test('eraEra00', () => {
	expect(erfa.eraEra00(2454388, 0.5)).toBeCloseTo(0.4022837240028158102, 13)
})

test('eraEra00', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(erfa.eraEors(rnpb, -0.1220040848472271978e-7)).toBeCloseTo(-0.1332882715130744606e-2, 15)
})

test('eraS06', () => {
	expect(erfa.eraS06(2400000.5, 53736, 0.5791308486706011e-3, 0.4020579816732961219e-4)).toBeCloseTo(-0.1220032213076463117e-7, 19)
})

test('eraObl06', () => {
	expect(erfa.eraObl06(2400000.5, 54388)).toBeCloseTo(0.4090749229387258204, 15)
})

test('eraFal03', () => {
	expect(erfa.eraFal03(0.8)).toBeCloseTo(5.13236975110868415, 12)
})

test('eraFaf03', () => {
	expect(erfa.eraFaf03(0.8)).toBeCloseTo(0.2597711366745499518, 11)
})

test('eraFaom03', () => {
	expect(erfa.eraFaom03(0.8)).toBeCloseTo(-5.973618440951302183, 13)
})

test('eraFapa03', () => {
	expect(erfa.eraFapa03(0.8)).toBeCloseTo(0.195088476224e-1, 13)
})

test('eraFame03', () => {
	expect(erfa.eraFame03(0.8)).toBeCloseTo(5.417338184297289661, 12)
})

test('eraFave03', () => {
	expect(erfa.eraFave03(0.8)).toBeCloseTo(3.424900460533758, 12)
})

test('eraFae03', () => {
	expect(erfa.eraFae03(0.8)).toBeCloseTo(1.744713738913081846, 13)
})

test('eraFama03', () => {
	expect(erfa.eraFama03(0.8)).toBeCloseTo(3.275506840277781492, 12)
})

test('eraFaju03', () => {
	expect(erfa.eraFaju03(0.8)).toBeCloseTo(5.275711665202481138, 13)
})

test('eraFasa03', () => {
	expect(erfa.eraFasa03(0.8)).toBeCloseTo(5.371574539440827046, 13)
})

test('eraFaur03', () => {
	expect(erfa.eraFaur03(0.8)).toBeCloseTo(5.180636450180413523, 13)
})

test('eraFalp03', () => {
	expect(erfa.eraFalp03(0.8)).toBeCloseTo(6.226797973505507345, 13)
})

test('eraFad03', () => {
	expect(erfa.eraFad03(0.8)).toBeCloseTo(1.946709205396925672, 12)
})

test('eraFw2m', () => {
	const m = erfa.eraFw2m(-0.2243387670997992368e-5, 0.4091014602391312982, -0.9501954178013015092e-3, 0.4091014316587367472)
	expect(m[0]).toBeCloseTo(0.9999995505176007047, 13)
	expect(m[1]).toBeCloseTo(0.8695404617348192957e-3, 13)
	expect(m[2]).toBeCloseTo(0.3779735201865582571e-3, 13)
	expect(m[3]).toBeCloseTo(-0.8695404723772016038e-3, 13)
	expect(m[4]).toBeCloseTo(0.9999996219496027161, 13)
	expect(m[5]).toBeCloseTo(-0.1361752496887100026e-6, 13)
	expect(m[6]).toBeCloseTo(-0.377973495703408279e-3, 13)
	expect(m[7]).toBeCloseTo(-0.1924880848087615651e-6, 13)
	expect(m[8]).toBeCloseTo(0.9999999285679971958, 13)
})

test('eraPfw06', () => {
	const a = erfa.eraPfw06(2400000.5, 50123.9999)
	expect(a[0]).toBeCloseTo(-0.224338767099799569e-5, 17)
	expect(a[1]).toBeCloseTo(0.4091014602391312808, 13)
	expect(a[2]).toBeCloseTo(-0.9501954178013031895e-3, 15)
	expect(a[3]).toBeCloseTo(0.4091014316587367491, 13)
})

test('eraPnm06a', () => {
	const m = erfa.eraPnm06a(2400000.5, 50123.9999)
	expect(m[0]).toBeCloseTo(0.9999995832794205484, 13)
	expect(m[1]).toBeCloseTo(0.8372382772630962111e-3, 15)
	expect(m[2]).toBeCloseTo(0.3639684771140623099e-3, 15)
	expect(m[3]).toBeCloseTo(-0.8372533744743683605e-3, 15)
	expect(m[4]).toBeCloseTo(0.9999996486492861646, 13)
	expect(m[5]).toBeCloseTo(0.4132905944611019498e-4, 15)
	expect(m[6]).toBeCloseTo(-0.3639337469629464969e-3, 15)
	expect(m[7]).toBeCloseTo(-0.4163377605910663999e-4, 15)
	expect(m[8]).toBeCloseTo(0.9999999329094260057, 13)
})

test('eraPmat06', () => {
	const m = erfa.eraPmat06(2400000.5, 50123.9999)
	expect(m[0]).toBeCloseTo(0.9999995505176007047, 13)
	expect(m[1]).toBeCloseTo(0.8695404617348208406e-3, 15)
	expect(m[2]).toBeCloseTo(0.3779735201865589104e-3, 15)
	expect(m[3]).toBeCloseTo(-0.8695404723772031414e-3, 15)
	expect(m[4]).toBeCloseTo(0.9999996219496027161, 13)
	expect(m[5]).toBeCloseTo(-0.1361752497080270143e-6, 15)
	expect(m[6]).toBeCloseTo(-0.377973495703408949e-3, 15)
	expect(m[7]).toBeCloseTo(-0.1924880847894457113e-6, 15)
	expect(m[8]).toBeCloseTo(0.9999999285679971958, 13)
})

test('eraNut06a', () => {
	const a = erfa.eraNut06a(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9630912025820308797e-5, 14)
	expect(a[1]).toBeCloseTo(0.4063238496887249798e-4, 14)
})

test('eraNut00a', () => {
	const a = erfa.eraNut00a(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9630909107115518431e-5, 14)
	expect(a[1]).toBeCloseTo(0.406323917400167871e-4, 14)
})

test('eraNut00b', () => {
	const a = erfa.eraNut00b(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9632552291148362783e-5, 14)
	expect(a[1]).toBeCloseTo(0.4063197106621159367e-4, 14)
})

test('eraPom00', () => {
	const m = erfa.eraPom00(2.55060238e-7, 1.860359247e-6, -0.136717458072889146e-10)
	expect(m[0]).toBeCloseTo(0.9999999999999674721, 13)
	expect(m[1]).toBeCloseTo(-0.1367174580728846989e-10, 12)
	expect(m[2]).toBeCloseTo(0.2550602379999972345e-6, 12)
	expect(m[3]).toBeCloseTo(0.1414624947957029801e-10, 12)
	expect(m[4]).toBeCloseTo(0.9999999999982695317, 13)
	expect(m[5]).toBeCloseTo(-0.1860359246998866389e-5, 13)
	expect(m[6]).toBeCloseTo(-0.2550602379741215021e-6, 13)
	expect(m[7]).toBeCloseTo(0.1860359247002414021e-5, 13)
	expect(m[8]).toBeCloseTo(0.9999999999982370039, 13)
})

test('eraC2teqx', () => {
	const rbpn: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	const rpom: Mat3 = [0.9999999999999674705, -0.1367174580728847031e-10, 0.2550602379999972723e-6, 0.1414624947957029721e-10, 0.9999999999982694954, -0.1860359246998866338e-5, -0.2550602379741215275e-6, 0.1860359247002413923e-5, 0.9999999999982369658]

	const m = erfa.eraC2teqx(rbpn, 1.754166138040730516, rpom)
	expect(m[0]).toBeCloseTo(-0.181033212852868573, 13)
	expect(m[1]).toBeCloseTo(0.9834769806897685071, 13)
	expect(m[2]).toBeCloseTo(0.6555535639982634449e-4, 13)
	expect(m[3]).toBeCloseTo(-0.9834768134095211257, 13)
	expect(m[4]).toBeCloseTo(-0.18103322038710238, 13)
	expect(m[5]).toBeCloseTo(0.5749801116126438962e-3, 13)
	expect(m[6]).toBeCloseTo(0.5773474014081539467e-3, 13)
	expect(m[7]).toBeCloseTo(0.3961832391768640871e-4, 13)
	expect(m[8]).toBeCloseTo(0.9999998325501691969, 13)
})

test('eraGc2Gde', () => {
	const [a, b, c] = erfa.eraGc2Gde(meter(6378137), 1 / 298.257223563, meter(2e6), meter(3e6), meter(5.244e6))
	expect(a).toBeCloseTo(0.982793723247329068, 15)
	expect(b).toBeCloseTo(0.97160184819075459, 15)
	expect(c).toBeCloseTo(meter(331.4172461426059892), 18)
})

test('eraGd2Gce', () => {
	const [x, y, z] = erfa.eraGd2Gce(meter(6378137), 1 / 298.257223563, 3.1, -0.5, meter(2500))
	expect(x).toBeCloseTo(meter(-5599000.5577049947), 19)
	expect(y).toBeCloseTo(meter(233011.67223479203), 19)
	expect(z).toBeCloseTo(meter(-3040909.4706983363), 19)
})

test('eraBp06', () => {
	const [rb, rp, rbp] = erfa.eraBp06(2400000.5, 50123.9999)

	expect(rb[0]).toBeCloseTo(0.9999999999999942497, 13)
	expect(rb[1]).toBeCloseTo(-0.7078368960971557145e-7, 15)
	expect(rb[2]).toBeCloseTo(0.8056213977613185606e-7, 15)
	expect(rb[3]).toBeCloseTo(0.7078368694637674333e-7, 15)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 13)
	expect(rb[5]).toBeCloseTo(0.3305943742989134124e-7, 15)
	expect(rb[6]).toBeCloseTo(-0.8056214211620056792e-7, 15)
	expect(rb[7]).toBeCloseTo(-0.330594317274058695e-7, 15)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 13)

	expect(rp[0]).toBeCloseTo(0.9999995504864960278, 13)
	expect(rp[1]).toBeCloseTo(0.8696112578855404832e-3, 15)
	expect(rp[2]).toBeCloseTo(0.3778929293341390127e-3, 15)
	expect(rp[3]).toBeCloseTo(-0.8696112560510186244e-3, 15)
	expect(rp[4]).toBeCloseTo(0.999999621888045882, 13)
	expect(rp[5]).toBeCloseTo(-0.1691646168941896285e-6, 15)
	expect(rp[6]).toBeCloseTo(-0.3778929335557603418e-3, 15)
	expect(rp[7]).toBeCloseTo(-0.1594554040786495076e-6, 15)
	expect(rp[8]).toBeCloseTo(0.9999999285984501222, 13)

	expect(rbp[0]).toBeCloseTo(0.9999995505176007047, 13)
	expect(rbp[1]).toBeCloseTo(0.8695404617348208406e-3, 15)
	expect(rbp[2]).toBeCloseTo(0.3779735201865589104e-3, 15)
	expect(rbp[3]).toBeCloseTo(-0.8695404723772031414e-3, 15)
	expect(rbp[4]).toBeCloseTo(0.9999996219496027161, 13)
	expect(rbp[5]).toBeCloseTo(-0.1361752497080270143e-6, 15)
	expect(rbp[6]).toBeCloseTo(-0.377973495703408949e-3, 15)
	expect(rbp[7]).toBeCloseTo(-0.1924880847894457113e-6, 15)
	expect(rbp[8]).toBeCloseTo(0.9999999285679971958, 13)
})

test('eraS2pv', () => {
	const [p, v] = erfa.eraS2pv(-3.21, 0.123, 0.456, -7.8e-6, 9.01e-6, -1.23e-5)

	expect(p[0]).toBeCloseTo(-0.4514964673880165228, 13)
	expect(p[1]).toBeCloseTo(0.0309339427734258688, 13)
	expect(p[2]).toBeCloseTo(0.0559466810510877933, 13)
	expect(v[0]).toBeCloseTo(0.129227085066326017e-4, 17)
	expect(v[1]).toBeCloseTo(0.2652814182060691422e-5, 17)
	expect(v[2]).toBeCloseTo(0.2568431853930292259e-5, 17)
})

test('eraStarpv', () => {
	const [p, v] = erfa.eraStarpv(0.01686756, -1.093989828, -1.78323516e-5, 2.336024047e-6, arcsec(0.74723), kilometerPerSecond(-21.6))

	expect(p[0]).toBeCloseTo(126668.5912743160601, 10)
	expect(p[1]).toBeCloseTo(2136.792716839935195, 12)
	expect(p[2]).toBeCloseTo(-245251.2339876830091, 11)
	expect(v[0]).toBeCloseTo(-0.4051854008955659551e-2, 13)
	expect(v[1]).toBeCloseTo(-0.625391975441477797e-2, 15)
	expect(v[2]).toBeCloseTo(0.1189353714588109341e-1, 13)
})

test('eraSepp', () => {
	expect(erfa.eraSepp([1, 0.1, 0.2], [-3, 1e-3, 0.2])).toBeCloseTo(2.860391919024660768, 13)
})

test('eraSeps', () => {
	expect(erfa.eraSeps(1, 0.1, 0.2, -3)).toBeCloseTo(2.346722016996998842, 15)
})

test('eraPpsp', () => {
	expect(erfa.eraPpsp([2, 2, 3], 5, [1, 3, 4])).toEqual([7, 17, 23])
})

test('eraPv2s', () => {
	const p = [-0.4514964673880165, 0.03093394277342585, 0.05594668105108779] as const
	const v = [1.29227085066326e-5, 2.652814182060692e-6, 2.568431853930293e-6] as const
	const [theta, phi, r, td, pd, rd] = erfa.eraPv2s(p, v)

	expect(theta).toBeCloseTo(3.073185307179586515, 13)
	expect(phi).toBeCloseTo(0.1229999999999999992, 13)
	expect(r).toBeCloseTo(0.4559999999999999757, 13)
	expect(td).toBeCloseTo(-0.7800000000000000364e-5, 17)
	expect(pd).toBeCloseTo(0.9010000000000001639e-5, 17)
	expect(rd).toBeCloseTo(-0.1229999999999999832e-4, 17)
})

test('eraPvstar', () => {
	const p = [126668.5912743160601, 2136.792716839935195, -245251.2339876830091] as const
	const v = [-0.4051854035740712739e-2, -0.6253919754866173866e-2, 0.1189353719774107189e-1] as const
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraPvstar(p, v) as Exclude<ReturnType<typeof erfa.eraPvstar>, false>

	expect(ra).toBeCloseTo(0.1686756e-1, 13)
	expect(dec).toBeCloseTo(-1.093989828, 13)
	expect(pmr).toBeCloseTo(-0.1783235160000472788e-4, 17)
	expect(pmd).toBeCloseTo(0.2336024047000619347e-5, 17)
	expect(toArcsec(px)).toBeCloseTo(0.74723, 13)
	expect(toKilometerPerSecond(rv)).toBeCloseTo(-21.6000001010730601, 13)
})

test('eraStarpm', () => {
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraStarpm(0.01686756, -1.093989828, -1.78323516e-5, 2.336024047e-6, arcsec(0.74723), kilometerPerSecond(-21.6), 2400000.5, 50083.0, 2400000.5, 53736.0) as Exclude<ReturnType<typeof erfa.eraStarpm>, false>

	expect(ra).toBeCloseTo(0.01668919069414256149, 13)
	expect(dec).toBeCloseTo(-1.093966454217127897, 13)
	expect(pmr).toBeCloseTo(-0.1783662682153176524e-4, 17)
	expect(pmd).toBeCloseTo(0.2338092915983989595e-5, 17)
	expect(toArcsec(px)).toBeCloseTo(0.7473533835317719243, 11)
	expect(toKilometerPerSecond(rv)).toBeCloseTo(-21.59905170476417175, 11)
})

test('eraPmsafe', () => {
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraStarpm(1.234, 0.789, 1e-5, -2e-5, arcsec(1e-2), kilometerPerSecond(10), 2400000.5, 48348.5625, 2400000.5, 51544.5) as Exclude<ReturnType<typeof erfa.eraStarpm>, false>

	expect(ra).toBeCloseTo(1.234087484501017061, 13)
	expect(dec).toBeCloseTo(0.7888249982450468567, 13)
	expect(pmr).toBeCloseTo(0.9996457663586073988e-5, 13)
	expect(pmd).toBeCloseTo(-0.2000040085106754565e-4, 17)
	expect(toArcsec(px)).toBeCloseTo(0.9999997295356830666e-2, 13)
	expect(toKilometerPerSecond(rv)).toBeCloseTo(10.38468380293920069, 11)
})

test('eraPmpx', () => {
	const [x, y, z] = erfa.eraPmpx(1.234, 0.789, 1e-5, -2e-5, arcsec(1e-2), kilometerPerSecond(10), 8.75, [0.9, 0.4, 0.1])

	expect(x).toBeCloseTo(0.2328137623960308438, 13)
	expect(y).toBeCloseTo(0.6651097085397855328, 13)
	expect(z).toBeCloseTo(0.7095257765896359837, 13)
})

test('eraAb', () => {
	const pnat = [-0.76321968546737951, -0.60869453983060384, -0.21676408580639883] as const
	const v = [2.1044018893653786e-5, -8.9108923304429319e-5, -3.8633714797716569e-5] as const
	const [x, y, z] = erfa.eraAb(pnat, v, 0.99980921395708788, 0.99999999506209258)

	expect(x).toBeCloseTo(-0.7631631094219556269, 13)
	expect(y).toBeCloseTo(-0.6087553082505590832, 13)
	expect(z).toBeCloseTo(-0.2167926269368471279, 13)
})

test('eraLd', () => {
	const p = [-0.763276255, -0.608633767, -0.216735543] as const
	const q = [-0.763276255, -0.608633767, -0.216735543] as const
	const e = [0.76700421, 0.605629598, 0.211937094] as const
	const [x, y, z] = erfa.eraLd(0.00028574, p, q, e, 8.91276983, 3e-10)

	expect(x).toBeCloseTo(-0.7632762548968159627, 13)
	expect(y).toBeCloseTo(-0.6086337670823762701, 13)
	expect(z).toBeCloseTo(-0.2167355431320546947, 13)
})

test('eraLdSun', () => {
	const p = [-0.763276255, -0.608633767, -0.216735543] as const
	const e = [-0.973644023, -0.20925523, -0.0907169552] as const
	const [x, y, z] = erfa.eraLdSun(p, e, 0.999809214)

	expect(x).toBeCloseTo(-0.7632762580731413169, 13)
	expect(y).toBeCloseTo(-0.60863376352626479, 13)
	expect(z).toBeCloseTo(-0.2167355419322321302, 13)
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

	const ob = [-0.974170437, -0.2115201, -0.0917583114] as const
	const sc = [-0.763276255, -0.608633767, -0.216735543] as const

	const [x, y, z] = erfa.eraLdn(b, ob, sc)

	expect(x).toBeCloseTo(-0.7632762579693333866, 13)
	expect(y).toBeCloseTo(-0.608633763609300266, 13)
	expect(z).toBeCloseTo(-0.2167355420646328159, 13)
})

test('eraC2tcio', () => {
	const rc2i: MutMat3 = [0.9999998323037164738, 0.5581526271714303683e-9, -0.5791308477073443903e-3, -0.2384266227524722273e-7, 0.9999999991917404296, -0.4020594955030704125e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	const rpom = [0.9999999999999674705, -0.1367174580728847031e-10, 0.2550602379999972723e-6, 0.1414624947957029721e-10, 0.9999999999982694954, -0.1860359246998866338e-5, -0.2550602379741215275e-6, 0.1860359247002413923e-5, 0.9999999999982369658] as const
	const r = erfa.eraC2tcio(rc2i, 1.75283325530307, rpom, rc2i)

	expect(r).toBe(rc2i)
	expect(r[0]).toBeCloseTo(-0.1810332128307110439, 13)
	expect(r[1]).toBeCloseTo(0.9834769806938470149, 13)
	expect(r[2]).toBeCloseTo(0.6555535638685466874e-4, 13)
	expect(r[3]).toBeCloseTo(-0.9834768134135996657, 13)
	expect(r[4]).toBeCloseTo(-0.1810332203649448367, 13)
	expect(r[5]).toBeCloseTo(0.5749801116141106528e-3, 13)
	expect(r[6]).toBeCloseTo(0.5773474014081407076e-3, 13)
	expect(r[7]).toBeCloseTo(0.3961832391772658944e-4, 13)
	expect(r[8]).toBeCloseTo(0.9999998325501691969, 13)
})

test('eraC2ixys', () => {
	const r = erfa.eraC2ixys(0.5791308486706011e-3, 0.4020579816732961219e-4, -0.1220040848472271978e-7)

	expect(r[0]).toBeCloseTo(0.9999998323037157138, 13)
	expect(r[1]).toBeCloseTo(0.5581984869168499149e-9, 13)
	expect(r[2]).toBeCloseTo(-0.579130849161128218e-3, 13)
	expect(r[3]).toBeCloseTo(-0.2384261642670440317e-7, 13)
	expect(r[4]).toBeCloseTo(0.9999999991917468964, 13)
	expect(r[5]).toBeCloseTo(-0.4020579110169668931e-4, 13)
	expect(r[6]).toBeCloseTo(0.5791308486706011e-3, 13)
	expect(r[7]).toBeCloseTo(0.4020579816732961219e-4, 13)
	expect(r[8]).toBeCloseTo(0.999999831495462759, 13)
})

test('eraC2i06a', () => {
	const r = erfa.eraC2i06a(2400000.5, 53736.0)

	expect(r[0]).toBeCloseTo(0.9999998323037159379, 13)
	expect(r[1]).toBeCloseTo(0.5581121329587613787e-9, 13)
	expect(r[2]).toBeCloseTo(-0.5791308487740529749e-3, 13)
	expect(r[3]).toBeCloseTo(-0.2384253169452306581e-7, 13)
	expect(r[4]).toBeCloseTo(0.9999999991917467827, 13)
	expect(r[5]).toBeCloseTo(-0.4020579392895682558e-4, 13)
	expect(r[6]).toBeCloseTo(0.5791308482835292617e-3, 13)
	expect(r[7]).toBeCloseTo(0.402058009945402031e-4, 13)
	expect(r[8]).toBeCloseTo(0.9999998314954628695, 13)
})

test('eraC2t06a', () => {
	const r = erfa.eraC2t06a(2400000.5, 53736.0, 2400000.5, 53736.0, 2.55060238e-7, 1.860359247e-6, undefined)

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

test('eraApci13', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	// const vh = [0.007421582502777622, 0.01405317261474486, 0.006091644528484732] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const [astrom, eo] = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)

	expect(astrom.pmt).toBeCloseTo(12.65133794027378508, 12)
	expect(astrom.eb[0]).toBeCloseTo(0.9013108747340644755, 13)
	expect(astrom.eb[1]).toBeCloseTo(-0.4174026640406119957, 13)
	expect(astrom.eb[2]).toBeCloseTo(-0.1809822877867817771, 13)
	expect(astrom.eh[0]).toBeCloseTo(0.8940025429255499549, 13)
	expect(astrom.eh[1]).toBeCloseTo(-0.4110930268331896318, 13)
	expect(astrom.eh[2]).toBeCloseTo(-0.178218900601974985, 13)
	expect(astrom.em).toBeCloseTo(1.010465295964664178, 13)
	expect(astrom.v[0]).toBeCloseTo(0.4289638912941341125e-4, 17)
	expect(astrom.v[1]).toBeCloseTo(0.8115034032405042132e-4, 17)
	expect(astrom.v[2]).toBeCloseTo(0.3517555135536470279e-4, 17)
	expect(astrom.bm1).toBeCloseTo(0.9999999951686013142, 13)
	expect(astrom.bpn[0]).toBeCloseTo(0.999999206037676171, 13)
	expect(astrom.bpn[3]).toBeCloseTo(0.4124244860106037157e-7, 13)
	expect(astrom.bpn[6]).toBeCloseTo(0.126012857105170967e-2, 13)
	expect(astrom.bpn[1]).toBeCloseTo(-0.128229198722213069e-7, 13)
	expect(astrom.bpn[4]).toBeCloseTo(0.9999999997456835325, 13)
	expect(astrom.bpn[7]).toBeCloseTo(-0.2255288829420524935e-4, 13)
	expect(astrom.bpn[2]).toBeCloseTo(-0.1260128571661374559e-2, 13)
	expect(astrom.bpn[5]).toBeCloseTo(0.2255285422953395494e-4, 13)
	expect(astrom.bpn[8]).toBeCloseTo(0.9999992057833604343, 13)
	expect(eo).toBeCloseTo(-0.2900618712657375647e-2, 13)
})

test('eraApci', () => {
	const ph = [0.903358544, -0.415395237, -0.180084014] as const
	const pb = [0.901310875, -0.417402664, -0.180982288] as const
	const vb = [0.00742727954, 0.0140507459, 0.00609045792] as const

	const astrom = erfa.eraApci(2456165.5, 0.401182685, [pb, vb], ph, 0.0013122272, -2.92808623e-5, 3.05749468e-8)

	expect(astrom.pmt).toBeCloseTo(12.65133794027378508, 12)
	expect(astrom.eb[0]).toBeCloseTo(0.901310875, 13)
	expect(astrom.eb[1]).toBeCloseTo(-0.417402664, 13)
	expect(astrom.eb[2]).toBeCloseTo(-0.180982288, 13)
	expect(astrom.eh[0]).toBeCloseTo(0.8940025429324143045, 13)
	expect(astrom.eh[1]).toBeCloseTo(-0.4110930268679817955, 13)
	expect(astrom.eh[2]).toBeCloseTo(-0.1782189004872870264, 13)
	expect(astrom.em).toBeCloseTo(1.010465295811013146, 13)
	expect(astrom.v[0]).toBeCloseTo(0.4289638913597693554e-4, 17)
	expect(astrom.v[1]).toBeCloseTo(0.8115034051581320575e-4, 17)
	expect(astrom.v[2]).toBeCloseTo(0.3517555136380563427e-4, 17)
	expect(astrom.bm1).toBeCloseTo(0.9999999951686012981, 13)
	expect(astrom.bpn[0]).toBeCloseTo(0.9999991390295159156, 13)
	expect(astrom.bpn[3]).toBeCloseTo(0.4978650072505016932e-7, 13)
	expect(astrom.bpn[6]).toBeCloseTo(0.13122272e-2, 13)
	expect(astrom.bpn[1]).toBeCloseTo(-0.113633665377160963e-7, 13)
	expect(astrom.bpn[4]).toBeCloseTo(0.9999999995713154868, 13)
	expect(astrom.bpn[7]).toBeCloseTo(-0.292808623e-4, 13)
	expect(astrom.bpn[2]).toBeCloseTo(-0.1312227200895260194e-2, 13)
	expect(astrom.bpn[5]).toBeCloseTo(0.292808221787231568e-4, 13)
	expect(astrom.bpn[8]).toBeCloseTo(0.9999991386008323373, 13)
})

test('eraApcg', () => {
	const ph = [0.903358544, -0.415395237, -0.180084014] as const
	const pb = [0.901310875, -0.417402664, -0.180982288] as const
	const vb = [0.00742727954, 0.0140507459, 0.00609045792] as const

	const astrom = erfa.eraApcg(2456165.5, 0.401182685, [pb, vb], ph)

	expect(astrom.pmt).toBeCloseTo(12.65133794027378508, 12)
	expect(astrom.eb[0]).toBeCloseTo(0.901310875, 13)
	expect(astrom.eb[1]).toBeCloseTo(-0.417402664, 13)
	expect(astrom.eb[2]).toBeCloseTo(-0.180982288, 13)
	expect(astrom.eh[0]).toBeCloseTo(0.8940025429324143045, 13)
	expect(astrom.eh[1]).toBeCloseTo(-0.4110930268679817955, 13)
	expect(astrom.eh[2]).toBeCloseTo(-0.1782189004872870264, 13)
	expect(astrom.em).toBeCloseTo(1.010465295811013146, 13)
	expect(astrom.v[0]).toBeCloseTo(0.4289638913597693554e-4, 17)
	expect(astrom.v[1]).toBeCloseTo(0.8115034051581320575e-4, 17)
	expect(astrom.v[2]).toBeCloseTo(0.3517555136380563427e-4, 17)
	expect(astrom.bm1).toBeCloseTo(0.9999999951686012981, 13)
	expect(astrom.bpn[0]).toBeCloseTo(1, 13)
	expect(astrom.bpn[3]).toBeCloseTo(0, 13)
	expect(astrom.bpn[6]).toBeCloseTo(0, 13)
	expect(astrom.bpn[1]).toBeCloseTo(0, 13)
	expect(astrom.bpn[4]).toBeCloseTo(1, 13)
	expect(astrom.bpn[7]).toBeCloseTo(0, 13)
	expect(astrom.bpn[2]).toBeCloseTo(0, 13)
	expect(astrom.bpn[5]).toBeCloseTo(0, 13)
	expect(astrom.bpn[8]).toBeCloseTo(1, 13)
})

test('eraApcs', () => {
	const p = [meter(-1836024.09), meter(1056607.72), meter(-5998795.26)] as const
	const v = [meterPerSecond(-77.0361767), meterPerSecond(-133.310856), meterPerSecond(0.0971855934)] as const
	const ph = [-0.973458265, -0.209215307, -0.0906996477] as const
	const pb = [-0.974170438, -0.211520082, -0.0917583024] as const
	const vb = [0.00364365824, -0.0154287319, -0.00668922024] as const

	const astrom = erfa.eraApcs(2456384.5, 0.970031644, [p, v], [pb, vb], ph)

	expect(astrom.pmt).toBeCloseTo(13.25248468622587269, 12)
	expect(astrom.eb[0]).toBeCloseTo(-0.9741827110629881886, 13)
	expect(astrom.eb[1]).toBeCloseTo(-0.2115130190136415986, 13)
	expect(astrom.eb[2]).toBeCloseTo(-0.09179840186954412099, 13)
	expect(astrom.eh[0]).toBeCloseTo(-0.9736425571689454706, 13)
	expect(astrom.eh[1]).toBeCloseTo(-0.209245212585043593, 13)
	expect(astrom.eh[2]).toBeCloseTo(-0.09075578152248299218, 13)
	expect(astrom.em).toBeCloseTo(0.9998233241709796859, 13)
	expect(astrom.v[0]).toBeCloseTo(0.207870499328268551e-4, 17)
	expect(astrom.v[1]).toBeCloseTo(-0.8955360106989405683e-4, 17)
	expect(astrom.v[2]).toBeCloseTo(-0.3863338994289409097e-4, 17)
	expect(astrom.bm1).toBeCloseTo(0.9999999950277561237, 13)
	expect(astrom.bpn[0]).toBeCloseTo(1, 13)
	expect(astrom.bpn[3]).toBeCloseTo(0, 13)
	expect(astrom.bpn[6]).toBeCloseTo(0, 13)
	expect(astrom.bpn[1]).toBeCloseTo(0, 13)
	expect(astrom.bpn[4]).toBeCloseTo(1, 13)
	expect(astrom.bpn[7]).toBeCloseTo(0, 13)
	expect(astrom.bpn[2]).toBeCloseTo(0, 13)
	expect(astrom.bpn[5]).toBeCloseTo(0, 13)
	expect(astrom.bpn[8]).toBeCloseTo(1, 13)
})

test('eraAtccq', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	// const vh = [0.007421582502777622, 0.01405317261474486, 0.006091644528484732] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const [astrom] = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const p = erfa.eraAtccq(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom)
	const [ra, dec] = erfa.eraC2s(...p)

	expect(ra).toBeCloseTo(2.710126504531372384, 13)
	expect(dec).toBeCloseTo(0.1740632537628350152, 13)
})

test('eraAtciq', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	// const vh = [0.007421582502777622, 0.01405317261474486, 0.006091644528484732] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const [astrom] = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const [ra, dec] = erfa.eraAtciq(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom)

	expect(ra).toBeCloseTo(2.710121572968696744, 13)
	expect(dec).toBeCloseTo(0.1729371367219539137, 13)
})

test('eraPvtob', () => {
	const pv = erfa.eraPvtob(2, 0.5, meter(3000), 1e-6, -0.5e-6, 1e-8, 5)

	expect(pv[0][0]).toBeCloseTo(meter(4225081.367071159207), 16)
	expect(pv[0][1]).toBeCloseTo(meter(3681943.215856198144), 16)
	expect(pv[0][2]).toBeCloseTo(meter(3041149.399241260785), 16)
	expect(pv[1][0]).toBeCloseTo(meterPerSecond(-268.4915389365998787), 15)
	expect(pv[1][1]).toBeCloseTo(meterPerSecond(308.0977983288903123), 15)
	expect(pv[1][2]).toBe(0)
})

test('eraApco', () => {
	const ebp = [-0.974170438, -0.211520082, -0.0917583024] as const
	const ebv = [0.00364365824, -0.0154287319, -0.00668922024] as const
	const ehp = [-0.973458265, -0.209215307, -0.0906996477] as const

	const astrom = erfa.eraApco(2456384.5, 0.970031644, [ebp, ebv], ehp, 0.0013122272, -2.92808623e-5, 3.05749468e-8, 3.14540971, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, -3.01974337e-11, 0.000201418779, -2.36140831e-7)

	expect(astrom.pmt).toBeCloseTo(13.25248468622587269, 12)
	expect(astrom.eb[0]).toBeCloseTo(-0.974182711063032272, 13)
	expect(astrom.eb[1]).toBeCloseTo(-0.2115130190135344832, 13)
	expect(astrom.eb[2]).toBeCloseTo(-0.09179840186949532298, 13)
	expect(astrom.eh[0]).toBeCloseTo(-0.9736425571689739035, 13)
	expect(astrom.eh[1]).toBeCloseTo(-0.2092452125849330936, 13)
	expect(astrom.eh[2]).toBeCloseTo(-0.09075578152243272599, 13)
	expect(astrom.em).toBeCloseTo(0.9998233241709957653, 13)
	expect(astrom.v[0]).toBeCloseTo(0.2078704992916728762e-4, 17)
	expect(astrom.v[1]).toBeCloseTo(-0.8955360107151952319e-4, 17)
	expect(astrom.v[2]).toBeCloseTo(-0.3863338994288951082e-4, 17)
	expect(astrom.bm1).toBeCloseTo(0.9999999950277561236, 13)
	expect(astrom.bpn[0]).toBeCloseTo(0.9999991390295159156, 13)
	expect(astrom.bpn[3]).toBeCloseTo(0.4978650072505016932e-7, 13)
	expect(astrom.bpn[6]).toBeCloseTo(0.13122272e-2, 13)
	expect(astrom.bpn[1]).toBeCloseTo(-0.113633665377160963e-7, 13)
	expect(astrom.bpn[4]).toBeCloseTo(0.9999999995713154868, 13)
	expect(astrom.bpn[7]).toBeCloseTo(-0.292808623e-4, 13)
	expect(astrom.bpn[2]).toBeCloseTo(-0.1312227200895260194e-2, 13)
	expect(astrom.bpn[5]).toBeCloseTo(0.292808221787231568e-4, 13)
	expect(astrom.bpn[8]).toBeCloseTo(0.9999991386008323373, 13)
	expect(astrom.along).toBeCloseTo(-0.5278008060295995734, 13)
	expect(astrom.xpl).toBeCloseTo(0.1133427418130752958e-5, 18)
	expect(astrom.ypl).toBeCloseTo(0.1453347595780646207e-5, 18)
	expect(astrom.sphi).toBeCloseTo(-0.9440115679003211329, 13)
	expect(astrom.cphi).toBeCloseTo(0.3299123514971474711, 13)
	expect(astrom.diurab).toBe(0)
	expect(astrom.eral).toBeCloseTo(2.617608903970400427, 13)
	expect(astrom.refa).toBeCloseTo(0.201418779e-3, 16)
	expect(astrom.refb).toBeCloseTo(-0.236140831e-6, 19)
})

test('eraApco13', () => {
	const ebp = [-0.974170437669016342, -0.211520082035387968, -0.091758302425478583] as const
	const ebv = [0.003643658242375083, -0.015428731944935825, -0.006689220237864495] as const
	const ehp = [-0.973458265012157486, -0.209215306558769298, -0.090699647709202746] as const

	const [tt1, tt2] = erfa.eraTaiTt(...erfa.eraUtcTai(2456384.5, 0.969254051))
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const [astrom, eo] = erfa.eraApco13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731.0, 12.8, 0.59, 0.55, [ebp, ebv], ehp)

	expect(astrom.pmt).toBeCloseTo(13.25248468622475727, 11)
	expect(astrom.eb[0]).toBeCloseTo(-0.9741827107320875162, 13)
	expect(astrom.eb[1]).toBeCloseTo(-0.2115130190489716682, 13)
	expect(astrom.eb[2]).toBeCloseTo(-0.09179840189496755339, 13)
	expect(astrom.eh[0]).toBeCloseTo(-0.9736425572586935247, 13)
	expect(astrom.eh[1]).toBeCloseTo(-0.2092452121603336166, 13)
	expect(astrom.eh[2]).toBeCloseTo(-0.09075578153885665295, 13)
	expect(astrom.em).toBeCloseTo(0.9998233240913898141, 13)
	expect(astrom.v[0]).toBeCloseTo(0.2078704994520489246e-4, 17)
	expect(astrom.v[1]).toBeCloseTo(-0.8955360133238868938e-4, 17)
	expect(astrom.v[2]).toBeCloseTo(-0.3863338993055887398e-4, 17)
	expect(astrom.bm1).toBeCloseTo(0.9999999950277561004, 13)
	expect(astrom.bpn[0]).toBeCloseTo(0.9999991390295147999, 13)
	expect(astrom.bpn[3]).toBeCloseTo(0.4978650075315529277e-7, 13)
	expect(astrom.bpn[6]).toBeCloseTo(0.001312227200850293372, 13)
	expect(astrom.bpn[1]).toBeCloseTo(-0.1136336652812486604e-7, 13)
	expect(astrom.bpn[4]).toBeCloseTo(0.9999999995713154865, 13)
	expect(astrom.bpn[7]).toBeCloseTo(-0.2928086230975367296e-4, 13)
	expect(astrom.bpn[2]).toBeCloseTo(-0.001312227201745553566, 13)
	expect(astrom.bpn[5]).toBeCloseTo(0.2928082218847679162e-4, 13)
	expect(astrom.bpn[8]).toBeCloseTo(0.9999991386008312212, 13)
	expect(astrom.along).toBeCloseTo(-0.5278008060295995733, 13)
	expect(astrom.xpl).toBeCloseTo(0.1133427418130752958e-5, 18)
	expect(astrom.ypl).toBeCloseTo(0.1453347595780646207e-5, 18)
	expect(astrom.sphi).toBeCloseTo(-0.9440115679003211329, 13)
	expect(astrom.cphi).toBeCloseTo(0.3299123514971474711, 13)
	expect(astrom.diurab).toBe(0)
	expect(astrom.eral).toBeCloseTo(2.617608909189664, 13)
	expect(astrom.refa).toBeCloseTo(0.2014187785940396921e-3, 16)
	expect(astrom.refb).toBeCloseTo(-0.2361408314943696227e-6, 19)
	expect(eo).toBeCloseTo(-0.003020548354802412839, 15)
})

test('eraRefco', () => {
	const [refa, refb] = erfa.eraRefco(800, 10, 0.9, 0.4)
	expect(refa).toBeCloseTo(0.2264949956241415009e-3, 15)
	expect(refb).toBeCloseTo(-0.259865826172934397e-6, 18)
})

test('eraApio', () => {
	const astrom = erfa.eraApio(-3.01974337e-11, 3.14540971, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0.000201418779, -2.36140831e-7)

	expect(astrom.along).toBeCloseTo(-0.5278008060295995734, 13)
	expect(astrom.xpl).toBeCloseTo(0.1133427418130752958e-5, 18)
	expect(astrom.ypl).toBeCloseTo(0.1453347595780646207e-5, 18)
	expect(astrom.sphi).toBeCloseTo(-0.9440115679003211329, 13)
	expect(astrom.cphi).toBeCloseTo(0.3299123514971474711, 13)
	expect(astrom.diurab).toBeCloseTo(0.5135843661699913529e-6, 13)
	expect(astrom.eral).toBeCloseTo(2.617608903970400427, 13)
	expect(astrom.refa).toBeCloseTo(0.201418779e-3, 16)
	expect(astrom.refb).toBeCloseTo(-0.236140831e-6, 19)
})

test('eraApio13', () => {
	const [tt1, tt2] = erfa.eraTaiTt(...erfa.eraUtcTai(2456384.5, 0.969254051))
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const astrom = erfa.eraApio13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, undefined, 731, 12.8, 0.59, 0.55)

	expect(astrom.along).toBeCloseTo(-0.5278008060295995733, 13)
	expect(astrom.xpl).toBeCloseTo(0.1133427418130752958e-5, 18)
	expect(astrom.ypl).toBeCloseTo(0.1453347595780646207e-5, 18)
	expect(astrom.sphi).toBeCloseTo(-0.9440115679003211329, 13)
	expect(astrom.cphi).toBeCloseTo(0.3299123514971474711, 13)
	expect(astrom.diurab).toBeCloseTo(0.5135843661699913529e-6, 13)
	expect(astrom.eral).toBeCloseTo(2.617608909189664, 13)
	expect(astrom.refa).toBeCloseTo(0.2014187785940396921e-3, 16)
	expect(astrom.refb).toBeCloseTo(-0.2361408314943696227e-6, 19)
})

test('eraAtioq', () => {
	const [tt1, tt2] = erfa.eraTaiTt(...erfa.eraUtcTai(2456384.5, 0.969254051))
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const astrom = erfa.eraApio13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, undefined, 731, 12.8, 0.59, 0.55)
	const [aob, zob, hob, rob, dob] = erfa.eraAtioq(2.710121572969038991, 0.1729371367218230438, astrom)

	expect(aob).toBeCloseTo(0.9233952224895122499e-1, 13)
	expect(zob).toBeCloseTo(1.407758704513549991, 13)
	expect(hob).toBeCloseTo(-0.924761987988169814e-1, 13)
	expect(dob).toBeCloseTo(0.1717653435756234676, 13)
	expect(rob).toBeCloseTo(2.710085107988480746, 13)
})

test('eraBi00', () => {
	const [dpsibi, depsbi, dra] = erfa.eraBi00()
	expect(dpsibi).toBeCloseTo(-0.2025309152835086613e-6, 13)
	expect(depsbi).toBeCloseTo(-0.3306041454222147847e-7, 13)
	expect(dra).toBeCloseTo(-0.7078279744199225506e-7, 13)
})

test('eraAtoiq', () => {
	const [tt1, tt2] = erfa.eraTaiTt(...erfa.eraUtcTai(2456384.5, 0.969254051))
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)

	const astrom = erfa.eraApio13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, undefined, 731, 12.8, 0.59, 0.55)

	let [ri, di] = erfa.eraAtoiq('R', 2.710085107986886201, 0.1717653435758265198, astrom)
	expect(ri).toBeCloseTo(2.71012157444754081, 13)
	expect(di).toBeCloseTo(0.17293718391166087785, 13)

	;[ri, di] = erfa.eraAtoiq('H', -0.09247619879782006106, 0.1717653435758265198, astrom)
	expect(ri).toBeCloseTo(2.710121574448138676, 13)
	expect(di).toBeCloseTo(0.1729371839116608778, 13)

	;[ri, di] = erfa.eraAtoiq('A', 0.09233952224794989993, 1.407758704513722461, astrom)
	expect(ri).toBeCloseTo(2.710121574448138676, 13)
	expect(di).toBeCloseTo(0.1729371839116608781, 13)
})
