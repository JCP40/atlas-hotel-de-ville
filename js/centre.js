import * as THREE from 'three';
import { h } from './util.js';
import { enregistrerDonnees } from './donnees.js';

// Le point du projet est l'origine de l'atlas : il fixe le centre du plateau (le cercle de la maquette
// physique), le périmètre d'étude et le repère des exports. Le déplacer recompose tout l'atlas :
// le réglage est gardé dans ce navigateur, puis la page se recharge.
const CLE = 'atlas-hdv-centre';

export function lireReglageCentre() {
  try { return JSON.parse(localStorage.getItem(CLE) || 'null'); } catch { return null; }
}

// Enregistre une partie du réglage (centre, maquette, rayons) sans toucher au reste
export function modifierReglageCentre(patch) {
  const r = { ...(lireReglageCentre() || {}), ...patch };
  for (const k of Object.keys(r)) if (r[k] == null) delete r[k];
  if (Object.keys(r).length) localStorage.setItem(CLE, JSON.stringify(r)); else localStorage.removeItem(CLE);
}

// À appeler au démarrage, juste après la lecture de config.json
export function appliquerReglageCentre(app, params) {
  const c = app.config;
  if (c.rayonConfort == null) c.rayonConfort = c.rayonPlateau;
  app.configFichier = JSON.parse(JSON.stringify({ origine: c.origine, rayonPlateau: c.rayonPlateau, rayonEtude: c.rayonEtude, rayonConfort: c.rayonConfort, maquette: c.maquette }));
  const r = lireReglageCentre();
  if (!r || params.get('centre') === 'config') return;
  if (Number.isFinite(r.lat) && Number.isFinite(r.lon)) {
    c.origine = { ...c.origine, lat: r.lat, lon: r.lon, nom: r.nom || 'Point choisi dans l\'atlas' };
  }
  if (r.maquette) {
    c.maquette = r.maquette;
    c.rayonPlateau = (r.maquette.diametreCm / 100) * r.maquette.echelle / 2;
  }
  if (r.rayonEtude > 0) c.rayonEtude = r.rayonEtude;
  if (r.rayonConfort > 0) c.rayonConfort = r.rayonConfort;
  app.centrePersonnalise = true;
}

