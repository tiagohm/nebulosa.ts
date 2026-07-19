import { expect, test } from 'bun:test'
import { eraEpv00 } from '../../../../src/astronomy/coordinates/erfa/earth'
import * as erfa from '../../../../src/astronomy/coordinates/erfa/erfa'
import { eraMoon98 } from '../../../../src/astronomy/coordinates/erfa/moon'
import type { Mat3, MutMat3 } from '../../../../src/math/linear-algebra/mat3'
import { arcsec, toArcsec } from '../../../../src/math/units/angle'
import { kilometer, meter } from '../../../../src/math/units/distance'
import { kilometerPerSecond, meterPerSecond, toKilometerPerSecond } from '../../../../src/math/units/velocity'

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

test('eraTtUt1', () => {
	const [a, b] = erfa.eraTtUt1(2453750.5, 0.892855139, 64.8499)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8921045614537037037, 13)
})

test('eraUt1Tai', () => {
	const [a, b] = erfa.eraUt1Tai(2453750.5, 0.892104561, -32.6659)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8924826385462962963, 13)
})

test('eraUt1Tt', () => {
	const [a, b] = erfa.eraUt1Tt(2453750.5, 0.892104561, 64.8499)
	expect(a).toBe(2453750.5)
	expect(b).toBeCloseTo(0.8928551385462962963, 13)
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

test('eraAe2hd', () => {
	const [ha, dec] = erfa.eraAe2hd(5.5, 1.1, 0.7)
	expect(ha).toBeCloseTo(0.5933291115507309663, 14)
	expect(dec).toBeCloseTo(0.961393476164781762, 14)
})

test('eraHd2ae', () => {
	const [az, el] = erfa.eraHd2ae(1.1, 1.2, 0.3)
	expect(az).toBeCloseTo(5.916889243730066194, 13)
	expect(el).toBeCloseTo(0.4472186304990486228, 14)
})

test('eraHd2pa', () => {
	expect(erfa.eraHd2pa(1.1, 1.2, 0.3)).toBeCloseTo(1.90622742800199558, 13)
})

test('eraBpn2xy', () => {
	const [x, y] = erfa.eraBpn2xy([0.9999962358680738, -0.002516417057665452, -0.00109356978534237, 0.002516462370370876, 0.9999968329010883, 0.0000400615958735831, 0.001093465510215479, -0.00004281337229063151, 0.9999994012499173])
	expect(x).toBeCloseTo(0.001093465510215479, 12)
	expect(y).toBeCloseTo(-0.00004281337229063151, 12)
})

test('eraFw2xy', () => {
	const [x, y] = erfa.eraFw2xy(-0.2243387670997992368e-5, 0.4091014602391312982, -0.9501954178013015092e-3, 0.4091014316587367472)
	expect(x).toBeCloseTo(-0.377973495703408279e-3, 14)
	expect(y).toBeCloseTo(-0.1924880848087615651e-6, 14)
})

test('eraG2icrs', () => {
	const [ra, dec] = erfa.eraG2icrs(5.585053606381854646, -0.7853981633974483)
	expect(ra).toBeCloseTo(5.933807430222719, 14)
	expect(dec).toBeCloseTo(-1.1784870613579945, 14)
})

test('eraIcrs2g', () => {
	const [longitude, latitude] = erfa.eraIcrs2g(5.933807430222719, -1.1784870613579945)
	expect(longitude).toBeCloseTo(5.585053606381855, 14)
	expect(latitude).toBeCloseTo(-0.7853981633974483, 14)
})

test('eraTpsts', () => {
	const [ra, dec] = erfa.eraTpsts(-0.03, 0.07, 2.3, 1.5)
	expect(ra).toBeCloseTo(0.759612716735963, 14)
	expect(dec).toBeCloseTo(1.540864645109263, 13)
})

test('eraTpstv', () => {
	const v = erfa.eraTpstv(-0.03, 0.07, erfa.eraS2c(2.3, 1.5))
	expect(v[0]).toBeCloseTo(0.02170030454907377, 15)
	expect(v[1]).toBeCloseTo(0.020609095905353674, 15)
	expect(v[2]).toBeCloseTo(0.9995520806583524, 14)
})

test('eraTpors', () => {
	const [count, a01, b01, a02, b02] = erfa.eraTpors(-0.03, 0.07, 1.3, 1.5)
	expect(count).toBe(2)
	expect(a01).toBeCloseTo(1.7366215777832087, 13)
	expect(b01).toBeCloseTo(1.4367365618440903, 13)
	expect(a02).toBeCloseTo(4.0049710758065845, 13)
	expect(b02).toBeCloseTo(1.565084088476418, 13)
})

test('eraTporv', () => {
	const [count, v01, v02] = erfa.eraTporv(-0.03, 0.07, erfa.eraS2c(1.3, 1.5))
	expect(count).toBe(2)
	expect(v01?.[0]).toBeCloseTo(-0.022062528223668886, 15)
	expect(v01?.[1]).toBeCloseTo(0.1318251060359645, 14)
	expect(v01?.[2]).toBeCloseTo(0.9910274397144544, 14)
	expect(v02?.[0]).toBeCloseTo(-0.003712211763801968, 16)
	expect(v02?.[1]).toBeCloseTo(-0.004341519956299837, 16)
	expect(v02?.[2]).toBeCloseTo(0.9999836852110587, 14)
})

test('eraTpxes', () => {
	const [status, xi, eta] = erfa.eraTpxes(1.3, 1.55, 2.3, 1.5)
	expect(status).toBe(0)
	expect(xi).toBeCloseTo(-0.017532009832369806, 15)
	expect(eta).toBeCloseTo(0.05962940005778713, 15)
})

test('eraTpxev', () => {
	const [status, xi, eta] = erfa.eraTpxev(erfa.eraS2c(1.3, 1.55), erfa.eraS2c(2.3, 1.5))
	expect(status).toBe(0)
	expect(xi).toBeCloseTo(-0.017532009832369806, 15)
	expect(eta).toBeCloseTo(0.05962940005778713, 15)
})

test('eraEpb2jd', () => {
	const [djm0, djm] = erfa.eraEpb2jd(1957.3)
	expect(djm0).toBeCloseTo(2400000.5, 9)
	expect(djm).toBeCloseTo(35948.1915101513, 9)
})

test('eraEpj2jd', () => {
	const [djm0, djm] = erfa.eraEpj2jd(1996.8)
	expect(djm0).toBeCloseTo(2400000.5, 9)
	expect(djm).toBeCloseTo(50375.7, 9)
})

test('eraPlan94', () => {
	let pv = erfa.eraPlan94(2400000.5, -320000, 2)
	expect(pv[0][0]).toBeCloseTo(0.9308038666832975759, 11)
	expect(pv[0][1]).toBeCloseTo(0.3258319040261346, 11)
	expect(pv[0][2]).toBeCloseTo(0.142279454448114056, 11)
	expect(pv[1][0]).toBeCloseTo(-0.6429458958255170006e-2, 11)
	expect(pv[1][1]).toBeCloseTo(0.1468570657704237764e-1, 11)
	expect(pv[1][2]).toBeCloseTo(0.6406996426270981189e-2, 11)

	pv = erfa.eraPlan94(2400000.5, 43999.9, 0)
	expect(pv[0][0]).toBeCloseTo(0.2945293959257430832, 11)
	expect(pv[0][1]).toBeCloseTo(-0.2452204176601049596, 11)
	expect(pv[0][2]).toBeCloseTo(-0.1615427700571978153, 11)
	expect(pv[1][0]).toBeCloseTo(0.1413867871404614441e-1, 11)
	expect(pv[1][1]).toBeCloseTo(0.1946548301104706582e-1, 11)
	expect(pv[1][2]).toBeCloseTo(0.8929809783898904786e-2, 11)
})

test('eraPr00', () => {
	const [dpsipr, depspr] = erfa.eraPr00(2400000.5, 53736)
	expect(dpsipr).toBeCloseTo(-0.8716465172668348e-7, 22)
	expect(depspr).toBeCloseTo(-0.7342018386722813e-8, 22)
})

test('eraPrec76', () => {
	const [zeta, z, theta] = erfa.eraPrec76(2400000.5, 33282, 2400000.5, 51544)
	expect(zeta).toBeCloseTo(0.5588961642000161e-2, 12)
	expect(z).toBeCloseTo(0.5589922365870681e-2, 12)
	expect(theta).toBeCloseTo(0.4858945471687297e-2, 12)
})

test('eraPmat76', () => {
	const m = erfa.eraPmat76(2400000.5, 50123.9999)
	expect(m[0]).toBeCloseTo(0.9999995504328350733, 12)
	expect(m[1]).toBeCloseTo(0.8696632209480960785e-3, 12)
	expect(m[2]).toBeCloseTo(0.3779153474959888345e-3, 12)
	expect(m[3]).toBeCloseTo(-0.8696632209485112192e-3, 12)
	expect(m[4]).toBeCloseTo(0.9999996218428560614, 12)
	expect(m[5]).toBeCloseTo(-0.1643284776111886407e-6, 12)
	expect(m[6]).toBeCloseTo(-0.3779153474950335077e-3, 12)
	expect(m[7]).toBeCloseTo(-0.1643306746147366896e-6, 12)
	expect(m[8]).toBeCloseTo(0.9999999285899790119, 12)
})

test('eraPb06', () => {
	const [bzeta, bz, btheta] = erfa.eraPb06(2400000.5, 50123.9999)
	expect(bzeta).toBeCloseTo(-0.5092634016326478e-3, 12)
	expect(bz).toBeCloseTo(-0.36027720605660444e-3, 12)
	expect(btheta).toBeCloseTo(-0.3779735537167811e-3, 12)
})

test('eraS00', () => {
	expect(erfa.eraS00(2400000.5, 53736, 0.5791308486706011e-3, 0.4020579816732961219e-4)).toBeCloseTo(-0.12200362632709057e-7, 18)
})

test('eraS00a', () => {
	expect(erfa.eraS00a(2400000.5, 52541)).toBeCloseTo(-0.1340684448919163584e-7, 18)
})

test('eraS00b', () => {
	expect(erfa.eraS00b(2400000.5, 52541)).toBeCloseTo(-0.1340695782951026584e-7, 18)
})

test('eraS06a', () => {
	expect(erfa.eraS06a(2400000.5, 52541)).toBeCloseTo(-0.1340680437291812383e-7, 18)
})

test('eraXys00a', () => {
	const [x, y, s] = erfa.eraXys00a(2400000.5, 53736)
	expect(x).toBeCloseTo(0.5791308472168152904e-3, 14)
	expect(y).toBeCloseTo(0.4020595661591500259e-4, 15)
	expect(s).toBeCloseTo(-0.1220040848471549623e-7, 18)
})

test('eraXys00b', () => {
	const [x, y, s] = erfa.eraXys00b(2400000.5, 53736)
	expect(x).toBeCloseTo(0.5791301929950208873e-3, 14)
	expect(y).toBeCloseTo(0.4020553681373720832e-4, 15)
	expect(s).toBeCloseTo(-0.1220027377285083189e-7, 18)
})

test('eraXys06a', () => {
	const [x, y, s] = erfa.eraXys06a(2400000.5, 53736)
	expect(x).toBeCloseTo(0.5791308482835292617e-3, 14)
	expect(y).toBeCloseTo(0.402058009945402031e-4, 15)
	expect(s).toBeCloseTo(-0.1220032294164579896e-7, 18)
})

test('eraC2ibpn', () => {
	const m = erfa.eraC2ibpn(2400000.5, 50123.9999, [0.9999962358680738, -0.002516417057665452, -0.00109356978534237, 0.002516462370370876, 0.9999968329010883, 0.0000400615958735831, 0.001093465510215479, -0.00004281337229063151, 0.9999994012499173])
	expect(m[0]).toBeCloseTo(0.9999994021664089977, 12)
	expect(m[1]).toBeCloseTo(-0.3869195948017503664e-8, 12)
	expect(m[2]).toBeCloseTo(-0.1093465511383285076e-2, 12)
	expect(m[3]).toBeCloseTo(0.5068413965715446111e-7, 12)
	expect(m[4]).toBeCloseTo(0.9999999990835075686, 12)
	expect(m[5]).toBeCloseTo(0.4281334246452708915e-4, 12)
	expect(m[6]).toBeCloseTo(0.1093465510215479e-2, 12)
	expect(m[7]).toBeCloseTo(-0.4281337229063151e-4, 12)
	expect(m[8]).toBeCloseTo(0.9999994012499173103, 12)
})

test('eraC2ixy', () => {
	const m = erfa.eraC2ixy(2400000.5, 53736, 0.5791308486706011e-3, 0.4020579816732961219e-4)
	expect(m[0]).toBeCloseTo(0.9999998323037157138, 12)
	expect(m[1]).toBeCloseTo(0.5581526349032241205e-9, 12)
	expect(m[2]).toBeCloseTo(-0.5791308491611263745e-3, 12)
	expect(m[3]).toBeCloseTo(-0.2384257057469842953e-7, 12)
	expect(m[4]).toBeCloseTo(0.9999999991917468964, 12)
	expect(m[5]).toBeCloseTo(-0.4020579110172324363e-4, 12)
	expect(m[6]).toBeCloseTo(0.5791308486706011e-3, 12)
	expect(m[7]).toBeCloseTo(0.4020579816732961219e-4, 12)
	expect(m[8]).toBeCloseTo(0.999999831495462759, 12)
})

test('eraBp00', () => {
	const [rb, rp, rbp] = erfa.eraBp00(2400000.5, 50123.9999)
	expect(rb[0]).toBeCloseTo(0.9999999999999942498, 12)
	expect(rb[1]).toBeCloseTo(-0.7078279744199196626e-7, 12)
	expect(rb[2]).toBeCloseTo(0.8056217146976134152e-7, 12)
	expect(rb[3]).toBeCloseTo(0.7078279477857337206e-7, 12)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3306041454222136517e-7, 12)
	expect(rb[6]).toBeCloseTo(-0.8056217380986972157e-7, 12)
	expect(rb[7]).toBeCloseTo(-0.33060408839805525e-7, 12)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)
	expect(rp[0]).toBeCloseTo(0.9999995504864048241, 12)
	expect(rp[1]).toBeCloseTo(0.8696113836207084411e-3, 12)
	expect(rp[2]).toBeCloseTo(0.3778928813389333402e-3, 12)
	expect(rp[3]).toBeCloseTo(-0.8696113818227265968e-3, 12)
	expect(rp[4]).toBeCloseTo(0.9999996218879365258, 12)
	expect(rp[5]).toBeCloseTo(-0.1690679263009242066e-6, 12)
	expect(rp[6]).toBeCloseTo(-0.3778928854764695214e-3, 12)
	expect(rp[7]).toBeCloseTo(-0.1595521004195286491e-6, 12)
	expect(rp[8]).toBeCloseTo(0.9999999285984682756, 12)
	expect(rbp[0]).toBeCloseTo(0.999999550517508726, 12)
	expect(rbp[1]).toBeCloseTo(0.8695405883617884705e-3, 12)
	expect(rbp[2]).toBeCloseTo(0.3779734722239007105e-3, 12)
	expect(rbp[3]).toBeCloseTo(-0.8695405990410863719e-3, 12)
	expect(rbp[4]).toBeCloseTo(0.99999962194949259, 12)
	expect(rbp[5]).toBeCloseTo(-0.1360775820404982209e-6, 12)
	expect(rbp[6]).toBeCloseTo(-0.3779734476558184991e-3, 12)
	expect(rbp[7]).toBeCloseTo(-0.1925857585832024058e-6, 12)
	expect(rbp[8]).toBeCloseTo(0.9999999285680153377, 12)
})

