import * as THREE from 'three';
import { h, info } from './util.js';
import { chargerJSON, chercherJeux, lireJeuGeo, enregistrerDonnees } from './donnees.js';
import { lireCache, ecrireCache } from './cache.js';
import { empriseAutour, lignesLocales, polygonesLocaux } from './geo.js';
import { geometrieRubans } from './maquette.js';

// Réseaux du site. Les réseaux enterrés précis (eau, assainissement, gaz, électricité) ne sont pas
// publics dans le détail : on assemble ce qui est ouvert, OpenStreetMap (éclairage, tampons, bornes
// incendie, lignes) et les jeux de l'Open Data de Nantes Métropole choisis par l'étudiant.
const TYPES_OSM = [
  { id: 'eclairage', libelle: 'Éclairage public', test: (p) => p.highway === 'street_lamp', couleur: '#e0a526' },
  { id: 'tampons', libelle: 'Tampons (regards)', test: (p) => p.man_made === 'manhole', couleur: '#5b6770' },
  { id: 'incendie', libelle: 'Bornes incendie', test: (p) => p.emergency === 'fire_hydrant', couleur: '#c8372d' },
  { id: 'armoires', libelle: 'Armoires et poteaux', test: (p) => p.man_made === 'street_cabinet' || p.man_made === 'utility_pole', couleur: '#7a6aa8' },
  { id: 'lignes', libelle: 'Lignes et conduites', test: (p) => !!p.power || p.man_made === 'pipeline', couleur: '#b0602b' },
];
const PALETTE = ['#2f7fb5', '#3f9a6b', '#a85b9b', '#c77a2b', '#4b5fb8', '#8a8f2a', '#b54a4a'];
const SUGGESTIONS = ['assainissement', 'eaux pluviales', 'eau potable', 'éclairage', 'réseau de chaleur', 'électricité', 'servitudes'];
const CLE = 'atlas-hdv-reseaux';

// Réseaux souterrains publiés en open data (data/reseaux/, extraits par outils hors ligne, cercle de 420 m) :
// GRDF (gaz) et Enedis (électricité BT, HTA, postes). Tracés seuls : ni profondeur ni diamètre.
// Couleurs conventionnelles des réseaux (grillages avertisseurs) : gaz jaune, électricité rouge ; HTA plus épaisse et en tirets.
// Rubans plats juste au-dessus du sol (drapés par le relief), polygonOffset et ordre de rendu pour éviter le scintillement.
const SOUTERRAINS = [
  { id: 'gaz', fichier: 'gaz.geojson', libelle: 'Gaz (GRDF)', calque: 'RESEAU_GAZ', couleur: '#e6b800', largeur: 0.9, y: 0.1, decalage: -7 },
  { id: 'elec-bt', fichier: 'elec-bt.geojson', libelle: 'Électricité BT (Enedis)', calque: 'RESEAU_ELEC_BT', couleur: '#e3262c', largeur: 0.45, y: 0.12, decalage: -8 },
  { id: 'elec-hta', fichier: 'elec-hta.geojson', libelle: 'Électricité HTA (Enedis)', calque: 'RESEAU_ELEC_HTA', couleur: '#9e0b1a', largeur: 1.5, y: 0.14, decalage: -9, tirets: true },
  { id: 'postes', fichier: 'postes.geojson', libelle: 'Postes HTA/BT (Enedis)', calque: 'POSTES', couleur: '#9e0b1a', points: true },
];
const NON_PUBLIES = ['Eaux usées', 'Eaux pluviales', 'Eau potable', 'Fibre optique'];
const CLE_SOUT = 'atlas-hdv-reseaux-souterrains';
const lireMasques = () => { try { return JSON.parse(localStorage.getItem(CLE_SOUT) || '{}') || {}; } catch { return {}; } };

