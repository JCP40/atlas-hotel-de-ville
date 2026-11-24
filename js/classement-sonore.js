import * as THREE from 'three';
import { h, info, viderGroupe } from './util.js';
import { lireCache, ecrireCache } from './cache.js';
import { empriseAutour, lignesLocales } from './geo.js';
import { geometrieRubans } from './maquette.js';

// Classement sonore des infrastructures de transports terrestres (21/11/2026), couche de l'outil Bruit (js/bruit.js).
// Données : data/classement-sonore.geojson produit par outils/bruit/classement.py depuis les archives de la DDTM de Loire-Atlantique
// (classement révisé en 2020, routes et réseau ferré, Licence Ouverte 2.0). Repli : service WFS de Géo-IDE (cache IndexedDB) ; il ne
// fournit aujourd'hui que les attributs, sans tracé (« Cannot write geometry », essai du 20/11/2026) : l'atlas le signale.
// Ce n'est PAS une carte de bruit : le classement range chaque tronçon dans une catégorie d'après un niveau sonore de référence calculé
// (arrêté du 30 mai 1996 modifié par l'arrêté du 23 juillet 2013, art. 2 et 4) et définit de part et d'autre un « secteur affecté par
// le bruit » où les bâtiments neufs doivent respecter un isolement acoustique minimal (art. 5 et 6). Une voie non classée n'est pas
// une voie calme : sous 5 000 véhicules par jour (ou hors des voies recensées), aucune voie n'est classée.
// Largeur du secteur : comptée depuis le bord de la chaussée le plus proche (routes) ou le rail le plus proche (voies ferrées), art. 2.
// L'atlas part de l'axe du tronçon + la demi-largeur de chaussée du fichier (champ largeurCha) ; voies ferrées : depuis l'axe (approximation
// de quelques mètres au plus).

// Niveaux sonores de référence (LAeq en dB(A), façade, art. 4 de l'arrêté du 30 mai 1996 modifié le 23 juillet 2013, version consolidée
// lue le 21/11/2026) : routes et LGV ; voies ferrées conventionnelles + 3 dB(A).
export const CATEGORIES_SONORES = [
  { n: 1, couleur: '#151515', largeur: 300, route: ['L > 81', 'L > 76'], fer: ['L > 84', 'L > 79'], u: 45 },
  { n: 2, couleur: '#7b2cbf', largeur: 250, route: ['76 < L ≤ 81', '71 < L ≤ 76'], fer: ['79 < L ≤ 84', '74 < L ≤ 79'], u: 42 },
  { n: 3, couleur: '#e5007d', largeur: 100, route: ['70 < L ≤ 76', '65 < L ≤ 71'], fer: ['73 < L ≤ 79', '68 < L ≤ 74'], u: 38 },
  { n: 4, couleur: '#0096c7', largeur: 30, route: ['65 < L ≤ 70', '60 < L ≤ 65'], fer: ['68 < L ≤ 73', '63 < L ≤ 68'], u: 35 },
  { n: 5, couleur: '#00a383', largeur: 10, route: ['60 < L ≤ 65', '55 < L ≤ 60'], fer: ['63 < L ≤ 68', '58 < L ≤ 63'], u: 30 },
];
const CAT = Object.fromEntries(CATEGORIES_SONORES.map((c) => [c.n, c]));

// Isolement acoustique minimal DnT,A,tr (dB) des pièces des logements neufs, méthode forfaitaire (art. 6), selon la distance à la voie.
// INDICATIF, À VÉRIFIER : le tableau officiel de l'art. 6 (JO n° 177 du 01/08/2013, texte 23) est une image que l'atlas n'a pas pu lire ;
// valeurs du tableau « tissu ouvert » de la version de 1996, telles qu'elles sont couramment reproduites, plancher 30 dB (art. 5).
// Rue en U (version de 1996, vérifiée dans une copie du texte) : 45, 42, 38, 35, 30 dB selon la catégorie, sans dépendre de la distance.
// Corrections non appliquées : angle de vue, écrans, façades latérales et arrière, cumul de plusieurs voies (art. 6).
const BORNES = [10, 15, 20, 25, 30, 40, 50, 65, 80, 100, 125, 160, 200, 250, 300];
const ISOLEMENT = {
  1: [45, 45, 44, 43, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32],
  2: [42, 42, 41, 40, 39, 38, 37, 36, 35, 34, 33, 32, 31, 30],
  3: [38, 38, 37, 36, 35, 34, 33, 32, 31, 30],
  4: [35, 33, 32, 31, 30],
  5: [30],
};
export function isolementIndicatif(cat, d, tissu = '') {
  const c = CAT[cat];
  if (!c || !(d <= c.largeur)) return null;
  if (/en u/i.test(tissu || '')) return c.u;
  const i = BORNES.findIndex((b) => d <= b);
  const v = ISOLEMENT[cat][i];
  return Math.max(30, v ?? 30);
}