test('eraPmat00', () => {
	const m = erfa.eraPmat00(2400000.5, 50123.9999)
	expect(m[8]).toBeCloseTo(0.9999999285680153, 12)
	expect(m[0]).toBeCloseTo(0.999999550517508726, 12)
	expect(m[1]).toBeCloseTo(0.8695405883617884705e-3, 12)
	expect(m[2]).toBeCloseTo(0.3779734722239007105e-3, 12)
	expect(m[3]).toBeCloseTo(-0.8695405990410863719e-3, 12)
	expect(m[4]).toBeCloseTo(0.99999962194949259, 12)
	expect(m[5]).toBeCloseTo(-0.1360775820404982209e-6, 12)
	expect(m[6]).toBeCloseTo(-0.3779734476558184991e-3, 12)
	expect(m[7]).toBeCloseTo(-0.1925857585832024058e-6, 12)
	expect(m[8]).toBeCloseTo(0.9999999285680153377, 12)
})

test('eraPn00', () => {
	const [epsa, rb, rp, rbp, rn, rbpn] = erfa.eraPn00(2400000.5, 53736, -0.9632552291149336e-5, 0.40631971066211414e-4)
	expect(epsa).toBeCloseTo(0.409079178940423, 12)
	expect(rb[0]).toBeCloseTo(0.9999999999999942498, 12)
	expect(rb[1]).toBeCloseTo(-0.7078279744199196626e-7, 12)
	expect(rb[2]).toBeCloseTo(0.8056217146976134152e-7, 12)
	expect(rb[3]).toBeCloseTo(0.7078279477857337206e-7, 12)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3306041454222136517e-7, 12)
	expect(rb[6]).toBeCloseTo(-0.8056217380986972157e-7, 12)
	expect(rb[7]).toBeCloseTo(-0.33060408839805525e-7, 12)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)
	expect(rp[0]).toBeCloseTo(0.9999989300532289018, 12)
	expect(rp[1]).toBeCloseTo(-0.1341647226791824349e-2, 12)
	expect(rp[2]).toBeCloseTo(-0.5829880927190296547e-3, 12)
	expect(rp[3]).toBeCloseTo(0.1341647231069759008e-2, 12)
	expect(rp[4]).toBeCloseTo(0.9999990999908750433, 12)
	expect(rp[5]).toBeCloseTo(-0.3837444441583715468e-6, 12)
	expect(rp[6]).toBeCloseTo(0.5829880828740957684e-3, 12)
	expect(rp[7]).toBeCloseTo(-0.3984203267708834759e-6, 12)
	expect(rp[8]).toBeCloseTo(0.9999998300623538046, 12)
	expect(rbp[0]).toBeCloseTo(0.9999989300052243993, 12)
	expect(rbp[1]).toBeCloseTo(-0.1341717990239703727e-2, 12)
	expect(rbp[2]).toBeCloseTo(-0.5829075749891684053e-3, 12)
	expect(rbp[3]).toBeCloseTo(0.1341718013831739992e-2, 12)
	expect(rbp[4]).toBeCloseTo(0.9999990998959191343, 12)
	expect(rbp[5]).toBeCloseTo(-0.350575973356542117e-6, 12)
	expect(rbp[6]).toBeCloseTo(0.5829075206857717883e-3, 12)
	expect(rbp[7]).toBeCloseTo(-0.431521995519860897e-6, 12)
	expect(rbp[8]).toBeCloseTo(0.9999998301093036269, 12)
	expect(rn[0]).toBeCloseTo(0.9999999999536069682, 12)
	expect(rn[1]).toBeCloseTo(0.8837746144872140812e-5, 12)
	expect(rn[2]).toBeCloseTo(0.3831488838252590008e-5, 12)
	expect(rn[3]).toBeCloseTo(-0.8837590456633197506e-5, 12)
	expect(rn[4]).toBeCloseTo(0.9999999991354692733, 12)
	expect(rn[5]).toBeCloseTo(-0.4063198798559573702e-4, 12)
	expect(rn[6]).toBeCloseTo(-0.3831847930135328368e-5, 12)
	expect(rn[7]).toBeCloseTo(0.4063195412258150427e-4, 12)
	expect(rn[8]).toBeCloseTo(0.9999999991671806225, 12)
	expect(rbpn[0]).toBeCloseTo(0.9999989440499982806, 12)
	expect(rbpn[1]).toBeCloseTo(-0.1332880253640848301e-2, 12)
	expect(rbpn[2]).toBeCloseTo(-0.5790760898731087295e-3, 12)
	expect(rbpn[3]).toBeCloseTo(0.1332856746979948745e-2, 12)
	expect(rbpn[4]).toBeCloseTo(0.9999991109064768883, 12)
	expect(rbpn[5]).toBeCloseTo(-0.4097740555723063806e-4, 12)
	expect(rbpn[6]).toBeCloseTo(0.5791301929950205e-3, 12)
	expect(rbpn[7]).toBeCloseTo(0.4020553681373702931e-4, 12)
	expect(rbpn[8]).toBeCloseTo(0.9999998314958529887, 12)
})

