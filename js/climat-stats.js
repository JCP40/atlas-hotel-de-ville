// Statistiques du climat (11/11/2026, demande de l'utilisateur : « quantifier en jours les moments canicule / chaud / tempéré / froid /
// très froid, avec pourcentages, humidité, UTCI avec rayonnement et direction du vent ») : calcul PUR (ni Three.js, ni DOM, ni fetch),
// testable sous Node. Lu par js/climat-stats-bloc.js (bloc « Statistiques du climat » du panneau Climat, js/climat.js).
//
// Entrée : heures en colonnes de js/meteo-extremes.js (heuresDepuisCSV : CSV Météo-France 44020001 2016-2025 ; heuresDepuisEPW),
// fournies par js/meteo.js heuresClimat() : T, TN, TX, FF, DD, FXI, U (HR %), RR1 (mm), N (octas), GLO (W/m²), DNI, DHI (EPW).
//
// JOURNÉE : jour civil de Paris (heure d'été comprise), valide si au moins 20 heures de T (comme data/meteo/extremes.json et
// meteo-extremes.js) ; Tmin = minimum de TN (sinon T), Tmax = maximum de TX (sinon T), Tmoy = moyenne des T horaires du jour.
// Les heures des journées incomplètes (< 20 h) ne sont comptées dans aucune catégorie (elles le sont dans les compteurs horaires).
//
// CATÉGORIES (exclusives, une par journée valide, testées dans cet ordre ; seuils réglables, SEUILS_DEFAUT) :
//   1. Canicule : journée d'un épisode de canicule, définition de meteo-extremes.js (seuils de vigilance Météo-France pour la
//      Loire-Atlantique) : fenêtre de 3 jours consécutifs valides dont la moyenne des Tmin ≥ 20 °C ET la moyenne des Tmax ≥ 34 °C ;
//      les 3 jours de chaque fenêtre sont des jours de canicule ;
//   2. Chaud : Tmax ≥ 30 °C (hors canicule) ;
//   3. Très froid : Tmoy ≤ 0 °C OU Tmin ≤ −5 °C (journée sans dégel, ou forte gelée) ;
//   4. Froid : Tmoy < 5 °C (hors très froid) ;
//   5. Tempéré : tous les autres jours.
// COMPTEURS NON EXCLUSIFS (COMPTEURS) : heures (T horaire) et journées valides (Tmin ou Tmax) sous / au-dessus de 5, 0, −5, 25, 30, 35 °C.
// VENT : rose à 12 secteurs de 30° (roseHeures de meteo-extremes.js : heures des journées de la catégorie, calme = FF < 1 m/s, % de
// toutes les heures calmes comprises, vitesse moyenne du secteur, direction moyenne du secteur dominant).
// HUMIDITÉ : HR moyenne des heures ; journée très humide si HR moyenne du jour ≥ 90 %, sèche si < 50 % (≥ 20 h d'HR) ;
// jour de pluie si cumul RR1 ≥ 1 mm (≥ 20 h de RR1 ; Météo-France seulement, pas de pluie lue dans l'EPW).
//
// UTCI AVEC RAYONNEMENT (piéton debout, site dégagé : ouverture au ciel 1, ni bâti ni arbre ; deux variantes : AU SOLEIL et À L'OMBRE =
// rayonnement direct nul sur le corps ET sur le sol voisin) : UTCI = utci(Ta, Tmrt, FF station à 10 m, HR) (js/utci.js, polynôme officiel).
// Tmrt par la méthode des facteurs d'angle de js/utci.js tmrtSimplifiee, mêmes choix que js/confort.js (VDI 3787, Thorsson et al. 2007) :
//   Sstr = αk (fp I + ½ D + ½ ρ Gsol) + εp [½ L_ciel + ½ L_sol] ; Tmrt = (Sstr / (εp σ))^¼ − 273,15 ; αk 0,7, εp 0,97, albédo du sol ρ 0,2 ;
//   fp = 0,308 cos(β (0,998 − β² / 50 000)) (facteur de projection d'une personne debout, β hauteur du soleil en degrés) ;
//   soleil : position SunCalc au milieu de l'heure écoulée (les mesures de rayonnement sont des moyennes de l'heure qui finit) ;
//   rayonnement : EPW → DNI (I) et DHI (D) du fichier ; Météo-France → global GLO mesuré, partagé en direct et diffus par la corrélation
//   d'Erbs et al. (1982) sur l'indice de clarté kt = GLO / (I0 sin β) ; GLO manquant → ciel clair de Haurwitz × (1 − 0,75 n^3,4)
//   (Kasten et Czeplak 1980, n = nébulosité / 8), heure comptée comme « estimée » ;
//   L_ciel = ε σ Ta⁴, ε = min(1, 1,24 (e / Ta)^(1/7)) (Brutsaert, ciel clair, comme Confort) × (1 + 0,22 n²) quand la nébulosité est
//   connue (mesure de l'heure, sinon la plus proche à ±3 h ; sinon ciel clair) : écart avec Confort, qui garde le ciel clair ;
//   L_sol = 0,95 σ Tsol⁴, Tsol = Ta + 0,025 (1 − ρ) Gsol (Gsol = global au soleil, diffus à l'ombre ; comme Confort).
// Journées UTCI (≥ 20 heures d'UTCI) : classe de l'UTCI maximal et de l'UTCI minimal de la journée ; « jour de stress de chaleur fort »
// = au moins une heure à UTCI ≥ 32 °C (classes fort, très fort, extrême) ; « jour de stress de froid modéré ou plus » = au moins une
// heure < 0 °C ; « fort » = au moins une heure < −13 °C. Estimation pédagogique : UTCI à ±3 à 5 °C près.

import { roseHeures, CANICULE, HEURES_MIN, NOMS12 } from './meteo-extremes.js';
import { utci, CLASSES_UTCI, tmrtSimplifiee, SIGMA } from './utci.js';

