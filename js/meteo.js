import { chargerJSON } from './donnees.js';

// Source météo unique de l'atlas : data/meteo/meteo.json (outils/meteo/analyse.py), complété par
// data/meteo/meteo_horaire.json (outils/meteo/horaire.py), tous deux tirés des mesures horaires de Météo-France
// à Nantes-Bouguenais (station 44020001). Lus une seule fois (promesse gardée) et utilisés par les outils
// Climat, Vent, Confort et Export.
//
// Contenu utile de meteo.json :
// - rose[16|12][saison][temperature] = { N, calmes, f[], vm[], p90[], fxi[], p5[], e[], vm_all } ou null ;
//   f = % de toutes les heures (calmes inclus), e = part de ΣFF³, p5 = % des heures du secteur au-dessus de 5 m/s ;
// - normales : T, Tmin, Tmax, FF, FXImax, U, GLO_MJm2j, f16, calmes par mois ;
// - EXC[16|12][saison] = { N, J[secteur][seuil] } : % de toutes les heures où le vent vient du secteur et
//   atteint le seuil (EXC.seuils, 0 à 12 m/s par 0,5) ;
// - meteo_horaire.json > moyennes[mois][heure locale] : météo moyenne pour le rayonnement et le confort.
// - meteo_annees.json (outils/meteo/annees.py) > annees[AAAA] = { heures_vent_valides, couverture_pct, rose12[saison]
//   (toutes températures), normales, extremes } : année choisie par definirAnnee(a) (null = moyenne 2016-2025) ;
//   rose(12, …), normales() et extremesAnnee() suivent l'année ; rose 16 secteurs, dépassements (confort au vent)
//   et exports restent sur la moyenne de la période.

export const FICHIER = 'data/meteo/meteo.json';
export const FICHIER_HORAIRE = 'data/meteo/meteo_horaire.json';
export const FICHIER_ANNEES = 'data/meteo/meteo_annees.json';
export const HEURES_MIN = 100; // en dessous, une case (saison × température) est peu représentative
export const SAISONS = [['annee', 'Année'], ['hiver', 'Hiver (déc. à fév.)'], ['printemps', 'Printemps (mars à mai)'], ['ete', 'Été (juin à août)'], ['automne', 'Automne (sept. à nov.)']];
export const TEMPERATURES = [['all', 'Toutes températures'], ['froid', 'Moins de 5 °C'], ['frais', '5 à 12 °C'], ['doux', '12 à 20 °C'], ['chaud', '20 °C et plus']];
export const NOMS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
export const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

const nombre = (v, d = 1) => (v == null ? '–' : v.toFixed(d).replace('.', ','));
const dateFr = (iso) => iso.split('-').reverse().join('/');

let promesse = null;
let donnees = null;
let donneesHoraires = null;
let donneesAnnees = null;
let anneeActive = null;

// Lecture (une fois) ; renvoie null si meteo.json manque.
export function chargerMeteo() {
  promesse ??= Promise.all([chargerJSON(FICHIER, null), chargerJSON(FICHIER_HORAIRE, null), chargerJSON(FICHIER_ANNEES, null)]).then(([d, hor, ans]) => {
    donneesHoraires = hor?.moyennes ? hor : null;
    donneesAnnees = ans?.annees ? ans : null;
    return (donnees = d?.rose && d?.normales ? d : null);
  });
  return promesse;
}
export const meteo = () => donnees;

// Année choisie (sélecteur « Moyenne 2016-2025 / année » de Climat et Vent) : null = moyenne de la période
export const annees = () => Object.keys(donneesAnnees?.annees ?? {}).sort();
export const annee = () => anneeActive;
export function definirAnnee(a) {
  anneeActive = a != null && donneesAnnees?.annees?.[String(a)] ? String(a) : null;
  return anneeActive;
}
const donneesAnnee = () => (anneeActive ? donneesAnnees.annees[anneeActive] : null);
export const extremesAnnee = () => donneesAnnee()?.extremes ?? null;
export function libellePeriode() {
  if (anneeActive) return `année ${anneeActive}`;
  const p = donnees?.periode?.stats?.split('/').map((x) => x.slice(0, 4)) ?? [];
  return p.length ? `moyenne ${p[0]}-${p[1]}` : 'moyenne';
}