test('eraPn00a', () => {
	const [dpsi, deps, epsa, rb, rp, rbp, rn, rbpn] = erfa.eraPn00a(2400000.5, 53736)
	expect(dpsi).toBeCloseTo(-0.9630909107115518e-5, 12)
	expect(deps).toBeCloseTo(0.40632391740016787e-4, 12)
	expect(epsa).toBeCloseTo(0.409079178940423, 12)
	expect(rb[0]).toBeCloseTo(0.9999999999999942498, 12)
	expect(rb[1]).toBeCloseTo(-0.7078279744199196626e-7, 12)
	expect(rb[2]).toBeCloseTo(0.8056217146976134152e-7, 12)
	expect(rb[3]).toBeCloseTo(0.7078279477857337206e-7, 12)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3306041454222136517e-7, 12)
	expect(rb[6]).toBeCloseTo(-0.8056217380986972157e-7, 12)
	expect(rb[7]).toBeCloseTo(-0.33060408839805525e-7, 12)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)
	expect(rp[0]).toBeCloseTo(0.9999989300532289018, 12)
	expect(rp[1]).toBeCloseTo(-0.1341647226791824349e-2, 12)
	expect(rp[2]).toBeCloseTo(-0.5829880927190296547e-3, 12)
	expect(rp[3]).toBeCloseTo(0.1341647231069759008e-2, 12)
	expect(rp[4]).toBeCloseTo(0.9999990999908750433, 12)
	expect(rp[5]).toBeCloseTo(-0.3837444441583715468e-6, 12)
	expect(rp[6]).toBeCloseTo(0.5829880828740957684e-3, 12)
	expect(rp[7]).toBeCloseTo(-0.3984203267708834759e-6, 12)
	expect(rp[8]).toBeCloseTo(0.9999998300623538046, 12)
	expect(rbp[0]).toBeCloseTo(0.9999989300052243993, 12)
	expect(rbp[1]).toBeCloseTo(-0.1341717990239703727e-2, 12)
	expect(rbp[2]).toBeCloseTo(-0.5829075749891684053e-3, 12)
	expect(rbp[3]).toBeCloseTo(0.1341718013831739992e-2, 12)
	expect(rbp[4]).toBeCloseTo(0.9999990998959191343, 12)
	expect(rbp[5]).toBeCloseTo(-0.350575973356542117e-6, 12)
	expect(rbp[6]).toBeCloseTo(0.5829075206857717883e-3, 12)
	expect(rbp[7]).toBeCloseTo(-0.431521995519860897e-6, 12)
	expect(rbp[8]).toBeCloseTo(0.9999998301093036269, 12)
	expect(rn[0]).toBeCloseTo(0.9999999999536227949, 12)
	expect(rn[1]).toBeCloseTo(0.8836238544090873336e-5, 12)
	expect(rn[2]).toBeCloseTo(0.3830835237722400669e-5, 12)
	expect(rn[3]).toBeCloseTo(-0.8836082880798569274e-5, 12)
	expect(rn[4]).toBeCloseTo(0.9999999991354655028, 12)
	expect(rn[5]).toBeCloseTo(-0.406324086536249985e-4, 12)
	expect(rn[6]).toBeCloseTo(-0.3831194272065995866e-5, 12)
	expect(rn[7]).toBeCloseTo(0.4063237480216291775e-4, 12)
	expect(rn[8]).toBeCloseTo(0.9999999991671660338, 12)
	expect(rbpn[0]).toBeCloseTo(0.9999989440476103435, 12)
	expect(rbpn[1]).toBeCloseTo(-0.1332881761240011763e-2, 12)
	expect(rbpn[2]).toBeCloseTo(-0.5790767434730085751e-3, 12)
	expect(rbpn[3]).toBeCloseTo(0.1332858254308954658e-2, 12)
	expect(rbpn[4]).toBeCloseTo(0.9999991109044505577, 12)
	expect(rbpn[5]).toBeCloseTo(-0.4097782710396580452e-4, 12)
	expect(rbpn[6]).toBeCloseTo(0.5791308472168152904e-3, 12)
	expect(rbpn[7]).toBeCloseTo(0.4020595661591500259e-4, 12)
	expect(rbpn[8]).toBeCloseTo(0.9999998314954572304, 12)
})

test('eraPn00b', () => {
	const [dpsi, deps, epsa, rb, rp, rbp, rn, rbpn] = erfa.eraPn00b(2400000.5, 53736)
	expect(dpsi).toBeCloseTo(-0.9632552291148363e-5, 12)
	expect(deps).toBeCloseTo(0.40631971066211594e-4, 12)
	expect(epsa).toBeCloseTo(0.409079178940423, 12)
	expect(rb[0]).toBeCloseTo(0.9999999999999942498, 12)
	expect(rb[1]).toBeCloseTo(-0.7078279744199196626e-7, 12)
	expect(rb[2]).toBeCloseTo(0.8056217146976134152e-7, 12)
	expect(rb[3]).toBeCloseTo(0.7078279477857337206e-7, 12)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3306041454222136517e-7, 12)
	expect(rb[6]).toBeCloseTo(-0.8056217380986972157e-7, 12)
	expect(rb[7]).toBeCloseTo(-0.33060408839805525e-7, 12)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)
	expect(rp[0]).toBeCloseTo(0.9999989300532289018, 12)
	expect(rp[1]).toBeCloseTo(-0.1341647226791824349e-2, 12)
	expect(rp[2]).toBeCloseTo(-0.5829880927190296547e-3, 12)
	expect(rp[3]).toBeCloseTo(0.1341647231069759008e-2, 12)
	expect(rp[4]).toBeCloseTo(0.9999990999908750433, 12)
	expect(rp[5]).toBeCloseTo(-0.3837444441583715468e-6, 12)
	expect(rp[6]).toBeCloseTo(0.5829880828740957684e-3, 12)
	expect(rp[7]).toBeCloseTo(-0.3984203267708834759e-6, 12)
	expect(rp[8]).toBeCloseTo(0.9999998300623538046, 12)
	expect(rbp[0]).toBeCloseTo(0.9999989300052243993, 12)
	expect(rbp[1]).toBeCloseTo(-0.1341717990239703727e-2, 12)
	expect(rbp[2]).toBeCloseTo(-0.5829075749891684053e-3, 12)
	expect(rbp[3]).toBeCloseTo(0.1341718013831739992e-2, 12)
	expect(rbp[4]).toBeCloseTo(0.9999990998959191343, 12)
	expect(rbp[5]).toBeCloseTo(-0.350575973356542117e-6, 12)
	expect(rbp[6]).toBeCloseTo(0.5829075206857717883e-3, 12)
	expect(rbp[7]).toBeCloseTo(-0.431521995519860897e-6, 12)
	expect(rbp[8]).toBeCloseTo(0.9999998301093036269, 12)
	expect(rn[0]).toBeCloseTo(0.9999999999536069682, 12)
	expect(rn[1]).toBeCloseTo(0.8837746144871248011e-5, 12)
	expect(rn[2]).toBeCloseTo(0.3831488838252202945e-5, 12)
	expect(rn[3]).toBeCloseTo(-0.883759045663230472e-5, 12)
	expect(rn[4]).toBeCloseTo(0.9999999991354692733, 12)
	expect(rn[5]).toBeCloseTo(-0.4063198798559591654e-4, 12)
	expect(rn[6]).toBeCloseTo(-0.3831847930134941271e-5, 12)
	expect(rn[7]).toBeCloseTo(0.406319541225816838e-4, 12)
	expect(rn[8]).toBeCloseTo(0.9999999991671806225, 12)
	expect(rbpn[0]).toBeCloseTo(0.9999989440499982806, 12)
	expect(rbpn[1]).toBeCloseTo(-0.1332880253640849194e-2, 12)
	expect(rbpn[2]).toBeCloseTo(-0.5790760898731091166e-3, 12)
	expect(rbpn[3]).toBeCloseTo(0.1332856746979949638e-2, 12)
	expect(rbpn[4]).toBeCloseTo(0.9999991109064768883, 12)
	expect(rbpn[5]).toBeCloseTo(-0.4097740555723081811e-4, 12)
	expect(rbpn[6]).toBeCloseTo(0.5791301929950208873e-3, 12)
	expect(rbpn[7]).toBeCloseTo(0.4020553681373720832e-4, 12)
	expect(rbpn[8]).toBeCloseTo(0.9999998314958529887, 12)
})

