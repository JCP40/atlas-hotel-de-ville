// Export des statistiques du climat en classeur Excel (11/11/2026) : calcul PUR (ni DOM, ni Three.js), testable sous Node 18+.
// Ne recalcule rien : il met en feuilles les objets déjà calculés et affichés par js/climat-stats-bloc.js (mêmes fonctions de calcul :
// statistiquesClimat → S, statistiquesTranches → R, analyser de meteo-extremes.js → X), pour la période, la source, les seuils et les
// bornes choisis par l'utilisateur. Seuls les tableaux « une ligne par jour » et « une ligne par heure » relisent les colonnes horaires H.
//
// contexte (ctx) : { portee: 'tout' | 'extremes', E: { H, annee, periode, epw, typique, cle }, S, R (tranches, ou null), X (analyse des conditions
//   extrêmes, ou null), info: source() de js/meteo.js, mentionLongue, mentionCourte, version (« v8 »), date (Date) }
// classeur(ctx, { horaires, progression }) → Promise<Uint8Array> ; nomFichier(ctx, 'xlsx'|'pdf') ; estimation(ctx, { horaires }).
import { CATEGORIES, LIBELLES_SEUILS, COMPTEURS, HUMIDE, SEC, PLUIE, UTCI_CHAUD_FORT, UTCI_FROID_MODERE, UTCI_FROID_FORT, PIETON, GRANDEURS, indiceTranche } from './climat-stats.js';
import { NOMS12, CONDITIONS, CALME, HEURES_MIN, CANICULE, roseHeures } from './meteo-extremes.js';
import { classeurXLSX } from './xlsx.js';

export const VERSION_EXPORT = '2026-11-11';
const ok = Number.isFinite;
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const v1 = (x) => String(x).replace('.', ',').replace('-', '−');
const dateFr = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const isoLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const serieJourIso = (iso) => { const [a, m, j] = iso.split('-').map(Number); return Date.UTC(a, m - 1, j) / 86400000 + 25569; };
const num = (v) => (v == null || !ok(v) ? null : v);
const r2 = (v) => (v == null || !ok(v) ? null : Math.round(v * 100) / 100);
const parAnDe = (ctx) => (ctx.S?.typique ? 1 : ctx.S?.nAnnees ?? 1);

// ------------------------------------------------------------------ noms de fichiers
const slug = (s) => String(s).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^0-9a-z]+/g, '-').replace(/^-+|-+$/g, '');
export function slugSource(ctx) {
  const t = ctx.info?.type;
  return t === 'base' || !t ? 'meteofrance' : t === 'epw-nantes' ? 'epw-nantes' : 'epw-perso';
}
export function slugPeriode(ctx) {
  const p = String(ctx.E?.periode ?? '');
  const m = /(\d{4})-(\d{4})/.exec(p);
  if (/type/i.test(p)) return slug(p);
  if (/^ann/i.test(p)) return (/\d{4}/.exec(p) || [slug(p)])[0];
  return m ? `${m[1]}-${m[2]}` : slug(p);
}
export function nomFichier(ctx, ext) {
  return `atlas-climat-${slugSource(ctx)}-${slugPeriode(ctx)}${ctx.portee === 'extremes' ? '-extremes' : ''}-${isoLocal(ctx.date ?? new Date())}.${ext}`;
}

// ------------------------------------------------------------------ estimation de la taille et de la durée
// constantes mesurées (scripts/mesures.mjs, Chromium) : octets d'un classeur sans les heures ; octets compressés par ligne horaire
export const OCTETS_BASE = 40000, OCTETS_PAR_HEURE = 69, OCTETS_PAR_JOUR = 145, HEURES_PAR_SECONDE = 45000;
export function nombreHeures(ctx) {
  const { H, annee } = ctx.E;
  if (annee == null) return H.n;
  let n = 0; for (let i = 0; i < H.n; i++) if (H.annee[i] === annee) n++;
  return n;
}
export function estimation(ctx, { horaires = false } = {}) {
  const jours = ctx.S?.journees?.length ?? (ctx.E.annee != null || ctx.E.typique ? 365 : 3653);
  const nh = horaires ? nombreHeures(ctx) : 0;
  return { octets: (ctx.portee === 'extremes' ? 25000 : OCTETS_BASE + OCTETS_PAR_JOUR * jours) + nh * OCTETS_PAR_HEURE, heures: nh, secondes: Math.max(1, Math.round(((ctx.portee === 'extremes' ? 0 : jours * 12) + nh) / HEURES_PAR_SECONDE + 1)) };
}

