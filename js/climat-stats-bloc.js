// Bloc « Statistiques du climat » du panneau Climat (11/11/2026) : affichage de js/climat-stats.js (calcul pur) sur la période choisie
// (moyenne 2016-2025, année du sélecteur, ou EPW actif). Créé par js/climat.js (construirePanneau), après « Conditions extrêmes et vent ».
// details repliable (ouvert / replié : localStorage atlas-hdv-stats-climat-ouvert), calcul au premier dépliage, résultats gardés par
// source | année | seuils (Map du module). Seuils réglables (localStorage atlas-hdv-seuils-climat, JSON). Styles injectés : style#styles-stats-climat.
import { h, info, lireLS, ecrireLS } from './util.js';
import { heuresClimat, mention, erreurExtremesDetail } from './meteo.js';
import {
  statistiquesClimat, csvStatistiques, texteResume, texteVentCategorie, seuilsValides, SEUILS_DEFAUT, LIBELLES_SEUILS, CATEGORIES, HUMIDE, SEC, PLUIE,
  UTCI_CHAUD_FORT, UTCI_FROID_MODERE, UTCI_FROID_FORT, PIETON,
  statistiquesTranches, texteTranches, csvTranches, lireBornes, DECOUPAGES, DECOUPAGE_DEFAUT, GRANDEURS, BORNES_MIN, BORNES_MAX,
} from './climat-stats.js';
import { NOMS12, HEURES_MIN, CALME } from './meteo-extremes.js';
import { svgRose } from './roses-saisons.js';
import { telecharger } from './donnees.js';
import { getPosition } from '../lib/suncalc.js';
import { barreExport } from './climat-export-ui.js'; // 11/11/2026 : barre « Exporter » (Excel, PDF, CSV)

const CLE_SEUILS = 'atlas-hdv-seuils-climat';
const CLE_OUVERT = 'atlas-hdv-stats-climat-ouvert';
const CLE_TRANCHES = 'atlas-hdv-tranches-climat'; // { decoupage: fin|standard|perso, perso: texte des bornes, grandeur: tmoy|tmax|tmin, touches, mois: jours|heures }
const MOIS_COURTS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const resultats = new Map();
const nb = (v, d = 0) => (v == null || !Number.isFinite(v) ? '–' : Number(v).toFixed(d).replace('.', ',').replace('-', '−'));
const entier = (v) => (v == null ? '–' : Math.round(v).toLocaleString('fr-FR'));
const parAnD = (v) => nb(v, v != null && Math.abs(v) < 10 ? 1 : 0);

function lireSeuils() {
  try { return seuilsValides(JSON.parse(lireLS(CLE_SEUILS) || '{}')); } catch { return { ...SEUILS_DEFAUT }; }
}

function styles() {
  if (document.getElementById('styles-stats-climat')) return;
  document.head.append(h('style', { id: 'styles-stats-climat' }, `
.bloc-stats-climat { margin: 10px 0 4px; }
.bloc-stats-climat > summary { cursor: pointer; font-weight: 600; font-size: 14px; padding: 4px 0; }
.bloc-stats-climat h4 { margin: 10px 0 2px; font-size: 13px; }
.bloc-stats-climat .defile { overflow-x: auto; -webkit-overflow-scrolling: touch; max-width: 100%; }
.bloc-stats-climat table.table-stats { border-collapse: collapse; font-size: 12px; margin: 4px 0 6px; min-width: 100%; }
.bloc-stats-climat .table-stats th, .bloc-stats-climat .table-stats td { padding: 2px 4px; border-bottom: 1px solid rgba(47,59,69,.12); text-align: right; vertical-align: top; white-space: nowrap; }
.bloc-stats-climat .table-stats th:first-child, .bloc-stats-climat .table-stats td:first-child { text-align: left; position: sticky; left: 0; background: var(--fond-panneau, #fbfaf7); }
.bloc-stats-climat .table-stats tr.total td { font-weight: 600; border-top: 1px solid rgba(47,59,69,.35); }
.bloc-stats-climat .table-stats tr.faible td { color: #7b8790; }
.bloc-stats-climat .table-stats td.max { font-weight: 700; }
.bloc-stats-climat .table-stats td .sous { display: block; font-size: 10px; color: #5b6770; }
.bloc-stats-climat .pastille { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
.bloc-stats-climat .seuils-climat { border: 1px solid rgba(47,59,69,.18); border-radius: 3px; padding: 4px 6px 6px; margin: 4px 0 8px; }
.bloc-stats-climat .seuils-climat legend { font-size: 12px; padding: 0 4px; }
.bloc-stats-climat .seuils-grille { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 4px 8px; }
.bloc-stats-climat .seuils-grille label { display: flex; flex-direction: column; font-size: 11px; gap: 1px; }
.bloc-stats-climat .seuils-grille input { width: 5.5em; padding: 2px 4px; }
.bloc-stats-climat ul.liste-stats { margin: 2px 0 6px; padding-left: 18px; font-size: 12px; }
.bloc-stats-climat .roses-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; margin: 4px 0; }
.bloc-stats-climat .roses-stats svg { width: 100%; height: auto; display: block; }
.bloc-stats-climat p.resultat { margin: 4px 0; }
.bloc-stats-climat .mention-stats { font-size: 11px; color: #5b6770; }
.bloc-stats-climat .alerte-stats { font-size: 12px; color: #8a4b08; }
.bloc-stats-climat .reglages-tranches { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: flex-end; }
.bloc-stats-climat .reglages-tranches label { display: flex; flex-direction: column; font-size: 11px; gap: 1px; }
.bloc-stats-climat .reglages-tranches label.case-tranches { flex-direction: row; align-items: center; gap: 4px; }
.bloc-stats-climat .reglages-tranches input[type=text] { width: 15em; padding: 2px 4px; }
.bloc-stats-climat .reglages-tranches input.invalide { border-color: #b2182b; outline: 1px solid #b2182b; }
.bloc-stats-climat .table-stats tr.choisie td { background: rgba(255, 214, 102, .35); font-weight: 600; }
.bloc-stats-climat .table-mois-tranches td { min-width: 2.6em; }
.bloc-stats-climat .table-stats td.clair { color: #fff; }
@media (max-width: 520px) { .bloc-stats-climat .roses-stats { grid-template-columns: repeat(2, 1fr); } }
`));
}

