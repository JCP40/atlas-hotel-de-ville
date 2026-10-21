import * as THREE from 'three';
import { h, info, allerVers } from './util.js';
import { pointDansPolygone } from './geo.js';
import { focaleVersFov, FOCALES } from './vues.js';

// Observateur et vue piéton (onglet Vues > Observateur), créé par js/vues.js : app.pieton.
// - Observateur posé au clic sur le sol (second clic : direction du regard), hauteur d'œil réglable (1,60 m), suit le relief
//   (app.relief.dz) ; symbole sur la maquette : silhouette, disque et cône de vision (champ horizontal selon la focale et l'écran).
// - « Voir depuis l'observateur » : vue piéton. La caméra perspective est pilotée directement (app.controls remplacé par un
//   contrôle neutre, comme la vue de face des coupes permute les siens) : ZQSD (touches physiques, donc WASD en QWERTY) ou flèches,
//   Maj = course, souris (pointer lock au clic) ou glisser pour regarder, molette = focale, pavé tactile à l'écran, Échap pour sortir.
// - Collisions simples avec le bâti effectif (app.batiEffectif(), emprises, rayon 0,3 m, glissement le long des murs), sauf bâti masqué.
// - etatVue() / appliquerVue(v) : une vue piéton s'enregistre dans l'outil Vues.
const VITESSES = { marche: 1.4, course: 4.2 };
const RAYON = 0.3;
const PORTEE_CONE = 30;

