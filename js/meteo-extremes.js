// Conditions extrêmes (10/11/2026, demande de l'utilisateur : « d'où vient le vent quand il y a canicule et quand il fait le plus froid ») :
// calcul PUR (ni Three.js, ni DOM, ni fetch), testable sous Node. Lu par js/meteo.js (extremesDetail), affiché par js/climat.js
// (bloc « Conditions extrêmes ») et js/vent.js (sélecteur « Situation »).
//
// Entrée : mesures horaires en colonnes H = { n, source: 'mf'|'epw', rafales (bool), ms (instant UTC de la mesure, ms), loc (heure de
// Paris, ms « décalés » : lire avec getUTC*), jour (clé de la journée civile de Paris = floor(loc / 86 400 000)), annee, mois (0-11),
// heure (0-23) de Paris, T, TN, TX, FF, DD, FXI (NaN si manquant) }, construite par :
// - heuresDepuisCSV(texte) : data/meteo/meteofrance_44020001_horaire.csv (Météo-France, station 44020001 Nantes-Bouguenais, colonnes
//   AAAAMMJJHH (UTC), FF (vent moyen 10 min à 10 m, m/s), DD (direction d'où vient le vent, degrés, 0 = calme), FXI (rafale instantanée
//   maximale de l'heure, m/s), T, TN, TX (température de l'heure, minimale et maximale dans l'heure, °C), U, …) ; filtrée sur les années
//   civiles de Paris [debut, fin] (2016-2025 par défaut, comme meteo.json) ;
// - heuresDepuisEPW(lecture) : colonnes de js/epw.js (lireEPW) : T, FF, DD horaires ; pas de TN / TX (= T), pas de rafales.
// Colonnes complémentaires (11/11/2026, lues pour js/climat-stats.js, ignorées par analyser) : U (humidité relative, %), TD (point de
// rosée), RR1 (pluie de l'heure, mm ; absente de l'EPW), N (nébulosité en octas ; EPW : dixièmes × 0,8), GLO (rayonnement global de
// l'heure écoulée, W/m² : J/cm² Météo-France × 10 000 / 3 600, ou GHI de l'EPW), DNI et DHI (EPW seulement ; Météo-France : NaN).
// Heure de Paris : comme js/epw.js et outils/meteo/extremes.py (heure d'été européenne du dernier dimanche de mars au dernier d'octobre).
//
// Définitions (CONDITIONS, affichées) : seuils sur la température horaire T et le vent moyen FF ; calme = FF < 1 m/s (pas de secteur) ;
// rose à 12 secteurs de 30° centrés sur k × 30° (comme l'outil Vent), fréquences en % de TOUTES les heures de la condition (calmes compris).
// Journée valide : au moins 20 heures de T ; Tmin = minimum de TN (sinon T), Tmax = maximum de TX (sinon T) (comme extremes.json).
// Canicule : seuils de vigilance canicule de Météo-France pour la Loire-Atlantique, IBMn ≥ 20 °C et IBMx ≥ 34 °C, moyennes sur 3 jours
// consécutifs des Tmin et des Tmax : les 3 jours de chaque fenêtre qui dépasse les deux seuils sont « jours de canicule ». Vague de chaleur
// (définition simple, pour comparer) : au moins 3 jours consécutifs avec Tmax ≥ 33 °C et Tmin ≥ 18 °C.

