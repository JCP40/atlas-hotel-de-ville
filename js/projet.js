import * as THREE from 'three';
import { h, info } from './util.js';
import { chargerJSON, enregistrerDonnees } from './donnees.js';
import { polygonesLocaux, centroide, pointDansPolygone } from './geo.js';
import { geometriesExtrudees, aretes, visibiliteBatiment, hauteurBatiment } from './maquette.js';

// ------------------------------------------------------------------
// Onglet « Bâtiments » : le projet (bâti démoli et formes ajoutées)
// - Démolir : survol en surbrillance, clic = démoli / rétabli. Le bâti est reconstruit sans les démolis
//   (app.reconstruireBatiments filtre app.donnees.batiments par filtrer()), un contour pointillé reste au sol.
// - Formes : carré, rectangle, rond, ellipse, triangle, L, U, posées au clic sur le sol (repris de la page
//   « Vent autour de l'Hôtel de Ville »), éditées en direct.
// - Calque « Projet » : case pour comparer l'existant et le projet ; data/projet.json (enregistrerDonnees).
// - app.batiEffectif() : empreintes non démolies + formes du projet, au format de app.empreintes ;
//   app.emettre('bati') à chaque changement (soleil, confort, vent se recalculent).
// ------------------------------------------------------------------

export const FORMES = [
  { id: 'carre', libelle: 'Carré' },
  { id: 'rectangle', libelle: 'Rectangle' },
  { id: 'rond', libelle: 'Rond' },
  { id: 'ellipse', libelle: 'Ellipse' },
  { id: 'triangle', libelle: 'Triangle' },
  { id: 'L', libelle: 'En L' },
  { id: 'U', libelle: 'En U (cour)' },
];
const NOM_FORME = Object.fromEntries(FORMES.map((f) => [f.id, f.libelle]));
const MAX_FORMES = 40;
const BORNES = { a: [2, 300, 30], b: [2, 300, 20], t: [2, 100, 10], rot: [-180, 180, 0], h: [3, 120, 18] };

const couleurCSS = (nom, defaut) => {
  try { return getComputedStyle(document.documentElement).getPropertyValue(nom).trim() || defaut; } catch { return defaut; }
};

// Anneau d'une forme en repère atlas [x, z] (x est, z sud), non fermé.
// Les dimensions sont lues sur le plan nord en haut ; la rotation tourne dans le sens trigonométrique.
export function anneauForme(f) {
  const A = f.a, B = f.b, T = Math.min(f.t, Math.min(A, B) * 0.8);
  let r;
  if (f.forme === 'rond') r = Array.from({ length: 32 }, (_, k) => { const t = (k / 32) * 2 * Math.PI; return [A * Math.cos(t), A * Math.sin(t)]; });
  else if (f.forme === 'ellipse') r = Array.from({ length: 40 }, (_, k) => { const t = (k / 40) * 2 * Math.PI; return [(A / 2) * Math.cos(t), (B / 2) * Math.sin(t)]; });
  else if (f.forme === 'carre') r = [[-A / 2, -A / 2], [A / 2, -A / 2], [A / 2, A / 2], [-A / 2, A / 2]];
  else if (f.forme === 'triangle') r = [[-A / 2, -B / 2], [A / 2, -B / 2], [0, B / 2]];
  else if (f.forme === 'L') r = [[-A / 2, -B / 2], [A / 2, -B / 2], [A / 2, -B / 2 + T], [-A / 2 + T, -B / 2 + T], [-A / 2 + T, B / 2], [-A / 2, B / 2]];
  else if (f.forme === 'U') r = [[-A / 2, -B / 2], [A / 2, -B / 2], [A / 2, B / 2], [A / 2 - T, B / 2], [A / 2 - T, -B / 2 + T], [-A / 2 + T, -B / 2 + T], [-A / 2 + T, B / 2], [-A / 2, B / 2]];
  else r = [[-A / 2, -B / 2], [A / 2, -B / 2], [A / 2, B / 2], [-A / 2, B / 2]];
  const c = Math.cos((f.rot * Math.PI) / 180), s = Math.sin((f.rot * Math.PI) / 180);
  // (u est, v nord) -> (x, z = -nord)
  return r.map(([u, v]) => [f.x + u * c - v * s, f.z - (u * s + v * c)]);
}

