import * as THREE from 'three';
import { h, info, lireLS, ecrireLS, estNonPublie, NON_PUBLIE } from './util.js';
import { affineDepuis3Points, appliquerAffine, empriseAutour } from './geo.js';
import { chargerJSON, fichierExiste, enregistrerDonnees, assemblerFond } from './donnees.js';
import { lireCache, ecrireCache } from './cache.js';

// Images posées au sol :
// - fonds IGN (photos aériennes, cartes anciennes), chargés en direct puis gardés en cache,
//   ou lus dans data/ign/ quand ils ont été préparés pour la borne ;
// - fonds tirés d'une image calée (entrée de data/calques.json avec « fond »: true, ex. IGNF 1923) :
//   image redressée dans un canevas nord-sud, proposée dans la liste des fonds au sol, absente de la liste des calques ;
// - calques de l'étudiant (plans anciens, plans du PSMV, dessins), calés par 3 points.
export function creerCalques(app) {
  const groupe = new THREE.Group();
  groupe.name = 'calques';
  app.scene.add(groupe);
  const fonds = [...(app.config.fonds || [])];
  const textures = new Map();
  const plans = { principal: null, comparaison: null };
  const rideau = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0);
  const etat = { principal: null, comparaison: null, rideauX: 0, opacite: Math.min(1, Math.max(0.05, +(lireLS('atlas-hdv-fond-opacite') ?? 1) || 1)) };
  const calques = [];
  const ui = {};

  // ------------------------------------------------------------
  // Fonds
  // ------------------------------------------------------------
  async function textureDepuisBlob(blob) {
    const url = URL.createObjectURL(blob);
    const t = await new THREE.TextureLoader().loadAsync(url).finally(() => URL.revokeObjectURL(url));
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = app.renderer.capabilities.getMaxAnisotropy();
    return t;
  }

  function obtenirFond(id) {
    if (textures.has(id)) return textures.get(id);
    const fond = fonds.find((f) => f.id === id);
    const promesse = (async () => {
      // 0. image calée de data/calques/ (fichier local : aussi en borne hors ligne)
      if (fond.type === 'calque') return fondDepuisCalque(fond.calque);
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

  // Image calée (3 points) redressée dans un canevas aligné nord-sud : même forme { texture, bornes } que les fonds IGN,
  // donc même plan au sol (drapé par relief.js, coupé par decoupe.js), photo sur les toits (bati.js), rendu de la planche
  async function fondDepuisCalque(e) {
    if (!e.points || e.points.length < 3) throw new Error('image pas encore calée (data/calques.json)');
    const img = await new Promise((ok, ko) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = () => ko(new Error(`image absente : data/calques/${e.fichier}`));
      i.src = `data/calques/${encodeURIComponent(e.fichier)}`;
    });
    const w = img.naturalWidth, hh = img.naturalHeight;
    const t = transformation(e, w, hh);
    const coins = [[0, 0], [w, 0], [w, hh], [0, hh]].map(([px, py]) => appliquerAffine(t, px, py));
    const xs = coins.map((c) => c[0]), zs = coins.map((c) => c[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
    const maxT = Math.min(4096, app.renderer.capabilities.maxTextureSize || 4096);
    // résolution de l'image d'origine (pixels par mètre), plafonnée par la taille de texture
    const s = Math.min(1 / Math.min(Math.hypot(t.a, t.d), Math.hypot(t.b, t.e)), maxT / (x1 - x0), maxT / (z1 - z0));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil((x1 - x0) * s)); c.height = Math.max(1, Math.ceil((z1 - z0) * s));
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.setTransform(t.a * s, t.d * s, t.b * s, t.e * s, (t.c - x0) * s, (t.f - z0) * s);
    ctx.drawImage(img, 0, 0);
    const texture = new THREE.CanvasTexture(c);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = app.renderer.capabilities.getMaxAnisotropy();
    const no = app.proj.versGeo(x0, z0), se = app.proj.versGeo(x1, z1);
    return { texture, bornes: { nord: no.lat, ouest: no.lon, sud: se.lat, est: se.lon }, source: 'fichier', transparent: true };
  }

  // entrée « fond »: true de data/calques.json → fond au sol (et non calque superposé)
  function ajouterFondCalque(entree) {
    const f = { id: entree.id, nom: entree.nom || entree.fichier, type: 'calque', calque: entree, periode: entree.periodeFond, note: entree.note, attribution: entree.attribution, avertissement: entree.avertissement };
    const i = fonds.findIndex((x) => x.id === entree.id);
    if (i >= 0) { fonds[i] = f; return; }
    // rangé avant les cartes anciennes du territoire (état-major, Cassini), sinon en fin de liste
    const j = fonds.findIndex((x) => x.id === 'etat-major');
    fonds.splice(j >= 0 ? j : fonds.length, 0, f);
  }

  // section de la légende automatique (app.legende.ajouter) : fond(s) au sol affiché(s) et crédit
  let legendeBranchee = false;
  function brancherLegende() {
    if (legendeBranchee || !app.legende?.ajouter) return;
    legendeBranchee = true;
    app.legende.ajouter(() => {
      const L = ['principal', 'comparaison'].map((r) => plans[r] && fonds.find((f) => f.id === etat[r])).filter(Boolean);
      if (!L.length) return null;
      return {
        id: 'fond', titre: 'Fond au sol',
        items: L.map((f) => ({ libelle: f.nom, couleur: f.type === 'calque' ? '#8c8c84' : '#b9c4b0', forme: 'aplat' })),
        note: L.map((f) => f.attribution).filter(Boolean).join(' ') || undefined,
      };
    });
  }
  (function attendreLegende(n = 0) { brancherLegende(); if (!legendeBranchee && n < 60) setTimeout(() => attendreLegende(n + 1), 500); })();

  function opaciteFond(m) {
    const o = etat.opacite;
    m.material.opacity = o;
    m.material.transparent = o < 1 || !!m.userData.res?.transparent;
    m.material.depthWrite = !m.material.transparent;
    m.material.needsUpdate = true;
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
    if (plans[role]) { groupe.remove(plans[role]); plans[role].geometry.dispose(); plans[role].material.dispose(); plans[role] = null; app.emettre('fond', role); app.emettre('legende'); }
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
      opaciteFond(m);
      plans[role] = m;
      groupe.add(m);
      app.emettre('fond', role);
      brancherLegende();
      app.emettre('legende');
      majUI();
      if (ui.etat?.isConnected) {
        ui.etat.replaceChildren(`${fond.nom}${fond.periode ? `, ${fond.periode}` : ''}. ${fond.note ?? ''}${fond.attribution ? ` ${fond.attribution}` : ''}`);
        // « i » du fond : avertissement (ex. image restaurée par IA, à ne pas citer comme source primaire)
        if (fond.avertissement) ui.etat.append(' ', info(...[].concat(fond.avertissement)));
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
    if (ui.opacite) ui.opacite.hidden = !(etat.principal || etat.comparaison);
  }

  function construireCommandesSol(conteneur) {
    const options = (vide) => [h('option', { value: '' }, vide), ...fonds.map((f) => h('option', { value: f.id }, `${f.nom}${f.periode ? ` (${f.periode})` : ''}`))];
    ui.selPrincipal = h('select', { 'aria-label': 'Fond au sol', onchange: (e) => choisir('principal', e.target.value) }, ...options('Maquette blanche'));
    ui.selComparaison = h('select', { 'aria-label': 'Comparer avec', onchange: (e) => choisir('comparaison', e.target.value) }, ...options('Pas de comparaison'));
    const curseur = h('input', { type: 'range', min: -app.config.rayonEtude, max: app.config.rayonEtude, step: 1, value: etat.rideauX, 'aria-label': 'Position du rideau' });
    curseur.addEventListener('input', () => { etat.rideauX = +curseur.value; rideau.constant = etat.rideauX; });
    ui.rideau = h('div', {}, h('p', { class: 'note' }, 'Le fond de comparaison occupe la partie gauche, jusqu\'au rideau.'), curseur);
    ui.etat = h('p', { class: 'note', 'aria-live': 'polite' });
    const opacite = h('input', { type: 'range', min: 0.05, max: 1, step: 0.05, value: etat.opacite, 'aria-label': 'Opacité du fond au sol' });
    opacite.addEventListener('input', () => {
      etat.opacite = +opacite.value;
      ecrireLS('atlas-hdv-fond-opacite', String(etat.opacite));
      Object.values(plans).forEach((m) => m && opaciteFond(m));
    });
    ui.opacite = h('label', { class: 'champ' }, h('span', {}, 'Opacité du fond'), opacite);
    brancherLegende();
    const google = fonds.some((f) => f.type === 'google');
    const cle = h('input', { type: 'password', autocomplete: 'off', placeholder: 'AIza…', value: lireLS('atlas-hdv-cle-google') || '' });
    cle.addEventListener('change', () => { ecrireLS('atlas-hdv-cle-google', cle.value.trim()); textures.forEach((_, k) => { if (fonds.find((f) => f.id === k)?.type === 'google') textures.delete(k); }); });
    conteneur.append(...[
      h('label', { class: 'champ' }, h('span', {}, 'Fond au sol'), ui.selPrincipal),
      ui.opacite,
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

  // points « image » en pixels de l'image calée ; « taille » [l, h] = taille de l'image au calage :
  // une copie redimensionnée du même fichier garde ainsi son calage
  function transformation(entree, w, hauteur) {
    const [kx, ky] = entree.taille && w && hauteur ? [w / entree.taille[0], hauteur / entree.taille[1]] : [1, 1];
    const src = entree.points.map((p) => [p.image[0] * kx, p.image[1] * ky]);
    const dst = entree.points.map((p) => { const l = app.proj.versLocal(p.geo[0], p.geo[1]); return [l.x, l.z]; });
    return affineDepuis3Points(src, dst);
  }

  async function ajouterCalque(entree, url = `data/calques/${entree.fichier}`) {
    let c = calques.find((x) => x.entree.id === entree.id);
    if (c?.mesh) { groupe.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh.material.map?.dispose(); c.mesh.material.dispose(); c.mesh = null; }
    if (!c) { c = { entree, mesh: null }; calques.push(c); }
    c.entree = entree;
    if (!entree.points || entree.points.length < 3) return c; // en attente de calage
    if (estNonPublie(url)) return c; // plan du PSMV non publié en ligne (droits à vérifier)
    try {
      const tex = await new THREE.TextureLoader().loadAsync(url);
      tex.colorSpace = THREE.SRGBColorSpace;
      const geo = geometrieCalee(transformation(entree, tex.image.width, tex.image.height), tex.image.width, tex.image.height, entree.altitude ?? 0.22);
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
    for (const entree of app.donnees.calques.calques || []) {
      if (entree.fond) { ajouterFondCalque(entree); continue; } // fond au sol seulement, pas dans la liste des calques
      await ajouterCalque(entree);
    }
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
        taille: [img.naturalWidth, img.naturalHeight],
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
