import * as THREE from 'three';
import { getPosition } from '../lib/suncalc.js';
import { h } from './util.js';
import { modifierReglageCentre } from './centre.js';
import { dateParis } from './geo.js';
import { chargerMeteo, horaire, partAuDessus, mention, libelleSaison, sourceEPW } from './meteo.js';

// Rayonnement et confort de l'espace public.
// Modèle volontairement simple et explicite (calcul dans le navigateur, sans réflexions multiples) :
// - ouverture au ciel (facteur de vue du ciel) depuis une grille des hauteurs du bâti et des arbres ;
// - rayonnement solaire cumulé : direct (s'il n'est pas masqué) + diffus (pondéré par l'ouverture au ciel),
//   à partir de la météo horaire moyenne par mois et par heure mesurée par Météo-France à Nantes-Bouguenais
//   (data/meteo/meteo_horaire.json : global mesuré, direct et diffus estimés par le modèle d'Erbs) ;
// - température radiante moyenne et température ressentie (Steadman, avec rayonnement) pour des scénarios types.
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
  app.on('outil', (id) => { cercle.visible = id === 'confort'; });

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
    const r = rayon();
    pas = r <= 150 ? 2 : r <= 300 ? 3 : 4;
    const zone = app.soleil.zoneAnalyse(r);
    const g = app.soleil.grilleHauteurs(zone);
    const nx = Math.ceil((zone.x1 - zone.x0) / pas), nz = Math.ceil((zone.z1 - zone.z0) / pas);
    etat.grille = { zone, g, nx, nz };
    return etat.grille;
  }

  // Hauteur d'horizon (angle d'élévation) vue depuis (x, z, y0) dans une direction
  function horizon(g, x, z, y0, sx, sz, dMax = 160) {
    let tanMax = 0;
    for (let d = 2; d <= dMax; d += 2) {
      const hh = app.soleil.hauteurEn(g, x + sx * d, z + sz * d);
      const t = (hh - y0) / d;
      if (t > tanMax) tanMax = t;
    }
    return Math.atan(tanMax);
  }

  async function calculerSVF() {
    const { zone, g, nx, nz } = etat.grille || preparerGrille();
    const n = 36;
    const dirs = Array.from({ length: n }, (_, k) => [Math.sin((k / n) * 2 * Math.PI), -Math.cos((k / n) * 2 * Math.PI)]);
    const svf = new Float32Array(nx * nz).fill(NaN);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        if (!dansCercle(x, z) || app.soleil.hauteurEn(g, x, z) > 0.5) continue;
        let s = 0;
        for (const [sx, sz] of dirs) { const b = horizon(g, x, z, 1.2, sx, sz); s += Math.sin(b) ** 2; }
        svf[j * nx + i] = 1 - s / n;
      }
      if (j % 10 === 0) { note(`Ouverture au ciel : ${Math.round((j / nz) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
    }
    etat.svf = svf;
    return svf;
  }

  // Le point est-il au soleil ? (marche le long du rayon dans la grille des hauteurs)
  function auSoleil(g, x, z, y0, sx, sz, tanAlt) {
    for (let d = 1; d < 400; d += 1.5) {
      const ray = y0 + d * tanAlt;
      if (ray > 150) return true;
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
    const svf = etat.svf || await calculerSVF();
    const S = soleils(PERIODES[periode].mois);
    const res = new Float32Array(nx * nz).fill(NaN);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const k = j * nx + i;
        if (!Number.isFinite(svf[k])) continue;
        const x = zone.x0 + (i + 0.5) * pas, z = zone.z0 + (j + 0.5) * pas;
        let e = 0;
        for (const s of S) {
          let w = s.met.dhi * svf[k];
          if (s.alt > 0.02 && s.met.dni > 0 && auSoleil(g, x, z, 0.3, s.sx, s.sz, s.tanAlt)) w += s.met.dni * s.cosZ;
          e += w * s.poids;
        }
        res[k] = e / 1000; // Wh -> kWh
      }
      if (j % 6 === 0) { note(`Rayonnement : ${Math.round((j / nz) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
    }
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
      if (++fait % 10 === 0) { note(`Façades : ${Math.round((fait / cibles.length) * 100)} %`); await new Promise((res) => setTimeout(res, 0)); }
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
    const svf = etat.svf || await calculerSVF();
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
      if (j % 10 === 0) { note(`Confort : ${Math.round((j / nz) * 100)} %`); await new Promise((r) => setTimeout(r, 0)); }
    }
    return { tmrt, ressenti, met, soleilHaut: pSol.altitude };
  }

  // ---------------------------------------------------------------
  // Affichage d'une carte au sol
  // ---------------------------------------------------------------
  function afficher(valeurs, couleur, info) {
    effacerCarte();
    const { zone, nx, nz } = etat.grille;
    const px = new Uint8Array(nx * nz * 4);
    for (let k = 0; k < valeurs.length; k++) {
      if (!Number.isFinite(valeurs[k])) continue;
      px.set([...couleur(valeurs[k]), 215], k * 4);
    }
    const tex = new THREE.DataTexture(px, nx, nz, THREE.RGBAFormat);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const geo = new THREE.PlaneGeometry(zone.x1 - zone.x0, zone.z1 - zone.z0).rotateX(-Math.PI / 2);
    const uv = geo.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -11, polygonOffsetUnits: -11 }));
    m.position.set((zone.x0 + zone.x1) / 2, 0.32, (zone.z0 + zone.z1) / 2);
    m.renderOrder = 6;
    m.raycast = () => {};
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
    } else if (info.min != null) {
      ui.resultat.append(h('div', { class: 'legende-soleil' }, h('span', {}, info.format(info.min)), h('i', { style: { background: 'linear-gradient(90deg, rgb(40,50,110), rgb(60,110,170) 25%, rgb(120,180,170) 50%, rgb(230,210,110) 75%, rgb(245,150,40))' } }), h('span', {}, info.format(info.max))));
    }
    if (info.note) ui.resultat.append(h('p', { class: 'note' }, info.note));
  }

  function effacerCarte() {
    if (!etat.calque) return;
    app.scene.remove(etat.calque);
    etat.calque.geometry.dispose();
    etat.calque.material.map.dispose();
    etat.calque = null;
    etat.valeurs = null;
  }

  // valeur sous le pointeur
  app.on('pointeurSol', ([x, z]) => {
    if (!etat.valeurs || !ui.pointeur?.isConnected) return;
    const { zone, nx, nz } = etat.grille;
    const i = Math.floor((x - zone.x0) / pas), j = Math.floor((z - zone.z0) / pas);
    const v = i >= 0 && j >= 0 && i < nx && j < nz ? etat.valeurs[j * nx + i] : NaN;
    ui.pointeur.textContent = Number.isFinite(v) ? `Sous le pointeur : ${etat.info.format(v)}` : '';
  });

  // ---------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------
  const note = (t) => { if (ui.etat) ui.etat.textContent = t; };
  const fmt = (d) => (v) => `${v.toFixed(d).replace('.', ',')}`;

  async function lancer(fn) {
    ui.boutons?.forEach((b) => { b.disabled = true; });
    try { await fn(); } catch (e) { note(`Calcul impossible : ${e.message}`); } finally { ui.boutons?.forEach((b) => { b.disabled = false; }); }
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
    const bouton = (libelle, fn, discret = false) => h('button', { type: 'button', class: `bouton${discret ? ' discret' : ''}`, onclick: () => lancer(fn) }, libelle);

    const bSVF = bouton('Ouverture au ciel', async () => {
      preparerGrille(); etat.svf = null;
      const svf = await calculerSVF();
      afficher(svf, (v) => degrade(v), { titre: 'Facteur de vue du ciel', format: (v) => `${Math.round(v * 100)} %`, min: 0, max: 1, note: 'Part du ciel visible depuis chaque point, à 1,20 m du sol. Faible : rue encaissée, fraîche le jour mais qui se refroidit mal la nuit et reçoit peu de lumière. Élevée : espace ouvert, exposé.' });
      note('');
    });
    const bRay = bouton('Rayonnement au sol', async () => {
      preparerGrille(); etat.svf = null;
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
      ui.resultat.replaceChildren(
        h('p', { class: 'resultat' }, `Façades et toits du cercle d'analyse colorés selon le rayonnement reçu, ${PERIODES[selPeriode.value].libelle.toLowerCase()} (jusqu'à ${Math.round(max)} kWh/m²).`),
        h('div', { class: 'legende-soleil' }, h('span', {}, '0'), h('i', { style: { background: 'linear-gradient(90deg, rgb(40,50,110), rgb(60,110,170) 25%, rgb(120,180,170) 50%, rgb(230,210,110) 75%, rgb(245,150,40))' } }), h('span', {}, `${Math.round(max)} kWh/m²`)),
        h('p', { class: 'note' }, 'Les ombres portées par les bâtiments voisins et les arbres sont prises en compte ; les façades reçoivent aussi le rayonnement réfléchi par le sol.'));
      note('');
    });
    const bConf = bouton('Confort thermique', async () => {
      preparerGrille(); etat.svf = null;
      const r = await calculerConfort(selScenario.value);
      const sc = SCENARIOS[selScenario.value];
      const classeDe = (v) => CLASSES_RESSENTI.find((c) => v < c.max);
      afficher(r.ressenti, (v) => classeDe(v).couleur, {
        titre: `Température ressentie, ${MOIS[sc.mois]} à ${sc.heure} h`, format: (v) => `${fmt(1)(v)} °C`, classes: CLASSES_RESSENTI, classeDe,
        note: `Air ${fmt(1)(r.met.ta)} °C, humidité ${Math.round(r.met.hr)} %, vent ${fmt(1)(r.met.v)} m/s à 10 m, soleil à ${Math.round(r.soleilHaut)}°${sc.chaud ? ` (moyenne des ${r.met.n} heures de juillet à 15 h les plus chaudes)` : ''}. Température radiante moyenne de ${fmt(0)(Math.min(...[...r.tmrt].filter(Number.isFinite)))} à ${fmt(0)(Math.max(...[...r.tmrt].filter(Number.isFinite)))} °C. ${texteVent(sc.mois)} Indice de Steadman avec rayonnement : ordre de grandeur, pas une norme. ${mention({ court: true })}`,
      });
      note('');
    });
    ui.boutons = [bSVF, bRay, bFac, bConf];
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
      ui.etat,
      ui.resultat,
      ui.pointeur,
      h('div', { class: 'actions' },
        bouton('Effacer la carte', async () => { effacerCarte(); ui.resultat.replaceChildren(); }, true)),
      ui.source,
      h('p', { class: 'note' }, 'Modèle simplifié, calculé dans le navigateur : pas de réflexions multiples ni d\'effet du vent autour des bâtiments. Pour une étude validée, exporter la maquette (outil Exporter) vers Rhino et Ladybug Tools (moteur Radiance), avec un fichier météo EPW de Nantes.'),
    ].filter(Boolean));
  }

  app.on('etat', () => { effacerCarte(); etat.grille = null; etat.svf = null; if (ui.resultat) ui.resultat.replaceChildren(); });
  // bâti modifié par le projet (onglet Bâtiments) : grille des hauteurs et résultats à recalculer
  app.on('bati', () => { effacerCarte(); etat.grille = null; etat.svf = null; if (ui.resultat) ui.resultat.replaceChildren(); });
  // source météo changée (base / EPW) : climatologie relue, résultats affichés à refaire
  app.on('meteoSource', () => {
    etat.climato = null;
    effacerCarte();
    if (ui.resultat?.isConnected) { ui.resultat.replaceChildren(); note('Source météo changée : relancer le calcul.'); ui.majSource?.(); }
  });

  // légende automatique (js/legende.js) : carte affichée (classes de température ressentie ou dégradé gradué)
  function legendeAuto() {
    const I = etat.info;
    if (!etat.calque || !I) return null;
    if (I.classes) {
      return { id: 'confort', titre: I.titre, items: I.classes.map((c, k) => {
        const a = k ? I.classes[k - 1].max : null;
        const plage = a == null ? `moins de ${c.max} °C` : c.max === Infinity ? `plus de ${a} °C` : `${a} à ${c.max} °C`;
        return { libelle: `${c.libelle} (${plage})`, couleur: `rgb(${c.couleur.join(',')})`, forme: 'aplat' };
      }) };
    }
    const min = I.min ?? 0, max = I.max ?? 1;
    return { id: 'confort', titre: I.titre,
      degrade: { stops: STOPS_DEGRADE, graduations: [0, 0.5, 1].map((u) => ({ u, texte: I.format(min + u * (max - min)) })) } };
  }

  return { construirePanneau, calculerSVF, legendeAuto, calculerRayonnement, calculerConfort, climatologie, effacerCarte, etat };
}