// ------------------------------------------------------------------ feuille LISEZ-MOI
function lisezMoi(ctx, { horaires }) {
  const { S, R, E, info, X } = ctx;
  const L = [];
  const l = (a, b = '') => L.push([a, b]);
  const sec = (t) => { L.push(['', '']); L.push([t, '']); };
  l('Atlas du site de l\'Hôtel de Ville de Nantes', 'Statistiques du climat — export de données');
  l('Version de l\'atlas', ctx.version ?? 'v8');
  l('Modules de calcul', `climat-stats.js ${S?.version ?? ''} ; export ${VERSION_EXPORT}`);
  l('Date de l\'export', `${dateFr(ctx.date ?? new Date())} ${String((ctx.date ?? new Date()).getHours()).padStart(2, '0')}:${String((ctx.date ?? new Date()).getMinutes()).padStart(2, '0')} (heure du navigateur)`);
  l('Contenu', ctx.portee === 'extremes' ? 'Conditions extrêmes et vent (feuilles Extrêmes, Extrêmes - vent, Épisodes, Records).' : `Catégories de jours, tranches de température, seuils, vent, humidité, UTCI, conditions extrêmes${horaires ? ', données horaires' : ''}.`);
  sec('Source des données');
  l('Source météo active', info?.libelle ?? '');
  l('Type de source', info?.type === 'base' || !info?.type ? 'Météo de base : mesures horaires Météo-France (station 44020001 Nantes-Bouguenais, Licence Ouverte Etalab 2.0)' : `Fichier EPW (${info.nom ?? ''}) : année type ou année unique, pas de moyenne pluriannuelle`);
  l('Période', E.periode);
  l('Année choisie', E.annee != null ? String(E.annee) : (ctx.E.typique ? 'année type (EPW)' : 'aucune (moyenne de toute la période)'));
  l('Heures de mesure', E.H.n.toLocaleString('fr-FR'));
  if (S) l('Journées valides', `${S.joursValides.toLocaleString('fr-FR')} (au moins 20 heures de température)`);
  l('Mention', ctx.mentionLongue ?? '');
  for (const a of info?.avertissements ?? []) l('Avertissement de la source', a);
  sec('Conventions');
  l('Jour civil', 'Europe/Paris (heure d\'été comprise) : une journée va de 0 h à 24 h, heure légale de Paris. Les horodatages de la feuille Heures sont en heure de Paris.');
  l('Journée valide', 'Au moins 20 heures de température mesurées. Les heures des journées incomplètes ne sont dans aucune catégorie de jours (elles sont comptées dans les compteurs horaires). La feuille Jours garde ces journées (colonne « Journée valide » = non, sans catégorie ni tranche) : par exemple les quelques heures qui débordent aux jonctions de mois d\'une année type EPW.');
  l('Tmin, Tmax, Tmoy', 'Tmin = minimum des TN horaires (sinon de T) ; Tmax = maximum des TX horaires (sinon de T) ; Tmoy = moyenne des températures horaires du jour.');
  l('Vent', `Vent moyen sur 10 min à 10 m, direction d'où vient le vent (degrés, 0 = nord, sens horaire), 12 secteurs de 30° centrés sur N (0°), NNE (30°)… Calme : vent < ${v1(CALME)} m/s (sans direction). Mesuré sur le terrain dégagé de l'aéroport (à 9 km du site) : en ville, plus faible et dévié par le bâti.`);
  l('Unités', 'Températures en °C, humidité relative en %, vent en m/s, rayonnement global en W/m² (moyenne de l\'heure), pluie en mm, UTCI en °C. Les pourcentages sont des fractions affichées en % (0,5 = 50 %).');
  if (S) {
    sec('Catégories de jours (exclusives, testées dans cet ordre : canicule, chaud, très froid, froid, tempéré)');
    for (const c of CATEGORIES) l(c.libelle, S.definitions[c.id]);
    sec('Seuils utilisés (réglés par l\'utilisateur)');
    for (const [k, t] of Object.entries(LIBELLES_SEUILS)) l(t, `${v1(S.seuils[k])} °C`);
    l('Compteurs non exclusifs', COMPTEURS.map((c) => c.libelle).join(' ; ') + ' : heures sur la température horaire, jours sur Tmin (seuils bas) ou Tmax (seuils hauts).');
    l('Humidité', `Journée très humide : HR moyenne du jour ≥ ${HUMIDE} % ; sèche : < ${SEC} % (au moins 20 h d'humidité). Jour de pluie : cumul RR1 ≥ ${PLUIE} mm (au moins 20 h de pluie ; absente d'un fichier EPW).`);
    l('UTCI', `UTCI d'un piéton debout en site dégagé (ni bâti ni arbre), au soleil et à l'ombre, heure par heure (polynôme UTCI_approx, Bröde et al. 2012 ; Tmrt par facteurs d'angle, αk ${v1(PIETON.ak)}, εp ${v1(PIETON.ep)}, albédo du sol ${v1(PIETON.albedoSol)}). Stress de chaleur fort ou plus : UTCI ≥ ${UTCI_CHAUD_FORT} °C ; froid modéré ou plus : < ${UTCI_FROID_MODERE} °C ; fort : < ${UTCI_FROID_FORT} °C. Estimation pédagogique, UTCI à ±3 à 5 °C près ; rayonnement ${E.epw ? 'DNI et DHI du fichier EPW' : 'global mesuré, direct et diffus estimés (Erbs et al. 1982)'}.`);
  }
  if (R) {
    sec('Tranches de température');
    l('Bornes (°C)', `${R.bornes.map(v1).join(' | ')} — borne inférieure INCLUSE, supérieure EXCLUE (15 °C compte dans « 15 à 25 », pas dans « 5 à 15 »).`);
    l('Heures', 'Température horaire de chaque heure mesurée.');
    l('Jours', `Journées valides classées par une seule grandeur : ${GRANDEURS[R.grandeur]} ; un jour compte dans une seule tranche. « Jours touchés » : au moins une heure dans la tranche (non exclusif).`);
  }
  if (X) {
    sec('Conditions extrêmes');
    for (const c of CONDITIONS) l(c.libelle, c.def);
    l('Canicule', `Seuils de vigilance Météo-France pour la ${CANICULE.departement} appliqués aux mesures de l'aéroport (ce n'est pas la liste officielle des alertes).`);
  }
  sec('Limites');
  l('Nature des résultats', 'Statistique observée sur les mesures passées, pas une prévision. Estimation pédagogique pour l\'UTCI et le rayonnement. Le vent est celui de l\'aéroport.');
  l('Échantillon faible', `Moins de ${HEURES_MIN} heures de vent dans un groupe : résultat peu représentatif (colonne « Échantillon faible »).`);
  if (E.epw) l('Fichier EPW', 'Pas de rafales (la « rafale maximale » est le vent horaire le plus fort) ni de pluie ; année type : les mois peuvent venir d\'années différentes (colonne Année = année d\'origine du mois).');
  sec('Feuilles');
  const noms = {
    Jours: 'une ligne par journée civile : températures, humidité, vent, catégorie, tranche, canicule, UTCI',
    Heures: 'une ligne par heure (option « Inclure les données horaires »)',
    'Catégories': 'jours, %, heures, jours par an et par année pour chaque catégorie',
    Tranches: 'heures et jours par tranche de température', 'Tranches par année': 'idem, année par année', 'Tranches par mois': 'idem, mois par mois (moyenne annuelle)',
    Seuils: 'compteurs non exclusifs (heures et jours sous / au-dessus de seuils)',
    'Vent par catégorie': '12 directions : heures, %, vitesse moyenne ; calme ; dominante', 'Vent par tranche': 'idem par tranche de température',
    'Extrêmes': 'conditions extrêmes : heures, jours, vent dominant', 'Extrêmes - vent': 'rose à 12 secteurs de chaque condition', 'Épisodes': 'épisodes (dates) de chaque condition', Records: 'records de température avec leur vent',
    'Humidité': 'HR moyenne, jours très humides, secs, de pluie', UTCI: 'heures et jours par classe de stress thermique, au soleil et à l\'ombre', 'UTCI par tranche': 'UTCI moyen et classe dominante par tranche',
  };
  for (const [n, t] of Object.entries(noms)) l(n, t);
  return { nom: 'LISEZ-MOI', colonnes: [{ titre: 'Rubrique', largeur: 34, format: 'long' }, { titre: 'Contenu', largeur: 110, format: 'long' }], lignes: L, filtre: false };
}