test('eraPnm00a', () => {
	const rbpn = erfa.eraPnm00a(2400000.5, 50123.9999)
	expect(rbpn[0]).toBeCloseTo(0.9999995832793134257, 12)
	expect(rbpn[1]).toBeCloseTo(0.8372384254137809439e-3, 12)
	expect(rbpn[2]).toBeCloseTo(0.3639684306407150645e-3, 12)
	expect(rbpn[3]).toBeCloseTo(-0.8372535226570394543e-3, 12)
	expect(rbpn[4]).toBeCloseTo(0.9999996486491582471, 12)
	expect(rbpn[5]).toBeCloseTo(0.4132915262664072381e-4, 12)
	expect(rbpn[6]).toBeCloseTo(-0.3639337004054317729e-3, 12)
	expect(rbpn[7]).toBeCloseTo(-0.4163386925461775873e-4, 12)
	expect(rbpn[8]).toBeCloseTo(0.9999999329094390695, 12)
})

test('eraPnm00b', () => {
	const rbpn = erfa.eraPnm00b(2400000.5, 50123.9999)
	expect(rbpn[0]).toBeCloseTo(0.999999583277620828, 12)
	expect(rbpn[1]).toBeCloseTo(0.8372401264429654837e-3, 12)
	expect(rbpn[2]).toBeCloseTo(0.3639691681450271771e-3, 12)
	expect(rbpn[3]).toBeCloseTo(-0.8372552234147137424e-3, 12)
	expect(rbpn[4]).toBeCloseTo(0.9999996486477686123, 12)
	expect(rbpn[5]).toBeCloseTo(0.413283219094605289e-4, 12)
	expect(rbpn[6]).toBeCloseTo(-0.3639344385341866407e-3, 12)
	expect(rbpn[7]).toBeCloseTo(-0.4163303977421522785e-4, 12)
	expect(rbpn[8]).toBeCloseTo(0.9999999329092049734, 12)
})

test('eraC2i00a', () => {
	const rc2i = erfa.eraC2i00a(2400000.5, 53736)
	expect(rc2i[0]).toBeCloseTo(0.9999998323037165557, 12)
	expect(rc2i[1]).toBeCloseTo(0.5581526348992140183e-9, 12)
	expect(rc2i[2]).toBeCloseTo(-0.5791308477073443415e-3, 12)
	expect(rc2i[3]).toBeCloseTo(-0.2384266227870752452e-7, 12)
	expect(rc2i[4]).toBeCloseTo(0.9999999991917405258, 12)
	expect(rc2i[5]).toBeCloseTo(-0.4020594955028209745e-4, 12)
	expect(rc2i[6]).toBeCloseTo(0.5791308472168152904e-3, 12)
	expect(rc2i[7]).toBeCloseTo(0.4020595661591500259e-4, 12)
	expect(rc2i[8]).toBeCloseTo(0.9999998314954572304, 12)
})

test('eraC2i00b', () => {
	const rc2i = erfa.eraC2i00b(2400000.5, 53736)
	expect(rc2i[0]).toBeCloseTo(0.9999998323040954356, 12)
	expect(rc2i[1]).toBeCloseTo(0.5581526349131823372e-9, 12)
	expect(rc2i[2]).toBeCloseTo(-0.5791301934855394005e-3, 12)
	expect(rc2i[3]).toBeCloseTo(-0.2384239285499175543e-7, 12)
	expect(rc2i[4]).toBeCloseTo(0.9999999991917574043, 12)
	expect(rc2i[5]).toBeCloseTo(-0.4020552974819030066e-4, 12)
	expect(rc2i[6]).toBeCloseTo(0.5791301929950208873e-3, 12)
	expect(rc2i[7]).toBeCloseTo(0.4020553681373720832e-4, 12)
	expect(rc2i[8]).toBeCloseTo(0.9999998314958529887, 12)
})

test('eraC2t00a', () => {
	const rc2t = erfa.eraC2t00a(2400000.5, 53736, 2400000.5, 53736, 2.55060238e-7, 1.860359247e-6)
	expect(rc2t[0]).toBeCloseTo(-0.1810332128307182668, 12)
	expect(rc2t[1]).toBeCloseTo(0.9834769806938457836, 12)
	expect(rc2t[2]).toBeCloseTo(0.6555535638688341725e-4, 12)
	expect(rc2t[3]).toBeCloseTo(-0.9834768134135984552, 12)
	expect(rc2t[4]).toBeCloseTo(-0.1810332203649520727, 12)
	expect(rc2t[5]).toBeCloseTo(0.5749801116141056317e-3, 12)
	expect(rc2t[6]).toBeCloseTo(0.5773474014081406921e-3, 12)
	expect(rc2t[7]).toBeCloseTo(0.3961832391770163647e-4, 12)
	expect(rc2t[8]).toBeCloseTo(0.9999998325501692289, 12)
})

test('eraC2t00b', () => {
	const rc2t = erfa.eraC2t00b(2400000.5, 53736, 2400000.5, 53736, 2.55060238e-7, 1.860359247e-6)
	expect(rc2t[0]).toBeCloseTo(-0.1810332128439678965, 12)
	expect(rc2t[1]).toBeCloseTo(0.9834769806913872359, 12)
	expect(rc2t[2]).toBeCloseTo(0.6555565082458415611e-4, 12)
	expect(rc2t[3]).toBeCloseTo(-0.9834768134115435923, 12)
	expect(rc2t[4]).toBeCloseTo(-0.1810332203784001946, 12)
	expect(rc2t[5]).toBeCloseTo(0.574979392203001723e-3, 12)
	expect(rc2t[6]).toBeCloseTo(0.5773467471863534901e-3, 12)
	expect(rc2t[7]).toBeCloseTo(0.396179041154994502e-4, 12)
	expect(rc2t[8]).toBeCloseTo(0.9999998325505635738, 12)
})

test('eraC2tpe', () => {
	const rc2t = erfa.eraC2tpe(2400000.5, 53736, 2400000.5, 53736, -0.9630909107115582393e-5, 0.40907897633565099, 2.55060238e-7, 1.860359247e-6)
	expect(rc2t[0]).toBeCloseTo(-0.1813677995763029394, 12)
	expect(rc2t[1]).toBeCloseTo(0.9023482206891683275, 12)
	expect(rc2t[2]).toBeCloseTo(-0.3909902938641085751, 12)
	expect(rc2t[3]).toBeCloseTo(-0.9834147641476804807, 12)
	expect(rc2t[4]).toBeCloseTo(-0.1659883635434995121, 12)
	expect(rc2t[5]).toBeCloseTo(0.7309763898042819705e-1, 12)
	expect(rc2t[6]).toBeCloseTo(0.1059685430673215247e-2, 12)
	expect(rc2t[7]).toBeCloseTo(0.3977631855605078674, 12)
	expect(rc2t[8]).toBeCloseTo(0.9174875068792735362, 12)
})