export const VERSION = '2026-11-11';
export const SEUILS_DEFAUT = Object.freeze({
  canTmin: CANICULE.ibmn, canTmax: CANICULE.ibmx, // moyennes sur 3 jours (vigilance canicule Loire-Atlantique)
  chaud: 30, // Tmax ≥
  tresFroidTmoy: 0, tresFroidTmin: -5, // Tmoy ≤ ou Tmin ≤
  froid: 5, // Tmoy <
});
export const LIBELLES_SEUILS = {
  canTmin: 'Canicule : Tmin moy. 3 j ≥', canTmax: 'Canicule : Tmax moy. 3 j ≥',
  chaud: 'Chaud : Tmax ≥', tresFroidTmoy: 'Très froid : Tmoy ≤', tresFroidTmin: '… ou Tmin ≤', froid: 'Froid : Tmoy <',
};
export function seuilsValides(s = {}) {
  const o = { ...SEUILS_DEFAUT };
  for (const k of Object.keys(o)) { const v = Number(s?.[k]); if (Number.isFinite(v) && v > -60 && v < 60) o[k] = v; }
  return o;
}
// ordre d'affichage (du plus chaud au plus froid) ; ordre de test : canicule, chaud, très froid, froid, tempéré
export const CATEGORIES = [
  { id: 'canicule', libelle: 'Canicule', couleur: '#b2182b' },
  { id: 'chaud', libelle: 'Chaud', couleur: '#ef8a62' },
  { id: 'tempere', libelle: 'Tempéré', couleur: '#7fae6a' },
  { id: 'froid', libelle: 'Froid', couleur: '#67a9cf' },
  { id: 'tres-froid', libelle: 'Très froid', couleur: '#2166ac' },
];
export function definitions(s = SEUILS_DEFAUT) {
  const v = (x) => String(x).replace('.', ',').replace('-', '−');
  return {
    canicule: `journée d'un épisode de canicule : 3 jours consécutifs dont la moyenne des Tmin ≥ ${v(s.canTmin)} °C et la moyenne des Tmax ≥ ${v(s.canTmax)} °C (seuils de vigilance Météo-France, Loire-Atlantique)`,
    chaud: `Tmax ≥ ${v(s.chaud)} °C, hors canicule`,
    'tres-froid': `Tmoy ≤ ${v(s.tresFroidTmoy)} °C ou Tmin ≤ ${v(s.tresFroidTmin)} °C`,
    froid: `Tmoy < ${v(s.froid)} °C, hors très froid`,
    tempere: 'tous les autres jours',
  };
}
export const COMPTEURS = [
  { id: 'lt5', libelle: 'T < 5 °C', h: (t) => t < 5, j: (d) => d.tmin < 5 },
  { id: 'le0', libelle: 'T ≤ 0 °C', h: (t) => t <= 0, j: (d) => d.tmin <= 0 },
  { id: 'lem5', libelle: 'T ≤ −5 °C', h: (t) => t <= -5, j: (d) => d.tmin <= -5 },
  { id: 'ge25', libelle: 'T ≥ 25 °C', h: (t) => t >= 25, j: (d) => d.tmax >= 25 },
  { id: 'ge30', libelle: 'T ≥ 30 °C', h: (t) => t >= 30, j: (d) => d.tmax >= 30 },
  { id: 'ge35', libelle: 'T ≥ 35 °C', h: (t) => t >= 35, j: (d) => d.tmax >= 35 },
];
export const HUMIDE = 90, SEC = 50, PLUIE = 1;
export const UTCI_CHAUD_FORT = 32, UTCI_FROID_MODERE = 0, UTCI_FROID_FORT = -13;
export const PIETON = { ak: 0.7, ep: 0.97, albedoSol: 0.2 };

const J = 86400000, RAD = Math.PI / 180;
const ok = Number.isFinite;
const r1 = (v) => (v == null || !ok(v) ? null : Math.round(v * 10) / 10);
const isoJour = (k) => new Date(k * J).toISOString().slice(0, 10);
const indiceClasse = (u) => { const k = CLASSES_UTCI.findIndex((c) => u < c.max); return k < 0 ? CLASSES_UTCI.length - 1 : k; };

// ------------------------------------------------------------------ rayonnement
// rayonnement extraterrestre normal (W/m²) au jour de l'année
const I0 = (doy) => 1361 * (1 + 0.033 * Math.cos((2 * Math.PI * doy) / 365));
// part diffuse d'Erbs, Klein et Duffie (1982)
export function partDiffuseErbs(kt) {
  if (kt <= 0.22) return 1 - 0.09 * kt;
  if (kt <= 0.8) return 0.9511 - 0.1604 * kt + 4.388 * kt ** 2 - 16.638 * kt ** 3 + 12.336 * kt ** 4;
  return 0.165;
}
// global horizontal → { dni, dhi } (W/m²) ; sinB = sinus de la hauteur du soleil
export function decomposer(G, sinB, doy) {
  if (!(G > 0)) return { dni: 0, dhi: 0, kt: 0 };
  if (sinB < 0.05) return { dni: 0, dhi: G, kt: null }; // soleil sous 3° : tout en diffus
  const kt = Math.min(1, G / (I0(doy) * sinB));
  const dhi = Math.min(G, partDiffuseErbs(kt) * G);
  return { dni: Math.min(1100, (G - dhi) / sinB), dhi, kt };
}
// ciel clair de Haurwitz (1945) atténué par la nébulosité (Kasten et Czeplak 1980)
export const globalEstime = (sinB, n) => (sinB > 0 ? 1098 * sinB * Math.exp(-0.057 / sinB) * (1 - 0.75 * (n ?? 0.5) ** 3.4) : 0);

// Tmrt et UTCI d'une heure, au soleil et à l'ombre (piéton debout, site dégagé). Entrées : Ta °C, HR %, v10 m/s, sinB (≤ 0 : nuit),
// beta (°), dni, dhi, G (global horizontal, W/m²), n (nébulosité 0-1 ou null). → { tmrtSoleil, tmrtOmbre, uSoleil, uOmbre }
export function heureUTCI({ Ta, HR, v10, beta, dni, dhi, G, n = null }) {
  const TaK = Ta + 273.15;
  const e = (HR / 100) * 6.105 * Math.exp((17.27 * Ta) / (237.7 + Ta));
  const eps = Math.min(1, 1.24 * Math.pow(e / TaK, 1 / 7) * (n == null ? 1 : 1 + 0.22 * n * n));
  const Lciel = eps * SIGMA * TaK ** 4;
  const b = Math.max(beta, 0);
  const fp = 0.308 * Math.cos(RAD * b * (0.998 - (b * b) / 50000));
  const { ak, ep, albedoSol: rho } = PIETON;
  const Lsol = (g) => 0.95 * SIGMA * (TaK + 0.025 * (1 - rho) * g) ** 4;
  const soleilLeve = beta > 0 && dni > 0;
  const tmrtSoleil = tmrtSimplifiee({ I: soleilLeve ? dni : 0, D: dhi, fp, svf: 1, albedoSol: rho, Gsol: G, Lciel, Lmurs: Lciel, Lsol: Lsol(G), ak, ep });
  const tmrtOmbre = tmrtSimplifiee({ I: 0, D: dhi, fp, svf: 1, albedoSol: rho, Gsol: dhi, Lciel, Lmurs: Lciel, Lsol: Lsol(dhi), ak, ep });
  return { tmrtSoleil, tmrtOmbre, uSoleil: utci(Ta, tmrtSoleil, v10, HR), uOmbre: utci(Ta, tmrtOmbre, v10, HR) };
}