// Nom d'un secteur : 16 secteurs nommés, 12 secteurs de 30° désignés par leur direction centrale
export const nomSecteur = (n, k) => (n === 16 ? NOMS16[k] : `${k * 30}°`);
export const directionSecteur = (n, k) => k * (360 / n);
export const libelleSaison = (s) => SAISONS.find(([v]) => v === s)?.[1] ?? s;
export const libelleTemperature = (t) => TEMPERATURES.find(([v]) => v === t)?.[1] ?? t;

// Rose d'une case saison × température : secteurs développés en objets
export function rose(n = 16, saison = 'annee', temperature = 'all') {
  // année choisie : rose de l'année en 12 secteurs, toutes températures (tranches trop maigres sur un an)
  const da = n === 12 ? donneesAnnee() : null;
  const r = da ? da.rose12?.[saison] : donnees?.rose?.[String(n)]?.[saison]?.[temperature];
  if (!r) return { N: 0, peuRepresentatif: true, secteurs: [] };
  return {
    N: r.N, calmes: r.calmes, vm: r.vm_all, peuRepresentatif: r.N < HEURES_MIN, annee: da ? anneeActive : null, temperatureIgnoree: !!da && temperature !== 'all',
    secteurs: r.f.map((f, k) => ({ k, dir: directionSecteur(n, k), label: nomSecteur(n, k), f, e: r.e[k], vm: r.vm[k], p90: r.p90[k], fxi: r.fxi[k], p5: r.p5[k] })),
  };
}

export const normales = () => donneesAnnee()?.normales ?? donnees?.normales ?? null;
export const horaire = () => donneesHoraires;

// Dépassements bruts : { N, J[secteur][seuil] } en % de toutes les heures, seuils EXC.seuils
export function depassements(n = 12, saison = 'annee') {
  const e = donnees?.EXC?.[String(n)]?.[saison];
  return e ? { N: e.N, J: e.J, seuils: donnees.EXC.seuils } : null;
}

// Même chose rééchantillonnée pour js/vent-calcul.js : J[secteur][v] = part du temps (0 à 1) où le vent vient
// du secteur et atteint v m/s, v entier de 0 à 24 (au-delà de 12 m/s, valeur nulle : quelques centièmes de % au plus).
export function depassementsParMetre(n = 12, saison = 'annee') {
  const e = depassements(n, saison);
  if (!e) return null;
  const pas = e.seuils[1] - e.seuils[0];
  return {
    N: e.N,
    J: e.J.map((l) => Array.from({ length: 25 }, (_, v) => { const i = Math.round(v / pas); return i < l.length ? l[i] / 100 : 0; })),
  };
}

// Part du temps (%) où le vent atteint un seuil, tous secteurs confondus
export function partAuDessus(seuil, saison = 'annee') {
  const e = depassements(16, saison);
  if (!e) return null;
  const i = e.seuils.findIndex((s) => s >= seuil);
  return i < 0 ? 0 : e.J.reduce((a, l) => a + l[i], 0);
}

// Couverture des mesures sur la période des statistiques (minimum par variable et par an)
export function couverture() {
  const c = donnees?.couverture;
  if (!c) return null;
  const [a0, a1] = (donnees.periode?.stats ?? '').split('/').map((x) => +x.slice(0, 4));
  const ans = Object.entries(c).filter(([a]) => +a >= a0 && +a <= a1).map(([, v]) => v);
  const min = (k) => Math.min(...ans.map((v) => v[k] ?? 100));
  return { vent: Math.min(min('FF'), min('DD')), temperature: min('T'), rayonnement: min('GLO') };
}

// Mention de source, période et couverture, à afficher sous chaque résultat
// annee: true : mention de l'année choisie (Climat, Vent) ; sinon toujours la période (exports, Confort)
export function mention({ court = false, annee: avecAnnee = false } = {}) {
  const d = donnees;
  if (!d) return 'Météo indisponible : data/meteo/meteo.json manque.';
  const [p0, p1] = d.periode.stats.split('/');
  const c = couverture();
  const station = `Météo-France, station ${d.station.id} ${d.station.nom.replace('NANTES-BOUGUENAIS', 'Nantes-Bouguenais')}`;
  const da = avecAnnee ? donneesAnnee() : null;
  if (da) {
    const cv = da.couverture_pct || {};
    const t = `${station}, mesures horaires de l'année ${anneeActive} seule (du 01/01/${anneeActive} au 31/12/${anneeActive})`;
    return court ? `${t} (${d.licence.mf}).` : `${t} : ${da.heures_vent_valides.toLocaleString('fr-FR')} heures de vent valides, couverture ${nombre(Math.min(cv.FF ?? 100, cv.DD ?? 100))} % (vent), ${nombre(cv.T ?? 100)} % (température). Une seule année : écarts normaux d'une année à l'autre, à comparer à la moyenne ${dateFr(p0).slice(-4)}-${dateFr(p1).slice(-4)}. Vent moyen sur 10 min à 10 m, terrain dégagé de l'aéroport, à 9 km du site. ${d.licence.mf}.`;
  }
  const base = `${station}, mesures horaires du ${dateFr(p0)} au ${dateFr(p1)}`;
  if (court) return `${base} (${d.licence.mf}).`;
  return `${base} : ${d.periode.heures_vent_valides.toLocaleString('fr-FR')} heures de vent valides, couverture ${nombre(c.vent)} % (vent), ${nombre(c.temperature)} % (température) au moins chaque année. Vent moyen sur 10 min à 10 m, terrain dégagé de l'aéroport, à 9 km du site. ${d.licence.mf}.`;
}