test('eraC2txy', () => {
	const rc2t = erfa.eraC2txy(2400000.5, 53736, 2400000.5, 53736, 0.5791308486706011e-3, 0.4020579816732961219e-4, 2.55060238e-7, 1.860359247e-6)
	expect(rc2t[0]).toBeCloseTo(-0.1810332128306279253, 12)
	expect(rc2t[1]).toBeCloseTo(0.9834769806938520084, 12)
	expect(rc2t[2]).toBeCloseTo(0.6555551248057665829e-4, 12)
	expect(rc2t[3]).toBeCloseTo(-0.9834768134136142314, 12)
	expect(rc2t[4]).toBeCloseTo(-0.1810332203649529312, 12)
	expect(rc2t[5]).toBeCloseTo(0.5749800843594139912e-3, 12)
	expect(rc2t[6]).toBeCloseTo(0.5773474028619264494e-3, 12)
	expect(rc2t[7]).toBeCloseTo(0.396181654691162426e-4, 12)
	expect(rc2t[8]).toBeCloseTo(0.999999832550174667, 12)
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

test('eraGst00a', () => {
	expect(erfa.eraGst00a(2400000.5, 53736, 2400000.5, 53736)).toBeCloseTo(1.754166138018281369, 12)
})

test('eraGst00b', () => {
	expect(erfa.eraGst00b(2400000.5, 53736)).toBeCloseTo(1.754166136510680589, 12)
})

test('eraGst94', () => {
	expect(erfa.eraGst94(2400000.5, 53736)).toBeCloseTo(1.754166136020645203, 13)
})

test('eraGst06', () => {
	const rnpb: Mat3 = [0.9999989440476103608, -0.1332881761240011518e-2, -0.5790767434730085097e-3, 0.1332858254308954453e-2, 0.9999991109044505944, -0.4097782710401555759e-4, 0.579130847216815332e-3, 0.4020595661593994396e-4, 0.9999998314954572365]
	expect(erfa.eraGst06(2453736, 0.5, 2453736, 0.5, rnpb)).toBeCloseTo(1.754166138018167568, 13)
})

test('eraGmst82', () => {
	expect(erfa.eraGmst82(2453736, 0.5)).toBeCloseTo(1.754174981860675096, 13)
})

test('eraGmst00', () => {
	expect(erfa.eraGmst00(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.75417497221074059, 13)
})

test('eraGmst06', () => {
	expect(erfa.eraGmst06(2453736, 0.5, 2453736, 0.5)).toBeCloseTo(1.754174971870091203, 13)
})

test('eraEqeq94', () => {
	expect(erfa.eraEqeq94(2400000.5, 41234)).toBeCloseTo(0.5357758254609256894e-4, 17)
})

test('eraEe00', () => {
	expect(erfa.eraEe00(2400000.5, 53736, 0.40907897633565099, -0.9630909107115582393e-5)).toBeCloseTo(-0.8834193235367965479e-5, 18)
})

test('eraEe00a', () => {
	expect(erfa.eraEe00a(2400000.5, 53736)).toBeCloseTo(-0.8834192459222588227e-5, 17)
})

test('eraEe00b', () => {
	expect(erfa.eraEe00b(2400000.5, 53736)).toBeCloseTo(-0.8835700060003032831e-5, 18)
})

test('eraEect00', () => {
	expect(erfa.eraEect00(2400000.5, 53736)).toBeCloseTo(0.2046085004885125264e-8, 20)
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

test('eraObl80', () => {
	expect(erfa.eraObl80(2400000.5, 54388)).toBeCloseTo(0.4090751347643816218, 15)
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

test('eraFane03', () => {
	expect(erfa.eraFane03(0.8)).toBeCloseTo(2.079343830860413523, 13)
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

test('eraNut80', () => {
	const a = erfa.eraNut80(2400000.5, 53736)
	expect(a[0]).toBeCloseTo(-0.9643658353226563966e-5, 14)
	expect(a[1]).toBeCloseTo(0.4060051006879713322e-4, 14)
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
	const [ra, dec, pmr, pmd, px, rv] = erfa.eraStarpm(0.01686756, -1.093989828, -1.78323516e-5, 2.336024047e-6, arcsec(0.74723), kilometerPerSecond(-21.6), 2400000.5, 50083, 2400000.5, 53736) as Exclude<ReturnType<typeof erfa.eraStarpm>, false>

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
			bm: 1,
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
	const r = erfa.eraC2i06a(2400000.5, 53736)

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
	const r = erfa.eraC2t06a(2400000.5, 53736, 2400000.5, 53736, 2.55060238e-7, 1.860359247e-6, 0)

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
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)

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
	expect(astrom.eo).toBeCloseTo(-0.2900618712657375647e-2, 13)
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
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const p = erfa.eraAtccq(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom)
	const [ra, dec] = erfa.eraC2s(...p)

	expect(ra).toBeCloseTo(2.710126504531372384, 13)
	expect(dec).toBeCloseTo(0.1740632537628350152, 13)
})

test('eraAtciq', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const [ra, dec] = erfa.eraAtciq(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom)

	expect(ra).toBeCloseTo(2.710121572968696744, 13)
	expect(dec).toBeCloseTo(0.1729371367219539137, 13)
})

test('eraAtciqz', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const [ri, di] = erfa.eraAtciqz(2.71, 0.174, astrom)

	expect(ri).toBeCloseTo(2.709994899247256984, 13)
	expect(di).toBeCloseTo(0.1728740720984931891, 13)
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

const DAY_FRACTION_SCRATCH = [0, 0]

test('eraApco13', () => {
	const ebp = [-0.974170437669016342, -0.211520082035387968, -0.091758302425478583] as const
	const ebv = [0.003643658242375083, -0.015428731944935825, -0.006689220237864495] as const
	const ehp = [-0.973458265012157486, -0.209215306558769298, -0.090699647709202746] as const

	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const astrom = erfa.eraApco13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55, [ebp, ebv], ehp)

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
	expect(astrom.eo).toBeCloseTo(-0.003020548354802412839, 15)
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
	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const astrom = erfa.eraApio13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)

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
	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const astrom = erfa.eraApio13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)
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
	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)

	const astrom = erfa.eraApio13(tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)

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

test('eraAticq', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const [rc, dc] = erfa.eraAticq(2.710121572969038991, 0.1729371367218230438, astrom)

	expect(rc).toBeCloseTo(2.710126504531716819, 13)
	expect(dc).toBeCloseTo(0.1740632537627034482, 13)
})

test('eraEpv0', () => {
	const [pvb, pvh] = eraEpv00(2400000.5, 53411.52501161)

	expect(pvh[0][0]).toBeCloseTo(-0.7757238809297706813, 13)
	expect(pvh[0][1]).toBeCloseTo(0.5598052241363340596, 13)
	expect(pvh[0][2]).toBeCloseTo(0.2426998466481686993, 13)

	expect(pvh[1][0]).toBeCloseTo(-0.1091891824147313846e-1, 14)
	expect(pvh[1][1]).toBeCloseTo(-0.1247187268440845008e-1, 14)
	expect(pvh[1][2]).toBeCloseTo(-0.5407569418065039061e-2, 14)

	expect(pvb[0][0]).toBeCloseTo(-0.7714104440491111971, 13)
	expect(pvb[0][1]).toBeCloseTo(0.5598412061824171323, 13)
	expect(pvb[0][2]).toBeCloseTo(0.24259962777224524, 13)

	expect(pvb[1][0]).toBeCloseTo(-0.1091874268116823295e-1, 14)
	expect(pvb[1][1]).toBeCloseTo(-0.1246525461732861538e-1, 14)
	expect(pvb[1][2]).toBeCloseTo(-0.5404773180966231279e-2, 14)
})

test('eraAtci13', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const

	const [ri, di, astrom] = erfa.eraAtci13(2456165.5, 0.401182685, 2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), [pb, vb], ph)

	expect(ri).toBeCloseTo(2.710121572968696744, 13)
	expect(di).toBeCloseTo(0.1729371367219539137, 13)
	expect(astrom.eo).toBeCloseTo(-0.002900618712657375647, 15)
})

test('eraAtcc13', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const
	const p = erfa.eraAtcc13(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), 2456165.5, 0.401182685, [pb, vb], ph)
	const [ra, da] = erfa.eraC2s(...p)

	expect(ra).toBeCloseTo(2.710126504531372384, 13)
	expect(da).toBeCloseTo(0.1740632537628350152, 13)
})

test('eraAtciqn', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const
	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const bodies = [
		{ bm: 0.00028574, dl: 3e-10, p: [-7.81014427, -5.60956681, -1.98079819] as const, v: [0.0030723249, -0.00406995477, -0.00181335842] as const },
		{ bm: 0.00095435, dl: 3e-9, p: [0.738098796, 4.63658692, 1.9693136] as const, v: [-0.00755816922, 0.00126913722, 0.000727999001] as const },
		{ bm: 1, dl: 6e-6, p: [-0.000712174377, -0.00230478303, -0.00105865966] as const, v: [6.29235213e-6, -3.30888387e-7, -2.96486623e-7] as const },
	]
	const [ri, di] = erfa.eraAtciqn(2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), astrom, bodies)

	expect(ri).toBeCloseTo(2.710122008104983335, 13)
	expect(di).toBeCloseTo(0.1729371916492767821, 13)
})

test('eraAtic13', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const
	const [rc, dc, astrom] = erfa.eraAtic13(2.710121572969038991, 0.1729371367218230438, 2456165.5, 0.401182685, [pb, vb], ph)

	expect(rc).toBeCloseTo(2.710126504531716819, 13)
	expect(dc).toBeCloseTo(0.1740632537627034482, 13)
	expect(astrom.eo).toBeCloseTo(-0.002900618712657375647, 15)
})