const tableau = (tete, lignes, cls = '') => h('div', { class: 'defile' }, h('table', { class: `table-stats ${cls}` },
  h('thead', {}, h('tr', {}, ...tete.map((t) => (t instanceof Node ? t : h('th', {}, t))))), h('tbody', {}, ...lignes)));
const td = (v, attrs = {}) => h('td', attrs, v);
const pastille = (c) => h('span', { class: 'pastille', style: `background:${c}` });

// Statistiques et tranches de l'état courant (réglages mémorisés : seuils, découpage, bornes, grandeur), pour l'export Excel / PDF :
// mêmes fonctions de calcul et mêmes caches (resultats, memoTranches) que l'affichage → mêmes valeurs. Bornes personnalisées invalides : erreur.
export async function statsPourExport(app) {
  const E = await heuresClimat();
  if (!E) throw new Error(erreurExtremesDetail() || 'Mesures horaires indisponibles.');
  const seuils = lireSeuils();
  const cle = `${E.cle}|${JSON.stringify(seuils)}`;
  let S = resultats.get(cle);
  if (!S) {
    const o = app.config?.origine ?? {};
    S = statistiquesClimat(E.H, { annee: E.annee, seuils, lat: o.lat ?? 47.2176, lon: o.lon ?? -1.5545, positionSoleil: getPosition, typique: E.typique });
    resultats.set(cle, S);
  }
  const reg = lireReglagesTranches();
  let bornes = DECOUPAGES[reg.decoupage]?.bornes;
  if (reg.decoupage === 'perso') {
    const r = lireBornes(reg.perso);
    if (r.erreur) throw new Error(`bornes des tranches invalides (${r.erreur}) : corriger les bornes dans « Tranches de température »`);
    bornes = r.bornes;
  }
  const ct = `${E.cle}|${bornes.join(',')}|${reg.grandeur}`;
  let R = memoTranches.get(ct);
  if (!R) { R = statistiquesTranches(E.H, { annee: E.annee, bornes, grandeur: reg.grandeur, typique: E.typique, utci: S.utci }); memoTranches.set(ct, R); }
  return { S, R, E };
}

