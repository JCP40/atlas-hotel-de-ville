import { getPosition } from '../lib/suncalc.js';
import { dateParis } from './geo.js';

// Outil Chaleur, lot 2 : température de surface estimée (calcul pur, sans DOM ni Three.js).
// ESTIMATION PÉDAGOGIQUE. Bilan d'énergie de surface par point (maille du sol de 2 m, quelques points par toit) :
//   rayonnement solaire absorbé (1 - albédo - transmission) x (direct x part au soleil + diffus x ouverture au ciel + réfléchi par les façades)
// + infrarouge reçu (ciel : Brutsaert 1975 corrigé de la nébulosité ; façades voisines à Ta + 2 °C), pondéré par l'ouverture au ciel
// - infrarouge émis (émissivité x sigma x Ts^4) - convection h (Ts - Ta), h = 5,7 + 3,8 v (McAdams) - évapotranspiration (part du net)
// = flux vers le sol G, qui fait évoluer Ts par la méthode force-restore (Deardorff 1978) :
//   dTs/dt = 2 racine(pi) / (effusivité racine(tau)) G - 2 pi / tau (Ts - Tprofond), tau = 1 jour, Tprofond = Ta moyenne du jour + 2 °C.
// Journée simulée deux fois (mise en régime), pas de 5 min ; instantanés toutes les 30 min et maximum de la journée.
const SIGMA = 5.67e-8, RAD = Math.PI / 180, TAU = 86400;
const OMEGA = (2 * Math.PI) / TAU, C1 = (2 * Math.sqrt(Math.PI)) / Math.sqrt(TAU);
export const PAS_INSTANTANE = 0.5; // h
export const NB_INSTANTANES = 49; // 0 h à 24 h
const pauseUI = () => new Promise((r) => setTimeout(r, 0));

// Points de calcul : mailles du sol libre + échantillon des mailles de chaque toit
// G : grille des matériaux (chaleur.js) ; classes : table de materiaux.json
export function preparerPoints(G, classes, { HORS, BATI, maxParToit = 24 }) {
  const sol = [], toits = [];
  for (let k = 0; k < G.cls.length; k++) if (G.cls[k] < BATI) sol.push(k);
  G.batiments.forEach((b, ib) => {
    const c = b.cellules;
    const pas = Math.max(1, Math.floor(c.length / maxParToit));
    for (let q = 0; q < c.length; q += pas) toits.push([ib, c[q]]);
  });
  const n = sol.length + toits.length;
  const P = {
    n, nSol: sol.length, k: new Int32Array(n), bat: new Int32Array(n).fill(-1),
    x: new Float32Array(n), z: new Float32Array(n), y0: new Float32Array(n), cls: new Uint8Array(n), arbre: new Uint8Array(n),
    svf: new Float32Array(n), fv: new Float32Array(n),
  };
  const cx = (k) => G.x0 + ((k % G.n) + 0.5) * G.pas, cz = (k) => G.z0 + (Math.floor(k / G.n) + 0.5) * G.pas;
  sol.forEach((k, i) => { P.k[i] = k; P.x[i] = cx(k); P.z[i] = cz(k); P.y0[i] = 0.3; P.cls[i] = G.cls[k]; P.arbre[i] = G.arbre[k]; });
  toits.forEach(([ib, k], j) => {
    const i = sol.length + j, b = G.batiments[ib];
    P.k[i] = k; P.bat[i] = ib; P.x[i] = cx(k); P.z[i] = cz(k); P.y0[i] = (b.e.hauteur || 10) + 0.3;
    P.cls[i] = classes.findIndex((c) => c.id === b.toit);
  });
  return P;
}

// hauteur maximale de la grille (arrêt des rayons au-dessus de tout obstacle)
const hauteurMax = (g) => { if (g.hMax == null) { let m = 0; for (let i = 0; i < g.H.length; i++) if (g.H[i] > m) m = g.H[i]; g.hMax = m; } return g.hMax; };