// ------------------------------------------------------------------ analyse
// H : heures (meteo-extremes.js) ; annee : null = toute la période ; positionSoleil(date, lat, lon) → { altitude (DEGRÉS) } (getPosition de lib/suncalc.js) ;
// typique : année type (EPW) ; utciActif : false pour sauter l'UTCI.
export function statistiquesClimat(H, { annee = null, seuils = SEUILS_DEFAUT, lat = 47.218, lon = -1.554, positionSoleil = null, typique = false, utciActif = true } = {}) {
  const s = seuilsValides(seuils);
  annee = annee == null || annee === '' ? null : Number(annee); // js/meteo.js garde l'année choisie en texte
  const garder = (i) => annee == null || H.annee[i] === annee;
  const col = new Set(H.colonnes ?? []);
  const aPluie = col.has('RR1'), aHR = col.has('U'), aRay = col.has('GLO');
  // 1. journées
  const D = new Map();
  let heuresT = 0;
  const cpt = Object.fromEntries(COMPTEURS.map((c) => [c.id, { heures: 0, jours: 0, parAnnee: {} }]));
  for (let i = 0; i < H.n; i++) {
    if (!garder(i)) continue;
    const t = H.T[i];
    if (!ok(t)) continue;
    heuresT++;
    for (const c of COMPTEURS) if (c.h(t)) cpt[c.id].heures++;
    let d = D.get(H.jour[i]);
    if (!d) { d = { k: H.jour[i], annee: H.annee[i], mois: H.mois[i], n: 0, sT: 0, tmin: Infinity, tmax: -Infinity, nU: 0, sU: 0, nRR: 0, sRR: 0, idx: [] }; D.set(H.jour[i], d); }
    d.n++; d.sT += t; d.idx.push(i);
    const tn = ok(H.TN[i]) ? H.TN[i] : t, tx = ok(H.TX[i]) ? H.TX[i] : t;
    if (tn < d.tmin) d.tmin = tn;
    if (tx > d.tmax) d.tmax = tx;
    if (ok(H.U[i])) { d.nU++; d.sU += H.U[i]; }
    if (ok(H.RR1[i])) { d.nRR++; d.sRR += H.RR1[i]; }
  }
  // toutes les journées (valides ou non) gardées pour l'export Excel (js/climat-export.js, feuille « Jours ») : S.journees, non énumérable
  const toutes = [...D.values()];
  for (const [k, d] of D) { d.tmoy = d.sT / d.n; d.valide = d.n >= 20; if (!d.valide) D.delete(k); }
  // canicule : fenêtres de 3 jours consécutifs valides
  const can = new Set();
  for (const k of D.keys()) {
    const w = [D.get(k), D.get(k + 1), D.get(k + 2)];
    if (w.some((x) => !x)) continue;
    if ((w[0].tmin + w[1].tmin + w[2].tmin) / 3 >= s.canTmin - 1e-9 && (w[0].tmax + w[1].tmax + w[2].tmax) / 3 >= s.canTmax - 1e-9) w.forEach((x) => can.add(x.k));
  }
  const categorie = (d) => (can.has(d.k) ? 'canicule' : d.tmax >= s.chaud ? 'chaud' : d.tmoy <= s.tresFroidTmoy || d.tmin <= s.tresFroidTmin ? 'tres-froid' : d.tmoy < s.froid ? 'froid' : 'tempere');
  const anneesSet = new Set();
  const joursValidesParAnnee = {};
  const C = Object.fromEntries(CATEGORIES.map((c) => [c.id, { id: c.id, jours: 0, heures: 0, parAnnee: {}, idx: [], sU: 0, nU: 0, humides: 0, secs: 0, pluie: 0, joursRR: 0, utciMaxSoleil: [], utciMaxOmbre: [] }]));
  const parAnnee = {}; // annee → { jours, sU, nU, humides, secs, pluie, joursRR, cumulRR }
  for (const d of D.values()) {
    const c = C[(d.cat = categorie(d))];
    anneesSet.add(d.annee);
    joursValidesParAnnee[d.annee] = (joursValidesParAnnee[d.annee] || 0) + 1;
    c.jours++; c.heures += d.n; c.parAnnee[d.annee] = (c.parAnnee[d.annee] || 0) + 1;
    for (const i of d.idx) c.idx.push(i);
    c.sU += d.sU; c.nU += d.nU;
    const A = (parAnnee[d.annee] ??= { jours: 0, sU: 0, nU: 0, humides: 0, secs: 0, pluie: 0, joursRR: 0, cumulRR: 0 });
    A.jours++; A.sU += d.sU; A.nU += d.nU;
    if (d.nU >= 20) { const hm = d.sU / d.nU; if (hm >= HUMIDE) { c.humides++; A.humides++; } if (hm < SEC) { c.secs++; A.secs++; } }
    if (d.nRR >= 20) { c.joursRR++; A.joursRR++; A.cumulRR += d.sRR; if (d.sRR >= PLUIE) { c.pluie++; A.pluie++; } }
    for (const x of COMPTEURS) if (x.j(d)) { cpt[x.id].jours++; cpt[x.id].parAnnee[d.annee] = (cpt[x.id].parAnnee[d.annee] || 0) + 1; }
  }
  const annees = [...anneesSet].sort((a, b) => a - b);
  const nAnnees = typique ? 1 : Math.max(1, annees.length);
  const joursValides = D.size;
  // 2. vent par catégorie (+ ensemble)
  const tous = [];
  for (const d of D.values()) for (const i of d.idx) tous.push(i);
  const vent = {};
  for (const c of CATEGORIES) vent[c.id] = roseHeures(H, C[c.id].idx);
  vent.ensemble = roseHeures(H, tous);
  const rafaleMax = (idx) => { let m = -Infinity; for (const i of idx) if (ok(H.FXI[i]) && H.FXI[i] > m) m = H.FXI[i]; return m > -Infinity ? r1(m) : null; };
  for (const c of CATEGORIES) vent[c.id].fxiMax = H.rafales ? rafaleMax(C[c.id].idx) : null;
  vent.ensemble.fxiMax = H.rafales ? rafaleMax(tous) : null;
  // 3. UTCI
  const U = utciActif && positionSoleil ? analyserUTCI(H, D, C, { lat, lon, positionSoleil, garder }) : null;
  // 4. sorties
  const categories = CATEGORIES.map((c0) => {
    const c = C[c0.id];
    return {
      id: c.id, libelle: c0.libelle, couleur: c0.couleur, jours: c.jours, pct: joursValides ? (100 * c.jours) / joursValides : 0, heures: c.heures,
      parAn: c.jours / nAnnees, parAnnee: c.parAnnee,
      hrMoy: c.nU ? c.sU / c.nU : null, humides: c.humides, secs: c.secs, pluie: aPluie ? c.pluie : null, joursRR: c.joursRR,
      utciMaxSoleil: c.utciMaxSoleil.length ? c.utciMaxSoleil.reduce((a, b) => a + b, 0) / c.utciMaxSoleil.length : null,
      utciMaxOmbre: c.utciMaxOmbre.length ? c.utciMaxOmbre.reduce((a, b) => a + b, 0) / c.utciMaxOmbre.length : null,
    };
  });
  const resultat = {
    version: VERSION, seuils: s, definitions: definitions(s), annee, typique, source: H.source, rafales: !!H.rafales,
    annees, nAnnees, joursValides, joursValidesParAnnee, heuresT, aPluie, aHR, aRay,
    categories,
    compteurs: COMPTEURS.map((c) => ({ id: c.id, libelle: c.libelle, heures: cpt[c.id].heures, pctHeures: heuresT ? (100 * cpt[c.id].heures) / heuresT : 0, heuresParAn: cpt[c.id].heures / nAnnees,
      jours: cpt[c.id].jours, pctJours: joursValides ? (100 * cpt[c.id].jours) / joursValides : 0, joursParAn: cpt[c.id].jours / nAnnees, parAnnee: cpt[c.id].parAnnee })),
    vent,
    humidite: { parAnnee: Object.fromEntries(Object.entries(parAnnee).map(([a, A]) => [a, { hrMoy: A.nU ? A.sU / A.nU : null, humides: A.humides, secs: A.secs, pluie: aPluie ? A.pluie : null, cumulRR: aPluie ? A.cumulRR : null, joursRR: A.joursRR }])) },
    utci: U,
  };
  // journées (ordre chronologique) : { k (jour civil de Paris, jours depuis 1970), annee, mois, n (heures de T), tmin, tmax, tmoy, sU/nU (HR),
  // sRR/nRR (pluie), idx (indices des heures), valide, cat (journées valides), utci { mxS, mnS, mxO, mnO } (≥ 20 h d'UTCI) } : export seulement
  Object.defineProperty(resultat, 'journees', { value: toutes.sort((a, b) => a.k - b.k), enumerable: false });
  return resultat;
}