export function blocStatistiques(app) {
  styles();
  const ouvert = lireLS(CLE_OUVERT) === '1';
  const corps = h('div', { class: 'corps-stats' });
  const bloc = h('details', { class: 'bloc-stats-climat', 'data-garder': '', open: ouvert || null }, h('summary', {}, 'Statistiques du climat'), corps);
  let seuils = lireSeuils();
  let calcule = false;
  let attente = null;

  const champs = {};
  const fieldset = h('fieldset', { class: 'seuils-climat' }, h('legend', {}, 'Seuils des catégories de jours (°C)'),
    h('div', { class: 'seuils-grille' }, ...Object.keys(SEUILS_DEFAUT).map((k) => {
      champs[k] = h('input', { type: 'number', step: '0.5', min: '-40', max: '45', value: String(seuils[k]), 'aria-label': LIBELLES_SEUILS[k],
        oninput: () => { clearTimeout(attente); attente = setTimeout(appliquerSeuils, 500); } });
      return h('label', {}, h('span', {}, LIBELLES_SEUILS[k]), champs[k]);
    })),
    h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: () => {
      seuils = { ...SEUILS_DEFAUT };
      for (const k of Object.keys(champs)) champs[k].value = String(seuils[k]);
      ecrireLS(CLE_SEUILS, null);
      calculer();
    } }, 'Valeurs par défaut')));
  function appliquerSeuils() {
    const brut = Object.fromEntries(Object.entries(champs).map(([k, el]) => [k, el.value === '' ? NaN : Number(el.value)]));
    seuils = seuilsValides(brut);
    const defaut = Object.keys(SEUILS_DEFAUT).every((k) => seuils[k] === SEUILS_DEFAUT[k]);
    ecrireLS(CLE_SEUILS, defaut ? null : JSON.stringify(seuils));
    calculer();
  }
  const resultat = h('div', { class: 'resultat-stats' });
  corps.append(fieldset, resultat);

  bloc.addEventListener('toggle', () => {
    ecrireLS(CLE_OUVERT, bloc.open ? '1' : null);
    if (bloc.open && !calcule) calculer();
  });
  if (ouvert) queueMicrotask(calculer);

  async function calculer() {
    calcule = true;
    resultat.replaceChildren(h('p', { class: 'note', role: 'status' }, 'Statistiques du climat : calcul sur les mesures horaires…'));
    const E = await heuresClimat();
    if (!E) { resultat.replaceChildren(h('p', { class: 'note', role: 'status' }, erreurExtremesDetail() || 'Mesures horaires indisponibles.')); return; }
    const cle = `${E.cle}|${JSON.stringify(seuils)}`;
    let S = resultats.get(cle);
    if (!S) {
      await new Promise((r) => setTimeout(r, 30)); // laisser s'afficher le message
      const o = app.config?.origine ?? {};
      S = statistiquesClimat(E.H, { annee: E.annee, seuils, lat: o.lat ?? 47.2176, lon: o.lon ?? -1.5545, positionSoleil: getPosition, typique: E.typique });
      resultats.set(cle, S);
    }
    if (!bloc.isConnected) return;
    resultat.replaceChildren(...afficher(S, E));
  }

  function afficher(S, E) {
    const periode = E.periode;
    const k = S.typique ? 1 : S.nAnnees;
    const parAnD = (v) => nb(v, k > 1 && v != null && Math.abs(v) < 10 ? 1 : 0);
    const parAn = S.typique ? 'année type' : S.nAnnees > 1 ? 'par an' : 'dans l\'année';
    const titre = (t, ...i) => h('div', { class: 'titre-info' }, h('h4', {}, t), i.length ? info(...i) : null);
    const out = [];
    // (i) mentions générales
    out.push(h('p', { class: 'mention-stats', 'data-garder': '' }, `${E.epw ? `Fichier EPW actif : ${S.typique ? 'année type (mois tirés d\'années différentes) : pas de tableau année par année ; ' : ''}pas de rafales ni de pluie. ` : ''}Période : ${periode} ; ${S.joursValides.toLocaleString('fr-FR')} journées valides (jour civil de Paris, au moins 20 h de mesures). `,
      info(h('div', {},
        h('p', {}, 'Journée : jour civil de Paris (heure d\'été comprise), valide si au moins 20 heures de température (comme les jours extrêmes). Tmin et Tmax : extrêmes des TN et TX horaires ; Tmoy : moyenne des températures horaires. Les heures des journées incomplètes ne sont dans aucune catégorie.'),
        h('p', {}, 'Catégories exclusives, testées dans cet ordre : canicule, chaud, très froid, froid, tempéré.'),
        h('ul', {}, ...CATEGORIES.map((c) => h('li', {}, h('b', {}, c.libelle), ` : ${S.definitions[c.id]}.`))),
        h('p', {}, 'Canicule : même définition que le bloc « Conditions extrêmes et vent » (seuils de vigilance du département appliqués aux mesures de l\'aéroport ; ce n\'est pas la liste officielle des alertes).'),
        h('p', {}, mention({ annee: true }))))));
    // barre d'export (Excel, PDF, CSV)
    out.push(barreExport(app, { portee: 'tout', stats: () => statsPourExport(app), titre: 'Exporter les statistiques',
      csv: () => [{ nom: `atlas-hdv-statistiques-climat-${periode.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^0-9a-z-]+/gi, '-')}.csv`, texte: csvStatistiques(S, `${mention({ court: true, annee: true })} Statistiques du climat, ${periode}.`) }] }));
    // (a) résumé
    out.push(...texteResume(S, periode).map((t) => h('p', { class: 'resultat' }, t)));
    // (h) seuils (fieldset placé au-dessus, dans le corps)
    // (b) catégories
    out.push(titre('Catégories de jours'),
      tableau(['Catégorie', 'Jours', '% des jours', 'Heures', `Jours ${parAn}`], [
        ...S.categories.map((c) => h('tr', { title: S.definitions[c.id] }, td([pastille(c.couleur), c.libelle]), td(entier(c.jours)), td(nb(c.pct, 1)), td(entier(c.heures)), td(parAnD(c.parAn)))),
        h('tr', { class: 'total' }, td('Total'), td(entier(S.joursValides)), td('100'), td(entier(S.categories.reduce((a, c) => a + c.heures, 0))), td(parAnD(S.joursValides / k))),
      ]));
    // compteurs non exclusifs
    out.push(titre('Seuils de température (non exclusifs)', 'Heures : température horaire ; jours : journées valides dont la Tmin (seuils bas) ou la Tmax (seuils hauts) atteint le seuil. Un même jour peut compter dans plusieurs lignes.'),
      tableau(['Seuil', 'Heures', '% des heures', `Heures ${parAn}`, 'Jours', '% des jours', `Jours ${parAn}`],
        S.compteurs.map((c) => h('tr', {}, td(c.libelle), td(entier(c.heures)), td(nb(c.pctHeures, 1)), td(entier(c.heuresParAn)), td(entier(c.jours)), td(nb(c.pctJours, 1)), td(parAnD(c.joursParAn))))));
    // (c) année par année
    if (!S.typique && S.annees.length > 1) {
      const A = S.annees;
      out.push(titre('Jours par année', 'Journées valides par catégorie, année civile de Paris ; dernière colonne : nombre de journées valides de l\'année (365 ou 366 si complète).'),
        tableau(['Année', ...S.categories.map((c) => h('th', {}, pastille(c.couleur), c.libelle)), 'Valides'], [
          ...A.map((a) => h('tr', {}, td(String(a)), ...S.categories.map((c) => td(entier(c.parAnnee[a] || 0))), td(entier(S.joursValidesParAnnee[a])))),
          h('tr', { class: 'total' }, td('Total'), ...S.categories.map((c) => td(entier(c.jours))), td(entier(S.joursValides))),
          h('tr', {}, td('Moyenne / an'), ...S.categories.map((c) => td(parAnD(c.parAn))), td(parAnD(S.joursValides / k))),
        ]));
    }
    // (c bis) tranches de température
    out.push(sectionTranches(S, E));
    // (d) vent par catégorie
    const ids = [...CATEGORIES.map((c) => c.id), 'ensemble'];
    const libelle = (id) => CATEGORIES.find((c) => c.id === id)?.libelle ?? 'Toutes les journées';
    const roses = ids.map((id) => {
      const r = S.vent[id], okR = r.N > 0 && !!r.dominant;
      return { lib: `${libelle(id)}${r.N ? ` (${entier(r.N)} h)` : ''}`, r: { secteurs: r.secteurs.map((x) => ({ ...x, p5: 0 })) }, ok: okR, dom: okR ? { k: r.dominant.k, dir: r.dominant.dir, f: r.dominant.f, vm: r.dominant.vm } : null };
    });
    const grille = h('div', { class: 'roses-stats' });
    grille.innerHTML = roses.map((x) => `<svg viewBox="0 0 100 124" role="img" aria-label="Rose des vents, ${x.lib}">${svgRose(x, Math.max(10, Math.ceil(Math.max(...x.r.secteurs.map((q) => q.f)) / 5) * 5), { cx: 50, cy: 50, R: 34, p: 8 })}</svg>`).join('');
    const lignesVent = ids.map((id) => {
      const r = S.vent[id], dom = r.dominant?.k;
      return h('tr', { class: r.peuRepresentatif ? 'faible' : '', title: r.peuRepresentatif ? `Échantillon faible : ${r.N} h (moins de ${HEURES_MIN} h)` : '' },
        td(libelle(id)),
        ...r.secteurs.map((x) => td([entier(x.n), h('span', { class: 'sous' }, `${nb(x.f, 1)} %`), h('span', { class: 'sous' }, x.n ? `${nb(x.vm, 1)} m/s` : '–')], { class: x.k === dom ? 'max' : '' })),
        td([entier(Math.round(((r.calmes ?? 0) * r.N) / 100)), h('span', { class: 'sous' }, `${nb(r.calmes, 1)} %`)]),
        td(r.dominant ? [`${r.dominant.nom} ${r.dominant.degMoyen ?? r.dominant.dir}°`, h('span', { class: 'sous' }, `${nb(r.dominant.f, 1)} %`)] : '–'),
        td(entier(r.N)), td(nb(r.vm, 1)), td(nb(r.vmax, 1)), S.rafales ? td(nb(r.fxiMax, 1)) : null);
    });
    out.push(titre('Vent par catégorie de jours',
      `Heures des journées de chaque catégorie ; 12 secteurs de 30° centrés sur N (0°), NNE (30°)… ; direction = d'où vient le vent ; vent moyen sur 10 min à 10 m ; calme : vent < ${String(CALME).replace('.', ',')} m/s (sans direction). Chaque case : heures, % de toutes les heures de la catégorie (calmes compris), vitesse moyenne du secteur. Roses : échelle propre à chaque rose (cercles tous les 5 ou 10 %). Dominant : secteur le plus fréquent et direction moyenne de ses heures. Moins de ${HEURES_MIN} h : échantillon faible (en gris). Vent mesuré sur le terrain dégagé de l'aéroport : en ville, plus faible et dévié par le bâti.`),
    grille,
    h('ul', { class: 'liste-stats' }, ...ids.slice(0, 5).map((id) => h('li', {}, h('b', {}, libelle(id)), ` : ${texteVentCategorie(S.vent[id])}.`))),
    tableau(['Catégorie', ...NOMS12, 'Calme', 'Dominant', 'Heures', 'Moy. m/s', 'Max m/s', ...(S.rafales ? ['Rafale max'] : [])], lignesVent, 'table-vent-stats'));
    // (e) humidité
    const aU = S.aHR;
    if (aU) {
      out.push(titre('Humidité', `Humidité relative de l'air (sous abri, ${E.epw ? 'fichier EPW' : 'Météo-France, colonne U'}) : moyenne des heures. Journée très humide : moyenne du jour ≥ ${HUMIDE} % ; sèche : < ${SEC} % (au moins 20 h mesurées). ${S.aPluie ? `Jour de pluie : cumul des pluies horaires (RR1) ≥ ${PLUIE} mm (au moins 20 h mesurées).` : 'Pluie : absente de cette source (non affichée).'}`),
        tableau(['Catégorie', 'HR moy. %', 'Très humides', 'Secs', ...(S.aPluie ? ['Jours de pluie'] : [])],
          S.categories.map((c) => h('tr', {}, td([pastille(c.couleur), c.libelle]), td(nb(c.hrMoy, 0)), td(entier(c.humides)), td(entier(c.secs)), S.aPluie ? td(entier(c.pluie)) : null))));
      if (!S.typique && S.annees.length) {
        out.push(tableau(['Année', 'HR moy. %', 'Très humides', 'Secs', ...(S.aPluie ? ['Jours de pluie', 'Pluie mm'] : [])],
          S.annees.map((a) => { const x = S.humidite.parAnnee[a] || {}; return h('tr', {}, td(String(a)), td(nb(x.hrMoy, 0)), td(entier(x.humides)), td(entier(x.secs)), S.aPluie ? td(entier(x.pluie)) : null, S.aPluie ? td(entier(x.cumulRR)) : null); })));
      }
      if (!S.aPluie) out.push(h('p', { class: 'mention-stats' }, 'Jours de pluie non calculés : la source active ne donne pas la pluie horaire.'));
    } else out.push(h('p', { class: 'mention-stats' }, 'Humidité absente de cette source.'));
    // (f) UTCI
    const U = S.utci;
    if (U) {
      const lignesU = U.classes.map((c) => h('tr', {}, td([pastille(`rgb(${c.couleur.join(',')})`), c.libelle, h('span', { class: 'sous' }, `${Number.isFinite(c.min) ? nb(c.min) : '…'} à ${Number.isFinite(c.max) ? nb(c.max) : '…'} °C`)]),
        td(entier(U.heures.soleil[c.k] / k)), td(entier(U.heures.ombre[c.k] / k)), td(entier(U.heuresJour.soleil[c.k] / k)), td(entier(U.heuresJour.ombre[c.k] / k)),
        td(parAnD(U.joursMax.soleil[c.k] / k)), td(parAnD(U.joursMax.ombre[c.k] / k)), td(parAnD(U.joursMin.soleil[c.k] / k)), td(parAnD(U.joursMin.ombre[c.k] / k))));
      const X = U.controle;
      out.push(titre('UTCI avec rayonnement (piéton en site dégagé)',
        h('p', {}, `UTCI (°C) d'un piéton debout en site dégagé (ni bâti ni arbre, ouverture au ciel 1), au soleil et à l'ombre (rayonnement direct nul sur le corps et sur le sol voisin), heure par heure : polynôme officiel UTCI_approx (Bröde et al. 2012, js/utci.js) avec l'air, l'humidité et le vent à 10 m de la station (borné entre 0,5 et 17 m/s), et une température radiante moyenne (Tmrt) calculée comme dans l'outil Confort : facteurs d'angle d'une personne debout (VDI 3787, Thorsson et al. 2007), absorption αk ${nb(PIETON.ak, 1)}, émissivité ${nb(PIETON.ep, 2)}, facteur de projection fp = 0,308 cos(β (0,998 − β²/50 000)), albédo du sol ${nb(PIETON.albedoSol, 1)}, sol chauffé par le soleil qu'il reçoit (Ta + 0,025 (1 − albédo) G), ciel de Brutsaert corrigé par la nébulosité quand elle est mesurée (± 3 h ; sinon ciel clair, comme Confort), soleil de SunCalc au milieu de l'heure.`),
        h('p', {}, E.epw ? 'Rayonnement : direct (DNI) et diffus (DHI) horaires du fichier EPW.' : `Rayonnement : global horizontal mesuré par Météo-France (GLO, J/cm² par heure), partagé en direct et diffus par la corrélation d'Erbs et al. (1982) : c'est une estimation. ${U.estimees ? `${U.estimees} heure(s) de jour sans mesure : ciel clair de Haurwitz atténué par la nébulosité (Kasten et Czeplak 1980).` : ''}`),
        h('p', {}, `Jours (au moins 20 heures calculées) : classe de l'UTCI maximal et de l'UTCI minimal de la journée. Stress de chaleur fort ou plus : UTCI ≥ ${UTCI_CHAUD_FORT} °C ; stress de froid modéré ou plus : UTCI < ${UTCI_FROID_MODERE} °C ; fort : < ${UTCI_FROID_FORT} °C. Classes de Błażejczyk et al. (2013).`),
        h('p', {}, 'Estimation pédagogique, UTCI à ±3 à 5 °C près : pas de bâti, d\'arbres ni de vent urbain (voir l\'outil Confort pour le site), réflexions et sol simplifiés.')),
      h('p', { class: 'note', 'data-garder': '' }, h('strong', {}, 'Estimation pédagogique'), ' : UTCI à ±3 à 5 °C, rayonnement ', E.epw ? 'du fichier EPW' : 'global mesuré, direct et diffus estimés', '.'),
      h('p', { class: 'resultat' }, `Stress de chaleur fort ou plus (UTCI ≥ ${UTCI_CHAUD_FORT} °C) : ${parAnD(U.chaudFort.jours.soleil / k)} jours ${parAn} au soleil (${entier(U.chaudFort.heures.soleil / k)} h), ${parAnD(U.chaudFort.jours.ombre / k)} à l'ombre (${entier(U.chaudFort.heures.ombre / k)} h). Stress de froid modéré ou plus : ${parAnD(U.froidModere.jours.soleil / k)} jours au soleil, ${parAnD(U.froidModere.jours.ombre / k)} à l'ombre${U.froidFort.jours.ombre ? ` (dont fort : ${parAnD(U.froidFort.jours.ombre / k)})` : ''}.`),
      X ? h('p', { class: 'mention-stats' }, `Contrôle : heure d'été la plus ensoleillée (${X.date}) : air ${nb(X.Ta, 1)} °C, global ${entier(X.G)} W/m², soleil à ${entier(X.beta)}° ; Tmrt ${nb(X.tmrtSoleil)} °C au soleil (Ta + ${nb(X.tmrtSoleil - X.Ta)} K), ${nb(X.tmrtOmbre)} °C à l'ombre ; UTCI ${nb(X.uSoleil)} °C au soleil, ${nb(X.uOmbre)} °C à l'ombre.`) : null,
      tableau(['Classe UTCI', h('th', { colspan: 2 }, `Heures ${parAn}`), h('th', { colspan: 2 }, 'dont de jour'), h('th', { colspan: 2 }, 'Jours (UTCI max)'), h('th', { colspan: 2 }, 'Jours (UTCI min)')], [
        h('tr', {}, td(''), ...['soleil', 'ombre', 'soleil', 'ombre', 'soleil', 'ombre', 'soleil', 'ombre'].map((x) => td(h('i', {}, x)))),
        ...lignesU,
      ], 'table-utci-stats'),
      tableau(['Catégorie', 'UTCI max moyen soleil', 'ombre'], S.categories.map((c) => h('tr', {}, td([pastille(c.couleur), c.libelle]), td(c.utciMaxSoleil == null ? '–' : `${nb(c.utciMaxSoleil, 1)} °C`), td(c.utciMaxOmbre == null ? '–' : `${nb(c.utciMaxOmbre, 1)} °C`)))));
    }
    out.push(h('p', { class: 'mention-stats', 'data-garder': '' }, `Statistique observée ${periode}, pas une prévision ; mesures de la station de l'aéroport (Nantes-Bouguenais), terrain dégagé.`));
    return out.filter(Boolean);
  }
  return bloc;
}