// Ouverture au ciel (facteur de vue du ciel) : 24 directions, horizon jusqu'à 120 m dans la grille des hauteurs (Soleil)
export async function calculerSVF(P, g, hauteurEn, note = () => {}) {
  const N = 24, Hm = hauteurMax(g);
  const dirs = Array.from({ length: N }, (_, q) => [Math.sin((q / N) * 2 * Math.PI), -Math.cos((q / N) * 2 * Math.PI)]);
  for (let i = 0; i < P.n; i++) {
    let s = 0;
    const x = P.x[i], z = P.z[i], y0 = P.y0[i];
    for (const [sx, sz] of dirs) {
      let t = 0;
      for (let d = 2; d <= 120; d += 2) {
        if ((Hm - y0) / d <= t) break; // plus rien ne peut dépasser l'horizon trouvé
        const v = (hauteurEn(g, x + sx * d, z + sz * d) - y0) / d; if (v > t) t = v;
      }
      const b = Math.atan(t);
      s += Math.sin(b) ** 2;
    }
    P.svf[i] = Math.max(0.02, 1 - s / N);
    if (i % 5000 === 4999) { note(`Ouverture au ciel : ${Math.round((100 * i) / P.n)} %`); await pauseUI(); }
  }
}

// Positions du soleil toutes les 30 min du jour donné
export function positionsSoleil({ annee, mois, jour, lat, lon }) {
  return Array.from({ length: NB_INSTANTANES }, (_, s) => {
    const p = getPosition(dateParis(annee, mois, jour, s * PAS_INSTANTANE), lat, lon);
    const alt = p.altitude * RAD, az = p.azimuth * RAD;
    return { t: s * PAS_INSTANTANE, alt, sx: Math.sin(az), sz: -Math.cos(az), tanAlt: Math.tan(Math.max(alt, 0.001)), sinAlt: Math.max(Math.sin(alt), 0) };
  });
}

// Ensoleillement de chaque point à chaque instantané (marche le long du rayon dans la grille des hauteurs)
export async function calculerMasques(P, g, hauteurEn, positions, note = () => {}) {
  const M = new Uint8Array(NB_INSTANTANES * P.n);
  const Hm = hauteurMax(g);
  let fait = 0;
  const actifs = positions.filter((p) => p.alt > 0.02).length;
  for (let s = 0; s < NB_INSTANTANES; s++) {
    const p = positions[s];
    if (p.alt <= 0.02) continue;
    const base = s * P.n;
    for (let i = 0; i < P.n; i++) {
      const x = P.x[i], z = P.z[i], y0 = P.y0[i];
      let soleil = 1;
      for (let d = 1.5; d < 450; d += 1.5) {
        const rayon = y0 + d * p.tanAlt;
        if (rayon > Hm) break; // au-dessus du plus haut obstacle
        if (hauteurEn(g, x + p.sx * d, z + p.sz * d) > rayon) { soleil = 0; break; }
      }
      M[base + i] = soleil;
    }
    if (++fait % 8 === 0) { note(`Ombres : ${Math.round((100 * fait) / actifs)} %`); await pauseUI(); } // peu de pauses : chaque pause laisse passer une image
  }
  return M;
}

// Météo à l'heure décimale t (0-24) : température, humidité, vent instantanés à l'heure ronde ;
// rayonnement = moyenne de l'heure écoulée, placée à la demi-heure
export function meteoA(heures, t) {
  const H = (i) => heures[((i % 24) + 24) % 24] || heures.find(Boolean);
  const i0 = Math.floor(t), f = t - i0;
  const a = H(i0), b = H(i0 + 1);
  const tr = t + 0.5, j0 = Math.floor(tr), fr = tr - j0;
  const ra = H(j0), rb = H(j0 + 1);
  const l = (u, v, w) => u + (v - u) * w;
  return {
    ta: l(a.ta, b.ta, f), hr: l(a.hr, b.hr, f), v: l(a.v, b.v, f),
    ghi: l(ra.ghi, rb.ghi, fr), dni: l(ra.dni, rb.dni, fr), dhi: l(ra.dhi, rb.dhi, fr),
  };
}

