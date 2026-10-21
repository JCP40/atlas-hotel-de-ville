import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { h, info } from './util.js';
import { enregistrerDonnees } from './donnees.js';
import { visibiliteBatiment } from './maquette.js';

// Fichiers 3D importés dans le projet (onglet Bâtiments > Projet) : GLB / glTF (recommandé) et OBJ (+ MTL facultatif),
// lus par les chargeurs de Three.js copiés dans lib/three/addons/loaders (même version que lib/three, r180).
// - Placement au clic sur le sol, rotation (°), unité du fichier et échelle, hauteur au-dessus du sol (m).
// - Le fichier est rangé dans data/imports/ (serveur local) et projet.json n'en garde que la référence :
//   imports: [{ n, nom, fichiers: ['imports/x.glb'] | ['imports/x.obj', 'imports/x.mtl'], lat, lon, rot, unite, echelle, hauteur, vis }].
// - Bâti effectif (soleil, vent, coupes, confort) : le volume ne compte que par son emprise (enveloppe convexe
//   extrudée jusqu'au point le plus haut) s'il est « simple » (ses faces vues de dessus couvrent au moins 85 % de
//   l'enveloppe) ; sinon il est affiché et exporté, mais ignoré par le vent et les coupes (le panneau le dit).

const UNITES = [[1, 'mètres'], [0.01, 'centimètres'], [0.001, 'millimètres'], [0.3048, 'pieds']];
const SEUIL_SIMPLE = 0.85;