function analyserUTCI(H, D, C, { lat, lon, positionSoleil, garder }) {
  const nk = CLASSES_UTCI.length;
  const z = () => new Array(nk).fill(0);
  const R = {
    heures: { soleil: z(), ombre: z() }, heuresJour: { soleil: z(), ombre: z() }, joursMax: { soleil: z(), ombre: z() }, joursMin: { soleil: z(), ombre: z() },
    n: 0, nJour: 0, estimees: 0, nebConnue: 0, jours: 0,
    chaudFort: { heures: { soleil: 0, ombre: 0 }, jours: { soleil: 0, ombre: 0 } },
    froidModere: { heures: { soleil: 0, ombre: 0 }, jours: { soleil: 0, ombre: 0 } },
    froidFort: { heures: { soleil: 0, ombre: 0 }, jours: { soleil: 0, ombre: 0 } },
    controle: null, // heure d'été la plus ensoleillée : Ta, Tmrt au soleil et à l'ombre
  };
  const uS = new Float64Array(H.n).fill(NaN), uO = new Float64Array(H.n).fill(NaN), deJour = new Uint8Array(H.n);
  // UTCI horaires gardés pour les tranches de température (statistiquesTranches) ; non énumérable : hors JSON et CSV
  Object.defineProperty(R, 'horaire', { value: { uS, uO, deJour }, enumerable: false });
  const neb = (i) => {
    if (ok(H.N[i])) return Math.min(8, H.N[i]) / 8;
    for (let d = 1; d <= 3; d++) for (const j of [i - d, i + d]) if (j >= 0 && j < H.n && Math.abs(H.ms[j] - H.ms[i]) <= d * 3600e3 + 1 && ok(H.N[j])) return Math.min(8, H.N[j]) / 8;
    return null;
  };
  const epw = H.source === 'epw';
  for (let i = 0; i < H.n; i++) {
    if (!garder(i)) continue;
    const Ta = H.T[i], HR = H.U[i], v = H.FF[i];
    if (!ok(Ta) || !ok(HR) || !ok(v)) continue;
    const date = new Date(H.ms[i] - 1800e3);
    const beta = positionSoleil(date, lat, lon).altitude; // degrés (lib/suncalc.js de l'atlas, réfraction comprise)
    const sinB = Math.sin(beta * RAD);
    const n = neb(i);
    if (n != null) R.nebConnue++;
    const doy = Math.floor((H.ms[i] - Date.UTC(new Date(H.ms[i]).getUTCFullYear(), 0, 0)) / J);
    let G = H.GLO[i], dni, dhi;
    if (sinB <= 0) { G = 0; dni = 0; dhi = 0; } else {
      if (!ok(G)) { G = globalEstime(sinB, n); R.estimees++; }
      if (epw && ok(H.DNI[i]) && ok(H.DHI[i])) { dni = H.DNI[i]; dhi = H.DHI[i]; } else ({ dni, dhi } = decomposer(G, sinB, doy));
    }
    const x = heureUTCI({ Ta, HR, v10: v, beta, dni, dhi, G, n });
    uS[i] = x.uSoleil; uO[i] = x.uOmbre;
    R.n++;
    const ks = indiceClasse(x.uSoleil), ko = indiceClasse(x.uOmbre);
    R.heures.soleil[ks]++; R.heures.ombre[ko]++;
    if (beta > 0) { deJour[i] = 1; R.nJour++; R.heuresJour.soleil[ks]++; R.heuresJour.ombre[ko]++; }
    if (x.uSoleil >= UTCI_CHAUD_FORT) R.chaudFort.heures.soleil++;
    if (x.uOmbre >= UTCI_CHAUD_FORT) R.chaudFort.heures.ombre++;
    if (x.uSoleil < UTCI_FROID_MODERE) R.froidModere.heures.soleil++;
    if (x.uOmbre < UTCI_FROID_MODERE) R.froidModere.heures.ombre++;
    if (x.uSoleil < UTCI_FROID_FORT) R.froidFort.heures.soleil++;
    if (x.uOmbre < UTCI_FROID_FORT) R.froidFort.heures.ombre++;
    if ([5, 6, 7].includes(H.mois[i]) && (!R.controle || G > R.controle.G)) R.controle = { date: new Date(H.loc[i]).toISOString().slice(0, 13).replace('T', ' ') + ' h', Ta, HR, v, G, dni, dhi, beta, tmrtSoleil: x.tmrtSoleil, tmrtOmbre: x.tmrtOmbre, uSoleil: x.uSoleil, uOmbre: x.uOmbre };
  }
  for (const d of D.values()) {
    let mxS = -Infinity, mnS = Infinity, mxO = -Infinity, mnO = Infinity, m = 0;
    for (const i of d.idx) if (ok(uS[i])) { m++; mxS = Math.max(mxS, uS[i]); mnS = Math.min(mnS, uS[i]); mxO = Math.max(mxO, uO[i]); mnO = Math.min(mnO, uO[i]); }
    if (m < 20) continue;
    d.utci = { mxS, mnS, mxO, mnO }; // valeurs du jour, pour l'export (feuille « Jours »)
    R.jours++;
    R.joursMax.soleil[indiceClasse(mxS)]++; R.joursMax.ombre[indiceClasse(mxO)]++;
    R.joursMin.soleil[indiceClasse(mnS)]++; R.joursMin.ombre[indiceClasse(mnO)]++;
    if (mxS >= UTCI_CHAUD_FORT) R.chaudFort.jours.soleil++;
    if (mxO >= UTCI_CHAUD_FORT) R.chaudFort.jours.ombre++;
    if (mnS < UTCI_FROID_MODERE) R.froidModere.jours.soleil++;
    if (mnO < UTCI_FROID_MODERE) R.froidModere.jours.ombre++;
    if (mnS < UTCI_FROID_FORT) R.froidFort.jours.soleil++;
    if (mnO < UTCI_FROID_FORT) R.froidFort.jours.ombre++;
    C[d.cat].utciMaxSoleil.push(mxS); C[d.cat].utciMaxOmbre.push(mxO);
  }
  R.classes = CLASSES_UTCI.map((c, k) => ({ k, libelle: c.libelle, min: k ? CLASSES_UTCI[k - 1].max : -Infinity, max: c.max, couleur: c.couleur }));
  return R;
}