export function creerReseaux(app) {
  const groupe = new THREE.Group();
  groupe.name = 'reseaux';
  app.scene.add(groupe);
  const jeux = []; // { id, titre, couleur, fc, objet }
  const ui = {};
  const emprise = () => empriseAutour(app.config.origine.lat, app.config.origine.lon, app.config.rayonEtude * 1.1);
  const r = () => app.config.rayonEtude * 1.1;

  // ---------------------------------------------------------------
  // Éléments OpenStreetMap
  // ---------------------------------------------------------------
  const osm = new THREE.Group();
  osm.name = 'reseaux-osm';
  groupe.add(osm);
  const compte = {};

  function construireOSM() {
    osm.clear();
    const col = app.donnees.osm.reseaux?.features || [];
    for (const t of TYPES_OSM) {
      const pts = [], lignes = [];
      for (const f of col) {
        if (!t.test(f.properties || {})) continue;
        if (f.geometry.type === 'Point') {
          const [x, z] = app.proj.pt(f.geometry.coordinates);
          if (Math.hypot(x, z) <= r()) pts.push([x, z]);
        } else {
          for (const l of lignesLocales(f.geometry, app.proj)) for (let i = 1; i < l.length; i++) lignes.push(l[i - 1][0], 0.34, l[i - 1][1], l[i][0], 0.34, l[i][1]);
        }
      }
      compte[t.id] = pts.length + lignes.length / 6;
      const couleur = new THREE.Color(t.couleur);
      if (pts.length) {
        const eclairage = t.id === 'eclairage';
        const geo = eclairage ? new THREE.CylinderGeometry(0.12, 0.12, 6, 6).translate(0, 3, 0) : new THREE.CylinderGeometry(0.6, 0.6, 0.12, 12).translate(0, 0.32, 0);
        const m = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: couleur, roughness: 0.6 }), pts.length);
        const m4 = new THREE.Matrix4();
        pts.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); m.setMatrixAt(i, m4); });
        m.name = t.id;
        m.raycast = () => {};
        osm.add(m);
        if (eclairage) {
          const tete = new THREE.InstancedMesh(new THREE.SphereGeometry(0.45, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe3a0 }), pts.length);
          pts.forEach(([x, z], i) => { m4.makeTranslation(x, 6.1, z); tete.setMatrixAt(i, m4); });
          tete.name = t.id;
          tete.raycast = () => {};
          osm.add(tete);
        }
      }
      if (lignes.length) {
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(lignes, 3));
        const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: couleur }));
        l.name = t.id;
        l.raycast = () => {};
        osm.add(l);
      }
    }
  }

  // ---------------------------------------------------------------
  // Réseaux souterrains open data (GRDF, Enedis), fichiers locaux
  // ---------------------------------------------------------------
  const sout = new THREE.Group();
  sout.name = 'reseaux-souterrains';
  groupe.add(sout);
  const souterrains = []; // { ...def, fc, objet, visible }
  let sources = null;

  function dessinerSouterrain(s) {
    const o = new THREE.Group();
    o.name = `reseau-${s.id}`;
    const couleur = new THREE.Color(s.couleur);
    if (s.points) {
      const pts = s.fc.features.filter((f) => f.geometry?.type === 'Point').map((f) => app.proj.pt(f.geometry.coordinates));
      if (pts.length) {
        // petit bloc carré (2,4 m, 1,6 m de haut) : visible en plan comme en 3D
        const m = new THREE.InstancedMesh(new THREE.BoxGeometry(2.4, 1.6, 2.4).translate(0, 0.8, 0),
          new THREE.MeshStandardMaterial({ color: couleur, roughness: 0.7 }), pts.length);
        const m4 = new THREE.Matrix4();
        pts.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); m.setMatrixAt(i, m4); });
        m.raycast = () => {};
        o.add(m);
      }
    } else {
      const lignes = [], segs = [];
      for (const f of s.fc.features) {
        if (!f.geometry) continue;
        for (const pts of lignesLocales(f.geometry, app.proj)) {
          lignes.push({ pts, largeur: s.largeur });
          for (let i = 1; i < pts.length; i++) segs.push(pts[i - 1][0], s.y + 0.12, pts[i - 1][1], pts[i][0], s.y + 0.12, pts[i][1]);
        }
      }
      if (lignes.length) {
        const ruban = new THREE.Mesh(geometrieRubans(lignes, s.y), new THREE.MeshBasicMaterial({
          color: couleur, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: s.decalage, polygonOffsetUnits: s.decalage,
        }));
        ruban.renderOrder = 5;
        ruban.raycast = () => {};
        o.add(ruban);
        // trait d'un pixel par-dessus : lisible même vu de loin (plan d'ensemble)
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(segs, 3));
        const trait = new THREE.LineSegments(g, s.tirets
          ? new THREE.LineDashedMaterial({ color: couleur, dashSize: 3, gapSize: 2 })
          : new THREE.LineBasicMaterial({ color: couleur }));
        if (s.tirets) trait.computeLineDistances();
        trait.renderOrder = 6;
        trait.raycast = () => {};
        o.add(trait);
      }
    }
    o.visible = s.visible;
    s.objet = o;
    sout.add(o);
  }

  async function construireSouterrains() {
    sout.clear();
    souterrains.length = 0;
    const masques = lireMasques();
    sources = await chargerJSON('data/reseaux/sources.json', null);
    for (const def of SOUTERRAINS) {
      const fc = await chargerJSON(`data/reseaux/${def.fichier}`, null);
      if (!fc?.features) continue;
      const s = { ...def, fc, visible: masques[def.id] !== false };
      souterrains.push(s);
      dessinerSouterrain(s);
    }
  }

  function basculerSouterrain(s, oui) {
    s.visible = oui;
    s.objet.visible = oui;
    const masques = lireMasques();
    masques[s.id] = oui;
    try { localStorage.setItem(CLE_SOUT, JSON.stringify(masques)); } catch { /* stockage indisponible */ }
  }

  function infoSouterrains() {
    const src = sources || {};
    const aeriens = souterrains.find((s) => s.id === 'elec-bt')?.fc.features.filter((f) => f.properties?.type === 'aerien').length || 0;
    const ligne = (s) => {
      const d = src[s.fichier] || {};
      const maj = typeof d.maj_jeu === 'object' && d.maj_jeu ? Object.entries(d.maj_jeu).map(([k, v]) => `${k} : ${v}`).join(' ; ') : d.maj_jeu;
      const url = [].concat(d.url || []).join(' ; ');
      return `${s.libelle} — ${s.fc.features.length} objets${d.detail ? ` (${d.detail})` : ''}. Licence : ${d.licence || 'Licence Ouverte Etalab 2.0'}. Mise à jour du jeu : ${maj || '?'}. Source : ${url || '?'}.`;
    };
    const p = (t) => (t ? h('p', { style: { overflowWrap: 'anywhere' } }, t) : null);
    return info(
      `Sources : GRDF (cartographie du réseau gaz en service) et Enedis (réseaux BT et HTA souterrains et aériens, postes électriques), open data sous Licence Ouverte / Open Licence 2.0 (Etalab). Extraction du ${src.extraction || '?'}, ${src.zone || 'cercle de 420 m autour du site'}.`,
      ...souterrains.map((s) => p(ligne(s))),
      'Limites : tracés seuls, positions indicatives, sans profondeur, diamètre, matériau ni pression ; les branchements particuliers ne sont pas tous représentés. Ces cartes ne remplacent pas une DT-DICT : avant tous travaux, la déclaration sur le Guichet unique (reseaux-et-canalisations.ineris.fr) est obligatoire.',
      'Lecture : couleurs conventionnelles des réseaux, gaz en jaune, électricité en rouge ; BT en trait fin, HTA en trait épais et en tirets (rouge sombre) ; postes HTA/BT en petits blocs.',
      aeriens ? `Les ${aeriens} tronçons BT aériens (façades, poteaux) sont dessinés au sol avec le reste.` : null,
    );
  }

  // ---------------------------------------------------------------
  // Jeux de données Open Data
  // ---------------------------------------------------------------
  function dessinerJeu(j) {
    if (j.objet) { groupe.remove(j.objet); }
    const o = new THREE.Group();
    const couleur = new THREE.Color(j.couleur);
    const lignes = [], pts = [];
    for (const f of j.fc.features) {
      const g = f.geometry;
      if (!g) continue;
      if (g.type === 'Point') { const [x, z] = app.proj.pt(g.coordinates); pts.push([x, z]); }
      else if (g.type === 'MultiPoint') g.coordinates.forEach((c) => { const [x, z] = app.proj.pt(c); pts.push([x, z]); });
      else if (g.type.includes('LineString')) {
        for (const l of lignesLocales(g, app.proj)) for (let i = 1; i < l.length; i++) lignes.push(l[i - 1][0], 0.36, l[i - 1][1], l[i][0], 0.36, l[i][1]);
      } else if (g.type.includes('Polygon')) {
        for (const anneaux of polygonesLocaux(g, app.proj)) for (const a of anneaux) for (let i = 0; i < a.length; i++) { const p = a[i], q = a[(i + 1) % a.length]; lignes.push(p[0], 0.36, p[1], q[0], 0.36, q[1]); }
      }
    }
    if (lignes.length) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(lignes, 3));
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: couleur }));
      l.raycast = () => {};
      o.add(l);
    }
    if (pts.length) {
      const m = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.7, 0.7, 0.12, 12).translate(0, 0.36, 0), new THREE.MeshBasicMaterial({ color: couleur }), pts.length);
      const m4 = new THREE.Matrix4();
      pts.forEach(([x, z], i) => { m4.makeTranslation(x, 0, z); m.setMatrixAt(i, m4); });
      m.raycast = () => {};
      o.add(m);
    }
    o.visible = j.visible !== false;
    j.objet = o;
    groupe.add(o);
  }

  async function ajouterJeu(id, titre, { silencieux = false } = {}) {
    if (jeux.some((j) => j.id === id)) return;
    const cle = `ods-${id}-${app.cleZone}`;
    // jeu enregistré dans data/reseaux/ (borne hors ligne), sinon mémoire du navigateur, sinon en ligne
    let fc = await chargerJSON(`data/reseaux/${id}.geojson`, null) || await lireCache(cle, 30);
    if (!fc) {
      if (!navigator.onLine || app.mode === 'borne') { if (!silencieux) app.signaler('Hors ligne : ce jeu de données n\'est pas en mémoire.'); return; }
      try {
        fc = await lireJeuGeo(id, emprise());
        await ecrireCache(cle, fc);
      } catch (e) {
        if (!silencieux) app.signaler(`Jeu « ${titre} » illisible : ${e.message}`);
        return;
      }
    }
    const j = { id, titre, couleur: PALETTE[jeux.length % PALETTE.length], fc, visible: true };
    jeux.push(j);
    dessinerJeu(j);
    memoriser();
    if (!silencieux) app.signaler(`${titre} : ${fc.features.length} éléments dans le périmètre.`);
    rafraichir();
  }

  function retirerJeu(id) {
    const i = jeux.findIndex((j) => j.id === id);
    if (i < 0) return;
    groupe.remove(jeux[i].objet);
    jeux.splice(i, 1);
    memoriser();
    rafraichir();
  }

  function memoriser() {
    localStorage.setItem(CLE, JSON.stringify(jeux.map((j) => ({ id: j.id, titre: j.titre }))));
  }

  async function construire() {
    construireOSM();
    await construireSouterrains();
    const liste = [...(app.config.reseaux || []), ...JSON.parse(localStorage.getItem(CLE) || '[]')];
    for (const { id, titre } of liste) await ajouterJeu(id, titre, { silencieux: true });
    majVisibilite();
  }

  function majVisibilite() {
    groupe.visible = !!app.couches.reseaux;
  }

  // ---------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------
  let conteneurPanneau = null;
  function rafraichir() { if (conteneurPanneau?.isConnected) { conteneurPanneau.replaceChildren(); construirePanneau(conteneurPanneau); } }

  async function chercher(mots) {
    ui.resultats.replaceChildren(h('p', { class: 'note' }, `Recherche de « ${mots} »…`));
    try {
      const res = await chercherJeux(mots);
      ui.resultats.replaceChildren(res.length
        ? h('ul', { class: 'liste-jeux' }, ...res.map((d) => h('li', {},
          h('div', {}, h('strong', {}, d.titre), h('span', { class: 'note' }, d.description)),
          h('button', { type: 'button', class: 'bouton petit', disabled: jeux.some((j) => j.id === d.id), onclick: () => ajouterJeu(d.id, d.titre) }, 'Afficher'))))
        : h('p', { class: 'note' }, 'Aucun jeu géographique trouvé pour ces mots.'));
    } catch (e) {
      ui.resultats.replaceChildren(h('p', { class: 'note' }, `Catalogue indisponible : ${e.message}`));
    }
  }

  function construirePanneau(conteneur) {
    conteneurPanneau = conteneur;
    ui.resultats = h('div');
    const champ = h('input', { type: 'search', placeholder: 'assainissement, éclairage…', 'aria-label': 'Rechercher un jeu de données' });
    champ.addEventListener('keydown', (e) => { if (e.key === 'Enter') chercher(champ.value.trim()); });
    conteneur.append(...[
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: !!app.couches.reseaux, onchange: (e) => { app.couches.reseaux = e.target.checked; majVisibilite(); } }), 'Afficher les réseaux sur la maquette'),
      h('h3', {}, 'OpenStreetMap'),
      h('ul', { class: 'legende' }, ...TYPES_OSM.map((t) => h('li', {},
        h('label', { class: 'case' },
          h('input', { type: 'checkbox', checked: osm.children.find((c) => c.name === t.id)?.visible ?? true, onchange: (e) => osm.children.filter((c) => c.name === t.id).forEach((c) => { c.visible = e.target.checked; }) }),
          h('i', { style: { background: t.couleur } }), `${t.libelle} (${compte[t.id] ?? 0})`)))),
      h('p', { class: 'note' }, 'Relevés bénévoles, souvent incomplets : à vérifier sur place.'),
      h('div', { class: 'titre-info' }, h('h3', {}, 'Réseaux souterrains (open data)'), infoSouterrains()),
      souterrains.length ? h('ul', { class: 'legende' }, ...souterrains.map((s) => h('li', {},
        h('label', { class: 'case' },
          h('input', { type: 'checkbox', checked: s.visible, onchange: (e) => basculerSouterrain(s, e.target.checked) }),
          h('i', { style: s.points ? { background: s.couleur, width: '10px', height: '10px' }
            : s.tirets ? { background: `repeating-linear-gradient(90deg, ${s.couleur} 0 6px, transparent 6px 9px)`, height: '6px', border: 'none' }
              : { background: s.couleur, height: s.id === 'gaz' ? '4px' : '2px', border: 'none' } }),
          `${s.libelle} (${s.fc.features.length})`)))) : h('p', { class: 'note' }, 'Fichiers data/reseaux/ absents : réseaux souterrains indisponibles.'),
      h('ul', { class: 'liste-non-publies note' }, ...NON_PUBLIES.map((n) => h('li', {}, `${n} : non publié en open data — accessible via DT-DICT (Guichet unique reseaux-et-canalisations.ineris.fr)`))),
      h('h3', {}, 'Open Data de Nantes Métropole'),
      jeux.length ? h('ul', { class: 'legende' }, ...jeux.map((j) => h('li', {},
        h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: j.visible, onchange: (e) => { j.visible = e.target.checked; j.objet.visible = j.visible; } }),
          h('i', { style: { background: j.couleur } }), `${j.titre} (${j.fc.features.length})`),
        app.mode === 'presentateur' ? h('button', { type: 'button', class: 'bouton discret petit', onclick: () => retirerJeu(j.id) }, 'Retirer') : null))) : null,
      app.mode !== 'borne' ? h('div', { class: 'recherche' }, champ, h('button', { type: 'button', class: 'bouton', onclick: () => chercher(champ.value.trim()) }, 'Chercher')) : null,
      app.mode !== 'borne' ? h('div', { class: 'puces' }, ...SUGGESTIONS.map((s) => h('button', { type: 'button', class: 'puce', onclick: () => { champ.value = s; chercher(s); } }, s))) : null,
      ui.resultats,
      h('p', { class: 'note' }, 'Les plans précis des réseaux enterrés ne sont pas publics : pour un projet, ils se demandent aux exploitants par une déclaration de projet de travaux (DT) sur le Guichet unique (reseaux-et-canalisations.ineris.fr).'),
      jeux.length && app.mode === 'presentateur' ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: async () => { for (const j of jeux) await enregistrerDonnees(`reseaux/${j.id}.geojson`, JSON.stringify(j.fc), { type: 'application/geo+json' }); } }, 'Enregistrer les jeux affichés')) : null,
    ].filter(Boolean));
  }

  app.on('couches', majVisibilite);

  return { construire, construirePanneau, jeux, souterrains, get osm() { return app.donnees.osm.reseaux?.features || []; }, TYPES_OSM };
}
