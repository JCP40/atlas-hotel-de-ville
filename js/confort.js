import * as THREE from 'three';
import { getPosition } from '../lib/suncalc.js';
import { h, info, lireLS, ecrireLS, dateDepuisJour, MOIS as MOIS_UTIL } from './util.js';
import { modifierReglageCentre } from './centre.js';
import { dateParis } from './geo.js';
import { chargerMeteo, horaire, partAuDessus, mention, libelleSaison, sourceEPW, journeesTypes } from './meteo.js';
import { utci as calculUTCI, CLASSES_UTCI, couleurContinue, versDixMetres, tmrtSimplifiee, dansDomaine } from './utci.js';
import { meteoA, positionsSoleil, calculEnFond, grillePourFond, prechaufferFond } from './chaleur-modele.js';
import { ouvertureCiel, ombres, noterCPU, blocGPU } from './gpu.js';
import { debut, fin, installer as installerProfil } from './profil.js';
import { transmissionCaduc } from './maquette.js';
import { telecharger } from './donnees.js';
import { versLambert93 } from './export.js';
import { textureGrille, dessinerTexture, caseLissage, hauteResolution, representants, etendre, signatureResolution, blocResolution, suivreNote, noterDuree, pointsEstimes } from './lissage.js';

// Rayonnement et confort de l'espace public.
// Modèle volontairement simple et explicite (calcul dans le navigateur, sans réflexions multiples) :
// - ouverture au ciel (facteur de vue du ciel) depuis une grille des hauteurs du bâti et des arbres ;
// - rayonnement solaire cumulé : direct (s'il n'est pas masqué) + diffus (pondéré par l'ouverture au ciel),
//   à partir de la météo horaire moyenne par mois et par heure mesurée par Météo-France à Nantes-Bouguenais
//   (data/meteo/meteo_horaire.json : global mesuré, direct et diffus estimés par le modèle d'Erbs) ;
// - température radiante moyenne et température ressentie (Steadman, avec rayonnement) pour des scénarios types.
// - carte UTCI (07/11/2026) : Universal Thermal Climate Index (polynôme officiel, js/utci.js) au jour et à l'heure de la barre
//   du temps, Tmrt estimée par les facteurs d'angle (ciel, murs, sol, soleil direct masqué par le bâti et les arbres), vent local
//   du champ de l'outil Vent (direction et vitesse du panneau, qui suivent la période) ramené à 10 m.
// Pour une étude validée : exporter la maquette vers Rhino + Ladybug Tools (moteur Radiance) avec un fichier EPW.

