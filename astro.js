// astro.js — the astronomy math. No libraries, just spherical trig.
// Low-precision formulas (good to ~1°), which is plenty for naked-eye stargazing.

const Astro = (() => {
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const norm = (d) => ((d % 360) + 360) % 360;

  // Julian Date: days since noon, Jan 1 4713 BC. Astronomers' universal clock.
  const julian = (date) => date.getTime() / 86400000 + 2440587.5;

  // Local Sidereal Time (degrees): which RA is crossing your meridian right now.
  function lst(date, lonDeg) {
    const d = julian(date) - 2451545.0;
    return norm(280.46061837 + 360.98564736629 * d + lonDeg);
  }

  // Convert sky coordinates (RA/Dec) → where to look (altitude above horizon, azimuth from North).
  function toAltAz(raDeg, decDeg, latDeg, lstDeg) {
    const H = (lstDeg - raDeg) * D2R, dec = decDeg * D2R, lat = latDeg * D2R;
    const sinAlt = Math.sin(dec) * Math.sin(lat) + Math.cos(dec) * Math.cos(lat) * Math.cos(H);
    const alt = Math.asin(sinAlt);
    const az = Math.atan2(-Math.cos(dec) * Math.sin(H),
                          Math.sin(dec) * Math.cos(lat) - Math.cos(dec) * Math.sin(lat) * Math.cos(H));
    return { alt: alt * R2D, az: norm(az * R2D) };
  }

  const obliquity = (d) => 23.439 - 0.0000004 * d;

  function eclToEq(lamDeg, betaDeg, epsDeg) {
    const l = lamDeg * D2R, b = betaDeg * D2R, e = epsDeg * D2R;
    const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l));
    const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l));
    return { ra: norm(ra * R2D), dec: dec * R2D };
  }

  // Sun position (Astronomical Almanac low-precision formula)
  function sun(date) {
    const d = julian(date) - 2451545.0;
    const L = norm(280.460 + 0.9856474 * d);
    const g = norm(357.528 + 0.9856003 * d) * D2R;
    const lam = L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g);
    return { ...eclToEq(lam, 0, obliquity(d)), lam };
  }

  // Moon position + phase (main terms only)
  function moon(date) {
    const d = julian(date) - 2451545.0;
    const L = norm(218.316 + 13.176396 * d);
    const M = norm(134.963 + 13.064993 * d) * D2R;
    const F = norm(93.272 + 13.229350 * d) * D2R;
    const lam = L + 6.289 * Math.sin(M);
    const beta = 5.128 * Math.sin(F);
    const s = sun(date);
    const elong = norm(lam - s.lam);                         // 0 = new, 180 = full
    const illum = (1 - Math.cos(elong * D2R)) / 2;           // fraction lit
    return { ...eclToEq(lam, beta, obliquity(d)), illum, waxing: elong < 180, elong };
  }

  function moonPhaseName(m) {
    const e = m.elong;
    if (e < 10 || e > 350) return "New Moon";
    if (e < 80) return "Waxing Crescent";
    if (e < 100) return "First Quarter";
    if (e < 170) return "Waxing Gibbous";
    if (e < 190) return "Full Moon";
    if (e < 260) return "Waning Gibbous";
    if (e < 280) return "Last Quarter";
    return "Waning Crescent";
  }

  function moonEmoji(m) {
    const icons = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];
    return icons[Math.round(m.elong / 45) % 8];
  }

  return { toAltAz, lst, sun, moon, moonPhaseName, moonEmoji, norm };
})();