test('eraAticqn', () => {
	const ph = [0.903358544130430152, -0.415395237027994912, -0.180084014143265775] as const
	const pb = [0.901310874734066458, -0.41740266404059817, -0.180982287786775775] as const
	const vb = [0.007427279538863471, 0.014050745866797413, 0.006090457918538545] as const
	const astrom = erfa.eraApci13(2456165.5, 0.401182685, [pb, vb], ph)
	const bodies = [
		{ bm: 0.00028574, dl: 3e-10, p: [-7.81014427, -5.60956681, -1.98079819] as const, v: [0.0030723249, -0.00406995477, -0.00181335842] as const },
		{ bm: 0.00095435, dl: 3e-9, p: [0.738098796, 4.63658692, 1.9693136] as const, v: [-0.00755816922, 0.00126913722, 0.000727999001] as const },
		{ bm: 1, dl: 6e-6, p: [-0.000712174377, -0.00230478303, -0.00105865966] as const, v: [6.29235213e-6, -3.30888387e-7, -2.96486623e-7] as const },
	]
	const [rc, dc] = erfa.eraAticqn(2.709994899247599271, 0.1728740720983623469, astrom, bodies)

	expect(rc).toBeCloseTo(2.709999575033027333, 13)
	expect(dc).toBeCloseTo(0.173999965631646999, 13)
})

test('eraAtio13', () => {
	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)
	const [aob, zob, hob, rob, dob] = erfa.eraAtio13(2.710121572969038991, 0.1729371367218230438, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)

	expect(aob).toBeCloseTo(0.9233952224895122499e-1, 13)
	expect(zob).toBeCloseTo(1.407758704513549991, 13)
	expect(hob).toBeCloseTo(-0.924761987988169814e-1, 13)
	expect(dob).toBeCloseTo(0.1717653435756234676, 13)
	expect(rob).toBeCloseTo(2.710085107988480746, 13)
})

test('eraAtoi13', () => {
	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)

	let [ri, di] = erfa.eraAtoi13('R', 2.710085107986886201, 0.1717653435758265198, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)
	expect(ri).toBeCloseTo(2.71012157444754081, 13)
	expect(di).toBeCloseTo(0.1729371839116608778, 13)

	;[ri, di] = erfa.eraAtoi13('H', -0.09247619879782006106, 0.1717653435758265198, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)
	expect(ri).toBeCloseTo(2.710121574448138676, 13)
	expect(di).toBeCloseTo(0.1729371839116608778, 13)

	;[ri, di] = erfa.eraAtoi13('A', 0.09233952224794989993, 1.407758704513722461, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55)
	expect(ri).toBeCloseTo(2.710121574448138676, 13)
	expect(di).toBeCloseTo(0.1729371839116608781, 13)
})

test('eraAtco13', () => {
	const pb = [-0.974170437669016342, -0.211520082035387968, -0.091758302425478583] as const
	const vb = [0.003643658242375083, -0.015428731944935825, -0.006689220237864495] as const
	const ph = [-0.973458265012157486, -0.209215306558769298, -0.090699647709202746] as const

	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)

	const [aob, zob, hob, rob, dob, astrom] = erfa.eraAtco13(tt1, tt2, ut11, ut12, 2.71, 0.174, 1e-5, 5e-6, arcsec(0.1), kilometerPerSecond(55), -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55, [pb, vb], ph)

	expect(aob).toBeCloseTo(0.9251774485485515207e-1, 13)
	expect(zob).toBeCloseTo(1.407661405256499357, 13)
	expect(hob).toBeCloseTo(-0.9265154431529724692e-1, 13)
	expect(rob).toBeCloseTo(2.710260453504961012, 13)
	expect(dob).toBeCloseTo(0.17166265600725262, 13)
	expect(astrom.eo).toBeCloseTo(-0.003020548354802412839, 15)
})

test('eraAtoc13', () => {
	const pb = [-0.974170437669016342, -0.211520082035387968, -0.091758302425478583] as const
	const vb = [0.003643658242375083, -0.015428731944935825, -0.006689220237864495] as const
	const ph = [-0.973458265012157486, -0.209215306558769298, -0.090699647709202746] as const

	erfa.eraUtcTai(2456384.5, 0.969254051, DAY_FRACTION_SCRATCH)
	const [tt1, tt2] = erfa.eraTaiTt(DAY_FRACTION_SCRATCH[0], DAY_FRACTION_SCRATCH[1])
	const [ut11, ut12] = erfa.eraUtcUt1(2456384.5, 0.969254051, 0.1550675)

	let [rc, dc] = erfa.eraAtoc13('R', 2.710085107986886201, 0.1717653435758265198, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55, [pb, vb], ph)
	expect(rc).toBeCloseTo(2.709956744659136129, 13)
	expect(dc).toBeCloseTo(0.1741696500898471362, 13)

	;[rc, dc] = erfa.eraAtoc13('H', -0.09247619879782006106, 0.1717653435758265198, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55, [pb, vb], ph)
	expect(rc).toBeCloseTo(2.709956744659734086, 13)
	expect(dc).toBeCloseTo(0.1741696500898471362, 13)

	;[rc, dc] = erfa.eraAtoc13('A', 0.09233952224794989993, 1.407758704513722461, tt1, tt2, ut11, ut12, -0.527800806, -1.2345856, meter(2738), 2.47230737e-7, 1.82640464e-6, 0, 731, 12.8, 0.59, 0.55, [pb, vb], ph)
	expect(rc).toBeCloseTo(2.709956744659734086, 13)
	expect(dc).toBeCloseTo(0.1741696500898471366, 13)
})

test('eraEpb', () => {
	expect(erfa.eraEpb(2415019.8135, 30103.18648)).toBeCloseTo(1982.41842415927858, 11)
})

test('eraEpj', () => {
	expect(erfa.eraEpj(2451545, -7392.5)).toBeCloseTo(1979.760438056125941, 13)
})

test('eraMoon98', () => {
	const [p, v] = eraMoon98(2400000.5, 43999.9)

	expect(p[0]).toBeCloseTo(-0.260129595997104418e-2, 13)
	expect(p[1]).toBeCloseTo(0.6139750944302742189e-3, 13)
	expect(p[2]).toBeCloseTo(0.2640794528229828909e-3, 13)

	expect(v[0]).toBeCloseTo(-0.1244321506649895021e-3, 13)
	expect(v[1]).toBeCloseTo(-0.5219076942678119398e-3, 13)
	expect(v[2]).toBeCloseTo(-0.1716132214378462047e-3, 13)
})

test('eraEceq06', () => {
	const [dr, dd] = erfa.eraEceq06(2456165.5, 0.401182685, 5.1, -0.9)
	expect(dr).toBeCloseTo(5.533459733613627767, 14)
	expect(dd).toBeCloseTo(-1.246542932554480576, 14)
})

test('eraEcm06', () => {
	const m = erfa.eraEcm06(2456165.5, 0.401182685)
	expect(m[0]).toBeCloseTo(0.9999952427708701137, 14)
	expect(m[1]).toBeCloseTo(-0.2829062057663042347e-2, 14)
	expect(m[2]).toBeCloseTo(-0.1229163741100017629e-2, 14)
	expect(m[3]).toBeCloseTo(0.3084546876908653562e-2, 14)
	expect(m[4]).toBeCloseTo(0.9174891871550392514, 14)
	expect(m[5]).toBeCloseTo(0.3977487611849338124, 14)
	expect(m[6]).toBeCloseTo(0.2488512951527405928e-5, 14)
	expect(m[7]).toBeCloseTo(-0.3977506604161195467, 14)
	expect(m[8]).toBeCloseTo(0.9174935488232863071, 14)
})

test('eraEe06a', () => {
	expect(erfa.eraEe06a(2400000.5, 53736)).toBeCloseTo(-0.8834195072043790156e-5, 15)
})

test('eraEo06a', () => {
	expect(erfa.eraEo06a(2400000.5, 53736)).toBeCloseTo(-0.1332882371941833644e-2, 15)
})

test('eraEqec06', () => {
	const [dl, db] = erfa.eraEqec06(1234.5, 2440000.5, 1.234, 0.987)
	expect(dl).toBeCloseTo(1.342509918994654619, 14)
	expect(db).toBeCloseTo(0.5926215259704608132, 14)
})