// ------------------------------------------------------------------ feuille Jours (une ligne par journée)
function feuilleJours(ctx) {
  const { S, R, E } = ctx;
  const H = E.H, J = S.journees;
  const rafales = !!H.rafales, aPluie = S.aPluie, aHR = S.aHR;
  const cols = [
    { titre: 'Date', format: 'date', largeur: 12 }, { titre: 'Année', format: 'brut', largeur: 7 }, { titre: 'Mois', format: 'brut', largeur: 6 },
    { titre: 'Tmin (°C)', format: 'd1', largeur: 10 }, { titre: 'Tmax (°C)', format: 'd1', largeur: 10 }, { titre: 'Tmoy (°C)', format: 'd1', largeur: 10 },
    ...(aHR ? [{ titre: 'HR moyenne (%)', format: 'd1', largeur: 14 }] : []),
    { titre: 'Vent moyen (m/s)', format: 'd1', largeur: 16 }, { titre: 'Vent max horaire (m/s)', format: 'd1', largeur: 20 },
    ...(rafales ? [{ titre: 'Rafale max (m/s)', format: 'd1', largeur: 16 }] : []),
    { titre: 'Direction dominante', largeur: 18 }, { titre: 'Direction moyenne du secteur dominant (°)', format: 'brut', largeur: 24 },
    { titre: 'Heures de mesure', format: 'brut', largeur: 14 }, { titre: 'Journée valide (≥ 20 h)', largeur: 16 },
    { titre: 'Catégorie de jour', largeur: 16 }, { titre: `Tranche (${R ? GRANDEURS[R.grandeur].split(' ')[0] : 'Tmoy'} du jour)`, largeur: 18 }, { titre: 'Canicule', largeur: 10 },
    ...(aHR ? [{ titre: 'Humidité du jour', largeur: 16 }] : []),
    ...(aPluie ? [{ titre: 'Pluie du jour (mm)', format: 'd1', largeur: 16 }, { titre: 'Jour de pluie', largeur: 12 }] : []),
    ...(S.utci ? [{ titre: 'UTCI max soleil (°C)', format: 'd1', largeur: 18 }, { titre: 'UTCI max ombre (°C)', format: 'd1', largeur: 18 }, { titre: 'UTCI min soleil (°C)', format: 'd1', largeur: 18 }, { titre: 'UTCI min ombre (°C)', format: 'd1', largeur: 18 }] : []),
  ];
  const cat = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.libelle]));
  const ligne = (k) => {
    const d = J[k];
    let somme = 0, n = 0, vmax = -Infinity, fmax = -Infinity;
    for (const i of d.idx) { const ff = H.FF[i]; if (ok(ff)) { somme += ff; n++; if (ff > vmax) vmax = ff; } if (rafales && ok(H.FXI[i]) && H.FXI[i] > fmax) fmax = H.FXI[i]; }
    const r = roseHeures(H, d.idx);
    const valide = d.n >= 20;
    const tr = valide && R ? R.tranches[R.trancheJour.get(d.k)]?.libelle ?? null : null;
    const hr = d.nU ? d.sU / d.nU : null;
    return [
      d.k + 25569, d.annee, d.mois + 1, d.tmin, d.tmax, d.tmoy,
      ...(aHR ? [hr] : []),
      n ? somme / n : null, n ? vmax : null,
      ...(rafales ? [fmax > -Infinity ? fmax : null] : []),
      r.dominant?.nom ?? (n ? 'calme' : null), r.dominant?.degMoyen ?? null,
      d.n, valide, valide ? cat[d.cat] : null, tr, valide ? d.cat === 'canicule' : null,
      ...(aHR ? [d.nU >= 20 ? (hr >= HUMIDE ? 'très humide' : hr < SEC ? 'sèche' : 'normale') : null] : []),
      ...(aPluie ? [d.nRR >= 20 ? d.sRR : null, d.nRR >= 20 ? d.sRR >= PLUIE : null] : []),
      ...(S.utci ? [d.utci?.mxS ?? null, d.utci?.mxO ?? null, d.utci?.mnS ?? null, d.utci?.mnO ?? null] : []),
    ];
  };
  return { nom: 'Jours', colonnes: cols, lignes: { n: J.length, ligne } };
}

