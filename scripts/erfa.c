#include "erfa.h"
#include "math.h"
#include <stdio.h>

const double RAD2ASEC = 3600.0 * 180.0 * M_PI;
const double RAD2DEG = 180 / M_PI;

int main()
{
    // 2003-08-26 00:37:38.97381
    double utc1 = 2452878.0;
    double utc2 = -0.4738544697916667;
    double dut1 = -0.3495186114062241; // seconds
    double rc = 6.165024380012967;
    double dc = 0.9124110521624642;
    double pr = 1.8145635207318077e-7;
    double pd = -1.0181087303300257e-8;
    double px = 0.023; // arcsec
    double rv = 25; // km/s
    double lng = 0.1695090996673224; // 9.712156 N
    double lat = 0.9143018813111498; // 52.385639 E
    double elev = 200; // m
    double xp = 0.0000012573132091648417;
    double yp = 0.0000020158008827406455;
    double phpa = 1013.25; // 0 = no refraction
    double tc = 15.0;
    double rh = 0.5;
    double wl = 0.55;
    double aob = 0;
    double zob = 0;
    double hob = 0;
    double dob = 0;
    double rob = 0;
    double eo = 0;

    eraAtco13(rc, dc, pr, pd, px, rv, utc1, utc2, dut1, lng, lat, elev, xp, yp, phpa, tc, rh, wl,
        &aob, &zob, &hob, &dob, &rob, &eo);

    printf("%.18f %.18f %.18f %.18f %.18f %.18f\n", aob * RAD2DEG, (M_PI / 2 - zob) * RAD2DEG, hob * RAD2DEG, dob * RAD2DEG, rob * RAD2DEG, eo * RAD2DEG);
}
