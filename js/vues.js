import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { h, info, allerVers, easeInOutCubic, mouvementReduit } from './util.js';
import { chargerJSON, enregistrerDonnees } from './donnees.js';
import { creerPieton } from './pieton.js';
import { creerParcours } from './parcours.js';

// Outil « Vues » (onglet Vues) : points de vue enregistrés.
// - Une vue garde la caméra (position et cible en WGS84 + hauteur au-dessus du sol, donc indépendante de config.origine),
//   la focale, la projection (3d | axo | plan | face | pieton), la coupe active, le soleil (jour, heure), l'époque,
//   les couches (app.couches), la vue maquette, le mode du bâti et sa représentation, l'onglet et l'outil ouverts, une vignette JPEG.
// - Liste nommée dans data/vues.json (enregistrerDonnees, sinon téléchargement), relue au démarrage.
// - Aller à une vue : transition douce (allerVers + focale animée). Clavier : N vue suivante, P vue précédente.
// - Observateur et vue piéton : js/pieton.js (app.pieton), créé ici ; une vue « pieton » le rétablit.
// - Parcours enregistrés : js/parcours.js, créé ici à la place de l'interface neutre app.parcours (data/parcours.json lu par charger()).
// - Projection axonométrique : OrthographicCamera + OrbitControls permutés dans app.camera / app.controls (comme la vue de face des coupes).
// Focale en mm « équivalent 24 × 36 » : champ vertical = 2 atan(12 / f).

export const focaleVersFov = (f) => THREE.MathUtils.radToDeg(2 * Math.atan(12 / f));
export const fovVersFocale = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
export const FOCALES = [18, 24, 28, 35, 50, 85];
const CLE_OPTIONS = 'atlas-hdv-vues';
const lireOptions = () => { try { return JSON.parse(localStorage.getItem(CLE_OPTIONS) || '{}'); } catch { return {}; } };
const ecrireOptions = (o) => { try { localStorage.setItem(CLE_OPTIONS, JSON.stringify(o)); } catch { /* stockage indisponible */ } };