const entier = (v) => { const n = parseInt(String(v ?? '').replace(',', '.'), 10); return Number.isFinite(n) ? n : null; };

// propriétés normalisées (fichier de classement.py, attributs bruts du shapefile ou du WFS)
export function normaliserClassement(p = {}) {
  const cat = entier(p.categorie ?? p.CATEGORIE);
  const fer = /fer/i.test(String(p.source ?? '')) || (p.Vit_VL == null && p.vitesse_vl == null && /^\d{4,}/.test(String(p.NOMROUTE ?? p.nom ?? '')));
  const lc = entier(p.largeur_chaussee_m ?? p.largeurCha);
  return {
    categorie: cat, largeur: entier(p.largeur_m ?? p.LARGEUR) ?? CAT[cat]?.largeur ?? null, chaussee: lc && lc > 0 ? lc : null,
    nom: p.nom ?? p.NOMROUTE ?? null, troncon: p.troncon ?? p.NOMTRONCON ?? null, gestionnaire: p.gestionnaire ?? p.Gestion ?? null,
    tissu: p.tissu ?? p.TISSU ?? '', tmja: entier(p.tmja ?? p.tmjaTV), vitesse: entier(p.vitesse_vl ?? p.Vit_VL),
    source: fer ? 'voies ferrées' : 'routes', id: p.id ?? p.ID ?? null,
  };
}
// libellé lisible d'une voie (« R DE STRASBOURG » → « rue de Strasbourg » ; lignes de tram : « tramway T2 »)
const ABREV = { R: 'rue', BD: 'boulevard', AV: 'avenue', PL: 'place', QU: 'quai', CRS: 'cours', ALL: 'allée', CHS: 'chaussée', PONT: 'pont', RTE: 'route', IMP: 'impasse' };
export function nomVoie(t) {
  if (!t) return '—';
  const s = String(t.nom || '').trim();
  if (t.source === 'voies ferrées') return /^T\d/.test(s) ? `tramway ${s}` : `voie ferrée ${s}`;
  const mots = s.toLowerCase().split(/\s+/);
  const a = ABREV[mots[0]?.toUpperCase()];
  const reste = mots.slice(a ? 1 : 0).map((m, i) => (/^(de|du|des|la|le|les|et|en|sur)$/.test(m) && (i || a) ? m : m.replace(/(^|[-'])(\p{L})/gu, (x, p, l) => p + l.toUpperCase())));
  return [a, ...reste].filter(Boolean).join(' ');
}

export function creerClassementSonore(app, { auChangement = () => {} } = {}) {
  const groupe = new THREE.Group();
  groupe.name = 'classement-sonore';
  app.scene.add(groupe);
  const etat = { fc: null, jeu: null, erreur: null, troncons: [], segments: [], visible: false, charge: false };
  let grille = new Map();
  const CEL = 50;

  // ------------------------------------------------------------
  // Préparation : tronçons et segments en mètres locaux, index des secteurs
  // ------------------------------------------------------------
  function preparer() {
    etat.troncons = []; etat.segments = []; grille = new Map();
    for (const f of etat.fc?.features || []) {
      const q = normaliserClassement(f.properties);
      if (!CAT[q.categorie]) continue;
      const lignes = lignesLocales(f.geometry, app.proj).filter((l) => l.length >= 2);
      if (!lignes.length) continue;
      const t = { ...q, demi: q.source === 'routes' ? (q.chaussee || 0) / 2 : 0, lignes, props: f.properties };
      t.rayon = q.largeur + t.demi; // depuis l'axe
      etat.troncons.push(t);
      for (const l of lignes) for (let i = 0; i < l.length - 1; i++) {
        const [ax, az] = l[i], [bx, bz] = l[i + 1];
        if (Math.hypot(bx - ax, bz - az) < 0.01) continue;
        const s = { ax, az, bx, bz, t, k: etat.segments.length };
        etat.segments.push(s);
        const r = t.rayon;
        for (let i0 = Math.floor((Math.min(ax, bx) - r) / CEL); i0 <= Math.floor((Math.max(ax, bx) + r) / CEL); i0++) {
          for (let j0 = Math.floor((Math.min(az, bz) - r) / CEL); j0 <= Math.floor((Math.max(az, bz) + r) / CEL); j0++) {
            const c = `${i0},${j0}`;
            if (!grille.has(c)) grille.set(c, []);
            grille.get(c).push(s);
          }
        }
      }
    }
  }
  const distSeg = (s, x, z) => {
    const dx = s.bx - s.ax, dz = s.bz - s.az, L2 = dx * dx + dz * dz;
    const u = Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / L2));
    return Math.hypot(x - (s.ax + u * dx), z - (s.az + u * dz));
  };
  // au point (x, z) : tronçons dont le secteur affecté contient le point → [{ t, d (m depuis le bord de chaussée ou l'axe des voies ferrées) }]
  function auPoint(x, z) {
    const vus = new Map();
    for (const s of grille.get(`${Math.floor(x / CEL)},${Math.floor(z / CEL)}`) || []) {
      const d = Math.max(0, distSeg(s, x, z) - s.t.demi);
      if (d > s.t.largeur) continue;
      const v = vus.get(s.t);
      if (v == null || d < v) vus.set(s.t, d);
    }
    return [...vus].map(([t, d]) => ({ t, d }));
  }
  // classement d'un élément (points de façade ou de contour) : catégorie la plus forte (1 = la plus bruyante), puis la voie la plus proche
  function classer(pts) {
    let best = null;
    const toutes = new Set();
    for (const [x, z] of pts) {
      for (const { t, d } of auPoint(x, z)) {
        toutes.add(t.categorie);
        if (!best || t.categorie < best.t.categorie || (t.categorie === best.t.categorie && d < best.d)) best = { t, d };
      }
    }
    if (!best) return null;
    const d = Math.round(best.d);
    return {
      categorie: best.t.categorie, voie: nomVoie(best.t), troncon: best.t.troncon, source: best.t.source, distance: d,
      largeur: best.t.largeur, tissu: best.t.tissu, isolement: isolementIndicatif(best.t.categorie, best.d, best.t.tissu),
      categories: [...toutes].sort((a, b) => a - b),
    };
  }

  // ------------------------------------------------------------
  // Géométrie des secteurs : capsules (segment ± rayon) par catégorie ; contour de leur réunion par échantillonnage
  // ------------------------------------------------------------
  const N_ARC = 12;
  function capsule(s, r) {
    const a = Math.atan2(s.bz - s.az, s.bx - s.ax), pts = [];
    for (let k = 0; k <= N_ARC; k++) { const t = a - Math.PI / 2 + (Math.PI * k) / N_ARC; pts.push([s.bx + r * Math.cos(t), s.bz + r * Math.sin(t)]); }
    for (let k = 0; k <= N_ARC; k++) { const t = a + Math.PI / 2 + (Math.PI * k) / N_ARC; pts.push([s.ax + r * Math.cos(t), s.az + r * Math.sin(t)]); }
    return pts;
  }
  // morceaux du contour de la réunion des secteurs d'une catégorie : [[x1, z1, x2, z2]…]
  function contour(cat) {
    const segs = etat.segments.filter((s) => s.t.categorie === cat);
    const morceaux = [];
    for (const s of segs) {
      const poly = capsule(s, s.t.rayon);
      for (let i = 0; i < poly.length; i++) {
        const [x1, z1] = poly[i], [x2, z2] = poly[(i + 1) % poly.length];
        const L = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.ceil(L / 2));
        for (let j = 0; j < n; j++) {
          const p = [x1 + ((x2 - x1) * j) / n, z1 + ((z2 - z1) * j) / n], q = [x1 + ((x2 - x1) * (j + 1)) / n, z1 + ((z2 - z1) * (j + 1)) / n];
          const mx = (p[0] + q[0]) / 2, mz = (p[1] + q[1]) / 2;
          let dedans = false;
          for (const o of grille.get(`${Math.floor(mx / CEL)},${Math.floor(mz / CEL)}`) || []) {
            if (o === s || o.t.categorie !== cat) continue;
            if (distSeg(o, mx, mz) < o.t.rayon - 0.05) { dedans = true; break; }
          }
          if (!dedans) morceaux.push([p[0], p[1], q[0], q[1]]);
        }
      }
    }
    return morceaux;
  }
  // morceaux bout à bout → polylignes (DXF, SVG)
  function chainer(m) {
    const cle = (x, z) => `${Math.round(x * 20)},${Math.round(z * 20)}`;
    const L = [];
    let cour = null;
    for (const [x1, z1, x2, z2] of m) {
      if (cour && cle(...cour[cour.length - 1]) === cle(x1, z1)) cour.push([x2, z2]);
      else { cour = [[x1, z1], [x2, z2]]; L.push(cour); }
    }
    return L;
  }
  let cacheContours = null;
  const contours = () => {
    if (!cacheContours) cacheContours = Object.fromEntries(CATEGORIES_SONORES.map((c) => [c.n, chainer(contour(c.n))]));
    return cacheContours;
  };
  const categoriesPresentes = () => [...new Set(etat.troncons.map((t) => t.categorie))].sort((a, b) => a - b);

  // ------------------------------------------------------------
  // Dessin 3D (drapé par js/relief.js comme les zones de bruit)
  // ------------------------------------------------------------
  function dessiner() {
    viderGroupe(groupe);
    app.etiquettes?.retirerGroupe('classement-sonore');
    groupe.visible = etat.visible && !!app.couches.bruit;
    if (!etat.troncons.length) return;
    const R = (app.config.rayonEtude || 420) + 60;
    for (const c of CATEGORIES_SONORES) {
      const segs = etat.segments.filter((s) => s.t.categorie === c.n);
      if (!segs.length) continue;
      // secteurs : capsules en éventail ; la catégorie la plus forte est dessinée d'abord et écrit la profondeur (depthFunc Less) :
      // une seule teinte par endroit, sans double transparence
      const pos = [];
      for (const s of segs) {
        const p = capsule(s, s.t.rayon), mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
        for (let i = 0; i < p.length; i++) { const [x1, z1] = p[i], [x2, z2] = p[(i + 1) % p.length]; pos.push(mx, 0.56, mz, x2, 0.56, z2, x1, 0.56, z1); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
        color: c.couleur, transparent: true, opacity: 0.16, depthWrite: true, depthFunc: THREE.LessDepth, side: THREE.DoubleSide,
        polygonOffset: true, polygonOffsetFactor: -15, polygonOffsetUnits: -40 + c.n * 2,
      }));
      m.renderOrder = 7.2 + c.n * 0.01; m.raycast = () => {};
      m.name = `classement-secteur-cat-${c.n}`; m.userData.categorie = c.n;
      groupe.add(m);
      // contour en pointillé
      const lp = [];
      for (const [x1, z1, x2, z2] of contour(c.n)) lp.push(x1, 0.62, z1, x2, 0.62, z2);
      if (lp.length) {
        const gl = new THREE.BufferGeometry();
        gl.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
        const l = new THREE.LineSegments(gl, new THREE.LineDashedMaterial({ color: c.couleur, dashSize: 3, gapSize: 2.5, transparent: true, opacity: 0.95, depthWrite: false }));
        l.computeLineDistances();
        l.renderOrder = 8.1; l.raycast = () => {};
        l.name = `classement-contour-cat-${c.n}`;
        groupe.add(l);
      }
      // tronçons : rubans de 2,5 m dans la couleur de la catégorie
      const rubans = etat.troncons.filter((t) => t.categorie === c.n).flatMap((t) => t.lignes.map((pts) => ({ pts, largeur: 2.5 })));
      const gr = geometrieRubans(rubans, 0.66, { joints: true });
      const mr = new THREE.Mesh(gr, new THREE.MeshBasicMaterial({ color: c.couleur, transparent: true, opacity: 0.95, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -16, polygonOffsetUnits: -60 }));
      mr.renderOrder = 8.2; mr.raycast = () => {};
      mr.name = `classement-troncons-cat-${c.n}`;
      groupe.add(mr);
    }
    // étiquettes de catégorie : une par tronçon, au milieu de sa longueur (périmètre d'étude + 60 m)
    for (const t of etat.troncons) {
      const l = t.lignes.reduce((a, b) => (longueur(b) > longueur(a) ? b : a));
      const p = milieu(l);
      if (!p || Math.hypot(p[0], p[1]) > R) continue;
      const et = app.etiquettes?.ajouter({
        texte: `${t.categorie}`, position: new THREE.Vector3(p[0], 1, p[1]), classe: `etiquette-classement cat-${t.categorie}`,
        groupe: 'classement-sonore', distanceMax: 900, centre: true, visibleSi: () => groupe.visible,
      });
      if (et) et.el.title = `${nomVoie(t)} : catégorie ${t.categorie}, secteur affecté de ${t.largeur} m${t.troncon ? ` (${t.troncon})` : ''}`;
    }
  }
  const longueur = (l) => l.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0), 0);
  function milieu(l) {
    const L = longueur(l) / 2;
    let s = 0;
    for (let i = 1; i < l.length; i++) {
      const d = Math.hypot(l[i][0] - l[i - 1][0], l[i][1] - l[i - 1][1]);
      if (s + d >= L) { const u = (L - s) / d; return [l[i - 1][0] + (l[i][0] - l[i - 1][0]) * u, l[i - 1][1] + (l[i][1] - l[i - 1][1]) * u]; }
      s += d;
    }
    return l[0];
  }

  // ------------------------------------------------------------
  // Chargement : data/classement-sonore.geojson, sinon cache, sinon WFS de Géo-IDE
  // ------------------------------------------------------------
  const WFS = [
    { uuid: 'e6cb14ce-3d1f-4832-840a-31adc2ad4893', couche: 'N_CLASS_SONORE_RTE_L_044', source: 'routes' },
    { uuid: 'cfb6480a-679f-429f-8365-63ddf19c7669', couche: 'N_CLASS_SONORE_FER_L_044', source: 'voies ferrées' },
  ];
  async function lireWFS() {
    const o = app.config.origine, e = empriseAutour(o.lat, o.lon, Math.max(800, app.config.rayonEtude || 0) + 300);
    const features = [];
    let sansGeometrie = 0;
    for (const c of WFS) {
      const url = `https://ogc.geo-ide.developpement-durable.gouv.fr/wxs?map=/opt/data/stack/mapfiles/1.4/org_38030/${c.uuid}.internet.map`
        + `&SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ms:${c.couche}`
        + `&BBOX=${e.sud},${e.ouest},${e.nord},${e.est},urn:ogc:def:crs:EPSG::4326&COUNT=3000`;
      const r = await fetch(url);
      if (!r.ok) throw new Error(`Géo-IDE : réponse ${r.status}`);
      const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
      for (const m of xml.getElementsByTagNameNS('*', 'member')) {
        const el = m.firstElementChild;
        if (!el) continue;
        const props = {};
        for (const x of el.children) if (x.namespaceURI !== 'http://www.opengis.net/gml/3.2' && !x.children.length) props[x.localName] = x.textContent.trim();
        // géométrie : gml:posList en lat lon (EPSG::4326, ordre des axes du CRS) hors de l'enveloppe
        const lignes = [...el.getElementsByTagNameNS('*', 'posList')].map((pl) => {
          const v = pl.textContent.trim().split(/\s+/).map(Number), pts = [];
          for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i + 1], v[i]]);
          return pts;
        }).filter((l) => l.length >= 2);
        if (!lignes.length) { sansGeometrie++; continue; }
        features.push({ type: 'Feature', properties: { ...props, source: c.source }, geometry: { type: 'MultiLineString', coordinates: lignes } });
      }
    }
    if (!features.length) {
      throw new Error(sansGeometrie
        ? `le service WFS de Géo-IDE renvoie ${sansGeometrie} tronçons sans tracé (attributs seuls) : produire data/classement-sonore.geojson avec outils/bruit/classement.py`
        : 'aucun tronçon reçu du service WFS de Géo-IDE');
    }
    return { type: 'FeatureCollection', source: 'Classement sonore 2020, DDTM 44 (service WFS de Géo-IDE), Licence Ouverte 2.0', features };
  }
  function poser(fc, jeu) {
    etat.fc = fc; etat.jeu = jeu; etat.erreur = null; cacheContours = null;
    preparer(); dessiner(); auChangement();
  }
  async function charger({ wfs = false } = {}) {
    etat.charge = true;
    const fc = await fetch('data/classement-sonore.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (fc?.features) { poser(fc, { id: 'fichier', titre: 'data/classement-sonore.geojson' }); return; }
    const cle = `classement-sonore-${app.cleZone}`;
    const cache = await lireCache(cle, 365).catch(() => null);
    if (cache?.features) { poser(cache, { id: 'wfs', titre: 'service WFS de Géo-IDE (cache)' }); return; }
    if (!wfs || !navigator.onLine || app.mode === 'borne') { etat.erreur = 'data/classement-sonore.geojson absent'; auChangement(); return; }
    try {
      const f = await lireWFS();
      await ecrireCache(cle, f);
      poser(f, { id: 'wfs', titre: 'service WFS de Géo-IDE' });
    } catch (e) { etat.erreur = e.message; auChangement(); }
  }
  function definirVisible(v) {
    etat.visible = !!v;
    groupe.visible = etat.visible && !!app.couches.bruit;
    if (etat.visible && !etat.charge) charger({ wfs: true });
    else if (etat.visible && !etat.fc && etat.erreur && !etat.essaiWFS) { etat.essaiWFS = true; charger({ wfs: true }); }
  }
  app.on('couches', () => { groupe.visible = etat.visible && !!app.couches.bruit; });

  // ------------------------------------------------------------
  // Légende, planche, DXF, panneau
  // ------------------------------------------------------------
  const actif = () => etat.visible && !!app.couches.bruit && etat.troncons.length > 0;
  function legende() {
    if (!actif()) return null;
    const P = categoriesPresentes();
    return {
      id: 'classement-sonore', titre: 'Classement sonore des voies (DDTM 44, 2020) : catégorie et secteur affecté',
      items: [
        ...P.map((n) => ({ libelle: `Catégorie ${n} (1 = la plus bruyante), secteur de ${CAT[n].largeur} m`, couleur: CAT[n].couleur, forme: 'trait' })),
        { libelle: 'Limite du secteur affecté par le bruit', couleur: '#555555', forme: 'tirets' },
      ],
      note: 'Voie non classée ≠ voie calme. Secteur compté depuis le bord de la chaussée (axe des voies ferrées) ; isolement des bâtiments neufs : arrêté du 30 mai 1996 modifié.',
    };
  }
  function svg(X, Y) {
    if (!actif()) return '';
    const o = [];
    const C = contours();
    const chemin = (pts) => `M${pts.map(([x, z]) => `${X(x)} ${Y(z)}`).join('L')}`;
    // aplats : catégorie 5 d'abord, catégorie 1 en dernier (la plus forte au-dessus), opacité de groupe
    const aplats = [];
    for (const c of [...CATEGORIES_SONORES].reverse()) {
      const segs = etat.segments.filter((s) => s.t.categorie === c.n);
      if (segs.length) aplats.push(`<path d="${segs.map((s) => `${chemin(capsule(s, s.t.rayon))}Z`).join('')}" fill="${c.couleur}"/>`);
    }
    o.push(`<g id="classement-secteurs" opacity="0.16">${aplats.join('')}</g>`);
    for (const c of CATEGORIES_SONORES) {
      if (C[c.n]?.length) o.push(`<g id="classement-secteur-cat-${c.n}" fill="none" stroke="${c.couleur}" stroke-width="0.3" stroke-dasharray="1.6 1.2">${C[c.n].map((l) => `<path d="${chemin(l)}"/>`).join('')}</g>`);
    }
    for (const c of CATEGORIES_SONORES) {
      const T = etat.troncons.filter((t) => t.categorie === c.n);
      if (T.length) o.push(`<g id="classement-cat-${c.n}" fill="none" stroke="${c.couleur}" stroke-width="0.9" stroke-linecap="round" stroke-linejoin="round">${T.flatMap((t) => t.lignes.map((l) => `<path d="${chemin(l)}"/>`)).join('')}</g>`);
    }
    const txt = etat.troncons.map((t) => {
      const l = t.lignes.reduce((a, b) => (longueur(b) > longueur(a) ? b : a)), p = milieu(l);
      return `<g><circle cx="${X(p[0])}" cy="${Y(p[1])}" r="1.6" fill="#fff" stroke="${CAT[t.categorie].couleur}" stroke-width="0.3"/><text x="${X(p[0])}" y="${Y(p[1])}" font-size="2.2" font-family="Helvetica, Arial, sans-serif" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="${CAT[t.categorie].couleur}">${t.categorie}</text></g>`;
    });
    o.push(`<g id="classement-etiquettes">${txt.join('')}</g>`);
    return o.join('');
  }
  // DXF : polylignes ouvertes { calque, pts } : CLASSEMENT_CAT_n (axes des tronçons), SECTEUR_AFFECTE_CAT_n (limite des secteurs)
  function lignesDXF() {
    if (!actif()) return [];
    const L = [];
    for (const t of etat.troncons) for (const pts of t.lignes) L.push({ calque: `CLASSEMENT_CAT_${t.categorie}`, pts });
    const C = contours();
    for (const c of CATEGORIES_SONORES) for (const pts of C[c.n] || []) L.push({ calque: `SECTEUR_AFFECTE_CAT_${c.n}`, pts });
    return L;
  }
  function infoTexte() {
    return [
      'Classement sonore des infrastructures de transports terrestres de Loire-Atlantique, révision 2020 (arrêtés préfectoraux, DDTM 44 ; data.gouv.fr, Licence Ouverte 2.0) : routes de plus de 5 000 véhicules par jour et voies ferrées (y compris tramway) recensées, rangées en 5 catégories (1 = la plus bruyante).',
      `Niveaux sonores de référence en façade (arrêté du 30 mai 1996 modifié par l'arrêté du 23 juillet 2013, art. 4 ; LAeq 6 h-22 h / 22 h-6 h, dB(A)) : ${CATEGORIES_SONORES.map((c) => `cat. ${c.n} : routes ${c.route[0]} / ${c.route[1]}, voies ferrées conventionnelles ${c.fer[0]} / ${c.fer[1]}, secteur de ${c.largeur} m`).join(' ; ')}.`,
      'Secteur affecté par le bruit : bande de cette largeur de part et d\'autre de la voie, comptée depuis le bord de la chaussée le plus proche (routes) ou le rail le plus proche (voies ferrées) (art. 2). L\'atlas la trace depuis l\'axe du tronçon + la demi-largeur de chaussée du fichier ; pour les voies ferrées, depuis l\'axe (écart de quelques mètres).',
      'Isolement acoustique minimal DnT,A,tr des pièces des logements neufs du secteur (art. 5 et 6, méthode forfaitaire) : au moins 30 dB, selon la catégorie et la distance à la voie. Valeurs de l\'atlas INDICATIVES, À VÉRIFIER : le tableau officiel (JO n° 177 du 01/08/2013, texte 23) n\'a pas pu être lu ; repris du tableau « tissu ouvert » de 1996 (ex. cat. 3 : 38 dB jusqu\'à 15 m, 35 dB à 25-30 m, 30 dB à 80-100 m) ; rue en U : 45, 42, 38, 35, 30 dB (texte de 1996). Corrections non appliquées (angle de vue, écrans, façades latérales ou arrière, plusieurs voies).',
      'Ce n\'est pas une carte de bruit mesuré : le classement est un outil d\'urbanisme (annexé au PLU) pour les constructions neuves. Une voie non classée n\'est pas une voie calme (rue de la Commune, par exemple : trafic sous le seuil de recensement ou non étudiée).',
    ];
  }
  function bloc(rafraichir) {
    const r = etat.troncons, P = categoriesPresentes();
    return [
      h('div', { class: 'titre-info' }, h('h3', {}, 'Classement sonore des voies'), info(...infoTexte())),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.visible, onchange: (e) => { definirVisible(e.target.checked); rafraichir?.(e.target.checked); auChangement(); } }),
        'Classement sonore des voies (catégories, secteurs affectés)'),
      etat.visible && r.length ? h('p', { class: 'bruit-seuil-valeurs', 'data-garder': '' },
        `${r.length} tronçons (${etat.jeu?.titre}) : `, ...P.flatMap((n, i) => [i ? ', ' : '', h('span', { class: 'puce-classement', style: `background:${CAT[n].couleur}` }), ` cat. ${n} (${r.filter((t) => t.categorie === n).length})`]),
        '. Voie non classée ≠ voie calme.') : null,
      etat.visible && !r.length ? h('p', { class: 'note', 'data-garder': '' }, etat.erreur ? `Classement sonore indisponible : ${etat.erreur}.` : 'Lecture du classement sonore…') : null,
    ];
  }

  return { etat, groupe, charger, definirVisible, dessiner, classer, auPoint, legende, svg, lignesDXF, bloc, infoTexte, categoriesPresentes, get actif() { return actif(); } };
}