// ------------------------------------------------------------------ tranches de température (11/11/2026)
function lireReglagesTranches() {
  let r = {};
  try { r = JSON.parse(lireLS(CLE_TRANCHES) || '{}') || {}; } catch { r = {}; }
  return {
    decoupage: ['fin', 'standard', 'perso'].includes(r.decoupage) ? r.decoupage : DECOUPAGE_DEFAUT,
    perso: typeof r.perso === 'string' ? r.perso : DECOUPAGES.standard.bornes.join(', '),
    grandeur: GRANDEURS[r.grandeur] ? r.grandeur : 'tmoy', touches: !!r.touches, mois: r.mois === 'heures' ? 'heures' : 'jours',
  };
}
const memoTranches = new Map();
const rgba = (rgb, a) => rgb.replace('rgb(', 'rgba(').replace(')', `,${a.toFixed(2)})`);
const sombre = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return 0.299 * r + 0.587 * g + 0.114 * b < 140; };

function sectionTranches(S, E) {
  const reg = lireReglagesTranches();
  const sauver = () => ecrireLS(CLE_TRANCHES, JSON.stringify(reg));
  const contenu = h('div', { class: 'contenu-tranches' });
  const erreur = h('span', { class: 'alerte-stats', role: 'status' });
  const champPerso = h('input', { type: 'text', value: reg.perso, 'aria-label': 'Bornes des tranches (°C)', placeholder: '0, 5, 15, 25, 30',
    oninput: () => { clearTimeout(champPerso.attente); champPerso.attente = setTimeout(() => { reg.perso = champPerso.value; sauver(); dessiner(); }, 500); } });
  const lPerso = h('label', {}, h('span', {}, `Bornes en °C, séparées par des virgules (${BORNES_MIN} à ${BORNES_MAX})`), champPerso);
  const selDec = h('select', { 'aria-label': 'Découpage', onchange: () => { reg.decoupage = selDec.value; sauver(); dessiner(); } },
    ...[['fin', DECOUPAGES.fin.libelle], ['standard', DECOUPAGES.standard.libelle], ['perso', 'Personnalisé']].map(([v, t]) => h('option', { value: v, selected: v === reg.decoupage || null }, t)));
  const selG = h('select', { 'aria-label': 'Jours classés par', onchange: () => { reg.grandeur = selG.value; sauver(); dessiner(); } },
    ...Object.entries(GRANDEURS).map(([v, t]) => h('option', { value: v, selected: v === reg.grandeur || null }, t)));
  const caseT = h('input', { type: 'checkbox', checked: reg.touches || null, onchange: () => { reg.touches = caseT.checked; sauver(); dessiner(); } });
  const reglages = h('fieldset', { class: 'seuils-climat reglages-tranches-fs' }, h('legend', {}, 'Tranches de température'),
    h('div', { class: 'reglages-tranches' }, h('label', {}, h('span', {}, 'Découpage'), selDec), lPerso, h('label', {}, h('span', {}, 'Jours classés par'), selG),
      h('label', { class: 'case-tranches' }, caseT, h('span', {}, 'Jours « touchés » (au moins une heure dans la tranche)'))),
    erreur);
  const section = h('div', { class: 'section-tranches' },
    h('div', { class: 'titre-info' }, h('h4', {}, 'Tranches de température'), info(
      h('p', {}, 'Tranches contiguës de température de l\'air (sous abri) : borne inférieure INCLUSE, borne supérieure EXCLUE (15 °C compte dans « 15 à 25 °C », pas dans « 5 à 15 °C »). Découpages proposés : fin (tous les 5 °C, de −5 à 35 °C) ; standard (0, 5, 15, 25, 30 °C) ; personnalisé (bornes croissantes séparées par des virgules ; avec « ; » comme séparateur, la virgule devient décimale).'),
      h('p', {}, 'Heures : température horaire de chaque heure mesurée. Jours : journées valides (jour civil de Paris, heure d\'été comprise, au moins 20 heures de mesures) classées par une seule grandeur (Tmoy = moyenne des températures horaires du jour ; Tmax et Tmin = extrêmes des TX et TN horaires, comme les catégories) : un jour compte dans une seule tranche, la somme des tranches fait le total. Jours « touchés » : journées dont au moins une heure est dans la tranche (un même jour peut compter dans plusieurs tranches).'),
      h('p', {}, `Vent, humidité et UTCI par tranche : heures dont la température est dans la tranche. Moins de ${HEURES_MIN} heures de vent : échantillon faible (en gris). UTCI : heures de jour (soleil levé), piéton debout en site dégagé, même calcul que le tableau UTCI ci-dessous ; classe dominante = classe la plus fréquente. Mois : moyenne annuelle (jours ou heures par mois). Les catégories de jours ci-dessus restent inchangées.`),
      h('p', {}, mention({ annee: true })))),
    reglages, contenu);
  if (reg.decoupage !== 'perso') lPerso.hidden = true;

  function dessiner() {
    lPerso.hidden = reg.decoupage !== 'perso';
    let bornes = DECOUPAGES[reg.decoupage]?.bornes;
    erreur.textContent = ''; champPerso.classList.remove('invalide');
    if (reg.decoupage === 'perso') {
      const r = lireBornes(champPerso.value);
      if (r.erreur) { erreur.textContent = `Bornes invalides : ${r.erreur} (résultats ci-dessous périmés).`; champPerso.classList.add('invalide'); contenu.style.opacity = '0.35'; return; }
      bornes = r.bornes;
    }
    contenu.style.opacity = '';
    const cle = `${E.cle}|${bornes.join(',')}|${reg.grandeur}`;
    let R = memoTranches.get(cle);
    if (!R) { R = statistiquesTranches(E.H, { annee: E.annee, bornes, grandeur: reg.grandeur, typique: E.typique, utci: S.utci }); memoTranches.set(cle, R); }
    contenu.replaceChildren(...afficherTranches(R, E, reg, dessiner));
  }
  dessiner();
  return section;
}