export function creerVues(app) {
  if (!document.querySelector('link[href$="css/vues.css"]')) document.head.append(h('link', { rel: 'stylesheet', href: 'css/vues.css' }));
  const cam3 = app.camera; // créé avant toute bascule : caméra perspective et contrôles d'orbite de la maquette
  const ctl3 = app.controls;
  const canvas = app.renderer.domElement;
  const etat = { liste: [], courant: -1, modifie: false, outil: null, options: { outil: false, ...lireOptions() } };
  const ui = {};

  app.on('outil', (id) => { etat.outil = id; });

  // ------------------------------------------------------------
  // Projection axonométrique (orthographique, rotation libre)
  // ------------------------------------------------------------
  const axo = { actif: false, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 8000), ctl: null, demi: 100 };
  const DIST_AXO = 1500;
  function cadrerAxo() {
    const a = window.innerWidth / window.innerHeight;
    Object.assign(axo.cam, { left: -axo.demi * a, right: axo.demi * a, top: axo.demi, bottom: -axo.demi });
    axo.cam.updateProjectionMatrix();
  }
  window.addEventListener('resize', () => { if (axo.actif) cadrerAxo(); });
  function entrerAxo() {
    if (axo.actif) return;
    quitterModes({ sauf: 'axo' });
    if (app.vue2D) basculerVue(false);
    const t = ctl3.target.clone();
    const dir = cam3.position.clone().sub(t);
    axo.demi = dir.length() * Math.tan(THREE.MathUtils.degToRad(cam3.fov) / 2);
    axo.cam.zoom = 1;
    cadrerAxo();
    axo.cam.position.copy(t).add(dir.setLength(DIST_AXO));
    axo.cam.lookAt(t);
    const c = new OrbitControls(axo.cam, canvas);
    c.enableDamping = true; c.dampingFactor = 0.08; c.maxPolarAngle = ctl3.maxPolarAngle;
    c.minZoom = 0.05; c.maxZoom = 60;
    c.target.copy(t); c.update();
    axo.ctl = c;
    app.animationCamera = null;
    ctl3.enabled = false;
    app.camera = axo.cam; app.controls = c;
    axo.actif = true;
    document.body.classList.add('vue-axo');
    majProjection();
  }
  function quitterAxo() {
    if (!axo.actif) return;
    const t = axo.ctl.target.clone();
    const demi = axo.demi / axo.cam.zoom;
    const d = demi / Math.tan(THREE.MathUtils.degToRad(cam3.fov) / 2);
    cam3.position.copy(t).add(axo.cam.position.clone().sub(t).setLength(d));
    ctl3.target.copy(t);
    axo.ctl.dispose(); axo.ctl = null;
    app.animationCamera = null;
    app.camera = cam3; app.controls = ctl3;
    ctl3.enabled = true; ctl3.update();
    axo.actif = false;
    document.body.classList.remove('vue-axo');
    majProjection();
  }
  // demi-hauteur visible (m) de la vue courante, quelle que soit la projection
  function demiVisible() {
    if (axo.actif) return axo.demi / axo.cam.zoom;
    if (app.vue2D) return app.vue.metresParPixel() * window.innerHeight / 2;
    return cam3.position.distanceTo(ctl3.target) * Math.tan(THREE.MathUtils.degToRad(cam3.fov) / 2);
  }

  // toute bascule plan/3D (touche V, chapitres, coupes…) quitte d'abord l'axonométrie et la vue piéton
  const basculerVue = app.vue.basculer;
  app.vue.basculer = (v) => { quitterModes(); basculerVue(v); majProjection(); };
  function quitterModes({ sauf } = {}) {
    if (sauf !== 'axo') quitterAxo();
    if (sauf !== 'pieton') app.pieton?.quitter?.();
    if (sauf !== 'face' && app.coupes?.etat.face) app.coupes.quitterVueFace();
  }
  function projection() {
    if (app.pieton?.actif) return 'pieton';
    if (axo.actif) return 'axo';
    if (app.coupes?.etat.face) return 'face';
    return app.vue2D ? 'plan' : '3d';
  }

  // ------------------------------------------------------------
  // Focale (caméra perspective)
  // ------------------------------------------------------------
  function definirFocale(f) {
    cam3.fov = focaleVersFov(f);
    cam3.updateProjectionMatrix();
    majFocale();
  }
  const focale = () => fovVersFocale(cam3.fov);
  function animerFocale(f1, duree) {
    const fov0 = cam3.fov, fov1 = focaleVersFov(f1);
    if (Math.abs(fov0 - fov1) < 0.01) return;
    if (duree <= 0 || mouvementReduit()) { cam3.fov = fov1; cam3.updateProjectionMatrix(); majFocale(); return; }
    const t0 = performance.now();
    const pas = (n) => {
      const u = Math.min((n - t0) / duree, 1);
      cam3.fov = fov0 + (fov1 - fov0) * easeInOutCubic(u);
      cam3.updateProjectionMatrix();
      if (u < 1) requestAnimationFrame(pas); else majFocale();
    };
    requestAnimationFrame(pas);
  }

  // ------------------------------------------------------------
  // Capture et rétablissement d'une vue
  // ------------------------------------------------------------
  const dz = (x, z) => (app.relief?.dz ? app.relief.dz(x, z) || 0 : 0);
  const arrondi = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
  function versGeo(p) {
    const g = app.proj.versGeo(p.x, p.z);
    return { lat: arrondi(g.lat, 7), lon: arrondi(g.lon, 7), h: arrondi(p.y - dz(p.x, p.z), 2) };
  }
  function versLocal(g) {
    const p = app.proj.versLocal(g.lat, g.lon);
    return new THREE.Vector3(p.x, (g.h || 0) + dz(p.x, p.z), p.z);
  }

  function vignette() {
    try {
      app.renderer.render(app.scene, app.camera);
      const src = canvas, W = 192, H = 120;
      const c = h('canvas', { width: W, height: H });
      const r = Math.min(src.width / W, src.height / H);
      const w = W * r, hh = H * r;
      c.getContext('2d').drawImage(src, (src.width - w) / 2, (src.height - hh) / 2, w, hh, 0, 0, W, H);
      return c.toDataURL('image/jpeg', 0.72);
    } catch { return null; }
  }

  function capturer(nom) {
    const proj = projection();
    let pos = app.camera.position.clone(), cible = app.controls.target.clone();
    if (proj === 'plan') pos = cible.clone().setY(0).add(new THREE.Vector3(0, app.vue.distanceEquivalente(), 0.01));
    if (proj === 'axo') pos = cible.clone().add(axo.cam.position.clone().sub(cible).setLength(demiVisible() / Math.tan(THREE.MathUtils.degToRad(cam3.fov) / 2)));
    const s = app.soleil?.etat || {};
    const v = {
      id: `v${Date.now().toString(36)}`,
      nom,
      date: new Date().toISOString().slice(0, 16),
      projection: proj,
      camera: { position: versGeo(pos), cible: versGeo(cible), focale: arrondi(focale(), 1), demi: arrondi(demiVisible(), 2) },
      coupe: app.coupes?.etat.actif || null,
      soleil: { annee: s.annee, jour: s.jour, heure: s.heure },
      etat: app.etat,
      couches: { ...app.couches },
      vueMaquette: !!app.vueMaquette,
      bati: { mode: app.bati?.etat.mode, representation: app.toits?.representation?.() },
      onglet: document.querySelector('.onglet-outil[aria-selected="true"]')?.dataset.groupe || null,
      outil: etat.outil,
    };
    const p = app.pieton?.etatVue?.();
    if (proj === 'pieton' && p) v.pieton = p;
    v.vignette = vignette();
    return v;
  }

  async function appliquer(v, { duree = 1600, outil = etat.options.outil } = {}) {
    if (!v) return;
    const instant = duree <= 0;
    // époque, couches, bâti, soleil
    if (v.etat && v.etat !== app.etat) app.temps.changer(v.etat, { instantane: instant });
    if (v.couches) Object.assign(app.couches, v.couches);
    if (v.vueMaquette != null && !!v.vueMaquette !== !!app.vueMaquette) app.definirVueMaquette(!!v.vueMaquette);
    app.emettre('couches');
    if (v.bati?.representation && app.toits?.representation?.() !== v.bati.representation) app.toits.definirRepresentation(v.bati.representation);
    if (v.bati?.mode && app.bati && app.bati.etat.mode !== v.bati.mode) { app.bati.etat.mode = v.bati.mode; app.bati.appliquer(); }
    if (v.soleil && app.soleil) {
      if (v.soleil.annee) app.soleil.etat.annee = v.soleil.annee;
      app.soleil.regler({ jour: v.soleil.jour, heure: v.soleil.heure });
    }
    // onglet et outil (option)
    if (outil && app.interface) {
      if (v.outil && v.outil !== etat.outil) app.interface.ouvrir(v.outil);
      else if (!v.outil && v.onglet) app.interface.choisirGroupe(v.onglet);
    }
    // coupe, projection, caméra
    const proj = v.projection || '3d';
    if (v.coupe && app.coupes?.liste.some((x) => x.id === v.coupe)) {
      if (app.coupes.etat.actif !== v.coupe) app.coupes.activer(v.coupe, { cadrer: false });
    } else if (app.coupes?.etat.actif) app.coupes.desactiver();
    const c = v.camera || {};
    const pos = versLocal(c.position || {}), cible = versLocal(c.cible || {});
    if (proj === 'pieton' && app.pieton?.appliquerVue) { quitterModes({ sauf: 'pieton' }); if (app.vue2D) basculerVue(false); app.pieton.appliquerVue(v, { duree }); return; }
    if (proj === 'face' && v.coupe && app.coupes?.vueFace) { quitterModes({ sauf: 'face' }); if (c.focale) definirFocale(c.focale); app.coupes.vueFace(); return; }
    if (proj === 'plan') { quitterModes(); if (!app.vue2D) basculerVue(true); }
    else {
      quitterModes({ sauf: proj === 'axo' ? 'axo' : undefined });
      if (app.vue2D) basculerVue(false);
      if (proj === 'axo') entrerAxo(); else quitterAxo();
    }
    majProjection();
    if (c.focale && proj !== 'plan') animerFocale(c.focale, duree);
    if (proj === 'axo') {
      const z0 = axo.cam.zoom, z1 = axo.demi / (c.demi || axo.demi);
      const p1 = cible.clone().add(pos.clone().sub(cible).setLength(DIST_AXO));
      const fin = allerVers(app, p1.toArray(), cible.toArray(), duree);
      animerZoomAxo(z0, z1, duree);
      return fin;
    }
    return allerVers(app, pos.toArray(), cible.toArray(), duree);
  }
  function animerZoomAxo(z0, z1, duree) {
    if (duree <= 0 || mouvementReduit()) { axo.cam.zoom = z1; axo.cam.updateProjectionMatrix(); return; }
    const t0 = performance.now();
    const pas = (n) => {
      if (!axo.actif) return;
      const u = Math.min((n - t0) / duree, 1);
      axo.cam.zoom = z0 + (z1 - z0) * easeInOutCubic(u);
      axo.cam.updateProjectionMatrix();
      if (u < 1) requestAnimationFrame(pas);
    };
    requestAnimationFrame(pas);
  }

  // ------------------------------------------------------------
  // Liste : ajout, mise à jour, renommage, ordre, suppression, navigation
  // ------------------------------------------------------------
  function modifier() { etat.modifie = true; majListe(); }
  function enregistrerVue(nom) {
    const v = capturer((nom || '').trim() || `Vue ${etat.liste.length + 1}`);
    etat.liste.push(v);
    etat.courant = etat.liste.length - 1;
    modifier();
    app.signaler(`Vue « ${v.nom} » enregistrée${app.mode === 'presentateur' ? ' (pensez à enregistrer vues.json)' : ''}.`);
    return v;
  }
  function mettreAJour(i) {
    const a = etat.liste[i]; if (!a) return;
    etat.liste[i] = { ...capturer(a.nom), id: a.id };
    etat.courant = i;
    modifier();
  }
  function renommer(i, nom) { const v = etat.liste[i]; if (!v || !nom?.trim()) return; v.nom = nom.trim(); modifier(); }
  function supprimer(i) {
    if (!etat.liste[i]) return;
    etat.liste.splice(i, 1);
    if (etat.courant >= etat.liste.length) etat.courant = etat.liste.length - 1;
    modifier();
  }
  function deplacer(i, d) {
    const j = i + d;
    if (j < 0 || j >= etat.liste.length) return;
    [etat.liste[i], etat.liste[j]] = [etat.liste[j], etat.liste[i]];
    if (etat.courant === i) etat.courant = j; else if (etat.courant === j) etat.courant = i;
    modifier();
  }
  function aller(i, options) {
    if (!etat.liste.length) { app.signaler('Aucune vue enregistrée (onglet Vues).'); return null; }
    const n = etat.liste.length;
    etat.courant = ((i % n) + n) % n;
    majListe();
    const v = etat.liste[etat.courant];
    app.signaler(`Vue ${etat.courant + 1}/${n} : ${v.nom}`);
    return appliquer(v, options);
  }
  const suivante = () => aller(etat.courant + 1);
  const precedente = () => aller(etat.courant < 0 ? -1 : etat.courant - 1);

  // ------------------------------------------------------------
  // Fichier data/vues.json
  // ------------------------------------------------------------
  function serialiser() {
    return {
      description: 'Points de vue de l\'atlas (outil Vues). Positions en WGS84, h = hauteur au-dessus du sol (m) ; focale en mm équivalent 24 × 36 ; projection 3d | axo | plan | face | pieton.',
      vues: etat.liste,
    };
  }
  async function charger() {
    const d = await chargerJSON('data/vues.json', null);
    etat.liste = Array.isArray(d?.vues) ? d.vues.filter((v) => v && v.camera) : [];
    etat.modifie = false;
    await app.parcours.charger?.();
  }
  async function enregistrer() {
    const r = await enregistrerDonnees('vues.json', JSON.stringify(serialiser(), null, 1), { apres: 'relu à la prochaine ouverture' });
    etat.modifie = false;
    majListe();
    return r;
  }

  // ------------------------------------------------------------
  // Clavier : N vue suivante, P vue précédente (hors champs de saisie et vue piéton)
  // ------------------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey || app.releve?.actif || app.pieton?.actif) return;
    if (e.key === 'n' || e.key === 'N') { e.preventDefault(); suivante(); }
    else if (e.key === 'p' || e.key === 'P') { e.preventDefault(); precedente(); }
  });

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  const edition = () => app.mode !== 'borne';
  function majProjection() {
    if (!ui.projection) return;
    const p = projection();
    ui.projection.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.p === p)));
    majFocale();
  }
  function majFocale() {
    if (!ui.focale) return;
    const f = Math.round(focale());
    ui.focale.value = String(FOCALES.reduce((a, b) => (Math.abs(b - f) < Math.abs(a - f) ? b : a)));
    ui.focaleTexte.textContent = `${f} mm`;
    ui.focale.disabled = app.vue2D || axo.actif;
  }
  app.on('vue', majProjection);

  function ligne(v, i) {
    const nom = h('button', { type: 'button', class: 'nom-vue', title: 'Aller à cette vue', onclick: () => aller(i) }, v.nom);
    const outils = edition() ? h('div', { class: 'actions-vue' },
      h('button', { type: 'button', class: 'mini', title: 'Monter', 'aria-label': `Monter ${v.nom}`, disabled: i === 0, onclick: () => deplacer(i, -1) }, '↑'),
      h('button', { type: 'button', class: 'mini', title: 'Descendre', 'aria-label': `Descendre ${v.nom}`, disabled: i === etat.liste.length - 1, onclick: () => deplacer(i, 1) }, '↓'),
      h('button', { type: 'button', class: 'mini', title: 'Renommer', 'aria-label': `Renommer ${v.nom}`, onclick: () => {
        const champ = h('input', { type: 'text', value: v.nom, 'aria-label': 'Nouveau nom' });
        let fait = false;
        const valider = () => { if (fait) return; fait = true; renommer(i, champ.value); majListe(); };
        champ.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') valider(); if (e.key === 'Escape') { fait = true; majListe(); } });
        champ.addEventListener('blur', valider);
        nom.replaceWith(champ); champ.focus(); champ.select();
      } }, '✎'),
      h('button', { type: 'button', class: 'mini', title: 'Mettre à jour avec la vue actuelle', 'aria-label': `Mettre à jour ${v.nom}`, onclick: () => mettreAJour(i) }, '⟳'),
      h('button', { type: 'button', class: 'mini danger', title: 'Supprimer', 'aria-label': `Supprimer ${v.nom}`, onclick: () => { if (window.confirm(`Supprimer la vue « ${v.nom} » ?`)) supprimer(i); } }, '×'),
    ) : null;
    const libelle = { '3d': '3D', axo: 'axonométrie', plan: 'plan', face: 'élévation', pieton: 'piéton' }[v.projection] || '3D';
    return h('li', { class: i === etat.courant ? 'courante' : '' },
      h('button', { type: 'button', class: 'vignette-vue', title: `Aller à « ${v.nom} »`, 'aria-label': `Aller à ${v.nom}`, onclick: () => aller(i) },
        v.vignette ? h('img', { src: v.vignette, alt: '' }) : h('span', {}, String(i + 1))),
      h('div', { class: 'texte-vue' }, nom,
        h('span', { class: 'note' }, `${i + 1}. ${libelle}${v.projection !== 'plan' && v.camera?.focale ? `, ${Math.round(v.camera.focale)} mm` : ''}`)),
      outils);
  }
  function majListe() {
    if (!ui.liste) return;
    ui.liste.replaceChildren(...etat.liste.map(ligne));
    ui.vide.hidden = etat.liste.length > 0;
    if (ui.enregistrer) ui.enregistrer.textContent = `Enregistrer vues.json${etat.modifie ? ' *' : ''}`;
  }

  function construirePanneau(c) {
    ui.projection = h('div', { class: 'choix-projection', role: 'radiogroup', 'aria-label': 'Projection' },
      ...[['3d', 'Perspective'], ['axo', 'Axonométrie'], ['plan', 'Plan']].map(([p, l]) => h('button', {
        type: 'button', role: 'radio', 'data-p': p, 'aria-checked': 'false',
        onclick: () => { if (p === 'axo') entrerAxo(); else if (p === 'plan') app.vue.basculer(true); else { quitterModes(); if (app.vue2D) basculerVue(false); } majProjection(); },
      }, l)));
    ui.focale = h('select', { 'aria-label': 'Focale', onchange: (e) => definirFocale(+e.target.value) },
      ...FOCALES.map((f) => h('option', { value: String(f) }, `${f} mm`)));
    ui.focaleTexte = h('span', { class: 'note' });
    const champNom = h('input', { type: 'text', placeholder: `Vue ${etat.liste.length + 1}`, 'aria-label': 'Nom de la vue' });
    champNom.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { enregistrerVue(champNom.value); champNom.value = ''; champNom.placeholder = `Vue ${etat.liste.length + 1}`; } });
    ui.liste = h('ol', { class: 'liste-vues' });
    ui.vide = h('p', { class: 'note', 'data-garder': '' }, 'Aucune vue enregistrée : placez la caméra, puis « Enregistrer la vue ».');
    ui.enregistrer = app.mode === 'presentateur' ? h('button', { type: 'button', class: 'bouton', onclick: enregistrer }, 'Enregistrer vues.json') : null;
    const optOutil = h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: !!etat.options.outil, onchange: (e) => { etat.options.outil = e.target.checked; ecrireOptions(etat.options); } }),
      'Rétablir aussi l\'onglet et l\'outil ouverts');
    c.append(
      h('section', {},
        h('div', { class: 'titre-info' }, h('h3', {}, 'Projection et focale'),
          info('Perspective : maquette 3D ordinaire. Axonométrie : projection orthographique (parallèle) qu\'on fait tourner comme la maquette. Plan : vue de dessus, nord en haut (touche V).',
            'Focale en millimètres « équivalent 24 × 36 » : 24 mm grand-angle, 35 mm reportage, 50 mm proche de l\'œil. La maquette s\'ouvre vers 38 mm.')),
        ui.projection,
        h('div', { class: 'ligne-focale' }, h('label', {}, 'Focale ', ui.focale), ui.focaleTexte)),
      h('section', {},
        h('div', { class: 'titre-info' }, h('h3', {}, 'Points de vue'),
          info('Une vue garde la caméra, la focale, la projection, le soleil (jour et heure), l\'époque, les couches affichées, la coupe active, le mode du bâti, l\'onglet et l\'outil ouverts, avec une vignette.',
            'Positions en latitude / longitude : les vues restent justes si le centre (outil Centre) change.',
            'Clavier : N vue suivante, P vue précédente. Liste enregistrée dans data/vues.json (serveur local), sinon téléchargée : à déposer dans data/.')),
        edition() ? h('div', { class: 'ajout-vue' }, champNom,
          h('button', { type: 'button', class: 'bouton principal', onclick: () => { enregistrerVue(champNom.value); champNom.value = ''; champNom.placeholder = `Vue ${etat.liste.length + 1}`; } }, 'Enregistrer la vue')) : null,
        ui.vide, ui.liste,
        h('div', { class: 'actions' },
          h('button', { type: 'button', class: 'bouton', title: 'Vue précédente (P)', onclick: precedente }, '‹ Précédente'),
          h('button', { type: 'button', class: 'bouton', title: 'Vue suivante (N)', onclick: suivante }, 'Suivante ›'),
          ui.enregistrer),
        optOutil),
    );
    majProjection();
    majListe();
  }

  // outils de l'onglet Vues (appelé par app.js une fois l'interface créée)
  function ajouterOutils(I, ajouterLigneAide) {
    I.ajouterOutil({ id: 'vues', groupe: 'vues', libelle: 'Vues', titre: 'Points de vue enregistrés', construire: construirePanneau });
    ajouterLigneAide('E', 'N P', 'Vue enregistrée suivante, précédente (onglet Vues)');
    I.ajouterOutil({ id: 'observateur', groupe: 'vues', libelle: 'Observateur', titre: 'Observateur et vue piéton', construire: (c) => app.pieton.construirePanneau(c) });
    I.ajouterOutil({ id: 'parcours', groupe: 'vues', libelle: 'Parcours', titre: 'Parcours de caméra', construire: (c) => app.parcours.construirePanneau(c) });
  }

  const api = {
    ajouterOutils, etat, axo, charger, enregistrer, serialiser, capturer, appliquer, enregistrerVue, mettreAJour, renommer, supprimer, deplacer,
    aller, suivante, precedente, entrerAxo, quitterAxo, quitterModes, projection, definirFocale, focale, construirePanneau,
    versGeo, versLocal, basculerVue, cam3, ctl3,
    get liste() { return etat.liste; },
  };
  app.pieton = creerPieton(app, api); // observateur et vue piéton (js/pieton.js)
  app.parcours = creerParcours(app, api); // parcours enregistrés (js/parcours.js), lus par la boucle de rendu
  return api;
}
