import * as THREE from 'three';
import { h, info, allerVers } from './util.js';
import { enregistrerDonnees } from './donnees.js';

// Calage des photos de façade (onglet Bâtiments, outil « Calage », 18/11/2026).
// Les photos de data/facades/<ensemble>.json sont redressées sur quatre coins repérés à l'œil, puis plaquées sur un segment
// (gauche, droite, en mètres locaux) à hauteur unique (hauteur_m) : certaines débordent ou sont décalées. L'outil permet de
// choisir une façade (liste, ou clic sur la façade dans la maquette) et de régler en direct, au pas de 5 cm :
// - les extrémités gauche et droite (le long de la façade et vers la rue ; curseurs, boutons, poignées à glisser) ;
// - la hauteur couverte par l'image (hauteur_m) et la base (base_m : bas de l'image au-dessus du sol, 0 par défaut) ;
// - l'opacité de la photo (comparaison avec le mur ; affichage seulement, jamais enregistrée).
// Aperçu immédiat : app.toits.rafraichirFacade(f) remplace le seul mesh de cette façade (relief, découpe et exports suivis).
// « Enregistrer » relit data/facades/<ensemble>.json, réécrit gauche, droite, hauteur_m, base_m des façades modifiées dans le
// repère du fichier (champ « origine » : les valeurs en mémoire ont été recalées sur config.origine par js/toits.js) et ajoute
// calage { date, ancien: { gauche, droite, hauteur_m, base_m } } (ancien = valeurs d'avant le premier calage, gardées ensuite).
// Écriture par enregistrerDonnees (serveur.py garde l'ancienne version dans data/.sauvegardes/), sinon téléchargement.
// « Chercher une photo Panoramax / Redresser » et « Ajouter une façade » : js/redressement-facades.js (chargé à la demande) ;
// « Assistant d'îlot » : js/assistant-ilot.js (toutes les façades d'un ensemble, chargé à la demande).