export function creerCentre(app) {
  const maquette = { diametreCm: 42, echelle: 500, ...(app.config.maquette || {}) };
  const rayons = { etude: app.config.rayonEtude, confort: app.config.rayonConfort };
  const etat = { choix: null, enCours: false };
  const ui = {};

  // aperçu du futur cercle
  const apercu = new THREE.Group();
  apercu.visible = false;
  app.scene.add(apercu);
  function dessinerApercu() {
    apercu.clear();
    const cercle = (r, couleur, opacite) => {
      const m = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.8, r + 0.8, 160).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ color: couleur, transparent: true, opacity: opacite, depthWrite: false })
      );
      m.position.y = 0.6;
      return m;
    };
    const anneau = cercle(rayonVoulu(), 0xc8372d, 0.9);
    const croix = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-6, 0.6, 0), new THREE.Vector3(6, 0.6, 0), new THREE.Vector3(0, 0.6, -6), new THREE.Vector3(0, 0.6, 6)]),
      new THREE.LineBasicMaterial({ color: 0xc8372d })
    );
    // rayon extérieur (périmètre d'étude) et rayon des analyses de confort
    apercu.add(anneau, croix, cercle(rayons.etude, 0x2f3b45, 0.55), cercle(rayons.confort, 0x2f7fb5, 0.7));
  }
  const rayonVoulu = () => (maquette.diametreCm / 100) * maquette.echelle / 2;

  app.on('pointeurSol', ([x, z]) => {
    if (!etat.enCours) return;
    apercu.position.set(x, 0, z);
  });

  function choisir() {
    if (!app.vue2D) app.vue.basculer(true);
    etat.enCours = true;
    dessinerApercu();
    apercu.visible = true;
    app.signaler('Cliquez le nouveau centre sur le plan.');
    app.captureSol = ([x, z]) => {
      etat.enCours = false;
      app.captureSol = null;
      apercu.position.set(x, 0, z);
      const g = app.proj.versGeo(x, z);
      etat.choix = { lat: +g.lat.toFixed(6), lon: +g.lon.toFixed(6) };
      majUI();
    };
  }

  function appliquer() {
    const base = etat.choix || { lat: app.config.origine.lat, lon: app.config.origine.lon };
    modifierReglageCentre({ ...base, maquette: { ...maquette }, nom: 'Point choisi dans l\'atlas', rayonEtude: rayons.etude, rayonConfort: rayons.confort });
    location.reload();
  }

  function revenir() {
    localStorage.removeItem(CLE);
    location.reload();
  }

  function enregistrerConfig() {
    const base = etat.choix || { lat: app.config.origine.lat, lon: app.config.origine.lon };
    enregistrerDonnees('config.json', JSON.stringify({
      ...app.config,
      origine: { ...app.config.origine, lat: base.lat, lon: base.lon },
      rayonPlateau: rayonVoulu(),
      rayonEtude: rayons.etude,
      rayonConfort: rayons.confort,
      maquette: { ...maquette },
    }, null, 2), { apres: 'le point et les rayons deviendront ceux de toutes les versions (borne, web)' });
  }

  function majUI() {
    if (!ui.point?.isConnected) return;
    const o = app.config.origine;
    ui.point.textContent = etat.choix
      ? `Nouveau centre : ${etat.choix.lat}, ${etat.choix.lon}.`
      : `Centre actuel : ${o.lat}, ${o.lon}${app.centrePersonnalise ? ' (choisi dans ce navigateur)' : ' (fichier config.json)'}.`;
    ui.rayon.textContent = `Cercle de ${Math.round(rayonVoulu() * 2)} m de diamètre sur le terrain, soit une maquette de ${maquette.diametreCm} cm au 1/${maquette.echelle}.`;
    ui.rayons.textContent = `Périmètre d'étude : ${Math.round(rayons.etude * 2)} m de diamètre (maquette, cadastre, réseaux, relief). Analyses de confort : cercle de ${Math.round(rayons.confort * 2)} m de diamètre.`;
    ui.appliquer.disabled = !etat.choix && rayonVoulu() === app.config.rayonPlateau && rayons.etude === app.config.rayonEtude && rayons.confort === app.config.rayonConfort;
  }

  function construirePanneau(conteneur) {
    ui.point = h('p', { class: 'resultat' });
    ui.rayon = h('p', { class: 'note' });
    ui.rayons = h('p', { class: 'note' });
    const champRayon = (libelle, cle, min, max, pas) => {
      const input = h('input', { type: 'number', min, max, step: pas, value: Math.round(rayons[cle]) });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v) && v >= min && v <= max) { rayons[cle] = v; dessinerApercu(); apercu.visible = true; majUI(); }
      });
      return h('label', { class: 'champ' }, h('span', {}, libelle), input);
    };
    const champ = (libelle, cle, min, max, pas) => {
      const input = h('input', { type: 'number', min, max, step: pas, value: maquette[cle] });
      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v) && v > 0) { maquette[cle] = v; if (apercu.visible) dessinerApercu(); majUI(); }
      });
      return h('label', { class: 'champ' }, h('span', {}, libelle), input);
    };
    ui.appliquer = h('button', { type: 'button', class: 'bouton principal', onclick: appliquer }, 'Appliquer et recomposer l\'atlas');
    conteneur.append(...[
      h('p', { class: 'note' }, 'Le centre fixe le cercle de la maquette, le périmètre d\'étude et l\'origine des exports.'),
      ui.point,
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: choisir }, 'Choisir le centre sur le plan')),
      h('h3', {}, 'Cercle de la maquette'),
      h('div', { class: 'deux-champs' }, champ('Diamètre (cm)', 'diametreCm', 10, 200, 1), champ('Échelle 1/…', 'echelle', 50, 5000, 50)),
      ui.rayon,
      h('h3', {}, 'Rayons d\'étude'),
      h('div', { class: 'deux-champs' }, champRayon('Rayon extérieur (m)', 'etude', 150, 1500, 10), champRayon('Rayon du confort (m)', 'confort', 30, 600, 5)),
      ui.rayons,
      h('p', { class: 'note' }, 'Le rayon extérieur fixe l\'étendue de la maquette et des données lues en ligne (OpenStreetMap, cadastre, réseaux) : au-delà des données préparées pour la borne, relancez preparer.html. Le rayon du confort fixe le cercle des calculs d\'ouverture au ciel, de rayonnement et de confort (plus il est grand, plus le calcul est long).'),
      h('div', { class: 'actions' }, ui.appliquer),
      h('h3', {}, 'Conserver ce réglage'),
      h('p', { class: 'note' }, 'Le réglage est gardé dans ce navigateur. Pour qu\'il vaille partout (borne, version en ligne), enregistrez config.json dans data/. Si le centre s\'éloigne de plus de 100 m, relancez la préparation hors ligne.'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: enregistrerConfig }, 'Enregistrer config.json'),
        app.centrePersonnalise ? h('button', { type: 'button', class: 'bouton discret', onclick: revenir }, 'Revenir au centre de config.json') : null),
    ].filter(Boolean));
    majUI();
  }

  app.on('outil', (id) => { if (id !== 'centre') { apercu.visible = false; if (etat.enCours) { etat.enCours = false; app.captureSol = null; } } });

  return { construirePanneau };
}