test('eraP06e', () => {
	const [eps0, psia, oma, bpa, bqa, pia, bpia, epsa, chia, za, zetaa, thetaa, pa, gam, phi, psi] = erfa.eraP06e(2400000.5, 52541)
	expect(eps0).toBeCloseTo(0.4090926006005828715, 14)
	expect(psia).toBeCloseTo(0.6664369630191613431e-3, 14)
	expect(oma).toBeCloseTo(0.4090925973783255982, 14)
	expect(bpa).toBeCloseTo(0.5561149371265209445e-6, 14)
	expect(bqa).toBeCloseTo(-0.619151719329062127e-5, 14)
	expect(pia).toBeCloseTo(0.6216441751884382923e-5, 14)
	expect(bpia).toBeCloseTo(3.052014180023779882, 14)
	expect(epsa).toBeCloseTo(0.4090864054922431688, 14)
	expect(chia).toBeCloseTo(0.1387703379530915364e-5, 14)
	expect(za).toBeCloseTo(0.2921789846651790546e-3, 14)
	expect(zetaa).toBeCloseTo(0.317877329033200931e-3, 14)
	expect(thetaa).toBeCloseTo(0.2650932701657497181e-3, 14)
	expect(pa).toBeCloseTo(0.6651637681381016288e-3, 14)
	expect(gam).toBeCloseTo(0.1398077115963754987e-5, 14)
	expect(phi).toBeCloseTo(0.4090864090837462602, 14)
	expect(psi).toBeCloseTo(0.6664464807480920325e-3, 14)
})

test('eraPn06', () => {
	const [epsa, rb, rp, rbp, rn, rbpn] = erfa.eraPn06(2400000.5, 53736, -0.9632552291149335877e-5, 0.4063197106621141414e-4)
	expect(epsa).toBeCloseTo(0.4090789763356509926, 12)
	expect(rb[0]).toBeCloseTo(0.9999999999999942497, 12)
	expect(rb[1]).toBeCloseTo(-0.7078368960971557145e-7, 14)
	expect(rb[2]).toBeCloseTo(0.8056213977613185606e-7, 14)
	expect(rb[3]).toBeCloseTo(0.7078368694637674333e-7, 14)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3305943742989134124e-7, 14)
	expect(rb[6]).toBeCloseTo(-0.8056214211620056792e-7, 14)
	expect(rb[7]).toBeCloseTo(-0.330594317274058695e-7, 14)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)
	expect(rp[0]).toBeCloseTo(0.9999989300536854831, 12)
	expect(rp[1]).toBeCloseTo(-0.1341646886204443795e-2, 14)
	expect(rp[2]).toBeCloseTo(-0.5829880933488627759e-3, 14)
	expect(rp[3]).toBeCloseTo(0.1341646890569782183e-2, 14)
	expect(rp[4]).toBeCloseTo(0.9999990999913319321, 12)
	expect(rp[5]).toBeCloseTo(-0.3835944216374477457e-6, 14)
	expect(rp[6]).toBeCloseTo(0.5829880833027867368e-3, 14)
	expect(rp[7]).toBeCloseTo(-0.3985701514686976112e-6, 14)
	expect(rp[8]).toBeCloseTo(0.999999830062353495, 12)
	expect(rbp[0]).toBeCloseTo(0.9999989300056797893, 12)
	expect(rbp[1]).toBeCloseTo(-0.1341717650545059598e-2, 14)
	expect(rbp[2]).toBeCloseTo(-0.5829075756493728856e-3, 14)
	expect(rbp[3]).toBeCloseTo(0.1341717674223918101e-2, 14)
	expect(rbp[4]).toBeCloseTo(0.9999990998963748448, 12)
	expect(rbp[5]).toBeCloseTo(-0.3504269280170069029e-6, 14)
	expect(rbp[6]).toBeCloseTo(0.5829075211461454599e-3, 14)
	expect(rbp[7]).toBeCloseTo(-0.4316708436255949093e-6, 14)
	expect(rbp[8]).toBeCloseTo(0.9999998301093032943, 12)
	expect(rn[0]).toBeCloseTo(0.9999999999536069682, 12)
	expect(rn[1]).toBeCloseTo(0.8837746921149881914e-5, 14)
	expect(rn[2]).toBeCloseTo(0.3831487047682968703e-5, 14)
	expect(rn[3]).toBeCloseTo(-0.883759123298369234e-5, 14)
	expect(rn[4]).toBeCloseTo(0.9999999991354692664, 12)
	expect(rn[5]).toBeCloseTo(-0.4063198798558931215e-4, 14)
	expect(rn[6]).toBeCloseTo(-0.3831846139597250235e-5, 14)
	expect(rn[7]).toBeCloseTo(0.4063195412258792914e-4, 14)
	expect(rn[8]).toBeCloseTo(0.9999999991671806293, 12)
	expect(rbpn[0]).toBeCloseTo(0.9999989440504506688, 12)
	expect(rbpn[1]).toBeCloseTo(-0.1332879913170492655e-2, 14)
	expect(rbpn[2]).toBeCloseTo(-0.5790760923225655753e-3, 14)
	expect(rbpn[3]).toBeCloseTo(0.1332856406595754748e-2, 14)
	expect(rbpn[4]).toBeCloseTo(0.9999991109069366795, 12)
	expect(rbpn[5]).toBeCloseTo(-0.4097725651142641812e-4, 14)
	expect(rbpn[6]).toBeCloseTo(0.5791301952321296716e-3, 14)
	expect(rbpn[7]).toBeCloseTo(0.4020538796195230577e-4, 14)
	expect(rbpn[8]).toBeCloseTo(0.9999998314958576778, 12)
})

test('eraPn06a', () => {
	const [dpsi, deps, epsa, rb, rp, rbp, rn, rbpn] = erfa.eraPn06a(2400000.5, 53736)
	expect(dpsi).toBeCloseTo(-0.9630912025820308797e-5, 12)
	expect(deps).toBeCloseTo(0.4063238496887249798e-4, 12)
	expect(epsa).toBeCloseTo(0.4090789763356509926, 12)
	expect(rb[0]).toBeCloseTo(0.9999999999999942497, 12)
	expect(rb[1]).toBeCloseTo(-0.7078368960971557145e-7, 14)
	expect(rb[2]).toBeCloseTo(0.8056213977613185606e-7, 14)
	expect(rb[3]).toBeCloseTo(0.7078368694637674333e-7, 14)
	expect(rb[4]).toBeCloseTo(0.9999999999999969484, 12)
	expect(rb[5]).toBeCloseTo(0.3305943742989134124e-7, 14)
	expect(rb[6]).toBeCloseTo(-0.8056214211620056792e-7, 14)
	expect(rb[7]).toBeCloseTo(-0.330594317274058695e-7, 14)
	expect(rb[8]).toBeCloseTo(0.9999999999999962084, 12)
	expect(rp[0]).toBeCloseTo(0.9999989300536854831, 12)
	expect(rp[1]).toBeCloseTo(-0.1341646886204443795e-2, 14)
	expect(rp[2]).toBeCloseTo(-0.5829880933488627759e-3, 14)
	expect(rp[3]).toBeCloseTo(0.1341646890569782183e-2, 14)
	expect(rp[4]).toBeCloseTo(0.9999990999913319321, 12)
	expect(rp[5]).toBeCloseTo(-0.3835944216374477457e-6, 14)
	expect(rp[6]).toBeCloseTo(0.5829880833027867368e-3, 14)
	expect(rp[7]).toBeCloseTo(-0.3985701514686976112e-6, 14)
	expect(rp[8]).toBeCloseTo(0.999999830062353495, 12)
	expect(rbp[0]).toBeCloseTo(0.9999989300056797893, 12)
	expect(rbp[1]).toBeCloseTo(-0.1341717650545059598e-2, 14)
	expect(rbp[2]).toBeCloseTo(-0.5829075756493728856e-3, 14)
	expect(rbp[3]).toBeCloseTo(0.1341717674223918101e-2, 14)
	expect(rbp[4]).toBeCloseTo(0.9999990998963748448, 12)
	expect(rbp[5]).toBeCloseTo(-0.3504269280170069029e-6, 14)
	expect(rbp[6]).toBeCloseTo(0.5829075211461454599e-3, 14)
	expect(rbp[7]).toBeCloseTo(-0.4316708436255949093e-6, 14)
	expect(rbp[8]).toBeCloseTo(0.9999998301093032943, 12)
	expect(rn[0]).toBeCloseTo(0.9999999999536227668, 12)
	expect(rn[1]).toBeCloseTo(0.8836241998111535233e-5, 14)
	expect(rn[2]).toBeCloseTo(0.3830834608415287707e-5, 14)
	expect(rn[3]).toBeCloseTo(-0.8836086334870740138e-5, 14)
	expect(rn[4]).toBeCloseTo(0.9999999991354657474, 12)
	expect(rn[5]).toBeCloseTo(-0.4063240188248455065e-4, 14)
	expect(rn[6]).toBeCloseTo(-0.3831193642839398128e-5, 14)
	expect(rn[7]).toBeCloseTo(0.406323680310147977e-4, 14)
	expect(rn[8]).toBeCloseTo(0.9999999991671663114, 12)
	expect(rbpn[0]).toBeCloseTo(0.9999989440480669738, 12)
	expect(rbpn[1]).toBeCloseTo(-0.1332881418091915973e-2, 14)
	expect(rbpn[2]).toBeCloseTo(-0.5790767447612042565e-3, 14)
	expect(rbpn[3]).toBeCloseTo(0.1332857911250989133e-2, 14)
	expect(rbpn[4]).toBeCloseTo(0.9999991109049141908, 12)
	expect(rbpn[5]).toBeCloseTo(-0.4097767128546784878e-4, 14)
	expect(rbpn[6]).toBeCloseTo(0.5791308482835292617e-3, 14)
	expect(rbpn[7]).toBeCloseTo(0.402058009945402031e-4, 14)
	expect(rbpn[8]).toBeCloseTo(0.9999998314954628695, 12)
})

