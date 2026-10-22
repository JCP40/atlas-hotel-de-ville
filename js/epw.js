// Fichiers météo EPW (EnergyPlus Weather) : lecture et adaptation au format de data/meteo/*.json.
// lireEPW(texte) : 8 lignes d'en-tête (LOCATION, DESIGN CONDITIONS, TYPICAL/EXTREME PERIODS, GROUND TEMPERATURES,
// HOLIDAYS/DAYLIGHT SAVINGS, COMMENTS 1, COMMENTS 2, DATA PERIODS) puis une ligne par heure (8760, 8784 en année
// bissextile). Heure EPW = heure 1 à 24 de fin de l'intervalle, en heure normale du fuseau du fichier (sans heure d'été).
// adapterEPW(epw) : mêmes structures que meteo.json, meteo_horaire.json, extremes.json et chaleur/journees.json,
// pour que js/meteo.js serve indifféremment la météo de base (Météo-France) ou un EPW. Calcul pur, sans DOM.

// colonnes utiles d'une ligne de données (numérotation EnergyPlus, à partir de 0) et valeurs « manquant »
const COL = { annee: 0, mois: 1, jour: 2, heure: 3, T: 6, Td: 7, HR: 8, P: 9, GHI: 13, DNI: 14, DHI: 15, DD: 20, FF: 21, neb: 22 };
const MANQUANT = { T: 99.9, Td: 99.9, HR: 999, P: 999999, GHI: 9999, DNI: 9999, DHI: 9999, DD: 999, FF: 999, neb: 99 };
const BORNES = { T: [-70, 70], Td: [-70, 70], HR: [0, 110], P: [31000, 120000], GHI: [0, 1500], DNI: [0, 1400], DHI: [0, 1000], DD: [0, 360], FF: [0, 60], neb: [0, 10] };
export const VARIABLES = { T: 'température sèche', Td: 'point de rosée', HR: 'humidité relative', P: 'pression', GHI: 'rayonnement global horizontal', DNI: 'rayonnement direct normal', DHI: 'rayonnement diffus horizontal', DD: 'direction du vent', FF: 'vitesse du vent', neb: 'nébulosité' };

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const moyenne = (l) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : null);
const quantile = (l, q) => { if (!l.length) return null; const s = [...l].sort((a, b) => a - b); const p = (s.length - 1) * q, i = Math.floor(p); return s[i] + (s[Math.min(i + 1, s.length - 1)] - s[i]) * (p - i); };
const pad = (n) => String(n).padStart(2, '0');

export class ErreurEPW extends Error {}

export function lireEPW(texte) {
  const lignes = String(texte).replace(/^[^L]+(?=LOCATION)/, '').split(/\r?\n/);
  const loc = lignes[0]?.split(',') ?? [];
  if (loc[0]?.trim().toUpperCase() !== 'LOCATION' || loc.length < 10) throw new ErreurEPW('Ce fichier ne ressemble pas à un EPW : première ligne LOCATION absente.');
  const num = (v) => { const x = parseFloat(v); return Number.isFinite(x) ? x : null; };
  const entete = {
    ville: loc[1].trim().replace(/[._]+/g, ' ').trim(), region: loc[2].trim(), pays: loc[3].trim(), source: loc[4].trim(), wmo: loc[5].trim(),
    lat: num(loc[6]), lon: num(loc[7]), fuseau: num(loc[8]), altitude: num(loc[9]),
  };
  if (entete.lat == null || entete.lon == null || entete.fuseau == null) throw new ErreurEPW('Ligne LOCATION incomplète (latitude, longitude ou fuseau illisible).');
  const cherche = (cle) => lignes.slice(0, 8).find((l) => l.toUpperCase().startsWith(cle)) || '';
  const commentaires = [cherche('COMMENTS 1'), cherche('COMMENTS 2')].map((l) => l.replace(/^COMMENTS \d,/i, '').replace(/^"|"$/g, '').trim()).filter(Boolean);
  const dp = cherche('DATA PERIODS').split(',');
  const conception = cherche('DESIGN CONDITIONS').split(',').slice(2, 3)[0]?.trim() || '';
  // lignes de données : toutes celles qui commencent par une année (l'en-tête peut compter plus ou moins de 8 lignes)
  const donnees = [];
  for (let i = 0; i < lignes.length; i++) {
    if (!/^\s*\d{4},/.test(lignes[i])) continue;
    const c = lignes[i].split(',');
    if (c.length < 22) continue;
    donnees.push(c);
  }
  const n = donnees.length;
  if (n < 24 * 28) throw new ErreurEPW(`Trop peu de lignes horaires (${n}) : un EPW en compte 8760.`);
  const col = {};
  const manquants = {};
  for (const [k, j] of Object.entries(COL)) {
    const a = new Float64Array(n);
    let m = 0;
    for (let i = 0; i < n; i++) {
      let v = parseFloat(donnees[i][j]);
      if (k in MANQUANT) {
        const [lo, hi] = BORNES[k];
        if (!Number.isFinite(v) || v >= MANQUANT[k] || v < lo || v > hi) { v = NaN; m++; }
      }
      a[i] = v;
    }
    col[k] = a;
    if (k in MANQUANT) manquants[k] = m;
  }
  const annees = [...new Set(col.annee)].filter(Number.isFinite).sort();
  const pr = commentaires.join(' ').match(/Period of Record\s*=\s*(\d{4})\s*-\s*(\d{4})/i);
  const avertissements = [];
  if (n !== 8760 && n !== 8784) avertissements.push(`${n} lignes horaires au lieu de 8760.`);
  for (const [k, m] of Object.entries(manquants)) if (m > n * 0.02) avertissements.push(`${VARIABLES[k]} : ${(100 * m / n).toFixed(1).replace('.', ',')} % de valeurs manquantes.`);
  if (manquants.FF > n * 0.5 || manquants.T > n * 0.5) throw new ErreurEPW('Vent ou température manquant sur plus de la moitié des heures : fichier inutilisable.');
  return {
    entete, commentaires, conception, n, col,
    periodes: { nombre: num(dp[1]), debut: dp[5]?.trim(), fin: dp[6]?.trim() },
    annees, periodeReleve: pr ? [+pr[1], +pr[2]] : (annees.length ? [annees[0], annees[annees.length - 1]] : null),
    typique: /TMY|IWEC|TRY|TMYX/i.test(`${entete.source} ${commentaires.join(' ')}`) || annees.length > 1,
    controles: { heures: n, manquants, avertissements },
  };
}

