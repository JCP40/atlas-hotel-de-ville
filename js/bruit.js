import * as THREE from 'three';
import { h, info, lireLS, ecrireLS, viderGroupe, allerVers } from './util.js';
import { chercherJeux, lireJeuGeo, lireCartesBruitEtat, enregistrerDonnees, telecharger } from './donnees.js';
import { lireCache, ecrireCache } from './cache.js';
import { empriseAutour, polygonesLocaux } from './geo.js';
import { geometriesPlates } from './maquette.js';
import { versLambert93 } from './export.js';
import { creerClassementSonore, CATEGORIES_SONORES } from './classement-sonore.js';
import { creerModeleBruit } from './bruit-modele.js'; // modèle de bruit calculé (21/11/2026)

// Carte du bruit : zones de bruit des cartes de bruit stratégiques (CBS, directive européenne 2002/49/CE),
// indicateurs Lden (moyenne jour-soir-nuit pondérée) ou Ln (nuit), par tranches de 5 dB(A).
// Données (20/11/2026) : data/bruit.geojson produit par outils/bruit/cbs.py depuis l'archive de l'État
// (CBS 2022 de la DDTM de Loire-Atlantique, réseaux routiers et ferroviaires non concédés, Licence Ouverte 2.0) :
// zones de type A (classes, db_lo = borne basse) et C (secteurs où les valeurs limites sont dépassées, db_lo = valeur limite),
// Lden et Ln, routes et voies ferrées, découpées à 800 m autour de config.origine. Propriétés : indicateur, db_lo, source,
// type, annee, producteur, id. Le lecteur WFS de Géo-IDE (type A seulement) et les GeoJSON importés restent lus
// (normaliser() : type A par défaut, indicateur et source devinés des attributs).
// Les CBS sont CALCULÉES par l'État à 4 m au-dessus du sol (arrêté du 4 avril 2006, art. 1) : l'atlas n'en fait aucun calcul,
// il les affiche et lit, pour chaque façade et chaque bâtiment, la classe des zones à 2 m devant le mur.
// Couleurs proches de la norme NF S 31-130.
export const CLASSES_BRUIT = [
  { min: 0, max: 50, libelle: 'moins de 50 dB(A)', couleur: '#b9dca4' },
  { min: 50, max: 55, libelle: '50 à 55 dB(A)', couleur: '#f0e442' },
  { min: 55, max: 60, libelle: '55 à 60 dB(A)', couleur: '#f7b32b' },
  { min: 60, max: 65, libelle: '60 à 65 dB(A)', couleur: '#ef7d2d' },
  { min: 65, max: 70, libelle: '65 à 70 dB(A)', couleur: '#d7263d' },
  { min: 70, max: 75, libelle: '70 à 75 dB(A)', couleur: '#8e2b53' },
  { min: 75, max: 200, libelle: 'plus de 75 dB(A)', couleur: '#3d3d9e' },
];

// Seuils de comparaison (dB(A)), par source et par indicateur.
// - Valeurs limites françaises : arrêté du 4 avril 2006 relatif à l'établissement des cartes de bruit et des PPBE, art. 7
//   (version consolidée ; modifié par l'arrêté du 23 décembre 2021) : route et/ou ligne à grande vitesse Lden 68 / Ln 62,
//   voie ferrée conventionnelle Lden 73 / Ln 65 (aérodromes 55 / 50, industrie 71 / 60, non traités ici). Elles concernent les
//   bâtiments d'habitation, d'enseignement et de santé. Ce sont aussi les isophones des cartes de type C.
// - Recommandations de l'OMS : Environmental Noise Guidelines for the European Region, OMS Europe, 2018
//   (ISBN 978 92 890 5356 3, https://iris.who.int/handle/10665/279952) : trafic routier Lden 53 / Lnight 45,
//   ferroviaire Lden 54 / Lnight 44 (recommandations « fortes », sauf Lden ferroviaire et Lnight : voir le document).
export const SEUILS_BRUIT = {
  fr: {
    id: 'fr', libelle: 'valeur limite (France)', court: 'FR',
    routes: { Lden: 68, Ln: 62 }, 'voies ferrées': { Lden: 73, Ln: 65 },
    source: 'Arrêté du 4 avril 2006 modifié (version consolidée après l\'arrêté du 23 décembre 2021), article 7 : route et/ou ligne à grande vitesse Lden 68 dB(A), Ln 62 dB(A) ; voie ferrée conventionnelle Lden 73 dB(A), Ln 65 dB(A). Valeurs applicables aux bâtiments d\'habitation, d\'enseignement et de santé.',
  },
  oms: {
    id: 'oms', libelle: 'recommandation OMS (2018)', court: 'OMS',
    routes: { Lden: 53, Ln: 45 }, 'voies ferrées': { Lden: 54, Ln: 44 },
    source: 'OMS Europe, Environmental Noise Guidelines for the European Region (2018) : trafic routier sous 53 dB Lden et 45 dB Lnight ; trafic ferroviaire sous 54 dB Lden et 44 dB Lnight.',
  },
};
export const SOURCES_BRUIT = [
  { id: 'routes', libelle: 'Routes', court: 'ROUTE', cle: 'routes' },
  { id: 'voies ferrées', libelle: 'Voies ferrées', court: 'FER', cle: 'fer' },
];
const CLE = 'atlas-hdv-bruit'; // jeu affiché
const CLE_REGLAGES = 'atlas-hdv-bruit-reglages'; // { nuit, sources: { routes, fer }, seuil, typeC }
const COULEUR_SEUIL = '#5b0a1f';
const virgule = (v) => String(v).replace('.', ',');

// Niveau (borne basse) lu dans les attributs, quelle que soit la forme du jeu de données
export function niveauDe(props) {
  const valeurs = Object.entries(props || {});
  for (const [k, v] of valeurs) {
    if (/db_?lo|dblo|isolevel|niv_?min|lden_?min|classe_?min|^legende$/i.test(k) && Number.isFinite(parseFloat(v))) return parseFloat(v);
  }
  for (const [, v] of valeurs) {
    const s = String(v ?? '');
    let m = s.match(/(\d{2})\s*(?:-|à|a|_|\/)\s*(\d{2})\s*(?:db)?/i);
    if (m && +m[2] - +m[1] === 5) return +m[1];
    m = s.match(/(?:>|sup[ée]rieur\s*(?:à|a)?|plus de)\s*(\d{2})/i);
    if (m) return +m[1];
  }
  for (const [k, v] of valeurs) {
    if (/lden|niveau|db|legende|classe/i.test(k) && Number.isFinite(parseFloat(v)) && parseFloat(v) >= 40 && parseFloat(v) <= 90) return parseFloat(v);
  }
  return null;
}
const classeDe = (n) => CLASSES_BRUIT.find((c) => n >= c.min && n < c.max) || null;
// dernière classe ouverte : Lden 75 et plus, Ln 70 et plus (arrêté du 4 avril 2006, art. 4)
const ouverte = (n, ind) => n >= (ind === 'Ln' ? 70 : 75);
export const libelleClasse = (n, ind) => (n == null ? 'non cartographié' : ouverte(n, ind) ? `${n} dB(A) et plus` : `${n} à ${n + 5} dB(A)`);
const courtClasse = (n, ind) => (n == null ? '—' : ouverte(n, ind) ? `≥ ${n}` : `${n}–${n + 5}`);

// indicateur, source, type et niveau d'une zone, quelle que soit la forme du jeu
export function normaliser(p = {}) {
  const tout = Object.values(p).map(String).join(' ');
  const i0 = String(p.indicateur ?? p.INDICETYPE ?? p.indice ?? '');
  const ind = /^(ln|lnight|n)$/i.test(i0) ? 'Ln' : /^(lden|ld)$/i.test(i0) ? 'Lden'
    : (/\bLn\b|[-_.]LN\b|nuit|night/i.test(tout) && !/lden|[-_.]LD\b/i.test(tout) ? 'Ln' : 'Lden');
  const s0 = String(p.source ?? p.TYPESOURCE ?? '');
  const src = /^f$|fer|rail/i.test(s0) || (!s0 && /[-_.]F-[AC]-|ferr|rail/i.test(tout)) ? 'voies ferrées' : 'routes';
  const t0 = String(p.type ?? p.CBSTYPE ?? '');
  const type = /^c$/i.test(t0) || (!t0 && /[-_.][RF]-C-/i.test(tout)) ? 'C' : 'A';
  return { ind, src, type, n: niveauDe(p) };
}