export function creerImports(app) {
  const groupe = new THREE.Group();
  groupe.name = 'imports';
  groupe.userData.pasDeRelief = true;
  app.scene.add(groupe);
  const liste = []; // { n, nom, fichiers, lat, lon, x, z, rot, unite, echelle, hauteur, vis, objet, brut, emprise, simple, erreur }
  let suivant = 1;
  let sel = -1;
  const ui = {};

  // ---------------------------------------------------------------
  // Lecture d'un modèle (fichiers locaux choisis, ou fichiers de data/imports/)
  // ---------------------------------------------------------------
  async function charger(fichiers, urls) {
    // urls : Map nom de fichier -> adresse (objet local ou data/imports/…)
    const manager = new THREE.LoadingManager();
    manager.setURLModifier((u) => { const nom = decodeURIComponent(u.split('/').pop().split('?')[0]); return urls.get(nom) || u; });
    const principal = fichiers.find((f) => /\.(glb|gltf)$/i.test(f)) || fichiers.find((f) => /\.obj$/i.test(f));
    if (!principal) throw new Error('fichier GLB, glTF ou OBJ attendu');
    if (/\.(glb|gltf)$/i.test(principal)) {
      const g = await new GLTFLoader(manager).loadAsync(urls.get(principal) || principal);
      return g.scene;
    }
    const obj = new OBJLoader(manager);
    const mtl = fichiers.find((f) => /\.mtl$/i.test(f));
    if (mtl) {
      const mats = await new MTLLoader(manager).loadAsync(urls.get(mtl) || mtl);
      mats.preload();
      obj.setMaterials(mats);
    }
    return garderMaillages(await obj.loadAsync(urls.get(principal) || principal));
  }
  // OBJ sans faces (courbes ou surfaces NURBS exportées telles quelles par Rhino : lignes « vp », « curv », « surf ») :
  // OBJLoader n'en tire que des points aux coordonnées NaN. On ne garde que les maillages ; s'il n'y en a aucun, erreur claire.
  function garderMaillages(o) {
    const autres = [];
    o.traverse((x) => { if ((x.isPoints || x.isLine) && !x.isMesh) autres.push(x); });
    for (const x of autres) { x.removeFromParent(); x.geometry?.dispose(); }
    let n = 0;
    o.traverse((x) => { if (x.isMesh) n++; });
    if (!n) throw new Error('OBJ sans faces (surfaces NURBS ?) : dans Rhino, exporter en maillage (polygones)');
    return o;
  }

  // ---------------------------------------------------------------
  // Placement, emprise et « simplicité »
  // ---------------------------------------------------------------
  function placer(it) {
    if (!it.objet) return;
    const o = it.objet;
    o.rotation.set(0, THREE.MathUtils.degToRad(it.rot), 0);
    const k = it.unite * it.echelle;
    o.scale.setScalar(k);
    o.position.set(0, 0, 0);
    o.updateMatrixWorld(true);
    const bb = new THREE.Box3().setFromObject(o);
    // posé au sol (point le plus bas à 0) puis relevé de « hauteur », centré sur le point choisi
    const c = bb.getCenter(new THREE.Vector3());
    const dz = app.relief?.actif ? app.relief.dz(it.x, it.z) : 0;
    o.position.set(it.x - c.x, -bb.min.y + it.hauteur + dz, it.z - c.z);
    o.visible = it.vis && app.projet?.visible !== false && visibiliteBatiment(app, cle(it));
    o.updateMatrixWorld(true);
    calculerEmprise(it);
  }
  const cle = (it) => `P${Math.hypot(it.x, it.z) <= app.config.rayonPlateau ? 'I' : 'E'}`;

  function calculerEmprise(it) {
    const pts = [];
    const tris = [];
    let haut = -Infinity, bas = Infinity;
    const v = new THREE.Vector3();
    it.objet.traverse((m) => {
      if (!m.isMesh || !m.geometry?.getAttribute('position')) return;
      const p = m.geometry.getAttribute('position');
      const idx = m.geometry.index;
      const debut = pts.length;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld);
        pts.push([v.x, v.z]);
        haut = Math.max(haut, v.y); bas = Math.min(bas, v.y);
      }
      const n = idx ? idx.count : p.count;
      for (let i = 0; i + 2 < n; i += 3) tris.push(debut + (idx ? idx.getX(i) : i), debut + (idx ? idx.getX(i + 1) : i + 1), debut + (idx ? idx.getX(i + 2) : i + 2));
    });
    if (pts.length < 3) { it.emprise = null; it.simple = false; return; }
    const env = enveloppe(pts);
    it.emprise = env;
    it.hauteurMax = haut;
    it.base = bas;
    it.triangles = tris.length / 3;
    // couverture : faces projetées au sol, rastérisées sur une grille (0,5 m au moins) dans l'enveloppe
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const [x, z] of env) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
    const pas = Math.max(0.5, Math.sqrt(((x1 - x0) * (z1 - z0)) / 40000));
    const nx = Math.ceil((x1 - x0) / pas) + 1, nz = Math.ceil((z1 - z0) / pas) + 1;
    const c = document.createElement('canvas');
    c.width = nx; c.height = nz;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#f00';
    // un remplissage par triangle : les faces du dessus et du dessous, de sens opposés, ne s'annulent pas
    for (let t = 0; t < tris.length; t += 3) {
      const [a, b, d] = [pts[tris[t]], pts[tris[t + 1]], pts[tris[t + 2]]];
      ctx.beginPath();
      ctx.moveTo((a[0] - x0) / pas, (a[1] - z0) / pas); ctx.lineTo((b[0] - x0) / pas, (b[1] - z0) / pas); ctx.lineTo((d[0] - x0) / pas, (d[1] - z0) / pas); ctx.closePath();
      ctx.fill();
    }
    const pleins = ctx.getImageData(0, 0, nx, nz).data;
    ctx.clearRect(0, 0, nx, nz);
    ctx.beginPath();
    env.forEach(([x, z], i) => (i ? ctx.lineTo((x - x0) / pas, (z - z0) / pas) : ctx.moveTo((x - x0) / pas, (z - z0) / pas)));
    ctx.closePath(); ctx.fill();
    const enveloppeP = ctx.getImageData(0, 0, nx, nz).data;
    let nEnv = 0, nPlein = 0;
    for (let i = 0; i < nx * nz; i++) if (enveloppeP[i * 4 + 3] > 127) { nEnv++; if (pleins[i * 4 + 3] > 127) nPlein++; }
    it.couverture = nEnv ? nPlein / nEnv : 0;
    it.simple = it.couverture >= SEUIL_SIMPLE && haut - bas > 0.5;
  }

  // enveloppe convexe (chaîne monotone), [x, z]
  function enveloppe(pts) {
    const p = pts.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const bas = [], haut = [];
    for (const q of p) { while (bas.length >= 2 && cross(bas[bas.length - 2], bas[bas.length - 1], q) <= 0) bas.pop(); bas.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (haut.length >= 2 && cross(haut[haut.length - 2], haut[haut.length - 1], q) <= 0) haut.pop(); haut.push(q); }
    return bas.slice(0, -1).concat(haut.slice(0, -1));
  }

  // ---------------------------------------------------------------
  // Bâti effectif (appelé par projet.batiEffectif) et export
  // ---------------------------------------------------------------
  function empreintes() {
    return liste.filter((it) => it.vis && it.objet && it.simple && it.emprise).map((it) => {
      const dz = app.relief?.actif ? app.relief.dz(it.x, it.z) : 0;
      return {
        polys: [[it.emprise]], hauteur: Math.max(it.hauteurMax - dz, 0.5), base: Math.max(it.base - dz, 0), cle: cle(it), rem: false,
        id: `import-${it.n}`, nom: `Import ${it.nom}`, cx: it.x, cz: it.z, mesh: null, debut: 0, nb: 0, projet: true, importe: true,
      };
    });
  }
  // objets à exporter (copies posées à plat, matériaux et textures conservés)
  function objetsExport(dedans) {
    const res = [];
    for (const it of liste) {
      if (!it.vis || !it.objet || !dedans(it.x, it.z)) continue;
      const copie = it.objet.clone(true);
      const dz = app.relief?.actif ? app.relief.dz(it.x, it.z) : 0;
      copie.position.y -= dz;
      copie.visible = true;
      copie.name = `Import ${it.nom}`;
      res.push(copie);
    }
    return res;
  }

  // ---------------------------------------------------------------
  // Ajout depuis le panneau, relecture depuis projet.json
  // ---------------------------------------------------------------
  function ajouterObjet(it, objet) {
    it.objet = objet;
    objet.name = `import-${it.n}`;
    objet.userData.pasDeRelief = true;
    objet.traverse((m) => {
      if (!m.isMesh) return;
      m.castShadow = true; m.receiveShadow = true;
      m.userData.pasDeRelief = true;
      m.userData.nom = `Import : ${it.nom}`;
    });
    groupe.add(objet);
    placer(it);
  }

  async function importer(fichiersChoisis) {
    const fichiers = [...fichiersChoisis];
    const principal = fichiers.find((f) => /\.(glb|gltf|obj)$/i.test(f.name));
    if (!principal) { app.signaler('Choisir un fichier .glb, .gltf ou .obj (avec, au besoin, son .mtl, son .bin et ses textures).'); return; }
    const urls = new Map(fichiers.map((f) => [f.name, URL.createObjectURL(f)]));
    note(`Lecture de ${principal.name}…`);
    let objet;
    try { objet = await charger(fichiers.map((f) => f.name), urls); } catch (e) { note(`Lecture impossible : ${e.message || e}`); return; }
    const c = app.controls.target;
    const g = app.proj.versGeo(c.x, c.z);
    const it = {
      n: suivant++, nom: principal.name.replace(/\.[^.]+$/, ''), fichiers: fichiers.map((f) => `imports/${f.name}`),
      lat: g.lat, lon: g.lon, x: c.x, z: c.z, rot: 0, unite: 1, echelle: 1, hauteur: 0, vis: true,
    };
    liste.push(it);
    ajouterObjet(it, objet);
    sel = liste.length - 1;
    majListe(); chargerFormulaire();
    changement();
    // copie du fichier dans data/imports/ (serveur local) ; sinon téléchargé, à placer dans data/imports/
    for (const f of fichiers) await enregistrerDonnees(`imports/${f.name}`, f, { apres: 'référencé par projet.json' });
    note(`${principal.name} importé au centre de la vue : « Placer au clic » pour le poser ailleurs. ${texteSimple(it)}`);
  }

  async function lire(entrees) {
    vider(false);
    for (const x of entrees || []) {
      if (!x || !Array.isArray(x.fichiers) || !Number.isFinite(x.lat) || !Number.isFinite(x.lon)) continue;
      const p = app.proj.versLocal(x.lat, x.lon);
      const it = {
        n: x.n || suivant, nom: String(x.nom || x.fichiers[0]), fichiers: x.fichiers.map(String), lat: x.lat, lon: x.lon, x: p.x, z: p.z,
        rot: +x.rot || 0, unite: +x.unite || 1, echelle: +x.echelle || 1, hauteur: +x.hauteur || 0, vis: x.vis !== false,
      };
      suivant = Math.max(suivant, it.n + 1);
      liste.push(it);
      const urls = new Map(it.fichiers.map((f) => [f.split('/').pop(), `data/${f}`]));
      try { ajouterObjet(it, await charger(it.fichiers.map((f) => f.split('/').pop()), urls)); } catch (e) {
        it.erreur = /OBJ sans faces/.test(e?.message) ? e.message : `fichier introuvable ou illisible (data/${it.fichiers[0]})`;
        console.warn(`Import 3D : ${it.erreur}`, e);
      }
    }
    majListe();
    if (liste.length) changement();
  }

  function serialiser() {
    // toujours un tableau (vide compris) : projet.js ne reprend alors pas l'ancienne liste lue au démarrage
    return liste.map((it) => ({
      n: it.n, nom: it.nom, fichiers: it.fichiers, lat: +it.lat.toFixed(7), lon: +it.lon.toFixed(7),
      rot: it.rot, unite: it.unite, echelle: it.echelle, hauteur: it.hauteur, vis: it.vis,
    }));
  }

  function liberer(it) {
    if (!it.objet) return;
    groupe.remove(it.objet);
    it.objet.traverse((m) => {
      m.geometry?.dispose();
      for (const mat of [].concat(m.material || [])) { for (const k of Object.keys(mat)) if (mat[k]?.isTexture) mat[k].dispose(); mat.dispose(); }
    });
  }
  function vider(signal = true) {
    liste.splice(0).forEach(liberer);
    sel = -1;
    majListe();
    if (signal) changement();
  }
  function supprimer(i) {
    liberer(liste[i]);
    liste.splice(i, 1);
    if (sel >= liste.length) sel = liste.length - 1;
    majListe(); chargerFormulaire();
    changement();
  }

  const changement = () => app.emettre('bati');
  const texteSimple = (it) => (!it.objet ? '' : it.simple
    ? `Volume simple : compté dans le soleil, le vent et les coupes par son emprise (${Math.round(it.couverture * 100)} % de l'enveloppe couverte).`
    : `Volume complexe (${Math.round((it.couverture || 0) * 100)} % de l'enveloppe couverte) : affiché, exporté et pris en compte par les ombres de la maquette, mais ignoré par le vent, les coupes et les calculs de soleil et de confort.`);

  // ---------------------------------------------------------------
  // Placement au clic
  // ---------------------------------------------------------------
  function clic(p) {
    const it = liste[sel];
    if (!p || !it) return;
    const g = app.proj.versGeo(p[0], p[1]);
    Object.assign(it, { x: p[0], z: p[1], lat: g.lat, lon: g.lon });
    placer(it);
    arreter();
    changement();
  }
  function arreter() {
    if (app.captureSol === clic) app.captureSol = null;
    ui.placer?.setAttribute('aria-pressed', 'false');
  }

  // ---------------------------------------------------------------
  // Panneau (bloc inséré par projet.js dans l'outil Projet)
  // ---------------------------------------------------------------
  const note = (t) => { if (ui.note?.isConnected) ui.note.textContent = t; };
  function chargerFormulaire() {
    const it = liste[sel];
    if (!ui.rot?.isConnected) return;
    ui.reglages.hidden = !it;
    if (!it) return;
    ui.rot.value = it.rot; ui.unite.value = it.unite; ui.echelle.value = it.echelle; ui.hauteur.value = it.hauteur;
    ui.etat.textContent = it.erreur ? `${it.nom} : ${it.erreur}.` : texteSimple(it);
  }
  function editer() {
    const it = liste[sel];
    if (!it) return;
    const num = (el, d) => { const v = parseFloat(String(el.value).replace(',', '.')); return Number.isFinite(v) ? v : d; };
    it.rot = num(ui.rot, 0); it.unite = num(ui.unite, 1); it.echelle = Math.max(0.001, num(ui.echelle, 1)); it.hauteur = num(ui.hauteur, 0);
    placer(it);
    ui.etat.textContent = texteSimple(it);
    clearTimeout(editer.t); editer.t = setTimeout(changement, 300);
  }
  function majListe() {
    if (!ui.liste?.isConnected) return;
    ui.liste.replaceChildren(...(liste.length ? liste.map((it, i) => h('li', { class: i === sel ? 'choisi' : '' },
      h('input', { type: 'checkbox', checked: it.vis, 'aria-label': `Afficher ${it.nom}`, onchange: (e) => { it.vis = e.target.checked; placer(it); changement(); } }),
      h('button', { type: 'button', class: 'choisir', 'aria-pressed': String(i === sel), onclick: () => { sel = sel === i ? -1 : i; majListe(); chargerFormulaire(); } },
        `${it.nom}${it.erreur ? ' (absent)' : it.simple ? '' : ' (complexe)'}`),
      h('button', { type: 'button', class: 'bouton discret petit', 'aria-label': `Supprimer ${it.nom}`, title: 'Supprimer', onclick: () => supprimer(i) }, '×'),
    )) : [h('li', { class: 'vide' }, 'Aucun fichier importé.')]));
  }
  function construireBloc(conteneur) {
    if (!conteneur) return;
    const champ = (libelle, el) => h('label', { class: 'champ-projet' }, h('span', {}, libelle), el);
    const fichier = h('input', { type: 'file', multiple: true, accept: '.glb,.gltf,.bin,.obj,.mtl,.jpg,.jpeg,.png', hidden: true, onchange: (e) => { importer(e.target.files); e.target.value = ''; } });
    ui.note = h('p', { class: 'note', 'aria-live': 'polite' });
    ui.etat = h('p', { class: 'note', role: 'status' });
    ui.liste = h('ul', { class: 'liste-projet liste-formes' });
    ui.rot = h('input', { type: 'number', step: 5, value: 0, oninput: editer });
    ui.unite = h('select', { onchange: editer }, ...UNITES.map(([v, l]) => h('option', { value: v }, l)));
    ui.echelle = h('input', { type: 'number', step: 0.1, min: 0.001, value: 1, inputmode: 'decimal', oninput: editer });
    ui.hauteur = h('input', { type: 'number', step: 0.5, value: 0, inputmode: 'decimal', oninput: editer });
    ui.placer = h('button', { type: 'button', class: 'bouton', 'aria-pressed': 'false', onclick: () => {
      if (!liste[sel]) return;
      if (app.captureSol === clic) { arreter(); return; }
      app.captureSol = clic; ui.placer.setAttribute('aria-pressed', 'true'); note('Cliquez le sol pour poser le modèle choisi.');
    } }, 'Placer au clic');
    ui.reglages = h('div', { hidden: true },
      h('div', { class: 'formulaire-projet' }, champ('Rotation (°)', ui.rot), champ('Unité du fichier', ui.unite), champ('Échelle', ui.echelle), champ('Hauteur au sol (m)', ui.hauteur)),
      h('div', { class: 'actions' }, ui.placer),
      ui.etat);
    conteneur.replaceChildren(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Importer un fichier 3D'),
        info('GLB ou glTF (recommandé : un seul fichier, textures comprises) ou OBJ, avec son fichier MTL et ses textures choisis en même temps (facultatif). Unité : le mètre, y vers le haut (glTF) ; pour un OBJ en centimètres ou en millimètres, choisir l\'unité.',
          'Le modèle est posé au centre de la vue, sur le sol, puis se place au clic ; rotation, échelle et hauteur au sol se règlent. Le fichier est copié dans data/imports/ (serveur local ; sinon téléchargé, à y déposer) et projet.json garde sa référence : « Enregistrer projet.json » pour le retrouver à l\'ouverture.',
          `Un modèle « simple » (vu de dessus, ses faces couvrent au moins ${Math.round(SEUIL_SIMPLE * 100)} % de son enveloppe) compte dans le bâti effectif par son emprise extrudée (soleil, confort, vent, coupes) ; un modèle complexe est affiché et exporté, mais ignoré par le vent et les coupes.`)),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: () => fichier.click() }, 'Importer GLB / glTF / OBJ…'), fichier),
      ui.note,
      ui.liste,
      ui.reglages,
    );
    majListe();
    chargerFormulaire();
  }

  // visibilité : calque Projet, époque, relief
  app.on('bati', () => liste.forEach((it) => { if (it.objet) it.objet.visible = it.vis && app.projet?.visible !== false && visibiliteBatiment(app, cle(it)); }));
  app.on('etat', () => liste.forEach((it) => { if (it.objet) it.objet.visible = it.vis && app.projet?.visible !== false && visibiliteBatiment(app, cle(it)); }));
  app.on('relief', () => liste.forEach(placer));
  app.on('outil', (id) => { if (id !== 'projet') arreter(); });

  return {
    groupe, lire, serialiser, empreintes, objetsExport, construireBloc, importer, vider,
    nombre: () => liste.length, get liste() { return liste; },
  };
}