// ------------------------------------------------------------------ feuille Heures (une ligne par heure)
function feuilleHeures(ctx) {
  const { S, R, E } = ctx;
  const H = E.H, U = S.utci?.horaire ?? null;
  const rafales = !!H.rafales, aPluie = S.aPluie, epw = H.source === 'epw';
  const idx = [];
  for (let i = 0; i < H.n; i++) if (E.annee == null || H.annee[i] === E.annee) idx.push(i);
  const jour = new Map(S.journees.map((d) => [d.k, d]));
  const cat = Object.fromEntries(CATEGORIES.map((c) => [c.id, c.libelle]));
  const cols = [
    { titre: 'Horodatage (heure de Paris)', format: 'dateheure', largeur: 22 }, { titre: 'Année', format: 'brut', largeur: 7 }, { titre: 'Mois', format: 'brut', largeur: 6 }, { titre: 'Heure', format: 'brut', largeur: 7 },
    { titre: 'T (°C)', format: 'd1', largeur: 8 }, ...(S.aHR ? [{ titre: 'HR (%)', format: 'brut', largeur: 8 }] : []),
    { titre: 'Vent moyen (m/s)', format: 'd1', largeur: 16 }, { titre: 'Direction (°)', format: 'brut', largeur: 12 },
    ...(rafales ? [{ titre: 'Rafale (m/s)', format: 'd1', largeur: 12 }] : []), ...(aPluie ? [{ titre: 'Pluie (mm)', format: 'd1', largeur: 11 }] : []),
    { titre: 'Rayonnement global (W/m²)', format: 'entier', largeur: 24 }, ...(epw ? [{ titre: 'DNI (W/m²)', format: 'entier', largeur: 11 }, { titre: 'DHI (W/m²)', format: 'entier', largeur: 11 }] : []),
    ...(U ? [{ titre: 'UTCI soleil (°C)', format: 'd1', largeur: 16 }, { titre: 'UTCI ombre (°C)', format: 'd1', largeur: 16 }, { titre: 'Soleil levé', largeur: 11 }] : []),
    { titre: 'Catégorie du jour', largeur: 16 }, { titre: 'Tranche de l\'heure (T)', largeur: 20 },
  ];
  const ligne = (k) => {
    const i = idx[k], t = H.T[i], d = jour.get(H.jour[i]);
    const tr = R && ok(t) ? R.tranches[indiceTranche(t, R.bornes)]?.libelle : null;
    return [
      H.loc[i] / 86400000 + 25569, H.annee[i], H.mois[i] + 1, H.heure[i],
      num(t), ...(S.aHR ? [num(H.U[i])] : []), num(H.FF[i]), num(H.DD[i]),
      ...(rafales ? [num(H.FXI[i])] : []), ...(aPluie ? [num(H.RR1[i])] : []),
      ok(H.GLO[i]) ? Math.round(H.GLO[i]) : null, ...(epw ? [ok(H.DNI[i]) ? Math.round(H.DNI[i]) : null, ok(H.DHI[i]) ? Math.round(H.DHI[i]) : null] : []),
      ...(U ? [ok(U.uS[i]) ? r2(U.uS[i]) : null, ok(U.uO[i]) ? r2(U.uO[i]) : null, ok(U.uS[i]) ? !!U.deJour[i] : null] : []),
      d && d.n >= 20 ? cat[d.cat] : null, tr ?? null,
    ];
  };
  return { nom: 'Heures', colonnes: cols, lignes: { n: idx.length, ligne } };
}