// ------------------------------------------------------------------
// Point dans polygone rapide : arêtes rangées par bandes horizontales de 4 m
// ------------------------------------------------------------------
const BANDE = 4;
function prepAnneau(a) {
  let zmin = Infinity;
  for (const [, z] of a) zmin = Math.min(zmin, z);
  const bandes = new Map();
  for (let i = 0, n = a.length; i < n; i++) {
    const [x1, z1] = a[i], [x2, z2] = a[(i + 1) % n];
    if (z1 === z2) continue;
    const b0 = Math.floor((Math.min(z1, z2) - zmin) / BANDE), b1 = Math.floor((Math.max(z1, z2) - zmin) / BANDE);
    for (let b = b0; b <= b1; b++) { if (!bandes.has(b)) bandes.set(b, []); bandes.get(b).push([x1, z1, x2, z2]); }
  }
  return { zmin, bandes };
}
function dansAnneau(A, x, z) {
  const ar = A.bandes.get(Math.floor((z - A.zmin) / BANDE));
  if (!ar) return false;
  let c = false;
  for (const [x1, z1, x2, z2] of ar) if ((z1 > z) !== (z2 > z) && x < ((x2 - x1) * (z - z1)) / (z2 - z1) + x1) c = !c;
  return c;
}
const dansZone = (Z, x, z) => x >= Z.bb[0] && x <= Z.bb[2] && z >= Z.bb[1] && z <= Z.bb[3]
  && dansAnneau(Z.anneaux[0], x, z) && !Z.anneaux.slice(1).some((t) => dansAnneau(t, x, z));
function dansAnneauSimple(a, x, z) {
  let c = false;
  for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
    const [xi, zi] = a[i], [xj, zj] = a[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
  }
  return c;
}