// Simulation d'une journée (deux jours enchaînés pour la mise en régime) ; T en °C
export function simulerJournee(P, classes, heures, positions, M, { dt = 300 } = {}) {
  const n = P.n;
  const Tm = heures.filter(Boolean).reduce((a, h) => a + h.ta, 0) / heures.filter(Boolean).length;
  // nébulosité moyenne du jour (part de diffus) pour le ciel nocturne
  const jour = heures.filter((h) => h && h.ghi > 80);
  const nebMoy = jour.length ? jour.reduce((a, h) => a + Math.min(1, Math.max(0, (h.dhi / h.ghi - 0.25) / 0.6)), 0) / jour.length : 0.5;
  const props = classes.map((c) => ({
    abs: Math.max(0, 1 - c.albedo - (c.transmission || 0)), eps: c.emissivite, mu: c.effusivite, evap: c.evaporation || 0,
    sol: c.type === 'sol', eau: c.id === 'eau', vegetal: (c.evaporation || 0) > 0.2,
  }));
  const Ts = new Float32Array(n);
  for (let i = 0; i < n; i++) Ts[i] = Tm + 273.15;
  const T = new Float32Array(NB_INSTANTANES * n);
  const Tmax = new Float32Array(n).fill(-1e9), hMax = new Float32Array(n);
  const pasParJour = Math.round(TAU / dt);
  for (let jourSimule = 0; jourSimule < 2; jourSimule++) {
    for (let step = 0; step <= pasParJour; step++) {
      const t = (step * dt) / 3600; // h
      if (jourSimule === 1 && Math.abs(t / PAS_INSTANTANE - Math.round(t / PAS_INSTANTANE)) < 1e-6) {
        const s = Math.round(t / PAS_INSTANTANE);
        for (let i = 0; i < n; i++) T[s * n + i] = Ts[i] - 273.15;
      }
      if (step === pasParJour) break;
      const m = meteoA(heures, t + dt / 7200); // milieu du pas
      const TaK = m.ta + 273.15;
      const e = (m.hr / 100) * 6.105 * Math.exp((17.27 * m.ta) / (237.7 + m.ta));
      const neb = m.ghi > 80 ? Math.min(1, Math.max(0, (m.dhi / m.ghi - 0.25) / 0.6)) : nebMoy;
      const epsCiel = Math.min(1, 1.24 * Math.pow(e / TaK, 1 / 7) * (1 + 0.22 * neb * neb));
      const Lciel = epsCiel * SIGMA * TaK ** 4;
      const Lmur = 0.92 * SIGMA * (TaK + (m.ghi > 50 ? 2 : 0)) ** 4;
      // part au soleil : interpolation entre deux instantanés
      const sf = (t + dt / 7200) / PAS_INSTANTANE, s0 = Math.min(NB_INSTANTANES - 1, Math.floor(sf)), s1 = Math.min(NB_INSTANTANES - 1, s0 + 1), w = sf - Math.floor(sf);
      const p0 = positions[s0], p1 = positions[s1];
      const sinAlt = p0.sinAlt + (p1.sinAlt - p0.sinAlt) * w;
      for (let i = 0; i < n; i++) {
        const pr = props[P.cls[i]];
        const svf = P.svf[i];
        let soleil = M[s0 * n + i] * (1 - w) + M[s1 * n + i] * w;
        if (P.arbre[i] && i < P.nSol) soleil = Math.max(soleil, 0.12); // lumière filtrée par le houppier
        const K = m.dni * sinAlt * soleil + m.dhi * svf + 0.25 * m.ghi * (1 - svf) * 0.5;
        const Ld = svf * Lciel + (1 - svf) * Lmur;
        const u = Math.max(0.3, m.v * (P.bat[i] >= 0 ? 0.8 : 0.5 * P.fv[i]));
        const hc = 5.7 + 3.8 * u;
        const Td = Tm + 273.15 + (pr.vegetal || pr.eau ? 0 : 2);
        const coef = C1 / pr.mu;
        // sous-pas si le matériau a très peu d'inertie (zinc, verrière)
        const raideur = coef * (4 * pr.eps * SIGMA * Ts[i] ** 3 + hc) + OMEGA;
        const nsub = Math.max(1, Math.ceil((dt * raideur) / 0.5));
        const h = dt / nsub;
        let Tk = Ts[i];
        for (let q = 0; q < nsub; q++) {
          const Rn = pr.abs * K + pr.eps * (Ld - SIGMA * Tk ** 4);
          const LE = pr.evap * Math.max(Rn, 0);
          const G = Rn - hc * (Tk - TaK) - LE;
          Tk += h * (coef * G - OMEGA * (Tk - Td));
        }
        Ts[i] = Tk;
        if (jourSimule === 1 && Tk - 273.15 > Tmax[i]) { Tmax[i] = Tk - 273.15; hMax[i] = t + dt / 3600; }
      }
    }
  }
  return { T, Tmax, hMax, Tm };
}

// Température à l'heure t (interpolation entre instantanés)
export function temperatureA(R, n, i, t) {
  const sf = Math.min(Math.max(t, 0), 24) / PAS_INSTANTANE, s0 = Math.min(NB_INSTANTANES - 1, Math.floor(sf)), s1 = Math.min(NB_INSTANTANES - 1, s0 + 1), w = sf - s0;
  return R.T[s0 * n + i] * (1 - w) + R.T[s1 * n + i] * w;
}