// ------------------------------------------------------------------ feuilles de synthèse
function feuilleCategories(ctx) {
  const { S } = ctx, k = parAnDe(ctx);
  const A = S.typique ? [] : S.annees;
  const cols = [{ titre: 'Catégorie', largeur: 14 }, { titre: 'Définition', largeur: 60, format: 'long' }, { titre: 'Jours', format: 'entier', largeur: 8 }, { titre: '% des jours', format: 'pct', largeur: 11 }, { titre: 'Heures', format: 'entier', largeur: 9 },
    { titre: S.typique ? 'Jours (année type)' : 'Jours par an', format: 'd1', largeur: 14 }, ...A.map((a) => ({ titre: `Jours ${a}`, format: 'entier', largeur: 10 }))];
  const L = S.categories.map((c) => [c.libelle, S.definitions[c.id], c.jours, c.pct / 100, c.heures, c.parAn, ...A.map((a) => c.parAnnee[a] || 0)]);
  L.push(['Total', 'toutes les journées valides', S.joursValides, 1, S.categories.reduce((a, c) => a + c.heures, 0), S.joursValides / k, ...A.map((a) => S.joursValidesParAnnee[a] || 0)]);
  return { nom: 'Catégories', colonnes: cols, lignes: L, filtre: false };
}
function feuilleSeuils(ctx) {
  const { S } = ctx;
  return { nom: 'Seuils', filtre: false, colonnes: [{ titre: 'Seuil', largeur: 14 }, { titre: 'Heures', format: 'entier', largeur: 9 }, { titre: '% des heures', format: 'pct', largeur: 12 }, { titre: 'Heures par an', format: 'entier', largeur: 13 }, { titre: 'Jours', format: 'entier', largeur: 8 }, { titre: '% des jours', format: 'pct', largeur: 11 }, { titre: 'Jours par an', format: 'd1', largeur: 12 }],
    lignes: S.compteurs.map((c) => [c.libelle, c.heures, c.pctHeures / 100, c.heuresParAn, c.jours, c.pctJours / 100, c.joursParAn]) };
}
function feuillesTranches(ctx) {
  const { R } = ctx, T = R.tranches, k = R.nAnnees, g = R.grandeur;
  const A = R.typique ? [] : R.annees;
  const L = T.map((t) => [t.libelle, num(ok(t.min) ? t.min : null), num(ok(t.max) ? t.max : null), t.heures, t.pctHeures / 100, t.heuresParAn, t.jours, t.pctJours / 100, t.joursParAn, t.touches, t.pctTouches / 100, t.touchesParAn, num(t.hrMoy)]);
  L.push(['Total', null, null, R.heuresT, 1, R.heuresT / k, R.joursValides, 1, R.joursValides / k, null, null, null, null]);
  const resume = { nom: 'Tranches', filtre: false, lignes: L, colonnes: [{ titre: 'Tranche', largeur: 14 }, { titre: 'Min inclus (°C)', format: 'd1', largeur: 14 }, { titre: 'Max exclu (°C)', format: 'd1', largeur: 14 }, { titre: 'Heures', format: 'entier', largeur: 9 }, { titre: '% des heures', format: 'pct', largeur: 12 }, { titre: R.typique ? 'Heures (année type)' : 'Heures par an', format: 'entier', largeur: 14 },
    { titre: `Jours (${g})`, format: 'entier', largeur: 11 }, { titre: '% des jours', format: 'pct', largeur: 11 }, { titre: 'Jours par an', format: 'd1', largeur: 12 }, { titre: 'Jours touchés', format: 'entier', largeur: 13 }, { titre: '% des jours touchés', format: 'pct', largeur: 17 }, { titre: 'Touchés par an', format: 'd1', largeur: 14 }, { titre: 'HR moyenne (%)', format: 'd1', largeur: 14 }] };
  const parAnnee = { nom: 'Tranches par année', colonnes: [{ titre: 'Tranche', largeur: 14 }, { titre: 'Année', format: 'brut', largeur: 8 }, { titre: 'Heures', format: 'entier', largeur: 9 }, { titre: '% des heures de l\'année', format: 'pct', largeur: 20 }, { titre: `Jours (${g})`, format: 'entier', largeur: 11 }, { titre: '% des jours de l\'année', format: 'pct', largeur: 19 }, { titre: 'Jours touchés', format: 'entier', largeur: 13 }],
    lignes: A.flatMap((a) => T.map((t) => [t.libelle, a, t.heuresParAnnee[a] || 0, (t.heuresParAnnee[a] || 0) / (R.heuresTParAnnee[a] || 1), t.joursParAnnee[a] || 0, (t.joursParAnnee[a] || 0) / (R.joursValidesParAnnee[a] || 1), t.touchesParAnnee[a] || 0])) };
  const parMois = { nom: 'Tranches par mois', colonnes: [{ titre: 'Tranche', largeur: 14 }, { titre: 'Mois (1-12)', format: 'brut', largeur: 11 }, { titre: 'Mois', largeur: 11 }, { titre: R.typique ? 'Jours dans le mois' : 'Jours (moyenne annuelle)', format: 'd2', largeur: 22 }, { titre: R.typique ? 'Heures dans le mois' : 'Heures (moyenne annuelle)', format: 'd1', largeur: 24 }],
    lignes: T.flatMap((t) => MOIS.map((m, i) => [t.libelle, i + 1, m, t.moisJours[i], t.moisHeures[i]])) };
  return [resume, parAnnee, parMois];
}
function feuilleVent(nom, items, rafales, premier) {
  const cols = [{ titre: premier, largeur: 20 }, { titre: 'Secteur', largeur: 9 }, { titre: 'Direction centrale (°)', format: 'brut', largeur: 20 }, { titre: 'Heures', format: 'entier', largeur: 9 }, { titre: '% des heures', format: 'pct', largeur: 12 }, { titre: 'Vitesse moyenne (m/s)', format: 'd1', largeur: 20 }, { titre: 'Vitesse max (m/s)', format: 'd1', largeur: 17 },
    ...(rafales ? [{ titre: 'Rafale max (m/s)', format: 'd1', largeur: 16 }] : []), { titre: 'Échantillon faible', largeur: 16 }, { titre: 'Secteur dominant', largeur: 16 }, { titre: 'Direction moyenne du dominant (°)', format: 'brut', largeur: 28 }, { titre: 'Part du dominant', format: 'pct', largeur: 15 }];
  const L = [];
  for (const { lib, r } of items) {
    const faible = r.peuRepresentatif;
    for (const x of r.secteurs) L.push([lib, NOMS12[x.k], x.dir, x.n, x.f / 100, x.n ? x.vm : null, x.vmax, ...(rafales ? [x.fxi] : []), faible, null, null, null]);
    L.push([lib, 'Calme', null, Math.round(((r.calmes ?? 0) * r.N) / 100), r.calmes != null ? r.calmes / 100 : null, null, null, ...(rafales ? [null] : []), faible, null, null, null]);
    L.push([lib, 'Total', null, r.N, r.N ? 1 : null, r.vm, r.vmax, ...(rafales ? [r.fxiMax ?? null] : []), faible, r.dominant?.nom ?? null, r.dominant?.degMoyen ?? null, r.dominant ? r.dominant.f / 100 : null]);
  }
  return { nom, colonnes: cols, lignes: L };
}
function feuilleHumidite(ctx) {
  const { S } = ctx;
  if (!S.aHR) return null;
  const cols = [{ titre: 'Groupe', largeur: 11 }, { titre: 'Libellé', largeur: 16 }, { titre: 'HR moyenne (%)', format: 'd1', largeur: 15 }, { titre: `Jours très humides (HR ≥ ${HUMIDE} %)`, format: 'entier', largeur: 28 }, { titre: `Jours secs (HR < ${SEC} %)`, format: 'entier', largeur: 22 }, ...(S.aPluie ? [{ titre: 'Jours de pluie', format: 'entier', largeur: 14 }, { titre: 'Cumul de pluie (mm)', format: 'd1', largeur: 18 }] : [])];
  const L = S.categories.map((c) => ['Catégorie', c.libelle, num(c.hrMoy), c.humides, c.secs, ...(S.aPluie ? [c.pluie, null] : [])]);
  if (!S.typique) for (const a of S.annees) { const x = S.humidite.parAnnee[a] || {}; L.push(['Année', String(a), num(x.hrMoy), x.humides ?? null, x.secs ?? null, ...(S.aPluie ? [x.pluie ?? null, num(x.cumulRR)] : [])]); }
  return { nom: 'Humidité', colonnes: cols, lignes: L };
}
function feuillesUTCI(ctx) {
  const { S, R } = ctx, U = S.utci;
  if (!U) return [];
  const k = parAnDe(ctx);
  const mesures = [['heures', 'Heures', (x) => x.heures], ['heuresJour', 'Heures de jour', (x) => x.heuresJour], ['joursMax', 'Jours (UTCI max)', (x) => x.joursMax], ['joursMin', 'Jours (UTCI min)', (x) => x.joursMin]];
  const cols = [{ titre: 'Classe UTCI', largeur: 28 }, { titre: 'UTCI min (°C)', format: 'd1', largeur: 13 }, { titre: 'UTCI max (°C)', format: 'd1', largeur: 13 }];
  for (const [, t] of mesures) for (const v of ['soleil', 'ombre']) cols.push({ titre: `${t}, ${v}`, format: 'entier', largeur: 20 });
  for (const [, t] of mesures) for (const v of ['soleil', 'ombre']) cols.push({ titre: `${t}, ${v} ${S.typique ? '(année type)' : 'par an'}`, format: 'd1', largeur: 24 });
  const L = U.classes.map((c) => [c.libelle, ok(c.min) ? c.min : null, ok(c.max) ? c.max : null,
    ...mesures.flatMap(([id]) => ['soleil', 'ombre'].map((v) => U[id][v][c.k])), ...mesures.flatMap(([id]) => ['soleil', 'ombre'].map((v) => U[id][v][c.k] / k))]);
  const extra = (lib, o, hCle, jCle) => { const row = new Array(cols.length).fill(null); row[0] = lib; row[3] = o.heures.soleil; row[4] = o.heures.ombre; row[7] = o.jours.soleil; row[8] = o.jours.ombre; row[11] = o.heures.soleil / k; row[12] = o.heures.ombre / k; row[15] = o.jours.soleil / k; row[16] = o.jours.ombre / k; void hCle; void jCle; return row; };
  // chaleur : jours = jours dont l'UTCI max ≥ 32 (colonnes « Jours (UTCI max) ») ; froid : jours dont l'UTCI min < seuil (colonnes « Jours (UTCI min) »)
  const rows = [extra(`Stress de chaleur fort ou plus (UTCI ≥ ${UTCI_CHAUD_FORT} °C)`, U.chaudFort), (() => { const r = new Array(cols.length).fill(null); const o = U.froidModere; r[0] = `Stress de froid modéré ou plus (UTCI < ${UTCI_FROID_MODERE} °C)`; r[3] = o.heures.soleil; r[4] = o.heures.ombre; r[9] = o.jours.soleil; r[10] = o.jours.ombre; r[11] = o.heures.soleil / k; r[12] = o.heures.ombre / k; r[17] = o.jours.soleil / k; r[18] = o.jours.ombre / k; return r; })(),
    (() => { const r = new Array(cols.length).fill(null); const o = U.froidFort; r[0] = `Stress de froid fort ou plus (UTCI < ${UTCI_FROID_FORT} °C)`; r[3] = o.heures.soleil; r[4] = o.heures.ombre; r[9] = o.jours.soleil; r[10] = o.jours.ombre; r[11] = o.heures.soleil / k; r[12] = o.heures.ombre / k; r[17] = o.jours.soleil / k; r[18] = o.jours.ombre / k; return r; })()];
  // les colonnes : 0 classe, 1 min, 2 max, 3-4 heures, 5-6 heures de jour, 7-8 jours max, 9-10 jours min, 11-12 heures/an, 13-14 heures de jour/an, 15-16 jours max/an, 17-18 jours min/an
  const sheets = [{ nom: 'UTCI', colonnes: cols, lignes: [...L, ...rows], filtre: false }];
  if (R?.utci) {
    const C = R.classesUTCI;
    sheets.push({ nom: 'UTCI par tranche', filtre: false, colonnes: [{ titre: 'Tranche', largeur: 14 }, { titre: S.typique ? 'Heures de jour (année type)' : 'Heures de jour par an', format: 'entier', largeur: 24 }, { titre: 'Heures de jour (total)', format: 'entier', largeur: 20 }, { titre: 'UTCI moyen soleil (°C)', format: 'd1', largeur: 20 }, { titre: 'Classe dominante soleil', largeur: 26 }, { titre: 'Part de la classe (soleil)', format: 'pct', largeur: 22 }, { titre: 'UTCI moyen ombre (°C)', format: 'd1', largeur: 20 }, { titre: 'Classe dominante ombre', largeur: 26 }, { titre: 'Part de la classe (ombre)', format: 'pct', largeur: 22 }, { titre: 'Échantillon faible', largeur: 16 }],
      lignes: R.tranches.map((t) => { const u = t.utci; return [t.libelle, u.n / R.nAnnees, u.n, num(u.soleil), u.classeSoleil != null ? C[u.classeSoleil].libelle : null, u.pctClasseSoleil != null ? u.pctClasseSoleil / 100 : null, num(u.ombre), u.classeOmbre != null ? C[u.classeOmbre].libelle : null, u.pctClasseOmbre != null ? u.pctClasseOmbre / 100 : null, u.n < HEURES_MIN]; }) });
  }
  return sheets;
}