const PAS = 0.05; // m
const r2 = (v) => Math.round(v * 100) / 100;
const cale = (v) => Math.round(v / PAS) * PAS; // au pas de 5 cm
const cm = (v) => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)} cm`;
const m2 = (v) => `${r2(v).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} m`;

// Sérialisation proche des fichiers d'origine : indentation du fichier, tableaux et petits objets de nombres sur une ligne
export function serialiserFacades(d, texteOrigine = '', indentation = null) {
  const m = texteOrigine.match(/^\{\r?\n( +)"/);
  const ind = indentation || (m ? m[1].length : 2);
  const prim = '(?:-?[\\d.eE+-]+|"[^"\\n]*"|true|false|null)';
  let s = JSON.stringify(d, null, ind);
  s = s.replace(new RegExp(`\\[\\s*(${prim}(?:,\\s*${prim})*)\\s*\\]`, 'g'), (_, c) => `[${c.match(new RegExp(prim, 'g')).join(', ')}]`);
  s = s.replace(/\{\s*("(?:lat|lon)": -?[\d.]+),\s*("(?:lat|lon)": -?[\d.]+)\s*\}/g, '{ $1, $2 }');
  return s + (texteOrigine.endsWith('\n') ? '\n' : '');
}

// Remplace dans le texte du fichier le seul bloc de la façade « id » (objet dont « id » est la première clé) : le reste du
// fichier reste identique, octet pour octet. null si le bloc n'est pas trouvé (le fichier est alors réécrit en entier).
export function remplacerBlocFacade(texte, id, objet) {
  const cle = `"id": ${JSON.stringify(id)}`;
  const i = texte.indexOf(cle);
  if (i < 0 || texte.indexOf(cle, i + 1) >= 0) return null;
  const debut = texte.lastIndexOf('{', i);
  if (debut < 0 || texte.slice(debut + 1, i).trim()) return null;
  let prof = 0, chaine = false, fin = -1;
  for (let k = debut; k < texte.length; k++) {
    const c = texte[k];
    if (chaine) { if (c === '\\') k++; else if (c === '"') chaine = false; continue; }
    if (c === '"') chaine = true;
    else if (c === '{') prof++;
    else if (c === '}' && --prof === 0) { fin = k; break; }
  }
  if (fin < 0) return null;
  const ligne = texte.slice(texte.lastIndexOf('\n', debut) + 1, debut);
  const m = texte.match(/^\{\r?\n( +)"/);
  const bloc = serialiserFacades(objet, '', m ? m[1].length : 2).split('\n').join(`\n${ligne}`);
  return texte.slice(0, debut) + bloc + texte.slice(fin + 1);
}

export function creerCalageFacades(app) {
  const T = app.toits;
  const etat = {
    sel: null, // façade choisie (objet en mémoire de app.toits, repère courant)
    originaux: new Map(), // id -> valeurs à la première modification de la session (repère courant)
    piles: new Map(), // id -> pile d'annulation [valeurs]
    modifiees: new Set(), // ids modifiés depuis le dernier enregistrement
    opacite: 1,
    actif: false,
    vueAvant: null, // { p, c, vue2D } : caméra d'avant la vue de face (bouton « Vue précédente »)
    glisse: null, // 'gauche' | 'droite' pendant un glisser de poignée
    origines: new Map(), // id d'ensemble -> origine du fichier (lue à la demande)
  };
  const ui = {};

  const facades = () => T?.toutesFacades?.() || [];
  const ensembleDe = (f) => T.ensembleDeFacade(f);
  const valeurs = (f) => ({ gauche: [...f.gauche], droite: [...f.droite], hauteur_m: f.hauteur_m, base_m: Number.isFinite(f.base_m) ? f.base_m : 0 });
  const egales = (a, b) => ['gauche', 'droite'].every((k) => Math.abs(a[k][0] - b[k][0]) < 1e-4 && Math.abs(a[k][1] - b[k][1]) < 1e-4)
    && Math.abs(a.hauteur_m - b.hauteur_m) < 1e-4 && Math.abs(a.base_m - b.base_m) < 1e-4;
  const original = (f) => etat.originaux.get(f.id) || valeurs(f);
  // repère de réglage, tiré du segment d'origine : u le long de la façade (gauche → droite), n vers la rue
  function repere(f) {
    const o = original(f);
    const L = Math.hypot(o.droite[0] - o.gauche[0], o.droite[1] - o.gauche[1]) || 1;
    const az = THREE.MathUtils.degToRad(f.normale_az);
    const u = [(o.droite[0] - o.gauche[0]) / L, (o.droite[1] - o.gauche[1]) / L];
    // n perpendiculaire au segment (réglages indépendants), du côté de la rue : celui de la normale de la photo,
    // N = (sin az, −cos az) en (x est, z sud) comme meshFacade de js/toits.js (azimut depuis le nord, horaire ; nord = −z).
    // (19/11/2026 : le signe de N.z était inversé, n pointait vers l'intérieur pour 15 façades sur 24 : vue de face prise de dos.)
    const N = [Math.sin(az), -Math.cos(az)];
    const s = u[1] * N[0] - u[0] * N[1] >= 0 ? 1 : -1;
    return { u, n: [s * u[1], -s * u[0]], o };
  }
  // décalage d'une extrémité par rapport à l'original : { a (le long), p (vers la rue) }
  function ecartExtremite(f, k) {
    const { u, n, o } = repere(f);
    const d = [f[k][0] - o[k][0], f[k][1] - o[k][1]];
    return { a: d[0] * u[0] + d[1] * u[1], p: d[0] * n[0] + d[1] * n[1] };
  }
  function placerExtremite(v, f, k, a, p) {
    const { u, n, o } = repere(f);
    // pas d'arrondi ici (sinon dérive au fil des pas) : valeurs arrondies au centimètre à l'enregistrement
    v[k] = [o[k][0] + a * u[0] + p * n[0], o[k][1] + a * u[1] + p * n[1]];
  }

  // ------------------------------------------------------------
  // Application d'un réglage (aperçu immédiat)
  // ------------------------------------------------------------
  let rafraichir = 0;
  function appliquerValeurs(f, v) {
    f.gauche = [...v.gauche];
    f.droite = [...v.droite];
    f.hauteur_m = r2(Math.max(0.5, v.hauteur_m));
    if (Math.abs(v.base_m) < 1e-6 && !Number.isFinite(etat.originaux.get(f.id)?.baseFichier)) delete f.base_m; else f.base_m = r2(v.base_m);
    const o = etat.originaux.get(f.id);
    if (o && egales(valeurs(f), o)) etat.modifiees.delete(f.id); else etat.modifiees.add(f.id);
    majAides();
    if (!rafraichir) {
      rafraichir = requestAnimationFrame(() => { rafraichir = 0; T.rafraichirFacade(f); app.emettre('facades'); });
    }
    majPanneau();
  }
  // nouvelle étape d'annulation (une par geste : bouton, glisser, curseur déplacé)
  function memoriser(f) {
    if (!etat.originaux.has(f.id)) etat.originaux.set(f.id, { ...valeurs(f), baseFichier: Number.isFinite(f.base_m) ? f.base_m : undefined });
    if (!etat.piles.has(f.id)) etat.piles.set(f.id, []);
    const pile = etat.piles.get(f.id);
    const v = valeurs(f);
    if (!pile.length || !egales(pile[pile.length - 1], v)) pile.push(v);
    if (pile.length > 200) pile.shift();
  }
  function modifier(changer, { geste = true } = {}) {
    const f = etat.sel;
    if (!f) return;
    if (geste) memoriser(f);
    const v = valeurs(f);
    changer(v, f);
    appliquerValeurs(f, v);
  }
  function annuler() {
    const f = etat.sel;
    const pile = f && etat.piles.get(f.id);
    if (!pile?.length) return;
    appliquerValeurs(f, pile.pop());
  }
  function retablirOriginal() {
    const f = etat.sel;
    const o = f && etat.originaux.get(f.id);
    if (!o || egales(valeurs(f), o)) return;
    memoriser(f);
    appliquerValeurs(f, o);
  }
  // valeurs d'avant le premier calage (champ calage.ancien du fichier), ramenées au repère courant
  async function revenirAvantCalage() {
    const f = etat.sel;
    if (!f?.calage?.ancien) return;
    const d = await decalageFichier(ensembleDe(f)?.id);
    const a = f.calage.ancien;
    memoriser(f);
    appliquerValeurs(f, { gauche: [r2(a.gauche[0] + d.x), r2(a.gauche[1] + d.z)], droite: [r2(a.droite[0] + d.x), r2(a.droite[1] + d.z)], hauteur_m: a.hauteur_m, base_m: a.base_m ?? 0 });
  }

  // ------------------------------------------------------------
  // Repère du fichier : valeurs en mémoire = valeurs du fichier + position de son origine dans le repère courant
  // ------------------------------------------------------------
  async function lireFichier(id) {
    const r = await fetch(`data/facades/${id}.json`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`data/facades/${id}.json illisible (${r.status})`);
    const texte = await r.text();
    const d = JSON.parse(texte);
    etat.origines.set(id, d.origine || null);
    return { texte, d };
  }
  async function decalageFichier(id) {
    if (!etat.origines.has(id)) await lireFichier(id);
    const o = etat.origines.get(id);
    return o ? app.proj.versLocal(o.lat, o.lon) : { x: 0, z: 0 };
  }

  async function enregistrer() {
    const ids = new Set([...etat.modifiees].map((id) => facades().find((f) => f.id === id)).filter(Boolean).map((f) => ensembleDe(f)?.id).filter(Boolean));
    if (!ids.size) { app.signaler('Aucune façade modifiée à enregistrer.'); return; }
    for (const id of ids) {
      try {
        const { texte, d } = await lireFichier(id);
        const o = d.origine;
        const { x: dx, z: dz } = o ? app.proj.versLocal(o.lat, o.lon) : { x: 0, z: 0 };
        const date = new Date();
        const jour = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const ecrites = [];
        for (const f of facades().filter((x) => etat.modifiees.has(x.id) && ensembleDe(x)?.id === id)) {
          const cible = d.facades?.find((x) => x.id === f.id);
          if (!cible) continue;
          const nouv = {
            gauche: [r2(f.gauche[0] - dx), r2(f.gauche[1] - dz)],
            droite: [r2(f.droite[0] - dx), r2(f.droite[1] - dz)],
            hauteur_m: r2(f.hauteur_m),
            base_m: r2(Number.isFinite(f.base_m) ? f.base_m : 0),
          };
          const avant = { gauche: cible.gauche, droite: cible.droite, hauteur_m: cible.hauteur_m, base_m: Number.isFinite(cible.base_m) ? cible.base_m : 0 };
          if (egales(nouv, avant)) continue;
          // ordre des champs gardé : gauche, droite, hauteur_m restent à leur place ; base_m suit hauteur_m
          const remplace = {};
          for (const [k, v] of Object.entries(cible)) {
            if (k === 'base_m' || k === 'calage') continue;
            remplace[k] = k in nouv ? nouv[k] : v;
            if (k === 'hauteur_m' && (nouv.base_m || 'base_m' in cible)) remplace.base_m = nouv.base_m;
          }
          const ancien = cible.calage?.ancien || { gauche: avant.gauche, droite: avant.droite, hauteur_m: avant.hauteur_m, ...('base_m' in cible ? { base_m: avant.base_m } : {}) };
          remplace.calage = { date: jour, outil: 'atlas, onglet Bâtiments > Calage', ancien };
          d.facades[d.facades.indexOf(cible)] = remplace;
          f.calage = remplace.calage;
          ecrites.push(f.id);
        }
        if (!ecrites.length) app.signaler(`data/facades/${id}.json : déjà à jour.`);
        else {
          // seuls les blocs des façades calées changent ; sinon (bloc introuvable) tout le fichier est resérialisé
          let sortie = texte;
          for (const fid of ecrites) { sortie = sortie && remplacerBlocFacade(sortie, fid, d.facades.find((x) => x.id === fid)); }
          if (!sortie) sortie = serialiserFacades(d, texte);
          JSON.parse(sortie); // contrôle avant écriture
          const ou = await enregistrerDonnees(`facades/${id}.json`, sortie, { apres: `${ecrites.length} façade${ecrites.length > 1 ? 's' : ''} calée${ecrites.length > 1 ? 's' : ''} (${ecrites.join(', ')})` });
          if (ou !== 'serveur') continue; // téléchargé : reste à placer dans data/facades/, modifications gardées
        }
        for (const f of facades()) {
          if (ensembleDe(f)?.id !== id || !etat.modifiees.has(f.id)) continue;
          etat.modifiees.delete(f.id);
          etat.originaux.set(f.id, { ...valeurs(f), baseFichier: Number.isFinite(f.base_m) ? f.base_m : undefined });
          etat.piles.delete(f.id);
        }
      } catch (err) {
        console.error(err);
        app.signaler(`Enregistrement impossible : ${err.message}`);
      }
    }
    majPanneau();
  }

  // ------------------------------------------------------------
  // Aides sur la maquette : cadre de l'image, poignées gauche (rouge) et droite (bleue)
  // ------------------------------------------------------------
  const aides = new THREE.Group();
  aides.name = 'calage-facades';
  aides.userData.horsDecoupe = true; // jamais coupé par la vue maquette (js/decoupe.js)
  aides.userData.pasDeRelief = true; // posé à app.relief.dz par majAides
  aides.renderOrder = 20;
  aides.visible = false;
  app.scene.add(aides);
  const matCadre = new THREE.LineBasicMaterial({ color: 0xff8a00, depthTest: false, transparent: true });
  const matSol = new THREE.LineDashedMaterial({ color: 0xff8a00, dashSize: 0.4, gapSize: 0.25, depthTest: false, transparent: true });
  const geoPoignee = new THREE.SphereGeometry(0.45, 16, 12);
  const poignees = {
    gauche: new THREE.Mesh(geoPoignee, new THREE.MeshBasicMaterial({ color: 0xd7263d, depthTest: false, transparent: true, opacity: 0.9 })),
    droite: new THREE.Mesh(geoPoignee, new THREE.MeshBasicMaterial({ color: 0x1b6fd8, depthTest: false, transparent: true, opacity: 0.9 })),
  };
  for (const [k, m] of Object.entries(poignees)) { m.name = `calage-poignee-${k}`; m.renderOrder = 21; aides.add(m); }
  const cadre = new THREE.LineLoop(new THREE.BufferGeometry(), matCadre);
  cadre.renderOrder = 20;
  const trace = new THREE.Line(new THREE.BufferGeometry(), matSol); // segment au sol, du pied de la façade
  trace.renderOrder = 20;
  aides.add(cadre, trace);

  function majAides() {
    const f = etat.sel;
    aides.visible = !!(f && etat.actif);
    if (!aides.visible) return;
    const [gx, gz] = f.gauche, [dx, dz] = f.droite;
    const b = Number.isFinite(f.base_m) ? f.base_m : 0, H = f.hauteur_m;
    const y0 = app.relief?.dz ? app.relief.dz((gx + dx) / 2, (gz + dz) / 2) : 0;
    aides.position.set(0, y0, 0);
    cadre.geometry.dispose();
    cadre.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(gx, b, gz), new THREE.Vector3(dx, b, dz), new THREE.Vector3(dx, b + H, dz), new THREE.Vector3(gx, b + H, gz)]);
    trace.geometry.dispose();
    trace.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(gx, 0.15, gz), new THREE.Vector3(dx, 0.15, dz)]);
    trace.computeLineDistances();
    poignees.gauche.position.set(gx, 0.6, gz);
    poignees.droite.position.set(dx, 0.6, dz);
  }
  app.on('bati', majAides);
  app.on('relief', majAides);
  app.on('facades', () => { if (!etat.sel) return; majAides(); });

  // ------------------------------------------------------------
  // Choix au clic (façade la plus proche du point touché sur le bâti, sinon du point au sol) et glisser des poignées
  // ------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const souris = new THREE.Vector2();
  function viser(e) {
    const r = app.renderer.domElement.getBoundingClientRect();
    souris.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(souris, app.camera);
  }
  const distanceSegment = (p, a, b) => {
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vz);
  };
  function facadeSous(e, p) {
    let point = null;
    if (e) {
      viser(e);
      const bati = app.scene.getObjectByName('batiments');
      const hit = bati?.visible ? ray.intersectObjects(bati.children.filter((m) => m.isMesh && m.visible), false)
        .find((i) => !app.decoupe?.actif || app.decoupe.dedans(i.point)) : null;
      if (hit) point = [hit.point.x, hit.point.z];
    }
    point ||= p;
    if (!point) return null;
    let best = null, dmin = 3;
    for (const f of facades()) {
      const d = distanceSegment(point, f.gauche, f.droite);
      if (d < dmin) { dmin = d; best = f; }
    }
    return best;
  }
  function clic(p, e) {
    const f = facadeSous(e, p);
    if (f) choisir(f);
  }
  clic.sansSol = true;
  function survol(p, e) {
    if (etat.glisse) return;
    if (etat.sel && e) {
      viser(e);
      if (ray.intersectObjects(Object.values(poignees), false).length) { app.renderer.domElement.style.cursor = 'grab'; return; }
    }
    app.renderer.domElement.style.cursor = facadeSous(e, p) ? 'pointer' : 'crosshair';
  }
  const planGlisse = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  function pointeurBas(e) {
    if (!etat.actif || !etat.sel || e.button !== 0 || e.target !== app.renderer.domElement) return;
    viser(e);
    const hit = ray.intersectObjects(Object.values(poignees), false)[0];
    if (!hit) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    etat.glisse = hit.object === poignees.gauche ? 'gauche' : 'droite';
    planGlisse.constant = -hit.point.y;
    memoriser(etat.sel);
    if (app.controls) app.controls.enabled = false;
    app.renderer.domElement.style.cursor = 'grabbing';
  }
  function pointeurDeplace(e) {
    if (!etat.glisse) return;
    e.stopImmediatePropagation();
    viser(e);
    const q = new THREE.Vector3();
    if (!ray.ray.intersectPlane(planGlisse, q)) return;
    const f = etat.sel, k = etat.glisse;
    const { u, n, o } = repere(f);
    const d = [q.x - o[k][0], q.z - o[k][1]];
    modifier((v) => placerExtremite(v, f, k, cale(d[0] * u[0] + d[1] * u[1]), cale(d[0] * n[0] + d[1] * n[1])), { geste: false });
  }
  function pointeurHaut(e) {
    if (!etat.glisse) return;
    e.stopImmediatePropagation();
    etat.glisse = null;
    if (app.controls) app.controls.enabled = true;
    app.renderer.domElement.style.cursor = '';
  }
  window.addEventListener('pointerdown', pointeurBas, true);
  window.addEventListener('pointermove', pointeurDeplace, true);
  window.addEventListener('pointerup', pointeurHaut, true);

  function activer() {
    etat.actif = true;
    app.captureSol = clic;
    app.survolCapture = survol;
    if (etat.sel) T.definirOpaciteFacade(etat.sel.id, etat.opacite);
    majAides();
  }
  function desactiver() {
    if (!etat.actif) return;
    etat.actif = false;
    if (app.captureSol === clic) app.captureSol = null;
    if (app.survolCapture === survol) app.survolCapture = null;
    if (etat.sel) T.definirOpaciteFacade(etat.sel.id, null); // opacité de comparaison : seulement pendant le calage
    if (etat.glisse) { etat.glisse = null; if (app.controls) app.controls.enabled = true; }
    // focale raccourcie par la vue de face : rétablie (la caméra reste où elle est)
    if (Number.isFinite(etat.vueAvant?.fov) && app.camera?.isPerspectiveCamera && Math.abs(app.camera.fov - etat.vueAvant.fov) > 0.01) reglerFov(etat.vueAvant.fov);
    etat.vueAvant = null;
    app.renderer.domElement.style.cursor = '';
    majAides();
  }
  app.on('outil', (id) => { if (id === 'calage-facades') activer(); else desactiver(); });

  function choisir(f) {
    if (etat.sel && etat.sel !== f) T.definirOpaciteFacade(etat.sel.id, null);
    etat.sel = f || null;
    if (f) T.definirOpaciteFacade(f.id, etat.actif ? etat.opacite : null);
    if (f && T.representation?.() !== 'photos') app.signaler('Photos de façade masquées : choisissez « Détaillé avec photos » (onglet Bâtiments > Bâti) pour voir l\'aperçu.');
    majAides();
    majPanneau();
  }

  // vue frontale de la façade choisie : caméra du côté rue (normale n du repère, celle de la photo), à hauteur du milieu de
  // l'image, regard horizontal perpendiculaire à la façade, cadrage de toute l'image avec 15 % de marge. Rue trop étroite
  // (bâtiment d'en face plus proche que le recul voulu) : caméra dans la rue et focale raccourcie (rétablie par « Vue
  // précédente » ou en quittant l'outil).
  const fovVersFocale = (fov) => 12 / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
  function reglerFov(fov) {
    if (app.vues?.definirFocale) app.vues.definirFocale(fovVersFocale(fov));
    else if (app.camera?.isPerspectiveCamera) { app.camera.fov = fov; app.camera.updateProjectionMatrix(); }
  }
  function vueDeFace() {
    const f = etat.sel;
    if (!f) return;
    const vue2D = !!app.vue2D;
    // vue d'avant gardée pour « Vue précédente » (la première, si l'on enchaîne plusieurs vues de face)
    if (!etat.vueAvant && app.controls?.target && !vue2D) etat.vueAvant = { p: app.camera.position.clone(), c: app.controls.target.clone(), fov: app.camera.fov, vue2D };
    else if (!etat.vueAvant && vue2D) etat.vueAvant = { vue2D };
    if (vue2D) app.vue?.basculer?.(); // quitte aussi axo, piéton et vue de face des coupes
    else app.vues?.quitterModes?.();
    if (!app.camera?.isPerspectiveCamera) return;
    if (etat.vueAvant && !Number.isFinite(etat.vueAvant.fov)) etat.vueAvant.fov = app.camera.fov;
    const mx = (f.gauche[0] + f.droite[0]) / 2, mz = (f.gauche[1] + f.droite[1]) / 2;
    const L = Math.hypot(f.droite[0] - f.gauche[0], f.droite[1] - f.gauche[1]);
    const b = Number.isFinite(f.base_m) ? f.base_m : 0;
    const y = (app.relief?.dz?.(mx, mz) ?? 0) + b + f.hauteur_m / 2;
    const { n } = repere(f);
    const fov0 = Number.isFinite(etat.vueAvant?.fov) ? etat.vueAvant.fov : app.camera.fov;
    const aspect = app.camera.aspect || 1.5;
    const demiH = (f.hauteur_m / 2) * 1.15, demiL = (L / 2) * 1.15;
    const tan0 = Math.tan(THREE.MathUtils.degToRad(fov0) / 2);
    const d = Math.max(demiH / tan0, demiL / (tan0 * aspect), 3);
    let dh = d;
    // pas de caméra dans le bâtiment d'en face : recul limité au premier bâtiment rencontré dans l'axe de la façade
    const bati = app.scene.getObjectByName('batiments');
    if (bati) {
      const r = new THREE.Raycaster(new THREE.Vector3(mx + n[0] * 0.8, y, mz + n[1] * 0.8), new THREE.Vector3(n[0], 0, n[1]), 0, d);
      const hit = r.intersectObjects(bati.children.filter((m) => m.isMesh && m.visible), false)[0];
      if (hit) dh = Math.min(d, Math.max(hit.distance + 0.8 - 1, 3));
    }
    // focale raccourcie si le recul manque (champ vertical plafonné à 100°)
    const tan1 = Math.max(demiH / dh, demiL / (dh * aspect));
    const fov = dh < d ? Math.min(100, THREE.MathUtils.radToDeg(2 * Math.atan(tan1))) : fov0;
    if (Math.abs(fov - app.camera.fov) > 0.01) reglerFov(fov);
    allerVers(app, [mx + n[0] * dh, y, mz + n[1] * dh], [mx, y, mz], 1200);
    majPanneau();
  }
  function vuePrecedente() {
    const v = etat.vueAvant;
    if (!v) return;
    etat.vueAvant = null;
    majPanneau();
    if (Number.isFinite(v.fov) && app.camera?.isPerspectiveCamera && Math.abs(app.camera.fov - v.fov) > 0.01) reglerFov(v.fov);
    if (v.vue2D) { if (!app.vue2D) app.vue?.basculer?.(); return; }
    if (app.vue2D) app.vue?.basculer?.();
    return allerVers(app, v.p.toArray(), v.c.toArray(), 1200);
  }

  // ------------------------------------------------------------
  // Panneau
  // ------------------------------------------------------------
  const STYLE_LIGNE = { display: 'grid', gridTemplateColumns: '7.5em 1fr auto auto 4.2em', gap: '4px', alignItems: 'center', fontSize: '13px', margin: '3px 0' };
  const bouton = (texte, titre, fn) => h('button', { type: 'button', class: 'bouton discret petit', title: titre, 'aria-label': titre, onclick: fn }, texte);
  // ligne de réglage : libellé, curseur, − / +, valeur ; lire() → valeur courante, ecrire(v, valeurs, f) l'applique
  function ligneReglage({ libelle, min, max, lire, ecrire, texte }) {
    const curseur = h('input', { type: 'range', min, max, step: PAS, 'aria-label': libelle });
    const sortie = h('output', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' } });
    let debut = true;
    curseur.addEventListener('input', () => { modifier((v, f) => ecrire(cale(+curseur.value), v, f), { geste: debut }); debut = false; });
    curseur.addEventListener('change', () => { debut = true; });
    const pas = (s) => modifier((v, f) => ecrire(cale(lire() + s * PAS), v, f));
    const ligne = h('div', { style: STYLE_LIGNE }, h('span', {}, libelle), curseur, bouton('−', `${libelle} : −5 cm`, () => pas(-1)), bouton('+', `${libelle} : +5 cm`, () => pas(1)), sortie);
    ligne.maj = () => {
      const x = lire();
      if (x < +curseur.min) curseur.min = Math.floor(x); if (x > +curseur.max) curseur.max = Math.ceil(x);
      if (document.activeElement !== curseur || !etat.sel) curseur.value = x;
      sortie.textContent = texte(x);
    };
    return ligne;
  }

  // Redressement Panoramax (js/redressement-facades.js, chargé à la demande) : recherche de photos, 4 coins, homographie
  async function redressement() {
    try {
      const m = await import('./redressement-facades.js');
      return (app.redressementFacades ||= m.creerRedressementFacades(app, api));
    } catch (err) { console.error(err); app.signaler(`Outil de redressement indisponible : ${err.message}`); return null; }
  }
  async function ouvrirRedressement() { if (etat.sel) (await redressement())?.ouvrir(etat.sel); }
  async function ajouterFacade() { (await redressement())?.ajouterFacade(); }
  // Assistant d'îlot (js/assistant-ilot.js, chargé à la demande) : photos Panoramax de toutes les façades d'un ensemble
  async function ouvrirAssistant() {
    try {
      const m = await import('./assistant-ilot.js');
      (app.assistantIlot ||= m.creerAssistantIlot(app, api)).ouvrir(etat.sel ? ensembleDe(etat.sel)?.id : null);
    } catch (err) { console.error(err); app.signaler(`Assistant d'îlot indisponible : ${err.message}`); }
  }
  // panneau reconstruit (façade ajoutée par le redressement)
  function rafraichirPanneau() {
    if (!ui.conteneur?.isConnected) return;
    ui.conteneur.replaceChildren();
    construirePanneau(ui.conteneur);
  }

  function construirePanneau(conteneur) {
    ui.conteneur = conteneur;
    const liste = facades();
    ui.ajout = h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'bouton discret', onclick: ajouterFacade, title: 'Cliquer un mur d\'un ensemble détaillé, puis chercher une photo Panoramax et la redresser' }, 'Ajouter une façade'),
      h('button', { type: 'button', class: 'bouton discret', onclick: ouvrirAssistant, title: 'Toutes les façades d\'un ensemble : meilleure photo Panoramax, placement automatique, niveaux du bâtiment, validation' }, 'Assistant d\'îlot'));
    if (!liste.length) {
      conteneur.append(h('p', { class: 'note', 'data-garder': '' }, 'Aucune photo de façade chargée (data/facades/*.json). Représentation « Simple » ? Choisissez « Détaillé avec photos » dans Bâtiments > Bâti.'), (T?.ensembles || []).length ? ui.ajout : '');
      return;
    }
    ui.choix = h('select', { 'aria-label': 'Façade à caler', style: { width: '100%', maxWidth: '100%' }, onchange: () => choisir(liste.find((f) => f.id === ui.choix.value) || null) },
      h('option', { value: '' }, '— Choisir une façade (ou cliquer sur la maquette) —'),
      ...(T.ensembles || []).filter((e) => e.facades?.facades?.length).map((e) => h('optgroup', { label: e.id === 'hotel-de-ville' ? 'Hôtel de Ville' : e.donnees.titre || e.id },
        ...e.facades.facades.map((f) => h('option', { value: f.id }, f.nom.split(',')[0])))));
    ui.fiche = h('p', { class: 'resultat' });
    const extremite = (k, nom) => [
      ligneReglage({ libelle: `${nom} : le long`, min: -3, max: 3, lire: () => ecartExtremite(etat.sel, k).a, ecrire: (a, v, f) => placerExtremite(v, f, k, a, ecartExtremite(f, k).p), texte: cm }),
      ligneReglage({ libelle: `${nom} : vers la rue`, min: -2, max: 2, lire: () => ecartExtremite(etat.sel, k).p, ecrire: (p, v, f) => placerExtremite(v, f, k, ecartExtremite(f, k).a, p), texte: cm }),
    ];
    ui.lignes = [
      ...extremite('gauche', 'Gauche'),
      ...extremite('droite', 'Droite'),
      ligneReglage({ libelle: 'Hauteur', min: 2, max: 40, lire: () => etat.sel.hauteur_m, ecrire: (x, v) => { v.hauteur_m = Math.max(0.5, x); }, texte: m2 }),
      ligneReglage({ libelle: 'Base', min: -3, max: 3, lire: () => (Number.isFinite(etat.sel.base_m) ? etat.sel.base_m : 0), ecrire: (x, v) => { v.base_m = x; }, texte: m2 }),
    ];
    // façade entière : les deux extrémités ensemble
    const toute = (da, dp) => modifier((v, f) => {
      for (const k of ['gauche', 'droite']) { const e = ecartExtremite(f, k); placerExtremite(v, f, k, cale(e.a + da * PAS), cale(e.p + dp * PAS)); }
    });
    ui.opacite = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: etat.opacite, 'aria-label': 'Opacité de la photo',
      oninput: () => { etat.opacite = +ui.opacite.value; if (etat.sel) T.definirOpaciteFacade(etat.sel.id, etat.opacite); } });
    ui.annuler = h('button', { type: 'button', class: 'bouton discret', onclick: annuler }, 'Annuler');
    ui.original = h('button', { type: 'button', class: 'bouton discret', onclick: retablirOriginal }, 'Rétablir l\'original');
    ui.avantCalage = h('button', { type: 'button', class: 'bouton discret', onclick: revenirAvantCalage, title: 'Valeurs d\'avant le premier calage enregistré (champ calage.ancien du fichier)' }, 'Avant calage');
    ui.enregistrer = h('button', { type: 'button', class: 'bouton', onclick: enregistrer }, 'Enregistrer');
    ui.modifiees = h('p', { class: 'note', role: 'status' });
    ui.reglages = h('div', {},
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret', onclick: vueDeFace, title: 'Caméra devant la façade, côté rue, perpendiculaire' }, 'Vue de face'),
        ui.precedente = h('button', { type: 'button', class: 'bouton discret', onclick: vuePrecedente, title: 'Revenir à la vue d\'avant la vue de face' }, 'Vue précédente'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { ui.choix.value = ''; choisir(null); } }, 'Désélectionner')),
      h('h3', {}, 'Extrémités (pas de 5 cm)'),
      h('p', { class: 'note', 'data-garder': '' }, 'Gauche et droite vues depuis la rue ; poignées rouge (gauche) et bleue (droite) à glisser sur la maquette.'),
      ...ui.lignes.slice(0, 4),
      h('div', { style: { ...STYLE_LIGNE, gridTemplateColumns: '7.5em repeat(4, auto)' } }, h('span', {}, 'Façade entière'),
        bouton('◀', 'Façade entière : 5 cm vers la gauche', () => toute(-1, 0)), bouton('▶', 'Façade entière : 5 cm vers la droite', () => toute(1, 0)),
        bouton('▲', 'Façade entière : 5 cm vers la rue', () => toute(0, 1)), bouton('▼', 'Façade entière : 5 cm vers le bâtiment', () => toute(0, -1))),
      h('h3', {}, 'Hauteur de l\'image'),
      ...ui.lignes.slice(4),
      h('div', { style: { ...STYLE_LIGNE, gridTemplateColumns: '7.5em 1fr' } }, h('span', {}, 'Opacité photo'), ui.opacite),
      h('div', { class: 'actions' }, ui.annuler, ui.original, ui.avantCalage, ui.enregistrer),
      h('h3', {}, 'Photo'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: ouvrirRedressement,
        title: 'Photos Panoramax proches de la façade (licences ouvertes), puis redressement sur 4 coins : remplace l\'image après aperçu et confirmation' }, 'Chercher une photo Panoramax / Redresser')),
    );
    conteneur.append(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Façade'),
        info('Les photos de façade sont redressées sur quatre coins repérés à l\'œil (±0,5 m, ±1 m en vue oblique) puis plaquées sur un segment (extrémités gauche et droite) à hauteur unique : réglez-les ici en comparant au mur (curseur Opacité).',
          'Base : hauteur du bas de l\'image au-dessus du sol (0 = au sol ; négatif : bas de l\'image sous le sol, coupé).',
          'Enregistrer : réécrit gauche, droite, hauteur_m et base_m dans data/facades/<ensemble>.json, dans le repère de son champ « origine », avec la trace calage { date, ancien } (valeurs d\'avant le premier calage). serveur.py garde l\'ancienne version dans data/.sauvegardes/ ; sans serveur, le fichier est téléchargé.',
          'Annuler : dernier geste. Rétablir l\'original : valeurs à l\'ouverture de l\'atlas (ou au dernier enregistrement). Avant calage : valeurs d\'avant le premier calage enregistré.')),
      ui.choix, ui.fiche, ui.reglages, ui.modifiees, ui.ajout,
    );
    if (etat.sel) ui.choix.value = etat.sel.id;
    majPanneau();
  }

  function majPanneau() {
    if (!ui.choix?.isConnected) return;
    const f = etat.sel;
    ui.reglages.hidden = !f;
    if (ui.choix.value !== (f?.id || '')) ui.choix.value = f?.id || '';
    if (!f) {
      ui.fiche.textContent = 'Choisissez une façade dans la liste ou cliquez-la sur la maquette.';
    } else {
      const e = ensembleDe(f);
      const L = Math.hypot(f.droite[0] - f.gauche[0], f.droite[1] - f.gauche[1]);
      ui.fiche.replaceChildren(h('strong', {}, f.nom), h('br'),
        h('span', { class: 'discret' }, `data/facades/${e?.id}.json · ${f.image} · ${m2(L)} × ${m2(f.hauteur_m)} · confiance ${f.confiance || '—'}${f.calage ? ` · calée le ${f.calage.date.split('-').reverse().join('/')}` : ''}`));
      for (const l of ui.lignes) l.maj();
      ui.annuler.disabled = !etat.piles.get(f.id)?.length;
      ui.original.disabled = !etat.originaux.has(f.id) || egales(valeurs(f), etat.originaux.get(f.id));
      ui.avantCalage.hidden = !f.calage?.ancien;
    }
    ui.precedente.hidden = !etat.vueAvant;
    const n = etat.modifiees.size;
    ui.enregistrer.textContent = `Enregistrer${n ? ` (${n}) *` : ''}`;
    ui.enregistrer.disabled = !n;
    ui.modifiees.textContent = n ? `Non enregistré : ${[...etat.modifiees].join(', ')}.` : '';
  }

  const api = { construirePanneau, choisir, enregistrer, annuler, retablirOriginal, modifier, vueDeFace, vuePrecedente, repere, etat, facadeSous, serialiserFacades, aides,
    rafraichirPanneau, ouvrirRedressement, ajouterFacade, ouvrirAssistant };
  return api;
}
