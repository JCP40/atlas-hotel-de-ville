import * as THREE from 'three';
import { h, info, MOIS } from './util.js';
import { lignesLocales, polygonesLocaux } from './geo.js';
import { COULEURS, visibiliteBatiment, ATTRIBUTION_ARBRES } from './maquette.js';
import { telecharger } from './donnees.js';
import { chargerMeteo, source as sourceMeteo } from './meteo.js';
import { COULEURS_FLUX } from './flux.js';
import { pdfImages } from './pdf.js';
import { donneesRoses, svgRose } from './roses-saisons.js';
import { grader, rgb } from './legende.js';

// Planche à l'échelle (onglet Export, 22/10/2026 ; cadrages et échelles libres le 30/10/2026) : vue du dessus orthographique
// centrée sur le centre de la maquette (repère local 0, 0), sur un format papier réel : carré 500 × 500 mm (défaut), A3, A2, A1
// paysage ou personnalisé (les carrés 450 et 400 mm ont été retirés : un réglage mémorisé qui les citait retombe sur 500 × 500).
// - Ce que je montre (reglages.forme) : « rond » = vue maquette ronde (cercle de reglages.rayon, défaut config.rayonPlateau) ;
//   « rectangle » = rectangle qui remplit la feuille moins la marge ; « carre » = carré de côté min(W, H) − 2 marges.
// - Échelle : 1/50, 1/100, 1/150, 1/200, 1/500 (défaut), 1/1000, 1/1500, 1/2000 ou saisie libre 1/n (n entier de 10 à 20 000).
// - Rond qui ne tient pas : « Rogner » (échelle exacte, cercle coupé par les bords), « Ajuster l'échelle » (échelle calculée,
//   écrite sur la planche), « Réduire le cercle » (échelle exacte, rayon affiché réduit, sans toucher config.rayonPlateau).
//   Rectangle et carré tiennent toujours (l'emprise au sol suit l'échelle) ; alerte si l'emprise sort des données (rayonEtude).
// - Mise en page : rond sur format carré → cadres dans les coins (légende de l'analyse en bas à gauche, éléments en haut à gauche,
//   réseaux et sources en haut à droite, cartouche en bas à droite ; avec les 4 roses : une rose par coin, légendes en bandeaux) ;
//   format allongé (rond ou carré) → bande latérale ; rectangle (et carré sur format carré) → bandeau de légende posé SUR la carte,
//   en bas, sur fond blanc ; sinon, ou sur demande, « légende et cartouche à part » (2e page du PDF, 2e fichier SVG).
// - PDF : rendu orthographique WebGL de la maquette affichée (300 dpi, ou 150 dpi en brouillon, par tuiles de 1024 px), découpé au
//   cercle ou au rectangle, légende et cartouche par-dessus, image JPEG dans un PDF au format papier réel (js/pdf.js) : imprimer en
//   taille réelle. Vue étendue le temps du rendu seulement si le sujet dépasse le plateau de la vue maquette.
// - SVG : viewBox en millimètres papier (1 mm = n / 1000 m) ; bâti, voirie, trottoirs, surfaces, arbres, ombres portées, réseaux,
//   flux, coupes, noms des rues en VECTEURS ; cartes d'analyse (Chaleur, Confort, Soleil, confort au vent) en images incrustées calées
//   (textures des calques, à leur emprise exacte) ; bruit en vecteurs ; légende et cartouche en vecteurs et texte ; un groupe <g id> par
//   calque (Illustrator, InDesign).
// La légende vient de app.legende.decrire() (js/legende.js), les roses de js/roses-saisons.js.
// Diagramme solaire (23/10/2026, case ou mode « Diagramme solaire » de l'outil Soleil) : cadre carré dessiné par
// app.diagrammeSolaire.svgPlanche (coin haut droit, réseaux et sources rejoignant les éléments ; ou en tête de bande / de page 2).
// Cartouche : phase affichée (app.phase.texte(), Existant / Projet). exporterDefaut(type, titre) : réglages par défaut
// (500 × 500 mm, 1/500, rond), utilisé par la barre des études. Réglages du panneau mémorisés (localStorage atlas-hdv-planche).
const FORMATS = [
  ['c500', 'Carré 500 × 500 mm', 500, 500],
  ['a3', 'A3 paysage (420 × 297 mm)', 420, 297], ['a2', 'A2 paysage (594 × 420 mm)', 594, 420], ['a1', 'A1 paysage (841 × 594 mm)', 841, 594],
  ['perso', 'Personnalisé', null, null],
];
const ECHELLES = [50, 100, 150, 200, 500, 1000, 1500, 2000];
const ECHELLE_MIN = 10, ECHELLE_MAX = 20000;
const FORMES = [['rond', 'Vue maquette ronde'], ['rectangle', 'Rectangle ajusté à la feuille'], ['carre', 'Carré ajusté à la feuille']];
const CLE_REGLAGES = 'atlas-hdv-planche';
const MEMORISES = ['format', 'largeur', 'hauteur', 'echelle', 'forme', 'mode', 'marge', 'dpi', 'aPart', 'rayon'];
const echelleValide = (n) => Number.isInteger(n) && n >= ECHELLE_MIN && n <= ECHELLE_MAX;
const LARGEURS = { // comme maquette.js
  primary: 12, secondary: 10, tertiary: 8, residential: 6.5, unclassified: 6, living_street: 5.5,
  pedestrian: 6, service: 4, footway: 2.5, path: 2, cycleway: 2, steps: 2.5, busway: 7,
};
const LARGEUR_TROTTOIR = 2.5;
const POLICE = "'IBM Plex Sans Condensed', 'Arial Narrow', Arial, sans-serif";
const ARDOISE = '#2f3b45';
const hex = (n) => `#${n.toString(16).padStart(6, '0')}`;
const f2 = (v) => Math.round(v * 100) / 100;
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const virgule = (v, d = 0) => v.toFixed(d).replace('.', ',');
const NON_ANALYSE = ['maquette', 'reseaux', 'flux', 'phase']; // sections de la légende automatique qui ne sont pas une analyse (phase : dans le cartouche)