// ------------------------------------------------------------------ textes
const nb = (v, d = 0) => (v == null || !ok(v) ? '–' : Number(v).toFixed(d).replace('.', ','));
const POINTS = { N: 'nord', NNE: 'nord-nord-est', ENE: 'est-nord-est', E: 'est', ESE: 'est-sud-est', SSE: 'sud-sud-est', S: 'sud', SSO: 'sud-sud-ouest', OSO: 'ouest-sud-ouest', O: 'ouest', ONO: 'ouest-nord-ouest', NNO: 'nord-nord-ouest' };
export const duSecteur = (abr) => { const n = POINTS[abr] ?? abr; return /^[eo]/.test(n) ? `de l'${n}` : `du ${n}`; };
export function texteVentCategorie(r) {
  if (!r || !r.N) return 'pas de mesure de vent';
  if (!r.dominant) return `vent calme (${nb(r.calmes)} % de calmes)`;
  return `le vent vient surtout ${duSecteur(r.dominant.nom)} (${r.dominant.nom}, ${r.dominant.degMoyen ?? r.dominant.dir}°, ${nb(r.dominant.f)} % des heures), ${nb(r.vm, 1)} m/s en moyenne${r.peuRepresentatif ? ` — échantillon faible (${r.N} h)` : ''}`;
}
export function texteResume(S, periode) {
  const parAn = S.typique ? 'dans l\'année type' : S.nAnnees > 1 ? 'par an' : 'dans l\'année';
  const cat = (id) => S.categories.find((c) => c.id === id);
  const QUALIF = { canicule: ['de canicule', 'de canicule'], chaud: ['chaud', 'chauds'], tempere: ['tempéré', 'tempérés'], froid: ['froid', 'froids'], 'tres-froid': ['très froid', 'très froids'] };
  const f = (id) => { const c = cat(id), pl = c.parAn >= 2; return `${nb(c.parAn, c.parAn < 10 && !S.typique && S.nAnnees > 1 ? 1 : 0)} jour${pl ? 's' : ''} ${QUALIF[id][pl ? 1 : 0]} (${nb(c.pct, 1)} %)`; };
  const p = [`Sur ${/^année/.test(periode) ? 'l\'' : ''}${periode}${!S.typique && S.nAnnees > 1 ? ', en moyenne par an' : ''} : ${f('canicule')}, ${f('chaud')}, ${f('tempere')}, ${f('froid')}, ${f('tres-froid')}.`];
  const lt5 = S.compteurs.find((c) => c.id === 'lt5');
  p.push(`Température sous 5 °C : ${nb(lt5.heuresParAn)} h ${parAn} (${nb(lt5.pctHeures, 1)} % des heures).`);
  const chaud = S.vent.canicule.N >= 1 ? 'canicule' : 'chaud';
  p.push(`Au plus chaud (${cat(chaud).libelle.toLowerCase()}), ${texteVentCategorie(S.vent[chaud])} ; par grand froid (très froid), ${texteVentCategorie(S.vent['tres-froid'])}.`);
  if (S.utci) {
    const u = S.utci, k = S.typique ? 1 : S.nAnnees;
    const d = k > 1 ? 1 : 0;
    p.push(`UTCI d'un piéton en site dégagé : ${nb(u.chaudFort.jours.soleil / k, d)} jour(s) ${parAn} avec au moins une heure de stress de chaleur fort ou plus au soleil, ${nb(u.chaudFort.jours.ombre / k, d)} à l'ombre ; stress de froid modéré ou plus : ${nb(u.froidModere.jours.ombre / k)} jours à l'ombre.`);
  }
  return p;
}