export function creerProjet(app) {
  const etat = {
    visible: true, // calque « Projet » affiché (sinon : l'existant seul)
    demolis: new Map(), // cle -> { cle, nom, hauteur, polys, cx, cz }
    formes: [], // { n, forme, a, b, t, rot, h, lat, lon, vis, x, z, couleur? }
    couleurDefaut: null, // couleur des nouveaux volumes ('#rrggbb'), sinon la teinte projet (--projet)
    importsLus: [], // entrées « imports » de projet.json, lues par js/imports.js
    sel: -1,
    mode: null, // 'demolir' | 'poser' | 'deplacer'
    suivant: 1,
    version: 0,
  };
  const ui = {};
  const groupe = new THREE.Group();
  groupe.name = 'projet';
  groupe.userData.pasDeRelief = true; // hauteur gérée ici (app.relief.dz)
  const grpFormes = new THREE.Group();
  const grpFantomes = new THREE.Group();
  groupe.add(grpFormes, grpFantomes);
  let surbrillance = null;
  let survole = null;
  let index = null; // cle -> feature du bâti chargé

  const couleurs = () => ({ projet: new THREE.Color(couleurCSS('--projet', '#5e9384')), coupe: new THREE.Color(couleurCSS('--coupe', '#c8372d')) });
  const matForme = new THREE.MeshStandardMaterial({ color: 0x5e9384, roughness: 0.85, metalness: 0 });
  const matSel = new THREE.MeshStandardMaterial({ color: 0x5e9384, roughness: 0.85, metalness: 0, emissive: 0x5e9384, emissiveIntensity: 0.35 });
  const matFantome = new THREE.LineDashedMaterial({ color: 0xc8372d, dashSize: 1.4, gapSize: 0.9, transparent: true, opacity: 0.95 });
  const matSurvol = new THREE.MeshBasicMaterial({ color: 0xc8372d, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });

  // ------------------------------------------------------------
  // Identité d'un bâtiment : identifiant OSM / IGN, sinon centre géographique
  // ------------------------------------------------------------
  const cleXZ = (cx, cz) => { const g = app.proj.versGeo(cx, cz); return `g${g.lat.toFixed(6)},${g.lon.toFixed(6)}`; };
  const cleEmpreinte = (e) => (e.id != null ? String(e.id) : cleXZ(e.cx, e.cz));
  function cleFeature(f) {
    const p = f.properties || {};
    const id = p.osm || p.id_ign;
    if (id != null) return String(id);
    const polys = polygonesLocaux(f.geometry, app.proj);
    if (!polys.length || !polys[0][0] || polys[0][0].length < 3) return null;
    return cleXZ(...centroide(polys[0][0]));
  }
  function indexer() {
    if (index?.source === app.donnees.batiments) return index.map;
    const map = new Map();
    for (const f of app.donnees.batiments?.features || []) { const c = cleFeature(f); if (c && !map.has(c)) map.set(c, f); }
    index = { source: app.donnees.batiments, map };
    return map;
  }
  function decrireDemoli(cle, infos = {}) {
    const f = indexer().get(cle);
    if (!f) return null;
    const polys = polygonesLocaux(f.geometry, app.proj);
    if (!polys.length) return null;
    const [cx, cz] = centroide(polys[0][0]);
    const p = f.properties || {};
    return { cle, nom: infos.nom ?? p.name ?? null, hauteur: infos.hauteur ?? hauteurBatiment(p, app.config), polys, cx, cz };
  }

  // bâti chargé, sans les démolis (appelé par app.reconstruireBatiments et au démarrage)
  function filtrer(fc) {
    if (!fc || !etat.visible || !etat.demolis.size) return fc;
    return { ...fc, features: fc.features.filter((f) => !etat.demolis.has(cleFeature(f))) };
  }

  // ------------------------------------------------------------
  // Bâti effectif (existant non démoli + formes du projet)
  // ------------------------------------------------------------
  const cleForme = (f) => `P${Math.hypot(f.x, f.z) <= app.config.rayonPlateau ? 'I' : 'E'}`;
  function empreinteForme(f) {
    return {
      polys: [[anneauForme(f)]], hauteur: f.h, base: 0, cle: cleForme(f), rem: false, id: `projet-${f.n}`,
      nom: `Volume ${f.n}`, cx: f.x, cz: f.z, mesh: null, debut: 0, nb: 0, projet: true, forme: f,
    };
  }
  const formesVisibles = () => (etat.visible ? etat.formes.filter((f) => f.vis) : []);
  function batiEffectif() {
    // + volumes importés (js/imports.js) : leur emprise seulement, s'ils sont assez simples
    return [...(app.empreintes || []), ...formesVisibles().map(empreinteForme), ...(etat.visible ? (app.imports?.empreintes?.() || []) : [])];
  }
  const demolisVisibles = () => (etat.visible ? [...etat.demolis.values()] : []);

  // les outils ouverts se recalculent (un peu après la dernière modification)
  let minuterie = 0;
  function changement({ immediat = false } = {}) {
    etat.version++;
    clearTimeout(minuterie);
    if (immediat) app.emettre('bati');
    else minuterie = setTimeout(() => app.emettre('bati'), 300);
  }

  // ------------------------------------------------------------
  // Dessin : formes (volumes couleur projet) et contours fantômes des démolis
  // ------------------------------------------------------------
  function viderGroupe(g) {
    for (const o of [...g.children]) {
      app.temps?.retirer(o);
      o.traverse((x) => { if (x.geometry) x.geometry.dispose(); if (x.userData.materiauPropre) x.material.dispose(); });
      g.remove(o);
    }
  }

  // couleur d'un volume : la sienne, sinon la couleur par défaut du projet, sinon la teinte projet
  const couleurDe = (f) => f.couleur || etat.couleurDefaut || null;
  function materiauForme(f, choisi) {
    const c = couleurDe(f);
    if (!c) return choisi ? matSel : matForme;
    return new THREE.MeshStandardMaterial({ color: c, roughness: 0.85, metalness: 0, ...(choisi ? { emissive: c, emissiveIntensity: 0.35 } : {}) });
  }
  const hexCSS = (c) => `#${c.getHexString()}`;

  function dessinerFormes() {
    viderGroupe(grpFormes);
    etat.formes.forEach((f, i) => {
      if (!f.vis || !etat.visible) return;
      const geos = geometriesExtrudees([[anneauForme(f)]], f.h, 0);
      if (!geos.length) return;
      const mesh = new THREE.Mesh(geos[0], materiauForme(f, i === etat.sel));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = { nom: `Projet : volume ${f.n}`, infobulle: libelleForme(f), pasDeRelief: true, centre: [f.x, f.z], materiauPropre: !!couleurDe(f) };
      mesh.add(aretes(geos[0], i === etat.sel ? 0.9 : 0.55));
      mesh.children[0].userData.pasDeRelief = true;
      grpFormes.add(mesh);
      const cle = cleForme(f);
      app.temps?.enregistrer(mesh, (a) => visibiliteBatiment(a, cle), 'aucune');
    });
    poserSurRelief();
  }

  function dessinerFantomes() {
    viderGroupe(grpFantomes);
    if (!etat.visible) return;
    for (const d of etat.demolis.values()) {
      const lot = new THREE.Group();
      lot.userData = { pasDeRelief: true, centre: [d.cx, d.cz] };
      for (const poly of d.polys) {
        for (const anneau of poly) {
          if (anneau.length < 2) continue;
          const pts = anneau.map(([x, z]) => new THREE.Vector3(x, 0.25, z));
          const ligne = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), matFantome);
          ligne.computeLineDistances();
          ligne.raycast = () => {};
          ligne.userData.pasDeRelief = true;
          lot.add(ligne);
        }
      }
      grpFantomes.add(lot);
      app.temps?.enregistrer(lot, (a) => a.etat !== 'avant', 'aucune');
    }
    poserSurRelief();
  }

  // relief affiché : chaque volume est soulevé d'un bloc (hauteur du terrain en son centre)
  function poserSurRelief() {
    for (const o of [...grpFormes.children, ...grpFantomes.children]) {
      const [x, z] = o.userData.centre || [0, 0];
      const d = app.relief?.dz ? app.relief.dz(x, z) : 0;
      o.position.y = Number.isFinite(d) ? d : 0;
    }
  }

  function majCouleurs() {
    const c = couleurs();
    matForme.color.copy(c.projet);
    matSel.color.copy(c.projet);
    matSel.emissive.copy(c.projet);
    matFantome.color.copy(c.coupe);
    matSurvol.color.copy(c.coupe);
  }

  function redessiner() {
    dessinerFormes();
    dessinerFantomes();
    app.temps?.appliquer({ instantane: true });
  }

  // ------------------------------------------------------------
  // Démolition
  // ------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const souris = new THREE.Vector2();
  function batimentSous(e, p) {
    const groupeBati = app.scene.getObjectByName('batiments');
    if (e && groupeBati?.visible) {
      const r = app.renderer.domElement.getBoundingClientRect();
      souris.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(souris, app.camera);
      const meshes = groupeBati.children.filter((m) => m.isMesh && m.visible);
      const hit = ray.intersectObjects(meshes, false)[0];
      if (hit && hit.faceIndex != null) {
        const geo = hit.object.geometry;
        const v = geo.index ? geo.index.getX(hit.faceIndex * 3) : hit.faceIndex * 3;
        const em = (app.empreintes || []).find((x) => x.mesh === hit.object && v >= x.debut && v < x.debut + x.nb);
        if (em) return em;
      }
    }
    // bâti masqué, ou clic au pied d'un bâtiment : emprise sous le point du sol
    if (!p) return null;
    return (app.empreintes || []).find((x) => x.mesh?.visible !== false && x.polys.some(([ext]) => pointDansPolygone(p[0], p[1], ext))) || null;
  }
  const demoliSous = (p) => (p ? [...etat.demolis.values()].find((d) => d.polys.some(([ext]) => pointDansPolygone(p[0], p[1], ext))) : null);

  function retirerSurbrillance() {
    if (surbrillance) { surbrillance.parent?.remove(surbrillance); surbrillance.geometry.dispose(); surbrillance = null; }
    survole = null;
  }
  function surligner(em) {
    if (em === survole) return;
    retirerSurbrillance();
    if (!em?.mesh) return;
    survole = em;
    const src = em.mesh.geometry;
    const g = new THREE.BufferGeometry();
    const a = src.getAttribute('position');
    g.setAttribute('position', new THREE.BufferAttribute(a.array.slice(em.debut * 3, (em.debut + em.nb) * 3), 3));
    surbrillance = new THREE.Mesh(g, matSurvol);
    surbrillance.raycast = () => {};
    surbrillance.renderOrder = 5;
    surbrillance.userData.pasDeRelief = true; // copie des sommets déjà posés sur le relief
    em.mesh.add(surbrillance); // même repère que le bâtiment (échelle de l'animation comprise)
  }

  function demolir(em) {
    const cle = cleEmpreinte(em);
    if (etat.demolis.has(cle)) return;
    const d = decrireDemoli(cle, { nom: em.nom, hauteur: em.hauteur }) || { cle, nom: em.nom, hauteur: em.hauteur, polys: em.polys, cx: em.cx, cz: em.cz };
    etat.demolis.set(cle, d);
    appliquerDemolitions();
    app.signaler(`${d.nom || 'Bâtiment'} démoli (${Math.round(d.hauteur)} m).`);
  }
  function retablir(cle) {
    if (!etat.demolis.delete(cle)) return;
    appliquerDemolitions();
  }
  function appliquerDemolitions() {
    retirerSurbrillance();
    app.reconstruireBatiments();
    dessinerFantomes();
    app.temps?.appliquer({ instantane: true });
    majListes();
    changement({ immediat: true });
  }

  // ------------------------------------------------------------
  // Modes de clic sur la maquette (app.captureSol, voir interface.js)
  // ------------------------------------------------------------
  function clic(p, e) {
    if (etat.mode === 'demolir') {
      const em = batimentSous(e, p);
      if (em) { demolir(em); return; }
      const d = demoliSous(p);
      if (d) { retablir(d.cle); app.signaler(`${d.nom || 'Bâtiment'} rétabli.`); }
      return;
    }
    if (!p) return;
    if (Math.hypot(p[0], p[1]) > app.config.rayonEtude) { app.signaler('Placez le volume dans le périmètre d\'étude.'); return; }
    const g = app.proj.versGeo(p[0], p[1]);
    if (etat.mode === 'poser') {
      if (etat.formes.length >= MAX_FORMES) { app.signaler(`${MAX_FORMES} volumes au plus.`); return; }
      const f = { n: etat.suivant++, ...valeursFormulaire(), lat: g.lat, lon: g.lon, vis: true, x: p[0], z: p[1] };
      etat.formes.push(f);
      etat.sel = etat.formes.length - 1;
      arreterMode();
    } else if (etat.mode === 'deplacer' && etat.formes[etat.sel]) {
      Object.assign(etat.formes[etat.sel], { lat: g.lat, lon: g.lon, x: p[0], z: p[1] });
      arreterMode();
    }
    dessinerFormes();
    app.temps?.appliquer({ instantane: true });
    majListes();
    changement({ immediat: true });
  }

  clic.sansSol = true; // interface.js : appelé aussi quand le pointeur vise le ciel (bâtiment touché en 3D)

  function survol(p, e) {
    if (etat.mode !== 'demolir') return;
    const em = batimentSous(e, p);
    surligner(em);
    const d = em ? null : demoliSous(p);
    const canvas = app.renderer.domElement;
    canvas.style.cursor = em || d ? 'pointer' : 'crosshair';
    if (ui.survol?.isConnected) {
      ui.survol.textContent = em ? `Sous le pointeur : ${em.nom || 'bâtiment'}, ${Math.round(em.hauteur)} m (cliquer pour démolir).`
        : d ? `Sous le pointeur : ${d.nom || 'bâtiment'} démoli (cliquer pour rétablir).` : '';
    }
  }

  function demarrerMode(mode) {
    if (etat.mode === mode) { arreterMode(); return; }
    if (!etat.visible) { etat.visible = true; appliquerVisibilite(); }
    etat.mode = mode;
    app.captureSol = clic;
    app.survolCapture = survol;
    majModes();
    const textes = {
      demolir: 'Démolir : cliquez un bâtiment pour le démolir, son contour pour le rétablir. Échap ou le bouton pour finir.',
      poser: 'Cliquez le sol pour poser le volume.',
      deplacer: 'Cliquez le sol pour déplacer le volume choisi.',
    };
    note(textes[mode]);
  }
  function arreterMode() {
    if (app.captureSol === clic) app.captureSol = null;
    if (app.survolCapture === survol) app.survolCapture = null;
    etat.mode = null;
    retirerSurbrillance();
    app.renderer.domElement.style.cursor = '';
    if (ui.survol?.isConnected) ui.survol.textContent = '';
    majModes();
    note('');
  }

  // ------------------------------------------------------------
  // Formes : formulaire, liste, édition en direct
  // ------------------------------------------------------------
  function libelleForme(f) {
    const d = f.forme === 'rond' ? `rayon ${f.a} m` : f.forme === 'carre' ? `côté ${f.a} m` : `${f.a} × ${f.b} m`;
    return `${NOM_FORME[f.forme] || f.forme}, ${d}, h ${f.h} m${f.rot ? `, ${f.rot}°` : ''}`;
  }
  const borner = (cle, v) => { const [lo, hi, d] = BORNES[cle]; const x = Number(v); return Number.isFinite(x) && v !== '' ? Math.max(lo, Math.min(hi, x)) : d; };
  function valeursFormulaire() {
    if (!ui.forme?.isConnected) return { forme: 'carre', a: 30, b: 20, t: 10, rot: 0, h: 18, couleur: etat.couleurDefaut || undefined };
    const c = ui.couleur.value;
    const defaut = etat.couleurDefaut || hexCSS(couleurs().projet);
    return { forme: ui.forme.value, a: borner('a', ui.a.value), b: borner('b', ui.b.value), t: borner('t', ui.t.value), rot: borner('rot', ui.rot.value), h: borner('h', ui.h.value), couleur: c && c !== defaut ? c : undefined };
  }
  function champsPour(forme) {
    if (!ui.forme?.isConnected) return;
    const deux = forme !== 'carre' && forme !== 'rond', aile = forme === 'L' || forme === 'U';
    ui.aLib.textContent = forme === 'rond' ? 'Rayon (m)' : forme === 'carre' ? 'Côté (m)' : 'Largeur (m)';
    ui.bLigne.hidden = !deux;
    ui.tLigne.hidden = !aile;
  }
  function chargerFormulaire() {
    const f = etat.formes[etat.sel];
    if (!f || !ui.forme?.isConnected) return;
    ui.forme.value = f.forme; ui.a.value = f.a; ui.b.value = f.b; ui.t.value = f.t; ui.rot.value = f.rot; ui.h.value = f.h;
    ui.couleur.value = couleurDe(f) || hexCSS(couleurs().projet);
    champsPour(f.forme);
  }
  function editer() {
    champsPour(ui.forme.value);
    const f = etat.formes[etat.sel];
    if (!f) return;
    Object.assign(f, valeursFormulaire());
    dessinerFormes();
    app.temps?.appliquer({ instantane: true });
    majListes();
    changement();
  }
  function selectionner(i) {
    etat.sel = etat.sel === i ? -1 : i;
    chargerFormulaire();
    dessinerFormes();
    app.temps?.appliquer({ instantane: true });
    majListes();
  }
  function supprimer(i) {
    etat.formes.splice(i, 1);
    if (etat.sel >= etat.formes.length) etat.sel = etat.formes.length - 1;
    if (etat.sel === i) etat.sel = -1;
    dessinerFormes();
    app.temps?.appliquer({ instantane: true });
    majListes();
    changement({ immediat: true });
  }

  // ------------------------------------------------------------
  // Calque « Projet », enregistrement, réinitialisation
  // ------------------------------------------------------------
  function appliquerVisibilite() {
    if (!etat.visible) arreterMode();
    app.reconstruireBatiments();
    redessiner();
    if (ui.visible?.isConnected) ui.visible.checked = etat.visible;
    majListes();
    changement({ immediat: true });
  }

  function serialiser() {
    return {
      description: 'Projet de l\'atlas : bâtiments démolis (clés OSM / IGN) et volumes ajoutés (centre en WGS84, dimensions en mètres, rotation en degrés, sens trigonométrique, nord en haut).',
      visible: etat.visible,
      demolis: [...etat.demolis.values()].map((d) => ({ cle: d.cle, nom: d.nom || null, hauteur: Math.round(d.hauteur * 10) / 10 })),
      couleur: etat.couleurDefaut || undefined,
      imports: app.imports?.serialiser?.() ?? (etat.importsLus.length ? etat.importsLus : undefined),
      formes: etat.formes.map((f) => ({ n: f.n, forme: f.forme, a: f.a, b: f.b, t: f.t, rot: f.rot, h: f.h, lat: +f.lat.toFixed(7), lon: +f.lon.toFixed(7), vis: f.vis, couleur: f.couleur || undefined })),
    };
  }
  function lire(d) {
    etat.demolis.clear();
    etat.formes = [];
    etat.sel = -1;
    if (!d || typeof d !== 'object') return;
    etat.visible = d.visible !== false;
    const hexOk = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : undefined);
    etat.couleurDefaut = hexOk(d.couleur) || null;
    etat.importsLus = Array.isArray(d.imports) ? d.imports : []; // fichiers 3D importés (js/imports.js)
    app.imports?.lire?.(etat.importsLus);
    const absents = [];
    for (const x of d.demolis || []) {
      if (!x?.cle) continue;
      const desc = decrireDemoli(String(x.cle), x);
      if (desc) etat.demolis.set(desc.cle, desc); else absents.push(x.nom || x.cle);
    }
    for (const x of d.formes || []) {
      if (!x || !FORMES.some((f) => f.id === x.forme) || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
      const p = app.proj.versLocal(x.lat, x.lon);
      etat.formes.push({ n: x.n || etat.formes.length + 1, forme: x.forme, a: borner('a', x.a), b: borner('b', x.b), t: borner('t', x.t), rot: borner('rot', x.rot), h: borner('h', x.h), lat: x.lat, lon: x.lon, vis: x.vis !== false, x: p.x, z: p.z, couleur: hexOk(x.couleur) });
    }
    etat.suivant = etat.formes.reduce((m, f) => Math.max(m, f.n), 0) + 1;
    if (absents.length) console.warn(`projet.json : ${absents.length} bâtiment(s) démoli(s) introuvable(s) dans le bâti chargé`, absents);
  }

  // lu au démarrage, avant la construction du bâti
  async function charger() {
    lire(await chargerJSON('data/projet.json', null));
  }

  function enregistrer() {
    enregistrerDonnees('projet.json', JSON.stringify(serialiser(), null, 2), { apres: 'rechargé à la prochaine ouverture' });
  }

  function reinitialiser() {
    if (!etat.demolis.size && !etat.formes.length && !app.imports?.nombre?.()) return;
    if (!window.confirm('Effacer tout le projet (bâtiments démolis et volumes ajoutés) ? Le fichier data/projet.json n\'est modifié qu\'en enregistrant.')) return;
    arreterMode();
    etat.demolis.clear();
    etat.formes = [];
    etat.sel = -1;
    etat.suivant = 1;
    app.imports?.vider?.();
    appliquerVisibilite();
    app.signaler('Projet réinitialisé.');
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  const note = (t) => { if (ui.note?.isConnected) ui.note.textContent = t; };

  function majModes() {
    if (!ui.boutonDemolir?.isConnected) return;
    ui.boutonDemolir.setAttribute('aria-pressed', String(etat.mode === 'demolir'));
    ui.boutonDemolir.textContent = etat.mode === 'demolir' ? 'Finir de démolir' : 'Démolir';
    ui.boutonPoser.setAttribute('aria-pressed', String(etat.mode === 'poser'));
    ui.boutonDeplacer.setAttribute('aria-pressed', String(etat.mode === 'deplacer'));
    ui.boutonDeplacer.disabled = !etat.formes[etat.sel];
    ui.boutonPoser.disabled = etat.formes.length >= MAX_FORMES;
  }

  function majListes() {
    if (!ui.demolis?.isConnected) return;
    const d = [...etat.demolis.values()];
    ui.demolis.replaceChildren(...(d.length ? d.map((x) => h('li', {},
      h('span', {}, `${x.nom || 'Bâtiment'}, ${Math.round(x.hauteur)} m`),
      h('button', { type: 'button', class: 'bouton discret petit', onclick: () => retablir(x.cle) }, 'Rétablir'),
    )) : [h('li', { class: 'vide' }, 'Aucun bâtiment démoli.')]));
    ui.toutRetablir.disabled = !d.length;
    ui.formes.replaceChildren(...(etat.formes.length ? etat.formes.map((f, i) => h('li', { class: i === etat.sel ? 'choisi' : '' },
      h('input', { type: 'checkbox', checked: f.vis, 'aria-label': `Afficher le volume ${f.n}`, onchange: (e) => { f.vis = e.target.checked; dessinerFormes(); app.temps?.appliquer({ instantane: true }); changement({ immediat: true }); } }),
      h('i', { class: 'pastille-projet', 'aria-hidden': 'true', style: { background: couleurDe(f) || hexCSS(couleurs().projet) } }),
      h('button', { type: 'button', class: 'choisir', 'aria-pressed': String(i === etat.sel), onclick: () => selectionner(i) }, `Volume ${f.n} : ${libelleForme(f)}`),
      h('button', { type: 'button', class: 'bouton discret petit', 'aria-label': `Supprimer le volume ${f.n}`, title: 'Supprimer', onclick: () => supprimer(i) }, '×'),
    )) : [h('li', { class: 'vide' }, 'Aucun volume ajouté.')]));
    const n = etat.formes.filter((f) => f.vis).length;
    ui.resume.textContent = `${d.length} bâtiment${d.length > 1 ? 's' : ''} démoli${d.length > 1 ? 's' : ''}, ${etat.formes.length} volume${etat.formes.length > 1 ? 's' : ''} ajouté${etat.formes.length > 1 ? 's' : ''}${etat.formes.length && n < etat.formes.length ? ` (${n} affiché${n > 1 ? 's' : ''})` : ''}.`;
    majModes();
  }

  function champ(cle, libelle, pas) {
    const [lo, hi, d] = BORNES[cle];
    ui[cle] = h('input', { type: 'number', min: lo, max: hi, step: pas, value: d, inputmode: 'decimal', oninput: editer, onchange: editer });
    ui[`${cle}Lib`] = h('span', {}, libelle);
    const ligne = h('label', { class: 'champ-projet' }, ui[`${cle}Lib`], ui[cle]);
    ui[`${cle}Ligne`] = ligne;
    return ligne;
  }

  function construirePanneau(conteneur) {
    if (!document.querySelector('link[href="css/projet.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/projet.css' }));
    ui.visible = h('input', { type: 'checkbox', checked: etat.visible, onchange: (e) => { etat.visible = e.target.checked; appliquerVisibilite(); } });
    ui.resume = h('p', { class: 'note' });
    ui.note = h('p', { class: 'note consigne-projet', 'aria-live': 'polite' });
    ui.survol = h('p', { class: 'note' });
    ui.boutonDemolir = h('button', { type: 'button', class: 'bouton principal', 'aria-pressed': 'false', onclick: () => demarrerMode('demolir') }, 'Démolir');
    ui.demolis = h('ul', { class: 'liste-projet' });
    ui.toutRetablir = h('button', { type: 'button', class: 'bouton discret petit', onclick: () => { if (!etat.demolis.size) return; etat.demolis.clear(); appliquerDemolitions(); app.signaler('Tous les bâtiments sont rétablis.'); } }, 'Tout rétablir');
    ui.forme = h('select', { onchange: editer }, ...FORMES.map((f) => h('option', { value: f.id }, f.libelle)));
    ui.boutonPoser = h('button', { type: 'button', class: 'bouton principal', 'aria-pressed': 'false', onclick: () => { etat.sel = -1; dessinerFormes(); app.temps?.appliquer({ instantane: true }); majListes(); demarrerMode('poser'); } }, 'Ajouter et placer');
    ui.boutonDeplacer = h('button', { type: 'button', class: 'bouton', 'aria-pressed': 'false', onclick: () => demarrerMode('deplacer') }, 'Déplacer');
    ui.formes = h('ul', { class: 'liste-projet liste-formes' });
    ui.couleur = h('input', { type: 'color', value: etat.couleurDefaut || hexCSS(couleurs().projet), 'aria-label': 'Couleur du volume', oninput: editer, onchange: editer });
    ui.boutonDefaut = h('button', { type: 'button', class: 'bouton discret petit', title: 'Les nouveaux volumes et ceux sans couleur propre prennent cette couleur', onclick: () => {
      etat.couleurDefaut = ui.couleur.value;
      for (const f of etat.formes) if (f.couleur === etat.couleurDefaut) delete f.couleur;
      dessinerFormes(); app.temps?.appliquer({ instantane: true }); majListes(); changement();
      app.signaler('Couleur par défaut des volumes enregistrée (avec « Enregistrer projet.json »).');
    } }, 'Couleur par défaut des volumes');

    conteneur.append(
      h('label', { class: 'case' }, ui.visible, h('span', {}, h('i', { class: 'pastille-projet', 'aria-hidden': 'true' }), 'Afficher le projet (décochée : le bâti existant seul)')),
      ui.resume,
      h('h3', {}, 'Démolir'),
      h('div', { class: 'actions' }, ui.boutonDemolir, ui.toutRetablir),
      ui.survol,
      ui.demolis,
      h('div', { class: 'titre-info' }, h('h3', {}, 'Ajouter des volumes'),
        info('Choisir un volume dans la liste pour modifier sa forme, ses dimensions, sa rotation, sa hauteur ou sa couleur (en direct) ; la case le masque. Hauteur de 3 à 120 m. Les volumes et les démolitions comptent dans les calculs de Soleil, Confort et Vent, et dans les exports.')),
      h('div', { class: 'formulaire-projet' },
        h('label', { class: 'champ-projet' }, h('span', {}, 'Forme'), ui.forme),
        champ('a', 'Côté (m)', 1), champ('b', 'Profondeur (m)', 1), champ('t', 'Épaisseur des ailes (m)', 1),
        champ('rot', 'Rotation (°)', 5), champ('h', 'Hauteur (m)', 1),
        h('label', { class: 'champ-projet' }, h('span', {}, 'Couleur'), ui.couleur)),
      h('div', { class: 'actions serrees' }, ui.boutonDefaut),
      h('div', { class: 'actions' }, ui.boutonPoser, ui.boutonDeplacer),
      ui.note,
      ui.formes,
      ui.blocImports = h('div', { class: 'bloc-imports' }),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Enregistrer'),
        info('Le projet est relu au démarrage depuis data/projet.json. Sans serveur local, le fichier est téléchargé : le placer dans data/.')),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: enregistrer }, 'Enregistrer projet.json'),
        h('button', { type: 'button', class: 'bouton discret', onclick: reinitialiser }, 'Réinitialiser')),
    );
    app.imports?.construireBloc?.(ui.blocImports);
    champsPour(ui.forme.value);
    chargerFormulaire();
    majListes();
  }

  // ------------------------------------------------------------
  // Montage
  // ------------------------------------------------------------
  function construire() {
    majCouleurs();
    app.scene.add(groupe);
    redessiner();
  }

  app.on('outil', (id) => { if (id !== 'projet') arreterMode(); });
  app.on('etat', () => retirerSurbrillance());
  let compteur = 0;

  return {
    etat, charger, construire, filtrer, batiEffectif, formesVisibles, demolisVisibles, empreinteForme,
    construirePanneau, enregistrer, reinitialiser, serialiser, lire, demolir, retablir, arreterMode,
    // appelé à chaque image : suit le relief affiché (toutes les 20 images)
    maj() { if (++compteur % 20 === 0) poserSurRelief(); },
    get version() { return etat.version; },
    get visible() { return etat.visible; },
    // calque « Projet » affiché ou non (outil Vent : confort avec / sans le projet)
    definirVisible(v) { if (etat.visible !== !!v) { etat.visible = !!v; appliquerVisibilite(); } },
  };
}