// ------------------------------------------------------------------ conditions extrêmes
function feuillesExtremes(ctx) {
  const { X } = ctx;
  if (!X) return [];
  const rafales = !!X.rafales;
  const C = CONDITIONS.map((d) => X.conditions[d.id]);
  const ext = { nom: 'Extrêmes', colonnes: [{ titre: 'Condition', largeur: 30 }, { titre: 'Groupe', largeur: 11 }, { titre: 'Définition', largeur: 70, format: 'long' }, { titre: 'Heures', format: 'entier', largeur: 9 }, { titre: 'Jours', format: 'entier', largeur: 8 }, { titre: 'Heures de vent', format: 'entier', largeur: 15 }, { titre: 'Vent dominant', largeur: 14 }, { titre: 'Direction du secteur dominant (°)', format: 'brut', largeur: 28 }, { titre: 'Part du dominant', format: 'pct', largeur: 15 }, { titre: 'Vent moyen (m/s)', format: 'd1', largeur: 16 }, { titre: 'Calme', format: 'pct', largeur: 8 }, { titre: 'Vent max (m/s)', format: 'd1', largeur: 14 }, { titre: 'Échantillon faible', largeur: 16 }, { titre: 'Remarque', largeur: 34 }],
    filtre: false,
    lignes: C.map((c, i) => { const r = c.rose, d = CONDITIONS[i]; return [d.libelle, d.groupe, d.def, c.indisponible ? null : c.heures, c.indisponible ? null : c.jours, c.indisponible ? null : c.heuresVent, r.dominant?.nom ?? null, r.dominant?.dir ?? null, r.dominant ? r.dominant.f / 100 : null, c.heures ? num(r.vm) : null, r.calmes != null ? r.calmes / 100 : null, c.heures ? num(r.vmax) : null, c.indisponible ? null : c.peuRepresentatif && c.heures > 0, c.indisponible ? 'pas de rafales dans cette source' : c.peuRepresentatif && c.heures ? `moins de ${HEURES_MIN} h de vent` : null]; }) };
  const vent = feuilleVent('Extrêmes - vent', CONDITIONS.filter((d, i) => !C[i].indisponible).map((d) => ({ lib: d.libelle, r: X.conditions[d.id].rose })), rafales, 'Condition');
  const ep = [];
  for (const d of CONDITIONS) for (const e of X.conditions[d.id].episodes) ep.push([d.libelle, serieJourIso(e.debut), serieJourIso(e.fin), e.jours, e.heures]);
  const episodes = { nom: 'Épisodes', colonnes: [{ titre: 'Condition', largeur: 30 }, { titre: 'Début', format: 'date', largeur: 12 }, { titre: 'Fin', format: 'date', largeur: 12 }, { titre: 'Jours', format: 'entier', largeur: 8 }, { titre: 'Heures', format: 'entier', largeur: 9 }], lignes: ep };
  // température record : valeur = TX / TN instantanée (x.valeur), T de l'heure à part
  const recs = [];
  const r2c = (quoi, portee, x) => { if (!x) return; recs.push([quoi, portee, serieJourIso(x.jour), x.heure, x.valeur, x.T, x.DD, x.nom, x.FF, x.FXI]); };
  r2c('Plus chaud', 'toute la période', X.recordChaud); r2c('Plus froid', 'toute la période', X.recordFroid);
  for (const a of X.annees) { r2c('Plus chaud', String(a.annee), a.chaud); r2c('Plus froid', String(a.annee), a.froid); }
  for (const j of X.joursFroids) recs.push(['Jour parmi les plus froids', 'toute la période', serieJourIso(j.date), null, j.tmin, j.tmax, null, null, null, null]);
  const records = { nom: 'Records', colonnes: [{ titre: 'Record', largeur: 26 }, { titre: 'Portée', largeur: 17 }, { titre: 'Date', format: 'date', largeur: 12 }, { titre: 'Heure de Paris', format: 'brut', largeur: 14 }, { titre: 'Température extrême (°C)', format: 'd1', largeur: 24 }, { titre: 'T de l\'heure (°C) / Tmax du jour', format: 'd1', largeur: 30 }, { titre: 'Direction (°)', format: 'brut', largeur: 13 }, { titre: 'Secteur', largeur: 9 }, { titre: 'Vent moyen (m/s)', format: 'd1', largeur: 16 }, { titre: 'Rafale (m/s)', format: 'd1', largeur: 13 }], lignes: recs };
  return [ext, vent, episodes, records];
}