// ------------------------------------------------------------------ CSV (un fichier long, sections séparées par une ligne vide)
const BOM = String.fromCharCode(0xfeff);
const cel = (v) => (v == null || (typeof v === 'number' && !ok(v)) ? '' : typeof v === 'number' ? String(Math.round(v * 100) / 100).replace('.', ',') : /[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
export function csvStatistiques(S, entete = '') {
  const L = [];
  const lg = (...v) => L.push(v.map(cel).join(';'));
  if (entete) lg(entete);
  lg(`Statistiques du climat (atlas HdV, ${VERSION}) ; journée = jour civil Europe/Paris, au moins 20 h de mesures ; seuils : ${Object.entries(S.seuils).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  L.push('');
  lg('# Catégories de jours'); lg('categorie', 'definition', 'jours', 'pct_jours', 'heures', 'jours_par_an', 'hr_moy_pct', 'jours_tres_humides', 'jours_secs', 'jours_pluie', 'utci_max_moy_soleil', 'utci_max_moy_ombre');
  for (const c of S.categories) lg(c.libelle, S.definitions[c.id], c.jours, c.pct, c.heures, c.parAn, c.hrMoy, c.humides, c.secs, c.pluie, c.utciMaxSoleil, c.utciMaxOmbre);
  lg('total', '', S.joursValides, 100, S.categories.reduce((a, c) => a + c.heures, 0), S.joursValides / (S.typique ? 1 : S.nAnnees));
  L.push('');
  if (!S.typique && S.annees.length) {
    lg('# Jours par année'); lg('annee', ...S.categories.map((c) => c.libelle), 'jours_valides', 'hr_moy_pct', 'jours_tres_humides', 'jours_secs', 'jours_pluie', 'cumul_pluie_mm');
    for (const a of S.annees) { const h = S.humidite.parAnnee[a] || {}; lg(a, ...S.categories.map((c) => c.parAnnee[a] || 0), S.joursValidesParAnnee[a], h.hrMoy, h.humides, h.secs, h.pluie, h.cumulRR); }
    lg('moyenne annuelle', ...S.categories.map((c) => c.parAn));
    L.push('');
  }
  lg('# Compteurs non exclusifs'); lg('seuil', 'heures', 'pct_heures', 'heures_par_an', 'jours', 'pct_jours', 'jours_par_an');
  for (const c of S.compteurs) lg(c.libelle, c.heures, c.pctHeures, c.heuresParAn, c.jours, c.pctJours, c.joursParAn);
  L.push('');
  lg('# Vent par catégorie (12 secteurs de 30°, direction d\'où vient le vent ; calme < 1 m/s)');
  lg('categorie', 'secteur', 'direction_deg', 'heures', 'pct_heures', 'vitesse_moy_ms', 'vitesse_max_ms');
  for (const id of [...CATEGORIES.map((c) => c.id), 'ensemble']) {
    const r = S.vent[id], lib = CATEGORIES.find((c) => c.id === id)?.libelle ?? 'Ensemble';
    for (const x of r.secteurs) lg(lib, NOMS12[x.k], x.dir, x.n, x.f, x.vm, x.vmax);
    lg(lib, 'calme', '', Math.round(((r.calmes ?? 0) * r.N) / 100), r.calmes, '', '');
    lg(lib, 'total', '', r.N, 100, r.vm, r.vmax);
    lg(lib, 'dominant', r.dominant?.degMoyen ?? '', r.dominant?.nom ?? '', r.dominant?.f ?? '', r.dominant?.vm ?? '', r.fxiMax != null ? `rafale max ${r.fxiMax}` : '');
  }
  L.push('');
  if (S.utci) {
    const u = S.utci, k = S.typique ? 1 : S.nAnnees;
    lg('# UTCI, piéton debout en site dégagé (heures et jours par an)');
    lg('classe', 'utci_min', 'utci_max', 'heures_soleil', 'heures_ombre', 'heures_jour_soleil', 'heures_jour_ombre', 'jours_max_soleil', 'jours_max_ombre', 'jours_min_soleil', 'jours_min_ombre');
    for (const c of u.classes) lg(c.libelle, ok(c.min) ? c.min : '', ok(c.max) ? c.max : '', u.heures.soleil[c.k] / k, u.heures.ombre[c.k] / k, u.heuresJour.soleil[c.k] / k, u.heuresJour.ombre[c.k] / k, u.joursMax.soleil[c.k] / k, u.joursMax.ombre[c.k] / k, u.joursMin.soleil[c.k] / k, u.joursMin.ombre[c.k] / k);
    lg('stress de chaleur fort ou plus (UTCI >= 32)', '', '', u.chaudFort.heures.soleil / k, u.chaudFort.heures.ombre / k, '', '', u.chaudFort.jours.soleil / k, u.chaudFort.jours.ombre / k);
    lg('stress de froid modéré ou plus (UTCI < 0)', '', '', u.froidModere.heures.soleil / k, u.froidModere.heures.ombre / k, '', '', '', '', u.froidModere.jours.soleil / k, u.froidModere.jours.ombre / k);
  }
  return BOM + L.join('\r\n') + '\r\n';
}

// ------------------------------------------------------------------ tranches de température (11/11/2026)
// Demande de l'utilisateur : « plus de détail sur les plages tempérées, par exemple de 0 à 5, de 5 à 15, de 15 à 25, de 25 à 30 ».
// Tranches CONTIGUËS définies par des bornes croissantes b0 < b1 < … : « < b0 », « b0 à b1 », …, « ≥ bn » ; borne inférieure incluse,
// supérieure exclue (15 °C tombe dans « 15 à 25 »). Deux mesures :
//   HEURES : température horaire T (toutes les heures mesurées de la période, comme les compteurs) ;
//   JOURS  : journées valides (≥ 20 h, jour civil de Paris) classées par UNE grandeur du jour (Tmoy par défaut, ou Tmax, Tmin : mêmes
//            définitions que les catégories) : un jour compte dans une seule tranche ; « jours touchés » = journées valides dont au moins
//            une heure (T horaire) est dans la tranche (non exclusif : la somme dépasse le nombre de jours).
// Vent, humidité et UTCI par tranche : heures dont T est dans la tranche (rose à 12 secteurs de meteo-extremes.js roseHeures) ;
// UTCI : heures de jour (soleil levé) déjà calculées par statistiquesClimat (S.utci.horaire), au soleil et à l'ombre.
export const DECOUPAGES = {
  fin: { libelle: 'Fin (5 °C)', bornes: [-5, 0, 5, 10, 15, 20, 25, 30, 35] },
  standard: { libelle: 'Standard (0-5-15-25-30)', bornes: [0, 5, 15, 25, 30] },
};
export const DECOUPAGE_DEFAUT = 'standard';
export const GRANDEURS = { tmoy: 'Tmoy (moyenne du jour)', tmax: 'Tmax (maximum du jour)', tmin: 'Tmin (minimum du jour)' };
export const BORNES_MIN = 2, BORNES_MAX = 20;
const virg = (x) => String(x).replace('.', ',').replace('-', '−');
// texte saisi → { bornes } ou { erreur } ; séparateur « , » (ou « ; », la virgule est alors décimale) ou espaces
export function lireBornes(texte) {
  const s = String(texte ?? '').trim().replace(/[−–]/g, '-');
  if (!s) return { erreur: 'saisir des bornes, par exemple « 0, 5, 15, 25, 30 »' };
  const morceaux = (s.includes(';') ? s.split(';').map((x) => x.replace(',', '.')) : s.split(/[,\s]+/)).map((x) => x.trim()).filter(Boolean);
  const v = morceaux.map(Number);
  const k = v.findIndex((x) => !Number.isFinite(x));
  if (k >= 0) return { erreur: `« ${morceaux[k]} » n'est pas un nombre` };
  if (v.length < BORNES_MIN || v.length > BORNES_MAX) return { erreur: `il faut de ${BORNES_MIN} à ${BORNES_MAX} bornes (${v.length} saisies)` };
  if (v.some((x) => x < -50 || x > 60)) return { erreur: 'bornes entre −50 et 60 °C' };
  for (let i = 1; i < v.length; i++) if (!(v[i] > v[i - 1])) return { erreur: `bornes strictement croissantes (${virg(v[i - 1])} puis ${virg(v[i])})` };
  return { bornes: v };
}
// palette bleu → rouge (RdYlBu inversée, sans blanc central) selon la température du milieu de la tranche
const PALETTE_T = [[-10, [49, 54, 149]], [-2, [69, 117, 180]], [4, [116, 173, 209]], [10, [120, 190, 200]], [15, [171, 210, 120]], [20, [254, 210, 110]], [25, [253, 150, 80]], [30, [230, 85, 55]], [36, [165, 0, 38]]];
export function couleurTemperature(t) {
  const P = PALETTE_T;
  if (t <= P[0][0]) return `rgb(${P[0][1]})`;
  for (let i = 1; i < P.length; i++) if (t <= P[i][0]) {
    const u = (t - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
    return `rgb(${P[i][1].map((c, j) => Math.round(P[i - 1][1][j] + u * (c - P[i - 1][1][j]))).join(',')})`;
  }
  return `rgb(${P[P.length - 1][1]})`;
}
export function tranchesDe(b) {
  return Array.from({ length: b.length + 1 }, (_, k) => {
    const min = k ? b[k - 1] : -Infinity, max = k < b.length ? b[k] : Infinity;
    const libelle = k === 0 ? `< ${virg(max)} °C` : k === b.length ? `≥ ${virg(min)} °C` : `${virg(min)} à ${virg(max)} °C`;
    const milieu = k === 0 ? max - 3 : k === b.length ? min + 3 : (min + max) / 2;
    return { k, min, max, libelle, couleur: couleurTemperature(milieu) };
  });
}
export const indiceTranche = (t, b) => { let k = 0; while (k < b.length && t >= b[k]) k++; return k; };

// H : heures ; annee : null = toute la période ; bornes ; grandeur tmoy|tmax|tmin ; typique (EPW) ; utci : S.utci de statistiquesClimat (même H,
// même année) ou null. Les tableaux année par année portent sur toutes les années de H, quelle que soit l'année choisie.
export function statistiquesTranches(H, { annee = null, bornes = DECOUPAGES[DECOUPAGE_DEFAUT].bornes, grandeur = 'tmoy', typique = false, utci = null } = {}) {
  annee = annee == null || annee === '' ? null : Number(annee);
  if (!GRANDEURS[grandeur]) grandeur = 'tmoy';
  const b = bornes, nt = b.length + 1, nk = CLASSES_UTCI.length;
  const garder = (i) => annee == null || H.annee[i] === annee;
  const U = utci?.horaire ?? null;
  const T = tranchesDe(b).map((t) => ({ ...t, heures: 0, idx: [], heuresParAnnee: {}, jours: 0, joursParAnnee: {}, touches: 0, touchesParAnnee: {},
    moisH: new Array(12).fill(0), moisJ: new Array(12).fill(0), sU: 0, nU: 0, nUt: 0, sUS: 0, sUO: 0, clS: new Array(nk).fill(0), clO: new Array(nk).fill(0) }));
  const D = new Map();
  let heuresT = 0;
  const heuresTParAnnee = {};
  for (let i = 0; i < H.n; i++) {
    const t = H.T[i];
    if (!ok(t)) continue;
    const k = indiceTranche(t, b), x = T[k], a = H.annee[i];
    x.heuresParAnnee[a] = (x.heuresParAnnee[a] || 0) + 1;
    heuresTParAnnee[a] = (heuresTParAnnee[a] || 0) + 1;
    let d = D.get(H.jour[i]);
    if (!d) { d = { k: H.jour[i], annee: a, mois: H.mois[i], n: 0, sT: 0, tmin: Infinity, tmax: -Infinity, tr: new Uint8Array(nt) }; D.set(H.jour[i], d); }
    d.n++; d.sT += t; d.tr[k] = 1;
    const tn = ok(H.TN[i]) ? H.TN[i] : t, tx = ok(H.TX[i]) ? H.TX[i] : t;
    if (tn < d.tmin) d.tmin = tn;
    if (tx > d.tmax) d.tmax = tx;
    if (!garder(i)) continue;
    heuresT++; x.heures++; x.idx.push(i); x.moisH[H.mois[i]]++;
    if (ok(H.U[i])) { x.sU += H.U[i]; x.nU++; }
    if (U && U.deJour[i] && ok(U.uS[i])) { x.nUt++; x.sUS += U.uS[i]; x.sUO += U.uO[i]; x.clS[indiceClasse(U.uS[i])]++; x.clO[indiceClasse(U.uO[i])]++; }
  }
  const anneesSet = new Set();
  const joursValidesParAnnee = {};
  let joursValides = 0;
  for (const d of D.values()) {
    if (d.n < 20) continue;
    d.tmoy = d.sT / d.n;
    d.tranche = indiceTranche(d[grandeur], b);
    const x = T[d.tranche], a = d.annee;
    anneesSet.add(a);
    joursValidesParAnnee[a] = (joursValidesParAnnee[a] || 0) + 1;
    x.joursParAnnee[a] = (x.joursParAnnee[a] || 0) + 1;
    for (let k = 0; k < nt; k++) if (d.tr[k]) T[k].touchesParAnnee[a] = (T[k].touchesParAnnee[a] || 0) + 1;
    if (annee != null && a !== annee) continue;
    joursValides++; x.jours++; x.moisJ[d.mois]++;
    for (let k = 0; k < nt; k++) if (d.tr[k]) T[k].touches++;
  }
  const annees = [...anneesSet].sort((p, q) => p - q);
  const nAnnees = typique || annee != null ? 1 : Math.max(1, annees.length);
  const rafaleMax = (idx) => { let m = -Infinity; for (const i of idx) if (ok(H.FXI[i]) && H.FXI[i] > m) m = H.FXI[i]; return m > -Infinity ? r1(m) : null; };
  const dominante = (cl) => { let m = -1, k = null; cl.forEach((n, j) => { if (n > m) { m = n; k = j; } }); return m > 0 ? k : null; };
  const tranches = T.map((x) => {
    const vent = roseHeures(H, x.idx);
    vent.fxiMax = H.rafales ? rafaleMax(x.idx) : null;
    return {
      k: x.k, min: x.min, max: x.max, libelle: x.libelle, couleur: x.couleur,
      heures: x.heures, pctHeures: heuresT ? (100 * x.heures) / heuresT : 0, heuresParAn: x.heures / nAnnees,
      jours: x.jours, pctJours: joursValides ? (100 * x.jours) / joursValides : 0, joursParAn: x.jours / nAnnees,
      touches: x.touches, pctTouches: joursValides ? (100 * x.touches) / joursValides : 0, touchesParAn: x.touches / nAnnees,
      heuresParAnnee: x.heuresParAnnee, joursParAnnee: x.joursParAnnee, touchesParAnnee: x.touchesParAnnee,
      moisJours: x.moisJ.map((v) => v / nAnnees), moisHeures: x.moisH.map((v) => v / nAnnees),
      hrMoy: x.nU ? x.sU / x.nU : null, vent,
      utci: U ? { n: x.nUt, soleil: x.nUt ? x.sUS / x.nUt : null, ombre: x.nUt ? x.sUO / x.nUt : null, classeSoleil: dominante(x.clS), classeOmbre: dominante(x.clO),
        pctClasseSoleil: x.nUt ? (100 * Math.max(...x.clS)) / x.nUt : null, pctClasseOmbre: x.nUt ? (100 * Math.max(...x.clO)) / x.nUt : null } : null,
    };
  });
  const resultat = {
    version: VERSION, bornes: [...b], grandeur, annee, typique, source: H.source, rafales: !!H.rafales, annees, nAnnees,
    heuresT, joursValides, heuresTParAnnee, joursValidesParAnnee, tranches, utci: !!U,
    classesUTCI: CLASSES_UTCI.map((c) => ({ libelle: c.libelle, couleur: c.couleur })),
  };
  // tranche de chaque journée valide (clé jour → indice de tranche) : export seulement (feuille « Jours »), non énumérable
  Object.defineProperty(resultat, 'trancheJour', { value: new Map([...D.values()].filter((d) => d.n >= 20).map((d) => [d.k, d.tranche])), enumerable: false });
  return resultat;
}

// phrases du résumé : tranches « principales » (au moins 1 % des jours ou des heures), de la plus froide à la plus chaude
export function texteTranches(R, periode) {
  const parAn = R.typique ? 'dans l\'année type' : R.nAnnees > 1 ? 'par an' : 'dans l\'année';
  const g = { tmoy: 'température moyenne du jour', tmax: 'maximum du jour', tmin: 'minimum du jour' }[R.grandeur];
  const p = [`Sur ${/^année/.test(periode) ? 'l\'' : ''}${periode}, jours classés par ${g} (borne basse incluse, haute exclue) :`];
  for (const t of R.tranches) {
    if (t.pctJours < 1 && t.pctHeures < 1) continue;
    p.push(`${t.libelle} : ${nb(t.joursParAn, t.joursParAn < 10 && R.nAnnees > 1 ? 1 : 0)} jour${t.joursParAn >= 2 ? 's' : ''} ${parAn} (${nb(t.pctJours, 1)} %), ${nb(t.heuresParAn)} h ${parAn} (${nb(t.pctHeures, 1)} % des heures) ; ${texteVentCategorie(t.vent)}.`);
  }
  return p;
}

export function csvTranches(R, entete = '') {
  const L = [];
  const lg = (...v) => L.push(v.map(cel).join(';'));
  if (entete) lg(entete);
  lg(`Tranches de température (atlas HdV, ${VERSION}) ; bornes ${R.bornes.join(' | ')} °C, borne inférieure incluse, supérieure exclue ; heures = température horaire ; jours = journées valides (jour civil Europe/Paris, au moins 20 h) classées par ${R.grandeur} ; jours touchés = au moins une heure dans la tranche`);
  L.push('');
  const k = R.nAnnees;
  lg('# Heures et jours par tranche'); lg('tranche', 'min_inclus', 'max_exclu', 'heures', 'pct_heures', 'heures_par_an', 'jours', 'pct_jours', 'jours_par_an', 'jours_touches', 'pct_jours_touches', 'jours_touches_par_an', 'hr_moy_pct');
  for (const t of R.tranches) lg(t.libelle, ok(t.min) ? t.min : '', ok(t.max) ? t.max : '', t.heures, t.pctHeures, t.heuresParAn, t.jours, t.pctJours, t.joursParAn, t.touches, t.pctTouches, t.touchesParAn, t.hrMoy);
  lg('total', '', '', R.heuresT, 100, R.heuresT / k, R.joursValides, 100, R.joursValides / k);
  L.push('');
  if (!R.typique && R.annees.length) {
    for (const [titre, cle, tot] of [['Jours par année', 'joursParAnnee', R.joursValidesParAnnee], ['Heures par année', 'heuresParAnnee', R.heuresTParAnnee]]) {
      lg(`# ${titre}`); lg('annee', ...R.tranches.map((t) => t.libelle), 'total');
      for (const a of R.annees) lg(a, ...R.tranches.map((t) => t[cle][a] || 0), tot[a] || 0);
      L.push('');
    }
  }
  const MOIS = ['janv', 'fevr', 'mars', 'avr', 'mai', 'juin', 'juil', 'aout', 'sept', 'oct', 'nov', 'dec'];
  for (const [titre, cle] of [['Jours par mois (moyenne annuelle)', 'moisJours'], ['Heures par mois (moyenne annuelle)', 'moisHeures']]) {
    lg(`# ${titre}`); lg('tranche', ...MOIS, 'annee');
    for (const t of R.tranches) lg(t.libelle, ...t[cle], t[cle].reduce((a, v) => a + v, 0));
    L.push('');
  }
  lg('# Vent par tranche (heures dont la température est dans la tranche ; 12 secteurs de 30°, calme < 1 m/s)');
  lg('tranche', 'heures_vent', 'calme_pct', 'dominant', 'direction_moy_deg', 'dominant_pct', 'vitesse_moy_ms', 'vitesse_max_ms', 'rafale_max_ms', 'echantillon_faible', ...NOMS12.map((n) => `h_${n}`));
  for (const t of R.tranches) { const r = t.vent; lg(t.libelle, r.N, r.calmes, r.dominant?.nom ?? '', r.dominant?.degMoyen ?? '', r.dominant?.f ?? '', r.vm, r.vmax, r.fxiMax, r.peuRepresentatif ? 'oui' : 'non', ...r.secteurs.map((x) => x.n)); }
  if (R.utci) {
    L.push('');
    lg('# UTCI par tranche (heures de jour, piéton en site dégagé)'); lg('tranche', 'heures_jour', 'utci_moy_soleil', 'classe_dominante_soleil', 'utci_moy_ombre', 'classe_dominante_ombre');
    for (const t of R.tranches) { const u = t.utci; lg(t.libelle, u.n, u.soleil, u.classeSoleil != null ? R.classesUTCI[u.classeSoleil].libelle : '', u.ombre, u.classeOmbre != null ? R.classesUTCI[u.classeOmbre].libelle : ''); }
  }
  return BOM + L.join('\r\n') + '\r\n';
}