// dernier dimanche d'un mois (UTC) : bornes de l'heure d'été européenne, à 1 h UTC
const dernierDimanche = (a, m) => { const d = new Date(Date.UTC(a, m + 1, 0)); return d.getUTCDate() - d.getUTCDay(); };
function decalageParis(ms) {
  const a = new Date(ms).getUTCFullYear();
  const debut = Date.UTC(a, 2, dernierDimanche(a, 2), 1), fin = Date.UTC(a, 9, dernierDimanche(a, 9), 1);
  return ms >= debut && ms < fin ? 2 : 1;
}

// Distance à vol d'oiseau (km)
export function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371, rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const SAISON_MOIS = { hiver: [11, 0, 1], printemps: [2, 3, 4], ete: [5, 6, 7], automne: [8, 9, 10] };
const CLASSES_T = { all: [-99, 99], froid: [-99, 5], frais: [5, 12], doux: [12, 20], chaud: [20, 99] };
const SEUILS = Array.from({ length: 25 }, (_, i) => i / 2);

export function adapterEPW(epw, { nom = '' } = {}) {
  const { col, n, entete } = epw;
  // heure locale (Europe/Paris, heure d'été comprise) de fin de chaque heure, comme meteo_horaire.json
  const loc = { mois: new Int8Array(n), heure: new Int8Array(n), jour: new Array(n) };
  for (let i = 0; i < n; i++) {
    const ms = Date.UTC(col.annee[i], col.mois[i] - 1, col.jour[i], col.heure[i]) - entete.fuseau * 3600e3;
    const d = new Date(ms + decalageParis(ms) * 3600e3);
    loc.mois[i] = d.getUTCMonth();
    loc.heure[i] = d.getUTCHours();
    loc.jour[i] = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const ok = (k, i) => !Number.isNaN(col[k][i]);
  const calme = (i) => col.FF[i] < 0.5;
  const ventOk = (i) => ok('FF', i) && (calme(i) || ok('DD', i));
  const secteur = (i, ns) => Math.round(col.DD[i] / (360 / ns)) % ns;
  const dansSaison = (i, s) => s === 'annee' || SAISON_MOIS[s].includes(loc.mois[i]);
  const dansClasse = (i, t) => t === 'all' || (ok('T', i) && col.T[i] >= CLASSES_T[t][0] && col.T[i] < CLASSES_T[t][1]);
  const [p0, p1] = epw.periodeReleve ?? [col.annee[0], col.annee[n - 1]];
  const libelle = `${entete.ville}${entete.pays ? ` (${entete.pays})` : ''}`;

  // ---- rose : rose[16|12][saison][temperature] ----
  function caseRose(ns, s, t) {
    const idx = [];
    for (let i = 0; i < n; i++) if (ventOk(i) && dansSaison(i, s) && dansClasse(i, t)) idx.push(i);
    const N = idx.length;
    if (!N) return null;
    const parS = Array.from({ length: ns }, () => []);
    let nCalmes = 0, somme = 0, e3 = 0;
    for (const i of idx) { somme += col.FF[i]; if (calme(i)) { nCalmes++; continue; } parS[secteur(i, ns)].push(col.FF[i]); e3 += col.FF[i] ** 3; }
    return {
      N, calmes: r2((100 * nCalmes) / N), vm_all: r2(somme / N),
      f: parS.map((l) => r2((100 * l.length) / N)),
      vm: parS.map((l) => r2(moyenne(l) ?? 0)),
      p90: parS.map((l) => r2(quantile(l, 0.9) ?? 0)),
      fxi: parS.map((l) => r1(l.length ? Math.max(...l) : 0)),
      p5: parS.map((l) => r2(l.length ? (100 * l.filter((v) => v > 5).length) / l.length : 0)),
      e: parS.map((l) => r2(e3 ? (100 * l.reduce((a, v) => a + v ** 3, 0)) / e3 : 0)),
    };
  }
  const rose = {};
  const EXC = { seuils: SEUILS };
  for (const ns of [16, 12]) {
    rose[ns] = {}; EXC[ns] = {};
    for (const s of ['annee', 'hiver', 'printemps', 'ete', 'automne']) {
      rose[ns][s] = {};
      for (const t of Object.keys(CLASSES_T)) rose[ns][s][t] = caseRose(ns, s, t);
      // dépassements : % de toutes les heures de la saison où le vent vient du secteur et atteint le seuil
      const J = Array.from({ length: ns }, () => new Array(SEUILS.length).fill(0));
      let N = 0;
      for (let i = 0; i < n; i++) {
        if (!ventOk(i) || !dansSaison(i, s)) continue;
        N++;
        if (calme(i)) continue;
        const k = secteur(i, ns);
        for (let q = 0; q < SEUILS.length && col.FF[i] >= SEUILS[q]; q++) J[k][q]++;
      }
      EXC[ns][s] = { N, J: J.map((l) => l.map((c) => r2(N ? (100 * c) / N : 0))) };
    }
  }

  // ---- jours (date locale) : minimum, maximum, moyenne ----
  const jours = new Map();
  for (let i = 0; i < n; i++) {
    if (!ok('T', i)) continue;
    let j = jours.get(loc.jour[i]);
    if (!j) jours.set(loc.jour[i], (j = { date: loc.jour[i], mois: loc.mois[i], T: [], idx: [] }));
    j.T.push(col.T[i]); j.idx.push(i);
  }
  const valides = [...jours.values()].filter((j) => j.T.length >= 20).map((j) => ({
    date: j.date, mois: j.mois, idx: j.idx, tmin: r1(Math.min(...j.T)), tmax: r1(Math.max(...j.T)), tmoy: r1(moyenne(j.T)),
  }));

  // ---- normales mensuelles ----
  const normales = { mois: [], T: [], Tmin: [], Tmax: [], FF: [], FXImax: [], U: [], GLO_MJm2j: [], f16: [], calmes: [] };
  for (let m = 0; m < 12; m++) {
    const I = [];
    for (let i = 0; i < n; i++) if (loc.mois[i] === m) I.push(i);
    const val = (k) => I.filter((i) => ok(k, i)).map((i) => col[k][i]);
    const jm = valides.filter((j) => j.mois === m);
    const ghi = val('GHI');
    const nj = new Set(I.map((i) => loc.jour[i])).size || 1;
    const vent = I.filter(ventOk);
    const f16 = new Array(16).fill(0);
    let nc = 0;
    for (const i of vent) { if (calme(i)) nc++; else f16[secteur(i, 16)]++; }
    normales.mois.push(m + 1);
    normales.T.push(r1(moyenne(val('T')) ?? NaN));
    normales.Tmin.push(r1(moyenne(jm.map((j) => j.tmin)) ?? NaN));
    normales.Tmax.push(r1(moyenne(jm.map((j) => j.tmax)) ?? NaN));
    normales.FF.push(r1(moyenne(val('FF')) ?? 0));
    normales.FXImax.push(r1(Math.max(0, ...val('FF'))));
    normales.U.push(Math.round(moyenne(val('HR')) ?? 0));
    // Wh/m² sur l'heure : somme du mois / nombre de jours, en MJ/m² par jour (complétée au prorata si valeurs manquantes)
    normales.GLO_MJm2j.push(r2(ghi.length ? ((ghi.reduce((a, b) => a + b, 0) * (I.length / ghi.length)) * 0.0036) / nj : 0));
    normales.f16.push(f16.map((c) => r2(vent.length ? (100 * c) / vent.length : 0)));
    normales.calmes.push(r2(vent.length ? (100 * nc) / vent.length : 0));
  }

  // ---- moyennes horaires par mois (meteo_horaire.json) ----
  const CH = { ta: 'T', hr: 'HR', v: 'FF', ghi: 'GHI', dni: 'DNI', dhi: 'DHI' };
  const profil = (I) => {
    const o = {};
    for (const [c, k] of Object.entries(CH)) { const l = I.filter((i) => ok(k, i)).map((i) => col[k][i]); o[c] = r1(moyenne(l) ?? 0); }
    o.n = I.length;
    return o;
  };
  const parMoisHeure = Array.from({ length: 12 }, () => Array.from({ length: 24 }, () => []));
  for (let i = 0; i < n; i++) parMoisHeure[loc.mois[i]][loc.heure[i]].push(i);
  const moyennes = parMoisHeure.map((l) => l.map((I) => profil(I)));
  // heures vides (bords du fichier) : heure voisine
  for (const l of moyennes) for (let k = 0; k < 24; k++) if (!l[k].n) l[k] = { ...(l[(k + 23) % 24].n ? l[(k + 23) % 24] : l[(k + 1) % 24]) };
  const juillet15 = parMoisHeure[6][15].filter((i) => ok('T', i)).sort((a, b) => col.T[b] - col.T[a]);
  const top = juillet15.slice(0, Math.max(1, Math.round(juillet15.length / 10)));
  const debut = `${p0}-01-01`, fin = `${p1}-12-31`;
  const horaire = {
    source: `EPW ${libelle} (${entete.source})`,
    def: 'moyennes[mois 0-11][heure locale 0-23] = {ta °C, hr %, v m/s à 10 m, ghi, dni, dhi W/m² (heure écoulée), n heures} tirées du fichier EPW',
    periode: `${debut}/${fin}`, heure: 'Europe/Paris',
    rayonnement: 'global, direct normal et diffus horizontal lus dans le fichier EPW',
    moyennes, chaudJuillet15h: { ...profil(top), n: top.length },
  };

  // ---- jours extrêmes (extremes.json) ----
  const parTmin = [...valides].sort((a, b) => a.tmin - b.tmin), parTmax = [...valides].sort((a, b) => b.tmax - a.tmax);
  const parMoy = [...valides].sort((a, b) => a.tmoy - b.tmoy);
  const sansIdx = ({ date, tmin, tmax, tmoy }) => ({ date, tmin, tmax, tmoy });
  const p10 = r1(quantile(valides.map((j) => j.tmoy), 0.1)), p90 = r1(quantile(valides.map((j) => j.tmoy), 0.9));
  const repartition = (liste) => { const o = {}; for (const j of liste) o[j.mois + 1] = (o[j.mois + 1] || 0) + 1; for (const k in o) o[k] = r1((100 * o[k]) / liste.length); return o; };
  const ordre = [...valides].sort((a, b) => a.date.localeCompare(b.date));
  // épisodes : jours consécutifs (dans l'ordre du fichier) sous le 1er décile / au-dessus du 9e
  const episodes = (test) => {
    const res = [];
    let cur = null;
    for (let q = 0; q < ordre.length; q++) {
      const j = ordre[q];
      const suite = cur && (Date.parse(j.date) - Date.parse(cur.fin) === 864e5);
      if (test(j)) { if (cur && suite) { cur.fin = j.date; cur.l.push(j.tmoy); } else { if (cur) res.push(cur); cur = { debut: j.date, fin: j.date, l: [j.tmoy] }; } } else if (cur) { res.push(cur); cur = null; }
    }
    if (cur) res.push(cur);
    return res.map((e) => ({ debut: e.debut, fin: e.fin, jours: e.l.length, tmoy: r1(moyenne(e.l)) })).sort((a, b) => b.jours - a.jours || b.tmoy - a.tmoy).slice(0, 5);
  };
  // saison la plus froide / chaude : fenêtre glissante de 31 jours (circulaire) sur l'ordre des jours de l'année
  const parJour = new Map();
  for (const j of valides) parJour.set(j.date.slice(5), j.tmoy);
  const cles = [...parJour.keys()].sort();
  const glissante = cles.map((c, q) => { const l = []; for (let d = -15; d <= 15; d++) l.push(parJour.get(cles[(q + d + cles.length) % cles.length])); return moyenne(l); });
  const saison = (cmp) => {
    let q = 0;
    glissante.forEach((v, k) => { if (cmp(v, glissante[q])) q = k; });
    const L = cles.length;
    return { debut: cles[(q - 15 + L) % L], fin: cles[(q + 15) % L], centre: cles[q], tmoy: r1(glissante[q]) };
  };
  const extremes = valides.length ? {
    source: `EPW ${libelle} (${entete.source}${nom ? `, ${nom}` : ''})`,
    periode: epw.typique ? `année type ${p0}-${p1}` : `${p0}`,
    jours_valides: valides.length,
    def: `Journée civile (Europe/Paris), au moins 20 h de données dans le fichier EPW ; Tmin, Tmax et Tmoy tirés des températures horaires (pas de minimum ni de maximum mesurés entre deux heures). Année type : chaque mois peut venir d'une année différente ; déciles et saisons calculés sur cette seule année.`,
    plus_froid: sansIdx(parTmin[0]), plus_chaud: sansIdx(parTmax[0]),
    plus_froid_moyenne: sansIdx(parMoy[0]), plus_chaud_moyenne: sansIdx(parMoy[parMoy.length - 1]),
    froids: parTmin.slice(0, 10).map(sansIdx), chauds: parTmax.slice(0, 10).map(sansIdx),
    deciles: {
      p10_tmoy: p10, p90_tmoy: p90,
      mois_froids: repartition(valides.filter((j) => j.tmoy <= p10)), mois_chauds: repartition(valides.filter((j) => j.tmoy >= p90)),
      episodes_froids: episodes((j) => j.tmoy <= p10), episodes_chauds: episodes((j) => j.tmoy >= p90),
    },
    saison_froide: saison((a, b) => a < b), saison_chaude: saison((a, b) => a > b),
  } : null;

  // ---- journées types pour l'outil Chaleur (chaleur/journees.json) ----
  const profilJour = (liste) => Array.from({ length: 24 }, (_, k) => {
    const I = liste.flatMap((j) => j.idx.filter((i) => loc.heure[i] === k));
    return I.length ? profil(I) : null;
  }).map((p, k, l) => p || l[(k + 23) % 24] || l[(k + 1) % 24] || l.find(Boolean));
  const ete = valides.filter((j) => [5, 6, 7].includes(j.mois));
  let chauds = ete.filter((j) => j.tmax >= 30);
  let libChaude = `Journée chaude type (moyenne des ${chauds.length} jours d'été à 30 °C ou plus, EPW ${entete.ville})`;
  if (chauds.length < 3) {
    chauds = [...ete].sort((a, b) => b.tmax - a.tmax).slice(0, Math.max(3, Math.round(ete.length / 10)));
    libChaude = `Journée chaude type (moyenne des ${chauds.length} jours d'été les plus chauds, EPW ${entete.ville})`;
  }
  const rec = parTmax[0];
  const journees = rec ? { source: horaire.source, profils: {
    ...(chauds.length ? { chaude: { libelle: libChaude, date: '06-21', n: chauds.length, heures: profilJour(chauds) } } : {}),
    record: { libelle: `Jour le plus chaud du fichier EPW (${rec.date.split('-').reverse().join('/')}, ${String(rec.tmax).replace('.', ',')} °C)`, date: rec.date.slice(5), jourMesure: rec.date, heures: profilJour([rec]) },
  } } : null;

  // ---- couverture (% de valeurs valides) ----
  const pc = (k) => r1(100 - (100 * (epw.controles.manquants[k] || 0)) / n);
  const couverture = { FF: pc('FF'), DD: pc('DD'), T: pc('T'), U: pc('HR'), GLO: pc('GHI') };
  let heuresVent = 0;
  for (let i = 0; i < n; i++) if (ventOk(i)) heuresVent++;

  const donnees = {
    source: { epw: `${entete.source}, ${nom || libelle}` },
    licence: { epw: /onebuilding/i.test(epw.commentaires.join(' ')) ? 'Climate.OneBuilding.org (usage libre, citer la source)' : 'licence du fichier EPW à vérifier' },
    station: { id: entete.wmo, nom: entete.ville, lat: entete.lat, lon: entete.lon, alt: entete.altitude, wmo: entete.wmo },
    periode: { stats: `${debut}/${fin}`, heures_vent_valides: heuresVent },
    unites: { FF: 'm/s (vent horaire à 10 m, fichier EPW)', FXI: 'm/s : vent horaire maximal (l\'EPW ne donne pas les rafales)', T: '°C', heure: 'Europe/Paris' },
    classes_T: CLASSES_T, rose, normales, EXC,
  };
  return { donnees, horaire, extremes, journees, couverture, libelle, periode: [p0, p1] };
}