// Avertissement pour une case peu représentative
export function avertissement(N, quoi = 'cette case') {
  if (N == null || N === 0) return `Aucune mesure pour ${quoi}.`;
  return N < HEURES_MIN ? `Attention : ${quoi} ne compte que ${N.toLocaleString('fr-FR')} h de mesures (moins de ${HEURES_MIN}) : résultat peu représentatif.` : null;
}

// Cases saison × température peu représentatives (pour les notes et les exports)
export function casesPeuRepresentatives() {
  const r = donnees?.rose?.['16'] ?? {};
  const liste = [];
  for (const [s, ts] of Object.entries(r)) for (const [t, v] of Object.entries(ts)) if (!v || v.N < HEURES_MIN) liste.push({ saison: s, temperature: t, N: v?.N ?? 0 });
  return liste;
}

// ------------------------------------------------------------------
// Exports CSV (séparateur « ; », virgule décimale, pour Excel en français)
// ------------------------------------------------------------------
const cellule = (v) => (v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : /[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
const lignesCSV = (entete, lignes) => [entete, ...lignes].map((l) => l.map(cellule).join(';')).join('\r\n');
const enTete = () => `# ${mention({ court: true })}`;

export function csvRose(n = 16) {
  const lignes = [];
  for (const [s] of SAISONS) for (const [t] of TEMPERATURES) {
    const r = donnees.rose[String(n)][s][t];
    if (!r) { lignes.push([s, t, 0, '', '', '', '', '', '', '', '', '', 'aucune mesure']); continue; }
    r.f.forEach((f, k) => lignes.push([s, t, r.N, r.calmes, nomSecteur(n, k), directionSecteur(n, k), f, r.e[k], r.vm[k], r.p90[k], r.fxi[k], r.p5[k],
      r.N < HEURES_MIN ? 'peu représentatif' : '']));
  }
  return `﻿${enTete()}\r\n${lignesCSV(['saison', 'temperature', 'heures', 'calmes_pct', 'secteur', 'direction_deg', 'frequence_pct', 'energie_pct', 'vent_moyen_ms', 'vent_p90_ms', 'rafale_max_ms', 'part_sup_5ms_pct', 'remarque'], lignes)}\r\n`;
}

export function csvNormales() {
  const n = donnees.normales;
  const lignes = n.mois.map((m, i) => [m, MOIS[i], n.T[i], n.Tmin[i], n.Tmax[i], n.FF[i], n.FXImax[i], n.U[i], n.GLO_MJm2j[i], n.calmes[i], ...n.f16[i]]);
  return `﻿${enTete()}\r\n${lignesCSV(['mois', 'nom', 'T_moy_C', 'Tmin_moy_C', 'Tmax_moy_C', 'vent_moyen_ms', 'rafale_max_ms', 'humidite_pct', 'rayonnement_MJm2j', 'calmes_pct', ...NOMS16.map((x) => `freq_${x}_pct`)], lignes)}\r\n`;
}

export function csvDepassements(n = 16) {
  const seuils = donnees.EXC.seuils;
  const lignes = [];
  for (const [s] of SAISONS) {
    const e = donnees.EXC[String(n)][s];
    e.J.forEach((l, k) => lignes.push([s, e.N, nomSecteur(n, k), directionSecteur(n, k), ...l]));
  }
  return `﻿${enTete()}\r\n# % de toutes les heures de la saison (calmes inclus) où le vent vient du secteur et atteint le seuil (m/s)\r\n${lignesCSV(['saison', 'heures', 'secteur', 'direction_deg', ...seuils.map((x) => `sup_${String(x).replace('.', '_')}ms`)], lignes)}\r\n`;
}