export function creerPlanche(app) {
  // styles des groupes du panneau (30/10/2026), ajoutés par le module comme ceux de css/complements.css
  if (!document.getElementById('styles-planche')) document.head.append(h('style', { id: 'styles-planche' }, `
  .planche-groupe { margin: 8px 0; padding: 4px 8px 6px; border: 1px solid var(--trait); border-radius: 2px; }
  .planche-groupe > legend { padding: 0 4px; font-size: 12px; font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; color: var(--ardoise); }
  .planche-formes { display: grid; gap: 2px; margin: 2px 0 4px; }
  .planche-echelle-libre { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; margin-top: 4px; }
  .planche-echelle-libre input { width: 8em; padding: 4px 6px; border: 1px solid var(--trait); border-radius: 2px; background: #fff; color: var(--ardoise); font: inherit; font-size: 13px; }
  .planche-echelle-libre input[aria-invalid='true'] { border-color: #a33a1f; outline: 1px solid #a33a1f; }
  .planche-erreur { flex-basis: 100%; font-size: 12px; color: #a33a1f; }
  .planche-erreur:empty { display: none; }
  `));
  const reglages = { format: 'c500', largeur: 500, hauteur: 500, echelle: 500, forme: 'rond', mode: 'rogner', marge: 10, aPart: false, roses: null, diagramme: null, dpi: 300, titre: '', rayon: null };
  const DEFAUT = { ...reglages };
  // réglages mémorisés (formats supprimés c400 / c450 → c500 ; valeurs invalides ignorées)
  function lireReglages() {
    let m = null;
    try { m = JSON.parse(localStorage.getItem(CLE_REGLAGES) || 'null'); } catch { m = null; }
    if (!m || typeof m !== 'object') return;
    if (typeof m.format === 'string') reglages.format = FORMATS.some((f) => f[0] === m.format) ? m.format : 'c500';
    for (const c of ['largeur', 'hauteur']) if (Number.isFinite(+m[c]) && +m[c] >= 150 && +m[c] <= 1500) reglages[c] = Math.round(+m[c]);
    if (echelleValide(+m.echelle)) reglages.echelle = +m.echelle;
    if (FORMES.some((f) => f[0] === m.forme)) reglages.forme = m.forme;
    if (['rogner', 'ajuster', 'reduire'].includes(m.mode)) reglages.mode = m.mode;
    if (Number.isFinite(+m.marge) && +m.marge >= 0 && +m.marge <= 60) reglages.marge = +m.marge;
    if (+m.dpi === 150 || +m.dpi === 300) reglages.dpi = +m.dpi;
    if (typeof m.aPart === 'boolean') reglages.aPart = m.aPart;
    if (m.rayon == null || (Number.isFinite(+m.rayon) && +m.rayon >= 10 && +m.rayon <= 600)) reglages.rayon = m.rayon == null ? null : +m.rayon;
  }
  function memoriser() {
    try { localStorage.setItem(CLE_REGLAGES, JSON.stringify(Object.fromEntries(MEMORISES.map((c) => [c, reglages[c]])))); } catch { /* stockage indisponible */ }
  }
  lireReglages();
  const ui = {};
  let dernierOutil = null; // outil ouvert avant l'onglet Export (4 roses par défaut si c'était le Vent)
  app.on('outil', (id) => { if (id && id !== 'exporter') dernierOutil = id; if (id === 'exporter') setTimeout(inserer, 0); });
  const rosesParDefaut = () => !!app.vent?.etat?.quatreSaisons || dernierOutil === 'vent' || app.interface?.ouvert === 'vent';
  const avecRoses = () => (reglages.roses ?? rosesParDefaut());
  const avecDiagramme = () => !!app.diagrammeSolaire && (reglages.diagramme ?? !!app.diagrammeSolaire.etat.visible);

  // ------------------------------------------------------------
  // Mise en page (mm)
  // ------------------------------------------------------------
  // L.sujet : { forme: 'rond', cx, cy, r } ou { forme: 'rectangle' | 'carre', x, y, w, h } (mm papier) ; L.Rcouv : rayon (m) qui couvre
  // le sujet depuis le centre de la maquette ; L.dedans(x, z, d) : point local (m) dans le sujet, à d m du bord au moins.
  function mise() {
    const r = reglages;
    const F = FORMATS.find((x) => x[0] === r.format) || FORMATS[0];
    const W = F[2] ?? Math.min(1500, Math.max(150, +r.largeur || 500)), H = F[3] ?? Math.min(1500, Math.max(150, +r.hauteur || 500));
    const forme = FORMES.some((f) => f[0] === r.forme) ? r.forme : 'rond';
    const echelleDemandee = echelleValide(+r.echelle) ? +r.echelle : 500;
    const Rm = Math.max(10, +reglages.rayon || app.config.rayonPlateau); // rayon du cercle (m) : plateau de l'atlas par défaut
    const roses = avecRoses();
    const diag = avecDiagramme() && !roses;
    const m = 8; // marge des cadres au bord du papier
    const alertes = [];
    const allonge = W / H >= 1.25 || H / W >= 1.25;
    // rond : coins (format carré) ou bande ; carré : bande (format allongé) ou bandeau sur la carte ; rectangle : bandeau sur la carte
    let type = r.aPart ? 'apart' : forme === 'rectangle' ? 'surcarte' : allonge ? 'bande' : forme === 'carre' ? 'surcarte' : 'coins';
    const paysage = W >= H;
    const zone = type === 'bande' ? (paysage ? { x: 0, y: 0, w: H, h: H } : { x: 0, y: 0, w: W, h: W }) : { x: 0, y: 0, w: W, h: H };
    let echelle = echelleDemandee, Raff = Rm, k = 1000 / echelle, tient = true, sujet, cx, cy, Rcouv;
    if (forme === 'rond') {
      cx = zone.x + zone.w / 2; cy = zone.y + zone.h / 2;
      const dispo = Math.min(zone.w, zone.h) / 2 - r.marge;
      tient = Rm * k <= dispo + 1e-6;
      if (!tient) {
        const ech = Math.ceil((Rm * 1000) / dispo / 10) * 10;
        if (r.mode === 'ajuster') {
          echelle = ech; k = 1000 / echelle;
          alertes.push(`Échelle ajustée au 1/${echelle} pour que le cercle de ${2 * Rm} m tienne avec ${r.marge} mm de marge : ce n'est plus le 1/${echelleDemandee} (l'échelle écrite sur la planche est la vraie).`);
        } else if (r.mode === 'reduire') {
          Raff = Math.max(1, Math.floor(dispo / k));
          alertes.push(`1/${echelle} exact, cercle affiché réduit à ${2 * Raff} m de diamètre (${virgule(2 * Raff * k)} mm) au lieu de ${2 * Rm} m ; le plateau de l'atlas n'est pas modifié.`);
        } else {
          alertes.push(`1/${echelle} exact : le cercle de ${2 * Rm} m fait ${virgule(2 * Rm * k)} mm et dépasse les ${Math.round(Math.min(zone.w, zone.h))} mm disponibles : il est rogné par les bords.`);
        }
        const fmt = FORMATS.find((x) => x[2] && Math.min(x[2], x[3]) >= 2 * Rm * k + 2 * r.marge && x[0] !== 'perso');
        const plusPetite = ECHELLES.find((e) => e >= ech);
        alertes.push(`Pour un cercle entier au 1/${echelleDemandee} : format ${fmt ? fmt[1] : `d'au moins ${Math.ceil(2 * Rm * k + 2 * r.marge)} mm de côté`} ; sur ce format, échelle 1/${ech} au plus grand${plusPetite && plusPetite !== ech ? ` (1/${plusPetite} dans la liste)` : ''} ; ou « Rectangle » / « Carré » pour remplir la feuille à l'échelle exacte.`);
      }
      sujet = { forme, cx, cy, r: Raff * k };
      Rcouv = Raff;
    } else {
      const ix = zone.x + r.marge, iy = zone.y + r.marge, iw = Math.max(20, zone.w - 2 * r.marge), ih = Math.max(20, zone.h - 2 * r.marge);
      const w = forme === 'carre' ? Math.min(iw, ih) : iw, hh = forme === 'carre' ? Math.min(iw, ih) : ih;
      sujet = { forme, x: ix + (iw - w) / 2, y: iy + (ih - hh) / 2, w, h: hh };
      cx = sujet.x + w / 2; cy = sujet.y + hh / 2;
      Rcouv = Math.hypot(w, hh) / 2 / k;
    }
    const Rmm = Raff * k;
    const lx = forme === 'rond' ? Raff : sujet.w / 2 / k, lz = forme === 'rond' ? Raff : sujet.h / 2 / k; // demi-emprise au sol (m)
    const etude = app.config.rayonEtude || 420;
    if (Rcouv > etude) alertes.push(`L'emprise (${forme === 'rond' ? `cercle de ${2 * Raff} m` : `${Math.round(2 * lx)} × ${Math.round(2 * lz)} m`}) sort du périmètre d'étude de ${etude} m : bâti, voirie et réseaux peuvent manquer près des bords.`);
    const dedans = (x, z, d = 0) => (forme === 'rond' ? Math.hypot(x, z) < Raff - d : Math.abs(x) < lx - d && Math.abs(z) < lz - d);
    if (avecDiagramme() && roses) alertes.push('Diagramme solaire non placé avec les 4 roses des vents : décocher l\'une des deux options.');
    const L = { W, H, k, echelle, echelleDemandee, forme, sujet, Rm, Raff, Rmm, Rcouv, lx, lz, dedans, cx, cy, zone, type, roses, diagramme: diag, alertes, cadres: {}, page2: null, mode: r.mode, tient, fond: null };
    const pageAPart = () => {
      L.type = 'apart'; L.cadres = {}; L.page2 = cadresPage2(W, H, roses, m, diag);
      L.cadres.nord = { x: W - m - 60, y: H - m - 16, w: 60, h: 16 };
      if (forme !== 'rond') L.fond = { x: L.cadres.nord.x - 3, y: L.cadres.nord.y - 3, w: 66, h: 22 };
    };
    const surCarte = () => {
      // bandeau de légende posé sur le bas de la carte, sur fond blanc (roses, analyse, éléments, réseaux, cartouche de gauche à droite)
      L.type = 'surcarte';
      const hb = Math.min(110, Math.max(55, H * 0.17)) + (roses ? 10 : 0);
      const b = { x: m + 3, y: H - m - 3 - hb, w: W - 2 * m - 6, h: hb };
      if (b.w < 240) { alertes.push('Feuille trop étroite pour un bandeau de légende sur la carte : légende et cartouche sur une 2e page.'); pageAPart(); return; }
      Object.assign(L.cadres, colonne(b, roses, diag));
      L.fond = { x: b.x - 3, y: b.y - 3, w: b.w + 6, h: b.h + 6 };
    };
    const R3 = Rmm + 3, disc = (cx + cy) ** 2 - 2 * (cx * cx + cy * cy - R3 * R3);
    if (type === 'coins' && (disc < 0 || (!tient && r.mode === 'rogner'))) {
      // cercle rogné par les bords (grande échelle) : coins pris par la carte, bandeau de légende sur la carte
      surCarte();
    } else if (type === 'coins') {
      // côté des cadres de coin : le coin intérieur du cadre reste hors du cercle (3 mm d'écart)
      const s = ((cx + cy) - Math.sqrt(disc)) / 2;
      const c = s - m;
      const coins = { hg: { x: m, y: m, w: c, h: c }, hd: { x: W - m - c, y: m, w: c, h: c }, bg: { x: m, y: H - m - c, w: c, h: c }, bd: { x: W - m - c, y: H - m - c, w: c, h: c } };
      if (!roses && c >= 55) Object.assign(L.cadres, diag ? { elements: coins.hg, diagramme: coins.hd, analyse: coins.bg, cartouche: coins.bd } : { elements: coins.hg, reseaux: coins.hd, analyse: coins.bg, cartouche: coins.bd });
      else if (roses && c >= 45) {
        const bh = cy - Rmm - 2 - m; // hauteur des bandeaux haut et bas (entre les coins)
        const bx = m + c + 4, bw = W - 2 * (m + c + 4);
        if (bh >= 20 && bw >= 120) {
          L.cadres.roses = [coins.hg, coins.hd, coins.bg, coins.bd];
          L.cadres.elements = { x: bx, y: m, w: bw * 0.62, h: bh };
          L.cadres.reseaux = { x: bx + bw * 0.62 + 3, y: m, w: bw * 0.38 - 3, h: bh };
          L.cadres.analyse = { x: bx, y: H - m - bh, w: bw * 0.45, h: bh };
          L.cadres.cartouche = { x: bx + bw * 0.45 + 3, y: H - m - bh, w: bw * 0.55 - 3, h: bh };
        } else { alertes.push('Bandeaux trop étroits pour la légende et le cartouche avec les 4 roses : ils passent sur une 2e page.'); pageAPart(); }
      } else { alertes.push(`Coins trop petits (${Math.round(Math.max(c, 0))} mm) pour la légende et le cartouche : ils passent sur une 2e page.`); pageAPart(); }
    } else if (type === 'bande') {
      const b = paysage ? { x: zone.w + 4, y: m, w: W - zone.w - 4 - m, h: H - 2 * m } : { x: m, y: zone.h + 4, w: W - 2 * m, h: H - zone.h - 4 - m };
      if (Math.min(b.w, b.h) < 60) { alertes.push('Bande latérale trop étroite : légende et cartouche sur une 2e page.'); pageAPart(); } else Object.assign(L.cadres, colonne(b, roses, diag));
    } else if (type === 'surcarte') surCarte();
    else pageAPart();
    return L;
  }
  // bande ou page de légende : roses (2 × 2) en haut, légendes, cartouche en bas
  function colonne(b, roses, diag = false) {
    const C = {};
    let y = b.y;
    const large = b.w > b.h * 1.3; // bande horizontale (format portrait) ou page entière
    let decal = 0;
    if (diag) {
      const cote = Math.min(large ? b.h : b.w, 90);
      C.diagramme = { x: b.x, y, w: cote, h: cote };
      if (large) decal = cote + 4; else y += cote + 6;
    }
    if (roses) {
      const cote = Math.min(large ? b.h * 0.5 : b.w / 2 - 2, 80);
      C.roses = [0, 1, 2, 3].map((i) => (large ? { x: b.x + i * (cote + 3), y, w: cote, h: cote } : { x: b.x + (i % 2) * (cote + 4), y: y + Math.floor(i / 2) * (cote + 3), w: cote, h: cote }));
      if (!large) y += 2 * cote + 8;
    }
    const hc = Math.min(70, b.h * 0.3);
    if (large) {
      const x0 = (roses ? b.x + 4 * (Math.min(b.h * 0.5, 80) + 3) : b.x) + decal;
      const w = b.x + b.w - x0;
      C.analyse = { x: x0, y: b.y, w: w * 0.3, h: b.h };
      C.elements = { x: x0 + w * 0.3 + 3, y: b.y, w: w * 0.25, h: b.h };
      C.reseaux = { x: x0 + w * 0.55 + 6, y: b.y, w: w * 0.2, h: b.h };
      C.cartouche = { x: x0 + w * 0.75 + 9, y: b.y, w: w * 0.25 - 9, h: b.h };
      return C;
    }
    const reste = b.y + b.h - hc - 4 - y;
    C.analyse = { x: b.x, y, w: b.w, h: reste * 0.4 };
    C.elements = { x: b.x, y: y + reste * 0.4 + 2, w: b.w, h: reste * 0.35 };
    C.reseaux = { x: b.x, y: y + reste * 0.75 + 4, w: b.w, h: reste * 0.25 - 4 };
    C.cartouche = { x: b.x, y: b.y + b.h - hc, w: b.w, h: hc };
    return C;
  }
  function cadresPage2(W, H, roses, m, diag = false) {
    const b = { x: m + 4, y: m + 4, w: W - 2 * m - 8, h: H - 2 * m - 8 };
    const C = {};
    let y = b.y;
    if (diag) {
      const cote = Math.min(b.w * 0.45, b.h * 0.4, 130);
      C.diagramme = { x: b.x, y, w: cote, h: cote };
      y += cote + 8;
    }
    if (roses) {
      const cote = Math.min((b.w - 9) / 4, 85);
      C.roses = [0, 1, 2, 3].map((i) => ({ x: b.x + i * (cote + 3), y, w: cote, h: cote }));
      y += cote + 8;
    }
    const hc = Math.min(80, (b.h - (y - b.y)) * 0.35);
    const reste = b.y + b.h - hc - 6 - y;
    C.analyse = { x: b.x, y, w: b.w * 0.5 - 3, h: reste };
    C.elements = { x: b.x + b.w * 0.5 + 3, y, w: b.w * 0.5 - 3, h: reste * 0.55 };
    C.reseaux = { x: b.x + b.w * 0.5 + 3, y: y + reste * 0.55 + 3, w: b.w * 0.5 - 3, h: reste * 0.45 - 3 };
    C.cartouche = { x: b.x, y: b.y + b.h - hc, w: b.w, h: hc };
    return C;
  }

  // ------------------------------------------------------------
  // Légendes et cartouche (SVG, unités mm)
  // ------------------------------------------------------------
  let nGrad = 0;
  const lignesDe = (t, w, p) => { // coupure approximative (largeur moyenne d'un caractère ≈ 0,5 corps)
    const max = Math.max(8, Math.floor(w / (p * 0.5)));
    const mots = String(t).split(/\s+/), L = [];
    let l = '';
    for (const m of mots) { if ((l ? `${l} ${m}` : m).length > max && l) { L.push(l); l = m; } else l = l ? `${l} ${m}` : m; }
    if (l) L.push(l);
    return L;
  };
  function pastille(it, x, y, p) {
    const c = rgb(it.couleur), w = p * 2, hh = p * 1.05, yc = y - p * 0.35;
    switch (it.forme) {
      case 'trait': return `<path d="M${f2(x)} ${f2(yc)}h${f2(w)}" stroke="${c}" stroke-width="${f2(p * 0.35)}"/>`;
      case 'tirets': return `<path d="M${f2(x)} ${f2(yc)}h${f2(w)}" stroke="${c}" stroke-width="${f2(p * 0.35)}" stroke-dasharray="${f2(p * 0.5)} ${f2(p * 0.3)}"/>`;
      case 'cercle': return `<circle cx="${f2(x + w / 2)}" cy="${f2(yc)}" r="${f2(hh / 2)}" fill="${c}" stroke="#7d9a62" stroke-width="0.12"/>`;
      case 'carre': return `<rect x="${f2(x + w / 2 - hh / 2)}" y="${f2(yc - hh / 2)}" width="${f2(hh)}" height="${f2(hh)}" fill="${c}"/>`;
      case 'contour': return `<rect x="${f2(x)}" y="${f2(yc - hh / 2)}" width="${f2(w)}" height="${f2(hh)}" fill="${c}" stroke="${ARDOISE}" stroke-width="0.18"/>`;
      default: return `<rect x="${f2(x)}" y="${f2(yc - hh / 2)}" width="${f2(w)}" height="${f2(hh)}" fill="${c}"/>`;
    }
  }
  // sections → lignes, réparties en colonnes dans le cadre ; corps réduit (jusqu'à 2 mm) si la place manque
  function blocLegende(box, sections, id, p0 = 2.8) {
    if (!box || !sections.length) return { svg: '', deborde: false };
    for (let p = p0; p >= 1.99; p -= 0.2) {
      for (let nc = 1; nc <= 4; nc++) {
        const ecart = 3, cw = (box.w - (nc - 1) * ecart) / nc;
        if (cw < 30 && nc > 1) break;
        const lh = p * 1.32;
        const blocs = [];
        for (const s of sections) {
          const t = lignesDe(s.titre, cw, p * 1.02);
          blocs.push({ type: 'titre', l: t, hh: t.length * lh + p * 0.25 });
          if (s.degrade) blocs.push({ type: 'degrade', D: s.degrade, hh: p * 3.9 });
          for (const it of s.items || []) { const l = lignesDe(it.libelle, cw - p * 2.6, p); blocs.push({ type: 'item', it, l, hh: l.length * lh }); }
          if (s.note) { const l = lignesDe(s.note, cw, p * 0.88); blocs.push({ type: 'note', l, hh: l.length * lh * 0.9 }); }
          blocs.push({ type: 'espace', hh: p * 0.6 });
        }
        let col = 0, y = 0, ok = true;
        const pos = [];
        blocs.forEach((b, i) => { if (b.type === 'titre' && blocs[i + 1]) b.suite = blocs[i + 1].hh; }); // un titre reste avec la ligne qui le suit
        for (const b of blocs) {
          if (b.type === 'espace' && y === 0) { pos.push(null); continue; }
          if (y + b.hh + (b.suite || 0) > box.h && y > 0) { col++; y = 0; if (b.type === 'espace') { pos.push(null); continue; } }
          if (col >= nc || b.hh > box.h) { ok = false; break; }
          pos.push({ x: box.x + col * (cw + ecart), y: box.y + y });
          y += b.hh;
        }
        if (!ok) continue;
        const o = [];
        blocs.forEach((b, i) => {
          const q = pos[i];
          if (!q) return;
          const yb = q.y + p;
          if (b.type === 'titre') b.l.forEach((l, j) => o.push(`<text x="${f2(q.x)}" y="${f2(yb + j * lh)}" font-size="${f2(p * 1.02)}" font-weight="600" fill="${ARDOISE}">${xml(l)}</text>`));
          else if (b.type === 'item') {
            o.push(pastille(b.it, q.x, yb, p));
            b.l.forEach((l, j) => o.push(`<text x="${f2(q.x + p * 2.6)}" y="${f2(yb + j * lh)}" font-size="${f2(p)}" fill="${ARDOISE}">${xml(l)}</text>`));
          } else if (b.type === 'note') b.l.forEach((l, j) => o.push(`<text x="${f2(q.x)}" y="${f2(yb + j * lh * 0.9)}" font-size="${f2(p * 0.88)}" fill="#5b6770">${xml(l)}</text>`));
          else if (b.type === 'degrade') {
            const D = b.D, gid = `${id}-degrade-${++nGrad}`, bw = Math.min(cw, 90), by = q.y + p * 0.2;
            o.push(`<defs><linearGradient id="${gid}" x1="0" x2="1" y1="0" y2="0">${D.stops.map(([u, c]) => `<stop offset="${f2(u)}" stop-color="${rgb(c)}"/>`).join('')}</linearGradient></defs>`,
              `<rect x="${f2(q.x)}" y="${f2(by)}" width="${f2(bw)}" height="${f2(p * 1.1)}" fill="url(#${gid})" stroke="#8a949b" stroke-width="0.12"/>`);
            const G = grader(D.graduations, 0.16);
            G.forEach((g, j) => {
              const x = q.x + g.u * bw, ancre = j === 0 ? 'start' : j === G.length - 1 ? 'end' : 'middle';
              o.push(`<path d="M${f2(x)} ${f2(by + p * 1.1)}v${f2(p * 0.4)}" stroke="${ARDOISE}" stroke-width="0.12"/>`,
                `<text x="${f2(x)}" y="${f2(by + p * 2.45)}" font-size="${f2(p * 0.85)}" text-anchor="${ancre}" fill="${ARDOISE}">${xml(g.texte)}</text>`);
            });
            if (D.gauche || D.droite) {
              o.push(`<text x="${f2(q.x)}" y="${f2(by + p * 3.45)}" font-size="${f2(p * 0.78)}" fill="#5b6770">${xml(D.gauche || '')}</text>`,
                `<text x="${f2(q.x + bw)}" y="${f2(by + p * 3.45)}" font-size="${f2(p * 0.78)}" text-anchor="end" fill="#5b6770">${xml(D.droite || '')}</text>`);
            }
          }
        });
        return { svg: `<g id="${id}">${o.join('')}</g>`, deborde: false };
      }
    }
    return { svg: `<g id="${id}"><text x="${f2(box.x)}" y="${f2(box.y + 3)}" font-size="2.4" fill="#a5281b">${xml('Légende trop longue pour ce cadre : choisir « légende et cartouche à part ».')}</text></g>`, deborde: true };
  }

  function nord(x, y, t) {
    return `<g id="nord"><circle cx="${f2(x)}" cy="${f2(y)}" r="${f2(t * 0.55)}" fill="none" stroke="${ARDOISE}" stroke-width="0.2"/>`
      + `<path d="M${f2(x)} ${f2(y - t * 0.5)}L${f2(x + t * 0.17)} ${f2(y + t * 0.12)}L${f2(x)} ${f2(y)}L${f2(x - t * 0.17)} ${f2(y + t * 0.12)}Z" fill="${ARDOISE}"/>`
      + `<text x="${f2(x)}" y="${f2(y + t * 0.42)}" font-size="${f2(t * 0.3)}" text-anchor="middle" fill="${ARDOISE}">N</text></g>`;
  }
  function echelleGraphique(x, y, wMax, k, p) {
    const Ls = [1000, 500, 200, 100, 50, 40, 20, 10, 5, 2, 1].find((l) => l * k <= wMax) || 1;
    const w = Ls * k, o = [];
    for (let i = 0; i < 4; i++) o.push(`<rect x="${f2(x + (i * w) / 4)}" y="${f2(y)}" width="${f2(w / 4)}" height="${f2(p * 0.55)}" fill="${i % 2 ? '#fff' : ARDOISE}" stroke="${ARDOISE}" stroke-width="0.15"/>`);
    for (const [u, t] of [[0, '0'], [0.5, `${Ls / 2}`], [1, `${Ls} m`]]) o.push(`<text x="${f2(x + u * w)}" y="${f2(y + p * 1.6)}" font-size="${f2(p * 0.85)}" text-anchor="${u === 0 ? 'start' : u === 1 ? 'end' : 'middle'}" fill="${ARDOISE}">${t}</text>`);
    return `<g id="echelle-graphique" data-longueur-m="${Ls}" data-longueur-mm="${f2(w)}">${o.join('')}</g>`;
  }
  function texteSourceMeteo() {
    try { const s = sourceMeteo(); return `${s.libelle}${s.periode ? `, ${s.periode}` : ''}`; } catch { return 'Météo-France, Nantes-Bouguenais'; }
  }
  function cartouche(box, L) {
    if (!box) return '';
    const auteurConfig = document.querySelector('.cartouche .auteur')?.textContent.trim() || 'Jean-Charles Poullain, L3 FPC, ENSA Nantes, 2026-2027';
    const d = new Date();
    const titre = reglages.titre || titreDefaut();
    for (let p = 2.9; p >= 1.99; p -= 0.15) {
      const o = [];
      const lh = p * 1.3, wt = box.w - p * 5;
      let y = box.y + p * 1.5;
      const T = lignesDe(titre, wt, p * 1.5);
      T.forEach((l) => { o.push(`<text x="${f2(box.x)}" y="${f2(y)}" font-size="${f2(p * 1.5)}" font-weight="700" fill="${ARDOISE}">${xml(l)}</text>`); y += p * 1.75; });
      const lignes = [
        [auteurConfig, 600], ['Projet « Inclusion dans la ville historique », Françoise Coulon', 400],
        [`${d.getDate()} ${MOIS[d.getMonth()]} ${d.getFullYear()} · échelle 1/${L.echelle}${L.echelle !== L.echelleDemandee ? ' (ajustée)' : ''} · ${L.W} × ${L.H} mm`, 600],
        [`Imprimer en taille réelle (100 %). ${emprise(L)}.`, 400],
        [`Météo : ${texteSourceMeteo()}.`, 400],
      ];
      const phase = app.phase?.texte?.();
      if (phase) lignes.splice(2, 0, [phase, 600]);
      for (const [t, g] of lignes) for (const l of lignesDe(t, box.w, p)) { o.push(`<text x="${f2(box.x)}" y="${f2(y)}" font-size="${f2(p)}" font-weight="${g}" fill="${ARDOISE}">${xml(l)}</text>`); y += lh; }
      y += p * 0.3;
      const t = Math.min(p * 4.2, 14);
      o.push(echelleGraphique(box.x, y, Math.min(box.w - t - 6, 90), L.k, p));
      o.push(nord(box.x + box.w - t * 0.6, box.y + t * 0.6, t));
      if (y + p * 1.8 <= box.y + box.h) return `<g id="cartouche">${o.join('')}</g>`;
    }
    return `<g id="cartouche"><text x="${f2(box.x)}" y="${f2(box.y + 3)}" font-size="2.4" fill="#a5281b">${xml('Cartouche trop long pour ce cadre.')}</text></g>`;
  }
  // emprise représentée, en clair (cartouche, résumé du panneau)
  function emprise(L) {
    if (L.forme === 'rond') return `Cercle de ${2 * L.Raff} m${L.Raff !== L.Rm ? ` (réduit, plateau ${2 * L.Rm} m)` : ''}${!L.tient && L.mode === 'rogner' ? ', rogné par les bords' : ''}`;
    return `${L.forme === 'carre' ? 'Carré' : 'Rectangle'} de ${virgule(2 * L.lx, L.lx < 50 ? 1 : 0)} × ${virgule(2 * L.lz, L.lz < 50 ? 1 : 0)} m centré sur la maquette`;
  }
  function titreDefaut() {
    const a = app.legende?.decrire?.().find((s) => !NON_ANALYSE.includes(s.id));
    return `Hôtel de Ville de Nantes — ${a ? a.titre.replace(/^Chaleur : /, '') : 'plan du site'}`;
  }
  function sectionsSources() {
    return [{ id: 'sources', titre: 'Sources', note: `Bâti, voirie : OpenStreetMap (ODbL), BD TOPO, BD ORTHO et LiDAR HD de l'IGN (Licence Ouverte 2.0) ; cadastre et PSMV de Nantes ; réseaux GRDF et Enedis (Licence Ouverte 2.0) ;${app.couches.arbres === false ? '' : app.donnees.arbresNantes?.features?.length ? ` arbres : ${ATTRIBUTION_ARBRES}, compléments OpenStreetMap ;` : ' arbres : OpenStreetMap ;'} météo : ${texteSourceMeteo()}. Analyses : estimations pédagogiques (ordres de grandeur).` }];
  }
  function rosesSvg(boxes) {
    if (!boxes) return '';
    const D = donneesRoses();
    return `<g id="roses-des-vents">${D.saisons.map((s, i) => {
      const b = boxes[i];
      if (!b) return '';
      const p = Math.min(3, b.w / 26), R = Math.min(b.w / 2 - p * 1.6, (b.h - p * 4) / 2 - p * 1.4);
      return `<g id="rose-${s.cle}">${svgRose(s, D.axe, { cx: b.x + b.w / 2, cy: b.y + p * 1.5 + R, R, p, actif: s.cle === D.ventee })}</g>`;
    }).join('')}<text x="${f2(boxes[0].x)}" y="${f2(boxes[0].y - 1)}" font-size="2" fill="#5b6770">${xml(`Roses des vents (12 secteurs, même échelle : ${D.axe} % au bord ; foncé : > 5 m/s ; flèche : dominant). ${D.source}.`)}</text></g>`;
  }

  // ------------------------------------------------------------
  // Carte en vecteurs (mm)
  // ------------------------------------------------------------
  function carteVecteurs(L) {
    const { k, cx, cy } = L;
    const X = (x) => f2(cx + x * k), Y = (z) => f2(cy + z * k);
    const lim = L.Rcouv + 25;
    const limX = L.lx + 25, limZ = L.lz + 25;
    const proche = (pts) => pts.some(([x, z]) => Math.abs(x) < limX && Math.abs(z) < limZ);
    const chemin = (pts, ferme) => `M${pts.map(([x, z]) => `${X(x)} ${Y(z)}`).join('L')}${ferme ? 'Z' : ''}`;
    const aff = (c) => app.couches[c] !== false;
    const G = [];
    const groupe = (id, contenu, attrs = '') => { if (contenu) G.push(`<g id="${id}"${attrs}>${contenu}</g>`); };
    const osm = app.donnees?.osm || {};
    // surfaces OSM
    const surf = { pietonne: [], parking: [], voirie: [], vegetal: [], eau: [] };
    for (const f of osm.surfaces?.features || []) {
      const s = f.properties?.surface;
      if (!surf[s]) continue;
      for (const [ext, ...trous] of polygonesLocaux(f.geometry, app.proj)) if (proche(ext)) surf[s].push(chemin(ext, true) + trous.map((t) => chemin(t, true)).join(''));
    }
    const pathSurf = (liste, couleur) => (liste.length ? `<path d="${liste.join('')}" fill="${couleur}" fill-rule="evenodd"/>` : '');
    if (aff('maqTrottoirs')) groupe('places-pietonnes', pathSurf(surf.pietonne, hex(COULEURS.cheminement)));
    // voirie : trottoirs (bande de 2,5 m de part et d'autre des chaussées, chemins) puis chaussées
    const parLargeur = (liste) => { const m = new Map(); for (const { pts, w } of liste) { if (!m.has(w)) m.set(w, []); m.get(w).push(chemin(pts)); } return m; };
    const traits = (m, couleur) => [...m].map(([w, d]) => `<path d="${d.join('')}" fill="none" stroke="${couleur}" stroke-width="${f2(w * k)}" stroke-linecap="round" stroke-linejoin="round"/>`).join('');
    const chaussees = [], trottoirs = [];
    for (const f of osm.voirie?.features || []) {
      const p = f.properties || {}, hw = p.highway;
      if (!hw || p.tunnel === 'yes' || p.layer < 0) continue;
      const w = LARGEURS[hw] ?? 3;
      for (const pts of lignesLocales(f.geometry, app.proj)) {
        if (pts.length < 2 || !proche(pts)) continue;
        if (w >= 4 && hw !== 'pedestrian') { chaussees.push({ pts, w }); trottoirs.push({ pts, w: w + 2 * LARGEUR_TROTTOIR }); } else trottoirs.push({ pts, w });
      }
    }
    if (aff('maqTrottoirs')) groupe('trottoirs', traits(parLargeur(trottoirs), hex(COULEURS.cheminement)));
    if (aff('maqChaussees')) groupe('chaussees', pathSurf(surf.voirie, hex(COULEURS.voirie)) + traits(parLargeur(chaussees), hex(COULEURS.voirie)));
    if (aff('maqTrottoirs')) groupe('stationnements', pathSurf(surf.parking, hex(COULEURS.parking)));
    if (aff('maqEspacesVerts')) groupe('espaces-verts', pathSurf(surf.vegetal, hex(COULEURS.vegetal)));
    if (aff('maqEau')) groupe('eau', pathSurf(surf.eau, hex(COULEURS.eau)));
    // analyses : textures des calques au sol (images calées) et bruit (vecteurs)
    groupe('analyse', imagesAnalyse(L), ' opacity="0.92"');
    groupe('bruit', bruitVecteurs(X, Y));
    // bâti effectif visible
    const bati = (app.batiEffectif?.() || app.empreintes || []).filter((e) => visibiliteBatiment({ ...app, vueMaquette: false }, e.cle) && Math.hypot(e.cx, e.cz) < lim + 60)
      .filter((e) => (e.projet ? aff('maqProjet') : e.detail ? aff('maqDetail') : aff('maqBati')));
    // ombres portées (soleil de la barre Soleil), sol supposé plat
    const S = app.soleil?.etat;
    if (S?.altitude > 2) {
      const a = (S.azimut * Math.PI) / 180, t = Math.tan((S.altitude * Math.PI) / 180);
      const o = [];
      for (const e of bati) {
        const L2 = Math.max(0, e.hauteur || 0) / t;
        const dx = -Math.sin(a) * L2, dz = Math.cos(a) * L2;
        for (const [ext] of e.polys) {
          const dep = ext.map(([x, z]) => [x + dx, z + dz]);
          o.push(chemin(dep, true));
          for (let i = 0; i < ext.length; i++) { const p1 = ext[i], p2 = ext[(i + 1) % ext.length]; o.push(chemin([p1, p2, [p2[0] + dx, p2[1] + dz], [p1[0] + dx, p1[1] + dz]], true)); }
        }
      }
      if (aff('arbres')) for (const [lot, l] of Object.entries(app.arbres?.lots || {})) for (const r of l) {
        if (Math.hypot(r.x, r.z) > lim || (lot === 'caduc' && (app.arbres.f ?? 1) < 0.5)) continue; // caducs sans feuilles : pas d'ombre de couronne
        const L3 = ((r.h || 8) * 0.75) / t;
        o.push(`M${X(r.x - Math.sin(a) * L3 + r.d / 2)} ${Y(r.z + Math.cos(a) * L3)}a${f2((r.d / 2) * k)} ${f2((r.d / 2) * k)} 0 1 0 ${f2(-r.d * k)} 0a${f2((r.d / 2) * k)} ${f2((r.d / 2) * k)} 0 1 0 ${f2(r.d * k)} 0Z`);
      }
      groupe('ombres', o.map((d) => `<path d="${d}"/>`).join(''), ` fill="${ARDOISE}" opacity="0.28" data-soleil="${xml(`${app.soleil.libelleDate?.() || ''}, ${virgule(S.heure, 2)} h`)}"`);
    }
    // réseaux souterrains et flux (sous le bâti)
    if (app.couches.reseaux) {
      for (const s of app.reseaux?.souterrains || []) {
        if (!s.visible) continue;
        if (s.points) {
          const d = (s.fc.features || []).filter((f) => f.geometry?.type === 'Point').map((f) => app.proj.pt(f.geometry.coordinates)).filter(([x, z]) => Math.hypot(x, z) < lim)
            .map(([x, z]) => `M${X(x - 1.2)} ${Y(z - 1.2)}h${f2(2.4 * k)}v${f2(2.4 * k)}h${f2(-2.4 * k)}Z`).join('');
          groupe(`reseau-${s.id}`, d ? `<path d="${d}" fill="${s.couleur}"/>` : '');
        } else {
          const d = (s.fc.features || []).filter((f) => f.geometry).flatMap((f) => lignesLocales(f.geometry, app.proj)).filter((p) => p.length > 1 && proche(p)).map((p) => chemin(p)).join('');
          groupe(`reseau-${s.id}`, d ? `<path d="${d}" fill="none" stroke="${s.couleur}" stroke-width="${f2(Math.max(0.25, (s.largeur || 0.5) * k))}" stroke-linecap="round"${s.tirets ? ` stroke-dasharray="${f2(3 * k)} ${f2(2 * k)}"` : ''}/>` : '');
        }
      }
    }
    if (app.couches.flux) {
      for (const mode of ['tram', 'bus']) {
        const d = (osm.lignes?.features || []).filter((f) => (f.properties?.mode === 'tram') === (mode === 'tram')).flatMap((f) => lignesLocales(f.geometry, app.proj)).filter(proche).map((p) => chemin(p)).join('');
        groupe(`flux-${mode}`, d ? `<path d="${d}" fill="none" stroke="${COULEURS_FLUX[mode]}" stroke-width="${f2(2 * k)}" stroke-opacity="0.6" stroke-linecap="round"/>` : '');
      }
    }
    // arbres
    // (caducs sans feuilles à la date de la barre Soleil : contour en tirets, groupe à part)
    if (aff('arbres')) {
      const o = [], nus = [];
      const sansFeuilles = (app.arbres?.f ?? 1) < 0.5;
      for (const [lot, l] of Object.entries(app.arbres?.lots || {})) for (const r of l) {
        if (Math.hypot(r.x, r.z) >= lim) continue;
        (lot === 'caduc' && sansFeuilles ? nus : o).push(`<circle cx="${X(r.x)}" cy="${Y(r.z)}" r="${f2((r.d / 2) * k)}"/>`);
      }
      groupe('arbres', o.join(''), ` fill="${hex(COULEURS.arbre)}" fill-opacity="0.85" stroke="#7d9a62" stroke-width="0.12"`);
      if (nus.length) groupe('arbres-sans-feuilles', nus.join(''), ` fill="none" stroke="#7d9a62" stroke-width="0.15" stroke-dasharray="0.6 0.4"`);
    }
    // bâti existant puis projet
    const coulProjet = app.projet?.etat?.couleurDefaut || getComputedStyle(document.body).getPropertyValue('--projet').trim() || '#5e9384';
    const polys = (e) => e.polys.map(([ext, ...trous]) => chemin(ext, true) + trous.map((t) => chemin(t, true)).join('')).join('');
    groupe('bati', bati.filter((e) => !e.projet).map((e) => `<path d="${polys(e)}"/>`).join(''), ` fill="${hex(COULEURS.maquette)}" fill-rule="evenodd" stroke="${ARDOISE}" stroke-width="0.2" stroke-linejoin="round"`);
    groupe('projet', bati.filter((e) => e.projet).map((e) => `<path d="${polys(e)}" fill="${e.couleur || coulProjet}"/>`).join(''), ` fill-rule="evenodd" stroke="${ARDOISE}" stroke-width="0.3"`);
    // coupes linéaires affichées
    if (app.couches.axes) {
      const o = [];
      for (const c of app.coupes?.liste || []) {
        if (c.type !== 'ligne' || c.visible === false || !c.A || !c.B) continue;
        o.push(`<path d="M${X(c.A.x)} ${Y(c.A.z)}L${X(c.B.x)} ${Y(c.B.z)}" stroke="${hex(COULEURS.coupe)}" stroke-width="0.4" stroke-dasharray="4 1.2 0.8 1.2"/>`,
          `<text x="${X(c.A.x)}" y="${Y(c.A.z)}" font-size="3.5" font-weight="700" fill="${hex(COULEURS.coupe)}" dx="1" dy="-1">${xml(c.id)}</text>`);
      }
      groupe('coupes', o.join(''));
    }
    // noms des rues (étiquettes posées par js/rues.js)
    if (app.couches.rues !== false) {
      const mode = app.vueMaquette ? 'maquette' : 'etendue';
      const o = (app.rues?.poses || []).filter((q) => q.mode === mode && L.dedans(q.x, q.z, 2)).map((q) => {
        let deg = (q.angle * 180) / Math.PI;
        if (deg > 90) deg -= 180; else if (deg < -90) deg += 180;
        return `<text transform="translate(${X(q.x)} ${Y(q.z)}) rotate(${f2(deg)})" font-size="${f2(Math.min(8, Math.max(1.6, q.h * k * 0.62)))}" text-anchor="middle" dominant-baseline="central">${xml(q.texte)}</text>`;
      });
      groupe('noms-rues', o.join(''), ` fill="#4a5660" font-family="${POLICE}" letter-spacing="0.05"`);
    }
    return G.join('');
  }
  // textures d'analyse posées au sol (DataTexture sur un plan) : image calée sur leur emprise
  function calquesAnalyse() {
    const L = [];
    app.scene.traverseVisible((o) => {
      if (!o.isMesh || o.geometry?.type !== 'PlaneGeometry' || !o.material?.map?.isDataTexture || !o.material.map.image?.data) return;
      L.push(o);
    });
    return L;
  }
  function imagesAnalyse(Lm) {
    const o = [];
    const v = new THREE.Vector3();
    for (const m of calquesAnalyse()) {
      const { data, width, height } = m.material.map.image;
      const c = document.createElement('canvas'); c.width = width; c.height = height;
      c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer.slice(data.byteOffset, data.byteOffset + width * height * 4)), width, height), 0, 0);
      m.getWorldPosition(v);
      const { width: gw, height: gh } = m.geometry.parameters;
      o.push(`<image id="analyse-${xml(m.name || 'carte')}" x="${f2(Lm.cx + (v.x - gw / 2) * Lm.k)}" y="${f2(Lm.cy + (v.z - gh / 2) * Lm.k)}" width="${f2(gw * Lm.k)}" height="${f2(gh * Lm.k)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="${c.toDataURL('image/png')}"/>`);
    }
    return o.join('');
  }
  function bruitVecteurs(X, Y) {
    const g = app.scene.children.find((o) => o.name === 'bruit');
    if (!g?.visible || !app.couches.bruit) return '';
    const par = new Map();
    for (const m of g.children) {
      const c = m.userData.classe?.couleur, pos = m.geometry?.getAttribute?.('position');
      if (!c || !pos) continue;
      const idx = m.geometry.index;
      const n = idx ? idx.count : pos.count;
      const d = [];
      for (let i = 0; i < n; i += 3) {
        const t = [0, 1, 2].map((j) => (idx ? idx.getX(i + j) : i + j));
        d.push(`M${t.map((q) => `${X(pos.getX(q))} ${Y(pos.getZ(q))}`).join('L')}Z`);
      }
      par.set(c, (par.get(c) || '') + d.join(''));
    }
    return [...par].map(([c, d]) => `<path d="${d}" fill="${c}" fill-opacity="0.6"/>`).join('');
  }

  // ------------------------------------------------------------
  // SVG de la planche (page 1 : carte et cadres ; page 2 : légende à part)
  // ------------------------------------------------------------
  function svgPlanche(L, { carte = true, page = 1, px = null } = {}) {
    nGrad = 0;
    const W = L.W, H = L.H;
    const taille = px ? `width="${px[0]}" height="${px[1]}"` : `width="${W}mm" height="${H}mm"`;
    const o = [`<svg xmlns="http://www.w3.org/2000/svg" ${taille} viewBox="0 0 ${W} ${H}" font-family="${POLICE}">`,
      `<title>${xml(reglages.titre || titreDefaut())}</title>`,
      `<desc>${xml(`Planche à l'échelle 1/${L.echelle}, ${W} × ${H} mm (1 unité = 1 mm papier = ${virgule(L.echelle / 1000, 1)} m). Atlas du site de l'Hôtel de Ville de Nantes.`)}</desc>`];
    if (page === 1) {
      o.push(`<rect id="papier" x="0" y="0" width="${W}" height="${H}" fill="${carte ? '#ffffff' : 'none'}"/>`);
      const z = L.zone;
      const S = L.sujet, rond = S.forme === 'rond';
      const forme = (attrs) => (rond ? `<circle cx="${f2(S.cx)}" cy="${f2(S.cy)}" r="${f2(S.r)}"${attrs}/>` : `<rect x="${f2(S.x)}" y="${f2(S.y)}" width="${f2(S.w)}" height="${f2(S.h)}"${attrs}/>`);
      const idClip = rond ? 'clip-cercle' : 'clip-cadrage';
      o.push(`<defs><clipPath id="clip-zone"><rect x="${f2(z.x)}" y="${f2(z.y)}" width="${f2(z.w)}" height="${f2(z.h)}"/></clipPath><clipPath id="${idClip}">${forme('')}</clipPath></defs>`);
      if (carte) o.push(`<g id="carte" clip-path="url(#clip-zone)"><g clip-path="url(#${idClip})">${forme(` id="socle" fill="${hex(COULEURS.plateau)}"`)}${carteVecteurs(L)}</g></g>`);
      o.push(`<g id="${rond ? 'cercle' : 'cadrage'}" clip-path="url(#clip-zone)">${forme(` fill="none" stroke="${ARDOISE}" stroke-width="0.35"`)}</g>`);
      if (L.fond) o.push(`<rect id="fond-legende" x="${f2(L.fond.x)}" y="${f2(L.fond.y)}" width="${f2(L.fond.w)}" height="${f2(L.fond.h)}" fill="#ffffff" fill-opacity="0.92" stroke="${ARDOISE}" stroke-width="0.2"/>`);
      if (L.type !== 'apart') o.push(cadresSvg(L.cadres, L));
      else {
        const b = L.cadres.nord;
        o.push(`<g id="nord-echelle">${echelleGraphique(b.x, b.y + 6, 45, L.k, 2.6)}${nord(b.x + b.w - 7, b.y + 6, 12)}</g>`);
        o.push(`<text id="titre-court" x="8" y="${f2(H - 10)}" font-size="3" fill="${ARDOISE}">${xml(`${reglages.titre || titreDefaut()} — 1/${L.echelle} (légende et cartouche : page 2)`)}</text>`);
      }
    } else {
      o.push(`<rect id="papier" x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`, cadresSvg(L.page2, L));
    }
    o.push('</svg>');
    return o.join('');
  }
  function cadresSvg(C, L) {
    if (!C) return '';
    const sec = app.legende?.decrire?.() || [];
    const analyse = sec.filter((s) => !NON_ANALYSE.includes(s.id));
    const elements = sec.filter((s) => s.id === 'maquette');
    const reseaux = [...sec.filter((s) => s.id === 'reseaux' || s.id === 'flux'), ...sectionsSources()];
    const o = [];
    if (C.roses) o.push(rosesSvg(C.roses));
    if (C.diagramme && app.diagrammeSolaire?.svgPlanche) o.push(app.diagrammeSolaire.svgPlanche(C.diagramme));
    if (!C.reseaux) elements.push(...reseaux); // cadre des réseaux pris par le diagramme solaire : réseaux et sources avec les éléments
    o.push(blocLegende(C.analyse, analyse.length ? analyse : [{ id: 'aucune', titre: 'Analyse', note: 'Aucune carte d\'analyse affichée (onglet Ambiance).' }], 'legende-analyse').svg);
    o.push(blocLegende(C.elements, elements, 'legende-elements').svg);
    o.push(blocLegende(C.reseaux, reseaux, 'legende-reseaux-sources', 2.6).svg);
    o.push(cartouche(C.cartouche, L));
    return o.join('');
  }

  // ------------------------------------------------------------
  // Rendu orthographique WebGL (par tuiles) et PDF
  // ------------------------------------------------------------
  function rendreOrtho(ctx, L, s) {
    // rectangle utile : zone de la carte ∩ carré du cercle, en mm puis en pixels
    const z = L.zone, S = L.sujet, rond = S.forme === 'rond';
    const b = rond ? { x: S.cx - S.r, y: S.cy - S.r, w: 2 * S.r, h: 2 * S.r } : S;
    const x0 = Math.max(z.x, b.x), y0 = Math.max(z.y, b.y), x1 = Math.min(z.x + z.w, b.x + b.w), y1 = Math.min(z.y + z.h, b.y + b.h);
    const px0 = Math.floor(x0 * s), py0 = Math.floor(y0 * s), pw = Math.ceil(x1 * s) - px0, ph = Math.ceil(y1 * s) - py0;
    const m = (X) => (X / s - L.cx) / L.k; // pixel → mètres locaux (x) ; même formule en z pour y
    const cam = new THREE.OrthographicCamera(m(px0), m(px0 + pw), -((py0 / s - L.cy) / L.k), -(((py0 + ph) / s - L.cy) / L.k), 1, 4000);
    cam.position.set(0, 2000, 0); cam.up.set(0, 0, -1); cam.lookAt(0, 0, 0); cam.updateProjectionMatrix();
    const r = app.renderer, taille = r.getSize(new THREE.Vector2()), pr = r.getPixelRatio(), brouillard = app.scene.fog;
    // sujet plus grand que le plateau (cercle, ou coin du rectangle) : vue étendue le temps du rendu (la maquette coupée s'arrête au
    // plateau) ; à grande échelle (1/50, 1/100) le rectangle reste dans le plateau et la vue maquette est gardée
    const etendre = app.vueMaquette && L.Rcouv > app.config.rayonPlateau + 0.5;
    if (etendre) app.definirVueMaquette(false);
    const T = 1024;
    ctx.save();
    ctx.beginPath(); ctx.rect(z.x * s, z.y * s, z.w * s, z.h * s); ctx.clip();
    ctx.beginPath();
    if (rond) ctx.arc(S.cx * s, S.cy * s, S.r * s, 0, 2 * Math.PI); else ctx.rect(S.x * s, S.y * s, S.w * s, S.h * s);
    ctx.clip();
    try {
      app.scene.fog = null;
      r.setPixelRatio(1);
      for (let ty = 0; ty < ph; ty += T) {
        for (let tx = 0; tx < pw; tx += T) {
          const tw = Math.min(T, pw - tx), th = Math.min(T, ph - ty);
          r.setSize(tw, th, false);
          cam.setViewOffset(pw, ph, tx, ty, tw, th);
          r.render(app.scene, cam);
          ctx.drawImage(r.domElement, 0, 0, tw, th, px0 + tx, py0 + ty, tw, th);
        }
      }
    } finally {
      app.scene.fog = brouillard;
      r.setPixelRatio(pr);
      r.setSize(taille.x, taille.y);
      if (etendre) app.definirVueMaquette(true);
      ctx.restore();
    }
    return { pw, ph, etendre };
  }
  const chargerImage = (svg) => new Promise((ok, ko) => {
    const img = new Image();
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    img.onload = () => { URL.revokeObjectURL(url); ok(img); };
    img.onerror = () => { URL.revokeObjectURL(url); ko(new Error('image SVG illisible')); };
    img.src = url;
  });
  const versJPEG = (c) => new Promise((ok) => c.toBlob(async (b) => ok(new Uint8Array(await b.arrayBuffer())), 'image/jpeg', 0.9));
  const nomFichier = (L) => `atlas-planche-${L.W}x${L.H}-1-${L.echelle}${L.forme === 'rond' ? '' : `-${L.forme}`}`;
  async function exporterPDF() {
    await chargerMeteo();
    const L = mise();
    const s = reglages.dpi / 25.4, Wpx = Math.round(L.W * s), Hpx = Math.round(L.H * s);
    etat(`Rendu orthographique à ${reglages.dpi} dpi (${Wpx} × ${Hpx} pixels)…`);
    await new Promise((r) => setTimeout(r, 30));
    const c = document.createElement('canvas'); c.width = Wpx; c.height = Hpx;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, Wpx, Hpx);
    const rendu = rendreOrtho(ctx, L, s);
    ctx.drawImage(await chargerImage(svgPlanche(L, { carte: false, px: [Wpx, Hpx] })), 0, 0, Wpx, Hpx);
    const pages = [{ largeur: L.W, hauteur: L.H, jpeg: await versJPEG(c), px: [Wpx, Hpx] }];
    if (L.page2) {
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, Wpx, Hpx);
      ctx.drawImage(await chargerImage(svgPlanche(L, { page: 2, px: [Wpx, Hpx] })), 0, 0, Wpx, Hpx);
      pages.push({ largeur: L.W, hauteur: L.H, jpeg: await versJPEG(c), px: [Wpx, Hpx] });
    }
    c.width = c.height = 1;
    const b = pdfImages(pages, { titre: reglages.titre || titreDefaut(), auteur: 'Jean-Charles Poullain' });
    telecharger(`${nomFichier(L)}.pdf`, b, 'application/pdf');
    etat(`PDF enregistré : ${pages.length} page${pages.length > 1 ? 's' : ''} de ${L.W} × ${L.H} mm au 1/${L.echelle} (${Math.round(b.size / 1e6)} Mo). Imprimer en taille réelle.`);
    return { L, pages: pages.length, octets: b.size, rendu };
  }
  async function exporterSVG() {
    await chargerMeteo();
    const L = mise();
    const svg = svgPlanche(L, { carte: true });
    telecharger(`${nomFichier(L)}.svg`, svg, 'image/svg+xml');
    if (L.page2) setTimeout(() => telecharger(`${nomFichier(L)}-legende.svg`, svgPlanche(L, { page: 2 }), 'image/svg+xml'), 400);
    etat(`SVG enregistré${L.page2 ? ' (planche et légende à part)' : ''} : unités en mm papier, 1/${L.echelle}.`);
    return { L, svg };
  }

  // ------------------------------------------------------------
  // Panneau (bloc inséré dans l'onglet Export)
  // ------------------------------------------------------------
  const etat = (t) => { if (ui.etat) ui.etat.textContent = t; };
  let attente = 0;
  function apercu() {
    clearTimeout(attente);
    attente = setTimeout(async () => {
      if (!ui.apercu?.isConnected) return;
      await chargerMeteo();
      const L = mise();
      ui.perso.hidden = reglages.format !== 'perso';
      ui.rayon.hidden = L.forme !== 'rond';
      ui.modes.hidden = L.forme !== 'rond' || L.tient;
      ui.margeHors.hidden = L.forme === 'rond' && !L.tient;
      for (const i of ui.bloc.querySelectorAll('input[data-cle="marge"]')) if (document.activeElement !== i) i.value = reglages.marge;
      ui.alertes.replaceChildren(...L.alertes.map((t) => h('li', {}, t)));
      ui.alertes.hidden = !L.alertes.length;
      const disposition = { coins: 'Cadres dans les coins.', bande: 'Légende et cartouche en bande latérale.', surcarte: 'Légende et cartouche en bandeau sur la carte (fond blanc).', apart: 'Légende et cartouche sur une 2e page.' }[L.type];
      ui.resume.textContent = `${L.W} × ${L.H} mm au 1/${L.echelle} : ${emprise(L).replace(/^./, (c) => c.toLowerCase())} = ${L.forme === 'rond' ? `${virgule(2 * L.Rmm)} mm` : `${virgule(L.sujet.w)} × ${virgule(L.sujet.h)} mm`} ; 100 m = ${virgule(100 * L.k, 1)} mm. ${disposition}${L.roses ? ' Avec les 4 roses des vents.' : ''}${L.diagramme ? ' Avec le diagramme solaire.' : ''}`;
      const svg = svgPlanche(L, { carte: true });
      for (const im of [ui.apercu, ui.apercu2]) if (im.src.startsWith('blob:')) URL.revokeObjectURL(im.src);
      ui.apercu.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      if (L.page2) ui.apercu2.src = URL.createObjectURL(new Blob([svgPlanche(L, { page: 2 })], { type: 'image/svg+xml' }));
      ui.apercu2.hidden = !L.page2;
    }, 150);
  }
  function construireBloc() {
    const changer = () => { memoriser(); apercu(); };
    const choix = (lib, options, cle, apres) => {
      const sel = h('select', { onchange: (e) => { reglages[cle] = /^\d+$/.test(e.target.value) ? +e.target.value : e.target.value; apres?.(); changer(); } },
        ...options.map(([v, l]) => h('option', { value: v, selected: String(reglages[cle]) === String(v) }, l)));
      return h('label', { class: 'champ' }, h('span', {}, lib), sel);
    };
    const nombre = (lib, cle, min, max) => h('label', { class: 'champ' }, h('span', {}, lib),
      h('input', { type: 'number', min, max, step: 1, value: reglages[cle], 'data-cle': cle, onchange: (e) => { reglages[cle] = Math.min(max, Math.max(min, +e.target.value || reglages[cle])); e.target.value = reglages[cle]; changer(); } }));
    ui.titre = h('input', { type: 'text', value: reglages.titre || titreDefaut(), 'aria-label': 'Titre de la planche', oninput: (e) => { reglages.titre = e.target.value; apercu(); } });
    // 1. Ce que je montre
    const formes = h('div', { class: 'planche-formes', role: 'radiogroup', 'aria-label': 'Ce que je montre' },
      ...FORMES.map(([v, l]) => h('label', { class: 'case' },
        h('input', { type: 'radio', name: 'planche-forme', value: v, checked: reglages.forme === v, onchange: () => { reglages.forme = v; changer(); } }), l)));
    ui.rayon = h('label', { class: 'champ' }, h('span', {}, 'Rayon du cercle (m)'), h('input', { type: 'number', min: 10, max: 600, step: 1, value: reglages.rayon || '', placeholder: `${app.config.rayonPlateau} (plateau de l'atlas)`,
      onchange: (e) => { reglages.rayon = +e.target.value >= 10 ? Math.min(600, Math.round(+e.target.value)) : null; e.target.value = reglages.rayon || ''; changer(); } }));
    // 2. Échelle : liste ou saisie 1/n
    const dansListe = ECHELLES.includes(reglages.echelle);
    ui.echelleLibre = h('input', { type: 'number', min: ECHELLE_MIN, max: ECHELLE_MAX, step: 1, inputmode: 'numeric', value: reglages.echelle, 'aria-label': 'Échelle 1/n : n',
      oninput: (e) => {
        const n = Number(e.target.value);
        const ok = e.target.value.trim() !== '' && echelleValide(n);
        e.target.setAttribute('aria-invalid', ok ? 'false' : 'true');
        ui.echelleMsg.textContent = ok ? '' : `Nombre entier de ${ECHELLE_MIN} à ${ECHELLE_MAX} (1/n).`;
        if (ok) { reglages.echelle = n; changer(); }
      } });
    ui.echelleMsg = h('span', { class: 'planche-erreur', role: 'status' });
    ui.echelleAutre = h('div', { class: 'planche-echelle-libre', hidden: dansListe }, h('span', {}, '1/'), ui.echelleLibre, ui.echelleMsg);
    const selEchelle = h('select', { 'aria-label': 'Échelle', onchange: (e) => {
      const v = e.target.value;
      ui.echelleAutre.hidden = v !== 'autre';
      if (v === 'autre') { ui.echelleLibre.value = reglages.echelle; ui.echelleLibre.focus(); return; }
      reglages.echelle = +v; changer();
    } }, ...ECHELLES.map((e) => h('option', { value: e, selected: reglages.echelle === e }, `1/${e}`)), h('option', { value: 'autre', selected: !dansListe }, 'Autre…'));
    // 3. Format de feuille
    ui.perso = h('div', { class: 'deux-champs', hidden: true }, nombre('Largeur (mm)', 'largeur', 150, 1500), nombre('Hauteur (mm)', 'hauteur', 150, 1500));
    ui.modes = h('div', { class: 'planche-modes', role: 'radiogroup', 'aria-label': 'Si le cercle ne tient pas' },
      h('p', { class: 'note', 'data-garder': '' }, 'Le cercle ne tient pas sur ce format :'),
      ...[['rogner', 'Rogner (échelle exacte, cercle coupé)'], ['ajuster', 'Ajuster l\'échelle (cercle entier)'], ['reduire', 'Réduire le cercle (échelle exacte)']].map(([v, l]) => h('label', { class: 'case' },
        h('input', { type: 'radio', name: 'planche-mode', value: v, checked: reglages.mode === v, onchange: () => { reglages.mode = v; changer(); } }), l)),
      nombre('Marge autour du cercle (mm)', 'marge', 0, 60));
    ui.margeHors = h('div', {}, nombre('Marge au bord de la feuille (mm)', 'marge', 0, 60));
    ui.alertes = h('ul', { class: 'planche-alertes', role: 'status', hidden: true });
    ui.resume = h('p', { class: 'note', 'data-garder': '' });
    ui.apercu = h('img', { class: 'planche-apercu', alt: 'Aperçu de la planche' });
    ui.apercu2 = h('img', { class: 'planche-apercu', alt: 'Aperçu de la page de légende', hidden: true });
    ui.etat = h('p', { class: 'note', role: 'status' });
    const caseRoses = h('input', { type: 'checkbox', checked: avecRoses(), onchange: (e) => { reglages.roses = e.target.checked; apercu(); } });
    const caseDiagramme = h('input', { type: 'checkbox', checked: avecDiagramme(), disabled: !app.diagrammeSolaire || undefined, onchange: (e) => { reglages.diagramme = e.target.checked; apercu(); } });
    const P = app.config.rayonPlateau;
    const groupe = (titre, ...enfants) => h('fieldset', { class: 'planche-groupe' }, h('legend', {}, titre), ...enfants);
    ui.bloc = h('div', { class: 'bloc-planche', 'data-garder': '' },
      h('div', { class: 'titre-info' }, h('h3', {}, 'Planche à l\'échelle'), info(
        `Vue du dessus orthographique centrée sur la maquette, sur un format papier réel (carré 500 × 500 mm par défaut, A3, A2, A1 ou personnalisé). Ce que je montre : la vue maquette ronde (le plateau de ${P} m de rayon fait ${[100, 200, 500, 1000].map((e) => `${Math.round((2 * P * 1000) / e)} mm au 1/${e}`).join(', ')}), ou un rectangle ou un carré qui remplit la feuille à l'échelle choisie (l'emprise au sol suit l'échelle : au 1/100 sur 500 × 500 mm, un carré de 48 m de côté ; au 1/1000, 480 m).`,
        'Échelles : 1/50, 1/100, 1/150, 1/200, 1/500, 1/1000, 1/1500, 1/2000, ou « Autre… » pour saisir 1/n (n entier de 10 à 20 000). Cartouche, nord, échelle graphique, légende automatique de ce qui est affiché (éléments, réseaux, analyse d\'Ambiance avec ses graduations) et, au choix, les 4 roses des vents des saisons. Rectangle et carré : légende en bandeau sur la carte (fond blanc), ou à part.',
        'PDF : rendu de la maquette affichée à 300 dpi (ombres, toits, cartes d\'analyse), image au format papier exact : imprimer en taille réelle (100 %), sans « ajuster à la page ». SVG : unités en millimètres papier (1 mm = n / 1000 m) ; bâti, voirie, trottoirs, surfaces, arbres, ombres portées, réseaux, flux, coupes et noms des rues en vecteurs, cartes d\'analyse en images calées, un groupe nommé par calque pour Illustrator ou InDesign.',
        `Vérification : 100 m = 100 000 / n mm (au 1/500, 100 m = 200 mm ; au 1/200, 100 m = 500 mm et le plateau de ${2 * P} m fait ${Math.round(2 * P * 5)} mm). Échelle graphique et emprise indiquées sous l'aperçu.`)),
      h('label', { class: 'champ' }, h('span', {}, 'Titre'), ui.titre),
      groupe('Ce que je montre', formes, ui.rayon),
      groupe('Échelle', h('label', { class: 'champ' }, h('span', {}, 'Échelle'), selEchelle), ui.echelleAutre),
      groupe('Format de feuille', choix('Format', FORMATS.map(([v, l]) => [v, l]), 'format'), ui.perso, ui.modes, ui.margeHors),
      h('label', { class: 'case' }, caseRoses, 'Ajouter les 4 roses des vents (saisons)'),
      h('label', { class: 'case' }, caseDiagramme, 'Ajouter le diagramme solaire (2D)'),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: reglages.aPart, onchange: (e) => { reglages.aPart = e.target.checked; changer(); } }), 'Légende et cartouche à part (2e page, 2e fichier SVG)'),
      choix('Résolution du PDF', [[300, '300 dpi (impression)'], [150, '150 dpi (brouillon, plus rapide)']], 'dpi'),
      ui.alertes,
      ui.resume,
      h('div', { class: 'planche-apercus' }, ui.apercu, ui.apercu2),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton principal', onclick: () => exporterPDF().catch((e) => { etat(`PDF impossible : ${e.message}`); console.warn(e); }) }, 'PDF à l\'échelle'),
        h('button', { type: 'button', class: 'bouton', onclick: () => exporterSVG().catch((e) => { etat(`SVG impossible : ${e.message}`); console.warn(e); }) }, 'SVG (vecteurs)')),
      ui.etat);
    return ui.bloc;
  }
  function inserer() {
    const c = document.querySelector('#panneau-outil .panneau-contenu');
    if (!c || c.querySelector('.bloc-planche') || app.interface?.ouvert !== 'exporter') return;
    c.prepend(construireBloc());
    apercu();
  }

  // export direct avec les réglages par défaut (500 × 500 mm, 1/500, roses et diagramme automatiques) : barre des études
  async function exporterDefaut(type = 'pdf', titre = '') {
    const avant = { ...reglages };
    Object.assign(reglages, DEFAUT, { titre });
    try { return type === 'svg' ? await exporterSVG() : await exporterPDF(); } finally { Object.assign(reglages, avant); }
  }

  return { mise, svgPlanche, exporterPDF, exporterSVG, exporterDefaut, reglages, apercu, inserer };
}