export const CALME = 1; // m/s
export const HEURES_MIN = 100; // comme js/meteo.js : en dessous, échantillon faible
export const NOMS12 = ['N', 'NNE', 'ENE', 'E', 'ESE', 'SSE', 'S', 'SSO', 'OSO', 'O', 'ONO', 'NNO'];
export const NOMS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const nom16 = (deg) => NOMS16[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
export const CANICULE = { departement: 'Loire-Atlantique (44)', ibmn: 20, ibmx: 34, jours: 3 };
export const VAGUE = { tmin: 18, tmax: 33, jours: 3 };
export const RAFALE_70 = 70 / 3.6, RAFALE_100 = 100 / 3.6;
const SAISON_MOIS = { annee: null, hiver: [11, 0, 1], printemps: [2, 3, 4], ete: [5, 6, 7], automne: [8, 9, 10] };
const J = 86400000;
const BOM = String.fromCharCode(0xfeff); // marque d'ordre des octets (Excel reconnaît l'UTF-8)

// Conditions : id, libellé, groupe (chaud | froid | vent | mixte), définition affichée, situation (proposée dans l'outil Vent)
export const CONDITIONS = [
  { id: 'habituel', libelle: 'Toutes les heures', groupe: 'reference', def: 'toutes les heures mesurées (référence)' },
  { id: 'chaleur', libelle: 'Chaleur', groupe: 'chaud', def: 'heures où T ≥ 30 °C', situation: true },
  { id: 'forte-chaleur', libelle: 'Forte chaleur', groupe: 'chaud', def: 'heures où T ≥ 35 °C' },
  { id: 'canicule', libelle: 'Canicule', groupe: 'chaud', def: `jours de canicule (seuils de vigilance de Météo-France pour la ${CANICULE.departement} : moyennes sur 3 jours des minimales ≥ ${CANICULE.ibmn} °C et des maximales ≥ ${CANICULE.ibmx} °C), toutes leurs heures`, situation: true },
  { id: 'vague-chaleur', libelle: 'Vague de chaleur (déf. simple)', groupe: 'chaud', def: `au moins ${VAGUE.jours} jours consécutifs avec maximale ≥ ${VAGUE.tmax} °C et minimale ≥ ${VAGUE.tmin} °C, toutes leurs heures` },
  { id: 'gel', libelle: 'Gel', groupe: 'froid', def: 'heures où T ≤ 0 °C', situation: true },
  { id: 'grand-froid', libelle: 'Grand froid', groupe: 'froid', def: 'heures où T ≤ −5 °C' },
  { id: 'plus-froid', libelle: 'Plus grand froid', groupe: 'froid', def: 'toutes les heures des 10 jours les plus froids de la série (minimales les plus basses)', situation: true },
  { id: 'vente', libelle: 'Venté', groupe: 'vent', def: 'heures où le vent moyen ≥ 8 m/s (29 km/h)' },
  { id: 'tempete', libelle: 'Tempête (force 6 et plus)', groupe: 'vent', def: 'heures où le vent moyen ≥ 10,8 m/s (force 6 Beaufort, 39 km/h)', situation: true },
  { id: 'rafale-70', libelle: 'Rafales ≥ 70 km/h', groupe: 'vent', def: 'heures dont la rafale maximale ≥ 70 km/h (19,4 m/s)', rafales: true },
  { id: 'rafale-100', libelle: 'Rafales ≥ 100 km/h', groupe: 'vent', def: 'heures dont la rafale maximale ≥ 100 km/h (27,8 m/s)', rafales: true },
  { id: 'chaud-sans-vent', libelle: 'Chaud et sans vent', groupe: 'mixte', def: 'heures où T ≥ 30 °C et vent moyen < 2 m/s (poches de chaleur)', situation: true },
  { id: 'froid-vente', libelle: 'Froid et venté', groupe: 'mixte', def: 'heures où T ≤ 5 °C et vent moyen ≥ 8 m/s (refroidissement éolien)', situation: true },
];
export const condition = (id) => CONDITIONS.find((c) => c.id === id) ?? null;

// heure d'été de Paris (comme js/epw.js) : décalage (h) à l'instant UTC ms
const dimanche = (a, m) => { const d = new Date(Date.UTC(a, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
const memoDST = new Map();
function decalageParis(ms) {
  const a = new Date(ms).getUTCFullYear();
  let b = memoDST.get(a);
  if (!b) { b = [Date.UTC(a, 2, dimanche(a, 2), 1), Date.UTC(a, 9, dimanche(a, 9), 1)]; memoDST.set(a, b); }
  return ms >= b[0] && ms < b[1] ? 2 : 1;
}

function colonnes(n) {
  const f = () => new Float64Array(n).fill(NaN);
  return { n, ms: new Float64Array(n), loc: new Float64Array(n), jour: new Int32Array(n), annee: new Int16Array(n), mois: new Int8Array(n), heure: new Int8Array(n), T: f(), TN: f(), TX: f(), FF: f(), DD: f(), FXI: f(), U: f(), TD: f(), RR1: f(), N: f(), GLO: f(), DNI: f(), DHI: f() };
}
function poserHeure(H, i, ms) {
  const loc = ms + decalageParis(ms) * 3600e3, d = new Date(loc);
  H.ms[i] = ms; H.loc[i] = loc; H.jour[i] = Math.floor(loc / J);
  H.annee[i] = d.getUTCFullYear(); H.mois[i] = d.getUTCMonth(); H.heure[i] = d.getUTCHours();
}
function tronquer(H, m) {
  const o = { n: m };
  for (const [k, v] of Object.entries(H)) if (ArrayBuffer.isView(v)) o[k] = v.slice(0, m);
  return { ...H, ...o };
}

// CSV Météo-France (séparateur « , » ou « ; »), heures AAAAMMJJHH en UTC
export function heuresDepuisCSV(texte, { debut = 2016, fin = 2025 } = {}) {
  const lignes = String(texte).split(/\r?\n/);
  const sep = lignes[0].includes(';') ? ';' : ',';
  const tete = lignes[0].replace(BOM, '').split(sep).map((x) => x.trim().toUpperCase());
  const c = (k) => tete.indexOf(k);
  const iD = c('AAAAMMJJHH');
  if (iD < 0) throw new Error('CSV horaire : colonne AAAAMMJJHH absente.');
  const idx = { T: c('T'), TN: c('TN'), TX: c('TX'), FF: c('FF'), DD: c('DD'), FXI: c('FXI'), U: c('U'), TD: c('TD'), RR1: c('RR1'), N: c('N'), GLO: c('GLO') };
  const H = colonnes(lignes.length);
  let m = 0;
  for (let l = 1; l < lignes.length; l++) {
    const v = lignes[l].split(sep);
    const d = v[iD];
    if (!d || d.length < 10) continue;
    const ms = Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +d.slice(8, 10));
    poserHeure(H, m, ms);
    if (H.annee[m] < debut || H.annee[m] > fin) continue;
    for (const [k, j] of Object.entries(idx)) {
      if (j < 0) continue;
      const s = v[j];
      if (s == null || s.trim() === '') continue;
      const x = parseFloat(s.replace(',', '.'));
      if (Number.isFinite(x)) H[k][m] = k === 'GLO' ? x / 0.36 : x; // J/cm² par heure → W/m² moyen
    }
    m++;
  }
  return { ...tronquer(H, m), source: 'mf', rafales: idx.FXI >= 0, periode: [debut, fin], colonnes: Object.keys(idx).filter((k) => idx[k] >= 0) };
}

// EPW (js/epw.js lireEPW) : heure EPW = fin de l'heure, en heure normale du fichier (fuseau de LOCATION)
export function heuresDepuisEPW(lecture) {
  const { col, n, entete } = lecture;
  const H = colonnes(n);
  for (let i = 0; i < n; i++) {
    poserHeure(H, i, Date.UTC(col.annee[i], col.mois[i] - 1, col.jour[i], col.heure[i]) - entete.fuseau * 3600e3);
    H.T[i] = col.T[i]; H.FF[i] = col.FF[i]; H.DD[i] = col.DD[i];
    H.U[i] = col.HR[i]; H.TD[i] = col.Td[i]; H.N[i] = col.neb[i] * 0.8; H.GLO[i] = col.GHI[i]; H.DNI[i] = col.DNI[i]; H.DHI[i] = col.DHI[i];
  }
  // année type : les mois viennent d'années différentes ; les journées gardent leur ordre dans le fichier
  return { ...H, source: 'epw', rafales: false, typique: !!lecture.typique, periode: lecture.periodeReleve ?? null, colonnes: ['T', 'FF', 'DD', 'U', 'TD', 'N', 'GLO', 'DNI', 'DHI'] };
}

const ok = Number.isFinite;
const isoJour = (k) => new Date(k * J).toISOString().slice(0, 10);
const isoHeure = (loc) => new Date(loc).toISOString().slice(0, 13).replace('T', ' ') + ' h';
const r1 = (v) => (v == null || !ok(v) ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v == null || !ok(v) ? null : Math.round(v * 100) / 100);
const quantile = (tri, q) => (tri.length ? tri[Math.min(tri.length - 1, Math.floor(q * (tri.length - 1) + 0.5))] : null);
const secteur = (dd) => Math.round(dd / 30) % 12;

// Journées civiles de Paris : Map clé → { tmin, tmax, n, annee }
function journees(H, garder) {
  const D = new Map();
  for (let i = 0; i < H.n; i++) {
    if (!garder(i) || !ok(H.T[i])) continue;
    let d = D.get(H.jour[i]);
    if (!d) { d = { k: H.jour[i], n: 0, tmin: Infinity, tmax: -Infinity, annee: H.annee[i] }; D.set(H.jour[i], d); }
    d.n++;
    const tn = ok(H.TN[i]) ? H.TN[i] : H.T[i], tx = ok(H.TX[i]) ? H.TX[i] : H.T[i];
    if (tn < d.tmin) d.tmin = tn;
    if (tx > d.tmax) d.tmax = tx;
  }
  for (const [k, d] of D) if (d.n < 20) D.delete(k);
  return D;
}
function joursCanicule(D) {
  const s = new Set();
  for (const k of D.keys()) {
    const w = [0, 1, 2].map((j) => D.get(k + j));
    if (w.some((x) => !x)) continue;
    const mn = (w[0].tmin + w[1].tmin + w[2].tmin) / 3, mx = (w[0].tmax + w[1].tmax + w[2].tmax) / 3;
    if (mn >= CANICULE.ibmn - 1e-9 && mx >= CANICULE.ibmx - 1e-9) w.forEach((x) => s.add(x.k));
  }
  return s;
}
function joursVague(D) {
  const s = new Set();
  const cles = [...D.keys()].sort((a, b) => a - b);
  let run = [];
  const fermer = () => { if (run.length >= VAGUE.jours) run.forEach((k) => s.add(k)); run = []; };
  for (const k of cles) {
    const d = D.get(k);
    const c = d.tmin >= VAGUE.tmin && d.tmax >= VAGUE.tmax;
    if (c && run.length && k !== run[run.length - 1] + 1) fermer();
    if (c) run.push(k); else fermer();
  }
  fermer();
  return s;
}
// épisodes : jours consécutifs
function episodes(jours, heuresParJour) {
  const cles = [...jours].sort((a, b) => a - b);
  const ep = [];
  for (const k of cles) {
    const e = ep[ep.length - 1];
    if (e && k === e.fin + 1) { e.fin = k; e.jours++; e.heures += heuresParJour.get(k) || 0; } else ep.push({ debut: k, fin: k, jours: 1, heures: heuresParJour.get(k) || 0 });
  }
  return ep.map((e) => ({ debut: isoJour(e.debut), fin: isoJour(e.fin), jours: e.jours, heures: e.heures }));
}

// Rose à 12 secteurs d'une liste d'heures (indices), au format de js/meteo.js rose() + vitesses max et rafales
export function roseHeures(H, idx, saison = 'annee') {
  const mois = SAISON_MOIS[saison];
  const S = Array.from({ length: 12 }, () => []);
  const R = Array.from({ length: 12 }, () => -Infinity);
  const DDs = Array.from({ length: 12 }, () => [0, 0]);
  let N = 0, calmes = 0, somme = 0, e3 = 0, vmax = -Infinity;
  for (const i of idx) {
    if (mois && !mois.includes(H.mois[i])) continue;
    const ff = H.FF[i], dd = H.DD[i];
    if (!ok(ff) || (ff >= CALME && !(dd >= 0 && dd <= 360))) continue;
    N++; somme += ff; if (ff > vmax) vmax = ff;
    if (ff < CALME) { calmes++; continue; }
    const k = secteur(dd);
    S[k].push(ff); e3 += ff ** 3;
    const t = (dd * Math.PI) / 180; DDs[k][0] += Math.sin(t); DDs[k][1] += Math.cos(t);
    if (ok(H.FXI[i]) && H.FXI[i] > R[k]) R[k] = H.FXI[i];
  }
  const secteurs = S.map((l, k) => {
    const tri = l.slice().sort((a, b) => a - b);
    const sm = l.reduce((a, b) => a + b, 0);
    return {
      k, dir: k * 30, label: NOMS12[k], n: l.length, f: N ? r2((100 * l.length) / N) : 0,
      vm: l.length ? r2(sm / l.length) : 0, p90: l.length ? r2(quantile(tri, 0.9)) : 0, vmax: l.length ? r1(tri[tri.length - 1]) : null,
      fxi: R[k] > -Infinity ? r1(R[k]) : null, p5: l.length ? r1((100 * l.filter((v) => v > 5).length) / l.length) : 0,
      e: e3 ? r1((100 * l.reduce((a, v) => a + v ** 3, 0)) / e3) : 0,
      degMoyen: l.length ? Math.round(((Math.atan2(DDs[k][0], DDs[k][1]) * 180) / Math.PI + 360) % 360) : null,
    };
  });
  const dom = N > calmes ? secteurs.reduce((a, b) => (b.n > a.n ? b : a)) : null;
  return {
    N, calmes: N ? r2((100 * calmes) / N) : null, vm: N ? r2(somme / N) : null, vmax: N ? r1(vmax) : null,
    peuRepresentatif: N < HEURES_MIN, saison, secteurs,
    dominant: dom && { k: dom.k, dir: dom.dir, nom: NOMS12[dom.k], f: dom.f, vm: dom.vm, p90: dom.p90, degMoyen: dom.degMoyen, nom16: nom16(dom.degMoyen ?? dom.dir) },
  };
}

function ventHeure(H, i) {
  return { date: isoHeure(H.loc[i]), jour: isoJour(H.jour[i]), heure: H.heure[i], DD: ok(H.DD[i]) ? H.DD[i] : null, FF: ok(H.FF[i]) ? H.FF[i] : null, FXI: ok(H.FXI[i]) ? H.FXI[i] : null,
    nom: ok(H.FF[i]) && H.FF[i] >= CALME && ok(H.DD[i]) ? nom16(H.DD[i]) : 'calme', T: ok(H.T[i]) ? H.T[i] : null };
}

// Analyse complète. annee : null (toute la période) ou AAAA (année civile de Paris seule)
export function analyser(H, { annee = null } = {}) {
  const garder = annee == null ? () => true : (i) => H.annee[i] === +annee;
  const D = journees(H, garder);
  const canicule = joursCanicule(D), vague = joursVague(D);
  const froids = [...D.values()].sort((a, b) => a.tmin - b.tmin || a.k - b.k).slice(0, 10);
  const plusFroid = new Set(froids.map((d) => d.k));
  const T = H.T, FF = H.FF, FXI = H.FXI;
  const tests = {
    habituel: () => true,
    chaleur: (i) => T[i] >= 30, 'forte-chaleur': (i) => T[i] >= 35,
    canicule: (i) => canicule.has(H.jour[i]), 'vague-chaleur': (i) => vague.has(H.jour[i]),
    gel: (i) => T[i] <= 0, 'grand-froid': (i) => T[i] <= -5, 'plus-froid': (i) => plusFroid.has(H.jour[i]),
    vente: (i) => FF[i] >= 8, tempete: (i) => FF[i] >= 10.8,
    'rafale-70': (i) => FXI[i] >= RAFALE_70, 'rafale-100': (i) => FXI[i] >= RAFALE_100,
    'chaud-sans-vent': (i) => T[i] >= 30 && FF[i] < 2, 'froid-vente': (i) => T[i] <= 5 && FF[i] >= 8,
  };
  const idx = Object.fromEntries(CONDITIONS.map((c) => [c.id, []]));
  for (let i = 0; i < H.n; i++) {
    if (!garder(i)) continue;
    for (const c of CONDITIONS) if (tests[c.id](i)) idx[c.id].push(i);
  }
  const resultat = {};
  for (const c of CONDITIONS) {
    const I = idx[c.id];
    const indisponible = c.rafales && !H.rafales;
    const parJour = new Map(), parMois = new Array(12).fill(0), parAnnee = {};
    for (const i of I) { parJour.set(H.jour[i], (parJour.get(H.jour[i]) || 0) + 1); parMois[H.mois[i]]++; parAnnee[H.annee[i]] = (parAnnee[H.annee[i]] || 0) + 1; }
    const rose = roseHeures(H, I);
    resultat[c.id] = {
      id: c.id, libelle: c.libelle, def: c.def, groupe: c.groupe, indisponible,
      heures: I.length, jours: parJour.size, heuresVent: rose.N, peuRepresentatif: rose.N < HEURES_MIN,
      episodes: c.id === 'habituel' ? [] : episodes(new Set(parJour.keys()), parJour), parMois, parAnnee: H.source === 'epw' ? null : parAnnee, rose,
    };
  }
  // records : heure de la température maximale (TX, sinon T) et minimale (TN, sinon T), avec son vent
  let ic = -1, ifr = -1, vc = -Infinity, vf = Infinity;
  const parAn = {};
  for (let i = 0; i < H.n; i++) {
    if (!garder(i)) continue;
    const tx = ok(H.TX[i]) ? H.TX[i] : T[i], tn = ok(H.TN[i]) ? H.TN[i] : T[i];
    if (ok(tx) && tx > vc) { vc = tx; ic = i; }
    if (ok(tn) && tn < vf) { vf = tn; ifr = i; }
    if (H.source !== 'epw') {
      const a = H.annee[i];
      const p = parAn[a] ??= { c: -1, vc: -Infinity, f: -1, vf: Infinity };
      if (ok(tx) && tx > p.vc) { p.vc = tx; p.c = i; }
      if (ok(tn) && tn < p.vf) { p.vf = tn; p.f = i; }
    }
  }
  const record = (i, v) => (i < 0 ? null : { valeur: v, ...ventHeure(H, i) });
  const annees = Object.entries(parAn).map(([a, p]) => ({ annee: +a, chaud: record(p.c, p.vc), froid: record(p.f, p.vf) }));
  return {
    source: H.source, rafales: H.rafales, typique: !!H.typique, annee: annee == null ? null : +annee, calme: CALME, joursValides: D.size,
    conditions: resultat, idx,
    recordChaud: record(ic, vc), recordFroid: record(ifr, vf), annees,
    joursFroids: froids.map((d) => ({ date: isoJour(d.k), tmin: r1(d.tmin), tmax: r1(d.tmax) })),
    canicule: resultat.canicule.episodes,
    H,
  };
}

// Rose d'une condition pour une saison (4 roses des saisons de l'outil Vent), même format
export const roseCondition = (R, id, saison = 'annee') => (saison === 'annee' ? R.conditions[id]?.rose : roseHeures(R.H, R.idx[id] || [], saison));

// ------------------------------------------------------------------
// Textes (français, virgule décimale)
// ------------------------------------------------------------------
// noms en toutes lettres (« le vent vient du nord-est », « vent d'ouest ») des 12 et 16 secteurs
const POINTS = { N: 'nord', NNE: 'nord-nord-est', NE: 'nord-est', ENE: 'est-nord-est', E: 'est', ESE: 'est-sud-est', SE: 'sud-est', SSE: 'sud-sud-est', S: 'sud', SSO: 'sud-sud-ouest', SO: 'sud-ouest', OSO: 'ouest-sud-ouest', O: 'ouest', ONO: 'ouest-nord-ouest', NO: 'nord-ouest', NNO: 'nord-nord-ouest' };
export const nomLong = (abr) => POINTS[abr] ?? abr;
export const duNom = (abr) => { const n = nomLong(abr); return /^[eo]/.test(n) ? `de l'${n}` : `du ${n}`; }; // « du nord », « de l'est »
const dUn = (abr) => { const n = nomLong(abr); return /^[eo]/.test(n) ? `d'${n}` : `du ${n}`; }; // « vent d'ouest », « vent du nord »
const nb = (v, d = 1) => (v == null ? '–' : Number(v).toFixed(d).replace('.', ','));
const dateFr = (iso) => iso.split('-').reverse().join('/');
export function texteVent(v) {
  if (!v || v.FF == null) return 'vent non mesuré';
  if (v.nom === 'calme') return `calme (${nb(v.FF)} m/s)`;
  return `vent ${dUn(v.nom)} (${v.nom}, ${Math.round(v.DD)}°) à ${nb(v.FF)} m/s${v.FXI != null ? `, rafale ${nb(v.FXI)} m/s (${Math.round(v.FXI * 3.6)} km/h)` : ''}`;
}
export function texteDominant(c, periode) {
  const r = c.rose, d = r.dominant;
  if (!c.heures) return `${c.libelle} : aucune heure (${periode}).`;
  if (!d) return `${c.libelle} (${c.heures} h) : vent calme ou non mesuré.`;
  return `${c.libelle} (${c.heures.toLocaleString('fr-FR')} h, ${c.jours} jour${c.jours > 1 ? 's' : ''}, ${periode}) : le vent vient surtout ${duNom(d.nom)} (${d.nom}, secteur ${d.dir}° ± 15°, direction moyenne ${d.degMoyen}°) : ${nb(d.f, 0)} % des heures, ${nb(d.vm)} m/s en moyenne dans ce secteur ; ${nb(r.vm)} m/s en moyenne toutes directions, calme ${nb(r.calmes, 0)} %.${c.peuRepresentatif ? ` Échantillon faible (${r.N} h de vent, moins de ${HEURES_MIN}).` : ''}`;
}
export function texteRecord(x, chaud) {
  if (!x) return '';
  return `${chaud ? 'Au plus chaud' : 'Au plus froid'} (${nb(x.valeur)} °C le ${dateFr(x.jour)} à ${x.heure} h, heure de Paris) : ${texteVent(x)}.`;
}
export const AVERTISSEMENT = 'Statistique observée sur les mesures passées, pas une prévision ; vent mesuré à 10 m sur le terrain dégagé de l\'aéroport (en ville, plus faible et dévié par le bâti).';

// ------------------------------------------------------------------
// Export CSV des roses par condition (séparateur « ; », virgule décimale, BOM pour Excel)
// ------------------------------------------------------------------
const cellule = (v) => (v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : /[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
export function csvExtremes(R, entete = '') {
  const L = [['condition', 'definition', 'heures', 'jours', 'heures_vent', 'calmes_pct', 'vent_moyen_ms', 'vent_max_ms', 'secteur', 'direction_deg', 'frequence_pct', 'vent_moyen_secteur_ms', 'vent_p90_secteur_ms', 'vent_max_secteur_ms', 'rafale_max_secteur_ms', 'remarque']];
  for (const c of Object.values(R.conditions)) {
    const r = c.rose;
    const rem = c.indisponible ? 'pas de rafales dans cette source' : c.peuRepresentatif ? `échantillon faible (< ${HEURES_MIN} h)` : '';
    if (!r.N) { L.push([c.id, c.def, c.heures, c.jours, 0, '', '', '', '', '', '', '', '', '', '', rem || 'aucune heure']); continue; }
    for (const s of r.secteurs) L.push([c.id, c.def, c.heures, c.jours, r.N, r.calmes, r.vm, r.vmax, s.label, s.dir, s.f, s.n ? s.vm : null, s.n ? s.p90 : null, s.vmax, s.fxi, rem]);
  }
  const ep = [['', ''], ['# episodes', ''], ['condition', 'debut', 'fin', 'jours', 'heures']];
  for (const c of Object.values(R.conditions)) for (const e of c.episodes) if (['canicule', 'vague-chaleur', 'plus-froid', 'grand-froid', 'rafale-100', 'chaud-sans-vent', 'froid-vente'].includes(c.id)) ep.push([c.id, e.debut, e.fin, e.jours, e.heures]);
  const rec = [['', ''], ['# records (heure de Paris)', ''], ['quoi', 'date_heure', 'temperature_C', 'direction_deg', 'secteur', 'vent_ms', 'rafale_ms']];
  const ligneRec = (q, x) => x && rec.push([q, x.date, x.valeur, x.DD, x.nom, x.FF, x.FXI]);
  ligneRec('plus_chaud', R.recordChaud); ligneRec('plus_froid', R.recordFroid);
  for (const a of R.annees) { ligneRec(`plus_chaud_${a.annee}`, a.chaud); ligneRec(`plus_froid_${a.annee}`, a.froid); }
  const txt = [...L, ...ep, ...rec].map((l) => l.map(cellule).join(';')).join('\r\n');
  return `${BOM}# ${entete}\r\n# Calme : vent moyen < ${CALME} m/s (sans secteur) ; fréquences en % de toutes les heures de la condition ; 12 secteurs de 30° centrés sur la direction indiquée (d'où vient le vent). ${AVERTISSEMENT}\r\n${txt}\r\n`;
}
