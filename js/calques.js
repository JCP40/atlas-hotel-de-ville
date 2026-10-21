import * as THREE from 'three';
import { h, estNonPublie, NON_PUBLIE } from './util.js';
import { affineDepuis3Points, appliquerAffine, empriseAutour } from './geo.js';
import { chargerJSON, fichierExiste, enregistrerDonnees, assemblerFond } from './donnees.js';
import { lireCache, ecrireCache } from './cache.js';

// Images posées au sol :
// - fonds IGN (photos aériennes, cartes anciennes), chargés en direct puis gardés en cache,
//   ou lus dans data/ign/ quand ils ont été préparés pour la borne ;
// - calques de l'étudiant (plans anciens, plans du PSMV, dessins), calés par 3 points.
export function creerCalques(app) {
  const groupe = new THREE.Group();
  groupe.name = 'calques';
  app.scene.add(groupe);
  const fonds = app.config.fonds || [];
  const textures = new Map();
  const plans = { principal: null, comparaison: null };
  const rideau = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  const etat = { principal: null, comparaison: null, rideauX: 0 };
  const calques = [];
  const ui = {};

  // ------------------------------------------------------------
  // Fonds
  // ------------------------------------------------------------
  async function textureDepuisBlob(blob) {
    const url = URL.createObjectURL(blob);
    const t = await new THREE.TextureLoader().loadAsync(url);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = app.renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  function obtenirFond(id) {
    if (textures.has(id)) return textures.get(id);
    const fond = fonds.find((f) => f.id === id);
    const promesse = (async () => {
      // 1. fichiers préparés (borne hors ligne)
      for (const nom of [`fond-${id}`, ...(fond.anciensFichiers || [])]) {
        const bornes = await chargerJSON(`data/ign/${nom}.json`, null);
        if (bornes && await fichierExiste(`data/ign/${nom}.jpg`)) {
          const t = await new THREE.TextureLoader().loadAsync(`data/ign/${nom}.jpg`);
          t.colorSpace = THREE.SRGBColorSpace;
          return { texture: t, bornes, source: 'fichier' };
        }
      }
      // 2. cache du navigateur (sauf fonds dont les conditions l'interdisent, comme Google)
      const cache = fond.pasDeCache ? null : await lireCache(`fond-${id}-${app.cleZone}`, 365);
      if (cache?.blob) return { texture: await textureDepuisBlob(cache.blob), bornes: cache.bornes, source: 'cache', blob: cache.blob };
      // 3. en direct
      if (!navigator.onLine || app.mode === 'borne') throw new Error('ce fond n\'a pas été préparé et l\'atlas est hors ligne');
      const e = empriseAutour(app.config.origine.lat, app.config.origine.lon, app.config.rayonEtude * 1.2);
      const { canvas, bornes } = await assemblerFond(e, fond, (t) => { if (ui.etat) ui.etat.textContent = t; });
      const blob = await new Promise((ok, ko) => {
        try { canvas.toBlob((b) => (b ? ok(b) : ko(new Error('image vide'))), 'image/jpeg', 0.85); } catch (err) { ko(new Error(`image non réutilisable dans le navigateur (${err.message})`)); }
      });
      if (fond.pasDeCache) return { texture: await textureDepuisBlob(blob), bornes, source: 'direct' };
      await ecrireCache(`fond-${id}-${app.cleZone}`, { blob, bornes });
      return { texture: await textureDepuisBlob(blob), bornes, source: 'direct', blob };
    })();
    textures.set(id, promesse);
    promesse.catch(() => textures.delete(id));
    return promesse;
  }

  function planPour(res, y) {
    const no = app.proj.versLocal(res.bornes.nord, res.bornes.ouest);
    const se = app.proj.versLocal(res.bornes.sud, res.bornes.est);
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(se.x - no.x, se.z - no.z).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ map: res.texture, roughness: 1, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 })
    );
    m.position.set((no.x + se.x) / 2, y, (no.z + se.z) / 2);
    m.receiveShadow = true;
    m.raycast = () => {};
    return m;
  }

  async function choisir(role, id) {
    etat[role] = id || null;
    if (plans[role]) { groupe.remove(plans[role]); plans[role].geometry.dispose(); plans[role].material.dispose(); plans[role] = null; app.emettre('fond', role); }
    majSol();
    if (!id) { majUI(); return; }
    const fond = fonds.find((f) => f.id === id);
    if (!fond) return;
    if (ui.etat) ui.etat.textContent = `Chargement : ${fond.nom}…`;
    try {
      const res = await obtenirFond(id);
      if (etat[role] !== id) return;
      const m = planPour(res, role === 'comparaison' ? 0.075 : 0.07);
      if (role === 'comparaison') m.material.clippingPlanes = [rideau];
      m.userData.res = res;
      plans[role] = m;
      groupe.add(m);
      app.emettre('fond', role);
      if (ui.etat?.isConnected) {
        ui.etat.replaceChildren(`${fond.nom}${fond.periode ? `, ${fond.periode}` : ''}. ${fond.note ?? ''}${fond.attribution ? ` ${fond.attribution}` : ''}`);
        if (res.blob && app.mode === 'presentateur') {
          ui.etat.append(' ', h('button', { type: 'button', class: 'lien', onclick: async () => { await enregistrerDonnees(`ign/fond-${id}.jpg`, res.blob); await enregistrerDonnees(`ign/fond-${id}.json`, JSON.stringify(res.bornes, null, 2)); } }, 'Enregistrer pour la borne'));
        }
      }
    } catch (e) {
      etat[role] = null;
      if (ui.etat) ui.etat.textContent = `${fond.nom} indisponible : ${e.message}.`;
      majUI();
    }
    majSol();
  }

  function majSol() {
    app.fondActif = !!(etat.principal || etat.comparaison);
    ['voirie', 'surfaces'].forEach((n) => { const g = app.scene.getObjectByName(n); if (g) g.visible = !app.fondActif && (!app.vueMaquette || !!app.decoupe?.disponible); });
    if (ui.rideau) ui.rideau.hidden = !etat.comparaison;
  }

  function majUI() {
    if (ui.selPrincipal) ui.selPrincipal.value = etat.principal || '';
    if (ui.selComparaison) ui.selComparaison.value = etat.comparaison || '';
    if (ui.rideau) ui.rideau.hidden = !etat.comparaison;
  }

  function construireCommandesSol(conteneur) {
    const options = (vide) => [h('option', { value: '' }, vide), ...fonds.map((f) => h('option', { value: f.id }, `${f.nom}${f.periode ? ` (${f.periode})` : ''}`))];
    ui.selPrincipal = h('select', { 'aria-label': 'Fond au sol', onchange: (e) => choisir('principal', e.target.value) }, ...options('Maquette blanche'));
    ui.selComparaison = h('select', { 'aria-label': 'Comparer avec', onchange: (e) => choisir('comparaison', e.target.value) }, ...options('Pas de comparaison'));
    const curseur = h('input', { type: 'range', min: -app.config.rayonEtude, max: app.config.rayonEtude, step: 1, value: etat.rideauX, 'aria-label': 'Position du rideau' });
    curseur.addEventListener('input', () => { etat.rideauX = +curseur.value; rideau.constant = etat.rideauX; });
    ui.rideau = h('div', {}, h('p', { class: 'note' }, 'Le fond de comparaison occupe la partie gauche, jusqu\'au rideau.'), curseur);
    ui.etat = h('p', { class: 'note', 'aria-live': 'polite' });
    const google = fonds.some((f) => f.type === 'google');
    const cle = h('input', { type: 'password', autocomplete: 'off', placeholder: 'AIza…', value: localStorage.getItem('atlas-hdv-cle-google') || '' });
    cle.addEventListener('change', () => { localStorage.setItem('atlas-hdv-cle-google', cle.value.trim()); textures.forEach((_, k) => { if (fonds.find((f) => f.id === k)?.type === 'google') textures.delete(k); }); });
    conteneur.append(...[
      h('label', { class: 'champ' }, h('span', {}, 'Fond au sol'), ui.selPrincipal),
      h('label', { class: 'champ' }, h('span', {}, 'Comparer avec'), ui.selComparaison),
      ui.rideau,
      ui.etat,
      google && app.mode !== 'borne' ? h('details', { class: 'details' },
        h('summary', {}, 'Clé Google Maps'),
        h('label', { class: 'champ' }, h('span', {}, 'Clé d\'API (Map Tiles API)'), cle),
        h('p', { class: 'note' }, 'Clé personnelle créée sur la console Google Cloud, API « Map Tiles » activée, facturation obligatoire (quota gratuit mensuel). Elle reste dans ce navigateur. Les images Google ne sont ni gardées en mémoire ni enregistrables pour la borne. Pour un compte de facturation en Europe, Google ne fournit plus les images satellite ni la 3D photographique : seul le plan reste disponible.')) : null,
    ].filter(Boolean));
    majUI();
  }

  // ------------------------------------------------------------
  // Calques calés
  // ------------------------------------------------------------
  function geometrieCalee(t, w, hauteur, y) {
    const coins = [[0, 0], [w, 0], [w, hauteur], [0, hauteur]].map(([px, py]) => appliquerAffine(t, px, py));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(coins.flatMap(([x, z]) => [x, y, z]), 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 1, 1, 1, 0, 0, 0], 2));
    geo.setIndex([0, 2, 1, 0, 3, 2]);
    geo.computeVertexNormals();
    return geo;
  }

  function transformation(entree) {
    const src = entree.points.map((p) => p.image);
    const dst = entree.points.map((p) => { const l = app.proj.versLocal(p.geo[0], p.geo[1]); return [l.x, l.z]; });
    return affineDepuis3Points(src, dst);
  }

  async function ajouterCalque(entree, url = `data/calques/${entree.fichier}`) {
    let c = calques.find((x) => x.entree.id === entree.id);
    if (c?.mesh) { groupe.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    if (!c) { c = { entree, mesh: null }; calques.push(c); }
    c.entree = entree;
    if (!entree.points || entree.points.length < 3) return c; // en attente de calage
    if (estNonPublie(url)) return c; // plan du PSMV non publié en ligne (droits à vérifier)
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = geometrieCalee(transformation(entree), tex.image.width, tex.image.height, entree.altitude ?? 0.22);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: entree.opacite ?? 0.75, side: THREE.DoubleSide, depthWrite: false }));
      m.renderOrder = 4;
      m.visible = entree.visible !== false;
      m.raycast = () => {};
      groupe.add(m);
      c.mesh = m;
    } catch (e) {
      app.signaler(`Calque « ${entree.nom || entree.fichier} » illisible : ${e.message}`);
    }
    return c;
  }

  async function construire() {
    for (const entree of app.donnees.calques.calques || []) await ajouterCalque(entree);
  }

  // Outil de calage : 3 points sur l'image, puis les 3 mêmes sur la maquette
  const table = document.getElementById('table-calage');
  function caler({ url, nomFichier, nom, id, objetUrl = false }) {
    const ptsImage = [], ptsSol = [];
    const img = h('img', { src: url, alt: 'Image à caler' });
    const zone = h('div', { class: 'zone-image' }, img);
    const consigne = h('p', { class: 'consigne' }, 'Cliquez 3 points bien repérables sur l\'image (angles d\'îlots, de monuments), écartés les uns des autres.');
    const actions = h('div', { class: 'actions' });
    const fermer = () => { app.captureSol = null; table.hidden = true; table.replaceChildren(); app.etiquettes.retirerGroupe('calage'); if (objetUrl) URL.revokeObjectURL(url); };
    actions.append(h('button', { type: 'button', class: 'bouton discret', onclick: fermer }, 'Annuler'));
    table.replaceChildren(h('h3', {}, `Caler « ${nom} »`), consigne, zone, actions);
    table.hidden = false;
    if (!app.vue2D) app.vue?.basculer(true);

    img.addEventListener('click', (e) => {
      if (ptsImage.length >= 3) return;
      const r = img.getBoundingClientRect();
      ptsImage.push([((e.clientX - r.left) / r.width) * img.naturalWidth, ((e.clientY - r.top) / r.height) * img.naturalHeight]);
      zone.append(h('span', { class: 'repere', style: { left: `${((e.clientX - r.left) / r.width) * 100}%`, top: `${((e.clientY - r.top) / r.height) * 100}%` } }, String(ptsImage.length)));
      if (ptsImage.length === 3) {
        consigne.textContent = 'Cliquez maintenant les trois mêmes points, dans le même ordre, sur le plan.';
        app.captureSol = ([x2, z2]) => {
          ptsSol.push([x2, z2]);
          app.etiquettes.ajouter({ texte: String(ptsSol.length), position: new THREE.Vector3(x2, 1, z2), classe: 'etiquette-calage', groupe: 'calage', toujours: true, centre: true });
          if (ptsSol.length === 3) { app.captureSol = null; terminer(); }
          return true;
        };
      }
    });

    async function terminer() {
      const ancien = (app.donnees.calques.calques || []).find((x) => x.id === id);
      const entree = {
        ...(ancien || {}),
        id, nom, fichier: nomFichier,
        opacite: ancien?.opacite ?? 0.75, visible: true, altitude: ancien?.altitude ?? 0.22,
        points: ptsImage.map((p, i) => { const g = app.proj.versGeo(ptsSol[i][0], ptsSol[i][1]); return { image: p.map((v) => Math.round(v * 10) / 10), geo: [+g.lat.toFixed(7), +g.lon.toFixed(7)] }; }),
      };
      const liste = (app.donnees.calques.calques || []).filter((x) => x.id !== id);
      app.donnees.calques = { ...app.donnees.calques, calques: [...liste, entree] };
      await ajouterCalque(entree, url);
      consigne.textContent = objetUrl
        ? 'Calage appliqué. Enregistrez calques.json dans data/, et copiez l\'image dans data/calques/.'
        : 'Calage appliqué. Enregistrez calques.json dans data/ pour le conserver.';
      actions.replaceChildren(
        h('button', { type: 'button', class: 'bouton principal', onclick: () => enregistrerDonnees('calques.json', JSON.stringify(app.donnees.calques, null, 2)) }, 'Enregistrer calques.json'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { fermer(); rafraichirPanneau(); } }, 'Fermer'),
      );
      rafraichirPanneau();
    }
  }

  let conteneurPanneau = null;
  function rafraichirPanneau() { if (conteneurPanneau?.isConnected) { conteneurPanneau.replaceChildren(); remplirPanneau(conteneurPanneau); } }

  function remplirPanneau(conteneur) {
    conteneurPanneau = conteneur;
    const bouton = (e, libelle) => h('button', { type: 'button', class: 'bouton discret petit', onclick: () => caler({ url: `data/calques/${e.fichier}`, nomFichier: e.fichier, nom: e.nom, id: e.id }) }, libelle);
    const liste = calques.map((c) => {
      const e = c.entree;
      if (!c.mesh) {
        return h('li', { class: 'a-caler' },
          h('span', {}, e.nom, e.periode ? h('em', {}, ` ${e.periode}`) : null),
          estNonPublie(`data/calques/${e.fichier}`) ? h('em', {}, ` ${NON_PUBLIE}`) : app.mode === 'presentateur' ? bouton(e, 'Caler') : h('em', {}, ' pas encore calé'));
      }
      const op = h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: c.mesh.material.opacity, 'aria-label': `Opacité de ${e.nom}` });
      op.addEventListener('input', () => { c.mesh.material.opacity = +op.value; });
      return h('li', {},
        h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: c.mesh.visible, onchange: (ev) => { c.mesh.visible = ev.target.checked; } }), e.nom),
        op,
        app.mode === 'presentateur' ? bouton(e, 'Recaler') : null);
    });
    conteneur.append(liste.length ? h('ul', { class: 'liste-calques' }, ...liste) : h('p', { class: 'note' }, 'Aucun calque.'));
    if (app.mode === 'presentateur') {
      const input = h('input', {
        type: 'file', accept: 'image/*', hidden: true,
        onchange: (e) => {
          const f = e.target.files[0];
          if (f) caler({ url: URL.createObjectURL(f), nomFichier: f.name, nom: f.name.replace(/\.[^.]+$/, ''), id: f.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-'), objetUrl: true });
          e.target.value = '';
        },
      });
      conteneur.append(input, h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: () => input.click() }, 'Caler une nouvelle image')));
    }
  }

  return { construire, remplirPanneau, construireCommandesSol, choisir, calques, etat, fonds, textureFond: (role) => plans[role]?.userData.res || null };
}