// texture des hachures des zones au-dessus du seuil, UV en mètres (ShapeGeometry) : diagonales montantes tous les 4 m
// (le non cartographié a sa propre texture, textureNonCartographie dans creerBruit)
const texHachures = {};
function hachures(sorte = 'seuil') {
  if (texHachures[sorte]) return texHachures[sorte];
  const c = document.createElement('canvas'); c.width = c.height = 32;
  const g = c.getContext('2d');
  g.strokeStyle = '#ffffff'; g.lineWidth = 5;
  for (const d of [-32, 0, 32]) { g.beginPath(); g.moveTo(d, 32); g.lineTo(d + 32, 0); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  // sans mipmaps : en vue éloignée, la moyenne des niveaux réduits effaçait des traits fins (alpha < seuil de rejet)
  t.generateMipmaps = false; t.minFilter = THREE.LinearFilter;
  t.repeat.set(1 / 4, 1 / 4);
  texHachures[sorte] = t;
  return t;
}
const COULEUR_NC = '#7d848a'; // 24/11/2026 : plus clair (avant #5f666d)
// disque (anneau extérieur) de rayon r en mètres locaux
const disque = (r, n = 128) => [Array.from({ length: n }, (_, i) => [r * Math.cos((2 * Math.PI * i) / n), r * Math.sin((2 * Math.PI * i) / n)])];

export function creerBruit(app) {
  const groupe = new THREE.Group();
  groupe.name = 'bruit';
  app.scene.add(groupe);
  const reglages = (() => { try { return JSON.parse(lireLS(CLE_REGLAGES) || 'null'); } catch { return null; } })() || {};
  const etat = {
    jeu: null, fc: null, resume: null,
    nuit: !!reglages.nuit,
    sources: { routes: reglages.sources?.routes !== false, fer: reglages.sources?.fer !== false },
    seuil: SEUILS_BRUIT[reglages.seuil] ? reglages.seuil : 'aucun',
    typeC: !!reglages.typeC,
    nc: reglages.nc !== false, // hachurer le non cartographié (défaut : oui)
    vue: reglages.vue === 'batiments' ? 'batiments' : 'facades',
    tout: false,
    classement: !!reglages.classement, // classement sonore des voies (js/classement-sonore.js)
  };
  const memoriser = () => ecrireLS(CLE_REGLAGES, JSON.stringify({ nuit: etat.nuit, sources: etat.sources, seuil: etat.seuil, typeC: etat.typeC, nc: etat.nc, vue: etat.vue, classement: etat.classement }));
  // classement sonore des infrastructures (DDTM 44, 2020) : couche à part, lue dans data/classement-sonore.geojson
  const classement = creerClassementSonore(app, { auChangement: () => { invalider(); rafraichir(); app.emettre('legende'); } });
  // modèle de bruit calculé (js/bruit-modele.js) : carte officielle masquée quand le modèle, l'écart ou la référence est affiché
  const modele = creerModeleBruit(app, { classes: CLASSES_BRUIT, nuit: () => etat.nuit, auChangement: () => { groupe.visible = voir(); if (ui.tableau?.isConnected) majTableau(); app.emettre('legende'); } });
  const voir = () => !!app.couches.bruit && modele.officiel();
  const ui = {};
  const emprise = () => empriseAutour(app.config.origine.lat, app.config.origine.lon, app.config.rayonEtude * 1.1);
  const indic = () => (etat.nuit ? 'Ln' : 'Lden');
  const sourceAffichee = (src) => (src === 'voies ferrées' ? etat.sources.fer : etat.sources.routes);
  const seuilDe = (src, ind = indic()) => (SEUILS_BRUIT[etat.seuil] ? SEUILS_BRUIT[etat.seuil][src][ind] : null);

  // ------------------------------------------------------------
  // Zones en mètres locaux, index spatial
  // ------------------------------------------------------------
  let zones = [], grille = new Map();
  const CELLULE = 40;
  function preparer() {
    zones = []; grille = new Map(); niveaux = null;
    if (!etat.fc?.features) return;
    for (const f of etat.fc.features) {
      const q = normaliser(f.properties);
      if (q.n == null || !classeDe(q.n)) continue;
      for (const poly of polygonesLocaux(f.geometry, app.proj)) {
        if (!poly[0] || poly[0].length < 3) continue;
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of poly[0]) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
        const Z = { ...q, poly, bb: [x0, z0, x1, z1], anneaux: poly.map(prepAnneau) };
        zones.push(Z);
        for (let i = Math.floor(x0 / CELLULE); i <= Math.floor(x1 / CELLULE); i++) for (let j = Math.floor(z0 / CELLULE); j <= Math.floor(z1 / CELLULE); j++) {
          const k = `${i},${j}`;
          if (!grille.has(k)) grille.set(k, []);
          grille.get(k).push(Z);
        }
      }
    }
  }
  // niveaux au point (x, z) : { A: { Lden: { routes, 'voies ferrées' }, Ln: {…} }, C: { Lden: {…}, Ln: {…} } } (null = non cartographié)
  const vide = () => ({ Lden: { routes: null, 'voies ferrées': null }, Ln: { routes: null, 'voies ferrées': null } });
  function auPoint(x, z, acc = { A: vide(), C: vide() }) {
    for (const Z of grille.get(`${Math.floor(x / CELLULE)},${Math.floor(z / CELLULE)}`) || []) {
      if (!dansZone(Z, x, z)) continue;
      const t = acc[Z.type][Z.ind];
      if (t[Z.src] == null || Z.n > t[Z.src]) t[Z.src] = Z.n;
    }
    return acc;
  }

  // ------------------------------------------------------------
  // Dessin : une couche par source et par classe ; « maximum des classes » là où routes et voies ferrées se recouvrent
  // (la classe la plus haute est dessinée d'abord et écrit la profondeur, les classes plus basses au même endroit sont rejetées)
  // ------------------------------------------------------------
  // emprises du bâti effectif (existant sans les démolis + projet) dans le périmètre : [[ext, ...trous]] en mètres locaux
  function empreintesBati(R) {
    const L = [];
    for (const e of app.batiEffectif?.() || []) {
      if (!(Math.hypot(e.cx, e.cz) <= R + 60)) continue;
      for (const p of e.polys || []) if (p?.[0]?.length >= 3) L.push(p);
    }
    return L;
  }
  // texture des hachures du non cartographié : 2048 px sur le carré [-R, R]² (≈ 0,4 m/px pour 420 m), diagonales descendantes
  // tous les 9 m, traits de 0,5 m ; zones et emprises du bâti (élargies de 0,6 m) effacées. UV en mètres (geometriesPlates : u = x,
  // v = -z), ramenés à [0, 1] par repeat/offset.
  function textureNonCartographie(R, zonesPolys, bati) {
    const N = 2048, k = N / (2 * R);
    const c = document.createElement('canvas'); c.width = c.height = N;
    const g = c.getContext('2d');
    const px = (x) => (x + R) * k, pz = (z) => (z + R) * k;
    const tracer = (polys) => { g.beginPath(); for (const poly of polys) for (const a of poly) { a.forEach(([x, z], i) => (i ? g.lineTo(px(x), pz(z)) : g.moveTo(px(x), pz(z)))); g.closePath(); } };
    g.save();
    g.beginPath(); g.arc(N / 2, N / 2, R * k, 0, 2 * Math.PI); g.clip();
    g.strokeStyle = '#ffffff'; g.lineWidth = 0.5 * k; g.lineCap = 'butt';
    const pas = 9 * k;
    g.beginPath();
    for (let d = -N; d <= N; d += pas) { g.moveTo(d, 0); g.lineTo(d + N, N); }
    g.stroke();
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = '#000'; g.strokeStyle = '#000';
    if (zonesPolys.length) { tracer(zonesPolys); g.fill('evenodd'); }
    if (bati.length) { tracer(bati); g.fill('nonzero'); g.lineWidth = 1.2 * k; g.lineJoin = 'round'; g.stroke(); }
    g.globalCompositeOperation = 'source-over';
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(1 / (2 * R), 1 / (2 * R)); t.offset.set(0.5, 0.5);
    t.anisotropy = app.renderer?.capabilities?.getMaxAnisotropy?.() || 1;
    return t;
  }
  function dessiner() {
    viderGroupe(groupe);
    if (!zones.length && etat.fc) preparer();
    if (!etat.fc) { etat.resume = null; return; }
    const ind = indic();
    const par = new Map(); // `${src}|${n}` -> polys
    const seuilPolys = [], contoursC = [];
    const aC = zones.some((Z) => Z.type === 'C');
    let sansNiveau = 0;
    for (const f of etat.fc.features) if (normaliser(f.properties).n == null) sansNiveau++;
    for (const Z of zones) {
      if (Z.ind !== ind || !sourceAffichee(Z.src)) continue;
      if (Z.type === 'C') {
        if (etat.seuil === 'fr') seuilPolys.push(Z.poly);
        if (etat.typeC || etat.seuil === 'fr') contoursC.push(Z.poly);
        continue;
      }
      const k = `${Z.src}|${Z.n}`;
      if (!par.has(k)) par.set(k, []);
      par.get(k).push(Z.poly);
      // OMS, ou valeur limite avec un jeu sans secteurs de type C (WFS, ancien fichier) : classes dont la borne basse atteint le seuil
      if ((etat.seuil === 'oms' || (etat.seuil === 'fr' && !aC)) && Z.n >= seuilDe(Z.src)) seuilPolys.push(Z.poly);
    }
    const rang = (n) => CLASSES_BRUIT.indexOf(classeDe(n));
    for (const [k, polys] of par) {
      const [src, ns] = k.split('|'), n = +ns, c = classeDe(n), r = rang(n), fer = src === 'voies ferrées' ? 1 : 0;
      const s = seuilDe(src);
      const attenue = s != null && n + 5 <= s; // toute la classe sous le seuil
      for (const g of geometriesPlates(polys, 0.34 + r * 0.01 + fer * 0.005)) {
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          color: c.couleur, transparent: true, opacity: attenue ? 0.18 : 0.6, depthWrite: true,
          polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12 - 2 * r - fer,
        }));
        m.renderOrder = 6 + (CLASSES_BRUIT.length - r) * 0.05 - fer * 0.01;
        m.raycast = () => {};
        m.name = `bruit-${src === 'voies ferrées' ? 'fer' : 'routes'}-${n}`;
        m.userData.classe = c;
        m.userData.bruit = { source: src, n, indicateur: ind, attenue };
        groupe.add(m);
      }
    }
    // isophones : limites des classes (contour fin de la couleur de la classe, plus foncée)
    for (const [k, polys] of par) {
      const [src, ns] = k.split('|'), n = +ns, c = classeDe(n);
      const pos = [];
      for (const poly of polys) for (const a of poly) for (let i = 0; i < a.length; i++) {
        const [x1, z1] = a[i], [x2, z2] = a[(i + 1) % a.length];
        pos.push(x1, 0.46, z1, x2, 0.46, z2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const s = seuilDe(src);
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: new THREE.Color(c.couleur).multiplyScalar(0.7), transparent: true, opacity: s != null && n + 5 <= s ? 0.25 : 0.85, depthWrite: false }));
      l.renderOrder = 6.9;
      l.raycast = () => {};
      l.name = `bruit-isophones-${src === 'voies ferrées' ? 'fer' : 'routes'}-${n}`;
      groupe.add(l);
    }
    // non cartographié (24/11/2026 : allégé) : hachures grises fines et espacées sur le périmètre d'étude, dessinées dans une
    // texture d'où sont retirées les zones dessinées et les emprises du bâti (rien sous ni sur les bâtiments) ; masquées avec la
    // carte officielle quand le modèle, l'écart ou la référence est affiché (voir())
    if (etat.nc && par.size) {
      const R = app.config.rayonEtude || 420;
      const tex = textureNonCartographie(R, [...par.values()].flat(), empreintesBati(R));
      for (const g of geometriesPlates([disque(R)], 0.3)) {
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          color: COULEUR_NC, map: tex, transparent: true, opacity: 0.35, depthWrite: false,
          polygonOffset: true, polygonOffsetFactor: -10, polygonOffsetUnits: -10,
        }));
        m.renderOrder = 6.6;
        m.raycast = () => {};
        m.name = 'bruit-non-cartographie';
        groupe.add(m);
      }
    }
    // zones au-dessus du seuil : hachures (sans double hachure là où deux zones se recouvrent)
    if (seuilPolys.length) {
      for (const g of geometriesPlates(seuilPolys, 0.5)) {
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
          color: COULEUR_SEUIL, map: hachures('seuil'), transparent: true, opacity: 0.75, alphaTest: 0.1, depthWrite: true, depthFunc: THREE.LessDepth,
          polygonOffset: true, polygonOffsetFactor: -14, polygonOffsetUnits: -30,
        }));
        m.renderOrder = 7;
        m.raycast = () => {};
        m.name = 'bruit-seuil';
        m.userData.seuil = etat.seuil;
        groupe.add(m);
      }
    }
    // contours des secteurs de type C (dépassement des valeurs limites, cartes officielles)
    if (contoursC.length) {
      const pos = [];
      for (const poly of contoursC) for (const a of poly) for (let i = 0; i < a.length; i++) {
        const [x1, z1] = a[i], [x2, z2] = a[(i + 1) % a.length];
        pos.push(x1, 0.52, z1, x2, 0.52, z2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: COULEUR_SEUIL, transparent: true, opacity: 0.95, depthWrite: false }));
      l.renderOrder = 8;
      l.raycast = () => {};
      l.name = 'bruit-type-c';
      groupe.add(l);
    }
    const presentes = [...par.keys()].map((k) => { const [src, n] = k.split('|'); return { src, n: +n }; });
    etat.resume = { presentes, sansNiveau, total: etat.fc.features.length, seuil: seuilPolys.length, typeC: contoursC.length, nc: !!(etat.nc && par.size) };
    groupe.visible = voir();
    app.emettre('legende');
  }

  // ------------------------------------------------------------
  // Niveaux par façade (photos) et par bâtiment : classe la plus haute des zones à 2 m devant le mur
  // (point d'évaluation en façade des CBS : arrêté du 4 avril 2006, art. 1), par indicateur et par source.
  // ------------------------------------------------------------
  let niveaux = null;
  const RECUL = 2;
  function echantillonsFacade(f, recul = RECUL) {
    const [gx, gz] = f.gauche, [dx, dz] = f.droite;
    const L = Math.hypot(dx - gx, dz - gz);
    if (!(L > 0.2)) return [];
    const ux = (dx - gx) / L, uz = (dz - gz) / L;
    const az = (f.normale_az * Math.PI) / 180;
    let nx = Math.sin(az), nz = -Math.cos(az); // comme meshFacade (js/toits.js) : nord = −z
    if (!Number.isFinite(nx)) { nx = -uz; nz = ux; }
    const k = Math.max(2, Math.ceil(L));
    const pts = [];
    for (let i = 0; i <= k; i++) { const s = (i / k) * L; pts.push([gx + ux * s + nx * recul, gz + uz * s + nz * recul]); }
    return pts;
  }
  function echantillonsBatiment(e, recul = RECUL) {
    const pts = [];
    for (const [ext] of e.polys || []) {
      if (!ext || ext.length < 3) continue;
      for (let i = 0; i < ext.length; i++) {
        const [x1, z1] = ext[i], [x2, z2] = ext[(i + 1) % ext.length];
        const L = Math.hypot(x2 - x1, z2 - z1);
        if (L < 0.3) continue;
        const ux = (x2 - x1) / L, uz = (z2 - z1) / L;
        const k = Math.max(1, Math.ceil(L / 2));
        for (let j = 0; j < k; j++) {
          const s = ((j + 0.5) / k) * L, px = x1 + ux * s, pz = z1 + uz * s;
          // côté extérieur : celui des deux points à 2 m qui n'est pas dans l'emprise
          const a = [px - uz * recul, pz + ux * recul], b = [px + uz * recul, pz - ux * recul];
          pts.push(dansAnneauSimple(ext, ...a) ? b : a);
        }
      }
    }
    return pts;
  }
  const CAPS = ['au nord', 'au nord-est', 'à l\'est', 'au sud-est', 'au sud', 'au sud-ouest', 'à l\'ouest', 'au nord-ouest'];
  const cap = (x, z) => CAPS[Math.round(((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360 / 45) % 8];
  function mesurer(pts) {
    const acc = { A: vide(), C: vide() };
    for (const [x, z] of pts) auPoint(x, z, acc);
    return acc;
  }
  function calculerNiveaux() {
    if (niveaux) return niveaux;
    const facades = [], batiments = [];
    // classement sonore : secteur affecté qui touche la façade (points sur le mur) ou le contour du bâtiment
    const cl = (pts) => (classement.etat.troncons.length ? classement.classer(pts) : null);
    if (zones.length || classement.etat.troncons.length) {
      for (const f of app.toits?.toutesFacades?.() || []) {
        const pts = echantillonsFacade(f);
        if (!pts.length) continue;
        const ens = app.toits.ensembleDeFacade?.(f);
        facades.push({ type: 'facade', id: f.id, nom: f.nom || f.id, ensemble: ens?.id || '', x: (f.gauche[0] + f.droite[0]) / 2, z: (f.gauche[1] + f.droite[1]) / 2, ...mesurer(pts), cl: cl(echantillonsFacade(f, 0)) });
      }
      const R = app.config.rayonEtude || 420;
      for (const e of app.batiEffectif?.() || []) {
        if (!(Math.hypot(e.cx, e.cz) <= R)) continue;
        const pts = echantillonsBatiment(e);
        if (!pts.length) continue;
        const cle = e.id || e.cle || `g${app.proj.versGeo(e.cx, e.cz).lat.toFixed(6)},${app.proj.versGeo(e.cx, e.cz).lon.toFixed(6)}`;
        batiments.push({ type: 'batiment', id: String(cle), nom: e.nom || (e.rem ? e.rem.etiquette || e.rem.nom : null) || `${e.projet ? 'Volume du projet' : 'Bâtiment'} à ${Math.round(Math.hypot(e.cx, e.cz))} m ${cap(e.cx, e.cz)}`, projet: !!e.projet, x: e.cx, z: e.cz, ...mesurer(pts), cl: cl(echantillonsBatiment(e, 0)) });
      }
    }
    niveaux = { facades, batiments };
    return niveaux;
  }
  const invalider = () => { niveaux = null; if (ui.tableau?.isConnected) majTableau(); };

  // valeurs affichées d'un élément selon les sources cochées (toutes si aucune)
  function synthese(r) {
    const srcs = SOURCES_BRUIT.filter((s) => etat.sources[s.cle]).map((s) => s.id);
    const S = srcs.length ? srcs : SOURCES_BRUIT.map((s) => s.id);
    const max = (o) => S.reduce((m, s) => (o[s] != null && (m == null || o[s] > m) ? o[s] : m), null);
    const Lden = max(r.A.Lden), Ln = max(r.A.Ln);
    const dom = S.filter((s) => r.A.Lden[s] != null && r.A.Lden[s] === Lden);
    const domN = dom.length ? dom : S.filter((s) => r.A.Ln[s] != null && r.A.Ln[s] === Ln);
    const cartographie = S.some((s) => r.A.Lden[s] != null || r.A.Ln[s] != null || r.C.Lden[s] != null || r.C.Ln[s] != null);
    // valeur limite : secteurs de type C (officiels) ; à défaut (jeu sans type C), borne basse de classe >= limite
    const aC = zones.some((Z) => Z.type === 'C');
    const fr = !cartographie ? null : S.some((s) => (aC ? r.C.Lden[s] != null || r.C.Ln[s] != null
      : (r.A.Lden[s] ?? -1) >= SEUILS_BRUIT.fr[s].Lden || (r.A.Ln[s] ?? -1) >= SEUILS_BRUIT.fr[s].Ln));
    const oms = !cartographie ? null : S.some((s) => (r.A.Lden[s] ?? -1) >= SEUILS_BRUIT.oms[s].Lden || (r.A.Ln[s] ?? -1) >= SEUILS_BRUIT.oms[s].Ln);
    return { Lden, Ln, source: domN.map((s) => (s === 'routes' ? 'routes' : 'fer')).join(' + ') || '—', fr, oms, cartographie };
  }
  const ouiNon = (v) => (v == null ? 'non cartographié' : v ? 'oui' : 'non');

  // ------------------------------------------------------------
  // Tableau du panneau et export CSV
  // ------------------------------------------------------------
  function lignes(type) {
    const N = calculerNiveaux();
    const L = (type === 'batiments' ? N.batiments : N.facades).map((r) => ({ r, s: synthese(r) }));
    const cle = (o) => [o.s.Lden ?? -1, o.s.Ln ?? -1, o.r.cl ? 6 - o.r.cl.categorie : 0];
    return L.sort((a, b) => { const [a1, a2, a3] = cle(a), [b1, b2, b3] = cle(b); return b1 - a1 || b2 - a2 || b3 - a3 || a.r.nom.localeCompare(b.r.nom, 'fr'); });
  }
  function centrer(r) {
    const y0 = app.relief?.dz ? app.relief.dz(r.x, r.z) || 0 : 0;
    allerVers(app, [r.x + 30, y0 + 55, r.z + 55], [r.x, y0 + 4, r.z], 1200);
  }
  function majTableau() {
    if (!ui.tableau) return;
    if (!zones.length && !classement.etat.troncons.length) { ui.tableau.replaceChildren(h('p', { class: 'note', 'data-garder': '' }, 'Aucune carte de bruit chargée.')); return; }
    const L = lignes(etat.vue);
    const limite = etat.vue === 'batiments' && !etat.tout ? 40 : Infinity;
    const vis = L.slice(0, limite);
    const cel = (v, ind) => h('td', { class: v == null ? 'nc' : '' }, courtClasse(v, ind));
    const marque = (v) => h('td', { class: v ? 'depasse' : v == null ? 'nc' : '' }, v == null ? '—' : v ? 'oui' : 'non');
    const avecCl = classement.etat.troncons.length > 0;
    const celCl = (c) => (c ? h('td', { class: 'cl', title: `${c.voie}${c.troncon ? ` (${c.troncon})` : ''} : catégorie ${c.categorie}, secteur de ${c.largeur} m, à ${c.distance} m ${c.source === 'routes' ? 'du bord de la chaussée' : 'de l\'axe de la voie'}${c.isolement ? ` ; isolement indicatif des logements neufs ${c.isolement} dB (à vérifier)` : ''}${c.categories.length > 1 ? ` ; aussi dans les secteurs de catégorie ${c.categories.slice(1).join(', ')}` : ''}` },
      h('span', { class: 'puce-classement', style: `background:${CATEGORIES_SONORES[c.categorie - 1].couleur}` }), ` ${c.categorie} · ${c.distance} m${c.isolement ? ` · ${c.isolement} dB` : ''}`)
      : h('td', { class: 'nc', title: 'Hors des secteurs affectés : voie non classée ou trop loin (pas forcément calme)' }, 'non'));
    ui.tableau.replaceChildren(
      h('table', { class: 'table-bruit' },
        h('thead', {}, h('tr', {}, h('th', {}, etat.vue === 'batiments' ? 'Bâtiment' : 'Façade'), h('th', { title: 'Lden, dB(A), classe de 5 dB' }, 'Lden'),
          h('th', { title: 'Ln (nuit), dB(A), classe de 5 dB' }, 'Ln'), h('th', {}, 'Source'),
          h('th', { title: 'Au-dessus de la valeur limite française (secteur de type C des cartes de l\'État)' }, 'FR'),
          h('th', { title: 'Au-dessus de la recommandation de l\'OMS (2018)' }, 'OMS'),
          avecCl ? h('th', { title: 'Classement sonore des voies (2020) : catégorie la plus forte dont le secteur affecté touche l\'élément · distance à la voie (bord de chaussée) · isolement acoustique indicatif des logements neufs (à vérifier)' }, 'Classement') : null, ...modele.entetes())),
        h('tbody', {}, ...vis.map(({ r, s }) => h('tr', { tabindex: 0, title: `${r.nom} : centrer la vue`, onclick: () => centrer(r), onkeydown: (e) => { if (e.key === 'Enter') centrer(r); } },
          h('td', {}, r.nom), cel(s.Lden, 'Lden'), cel(s.Ln, 'Ln'), h('td', {}, s.cartographie ? s.source : 'non cartographié'), marque(s.fr), marque(s.oms), avecCl ? celCl(r.cl) : null, ...modele.cellules(r))))),
      L.length > vis.length ? h('button', { type: 'button', class: 'bouton discret petit', onclick: () => { etat.tout = true; majTableau(); } }, `Afficher les ${L.length} bâtiments`) : null,
      h('p', { class: 'note', 'data-garder': '' }, `${L.length} ${etat.vue === 'batiments' ? `bâtiments à moins de ${app.config.rayonEtude} m` : 'façades photo'}, ${L.filter((o) => !o.s.cartographie).length} hors des cartes (non cartographiés : pas forcément calmes). Clic sur une ligne : centrer la vue.`));
  }

  function exporterCSV() {
    const N = calculerNiveaux();
    const cellule = (v) => (v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : /[;"\n]/.test(v) ? `"${String(v).replace(/"/g, '""')}"` : v);
    const l93 = (x, z) => { const g = app.proj.versGeo(x, z); return versLambert93(g.lat, g.lon).map((v) => Math.round(v * 10) / 10); };
    const T = [['type', 'id', 'nom', 'ensemble', 'x_l93', 'y_l93',
      'lden_routes_db_lo', 'lden_fer_db_lo', 'ln_routes_db_lo', 'ln_fer_db_lo', 'lden_max_db_lo', 'ln_max_db_lo', 'source_dominante',
      'secteur_c_routes', 'secteur_c_fer', 'depasse_valeur_limite_fr', 'depasse_oms',
      'classement_categorie', 'classement_voie', 'classement_troncon', 'classement_source', 'classement_distance_m', 'classement_largeur_secteur_m', 'classement_tissu', 'classement_autres_categories', 'isolement_indicatif_db', 'remarque', ...modele.entetesCSV()]];
    const ancien = { ...etat.sources };
    etat.sources = { routes: true, fer: true }; // le CSV porte toujours les deux sources
    try {
      for (const r of [...N.facades, ...N.batiments]) {
        const s = synthese(r);
        const [X, Y] = l93(r.x, r.z);
        const c = (src) => (r.C.Lden[src] != null || r.C.Ln[src] != null ? 'oui' : (r.A.Lden[src] != null || r.A.Ln[src] != null ? 'non' : ''));
        T.push([r.type === 'facade' ? 'facade' : r.projet ? 'volume_projet' : 'batiment', r.id, r.nom, r.ensemble || '', X, Y,
          r.A.Lden.routes, r.A.Lden['voies ferrées'], r.A.Ln.routes, r.A.Ln['voies ferrées'], s.Lden, s.Ln, s.cartographie ? s.source : '',
          c('routes'), c('voies ferrées'), ouiNon(s.fr), ouiNon(s.oms),
          r.cl?.categorie ?? (classement.etat.troncons.length ? 'non classé' : ''), r.cl?.voie ?? '', r.cl?.troncon ?? '', r.cl?.source ?? '', r.cl?.distance ?? '', r.cl?.largeur ?? '', r.cl?.tissu ?? '', r.cl?.categories.slice(1).join(' ') ?? '', r.cl?.isolement ?? '',
          s.cartographie ? '' : 'non cartographié (pas forcément calme)', ...modele.valeursCSV(r)]);
      }
    } finally { etat.sources = ancien; }
    const tete = ['# Atlas de l\'Hôtel de Ville, outil Bruit : classe (borne basse, dB(A), classes de 5 dB) des cartes de bruit stratégiques de l\'État (DDTM 44, 2022, Licence Ouverte 2.0) lue à 2 m devant chaque façade photo et le long de chaque bâtiment ; niveaux calculés par l\'État à 4 m au-dessus du sol, aucun calcul de propagation par l\'atlas',
      '# Rues communales, tramway et industrie non cartographiés en données ouvertes : une case vide n\'est pas un lieu calme. Coordonnées Lambert-93 (EPSG:2154) du milieu de la façade ou du centre du bâtiment ; séparateur ;',
      `# Valeurs limites FR (arrêté du 4 avril 2006, art. 7) : routes Lden 68 / Ln 62, fer 73 / 65 ; OMS 2018 : routes Lden 53 / Ln 45, fer 54 / 44`,
      '# Classement sonore des voies (DDTM 44, révision 2020, Licence Ouverte 2.0) : catégorie la plus forte (1 = la plus bruyante) dont le secteur affecté touche la façade ou le contour du bâtiment ; distance en m au bord de la chaussée (axe + demi-largeur du fichier ; voies ferrées : axe) ; « non classé » = hors secteur, pas forcément calme',
      '# Isolement indicatif DnT,A,tr des logements neufs (arrêté du 30 mai 1996 modifié, art. 6, méthode forfaitaire sans corrections) : À VÉRIFIER dans le texte officiel (tableau du JO du 01/08/2013 non lu)', ...modele.noteCSV()];
    const d = new Date(), z2 = (v) => String(v).padStart(2, '0');
    telecharger(`atlas-hdv-bruit-facades-batiments-${d.getFullYear()}${z2(d.getMonth() + 1)}${z2(d.getDate())}.csv`,
      `${String.fromCharCode(0xfeff)}${[...tete, ...T.map((l) => l.map(cellule).join(';'))].join('\r\n')}\r\n`, 'text/csv;charset=utf-8');
  }

  // ------------------------------------------------------------
  // Légende automatique (js/legende.js), planche (js/planche.js), DXF (js/export.js)
  // ------------------------------------------------------------
  const nomSources = () => SOURCES_BRUIT.filter((s) => etat.sources[s.cle]).map((s) => s.libelle.toLowerCase()).join(' et ') || 'aucune source';
  function texteSeuil() {
    const S = SEUILS_BRUIT[etat.seuil];
    if (!S) return '';
    const ind = indic();
    const v = SOURCES_BRUIT.filter((s) => etat.sources[s.cle]).map((s) => `${s.libelle.toLowerCase()} ${S[s.id][ind]}`).join(', ');
    return `${S.libelle} : ${v} dB(A) ${ind}`;
  }
  function legendeAuto() {
    if (app.couches.bruit && !modele.officiel()) { const L = [...modele.legende(), classement.legende()].filter(Boolean); return L.length ? L : null; }
    if (!app.couches.bruit || !groupe.visible) return null;
    const cs = classement.legende();
    if (!etat.resume) return cs ? [cs] : null;
    const ind = indic();
    const L = [];
    const titre = `Bruit ${ind} (${ind === 'Ln' ? 'nuit' : 'jour, soir, nuit'}), ${nomSources()} — CBS de l'État 2022, 4 m`;
    const P = etat.resume.presentes;
    const classes = [...new Set(P.map((p) => p.n))].sort((a, b) => a - b);
    if (classes.length) {
      L.push({
        id: 'bruit', titre: etat.seuil !== 'aucun' ? `${titre} ; seuil : ${texteSeuil()}` : titre,
        items: classes.map((n) => ({ libelle: libelleClasse(n, ind), couleur: classeDe(n).couleur, forme: 'aplat' })),
        note: 'Hors zones colorées : non cartographié, pas forcément calme (rues communales, tramway et industrie absents des cartes de l\'État). Là où routes et voies ferrées se recouvrent : classe la plus haute.',
      });
    }
    const it = [];
    if (etat.resume.seuil) it.push({ libelle: `Hachures : au-dessus du seuil (${etat.seuil === 'fr' && zones.some((Z) => Z.type === 'C') ? 'secteurs de type C' : 'borne basse de classe ≥ seuil'})`, couleur: COULEUR_SEUIL, forme: 'tirets' });
    if (etat.resume.nc) it.push({ libelle: `Hachures grises : non cartographié dans ${app.config.rayonEtude || 420} m (pas forcément calme)`, couleur: COULEUR_NC, forme: 'tirets' });
    if (etat.resume.typeC) it.push({ libelle: 'Contour : secteurs où les valeurs limites sont dépassées (type C, officiel)', couleur: COULEUR_SEUIL, forme: 'trait' });
    if (it.length) L.push({ id: 'bruit-seuil', titre: etat.seuil !== 'aucun' ? `Seuil : ${texteSeuil()}` : 'Bruit : hachures et contours', items: it });
    if (cs) L.push(cs);
    return L.length ? L : null;
  }

  // planche : vecteurs SVG (X, Y : mètres locaux -> mm). Opacité de groupe = maximum des classes, comme à l'écran.
  function svgPlanche(X, Y) {
    if (app.couches.bruit && !modele.officiel()) return modele.svgPlanche(X, Y) + (classement.actif ? `<g id="classement-sonore">${classement.svg(X, Y)}</g>` : '');
    if (!app.couches.bruit || !groupe.visible) return '';
    const cs = `<g id="classement-sonore">${classement.svg(X, Y)}</g>`; // au-dessus des zones de bruit
    if (!etat.fc) return classement.actif ? cs : '';
    const ind = indic();
    const chemin = (poly) => poly.map((a) => `M${a.map(([x, z]) => `${X(x)} ${Y(z)}`).join('L')}Z`).join('');
    const A = zones.filter((Z) => Z.type === 'A' && Z.ind === ind && sourceAffichee(Z.src)).sort((a, b) => a.n - b.n);
    const fort = [], faible = [];
    for (const Z of A) { const s = seuilDe(Z.src); (s != null && Z.n + 5 <= s ? faible : fort).push(Z); }
    const couche = (L, op, id) => (L.length ? `<g id="${id}" opacity="${op}">${L.map((Z) => `<path d="${chemin(Z.poly)}" fill="${classeDe(Z.n).couleur}" fill-rule="evenodd"/>`).join('')}</g>` : '');
    const o = [];
    if (etat.nc && A.length) { // non cartographié : hachures grises fines et espacées, masquées sur les zones et sur le bâti
      const R = app.config.rayonEtude || 420;
      const bati = empreintesBati(R);
      o.push(`<defs><pattern id="hachures-nc-bruit" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(-45)"><rect x="0" y="0" width="0.15" height="6" fill="${COULEUR_NC}"/></pattern>`
        + `<mask id="masque-nc-bruit" maskUnits="userSpaceOnUse"><path d="${chemin(disque(R))}" fill="#fff"/>${A.map((Z) => `<path d="${chemin(Z.poly)}" fill="#000" fill-rule="evenodd"/>`).join('')}`
        + `${bati.length ? `<path d="${bati.map(chemin).join('')}" fill="#000" stroke="#000" stroke-width="0.6" fill-rule="nonzero"/>` : ''}</mask></defs>`);
      o.push(`<g id="bruit-non-cartographie" mask="url(#masque-nc-bruit)" opacity="0.45"><path d="${chemin(disque(R))}" fill="url(#hachures-nc-bruit)"/></g>`);
    }
    o.push(couche(faible, 0.18, 'bruit-sous-seuil'), couche(fort, 0.6, 'bruit-classes'));
    const aC = zones.some((Z) => Z.type === 'C');
    const sp = etat.seuil === 'fr' && aC ? zones.filter((Z) => Z.type === 'C' && Z.ind === ind && sourceAffichee(Z.src))
      : etat.seuil !== 'aucun' ? A.filter((Z) => Z.n >= seuilDe(Z.src)) : [];
    if (sp.length) {
      o.push(`<defs><pattern id="hachures-bruit" patternUnits="userSpaceOnUse" width="2" height="2" patternTransform="rotate(45)"><rect x="0" y="0" width="0.45" height="2" fill="${COULEUR_SEUIL}"/></pattern></defs>`);
      o.push(`<g id="bruit-seuil-${etat.seuil}">${sp.map((Z) => `<path d="${chemin(Z.poly)}" fill="url(#hachures-bruit)" fill-rule="evenodd"/>`).join('')}</g>`);
    }
    if (etat.typeC || etat.seuil === 'fr') {
      const C = zones.filter((Z) => Z.type === 'C' && Z.ind === ind && sourceAffichee(Z.src));
      if (C.length) o.push(`<g id="bruit-type-c" fill="none" stroke="${COULEUR_SEUIL}" stroke-width="0.25">${C.map((Z) => `<path d="${chemin(Z.poly)}"/>`).join('')}</g>`);
    }
    if (classement.actif) o.push(cs);
    return o.join('');
  }

  // DXF : calques BRUIT_<ROUTE|FER>_<LDEN|LN>_<a>_<b> (ou _PLUS_<n>), BRUIT_SEUIL_<FR|OMS>_<LDEN|LN>, BRUIT_TYPE_C_<ROUTE|FER>_<LDEN|LN>
  function entitesDXF() {
    const polys = [];
    if (app.couches.bruit && !modele.officiel()) return modele.entitesDXF();
    if (!app.couches.bruit || !etat.fc) return polys;
    const ind = indic(), I = ind.toUpperCase();
    const aC = zones.some((Z) => Z.type === 'C');
    const court = (src) => (src === 'voies ferrées' ? 'FER' : 'ROUTE');
    for (const Z of zones) {
      if (Z.ind !== ind || !sourceAffichee(Z.src)) continue;
      if (Z.type === 'A') polys.push({ calque: `BRUIT_${court(Z.src)}_${I}_${ouverte(Z.n, ind) ? `PLUS_${Z.n}` : `${Z.n}_${Z.n + 5}`}`, poly: Z.poly });
      if (Z.type === 'C' && (etat.typeC || etat.seuil === 'fr')) polys.push({ calque: `BRUIT_TYPE_C_${court(Z.src)}_${I}`, poly: Z.poly });
      if ((etat.seuil === 'fr' && aC && Z.type === 'C') || ((etat.seuil === 'oms' || (etat.seuil === 'fr' && !aC)) && Z.type === 'A' && Z.n >= seuilDe(Z.src))) {
        polys.push({ calque: `BRUIT_SEUIL_${SEUILS_BRUIT[etat.seuil].court}_${I}`, poly: Z.poly });
      }
    }
    return polys;
  }

  // ------------------------------------------------------------
  // Chargement
  // ------------------------------------------------------------
  function poser(jeu, fc) {
    etat.jeu = jeu; etat.fc = fc;
    preparer();
    dessiner();
  }
  async function charger(id, titre) {
    const cle = `bruit-${id}-${app.cleZone}`;
    let fc = await lireCache(cle, 90);
    if (!fc) {
      if (!navigator.onLine || app.mode === 'borne') throw new Error('hors ligne : jeu non disponible');
      fc = await lireJeuGeo(id, emprise());
      await ecrireCache(cle, fc);
    }
    ecrireLS(CLE, JSON.stringify({ id, titre }));
    app.couches.bruit = true;
    poser({ id, titre }, fc);
    app.emettre('couches');
  }

  // Cartes de bruit stratégiques de l'État (DDTM 44), lues en direct pour le périmètre d'étude (type A seulement)
  async function chargerEtat() {
    const id = 'etat-ddtm44';
    const cle = `bruit-${id}-${app.cleZone}`;
    let fc = await lireCache(cle, 365);
    if (!fc) {
      if (!navigator.onLine || app.mode === 'borne') throw new Error('hors ligne : cartes non disponibles');
      fc = await lireCartesBruitEtat(emprise(), (t) => { if (ui.liste?.isConnected) ui.liste.replaceChildren(h('p', { class: 'note' }, t)); });
      await ecrireCache(cle, fc);
    }
    const jeu = { id, titre: 'Cartes de bruit stratégiques de l\'État (DDTM 44, 2022, service WFS, type A), routes et voies ferrées' };
    ecrireLS(CLE, JSON.stringify(jeu));
    app.couches.bruit = true;
    poser(jeu, fc);
    app.emettre('couches');
  }

  function importer(fichier) {
    return fichier.text().then((t) => {
      const fc = JSON.parse(t);
      if (!fc.features) throw new Error('le fichier n\'est pas un GeoJSON');
      const jeu = { id: `fichier-${fichier.name}`, titre: fichier.name };
      ecrireCache(`bruit-${jeu.id}-${app.cleZone}`, fc);
      ecrireLS(CLE, JSON.stringify(jeu));
      app.couches.bruit = true;
      poser(jeu, fc);
      app.emettre('couches');
    });
  }

  async function construire() {
    if (etat.classement) classement.definirVisible(true);
    const memo = (() => { try { return JSON.parse(lireLS(CLE) || 'null'); } catch { return null; } })() || app.config.bruit || null;
    let fc = await fetch('data/bruit.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (fc) { poser({ id: 'fichier', titre: 'data/bruit.geojson' }, fc); return; }
    if (memo) {
      fc = await lireCache(`bruit-${memo.id}-${app.cleZone}`, 365);
      if (!fc && memo.id === 'etat-ddtm44' && navigator.onLine && app.mode !== 'borne') { try { await chargerEtat(); return; } catch { /* hors ligne */ } }
      if (fc) poser(memo, fc);
    }
  }

  async function chercher() {
    ui.liste.replaceChildren(h('p', { class: 'note' }, 'Recherche des cartes de bruit dans l\'Open Data de Nantes Métropole…'));
    try {
      const res = [...await chercherJeux('bruit')].filter((d) => /bruit|sonore|lden|isophone/i.test(`${d.titre} ${d.description}`));
      ui.liste.replaceChildren(res.length
        ? h('ul', { class: 'liste-jeux' }, ...res.map((d) => h('li', {},
          h('div', {}, h('strong', {}, d.titre), h('span', { class: 'note' }, d.description)),
          h('button', { type: 'button', class: 'bouton petit', onclick: async (e) => { e.target.disabled = true; try { await charger(d.id, d.titre); rafraichir(); } catch (err) { app.signaler(`Carte de bruit illisible : ${err.message}`); e.target.disabled = false; } } }, 'Afficher'))))
        : h('p', { class: 'note' }, 'Aucune carte de bruit trouvée dans le catalogue. Importez un fichier GeoJSON (voir ci-dessous).'));
    } catch (e) {
      ui.liste.replaceChildren(h('p', { class: 'note' }, `Catalogue indisponible : ${e.message}`));
    }
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  function styles() {
    if (document.getElementById('styles-bruit')) return;
    document.head.append(h('style', { id: 'styles-bruit' }, `
.bruit-bandeau { margin: 0 0 8px; padding: 6px 9px; border-left: 3px solid ${COULEUR_SEUIL}; background: #f6eef0; font-size: 13px; line-height: 1.35; }
.bruit-bandeau ul { margin: 4px 0 0; padding-left: 16px; }
.bruit-seuil-valeurs { font-size: 12.5px; margin: 2px 0 6px; }
.table-bruit { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 6px 0; font-variant-numeric: tabular-nums; }
.table-bruit th, .table-bruit td { padding: 2px 4px; border-bottom: 1px solid var(--trait, #ccc); text-align: center; }
.table-bruit th:first-child, .table-bruit td:first-child { text-align: left; }
.table-bruit tbody tr { cursor: pointer; }
.table-bruit tbody tr:hover, .table-bruit tbody tr:focus { background: rgba(47, 59, 69, 0.07); outline: none; }
.table-bruit td + td { white-space: nowrap; }
.table-bruit td.nc { color: #8a8f93; font-style: italic; }
.table-bruit td.depasse { color: ${COULEUR_SEUIL}; font-weight: 600; }
.bruit-tableau-defile { max-height: 320px; overflow: auto; }
.puce-classement { display: inline-block; width: 9px; height: 9px; border-radius: 2px; vertical-align: -1px; }
.table-bruit td.cl { white-space: nowrap; }
.etiquette.etiquette-classement { pointer-events: auto; min-width: 16px; padding: 0 4px; border-radius: 9px; font: 700 11px/16px system-ui, sans-serif; text-align: center; color: #fff; background: #555; border: 1.5px solid #fff; box-shadow: 0 1px 2px rgba(0,0,0,.35); }
${CATEGORIES_SONORES.map((c) => `.etiquette.etiquette-classement.cat-${c.n} { background: ${c.couleur}; }`).join('\n')}
`));
  }

  let conteneurPanneau = null;
  function rafraichir() { if (conteneurPanneau?.isConnected) { conteneurPanneau.replaceChildren(); construirePanneau(conteneurPanneau); } }
  const changer = (f) => { f(); memoriser(); dessiner(); modele.dessiner(); rafraichir(); };

  function construirePanneau(conteneur) {
    styles();
    conteneurPanneau = conteneur;
    ui.liste = h('div');
    const fichier = h('input', { type: 'file', accept: '.geojson,.json,application/json', hidden: true, onchange: async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await importer(f); rafraichir(); } catch (err) { app.signaler(`Import impossible : ${err.message}`); } } });
    const r = etat.resume;
    const nb = (src, type) => zones.filter((Z) => Z.src === src && Z.type === type && Z.ind === indic()).length;
    const aC = zones.some((Z) => Z.type === 'C');
    const S = SEUILS_BRUIT[etat.seuil];
    ui.tableau = h('div', { class: 'bruit-tableau-defile' });
    conteneur.append(...[
      h('div', { class: 'bruit-bandeau', 'data-garder': '' },
        h('strong', {}, 'Cartes de l\'État, pas un calcul de l\'atlas'), ' : niveaux calculés par la DDTM à 4 m au-dessus du sol, moyennés sur l\'année, par classes de 5 dB(A). Limites :',
        h('ul', {},
          h('li', {}, 'rues communales non couvertes (cartes de Nantes Métropole publiées en PDF seulement) ;'),
          h('li', {}, 'tramway et industrie absents ;'),
          h('li', {}, 'bords en escalier : grille de calcul de 10 m de l\'État ; les zones s\'arrêtent où s\'arrête son calcul (réseau routier national et départemental, voies ferrées), pas où le bruit cesse ;'),
          h('li', {}, 'hors zones colorées : non cartographié, pas forcément calme.'))),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: !!app.couches.bruit, onchange: (e) => { app.couches.bruit = e.target.checked; groupe.visible = voir(); app.emettre('couches'); } }), 'Afficher la carte du bruit'),
      ...modele.bloc(),
      h('div', { class: 'choix', role: 'radiogroup', 'aria-label': 'Indicateur' }, ...[[false, 'Lden (jour, soir, nuit)'], [true, 'Ln (nuit)']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'indic-bruit', checked: etat.nuit === v, onchange: () => changer(() => { etat.nuit = v; }) }), l))),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Sources'),
        info('Routes : réseau autoroutier, national et départemental non concédé ; voies ferrées : réseau SNCF Réseau. Là où les deux se recouvrent, la carte montre la classe la plus haute.')),
      ...SOURCES_BRUIT.map((s) => h('label', { class: 'case' },
        h('input', { type: 'checkbox', checked: etat.sources[s.cle], onchange: (e) => changer(() => { etat.sources[s.cle] = e.target.checked; }) }),
        `${s.libelle} (${nb(s.id, 'A')} zones${nb(s.id, 'C') ? `, ${nb(s.id, 'C')} secteur${nb(s.id, 'C') > 1 ? 's' : ''} C` : ''})`)),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Seuil'),
        info(SEUILS_BRUIT.fr.source, SEUILS_BRUIT.oms.source,
          'Zones au-dessus du seuil hachurées, classes entièrement sous le seuil atténuées. Valeur limite : hachures = secteurs de type C des cartes de l\'État (isophone exacte de la valeur limite). OMS : toutes les classes cartographiées (à partir de 55 dB(A) Lden, 50 dB(A) Ln) sont au-dessus des recommandations ; hors carte, le niveau peut aussi les dépasser.')),
      h('label', {}, 'Seuil : ', h('select', { onchange: (e) => changer(() => { etat.seuil = e.target.value; }) },
        ...[['aucun', 'aucun'], ['fr', 'valeur limite (France)'], ['oms', 'recommandation OMS (2018)']].map(([v, l]) => h('option', { value: v, selected: etat.seuil === v }, l)))),
      S ? h('p', { class: 'bruit-seuil-valeurs', 'data-garder': '' }, `${S.libelle} : routes ${S.routes.Lden} / ${S.routes.Ln}, voies ferrées ${S['voies ferrées'].Lden} / ${S['voies ferrées'].Ln} dB(A) (Lden / Ln).`) : null,
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.nc, onchange: (e) => changer(() => { etat.nc = e.target.checked; }) }),
        `Hachurer le non cartographié (périmètre de ${app.config.rayonEtude || 420} m)`),
      aC ? h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.typeC, onchange: (e) => changer(() => { etat.typeC = e.target.checked; }) }),
        'Secteurs de dépassement des valeurs limites (type C, officiel)') : null,
      ...classement.bloc((v) => { etat.classement = v; memoriser(); if (v && !app.couches.bruit) { app.couches.bruit = true; groupe.visible = true; app.emettre('couches'); } }),
      etat.jeu ? h('p', { class: 'resultat' }, `${etat.jeu.titre} : ${r?.total ?? 0} zones${r?.sansNiveau ? `, dont ${r.sansNiveau} sans niveau lisible` : ''}.`) : h('p', { class: 'note', 'data-garder': '' }, 'Aucune carte de bruit chargée.'),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Niveaux par façade et par bâtiment'),
        info('Classe la plus haute des zones de bruit sous des points pris tous les mètres à 2 m devant chaque façade photo (point d\'évaluation en façade des cartes, arrêté du 4 avril 2006, art. 1), ou tous les 2 m à 2 m autour de chaque bâtiment du périmètre d\'étude (bâti effectif : sans les démolitions, avec les volumes du projet). Aucune propagation n\'est calculée : la valeur est celle de la carte de l\'État, par classe de 5 dB(A). « Non cartographié » : aucune zone, ce qui ne veut pas dire calme.',
          'Colonnes FR et OMS : au-dessus de la valeur limite (secteur de type C) ou de la recommandation de l\'OMS, pour l\'un des deux indicateurs et l\'une des sources cochées.')),
      h('div', { class: 'choix', role: 'radiogroup', 'aria-label': 'Éléments' }, ...[['facades', 'Façades photo'], ['batiments', 'Bâtiments']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'vue-bruit', checked: etat.vue === v, onchange: () => { etat.vue = v; etat.tout = false; memoriser(); majTableau(); } }), l))),
      ui.tableau,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: exporterCSV, disabled: !zones.length && !classement.etat.troncons.length }, 'CSV façades et bâtiments (Lambert-93)')),
      app.mode !== 'borne' ? h('h3', {}, 'Trouver une carte de bruit') : null,
      app.mode !== 'borne' ? h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: async (e) => { e.target.disabled = true; try { await chargerEtat(); rafraichir(); } catch (err) { app.signaler(`Cartes de l'État indisponibles : ${err.message}`); e.target.disabled = false; } } }, 'Cartes de l\'État (WFS)'),
        h('button', { type: 'button', class: 'bouton discret', onclick: chercher }, 'Chercher dans l\'Open Data'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => fichier.click() }, 'Importer un GeoJSON')) : null,
      etat.fc && etat.jeu?.id !== 'fichier' && app.mode === 'presentateur' ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: () => enregistrerDonnees('bruit.geojson', JSON.stringify(etat.fc), { type: 'application/geo+json', apres: 'affichée d\'office, y compris sur la borne hors ligne' }) }, 'Enregistrer dans data/bruit.geojson')) : null,
      fichier,
      ui.liste,
      h('p', { class: 'note' }, 'data/bruit.geojson : cartes de bruit stratégiques 2022 de l\'État en Loire-Atlantique (DDTM 44 / Cerema, réseaux routiers et ferroviaires non concédés, directive 2002/49/CE, Licence Ouverte 2.0), zones de type A et C, Lden et Ln, découpées à 800 m autour de l\'Hôtel de Ville par outils/bruit/cbs.py. Le service WFS de Géo-IDE (bouton ci-dessus) ne donne que le type A. Le bruit des rues communales relève de la carte de l\'agglomération de Nantes Métropole, publiée en PDF seulement : la demander au service environnement de la métropole, puis l\'importer en GeoJSON.'),
    ].filter(Boolean));
    majTableau();
  }

  app.on('couches', () => { groupe.visible = voir(); });
  app.on('bati', () => { invalider(); if (etat.nc && etat.resume?.nc) dessiner(); }); // hachures du non cartographié : emprises du bâti retirées
  app.on('facades', invalider);

  return {
    construire, construirePanneau, charger, etat, niveauDe, normaliser, legendeAuto, svgPlanche, entitesDXF, exporterCSV,
    calculerNiveaux, synthese, auPoint, dessiner, classement, modele,
    lignesDXF: () => (app.couches.bruit ? classement.lignesDXF() : []),
    definir(r = {}) { // réglages (étude Bruit, essais) : { nuit, sources: { routes, fer }, seuil, typeC }
      if ('nuit' in r) etat.nuit = !!r.nuit;
      if (r.sources) Object.assign(etat.sources, r.sources);
      if ('seuil' in r) etat.seuil = SEUILS_BRUIT[r.seuil] ? r.seuil : 'aucun';
      if ('typeC' in r) etat.typeC = !!r.typeC;
      if ('nc' in r) etat.nc = !!r.nc;
      if ('classement' in r) { etat.classement = !!r.classement; classement.definirVisible(etat.classement); }
      if ('modele' in r) modele.definirAffichage(r.modele); // 'officielles' | 'modele' | 'ecart' | 'reference'
      memoriser(); dessiner(); rafraichir();
    },
    get zones() { return etat.fc; }, estNuit: () => etat.nuit,
  };
}