function afficherTranches(R, E, reg, redessiner) {
  const periode = E.periode, k = R.nAnnees;
  const parAn = R.typique ? 'année type' : k > 1 ? 'par an' : 'dans l\'année';
  const parAnD = (v) => nb(v, k > 1 && v != null && Math.abs(v) < 10 ? 1 : 0);
  const T = R.tranches;
  const libT = (t) => [pastille(t.couleur), t.libelle];
  const out = [];
  const phrases = texteTranches(R, periode);
  out.push(h('p', { class: 'resultat' }, phrases[0]), h('ul', { class: 'liste-stats resume-tranches' }, ...phrases.slice(1).map((t) => h('li', {}, t))));
  // heures et jours
  const g = { tmoy: 'Tmoy', tmax: 'Tmax', tmin: 'Tmin' }[R.grandeur];
  out.push(tableau(['Tranche', 'Heures', '% des heures', `Heures ${parAn}`, `Jours (${g})`, '% des jours', `Jours ${parAn}`, ...(reg.touches ? ['Jours touchés', `Touchés ${parAn}`] : []), 'HR moy. %'], [
    ...T.map((t) => h('tr', {}, td(libT(t)), td(entier(t.heures)), td(nb(t.pctHeures, 1)), td(entier(t.heuresParAn)), td(entier(t.jours)), td(nb(t.pctJours, 1)), td(parAnD(t.joursParAn)),
      reg.touches ? td([entier(t.touches), h('span', { class: 'sous' }, `${nb(t.pctTouches, 1)} %`)]) : null, reg.touches ? td(parAnD(t.touchesParAn)) : null, td(nb(t.hrMoy, 0)))),
    h('tr', { class: 'total' }, td('Total'), td(entier(R.heuresT)), td('100'), td(entier(R.heuresT / k)), td(entier(R.joursValides)), td('100'), td(parAnD(R.joursValides / k)), ...(reg.touches ? [td(''), td('')] : []), td('')),
  ], 'table-tranches'));
  // année par année
  if (!R.typique && R.annees.length > 1) {
    const choisie = R.annee;
    out.push(h('h4', {}, `Jours par tranche, année par année (${g} du jour)`),
      tableau(['Année', ...T.map((t) => h('th', {}, pastille(t.couleur), t.libelle)), 'Total'], [
        ...R.annees.map((a) => h('tr', { class: a === choisie ? 'choisie' : '' }, td(String(a)), ...T.map((t) => td(entier(t.joursParAnnee[a] || 0))), td(entier(R.joursValidesParAnnee[a])))),
        h('tr', { class: 'total' }, td('Total'), ...T.map((t) => td(entier(R.annees.reduce((s, a) => s + (t.joursParAnnee[a] || 0), 0)))), td(entier(R.annees.reduce((s, a) => s + (R.joursValidesParAnnee[a] || 0), 0)))),
        h('tr', {}, td('Moyenne / an'), ...T.map((t) => td(nb(R.annees.reduce((s, a) => s + (t.joursParAnnee[a] || 0), 0) / R.annees.length, 1))), td(nb(R.annees.reduce((s, a) => s + (R.joursValidesParAnnee[a] || 0), 0) / R.annees.length, 1))),
      ], 'table-annees-tranches'),
      choisie != null ? h('p', { class: 'mention-stats' }, `Ligne surlignée : année ${choisie} (année choisie) ; les autres tableaux portent sur cette année.`) : null);
  }
  // mois × tranches (heatmap)
  const selM = h('select', { 'aria-label': 'Mois : jours ou heures', onchange: () => { reg.mois = selM.value; ecrireLS(CLE_TRANCHES, JSON.stringify(reg)); redessiner(); } },
    h('option', { value: 'jours', selected: reg.mois === 'jours' || null }, 'jours'), h('option', { value: 'heures', selected: reg.mois === 'heures' || null }, 'heures'));
  const cleM = reg.mois === 'heures' ? 'moisHeures' : 'moisJours';
  const maxM = Math.max(1e-9, ...T.flatMap((t) => t[cleM]));
  const dM = reg.mois === 'heures' ? 0 : 1;
  out.push(h('div', { class: 'titre-info' }, h('h4', {}, 'Mois par mois : '), selM, h('span', { class: 'mention-stats' }, ` ${parAn === 'année type' ? 'dans l\'année type' : `en moyenne ${parAn}`} ; couleur d'autant plus soutenue que la valeur est grande`)),
    tableau(['Tranche', ...MOIS_COURTS, 'Année'], T.map((t) => h('tr', {}, td(libT(t)), ...t[cleM].map((v) => {
      const a = v / maxM;
      return td(v ? nb(v, dM) : '·', { style: v ? `background:${rgba(t.couleur, 0.08 + 0.85 * a)}` : '', class: v && a > 0.55 && sombre(t.couleur) ? 'clair' : '' });
    }), td(nb(t[cleM].reduce((s, v) => s + v, 0), dM))))
    , 'table-mois-tranches'));
  // vent par tranche
  const roses = T.map((t) => {
    const r = t.vent, okR = r.N > 0 && !!r.dominant;
    return { lib: `${t.libelle}${r.N ? ` (${entier(r.N)} h)` : ''}`, r: { secteurs: r.secteurs.map((x) => ({ ...x, p5: 0 })) }, ok: okR, dom: okR ? { k: r.dominant.k, dir: r.dominant.dir, f: r.dominant.f, vm: r.dominant.vm } : null };
  });
  const grille = h('div', { class: 'roses-stats roses-tranches' });
  grille.innerHTML = roses.map((x) => `<svg viewBox="0 0 100 124" role="img" aria-label="Rose des vents, ${x.lib}">${svgRose(x, Math.max(10, Math.ceil(Math.max(...x.r.secteurs.map((q) => q.f)) / 5) * 5), { cx: 50, cy: 50, R: 34, p: 8 })}</svg>`).join('');
  out.push(h('div', { class: 'titre-info' }, h('h4', {}, 'Vent par tranche de température'), info(`Heures dont la température est dans la tranche ; 12 secteurs de 30° (direction d'où vient le vent), vent moyen sur 10 min à 10 m, calme < ${String(CALME).replace('.', ',')} m/s. Case : heures, % des heures de la tranche (calmes compris), vitesse moyenne. Dominant : secteur le plus fréquent et direction moyenne de ses heures. Moins de ${HEURES_MIN} h : échantillon faible (en gris). Vent de l'aéroport, terrain dégagé.`)),
    grille,
    tableau(['Tranche', ...NOMS12, 'Calme', 'Dominant', 'Heures', 'Moy. m/s', 'Max m/s', ...(R.rafales ? ['Rafale max'] : [])], T.map((t) => {
      const r = t.vent, dom = r.dominant?.k;
      return h('tr', { class: r.peuRepresentatif ? 'faible' : '', title: r.peuRepresentatif ? `Échantillon faible : ${r.N} h (moins de ${HEURES_MIN} h)` : '' }, td(libT(t)),
        ...r.secteurs.map((x) => td([entier(x.n), h('span', { class: 'sous' }, `${nb(x.f, 1)} %`), h('span', { class: 'sous' }, x.n ? `${nb(x.vm, 1)} m/s` : '–')], { class: x.k === dom ? 'max' : '' })),
        td([entier(Math.round(((r.calmes ?? 0) * r.N) / 100)), h('span', { class: 'sous' }, `${nb(r.calmes, 1)} %`)]),
        td(r.dominant ? [`${r.dominant.nom} ${r.dominant.degMoyen ?? r.dominant.dir}°`, h('span', { class: 'sous' }, `${nb(r.dominant.f, 1)} %`)] : '–'),
        td(entier(r.N)), td(nb(r.vm, 1)), td(nb(r.vmax, 1)), R.rafales ? td(nb(r.fxiMax, 1)) : null);
    }), 'table-vent-tranches'));
  const faibles = T.filter((t) => t.vent.peuRepresentatif);
  if (faibles.length) out.push(h('p', { class: 'alerte-stats' }, `Échantillon faible (moins de ${HEURES_MIN} h de vent) : ${faibles.map((t) => `${t.libelle} (${t.vent.N} h)`).join(', ')}.`));
  // UTCI par tranche
  if (R.utci) {
    const C = R.classesUTCI;
    const cl = (i, p) => (i == null ? '–' : [pastille(`rgb(${C[i].couleur.join(',')})`), C[i].libelle, h('span', { class: 'sous' }, `${nb(p, 0)} % des heures`)]);
    out.push(h('div', { class: 'titre-info' }, h('h4', {}, 'UTCI par tranche (heures de jour)'), info('UTCI (ressenti) d\'un piéton debout en site dégagé pendant les heures de jour dont la température de l\'air est dans la tranche : moyenne et classe de stress la plus fréquente, au soleil et à l\'ombre. Montre l\'écart entre l\'air et le ressenti (soleil, vent, humidité). Estimation pédagogique, UTCI à ±3 à 5 °C près.')),
      tableau(['Tranche', `Heures de jour ${parAn}`, 'UTCI moy. soleil', 'Classe dominante soleil', 'UTCI moy. ombre', 'Classe dominante ombre'],
        T.map((t) => { const u = t.utci; return h('tr', { class: u.n < HEURES_MIN ? 'faible' : '', title: u.n < HEURES_MIN ? `Échantillon faible : ${u.n} h de jour` : '' }, td(libT(t)), td(entier(u.n / k)), td(u.soleil == null ? '–' : `${nb(u.soleil, 1)} °C`), td(cl(u.classeSoleil, u.pctClasseSoleil)), td(u.ombre == null ? '–' : `${nb(u.ombre, 1)} °C`), td(cl(u.classeOmbre, u.pctClasseOmbre))); }),
        'table-utci-tranches'));
  }
  out.push(h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: () => {
    const nom = periode.normalize('NFD').replace(/\p{M}/gu, '').replace(/[^0-9a-z-]+/gi, '-');
    telecharger(`atlas-hdv-tranches-temperature-${nom}.csv`, csvTranches(R, `${mention({ court: true, annee: true })} Tranches de température, ${periode}.`), 'text/csv;charset=utf-8');
  } }, 'CSV des tranches (heures, jours, années, mois, vent)')));
  out.push(h('p', { class: 'mention-stats', 'data-garder': '' }, `${E.epw ? `Fichier EPW${R.typique ? ' (année type : pas de détail année par année)' : ''} ; ` : 'Météo-France, station 44020001 Nantes-Bouguenais ; '}borne inférieure incluse, supérieure exclue ; journée = jour civil de Paris, au moins 20 h de mesures ; ${entier(R.joursValides)} journées valides, ${entier(R.heuresT)} heures.`));
  return out.filter(Boolean);
}