// ------------------------------------------------------------------ classeur complet
export function feuilles(ctx, { horaires = false } = {}) {
  const F = [lisezMoi(ctx, { horaires })];
  if (ctx.portee !== 'extremes' && ctx.S) {
    const { S, R } = ctx;
    F.push(feuilleJours(ctx));
    if (horaires) F.push(feuilleHeures(ctx));
    F.push(feuilleCategories(ctx));
    if (R) F.push(...feuillesTranches(ctx));
    F.push(feuilleSeuils(ctx));
    const ids = [...CATEGORIES.map((c) => c.id), 'ensemble'];
    F.push(feuilleVent('Vent par catégorie', ids.map((id) => ({ lib: CATEGORIES.find((c) => c.id === id)?.libelle ?? 'Toutes les journées', r: S.vent[id] })), S.rafales, 'Catégorie'));
    if (R) F.push(feuilleVent('Vent par tranche', R.tranches.map((t) => ({ lib: t.libelle, r: t.vent })), R.rafales, 'Tranche'));
  }
  F.push(...feuillesExtremes(ctx));
  if (ctx.portee !== 'extremes' && ctx.S) {
    const hu = feuilleHumidite(ctx); if (hu) F.push(hu);
    F.push(...feuillesUTCI(ctx));
  }
  return F;
}
export function classeur(ctx, { horaires = false, progression = null } = {}) {
  return classeurXLSX(feuilles(ctx, { horaires }), { titre: `Statistiques du climat — ${ctx.E.periode}`, auteur: 'Atlas du site de l\'Hôtel de Ville', progression });
}