export function creerPieton(app, vues) {
  const cam3 = vues.cam3, ctl3 = vues.ctl3;
  const canvas = app.renderer.domElement;
  const dz = (x, z) => (app.relief?.dz ? app.relief.dz(x, z) || 0 : 0);
  const obs = { pose: false, x: 0, z: 0, cap: 0, inclinaison: 0, hauteur: 1.6, focale: 35, visible: true };
  const etat = { actif: false, pose: null, avant: null, touches: new Set(), course: false, collisions: true, glisse: null, pad: new Set() };
  const ui = {};

  // ------------------------------------------------------------
  // Symbole : silhouette, disque au sol, cône de vision
  // ------------------------------------------------------------
  const COULEUR = 0xd9622b;
  const groupe = new THREE.Group();
  groupe.name = 'observateur';
  groupe.userData.pasDeRelief = true;
  groupe.visible = false;
  const matPlein = new THREE.MeshStandardMaterial({ color: COULEUR, roughness: 0.6 });
  const corps = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 1, 4, 10), matPlein);
  const tete = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), matPlein);
  const disque = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.3, 32), new THREE.MeshBasicMaterial({ color: COULEUR, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7 }));
  disque.rotation.x = -Math.PI / 2; disque.position.y = 0.14;
  const matCone = new THREE.MeshBasicMaterial({ color: COULEUR, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  const cone = new THREE.Mesh(new THREE.BufferGeometry(), matCone);
  const aretes = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: COULEUR, transparent: true, opacity: 0.9 }));
  [corps, tete, disque, cone, aretes].forEach((o) => { o.raycast = () => {}; groupe.add(o); });
  app.scene.add(groupe);

  const champH = () => 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(focaleVersFov(obs.focale)) / 2) * (window.innerWidth / window.innerHeight));
  function dessiner() {
    groupe.visible = obs.pose && obs.visible && !etat.actif;
    if (!obs.pose) return;
    const y0 = dz(obs.x, obs.z);
    groupe.position.set(obs.x, y0, obs.z);
    const hc = Math.max(obs.hauteur - 0.35, 0.4);
    corps.scale.y = Math.max((hc - 0.44) / 1, 0.05);
    corps.position.y = hc / 2;
    tete.position.y = obs.hauteur - 0.02;
    // cône horizontal au sol (secteur) et quatre arêtes depuis l'œil
    const a = champH(), n = 24, R = PORTEE_CONE;
    const pos = [0, 0.12, 0];
    for (let i = 0; i <= n; i++) {
      const t = obs.cap - a / 2 + (a * i) / n;
      pos.push(Math.sin(t) * R, 0.12, -Math.cos(t) * R);
    }
    const idx = [];
    for (let i = 1; i <= n; i++) idx.push(0, i, i + 1);
    cone.geometry.dispose();
    cone.geometry = new THREE.BufferGeometry();
    cone.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    cone.geometry.setIndex(idx);
    const v = THREE.MathUtils.degToRad(focaleVersFov(obs.focale)) / 2;
    const L = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const d = new THREE.Vector3(Math.tan(a / 2) * sx, Math.tan(v) * sy, -1).normalize().multiplyScalar(R * 0.6);
      d.applyAxisAngle(new THREE.Vector3(1, 0, 0), obs.inclinaison).applyAxisAngle(new THREE.Vector3(0, 1, 0), -obs.cap);
      L.push(0, obs.hauteur, 0, d.x, obs.hauteur + d.y, d.z);
    }
    aretes.geometry.dispose();
    aretes.geometry = new THREE.BufferGeometry();
    aretes.geometry.setAttribute('position', new THREE.Float32BufferAttribute(L, 3));
  }
  app.on('relief', dessiner);
  window.addEventListener('resize', dessiner);

  // ------------------------------------------------------------
  // Poser l'observateur : clic au sol, puis direction du regard
  // ------------------------------------------------------------
  function poser() {
    if (etat.actif) quitter();
    etat.pose = { etape: 1 };
    app.captureSol = capture;
    app.survolCapture = survol;
    consigne('Cliquez sur le sol pour poser l\'observateur.');
  }
  function capture(p) {
    if (!p) return;
    if (!etat.pose || etat.pose.etape === 1) {
      [obs.x, obs.z] = p; obs.pose = true; obs.inclinaison = 0;
      etat.pose = { etape: 2 };
      dessiner();
      consigne('Cliquez dans la direction du regard.');
    } else {
      orienter(p);
      finirPose();
      consigne(`Observateur posé, regard au ${Math.round(((THREE.MathUtils.radToDeg(obs.cap) % 360) + 360) % 360)}° (0° = nord).`);
    }
  }
  function survol(p) { if (p && etat.pose?.etape === 2) { orienter(p); dessiner(); } }
  function orienter(p) { if (Math.hypot(p[0] - obs.x, p[1] - obs.z) > 0.5) obs.cap = Math.atan2(p[0] - obs.x, -(p[1] - obs.z)); }
  function finirPose() {
    etat.pose = null;
    if (app.captureSol === capture) { app.captureSol = null; app.survolCapture = null; canvas.style.cursor = ''; }
    dessiner(); majPanneau();
  }
  app.on('outil', (id) => { if (id !== 'observateur' && etat.pose) { finirPose(); consigne(''); } });

  // ------------------------------------------------------------
  // Collisions avec le bâti effectif
  // ------------------------------------------------------------
  let index = null;
  const CELLULE = 25;
  function indexer() {
    const cells = new Map();
    const polys = [];
    for (const e of app.batiEffectif()) {
      if (!e.polys || (e.hauteur ?? 3) < 1) continue;
      for (const poly of e.polys) {
        const ext = poly[0]; if (!ext?.length) continue;
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (const [x, z] of ext) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
        const k = polys.push({ poly, x0, z0, x1, z1 }) - 1;
        for (let i = Math.floor((x0 - 1) / CELLULE); i <= Math.floor((x1 + 1) / CELLULE); i++) for (let j = Math.floor((z0 - 1) / CELLULE); j <= Math.floor((z1 + 1) / CELLULE); j++) {
          const c = `${i},${j}`; if (!cells.has(c)) cells.set(c, []); cells.get(c).push(k);
        }
      }
    }
    index = { cells, polys };
  }
  app.on('bati', () => { index = null; });
  const distSeg = (x, z, [ax, az], [bx, bz]) => {
    const dx = bx - ax, dzz = bz - az, l = dx * dx + dzz * dzz;
    const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dzz) / l)) : 0;
    return Math.hypot(x - ax - t * dx, z - az - t * dzz);
  };
  function bloque(x, z) {
    if (!etat.collisions || app.bati?.masque) return false;
    if (!index) indexer();
    const liste = index.cells.get(`${Math.floor(x / CELLULE)},${Math.floor(z / CELLULE)}`) || [];
    for (const k of liste) {
      const { poly, x0, z0, x1, z1 } = index.polys[k];
      if (x < x0 - RAYON || x > x1 + RAYON || z < z0 - RAYON || z > z1 + RAYON) continue;
      const [ext, ...trous] = poly;
      if (pointDansPolygone(x, z, ext) && !trous.some((t) => pointDansPolygone(x, z, t))) return true;
      for (const anneau of poly) for (let i = 0, j = anneau.length - 1; i < anneau.length; j = i++) if (distSeg(x, z, anneau[j], anneau[i]) < RAYON) return true;
    }
    return false;
  }

  // ------------------------------------------------------------
  // Vue piéton
  // ------------------------------------------------------------
  const neutre = { target: new THREE.Vector3(), enabled: true, update() {}, dispose() {}, addEventListener() {}, removeEventListener() {} };
  const direction = () => new THREE.Vector3(Math.sin(obs.cap) * Math.cos(obs.inclinaison), Math.sin(obs.inclinaison), -Math.cos(obs.cap) * Math.cos(obs.inclinaison));
  const oeil = () => new THREE.Vector3(obs.x, dz(obs.x, obs.z) + obs.hauteur, obs.z);
  function placerCamera() {
    const o = oeil();
    cam3.position.copy(o);
    neutre.target.copy(o).add(direction().multiplyScalar(5));
    cam3.lookAt(neutre.target);
  }
  async function entrer({ duree = 1400 } = {}) {
    if (!obs.pose) { app.signaler('Posez d\'abord l\'observateur (onglet Vues > Observateur).'); return; }
    if (etat.pose) finirPose();
    if (!etat.actif) {
      vues.quitterModes({ sauf: 'pieton' });
      if (app.vue2D) vues.basculerVue(false);
      etat.avant = { position: cam3.position.clone(), cible: ctl3.target.clone(), fov: cam3.fov };
    }
    const o = oeil();
    const fov1 = focaleVersFov(obs.focale);
    if (duree > 0 && !etat.actif) {
      groupe.visible = false;
      cam3.fov = fov1; cam3.updateProjectionMatrix();
      await allerVers(app, o.toArray(), o.clone().add(direction().multiplyScalar(5)).toArray(), duree);
    }
    etat.actif = true;
    cam3.fov = fov1; cam3.updateProjectionMatrix();
    app.animationCamera = null;
    ctl3.enabled = false;
    app.camera = cam3; app.controls = neutre;
    app.captureSol = avaler; // pas de fiche ni de parcelle au clic pendant la vue piéton
    placerCamera();
    groupe.visible = false;
    document.body.classList.add('vue-pieton');
    pad.hidden = !window.matchMedia('(pointer: coarse)').matches;
    requestAnimationFrame(boucle);
    majPanneau();
    app.emettre('pieton', true);
  }
  function avaler() {}
  avaler.sansSol = true;
  function quitter({ revenir = true } = {}) {
    if (!etat.actif) return;
    etat.actif = false;
    etat.touches.clear(); etat.pad.clear();
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    if (app.captureSol === avaler) app.captureSol = null;
    app.controls = ctl3; ctl3.enabled = true;
    const a = etat.avant;
    if (revenir && a) {
      ctl3.target.copy(neutre.target);
      cam3.fov = a.fov; cam3.updateProjectionMatrix();
      allerVers(app, a.position.toArray(), a.cible.toArray(), 900);
    } else {
      // reste sur place : la cible d'orbite passe 5 m devant l'œil
      ctl3.target.copy(neutre.target);
    }
    ctl3.update();
    document.body.classList.remove('vue-pieton');
    pad.hidden = true;
    dessiner(); majPanneau();
    app.emettre('pieton', false);
  }

  let precedent = 0;
  function boucle(t) {
    if (!etat.actif) return;
    requestAnimationFrame(boucle);
    const dt = Math.min((t - (precedent || t)) / 1000, 0.1);
    precedent = t;
    const k = etat.touches, p = etat.pad;
    const av = (k.has('KeyW') || k.has('ArrowUp') || p.has('av') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') || p.has('ar') ? 1 : 0);
    const lat = (k.has('KeyD') || k.has('ArrowRight') || p.has('dr') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') || p.has('ga') ? 1 : 0);
    if (av || lat) {
      const v = (etat.course || k.has('ShiftLeft') || k.has('ShiftRight') ? VITESSES.course : VITESSES.marche) * dt;
      const n = Math.hypot(av, lat);
      const dx = (Math.sin(obs.cap) * av + Math.cos(obs.cap) * lat) / n * v;
      const dzz = (-Math.cos(obs.cap) * av + Math.sin(obs.cap) * lat) / n * v;
      const dedans = bloque(obs.x, obs.z); // déjà dans un bâtiment (posé sur un toit) : on peut en sortir
      if (dedans || !bloque(obs.x + dx, obs.z + dzz)) { obs.x += dx; obs.z += dzz; }
      else if (!bloque(obs.x + dx, obs.z)) obs.x += dx;
      else if (!bloque(obs.x, obs.z + dzz)) obs.z += dzz;
    }
    placerCamera();
  }

  // regard : pointer lock (souris) ou glisser (souris sans verrou, doigt)
  const tourner = (mx, my, f = 0.0025) => {
    obs.cap += mx * f;
    obs.inclinaison = THREE.MathUtils.clamp(obs.inclinaison - my * f, -1.3, 1.3);
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (!etat.actif) return;
    if (e.pointerType === 'mouse' && document.pointerLockElement !== canvas) {
      try { const r = canvas.requestPointerLock?.(); r?.catch?.(() => {}); } catch { /* refusé : glisser reste possible */ }
    }
    etat.glisse = { x: e.clientX, y: e.clientY };
  });
  window.addEventListener('pointerup', () => { etat.glisse = null; });
  canvas.addEventListener('pointermove', (e) => {
    if (!etat.actif) return;
    if (document.pointerLockElement === canvas) { tourner(e.movementX, e.movementY); return; }
    if (etat.glisse && e.buttons) {
      tourner(-(e.clientX - etat.glisse.x), -(e.clientY - etat.glisse.y), 0.004);
      etat.glisse = { x: e.clientX, y: e.clientY };
    }
  });
  canvas.addEventListener('wheel', (e) => {
    if (!etat.actif) return;
    e.preventDefault();
    const i = FOCALES.indexOf(FOCALES.reduce((a, b) => (Math.abs(b - obs.focale) < Math.abs(a - obs.focale) ? b : a)));
    definirFocale(FOCALES[THREE.MathUtils.clamp(i + (e.deltaY > 0 ? -1 : 1), 0, FOCALES.length - 1)]);
  }, { passive: false });
  document.addEventListener('pointerlockchange', majPanneau);

  // clavier : écouté en phase de capture pour passer avant les raccourcis de l'atlas (S, flèches…)
  const TOUCHES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight']);
  window.addEventListener('keydown', (e) => {
    if (!etat.actif) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); quitter(); return; }
    if (e.target.closest?.('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
    if (TOUCHES.has(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); etat.touches.add(e.code); }
  }, true);
  window.addEventListener('keyup', (e) => { etat.touches.delete(e.code); }, true);
  window.addEventListener('blur', () => etat.touches.clear());

  // pavé tactile (écrans tactiles)
  const bouton = (cle, texte, libelle) => {
    const b = h('button', { type: 'button', 'aria-label': libelle, 'data-cle': cle }, texte);
    const on = (e) => { e.preventDefault(); etat.pad.add(cle); };
    const off = () => etat.pad.delete(cle);
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
    return b;
  };
  const pad = h('div', { class: 'pad-pieton', hidden: true },
    bouton('av', '▲', 'Avancer'), bouton('ga', '◀', 'Pas à gauche'), bouton('dr', '▶', 'Pas à droite'), bouton('ar', '▼', 'Reculer'),
    h('button', { type: 'button', class: 'sortir', 'aria-label': 'Quitter la vue piéton', onclick: () => quitter() }, '×'));
  document.body.append(pad);

  // ------------------------------------------------------------
  // Réglages
  // ------------------------------------------------------------
  function definirFocale(f) {
    obs.focale = f;
    if (etat.actif) { cam3.fov = focaleVersFov(f); cam3.updateProjectionMatrix(); }
    dessiner();
    if (ui.focale) ui.focale.value = String(f);
  }
  function definirHauteur(m) {
    if (!Number.isFinite(m)) return;
    obs.hauteur = THREE.MathUtils.clamp(m, 0.5, 3);
    dessiner();
    if (etat.actif) placerCamera();
  }

  // ------------------------------------------------------------
  // Vues enregistrées (outil Vues)
  // ------------------------------------------------------------
  function etatVue() {
    if (!obs.pose) return null;
    const r = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
    return { hauteur: r(obs.hauteur, 2), cap: r(obs.cap, 4), inclinaison: r(obs.inclinaison, 4), focale: obs.focale };
  }
  function appliquerVue(v, { duree = 1400 } = {}) {
    const p = v.pieton || {};
    const g = vues.versLocal(v.camera.position);
    Object.assign(obs, { pose: true, x: g.x, z: g.z });
    if (p.hauteur) obs.hauteur = p.hauteur;
    if (p.focale) obs.focale = p.focale;
    else if (v.camera.focale) obs.focale = v.camera.focale;
    if (p.cap != null) { obs.cap = p.cap; obs.inclinaison = p.inclinaison || 0; }
    else { const c = vues.versLocal(v.camera.cible); obs.cap = Math.atan2(c.x - g.x, -(c.z - g.z)); obs.inclinaison = 0; }
    if (etat.actif) { cam3.fov = focaleVersFov(obs.focale); cam3.updateProjectionMatrix(); placerCamera(); majPanneau(); return Promise.resolve(); }
    return entrer({ duree });
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  function consigne(t) { if (ui.consigne) ui.consigne.textContent = t; }
  function majPanneau() {
    if (!ui.voir) return;
    ui.voir.textContent = etat.actif ? 'Quitter la vue piéton (Échap)' : 'Voir depuis l\'observateur';
    ui.voir.setAttribute('aria-pressed', String(etat.actif));
    ui.voir.disabled = !obs.pose;
    ui.enregistrer.disabled = !etat.actif;
    ui.poser.textContent = obs.pose ? 'Déplacer l\'observateur' : 'Poser l\'observateur';
    if (etat.actif) consigne(document.pointerLockElement === canvas
      ? 'Vue piéton : Z Q S D ou flèches pour marcher, Maj pour courir, souris pour regarder, molette = focale. Échap libère la souris.'
      : 'Vue piéton : Z Q S D ou flèches pour marcher, Maj pour courir ; cliquez la maquette pour regarder à la souris (ou glissez). Échap pour sortir.');
  }
  function construirePanneau(c) {
    ui.consigne = h('p', { class: 'note consigne-pieton', 'aria-live': 'polite' });
    ui.poser = h('button', { type: 'button', class: 'bouton', onclick: poser }, 'Poser l\'observateur');
    ui.voir = h('button', { type: 'button', class: 'bouton principal', 'aria-pressed': 'false', onclick: () => (etat.actif ? quitter() : entrer()) }, 'Voir depuis l\'observateur');
    ui.enregistrer = h('button', { type: 'button', class: 'bouton', title: 'Ajouter cette vue piéton à la liste de l\'outil Vues', onclick: () => vues.enregistrerVue(`Piéton ${vues.liste.length + 1}`) }, 'Enregistrer cette vue');
    ui.focale = h('select', { 'aria-label': 'Focale', onchange: (e) => definirFocale(+e.target.value) }, ...FOCALES.map((f) => h('option', { value: String(f), selected: f === obs.focale }, `${f} mm`)));
    const hauteur = h('input', { type: 'number', min: '0.5', max: '3', step: '0.05', value: String(obs.hauteur), 'aria-label': 'Hauteur d\'œil (m)', onchange: (e) => definirHauteur(parseFloat(String(e.target.value).replace(',', '.'))) });
    hauteur.addEventListener('keydown', (e) => e.stopPropagation());
    const radio = (v, l) => h('label', { class: 'case' }, h('input', { type: 'radio', name: 'vitesse-pieton', checked: etat.course === (v === 'course'), onchange: () => { etat.course = v === 'course'; } }), l);
    c.append(
      h('section', {},
        h('div', { class: 'titre-info' }, h('h3', {}, 'Observateur'),
          info('Poser : un clic au sol place l\'observateur, un second clic donne la direction du regard. Le symbole orange montre la silhouette, le champ de vision au sol (30 m) et ses arêtes depuis l\'œil.',
            'Hauteur d\'œil : 1,60 m pour un adulte debout, 1,20 m en fauteuil roulant, 1,10 m pour un enfant. L\'œil suit le relief quand il est activé (onglet Topographie).',
            'Focale en mm équivalent 24 × 36 : 24 mm grand-angle, 35 mm, 50 mm proche du champ attentif de l\'œil.')),
        h('div', { class: 'actions' }, ui.poser,
          h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: obs.visible, onchange: (e) => { obs.visible = e.target.checked; dessiner(); } }), 'Afficher')),
        h('div', { class: 'champs-pieton' },
          h('label', {}, 'Hauteur d\'œil (m) ', hauteur),
          h('label', {}, 'Focale ', ui.focale)),
        ui.consigne),
      h('section', {},
        h('div', { class: 'titre-info' }, h('h3', {}, 'Vue piéton'),
          info('Clavier : Z Q S D (ou W A S D en QWERTY) ou flèches pour avancer, reculer et faire un pas de côté ; Maj (maintenue) pour courir. Souris : cliquer la maquette verrouille le pointeur (regard à la souris), Échap le libère, un second Échap quitte la vue piéton. Molette : focale.',
            'Écran tactile : glisser pour regarder, pavé ▲ ◀ ▶ ▼ pour marcher, × pour sortir.',
            `Marche ${VITESSES.marche.toLocaleString('fr-FR')} m/s, course ${VITESSES.course.toLocaleString('fr-FR')} m/s. Collisions simples avec les emprises du bâti effectif (existant non démoli et volumes du projet), sans escaliers ni portes ; aucune collision quand le bâti est masqué.`)),
        h('div', { class: 'actions' }, ui.voir, ui.enregistrer),
        h('div', { class: 'actions' }, radio('marche', 'Marche'), radio('course', 'Course'),
          h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.collisions, onchange: (e) => { etat.collisions = e.target.checked; } }), 'Collisions avec le bâti'))),
    );
    majPanneau();
  }

  return {
    obs, etat, groupe, construirePanneau, poser, capture, entrer, quitter, etatVue, appliquerVue, definirFocale, definirHauteur, bloque, dessiner,
    get actif() { return etat.actif; },
  };
}