test('eraNutm80', () => {
	const m = erfa.eraNutm80(2400000.5, 53736)

	expect(m[0]).toBeCloseTo(0.9999999999534999268, 13)
	expect(m[1]).toBeCloseTo(0.8847935789636432161e-5, 13)
	expect(m[2]).toBeCloseTo(0.3835906502164019142e-5, 13)
	expect(m[3]).toBeCloseTo(-0.8847780042583435924e-5, 13)
	expect(m[4]).toBeCloseTo(0.9999999991366569963, 13)
	expect(m[5]).toBeCloseTo(-0.4060052702727130809e-4, 13)
	expect(m[6]).toBeCloseTo(-0.3836265729708478796e-5, 13)
	expect(m[7]).toBeCloseTo(0.4060049308612638555e-4, 13)
	expect(m[8]).toBeCloseTo(0.9999999991684415129, 13)
})

test('eraNumat', () => {
	const m = erfa.eraNumat(0.40907897633565099, -0.9630909107115582393e-5, 0.4063239174001678826e-4)

	expect(m[0]).toBeCloseTo(0.9999999999536227949, 13)
	expect(m[1]).toBeCloseTo(0.8836239320236250577e-5, 13)
	expect(m[2]).toBeCloseTo(0.3830833447458251908e-5, 13)
	expect(m[3]).toBeCloseTo(-0.8836083657016688588e-5, 13)
	expect(m[4]).toBeCloseTo(0.9999999991354654959, 13)
	expect(m[5]).toBeCloseTo(-0.4063240865361857698e-4, 13)
	expect(m[6]).toBeCloseTo(-0.3831192481833385226e-5, 13)
	expect(m[7]).toBeCloseTo(0.4063237480216934159e-4, 13)
	expect(m[8]).toBeCloseTo(0.9999999991671660407, 13)
})

test('eraNum00a', () => {
	const m = erfa.eraNum00a(2400000.5, 53736)
	expect(m[0]).toBeCloseTo(0.9999999999536227949, 12)
	expect(m[1]).toBeCloseTo(0.8836238544090873336e-5, 12)
	expect(m[2]).toBeCloseTo(0.3830835237722400669e-5, 12)
	expect(m[3]).toBeCloseTo(-0.8836082880798569274e-5, 12)
	expect(m[4]).toBeCloseTo(0.9999999991354655028, 12)
	expect(m[5]).toBeCloseTo(-0.406324086536249985e-4, 12)
	expect(m[6]).toBeCloseTo(-0.3831194272065995866e-5, 12)
	expect(m[7]).toBeCloseTo(0.4063237480216291775e-4, 12)
	expect(m[8]).toBeCloseTo(0.9999999991671660338, 12)
})

test('eraNum00b', () => {
	const m = erfa.eraNum00b(2400000.5, 53736)
	expect(m[0]).toBeCloseTo(0.9999999999536069682, 12)
	expect(m[1]).toBeCloseTo(0.8837746144871248011e-5, 12)
	expect(m[2]).toBeCloseTo(0.3831488838252202945e-5, 12)
	expect(m[3]).toBeCloseTo(-0.883759045663230472e-5, 12)
	expect(m[4]).toBeCloseTo(0.9999999991354692733, 12)
	expect(m[5]).toBeCloseTo(-0.4063198798559591654e-4, 12)
	expect(m[6]).toBeCloseTo(-0.3831847930134941271e-5, 12)
	expect(m[7]).toBeCloseTo(0.406319541225816838e-4, 12)
	expect(m[8]).toBeCloseTo(0.9999999991671806225, 12)
})

test('eraNum06a', () => {
	const m = erfa.eraNum06a(2400000.5, 53736)
	expect(m[0]).toBeCloseTo(0.9999999999536227668, 12)
	expect(m[1]).toBeCloseTo(0.8836241998111535233e-5, 12)
	expect(m[2]).toBeCloseTo(0.3830834608415287707e-5, 12)
	expect(m[3]).toBeCloseTo(-0.8836086334870740138e-5, 12)
	expect(m[4]).toBeCloseTo(0.9999999991354657474, 12)
	expect(m[5]).toBeCloseTo(-0.4063240188248455065e-4, 12)
	expect(m[6]).toBeCloseTo(-0.3831193642839398128e-5, 12)
	expect(m[7]).toBeCloseTo(0.406323680310147977e-4, 12)
	expect(m[8]).toBeCloseTo(0.9999999991671663114, 12)
})

test('eraPnm80', () => {
	const m = erfa.eraPnm80(2400000.5, 50123.9999)
	expect(m[0]).toBeCloseTo(0.9999995831934611169, 12)
	expect(m[1]).toBeCloseTo(0.8373654045728124011e-3, 12)
	expect(m[2]).toBeCloseTo(0.3639121916933106191e-3, 12)
	expect(m[3]).toBeCloseTo(-0.8373804896118301316e-3, 12)
	expect(m[4]).toBeCloseTo(0.9999996485439674092, 12)
	expect(m[5]).toBeCloseTo(0.4130202510421549752e-4, 12)
	expect(m[6]).toBeCloseTo(-0.3638774789072144473e-3, 12)
	expect(m[7]).toBeCloseTo(-0.4160674085851722359e-4, 12)
	expect(m[8]).toBeCloseTo(0.9999999329310274805, 12)
})

test('eraLteceq', () => {
	const [dr, dd] = erfa.eraLteceq(2500, 1.5, 0.6)
	expect(dr).toBeCloseTo(1.275156021861921167, 14)
	expect(dd).toBeCloseTo(0.9966573543519204791, 14)
})

test('eraLteqec', () => {
	const [dl, db] = erfa.eraLteqec(-1500, 1.234, 0.987)
	expect(dl).toBeCloseTo(0.5039483649047114859, 14)
	expect(db).toBeCloseTo(0.5848534459726224882, 14)
})

test('eraLtpecl', () => {
	const v = erfa.eraLtpecl(-1500)
	expect(v[0]).toBeCloseTo(0.4768625676477096525e-3, 14)
	expect(v[1]).toBeCloseTo(-0.4052259533091875112, 14)
	expect(v[2]).toBeCloseTo(0.9142164401096448012, 14)
})

test('eraLtpequ', () => {
	const v = erfa.eraLtpequ(-2500)
	expect(v[0]).toBeCloseTo(-0.3586652560237326659, 14)
	expect(v[1]).toBeCloseTo(-0.1996978910771128475, 14)
	expect(v[2]).toBeCloseTo(0.9118552442250819624, 14)
})

test('eraLtecm', () => {
	const m = erfa.eraLtecm(-3000)
	expect(m[0]).toBeCloseTo(0.3564105644859788825, 14)
	expect(m[1]).toBeCloseTo(0.8530575738617682284, 14)
	expect(m[2]).toBeCloseTo(0.3811355207795060435, 14)
	expect(m[3]).toBeCloseTo(-0.9343283469640709942, 14)
	expect(m[4]).toBeCloseTo(0.3247830597681745976, 14)
	expect(m[5]).toBeCloseTo(0.1467872751535940865, 14)
	expect(m[6]).toBeCloseTo(0.1431636191201167793e-2, 14)
	expect(m[7]).toBeCloseTo(-0.4084222566960599342, 14)
	expect(m[8]).toBeCloseTo(0.9127919865189030899, 14)
})

test('eraLtp', () => {
	const m = erfa.eraLtp(1666.666)
	expect(m[0]).toBeCloseTo(0.9967044141159213819, 14)
	expect(m[1]).toBeCloseTo(0.0743780189319321084, 14)
	expect(m[2]).toBeCloseTo(0.03237624409345603401, 14)
	expect(m[3]).toBeCloseTo(-0.07437802731819618167, 14)
	expect(m[4]).toBeCloseTo(0.997229389445453307, 14)
	expect(m[5]).toBeCloseTo(-0.001205768842723593346, 14)
	expect(m[6]).toBeCloseTo(-0.03237622482766575399, 14)
	expect(m[7]).toBeCloseTo(-0.001206286039697609008, 14)
	expect(m[8]).toBeCloseTo(0.9994750246704010914, 14)
})

test('eraLtpb', () => {
	const m = erfa.eraLtpb(1666.666)
	expect(m[0]).toBeCloseTo(0.9967044167723271851, 14)
	expect(m[1]).toBeCloseTo(0.7437794731203340345e-1, 14)
	expect(m[2]).toBeCloseTo(0.3237632684841625547e-1, 14)
	expect(m[3]).toBeCloseTo(-0.7437795663437177152e-1, 14)
	expect(m[4]).toBeCloseTo(0.9972293947500013666, 14)
	expect(m[5]).toBeCloseTo(-0.1205741865911243235e-2, 14)
	expect(m[6]).toBeCloseTo(-0.3237630543224664992e-1, 14)
	expect(m[7]).toBeCloseTo(-0.1206316791076485295e-2, 14)
	expect(m[8]).toBeCloseTo(0.9994750220222438819, 14)
})