const RAD = Math.PI / 180;
const SIGMA = 5.67e-8;
const JOURS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MOIS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export const PERIODES = {
  annee: { libelle: 'Année', mois: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  ete: { libelle: 'Été (juin à août)', mois: [5, 6, 7] },
  hiver: { libelle: 'Hiver (décembre à février)', mois: [11, 0, 1] },
  intersaisons: { libelle: 'Printemps et automne', mois: [2, 3, 4, 8, 9, 10] },
};

export const SCENARIOS = {
  'ete-chaud': { libelle: 'Après-midi chaud d\'été (juillet, 15 h, 10 % des jours les plus chauds)', mois: 6, heure: 15, chaud: true },
  'ete': { libelle: 'Après-midi d\'été moyen (juillet, 15 h)', mois: 6, heure: 15 },
  'ete-matin': { libelle: 'Matinée d\'été (juillet, 10 h)', mois: 6, heure: 10 },
  'mi-saison': { libelle: 'Midi de mi-saison (avril, 13 h)', mois: 3, heure: 13 },
  'hiver': { libelle: 'Midi d\'hiver (janvier, 13 h)', mois: 0, heure: 13 },
};

const CLASSES_RESSENTI = [
  { max: 0, libelle: 'très froid', couleur: [40, 60, 140] },
  { max: 10, libelle: 'froid', couleur: [90, 130, 200] },
  { max: 18, libelle: 'frais', couleur: [150, 200, 220] },
  { max: 26, libelle: 'confortable', couleur: [150, 205, 140] },
  { max: 32, libelle: 'chaud', couleur: [245, 200, 90] },
  { max: 38, libelle: 'très chaud', couleur: [230, 120, 50] },
  { max: Infinity, libelle: 'chaleur extrême', couleur: [180, 40, 50] },
];

// dégradé générique (bleu nuit -> jaune)
const STOPS_DEGRADE = [[0, [40, 50, 110]], [0.25, [60, 110, 170]], [0.5, [120, 180, 170]], [0.75, [230, 210, 110]], [1, [245, 150, 40]]];
function degrade(t) {
  const stops = STOPS_DEGRADE;
  t = Math.min(Math.max(t, 0), 1);
  for (let k = 1; k < stops.length; k++) {
    if (t <= stops[k][0]) {
      const [t0, c0] = stops[k - 1], [t1, c1] = stops[k];
      const u = (t - t0) / (t1 - t0);
      return c0.map((c, i) => Math.round(c + (c1[i] - c) * u));
    }
  }
  return stops[stops.length - 1][1];
}

export function creerConfort(app) {
  installerProfil(app); // profil des calculs (?profil=1) : sans effet sinon
  const { lat, lon } = app.config.soleil;
  const etat = { climato: null, grille: null, svf: null, calque: null, valeurs: null, type: null, legende: null, facadesActives: false };
  const ui = {};
  let pas = 2; // maille du calcul (m), élargie pour un grand cercle d'analyse
  const rayon = () => app.config.rayonConfort || app.config.rayonPlateau;
  const dansCercle = (x, z) => Math.hypot(x, z) <= rayon();

  // cercle d'analyse, visible quand le panneau Confort est ouvert
  const cercle = new THREE.Mesh(new THREE.RingGeometry(0.99, 1, 160).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x2f7fb5, transparent: true, opacity: 0.8, depthWrite: false }));
  cercle.position.y = 0.5;
  cercle.visible = false;
  cercle.renderOrder = 8;
  cercle.raycast = () => {};
  app.scene.add(cercle);
  const majCercle = () => { const r = rayon(); cercle.geometry.dispose(); cercle.geometry = new THREE.RingGeometry(r - 0.9, r + 0.9, 160).rotateX(-Math.PI / 2); };
  majCercle();
  app.on('outil', (id) => { cercle.visible = id === 'confort'; if (id === 'confort' || id === 'chaleur') prechaufferFond(); });

  // ---------------------------------------------------------------
  // Météo moyenne par mois et par heure
  // ---------------------------------------------------------------
  async function climatologie() {
    if (etat.climato) return etat.climato;
    await chargerMeteo();
    const c = horaire();
    if (!c?.moyennes) throw new Error('météo horaire absente (data/meteo/meteo_horaire.json, produit par outils/meteo/horaire.py)');
    const [p0, p1] = c.periode.split('/').map((x) => x.split('-').reverse().join('/'));
    etat.climato = { ...c, periode: `du ${p0} au ${p1}` };
    return etat.climato;
  }

  // ---------------------------------------------------------------
  // Grille d'étude, hauteurs, ouverture au ciel
  // ---------------------------------------------------------------
  function preparerGrille() {
    const t0 = debut();
    const r = rayon();
    const hr = hauteResolution(); // haute résolution : mailles de 1 m, un point de calcul par bloc hors de la zone détaillée (js/lissage.js)
    pas = hr ? 1 : r <= 150 ? 2 : r <= 300 ? 3 : 4;
    const zone = app.soleil.zoneAnalyse(r);
    const g = app.soleil.grilleHauteurs(zone);
    const nx = Math.ceil((zone.x1 - zone.x0) / pas), nz = Math.ceil((zone.z1 - zone.z0) / pas);
    // rep : maille de calcul de chaque maille ouverte (même règle que Chaleur) ; null en résolution normale
    const rep = hr ? representants({ nx, nz, x0: zone.x0, z0: zone.z0, pas, garder: (k) => { const x = zone.x0 + ((k % nx) + 0.5) * pas, z = zone.z0 + (Math.floor(k / nx) + 0.5) * pas; return dansCercle(x, z) && app.soleil.hauteurEn(g, x, z) <= 0.5; } }) : null;
    etat.grille = { zone, g, nx, nz, rep };
    fin('Confort : grille des hauteurs (preparerGrille)', t0, { nx, nz });
    return etat.grille;
  }

  // hauteur maximale de la grille (gardée sur g, comme chaleur-modele.js) : arrêt des marches au-dessus de tout obstacle
  const hauteurMax = (g) => { if (g.hMax == null) { let m = 0; for (let i = 0; i < g.H.length; i++) if (g.H[i] > m) m = g.H[i]; g.hMax = m; } return g.hMax; };
  // pause rendue au navigateur au plus toutes les 100 ms (chaque pause laisse passer une image : moins de pauses, calcul plus court, mêmes résultats)
  let tPause = 0;
  // (08/11/2026 : l'horloge repart APRÈS l'image ; avant, elle partait avant, et quand une image de la maquette prenait plus de
  // 100 ms, chaque contrôle suivant rendait de nouveau la main : une image toutes les 6 ou 10 lignes de la grille)
  const pause = (ms = 100) => { const t = performance.now(); if (t - tPause < ms) return null; return new Promise((r) => setTimeout(r, 0)).then(() => { tPause = performance.now(); }); };
  // progression d'un calcul en arrière-plan : note du panneau, ou fonction progres(u) de l'UTCI
  const suiviFond = (etape, progres = null) => (p) => { const u = Number.isFinite(p.u) ? p.u : Number((/(\d+) %/.exec(p.texte || '') || [])[1]) / 100; if (!Number.isFinite(u)) return; if (progres) progres(u); else note(`${etape} : ${Math.round(u * 100)} %`); };
  // ouverture au ciel réutilisable par l'UTCI tant que le bâti, le rayon et le feuillage (caducs dans la grille) n'ont pas changé
  const cleSVF = () => `${signatureResolution()}|${rayon()}|${(app.arbres?.f ?? 1) >= 0.5}|${Math.round((app.arbres?.echelle ?? 1) * 10)}`;
  // 08/11/2026 : les boutons Ouverture au ciel, Rayonnement au sol et Confort thermique la réutilisent aussi (elle était
  // recalculée à chaque clic) ; effacée par les événements bati, etat, arbres (bâti, époque, arbres relevés modifiés)
  const svfValide = () => !!(etat.svf && etat.grille && etat.svfCle === cleSVF() && etat.svf.length === etat.grille.nx * etat.grille.nz);

  // Hauteur d'horizon (angle d'élévation) vue depuis (x, z, y0) dans une direction
  function horizon(g, x, z, y0, sx, sz, dMax = 160) {
    let tanMax = 0;
    const Hm = hauteurMax(g);
    for (let d = 2; d <= dMax; d += 2) {
      if ((Hm - y0) / d <= tanMax) break; // plus rien ne peut dépasser l'horizon trouvé (résultat identique)
      const hh = app.soleil.hauteurEn(g, x + sx * d, z + sz * d);
      const t = (hh - y0) / d;
      if (t > tanMax) tanMax = t;
    }
    return Math.atan(tanMax);
  }

  // mailles ouvertes du cercle (pas sous un bâtiment ni une couronne) : points du calcul sur la carte graphique (js/gpu.js)
  function pointsOuverts(zone, g, nx, nz, y0, garder = null) {
    const k = [];
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        const q = j * nx + i, rep = etat.grille?.rep;
        if (garder ? garder(q) : rep ? rep[q] === q : dansCercle(x, z) && app.soleil.hauteurEn(g, x, z) <= 0.5) k.push(q); // haute résolution : un point par bloc
      }
    }
    const P = { n: k.length, k, x: new Float32Array(k.length), z: new Float32Array(k.length), y0: new Float32Array(k.length).fill(y0) };
    k.forEach((q, m) => { P.x[m] = zone.x0 + ((q % nx) + 0.5) * pas; P.z[m] = zone.z0 + (Math.floor(q / nx) + 0.5) * pas; });
    return P;
  }

  async function calculerSVF(progres = null) {
    const tP = debut();
    try { return await calculerSVFSeul(progres); } finally { fin('Confort : ouverture au ciel (calculerSVF)', tP); }
  }
  async function calculerSVFSeul(progres) {
    const { zone, g, nx, nz } = etat.grille || preparerGrille();
    // carte graphique si WebGPU est actif (mêmes 36 directions, pas de 2 m jusqu'à 160 m, à 1,20 m du sol)
    const P = pointsOuverts(zone, g, nx, nz, 1.2);
    const r = await ouvertureCiel(g, P, { N: 36, pas: 2, dMax: 160, note: progres ? null : note });
    if (r) {
      const svf = new Float32Array(nx * nz).fill(NaN);
      P.k.forEach((q, m) => { svf[q] = r[m]; });
      if (progres) await progres(1);
      etat.svf = svf;
      etat.svfCle = cleSVF();
      return svf;
    }
    const t0 = performance.now();
    // 08/11/2026 : sur le processeur, calcul en arrière-plan (js/chaleur-worker.js, svfCPU de js/gpu.js : même boucle que
    // ci-dessous, y0 en double comme ici) ; l'interface reste fluide ; boucle d'origine si le worker est indisponible
    const tache = calculEnFond('svf', { g: grillePourFond(g), pts: { n: P.n, x: P.x, z: P.z, y0: new Float64Array(P.n).fill(1.2) }, options: { N: 36, pas: 2, dMax: 160 } }, [], suiviFond('Ouverture au ciel', progres));
    if (tache) {
      try {
        const { svf: r, ms } = await tache;
        fin('Confort : ouverture au ciel / dont calcul dans le worker', debut() - ms);
        const svf = new Float32Array(nx * nz).fill(NaN);
        P.k.forEach((q, m) => { svf[q] = r[m]; });
        if (progres) await progres(1);
        noterCPU('ouverture au ciel', performance.now() - t0);
        etat.svf = svf;
        etat.svfCle = cleSVF();
        return svf;
      } catch (e) { if (!e.indisponible) throw e; }
    }
    const n = 36;
    const dirs = Array.from({ length: n }, (_, k) => [Math.sin((k / n) * 2 * Math.PI), -Math.cos((k / n) * 2 * Math.PI)]);
    const svf = new Float32Array(nx * nz).fill(NaN);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        if (!dansCercle(x, z) || app.soleil.hauteurEn(g, x, z) > 0.5) continue;
        if (etat.grille.rep && etat.grille.rep[j * nx + i] !== j * nx + i) continue; // haute résolution : un point par bloc
        let s = 0;
        for (const [sx, sz] of dirs) { const b = horizon(g, x, z, 1.2, sx, sz); s += Math.sin(b) ** 2; }
        svf[j * nx + i] = 1 - s / n;
      }
      if (progres) await progres(j / nz); else if (j % 10 === 0) { note(`Ouverture au ciel : ${Math.round((j / nz) * 100)} %`); await pause(); }
    }
    noterCPU('ouverture au ciel', performance.now() - t0);
    etat.svf = svf;
    etat.svfCle = cleSVF();
    return svf;
  }

  // Le point est-il au soleil ? (marche le long du rayon dans la grille des hauteurs)
  function auSoleil(g, x, z, y0, sx, sz, tanAlt) {
    for (let d = 1; d < 400; d += 1.5) {
      const ray = y0 + d * tanAlt;
      if (ray > 150 || ray > hauteurMax(g)) return true; // au-dessus du plus haut obstacle : rien ne peut plus masquer
      if (app.soleil.hauteurEn(g, x + sx * d, z + sz * d) > ray) return false;
    }
    return true;
  }

  // Positions du soleil et météo pour chaque mois et chaque heure (le 15 du mois)
  function soleils(mois) {
    const c = etat.climato;
    const liste = [];
    const annee = new Date().getFullYear();
    for (const m of mois) {
      for (let hh = 5; hh <= 22; hh++) {
        const met = c.moyennes[m][hh];
        if (!met || (met.dni <= 0 && met.dhi <= 0)) continue;
        const p = getPosition(dateParis(annee, m, 15, hh - 0.5), lat, lon); // rayonnement de l'heure écoulée
        const alt = p.altitude * RAD, az = p.azimuth * RAD;
        liste.push({ m, poids: JOURS[m], alt, sx: Math.sin(az), sz: -Math.cos(az), tanAlt: Math.tan(Math.max(alt, 0.001)), cosZ: Math.max(Math.sin(alt), 0), dir: new THREE.Vector3(Math.sin(az) * Math.cos(alt), Math.sin(alt), -Math.cos(az) * Math.cos(alt)), met });
      }
    }
    return liste;
  }

  // ---------------------------------------------------------------
  // Rayonnement cumulé au sol (kWh/m²)
  // ---------------------------------------------------------------
  async function calculerRayonnement(periode) {
    await climatologie();
    const { zone, g, nx, nz } = etat.grille || preparerGrille();
    const svf = svfValide() ? etat.svf : await calculerSVF();
    const S = soleils(PERIODES[periode].mois);
    const res = new Float32Array(nx * nz).fill(NaN);
    // ombres de toutes les heures sur la carte graphique si WebGPU est actif (même marche que auSoleil, à 0,30 m du sol)
    const vus = S.map((s, q) => (s.alt > 0.02 && s.met.dni > 0 ? q : -1)).filter((q) => q >= 0);
    const PO = pointsOuverts(zone, g, nx, nz, 0.3, (k) => Number.isFinite(svf[k]));
    let MG = await ombres(g, PO, vus.map((q) => S[q]), { d0: 1, pas: 1.5, dLim: 400, plafond: Math.min(150, hauteurMax(g)), note });
    // sans carte graphique : mêmes ombres (masquesCPU, même marche que auSoleil, y0 en double) en arrière-plan (08/11/2026)
    const tFond = !MG ? calculEnFond('masques', { g: grillePourFond(g), pts: { n: PO.n, x: PO.x, z: PO.z, y0: new Float64Array(PO.n).fill(0.3) },
      soleils: vus.map((q) => ({ sx: S[q].sx, sz: S[q].sz, tanAlt: S[q].tanAlt })), options: { d0: 1, pas: 1.5, dLim: 400, plafond: Math.min(150, hauteurMax(g)) } }, [], suiviFond('Ombres')) : null;
    if (tFond) { try { const r = await tFond; MG = r.M; fin('Confort : ombres de toutes les heures / dont calcul dans le worker', debut() - r.ms, { soleils: vus.length, points: PO.n }); } catch (e) { if (!e.indisponible) throw e; } }
    let indice = null, rangSoleil = null;
    if (MG) { indice = new Int32Array(nx * nz).fill(-1); PO.k.forEach((q, m) => { indice[q] = m; }); rangSoleil = new Int32Array(S.length).fill(-1); vus.forEach((q, r) => { rangSoleil[q] = r; }); }
    const t0 = performance.now();
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!Number.isFinite(svf[k])) continue;
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        let e = 0;
        for (let q = 0; q < S.length; q++) {
          const s = S[q];
          let w = s.met.dhi * svf[k];
          if (s.alt > 0.02 && s.met.dni > 0 && (MG ? MG[rangSoleil[q] * PO.n + indice[k]] : auSoleil(g, x, z, 0.3, s.sx, s.sz, s.tanAlt))) w += s.met.dni * s.cosZ;
          e += w * s.poids;
        }
        res[k] = e / 1000; // Wh -> kWh
      }
      if (j % 6 === 0) { note(`Rayonnement : ${Math.round((j / nz) * 100)} %`); await pause(); }
    }
    if (!MG) noterCPU('ombres', performance.now() - t0);
    return res;
  }

  // ---------------------------------------------------------------
  // Rayonnement cumulé sur les façades et les toits du plateau (couleurs des bâtiments)
  // ---------------------------------------------------------------
  async function calculerFacades(periode) {
    await climatologie();
    const { g } = etat.grille || preparerGrille();
    const S = soleils(PERIODES[periode].mois);
    const r = rayon();
    const cibles = (app.empreintes || []).filter((e) => e.mesh && Math.hypot(e.cx, e.cz) <= r);
    const n = new THREE.Vector3(), p = new THREE.Vector3();
    const valeurs = [];
    let fait = 0;
    for (const e of cibles) {
      const pos = e.mesh.geometry.getAttribute('position'), nor = e.mesh.geometry.getAttribute('normal');
      const vals = new Float32Array(e.nb);
      for (let v = 0; v < e.nb; v++) {
        const idx = e.debut + v;
        n.fromBufferAttribute(nor, idx).normalize();
        p.fromBufferAttribute(pos, idx);
        const toit = n.y > 0.6;
        // hauteur au-dessus du sol (le relief affiché soulève le bâtiment d'un bloc)
        const x = p.x + n.x * 0.6, z = p.z + n.z * 0.6, y = Math.max(p.y - (e.decalageRelief || 0), 1);
        // part de ciel vue par une façade verticale ~ 0,5 x ouverture dans la direction de la façade
        const ciel = toit ? 1 : 0.5 * (1 - Math.sin(horizon(g, x, z, y, n.x, n.z, 100)) ** 2);
        let e2 = 0;
        for (const s of S) {
          let w = s.met.dhi * ciel + (toit ? 0 : 0.5 * 0.2 * s.met.ghi);
          const cosI = n.dot(s.dir);
          if (cosI > 0 && s.alt > 0.02 && s.met.dni > 0 && auSoleil(g, x, z, y + (toit ? 0.2 : 0), s.sx, s.sz, s.tanAlt)) w += s.met.dni * cosI;
          e2 += w * s.poids;
        }
        vals[v] = e2 / 1000;
      }
      valeurs.push({ e, vals });
      if (++fait % 10 === 0) { note(`Façades : ${Math.round((fait / cibles.length) * 100)} %`); await pause(); }
    }
    return valeurs;
  }

  function colorierFacades(valeurs, max) {
    const c = new THREE.Color();
    const modifies = new Set();
    for (const { e, vals } of valeurs) {
      const attr = e.mesh.geometry.getAttribute('color');
      vals.forEach((v, i) => { const [r, g2, b] = degrade(v / max); c.setRGB(r / 255, g2 / 255, b / 255, THREE.SRGBColorSpace); attr.setXYZ(e.debut + i, c.r, c.g, c.b); });
      modifies.add(attr);
    }
    modifies.forEach((a) => { a.needsUpdate = true; });
    etat.facadesActives = true;
  }

  function effacerFacades() {
    if (!etat.facadesActives) return;
    etat.facadesActives = false;
    // retour aux couleurs du PSMV si elles sont affichées, sinon au blanc
    app.cadastre?.majBatiments(true);
  }

  // Dépassements de vent mesurés (Météo-France) pour la saison du scénario
  function texteVent(m) {
    const saison = [11, 0, 1].includes(m) ? 'hiver' : m <= 4 ? 'printemps' : m <= 7 ? 'ete' : 'automne';
    const p5 = partAuDessus(5, saison), p8 = partAuDessus(8, saison);
    if (p5 == null) return '';
    return `${libelleSaison(saison).replace(/ \(.*/, '')} : vent de 5 m/s ou plus à la station ${fmt(0)(p5)} % du temps, de 8 m/s ou plus ${fmt(1)(p8)} % (le vent dans les rues est plus faible : voir l'outil Vent).`;
  }

  // ---------------------------------------------------------------
  // Confort : température radiante moyenne et température ressentie
  // ---------------------------------------------------------------
  function meteoScenario(sc) {
    const c = etat.climato;
    return sc.chaud ? c.chaudJuillet15h : c.moyennes[sc.mois][sc.heure];
  }

  async function calculerConfort(cle) {
    await climatologie();
    const sc = SCENARIOS[cle];
    const met = meteoScenario(sc);
    const { zone, g, nx, nz } = etat.grille || preparerGrille();
    const svf = svfValide() ? etat.svf : await calculerSVF();
    const annee = new Date().getFullYear();
    const pSol = getPosition(dateParis(annee, sc.mois, 15, sc.heure - 0.5), lat, lon);
    const alt = pSol.altitude * RAD, az = pSol.azimuth * RAD;
    const sx = Math.sin(az), sz = -Math.cos(az), tanAlt = Math.tan(Math.max(alt, 0.001));
    const Ta = met.ta, TaK = Ta + 273.15;
    const e = (met.hr / 100) * 6.105 * Math.exp((17.27 * Ta) / (237.7 + Ta)); // pression de vapeur (hPa)
    const epsCiel = Math.min(1, 1.24 * Math.pow(e / TaK, 1 / 7)); // Brutsaert, ciel clair
    const Lciel = epsCiel * SIGMA * TaK ** 4;
    const Lenv = 0.95 * SIGMA * TaK ** 4;
    const betaDeg = Math.max(pSol.altitude, 0);
    const fp = 0.308 * Math.cos(RAD * betaDeg * (0.998 - (betaDeg * betaDeg) / 50000)); // aire projetée d'une personne debout
    const tmrt = new Float32Array(nx * nz).fill(NaN);
    const ressenti = new Float32Array(nx * nz).fill(NaN);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const f = svf[k];
        if (!Number.isFinite(f)) continue;
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        const soleil = alt > 0.02 && met.dni > 0 && auSoleil(g, x, z, 1.2, sx, sz, tanAlt) ? 1 : 0;
        const solSol = soleil * met.dni * Math.max(Math.sin(alt), 0) + met.dhi * f; // rayonnement reçu par le sol
        const K = 0.7 * (fp * met.dni * soleil + 0.5 * met.dhi * f + 0.5 * 0.2 * solSol);
        const Tsol = TaK + 0.02 * solSol; // un sol ensoleillé chauffe
        const L = 0.97 * (0.5 * (f * Lciel + (1 - f) * Lenv) + 0.5 * 0.95 * SIGMA * Tsol ** 4);
        const tr = Math.pow((K + L) / (0.97 * SIGMA), 0.25) - 273.15;
        tmrt[k] = tr;
        // vent à hauteur de piéton : profil vertical et abri des façades
        const v = Math.max(0.3, met.v * 0.66 * (0.35 + 0.65 * f));
        // température ressentie de Steadman (1994), avec rayonnement absorbé Q
        ressenti[k] = Ta + 0.348 * e - 0.70 * v + (0.70 * K) / (v + 10) - 4.25;
      }
      if (j % 10 === 0) { note(`Confort : ${Math.round((j / nz) * 100)} %`); await pause(); }
    }
    return { tmrt, ressenti, met, soleilHaut: pSol.altitude };
  }


  // ---------------------------------------------------------------
  // Carte UTCI (07/11/2026, demande de l'utilisateur)
  // ---------------------------------------------------------------
  // UTCI = f(Ta, Tmrt, va à 10 m, HR), polynôme officiel UTCI_approx (Bröde et al. 2012, js/utci.js), sur la grille de Confort
  // (mailles de 2 m, espaces ouverts du cercle d'analyse, sous les arbres compris), à 1,1 m du sol.
  // - Moment : jour et heure de la barre du temps (soleil). Ta, HR, rayonnement direct / diffus : moyenne du mois à l'heure
  //   (meteo_horaire.json ou EPW), ou journée type (Chaleur : journée chaude, record ; tirées de l'EPW si choisi) par meteoA.
  // - Tmrt : méthode des facteurs d'angle d'une personne debout (moitié haute, moitié basse ; VDI 3787, Thorsson 2007) :
  //   Sstr = αk (fp I + ½ D SVF + ½ ρsol Gsol) + εp [½ (SVF L_ciel + (1 − SVF) L_murs) + ½ L_sol] ; Tmrt = (Sstr / (εp σ))^¼ − 273,15,
  //   αk 0,7, εp 0,97, fp aire projetée selon la hauteur du soleil, I direct seulement si le point est au soleil (bâti et arbres de
  //   la grille des hauteurs de Soleil), L_ciel de Brutsaert (ciel clair), murs à Ta (ε 0,95), sol à Ta + 0,025 (1 − ρ) Gsol (ε 0,95),
  //   ρsol = albédo de la grille des matériaux de Chaleur si elle est chargée, sinon 0,2. Sous une couronne : ciel et soleil
  //   filtrés par la transmission de l'arbre (12 % ; caducs 12 à 65 % selon la saison), couronne à Ta.
  // - Vent : champ 2D de l'outil Vent (rapport local / vent libre à 1,5 m) pour la direction et la vitesse du panneau Vent
  //   (qui suivent la période choisie, partie A) ; vent piéton = 0,70 × rapport × vent de la station (comme le confort au vent),
  //   ramené à 10 m par une loi en puissance (exposant 0,18) : va = v(1,5 m) × (10 / 1,5)^0,18 ≈ 1,41 v(1,5 m), borné à 0,5-17 m/s.
  //   Variante : vitesse de la météo de l'heure (direction du panneau), ou sans écoulement : rapport 0,35 + 0,65 SVF (comme Chaleur).
  // Calcul par lots (≤ 50 ms d'affilée, barre de progression), ouverture au ciel réutilisée tant que rien n'a changé.
  const CLE_UTCI = 'atlas-hdv-confort-utci';
  const REGL_UTCI = { affichage: 'classes', meteo: 'mois', vent: 'panneau' };
  etat.reglUTCI = { ...REGL_UTCI };
  try { Object.assign(etat.reglUTCI, JSON.parse(lireLS(CLE_UTCI) || '{}')); } catch { /* réglage illisible : défauts */ }
  const memoriserUTCI = () => ecrireLS(CLE_UTCI, JSON.stringify(etat.reglUTCI));
  const KPED = 0.70; // vent libre à 2 m en ville / vent de la station (js/vent-calcul.js)
  const HAUTEUR_CHAMP = 1.5; // hauteur du champ 2D de l'outil Vent (m)
  let dureeParMaille = 0.12; // ms, estimation affichée avant le calcul (mise à jour après chaque calcul)

  function profilsJournees() { return journeesTypes()?.profils ?? app.chaleur?.etat?.journees?.profils ?? {}; }
  function sourcesMeteoUTCI() {
    const L = [['mois', 'Moyenne du mois à cette heure']];
    for (const [k, p] of Object.entries(profilsJournees())) L.push([k, p.libelle || k]);
    return L;
  }
  function momentBarre() {
    const S = app.soleil?.etat || {};
    const annee = S.annee ?? new Date().getFullYear();
    const d = dateDepuisJour(annee, S.jour ?? 172);
    const heure = S.heure ?? 12;
    const hh = Math.floor(heure + 1e-6), mm = Math.round((heure - hh) * 60);
    return { ...d, heure, libelle: `${d.jour} ${MOIS_UTIL[d.mois]} ${hh} h${mm ? ` ${String(mm).padStart(2, '0')}` : ''}` };
  }
  // zone du diagnostic WebGPU (js/gpu.js, bouton « Tester WebGPU » de Confort et Chaleur) : mailles ouvertes du cercle d'analyse,
  // grille des hauteurs courante, positions du soleil toutes les 30 min du jour de la barre du temps
  function preparerDiagnostic() {
    const { zone, g, nx, nz } = etat.grille || preparerGrille();
    const P = pointsOuverts(zone, g, nx, nz, 1.2);
    const q = momentBarre();
    const soleils = positionsSoleil({ annee: q.annee, mois: q.mois, jour: q.jour, lat, lon }).filter((p) => p.alt > 0.02);
    return { g, pts: P, soleils, zone: `cercle d'analyse de Confort (rayon ${Math.round(rayon())} m, maille ${pas} m), soleil du ${q.jour} ${MOIS_UTIL[q.mois]}` };
  }
  const blocWebGPU = () => blocGPU({ h, info }, async () => preparerDiagnostic());
  // même bloc dans le panneau Chaleur, après la section « Température de surface » (inséré ici : chaleur.js inchangé)
  app.on('outil', (id) => {
    if (id !== 'chaleur') return;
    let essais = 0;
    const inserer = () => {
      const p = document.querySelector('#panneau-outil');
      const ancre = p?.querySelector('.section-temperature');
      if (!ancre) { if (++essais < 60) setTimeout(inserer, 250); return; } // panneau construit après la lecture des matériaux
      if (!p.querySelector('.bloc-gpu')) ancre.after(blocWebGPU());
    };
    setTimeout(inserer, 0);
  });

  function meteoUTCI(q) {
    const R = etat.reglUTCI;
    const P = profilsJournees()[R.meteo];
    if (R.meteo !== 'mois' && P?.heures) return { ...meteoA(P.heures, q.heure), source: P.libelle || R.meteo };
    const M = etat.climato.moyennes[q.mois];
    return { ...meteoA(M, q.heure), source: `moyenne de ${MOIS_UTIL[q.mois]} à cette heure` };
  }
  // couronnes d'arbres sur la grille de Confort : transmission de la lumière (0 = pas d'arbre), hauteur de la couronne
  function masqueArbres(G) {
    const { zone, nx, nz } = G;
    const tau = new Float32Array(nx * nz), hA = new Float32Array(nx * nz);
    const f = app.arbres?.f ?? 1;
    for (const [lot, liste] of Object.entries(app.arbres?.lots || {})) {
      const caduc = lot === 'caduc';
      if (caduc && f < 0.5) continue; // sans feuilles : hors de la grille des hauteurs, comptés comme espace ouvert
      const t = caduc ? transmissionCaduc(f) : 0.12, e = caduc ? app.arbres.echelle ?? 1 : 1;
      for (const a of liste) {
        const r = (a.d / 2) * e;
        const i0 = Math.max(0, Math.floor((a.x - r - zone.x0) / pas)), i1 = Math.min(nx - 1, Math.floor((a.x + r - zone.x0) / pas));
        const j0 = Math.max(0, Math.floor((a.z - r - zone.z0) / pas)), j1 = Math.min(nz - 1, Math.floor((a.z + r - zone.z0) / pas));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
          const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
          if ((x - a.x) ** 2 + (z - a.z) ** 2 > r * r) continue;
          const k = j * nx + i;
          if (!tau[k] || t < tau[k]) tau[k] = t;
          if (a.h > hA[k]) hA[k] = a.h;
        }
      }
    }
    return { tau, hA };
  }
  // albédo du sol : grille des matériaux de Chaleur (si elle est déjà construite), sinon 0,2
  function albedoSol() {
    const C = app.chaleur, Gc = C?.etat?.grille, cl = Gc && C.classes?.();
    if (!Gc || !cl?.length) return { en: () => 0.2, source: 'albédo du sol 0,2 (grille des matériaux de Chaleur non calculée)' };
    return {
      en: (x, z) => {
        const i = Math.floor((x - Gc.x0) / Gc.pas), j = Math.floor((z - Gc.z0) / Gc.pas);
        const c = i < 0 || j < 0 || i >= Gc.n || j >= Gc.n ? null : cl[Gc.cls[j * Gc.n + i]];
        return c?.albedo ?? 0.2;
      },
      source: 'albédo du sol de la grille des matériaux de Chaleur',
    };
  }

  async function calculerUTCI() {
    const t0 = performance.now(), tP = debut();
    try { return await calculerUTCISeul(t0); } finally { fin('Confort : UTCI complet', tP); }
  }
  async function calculerUTCISeul(t0) {
    await climatologie();
    if (etat.reglUTCI.meteo !== 'mois') await app.chaleur?.charger?.().catch(() => null);
    const R = etat.reglUTCI;
    const q = momentBarre();
    const met = meteoUTCI(q);
    const G = preparerGrille();
    const { zone, g, nx, nz } = G;
    // rend la main au navigateur dès que 50 ms de calcul se sont enchaînées (une image passe) ; mesure du calcul seul
    let attente = 0, trancheMax = 0, tReprise = performance.now();
    const avancer = async (etape, u) => {
      const t = performance.now();
      if (t - tReprise < 50) return;
      trancheMax = Math.max(trancheMax, t - tReprise);
      progresUTCI(etape, u);
      await new Promise((r) => setTimeout(r, 0));
      tReprise = performance.now();
      attente += tReprise - t;
    };
    // 1. ouverture au ciel (réutilisée si le bâti, le rayon et le feuillage n'ont pas changé)
    let svf = etat.svf;
    const tSvf = performance.now();
    if (!svf || etat.svfCle !== cleSVF() || svf.length !== nx * nz) { etat.svf = null; svf = await calculerSVF((u) => avancer('Ouverture au ciel', 0.6 * u)); }
    fin('Confort : UTCI complet / ouverture au ciel', tSvf);
    const dSvf = performance.now() - tSvf;
    // 2. vent : champ de l'outil Vent (direction et vitesse du panneau, calcul exact par lots)
    let champ = null, texteVent = '';
    const V = app.vent?.etat;
    const tV = debut();
    if (R.vent !== 'ciel' && app.vent?.champPour) {
      try { champ = await app.vent.champPour((u) => progresUTCI('Écoulement du vent', 0.6 + 0.1 * u)); attente += champ.attente || 0; tReprise = performance.now(); } catch (e) { console.warn('UTCI : champ du vent indisponible', e); champ = null; }
    }
    fin('Confort : UTCI complet / champ du vent (champPour)', tV);
    const vRef = R.vent === 'panneau' && champ ? champ.vitesse : met.v;
    if (champ) texteVent = `vent de ${champ.direction}° (outil Vent${V?.suitPeriode ? `, dominant ${({ annee: 'de l\'année', hiver: 'd\'hiver', printemps: 'de printemps', ete: 'd\'été', automne: 'd\'automne' })[V.saison] || ''}` : ', réglage manuel'}), ${fmt(1)(vRef)} m/s à la station${R.vent === 'meteo' ? ' (météo de l\'heure)' : ''}, écoulement 2D autour du bâti`;
    else texteVent = `${fmt(1)(vRef)} m/s à la station (météo de l'heure), abri estimé par l'ouverture au ciel (0,35 + 0,65 SVF)`;
    // 3. soleil, ciel, Tmrt et UTCI par maille
    const pSol = getPosition(dateParis(q.annee, q.mois, q.jour, q.heure), lat, lon);
    const alt = pSol.altitude * RAD, az = pSol.azimuth * RAD;
    const sx = Math.sin(az), sz = -Math.cos(az), tanAlt = Math.tan(Math.max(alt, 0.001));
    const Ta = met.ta, TaK = Ta + 273.15, HR = met.hr;
    const e = (HR / 100) * 6.105 * Math.exp((17.27 * Ta) / (237.7 + Ta));
    const Lciel = Math.min(1, 1.24 * Math.pow(e / TaK, 1 / 7)) * SIGMA * TaK ** 4;
    const Lair = 0.95 * SIGMA * TaK ** 4;
    const beta = Math.max(pSol.altitude, 0);
    const fp = 0.308 * Math.cos(RAD * beta * (0.998 - (beta * beta) / 50000));
    const soleilLeve = alt > 0.02 && met.dni > 0;
    let tB = debut();
    const { tau, hA } = masqueArbres(G);
    fin('Confort : UTCI complet / masqueArbres', tB); tB = debut();
    const alb = albedoSol();
    const N = nx * nz;
    const tmrt = new Float32Array(N).fill(NaN), va = new Float32Array(N).fill(NaN), u = new Float32Array(N).fill(NaN);
    const out = [0, 0];
    let horsDomaine = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        if (!dansCercle(x, z)) continue;
        let f = svf[k], t = 1, sousArbre = false;
        if (!Number.isFinite(f)) {
          // maille masquée par la grille des hauteurs : sous une couronne (pas un bâtiment plus haut que l'arbre) → calculée à l'ombre filtrée
          if (!tau[k] || app.soleil.hauteurEn(g, x, z) > hA[k] + 0.5) continue;
          sousArbre = true; t = tau[k]; f = tau[k];
        }
        const auSol = soleilLeve && (sousArbre ? true : auSoleil(g, x, z, 1.2, sx, sz, tanAlt));
        const I = auSol ? met.dni * t : 0;
        const Gsol = I * Math.max(Math.sin(alt), 0) + met.dhi * f;
        const rho = alb.en(x, z);
        const Tsol = TaK + 0.025 * (1 - rho) * Gsol;
        const tr = tmrtSimplifiee({ I, D: met.dhi, fp, svf: f, albedoSol: rho, Gsol, Lciel, Lmurs: Lair, Lsol: 0.95 * SIGMA * Tsol ** 4 });
        // vent local : rapport du champ 2D (vitesse locale / vent libre), sinon abri estimé par l'ouverture au ciel
        let rapport = 0.35 + 0.65 * (Number.isFinite(svf[k]) ? svf[k] : 0.3);
        if (champ && champ.vitesse > 0 && champ.echantillon(x, z, out)) rapport = Math.min(2.5, Math.hypot(out[0], out[1]) / champ.vitesse);
        const v10 = Math.max(0.5, Math.min(17, versDixMetres(KPED * rapport * vRef, HAUTEUR_CHAMP)));
        if (!dansDomaine(Ta, tr, v10)) horsDomaine++;
        tmrt[k] = tr; va[k] = v10;
        u[k] = calculUTCI(Ta, tr, v10, HR);
      }
      await avancer('Température radiante et UTCI', 0.7 + 0.3 * (j / nz));
    }
    fin('Confort : UTCI complet / ombre, Tmrt et UTCI par maille', tB);
    const nb = u.reduce((a, x) => a + (Number.isFinite(x) ? 1 : 0), 0);
    const duree = performance.now() - t0;
    if (nb) dureeParMaille = (duree - dSvf) / nb + (dSvf > 50 ? dSvf / nb : 0);
    return { u, tmrt, va, met, q, soleilHaut: pSol.altitude, texteVent, albedo: alb.source, duree, dureeSvf: dSvf, nb, horsDomaine, phase: app.phase?.phase || 'existant',
      calcul: duree - attente, trancheMax };
  }

  function progresUTCI(etape, u) {
    if (!ui.progres?.isConnected) return;
    ui.progres.hidden = false;
    ui.progres.value = u;
    ui.progresTexte.textContent = `${etape} : ${Math.round(u * 100)} %`;
  }

  // affichage de la carte UTCI (classes ou continu) à partir du dernier calcul
  function afficherUTCI(r = etat.resUTCI) {
    if (!r) return;
    const ok = [...r.u].filter(Number.isFinite);
    if (!ok.length) { note('Aucune maille ouverte dans le cercle d\'analyse.'); return; }
    const min = Math.min(...ok), max = Math.max(...ok);
    const continu = etat.reglUTCI.affichage === 'continu';
    const classeDe = (v) => CLASSES_UTCI.find((c) => v < c.max) ?? CLASSES_UTCI[CLASSES_UTCI.length - 1];
    const lo = Math.floor(min / 2) * 2, hi = Math.max(lo + 2, Math.ceil(max / 2) * 2);
    const stops = Array.from({ length: 9 }, (_, i) => [i / 8, couleurContinue(lo + ((hi - lo) * i) / 8)]);
    const phase = r.phase === 'projet' ? ' (avec le projet)' : '';
    const titre = `UTCI, ${r.q.libelle}${phase}`;
    const fmtT = (v) => `${fmt(1)(v)} °C`;
    afficher(r.u, continu ? (v) => couleurContinue(v) : (v) => classeDe(v).couleur, {
      utci: true, nom: 'confort-utci', titre, format: fmtT, min: lo, max: hi,
      ...(continu ? { stops, graduations: [lo, (lo + hi) / 2, hi] } : { classes: CLASSES_UTCI, classeDe }),
      classeDe,
      detail: (k) => { const R = etat.grille?.rep; if (R?.[k] >= 0) k = R[k]; return `UTCI ${fmtT(r.u[k])} : ${classeDe(r.u[k]).libelle} — Tmrt ${fmt(0)(r.tmrt[k])} °C, vent ${fmt(1)(r.va[k])} m/s à 10 m`; }, // haute résolution : point de calcul du bloc
      noteLegende: `Estimation pédagogique (±3 à 5 °C). Air ${fmt(1)(r.met.ta)} °C, HR ${Math.round(r.met.hr)} %.`,
      note: `Air ${fmt(1)(r.met.ta)} °C, humidité ${Math.round(r.met.hr)} % (${r.met.source}), soleil à ${Math.round(r.soleilHaut)}°, rayonnement direct ${Math.round(r.met.dni)} W/m², diffus ${Math.round(r.met.dhi)} W/m² ; ${r.texteVent}. Tmrt de ${fmt(0)(Math.min(...[...r.tmrt].filter(Number.isFinite)))} à ${fmt(0)(Math.max(...[...r.tmrt].filter(Number.isFinite)))} °C ; ${r.albedo}.${r.horsDomaine ? ` ${r.horsDomaine} maille(s) hors du domaine du polynôme (entrées bornées).` : ''} Calcul : ${(r.duree / 1000).toFixed(1).replace('.', ',')} s pour ${r.nb.toLocaleString('fr-FR')} mailles${r.dureeSvf > 50 ? ` (dont ouverture au ciel ${(r.dureeSvf / 1000).toFixed(1).replace('.', ',')} s)` : ' (ouverture au ciel réutilisée)'}. ${mention({ court: true })}`,
    });
    app.emettre('legende');
  }

  async function lancerUTCI() {
    if (etat.calculUTCI) return;
    etat.calculUTCI = true;
    ui.boutons?.forEach((b) => { b.disabled = true; });
    try {
      preparerGrille();
      const n = pointsEstimes(rayon());
      const reutilise = etat.svf && etat.svfCle === cleSVF();
      note(`Calcul de l'UTCI sur environ ${n.toLocaleString('fr-FR')} mailles (${reutilise ? 'ouverture au ciel réutilisée, ' : ''}environ ${Math.max(1, Math.round((n * (reutilise ? 0.02 : dureeParMaille)) / 1000))} s)…`);
      progresUTCI('Préparation', 0);
      const r = await calculerUTCI();
      etat.resUTCI = r;
      noterDuree('confort', r.duree, r.nb);
      afficherUTCI(r);
      note(`Carte UTCI calculée en ${(r.duree / 1000).toFixed(1).replace('.', ',')} s.`);
    } catch (e) { note(`Calcul impossible : ${e.message}`); console.warn(e); } finally {
      etat.calculUTCI = false;
      if (ui.progres) ui.progres.hidden = true;
      if (ui.progresTexte) ui.progresTexte.textContent = '';
      ui.boutons?.forEach((b) => { b.disabled = false; });
    }
  }

  // exports de la carte UTCI : PNG (carte + légende), CSV (Lambert-93 comme Chaleur)
  const horodatage = () => new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  function exporterPNG() {
    const r = etat.resUTCI, I = etat.info;
    if (!r || !etat.calque || !I?.utci) { app.signaler('Calculez d\'abord une carte UTCI.'); return; }
    const { nx, nz } = etat.grille, E = Math.max(2, Math.round(900 / nx));
    const L = legendeCarte();
    const lignesLeg = L.items ? Math.ceil(L.items.length / 2) : 2;
    const marge = 90 + lignesLeg * 20 + 40;
    const c = document.createElement('canvas');
    c.width = Math.max(nx * E, 760); c.height = nz * E + marge;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    dessinerTexture(ctx, etat.calque.material.map, 0, 0, nx * E, nz * E);
    const y0 = nz * E;
    ctx.fillStyle = '#2f3b45'; ctx.font = 'bold 15px sans-serif';
    ctx.fillText(`Atlas de l'Hôtel de Ville — Confort : ${I.titre} (nord en haut, maille ${pas} m)`, 12, y0 + 24);
    ctx.font = '12px sans-serif';
    if (L.items) {
      L.items.forEach((it, i) => {
        const x = 12 + (i % 2) * 380, y = y0 + 44 + Math.floor(i / 2) * 20;
        ctx.fillStyle = it.couleur; ctx.fillRect(x, y - 11, 22, 13);
        ctx.fillStyle = '#2f3b45'; ctx.fillText(it.libelle, x + 30, y);
      });
    } else {
      const bx = 12, by = y0 + 40, bw = Math.min(520, c.width - 24);
      const gr = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      for (const [u, col] of L.degrade.stops) gr.addColorStop(u, `rgb(${col.join(',')})`);
      ctx.fillStyle = gr; ctx.fillRect(bx, by, bw, 14);
      ctx.fillStyle = '#2f3b45';
      L.degrade.graduations.forEach((gq, i, A) => { ctx.textAlign = i === 0 ? 'left' : i === A.length - 1 ? 'right' : 'center'; ctx.fillText(gq.texte, bx + gq.u * bw, by + 30); });
      ctx.textAlign = 'left';
    }
    ctx.fillStyle = '#2f3b45'; ctx.font = '12px sans-serif';
    ctx.fillText(`Air ${fmt(1)(r.met.ta)} °C, HR ${Math.round(r.met.hr)} % (${r.met.source}) ; ${r.texteVent}.`.slice(0, 170), 12, c.height - 36);
    ctx.fillStyle = '#a5281b'; ctx.font = 'bold 13px sans-serif';
    ctx.fillText('ESTIMATION PÉDAGOGIQUE — UTCI à ±3 à 5 °C près, Tmrt et vent simplifiés ; pas une simulation certifiée.', 12, c.height - 14);
    c.toBlob((b) => telecharger(`atlas-utci-${horodatage()}.png`, b, 'image/png'), 'image/png');
  }
  function exporterCSV() {
    const r = etat.resUTCI;
    if (!r) { app.signaler('Calculez d\'abord une carte UTCI.'); return; }
    const { zone, nx } = etat.grille;
    const classeDe = (v) => CLASSES_UTCI.find((c) => v < c.max) ?? CLASSES_UTCI[CLASSES_UTCI.length - 1];
    const f1 = (v) => fmt(1)(v);
    const L = ['# Atlas de l\'Hôtel de Ville, outil Confort : carte UTCI — ESTIMATION PÉDAGOGIQUE (±3 à 5 °C, pas une simulation certifiée)',
      `# ${r.q.libelle} ; air ${f1(r.met.ta)} °C, HR ${Math.round(r.met.hr)} % (${r.met.source}) ; ${r.texteVent} ; polynôme UTCI de Bröde et al. (2012) ; coordonnées Lambert-93 (EPSG:2154) ; maille ${pas} m ; séparateur ;`,
      'x_l93;y_l93;utci_c;classe;tmrt_c;vent_10m_ms;ta_c;hr_pct'];
    const R = etat.grille.rep, ext = (a) => (R ? etendre(Float32Array.from(a), R) : a); // haute résolution : une ligne par maille de 1 m
    const U = ext(r.u), TM = ext(r.tmrt), VA = ext(r.va);
    for (let k = 0; k < U.length; k++) {
      if (!Number.isFinite(U[k])) continue;
      const x = zone.x0 + ((k % nx) + 0.5) * pas, z = zone.z0 + (Math.floor(k / nx) + 0.5) * pas;
      const g = app.proj.versGeo(x, z), [X, Y] = versLambert93(g.lat, g.lon);
      L.push([X.toFixed(1), Y.toFixed(1), f1(U[k]), classeDe(U[k]).libelle, f1(TM[k]), f1(VA[k]), f1(r.met.ta), Math.round(r.met.hr)].join(';'));
    }
    telecharger(`atlas-utci-${horodatage()}.csv`, `﻿${L.join('\r\n')}`, 'text/csv'); // BOM UTF-8 (Excel)
  }
  // réglages pour les points de vue (js/vues.js) ; carte UTCI refaite à l'ouverture de l'outil si la vue l'affichait
  function reglages() { return { utci: { ...etat.reglUTCI }, carte: etat.calque && etat.info?.utci ? 'utci' : null }; }
  function regler(r) {
    if (!r) return;
    if (r.utci) { Object.assign(etat.reglUTCI, Object.fromEntries(Object.entries(r.utci).filter(([k]) => k in REGL_UTCI))); memoriserUTCI(); }
    etat.relancerUTCI = r.carte === 'utci';
  }
  app.on('outil', (id) => {
    if (id !== 'confort') { etat.relancerUTCI = false; return; } // une vue qui ouvre un autre outil n'a pas à relancer l'UTCI plus tard
    if (!etat.relancerUTCI) return;
    etat.relancerUTCI = false;
    setTimeout(lancerUTCI, 300);
  });

  // ---------------------------------------------------------------
  // Affichage d'une carte au sol
  // ---------------------------------------------------------------
  function afficher(valeurs, couleur, info) {
    effacerCarte();
    const { zone, nx, nz } = etat.grille;
    etat.pose = [valeurs, couleur, info]; // redessin au changement de « Lisser la carte »
    // haute résolution : valeur du point de calcul recopiée dans les mailles de son bloc (copie : svf et résultats gardent un point par bloc)
    if (etat.grille.rep) valeurs = etendre(Float32Array.from(valeurs), etat.grille.rep);
    // valeurs interpolées entre mailles valides si « Lisser la carte » (js/lissage.js), sinon mailles nettes
    const tex = textureGrille({ nx, nz, alpha: 215, valeur: (k) => valeurs[k], couleur });
    const geo = new THREE.PlaneGeometry(zone.x1 - zone.x0, zone.z1 - zone.z0).rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -11, polygonOffsetUnits: -11 }));
    m.position.set((zone.x0 + zone.x1) / 2, 0.32, (zone.z0 + zone.z1) / 2);
    m.renderOrder = 6;
    m.raycast = () => {};
    m.name = info.nom || 'confort-carte'; // planche à l'échelle : image calée « analyse-<nom> »
    app.scene.add(m);
    etat.calque = m;
    etat.valeurs = valeurs;
    etat.info = info;
    // statistiques sur les espaces ouverts
    const ok = [...valeurs].filter(Number.isFinite);
    const moy = ok.reduce((a, b) => a + b, 0) / Math.max(ok.length, 1);
    ui.resultat.replaceChildren(h('p', { class: 'resultat' }, `${info.titre} : ${info.format(moy)} en moyenne sur les espaces ouverts du cercle d'analyse (de ${info.format(Math.min(...ok))} à ${info.format(Math.max(...ok))}).`));
    if (info.classes) {
      const parts = info.classes.map((c) => ({ ...c, n: ok.filter((v) => info.classeDe(v) === c).length }));
      ui.resultat.append(h('ul', { class: 'legende' }, ...parts.filter((c) => c.n).map((c) => h('li', {}, h('i', { style: { background: `rgb(${c.couleur.join(',')})` } }), `${c.libelle} : ${Math.round((100 * c.n) / ok.length)} %`))));
    } // dégradé : dans la légende automatique (js/legende.js)
    if (info.note) ui.resultat.append(h('p', { class: 'note' }, info.note));
  }

  function effacerCarte() {
    if (!etat.calque) return;
    app.scene.remove(etat.calque);
    etat.calque.geometry.dispose();
    etat.calque.material.map.dispose();
    etat.calque.material.dispose();
    etat.calque = null;
    etat.valeurs = null;
  }

  // valeur sous le pointeur
  app.on('pointeurSol', ([x, z]) => {
    if (!etat.valeurs || !ui.pointeur?.isConnected) return;
    const { zone, nx, nz } = etat.grille;
    const i = Math.floor((x - zone.x0) / pas), j = Math.floor((z - zone.z0) / pas);
    const v = i >= 0 && j >= 0 && i < nx && j < nz ? etat.valeurs[j * nx + i] : NaN;
    ui.pointeur.textContent = !Number.isFinite(v) ? '' : etat.info.detail ? `Sous le pointeur : ${etat.info.detail(j * nx + i)}` : `Sous le pointeur : ${etat.info.format(v)}${etat.info.classeDe ? ` (${etat.info.classeDe(v).libelle})` : ''}`;
  });

  // ---------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------
  const note = (t) => { if (ui.etat) ui.etat.textContent = t; suivreNote(t); };
  const fmt = (d) => (v) => `${v.toFixed(d).replace('.', ',')}`;

  async function lancer(fn) {
    ui.boutons?.forEach((b) => { b.disabled = true; });
    const tP = debut();
    try { await fn(); fin(`Confort : ${fn.profil || 'calcul'} complet`, tP); } catch (e) { note(`Calcul impossible : ${e.message}`); } finally { ui.boutons?.forEach((b) => { b.disabled = false; }); }
  }

  function construirePanneau(conteneur) {
    ui.etat = h('p', { class: 'note', 'aria-live': 'polite' });
    ui.resultat = h('div');
    ui.source = h('p', { class: 'note' });
    const majSource = () => { ui.source.textContent = `Météo : ${mention()} ${sourceEPW() ? 'Rayonnement global, direct et diffus lus dans le fichier EPW.' : 'Rayonnement direct et diffus estimés à partir du global mesuré (modèle d\'Erbs).'}`; };
    ui.majSource = majSource;
    chargerMeteo().then(majSource);
    ui.pointeur = h('p', { class: 'coordonnees' });
    const selPeriode = h('select', { 'aria-label': 'Période' }, ...Object.entries(PERIODES).map(([k, p]) => h('option', { value: k }, p.libelle)));
    const selScenario = h('select', { 'aria-label': 'Scénario' }, ...Object.entries(SCENARIOS).map(([k, s]) => h('option', { value: k }, s.libelle)));
    const bouton = (libelle, fn, discret = false) => { fn.profil = libelle; return h('button', { type: 'button', class: `bouton${discret ? ' discret' : ''}`, onclick: () => lancer(fn) }, libelle); };

    const bSVF = bouton('Ouverture au ciel', async () => {
      preparerGrille();
      const svf = svfValide() ? etat.svf : await calculerSVF();
      afficher(svf, (v) => degrade(v), { titre: 'Facteur de vue du ciel', format: (v) => `${Math.round(v * 100)} %`, min: 0, max: 1, note: 'Part du ciel visible depuis chaque point, à 1,20 m du sol. Faible : rue encaissée, fraîche le jour mais qui se refroidit mal la nuit et reçoit peu de lumière. Élevée : espace ouvert, exposé.' });
      note('');
    });
    const bRay = bouton('Rayonnement au sol', async () => {
      preparerGrille(); if (!svfValide()) etat.svf = null;
      const r = await calculerRayonnement(selPeriode.value);
      const ok = [...r].filter(Number.isFinite);
      const min = Math.min(...ok), max = Math.max(...ok);
      afficher(r, (v) => degrade((v - min) / (max - min || 1)), { titre: `Rayonnement solaire reçu, ${PERIODES[selPeriode.value].libelle.toLowerCase()}`, format: (v) => `${Math.round(v)} kWh/m²`, min, max, note: `Direct et diffus, sans réflexions entre façades. Météo moyenne ${etat.climato.periode}. ${app.arbres?.hiver ? 'Arbres caducs sans feuilles.' : ''}` });
      note('');
    });
    const bFac = bouton('Rayonnement sur les façades', async () => {
      preparerGrille();
      const vals = await calculerFacades(selPeriode.value);
      const tout = vals.flatMap((x) => [...x.vals]);
      const max = Math.max(...tout);
      colorierFacades(vals, max);
      etat.facadesMax = max; etat.facadesPeriode = PERIODES[selPeriode.value].libelle.toLowerCase();
      ui.resultat.replaceChildren(
        h('p', { class: 'resultat' }, `Façades et toits du cercle d'analyse colorés selon le rayonnement reçu, ${PERIODES[selPeriode.value].libelle.toLowerCase()} (jusqu'à ${Math.round(max)} kWh/m²).`),
        h('p', { class: 'note' }, 'Les ombres portées par les bâtiments voisins et les arbres sont prises en compte ; les façades reçoivent aussi le rayonnement réfléchi par le sol.'));
      note('');
    });
    const bConf = bouton('Confort thermique', async () => {
      preparerGrille(); if (!svfValide()) etat.svf = null;
      const r = await calculerConfort(selScenario.value);
      const sc = SCENARIOS[selScenario.value];
      const classeDe = (v) => CLASSES_RESSENTI.find((c) => v < c.max);
      afficher(r.ressenti, (v) => classeDe(v).couleur, {
        titre: `Température ressentie, ${MOIS[sc.mois]} à ${sc.heure} h`, format: (v) => `${fmt(1)(v)} °C`, classes: CLASSES_RESSENTI, classeDe,
        note: `Air ${fmt(1)(r.met.ta)} °C, humidité ${Math.round(r.met.hr)} %, vent ${fmt(1)(r.met.v)} m/s à 10 m, soleil à ${Math.round(r.soleilHaut)}°${sc.chaud ? ` (moyenne des ${r.met.n} heures de juillet à 15 h les plus chaudes)` : ''}. Température radiante moyenne de ${fmt(0)(Math.min(...[...r.tmrt].filter(Number.isFinite)))} à ${fmt(0)(Math.max(...[...r.tmrt].filter(Number.isFinite)))} °C. ${texteVent(sc.mois)} Indice de Steadman avec rayonnement : ordre de grandeur, pas une norme. ${mention({ court: true })}`,
      });
      note('');
    });
    // carte UTCI (07/11/2026)
    const R = etat.reglUTCI;
    const bUTCI = h('button', { type: 'button', class: 'bouton', onclick: () => lancerUTCI() }, 'Carte UTCI');
    ui.momentUTCI = h('p', { class: 'note moment-utci', 'data-garder': '' });
    ui.majMoment = () => { if (ui.momentUTCI?.isConnected) ui.momentUTCI.textContent = `Moment : ${momentBarre().libelle} (barre du temps, en haut à droite).`; };
    ui.majMoment();
    const selMeteo = h('select', { 'aria-label': 'Météo de l\'UTCI', onchange: (e) => { R.meteo = e.target.value; memoriserUTCI(); } },
      ...sourcesMeteoUTCI().map(([v, l]) => h('option', { value: v, selected: v === R.meteo }, l)));
    ui.selMeteoUTCI = selMeteo;
    // journées types de Chaleur (data/chaleur/journees.json) : chargées à la demande pour compléter la liste
    app.chaleur?.charger?.().then(() => { if (!selMeteo.isConnected) return; const L = sourcesMeteoUTCI(); if (L.length !== selMeteo.options.length) selMeteo.replaceChildren(...L.map(([v, l]) => h('option', { value: v, selected: v === R.meteo }, l))); }).catch(() => {});
    const selVent = h('select', { 'aria-label': 'Vent de l\'UTCI', onchange: (e) => { R.vent = e.target.value; memoriserUTCI(); } },
      ...[['panneau', 'Outil Vent : direction et vitesse du panneau'], ['meteo', 'Outil Vent : direction du panneau, vitesse de la météo de l\'heure'], ['ciel', 'Sans écoulement : abri selon l\'ouverture au ciel']]
        .map(([v, l]) => h('option', { value: v, selected: v === R.vent }, l)));
    const boutonsAff = [['classes', 'Classes de stress'], ['continu', 'Continu (°C)']].map(([v, l]) => h('button', { type: 'button', 'data-aff': v, 'aria-pressed': String(R.affichage === v),
      onclick: () => {
        R.affichage = v; memoriserUTCI();
        boutonsAff.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.aff === v)));
        if (etat.calque && etat.info?.utci) afficherUTCI();
      } }, l));
    ui.progres = h('progress', { class: 'progres-confort', max: 1, value: 0, hidden: true });
    ui.progresTexte = h('span', { class: 'progres-confort-texte', 'aria-live': 'off' });
    const blocUTCI = [
      h('div', { class: 'titre-info' }, h('h3', {}, 'Carte UTCI (stress thermique)'),
        info('UTCI (Universal Thermal Climate Index, °C) : température d\'un environnement de référence (ombre, vent faible, 50 % d\'humidité) qui produirait la même contrainte physiologique qu\'ici. Calcul : polynôme d\'approximation officiel « UTCI_approx » (6e ordre, 210 termes) de Bröde P., Fiala D., Błażejczyk K. et al. (2012), « Deriving the operational procedure for the Universal Thermal Climate Index (UTCI) », International Journal of Biometeorology 56 : 481-494 ; www.utci.org. Domaine : Ta −50 à 50 °C, Tmrt − Ta −30 à 70 K, vent à 10 m de 0,5 à 17 m/s (hors domaine : entrées bornées). Classes de stress de Błażejczyk et al. (2013).',
          'Entrées : air et humidité de la météo choisie au jour et à l\'heure de la barre du temps (moyenne du mois à cette heure, ou journée type de l\'outil Chaleur, tirée de l\'EPW si cette source est choisie) ; température radiante moyenne (Tmrt) estimée par maille à 1,1 m du sol : méthode des facteurs d\'angle d\'une personne debout (moitié haute : ciel selon l\'ouverture au ciel et façades à la température de l\'air ; moitié basse : sol chauffé par le soleil qu\'il reçoit ; soleil direct sur l\'aire projetée du corps s\'il n\'est masqué ni par le bâti ni par les arbres ; αk 0,7, εp 0,97 ; Tmrt = (Sstr / (εp σ))^¼ − 273,15) ; albédo du sol de la grille des matériaux de Chaleur si elle est calculée, sinon 0,2 ; sous une couronne : soleil et ciel filtrés (12 %, caducs 12 à 65 % selon la saison).',
          'Vent : champ 2D de l\'outil Vent pour la direction et la vitesse de son panneau (qui suivent la période choisie si la case « Direction suivant la période » est cochée) : vent piéton = 0,70 × rapport local × vent de la station, ramené à 10 m (hauteur attendue par l\'UTCI) par une loi en puissance d\'exposant 0,18 : v10 = v(1,5 m) × (10 / 1,5)^0,18 ≈ 1,41 v(1,5 m). Variantes : vitesse de la météo de l\'heure, ou abri estimé par l\'ouverture au ciel (0,35 + 0,65 SVF, comme Chaleur).',
          'Limites : Tmrt simplifiée (façades à la température de l\'air, pas de réflexions multiples ni de façades chauffées au soleil, ciel clair de Brutsaert), vent 2D estimé, météo moyenne : écart de l\'ordre de 3 à 5 °C sur l\'UTCI. À lire pour comparer les lieux entre eux. Pour une étude validée : Ladybug Tools (UTCI avec SolarCal et Radiance) avec un fichier EPW.')),
      h('p', { class: 'note confort-bandeau', 'data-garder': '' }, h('strong', {}, 'Estimation pédagogique'), ' : UTCI à ±3 à 5 °C, Tmrt et vent simplifiés.'),
      ui.momentUTCI,
      h('label', { class: 'champ' }, h('span', {}, 'Météo'), selMeteo),
      h('label', { class: 'champ' }, h('span', {}, 'Vent'), selVent),
      h('div', { class: 'segment-vent segment-utci', role: 'group', 'aria-label': 'Affichage de la carte UTCI' }, ...boutonsAff),
      h('div', { class: 'actions' }, bUTCI,
        h('button', { type: 'button', class: 'bouton discret', onclick: exporterPNG, title: 'Carte UTCI et sa légende' }, 'PNG'),
        h('button', { type: 'button', class: 'bouton discret', onclick: exporterCSV, title: 'Valeurs par maille, Lambert-93' }, 'CSV')),
      h('div', { class: 'progres-utci', 'data-garder': '' }, ui.progres, ui.progresTexte),
    ];
    ui.boutons = [bSVF, bRay, bFac, bConf, bUTCI];
    conteneur.append(...[
      app.meteoSource?.bloc(),
      h('p', { class: 'note' }, `Analyses dans le cercle bleu, centré sur le centre du projet, à partir de la météo horaire moyenne de la source choisie ci-dessus (par défaut Météo-France à Nantes-Bouguenais, 2016-2025, rayonnement direct et diffus estimés à partir du global mesuré ; ou fichier EPW), du bâti et des arbres.`),
      h('label', { class: 'champ' }, h('span', {}, 'Rayon d\'analyse (m)'), (() => {
        const input = h('input', { type: 'number', min: 30, max: 600, step: 5, value: Math.round(rayon()) });
        input.addEventListener('change', () => {
          const v = parseFloat(input.value);
          if (!(v >= 30 && v <= 600)) { input.value = Math.round(rayon()); return; }
          app.config.rayonConfort = v;
          modifierReglageCentre({ rayonConfort: v });
          majCercle();
          effacerCarte(); etat.grille = null; etat.svf = null; ui.resultat.replaceChildren();
          note(`Cercle d'analyse de ${Math.round(v * 2)} m de diamètre${v > 200 ? ' : calculs plus longs (maille de ' + (v <= 300 ? 3 : 4) + ' m)' : ''}.`);
        });
        return input;
      })()),
      h('h3', {}, 'Ouverture au ciel'),
      h('div', { class: 'actions' }, bSVF),
      h('h3', {}, 'Rayonnement solaire cumulé'),
      h('label', { class: 'champ' }, h('span', {}, 'Période'), selPeriode),
      h('div', { class: 'actions' }, bRay, bFac, bouton('Façades en blanc', async () => effacerFacades(), true)),
      h('h3', {}, 'Confort thermique extérieur'),
      h('label', { class: 'champ' }, h('span', {}, 'Scénario'), selScenario),
      h('div', { class: 'actions' }, bConf),
      ...blocUTCI,
      caseLissage(app),
      blocResolution(app, { outil: 'confort', rayon }),
      ui.etat,
      ui.resultat,
      ui.pointeur,
      h('div', { class: 'actions' },
        bouton('Effacer la carte', async () => { effacerCarte(); ui.resultat.replaceChildren(); }, true)),
      ui.source,
      blocWebGPU(),
      h('p', { class: 'note' }, 'Modèle simplifié, calculé dans le navigateur : pas de réflexions multiples ni d\'effet du vent autour des bâtiments. Pour une étude validée, exporter la maquette (outil Exporter) vers Rhino et Ladybug Tools (moteur Radiance), avec un fichier météo EPW de Nantes.'),
    ].filter(Boolean));
  }

  app.on('lissage', () => { if (etat.calque && etat.pose) afficher(...etat.pose); });
  app.on('resolution', () => { effacerCarte(); etat.grille = null; etat.svf = null; etat.resUTCI = null; if (ui.resultat) ui.resultat.replaceChildren(); });
  app.on('etat', () => { effacerCarte(); etat.grille = null; etat.svf = null; if (ui.resultat) ui.resultat.replaceChildren(); });
  // barre du temps : moment affiché ; carte UTCI affichée refaite pour le nouveau jour / la nouvelle heure (après 0,8 s sans changement)
  let minuterieUTCI = 0;
  app.on('soleil', () => {
    ui.majMoment?.();
    if (!etat.calque || !etat.info?.utci) return;
    const q = momentBarre();
    if (etat.resUTCI && etat.resUTCI.q.libelle === q.libelle && etat.resUTCI.q.annee === q.annee) return;
    clearTimeout(minuterieUTCI);
    minuterieUTCI = setTimeout(() => { if (etat.calque && etat.info?.utci) lancerUTCI(); }, 800);
  });
  // bâti modifié par le projet (onglet Bâtiments) : grille des hauteurs et résultats à recalculer
  app.on('bati', () => { effacerCarte(); etat.grille = null; etat.svf = null; if (ui.resultat) ui.resultat.replaceChildren(); });
  app.on('arbres', () => { etat.svf = null; }); // arbres relevés ajoutés ou supprimés (outil Relevé) : ouverture au ciel à refaire
  // source météo changée (base / EPW) : climatologie relue, résultats affichés à refaire
  app.on('meteoSource', () => {
    etat.climato = null;
    effacerCarte();
    if (ui.resultat?.isConnected) { ui.resultat.replaceChildren(); note('Source météo changée : relancer le calcul.'); ui.majSource?.(); }
  });

  // légende automatique (js/legende.js) : carte affichée (classes de température ressentie ou dégradé gradué)
  function legendeAuto() {
    const L = [legendeCarte()];
    if (etat.facadesActives && etat.facadesMax) L.push({ id: 'confort-facades', titre: `Rayonnement reçu par les façades et toits, ${etat.facadesPeriode || ''}`.replace(/, $/, ''),
      degrade: { stops: STOPS_DEGRADE, graduations: [0, 0.5, 1].map((u) => ({ u, texte: `${Math.round(u * etat.facadesMax)} kWh/m²` })) } });
    return L.filter(Boolean);
  }
  function legendeCarte() {
    const I = etat.info;
    if (!etat.calque || !I) return null;
    if (I.classes) {
      // UTCI en classes : seules les classes présentes sur la carte (et leurs voisines) ; note d'estimation
      const presentes = I.utci ? new Set([...etat.valeurs].filter(Number.isFinite).map((v) => I.classeDe(v))) : null;
      return { id: 'confort', titre: I.titre, ...(I.noteLegende ? { note: I.noteLegende } : {}), items: I.classes.map((c, k) => {
        const a = k ? I.classes[k - 1].max : null;
        const plage = a == null ? `moins de ${c.max} °C` : c.max === Infinity ? `plus de ${a} °C` : `${a} à ${c.max} °C`;
        return { libelle: `${c.libelle} (${plage})`, couleur: `rgb(${c.couleur.join(',')})`, forme: 'aplat', present: !presentes || presentes.has(c) };
      }).filter((it, k, A) => !presentes || it.present || A[k - 1]?.present || A[k + 1]?.present).map(({ present, ...it }) => it) };
    }
    const min = I.min ?? 0, max = I.max ?? 1;
    const grad = I.graduations ? I.graduations.map((v) => ({ u: (v - min) / (max - min || 1), texte: I.format(v) })) : [0, 0.5, 1].map((u) => ({ u, texte: I.format(min + u * (max - min)) }));
    return { id: 'confort', titre: I.titre, ...(I.noteLegende ? { note: I.noteLegende } : {}),
      degrade: { stops: I.stops || STOPS_DEGRADE, graduations: grad } };
  }

  return { construirePanneau, calculerSVF, preparerDiagnostic, blocWebGPU, legendeAuto, calculerRayonnement, calculerConfort, climatologie, effacerCarte, effacerFacades, etat,
    calculerUTCI, lancerUTCI, afficherUTCI, exporterPNG, exporterCSV, reglages, regler };
}
