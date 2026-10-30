import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { polygonesLocaux, lignesLocales, centroide } from './geo.js';

// Palette de la maquette : l'existant en blanc, la couleur réservée à l'analyse.
export const COULEURS = {
  ciel: 0xdce2e5,
  sol: 0xecedea,
  plateau: 0xf8f8f5,
  maquette: 0xf7f6f2,
  trait: 0x2f3b45,
  voirie: 0xbdc1bf, // chaussée : teinte unique
  cheminement: 0xdcdfdb, // trottoirs, places et chemins piétons : teinte unique, plus claire
  vegetal: 0xd2dccb,
  parking: 0xcfd3d4,
  eau: 0xc9dde4,
  tuffeau: 0xd8cbae,
  fantome: 0x6f86a6,
  coupe: 0xc8372d,
  arbre: 0xc8deb0,
  magnolia: 0x9cc184,
};

// ------------------------------------------------------------------
// Scène, caméra, lumières
// ------------------------------------------------------------------

export function creerScene(app) {
  const canvas = document.getElementById('scene');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, app.mode === 'web' ? 1.5 : 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.localClippingEnabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(COULEURS.ciel);
  scene.fog = new THREE.Fog(COULEURS.ciel, 400, 1200);

  const camera = new THREE.PerspectiveCamera(35, window.innerWidth / window.innerHeight, 0.5, 8000);
  camera.position.set(-260, 230, 320);

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.screenSpacePanning = false;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minDistance = 2;
  controls.maxDistance = 2200;
  controls.target.set(0, 0, 0);

  const hemi = new THREE.HemisphereLight(0xf1f4f6, 0xb9b5aa, 1.35);
  scene.add(hemi);

  const soleil = new THREE.DirectionalLight(0xfff6ea, 2.4);
  soleil.castShadow = true;
  const tailleOmbre = app.mode === 'web' ? 2048 : 4096;
  soleil.shadow.mapSize.set(tailleOmbre, tailleOmbre);
  const r = app.config.rayonEtude * 1.15;
  Object.assign(soleil.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 3000 });
  soleil.shadow.bias = -0.0004;
  soleil.shadow.normalBias = 0.6;
  scene.add(soleil, soleil.target);

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, controls, soleil, hemi };
}

// Le brouillard s'éloigne avec la caméra : le périmètre d'étude reste net, le reste s'efface.
export function majBrouillard(app) {
  const d = app.camera.position.distanceTo(app.controls.target);
  app.scene.fog.near = d + app.config.rayonPlateau * 0.8;
  app.scene.fog.far = d + app.config.rayonEtude * 2.2;
}

// ------------------------------------------------------------------
// Sol et plateau (écho à la maquette circulaire de 42 cm au 1/500)
// ------------------------------------------------------------------

export function creerSol(app) {
  const g = new THREE.Group();
  const { rayonPlateau, rayonEtude } = app.config;

  const sol = new THREE.Mesh(
    new THREE.CircleGeometry(rayonEtude * 3, 96).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: COULEURS.sol, roughness: 1 })
  );
  sol.receiveShadow = true;
  sol.name = 'sol';
  sol.userData.reliefDecalage = -0.6; // relief : grand sol découpé large, glissé sous le sol urbain (pas de plaques au travers)
  g.add(sol);

  const plateau = new THREE.Mesh(
    new THREE.CircleGeometry(rayonPlateau, 128).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: COULEURS.plateau, roughness: 1, polygonOffset: true, polygonOffsetFactor: -1 })
  );
  plateau.position.y = 0.01;
  plateau.receiveShadow = true;
  plateau.userData.reliefPas = 2; // relief : mêmes mailles que le sol urbain
  g.add(plateau);

  const bord = new THREE.Mesh(
    new THREE.RingGeometry(rayonPlateau - 0.25, rayonPlateau + 0.25, 256).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: COULEURS.trait, transparent: true, opacity: 0.45 })
  );
  bord.position.y = 0.05;
  g.add(bord);

  // Épaisseur du plateau, visible seulement en « vue maquette »
  const epaisseur = new THREE.Mesh(
    new THREE.CylinderGeometry(rayonPlateau, rayonPlateau, 8, 128, 1, true),
    new THREE.MeshStandardMaterial({ color: 0xe9e6de, roughness: 1, side: THREE.DoubleSide })
  );
  epaisseur.position.y = -4;
  epaisseur.visible = false;
  g.add(epaisseur);

  app.scene.add(g);
  app.sol = { groupe: g, sol, plateau, bord, epaisseur };
  return app.sol;
}

// ------------------------------------------------------------------
// Bâti
// ------------------------------------------------------------------

export function hauteurBatiment(p, cfg) {
  const lire = (v) => parseFloat(String(v ?? '').replace(',', '.'));
  const h = lire(p.hauteur ?? p.height);
  if (Number.isFinite(h) && h > 0) return h;
  const niv = lire(p.niveaux ?? p['building:levels']);
  const toit = lire(p['roof:levels']) || 0;
  if (Number.isFinite(niv) && niv > 0) return niv * cfg.hauteurNiveau + toit * cfg.hauteurNiveau * 0.8;
  if (p.building === 'roof') return 4;
  return cfg.hauteurParDefaut;
}

export function baseBatiment(p, cfg) {
  const lire = (v) => parseFloat(String(v ?? '').replace(',', '.'));
  const mh = lire(p.min_height);
  if (Number.isFinite(mh)) return mh;
  const ml = lire(p['building:min_level']);
  if (Number.isFinite(ml)) return ml * cfg.hauteurNiveau;
  if (p.building === 'roof') return 3.5;
  return 0;
}

export function geometriesExtrudees(polys, hauteur, base = 0) {
  const geos = [];
  for (const [ext, ...trous] of polys) {
    if (!ext || ext.length < 3 || hauteur <= 0) continue;
    const forme = new THREE.Shape(ext.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const t of trous) if (t.length >= 3) forme.holes.push(new THREE.Path(t.map(([x, z]) => new THREE.Vector2(x, -z))));
    try {
      const geo = new THREE.ExtrudeGeometry(forme, { depth: hauteur, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      geo.translate(0, base, 0);
      geo.clearGroups();
      geos.push(geo);
    } catch { /* polygone dégénéré ignoré */ }
  }
  return geos;
}

export function geometriesPlates(polys, y = 0) {
  const geos = [];
  for (const [ext, ...trous] of polys) {
    if (!ext || ext.length < 3) continue;
    const forme = new THREE.Shape(ext.map(([x, z]) => new THREE.Vector2(x, -z)));
    for (const t of trous) if (t.length >= 3) forme.holes.push(new THREE.Path(t.map(([x, z]) => new THREE.Vector2(x, -z))));
    const geo = new THREE.ShapeGeometry(forme);
    geo.rotateX(-Math.PI / 2);
    geo.translate(0, y, 0);
    geos.push(geo);
  }
  return geos;
}

export function aretes(geo, opacite = 0.3, couleur = COULEURS.trait) {
  const lignes = new THREE.LineSegments(
    new THREE.EdgesGeometry(geo, 25),
    new THREE.LineBasicMaterial({ color: couleur, transparent: true, opacity: opacite })
  );
  lignes.raycast = () => {};
  return lignes;
}

function testRemarquable(r, p) {
  if (r.osm && p.osm === r.osm) return true;
  if (r.tag && p[r.tag] === r.valeur) return true;
  if (r.nom) {
    const re = new RegExp(r.nom, 'i');
    return re.test(p.name || '') || re.test(p.nom || '');
  }
  return false;
}

// Construit le bâti existant. Les bâtiments sont regroupés par catégorie (fusion des géométries)
// pour rester fluide, sauf les bâtiments remarquables qui restent cliquables individuellement.
export function construireBatiments(app, geojson) {
  const cfg = app.config;
  const groupe = new THREE.Group();
  groupe.name = 'batiments';
  const apres1943 = new Set(cfg.temps?.apres1943 || []);
  const categories = new Map();
  const remarquables = [];
  const empreintes = []; // pour le calcul d'ensoleillement : {polys, hauteur, base, cle}

  // Toitures détaillées (js/toits.js : mairie, îlot Saint-Vincent…) : corps de bâtiment affectés aux bâtiments chargés
  const lots = geojson.features.map((f) => ({ f, polys: polygonesLocaux(f.geometry, app.proj) }));
  const details = app.toits?.assigner(lots) || new Map();
  const remMairie = (cfg.remarquables || []).find((r) => r.id === 'mairie');

  for (const lot of lots) {
    const { f, polys } = lot;
    const p = f.properties || {};
    if (!polys.length || polys[0][0].length < 3) continue;
    const [cx, cz] = centroide(polys[0][0]);
    const dist = Math.hypot(cx, cz);
    if (dist > cfg.rayonEtude * 1.15) continue;

    const corpsDetail = details.get(lot);
    // bâtiment détaillé : remarquable de config (mairie) ou de son ensemble (data/toits/<id>.json > remarquable)
    const rem = (cfg.remarquables || []).find((r) => testRemarquable(r, p)) || (corpsDetail ? (app.toits.remarquable?.(corpsDetail) || remMairie) : undefined);
    const mesuree = p.source === 'BD TOPO' && Number.isFinite(parseFloat(p.hauteur));
    // détaillé : emprise d'origine, hauteur maximale des corps (faîtage) pour le bâti effectif
    const hauteurCalculee = corpsDetail ? app.toits.hauteurMax(corpsDetail) : mesuree ? hauteurBatiment(p, cfg) : (rem?.hauteur ?? hauteurBatiment(p, cfg));
    // hauteur corrigée à la main (outil Hauteurs, data/hauteurs.json) : bâtiments simples seulement
    const corrigee = corpsDetail ? null : app.hauteurs?.valeur(p.osm || p.id_ign, cx, cz);
    const hauteur = corrigee ?? hauteurCalculee;
    const base = corpsDetail ? 0 : baseBatiment(p, cfg);
    const id = p.osm || p.id_ign;
    const annee = parseInt(String(p.start_date || p.date_apparition || '').slice(0, 4), 10);
    const post = apres1943.has(id) || (Number.isFinite(annee) && annee >= 1944 && p.source !== 'BD TOPO');
    const plateau = dist <= cfg.rayonPlateau;
    const geos = corpsDetail ? app.toits.geometries(corpsDetail) : geometriesExtrudees(polys, Math.max(hauteur - base, 0.5), base);
    if (!geos.length) continue;
    const cle = `${post ? 'P' : ''}${plateau ? 'I' : 'E'}`;
    // couleur par sommet (blanc par défaut, teintes des matériaux pour la mairie détaillée),
    // pour pouvoir colorer chaque bâtiment après la fusion
    let nb = 0;
    for (const g of geos) {
      const n = g.getAttribute('position').count;
      if (!corpsDetail) g.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(n * 3).fill(1), 3));
      nb += n;
    }
    const empreinte = { polys, hauteur, base, cle, rem: !!rem, id, nom: p.name || rem?.etiquette || null, cx, cz, nb, mesh: null, debut: 0 };
    if (corrigee != null) { empreinte.hauteurOrigine = hauteurCalculee; empreinte.corrigee = true; }
    if (corpsDetail) {
      empreinte.detail = { corps: corpsDetail };
      empreinte.hauteurEn = app.toits.fonctionHauteur(geos);
      empreinte.facades = app.toits.facadesPhoto?.(geos) || []; // photos de façade sur rue (data/facades/)
    }
    empreintes.push(empreinte);

    if (rem) {
      remarquables.push({ r: rem, geos, p, hauteur, cx, cz, cle, empreinte });
    } else {
      if (!categories.has(cle)) categories.set(cle, []);
      categories.get(cle).push({ geos, empreinte });
    }
  }

  const matCourant = new THREE.MeshStandardMaterial({ color: COULEURS.maquette, roughness: 0.92, metalness: 0, vertexColors: true });
  const matRemarquable = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, vertexColors: true });
  app.materiaux = { ...(app.materiaux || {}), batiment: matCourant, remarquable: matRemarquable };

  const enregistrer = (mesh, cle) => {
    mesh.userData.cle = cle;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    groupe.add(mesh);
    app.temps?.enregistrer(mesh, (a) => visibiliteBatiment(a, cle), 'hauteur');
  };

  for (const [cle, lots] of categories) {
    const geos = lots.flatMap((l) => l.geos);
    const geo = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(geo, matCourant);
    let debut = 0;
    for (const { empreinte } of lots) { empreinte.mesh = mesh; empreinte.debut = debut; debut += empreinte.nb; }
    mesh.add(aretes(geo, cle.includes('I') ? 0.3 : 0.16));
    enregistrer(mesh, cle);
  }

  const etiquetes = new Set();
  for (const { r, geos, p, hauteur, cx, cz, cle, empreinte } of remarquables) {
    const geo = mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    const mesh = new THREE.Mesh(geo, matRemarquable);
    empreinte.mesh = mesh;
    empreinte.debut = 0;
    if (empreinte.detail) {
      // teintes d'origine, rétablies par colorierBatiments ; arêtes fines et lignes d'étages
      empreinte.couleurs = geo.getAttribute('color').array.slice();
      mesh.add(app.toits.aretesDetail(geo));
      const etages = app.toits.lignesEtages(empreinte.detail.corps);
      if (etages) mesh.add(etages);
      for (const f of empreinte.facades || []) mesh.add(f);
      mesh.userData.detail = true;
    } else mesh.add(aretes(geo, 0.62));
    mesh.userData.fiche = r.fiche;
    mesh.userData.nom = r.etiquette || p.name || r.nom || r.id;
    enregistrer(mesh, cle);
    app.pickables.push(mesh);
    if (r.etiquette && !etiquetes.has(r.id)) {
      etiquetes.add(r.id);
      // mairie en plusieurs bâtiments : étiquette au centre de l'ensemble (périmètre des toitures détaillées)
      const centreMairie = r.id === 'mairie' ? app.toits?.centre?.() : null;
      const hEtiquette = centreMairie ? Math.max(...remarquables.filter((x) => x.r.id === 'mairie').map((x) => x.hauteur)) : hauteur;
      const [ex, ez] = centreMairie || [cx, cz];
      app.etiquettes.ajouter({
        texte: r.etiquette,
        position: new THREE.Vector3(ex, hEtiquette + 4, ez),
        classe: 'etiquette-repere',
        fiche: r.fiche,
        groupe: 'batiments',
      });
    }
  }

  app.scene.add(groupe);
  app.empreintes = empreintes;
  return groupe;
}

export function visibiliteBatiment(app, cle) {
  // vue maquette : avec la découpe (js/decoupe.js) tout le bâti reste et est coupé au bord ; sans elle, bâtiments
  // dont le centre est hors du plateau masqués (ancienne vue maquette)
  if (app.vueMaquette && cle.includes('E') && !app.decoupe?.disponible) return false;
  if (app.etat === 'avant' && cle.includes('P')) return false;
  return true;
}

// ------------------------------------------------------------------
// Textures procédurales (joints de pavés, hachures)
// ------------------------------------------------------------------

export function textureHachures(couleur = 'rgba(47,59,69,0.55)', pas = 16, fond = null) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  if (fond) { x.fillStyle = fond; x.fillRect(0, 0, 64, 64); }
  x.strokeStyle = couleur;
  x.lineWidth = 2;
  for (let i = -64; i < 128; i += pas) { x.beginPath(); x.moveTo(i, 64); x.lineTo(i + 64, 0); x.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function texturePaves(fond = '#d6cdbb', joint = 'rgba(90,80,60,0.35)') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = fond; x.fillRect(0, 0, 128, 128);
  x.strokeStyle = joint; x.lineWidth = 2;
  for (let r = 0; r < 4; r++) {
    const y = r * 32;
    x.beginPath(); x.moveTo(0, y); x.lineTo(128, y); x.stroke();
    for (let k = 0; k < 3; k++) {
      const xx = k * 48 + (r % 2 ? 24 : 0);
      x.beginPath(); x.moveTo(xx, y); x.lineTo(xx, y + 32); x.stroke();
    }
  }
  // joints enherbés, pour la perméabilité
  x.fillStyle = 'rgba(110,150,90,0.35)';
  for (let i = 0; i < 40; i++) x.fillRect(Math.random() * 128, Math.floor(Math.random() * 4) * 32 - 1, 3, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function textureHerbe(fond = '#9dba7a') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const x = c.getContext('2d');
  x.fillStyle = fond; x.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 900; i++) {
    x.fillStyle = Math.random() > 0.5 ? 'rgba(70,110,60,0.25)' : 'rgba(210,230,170,0.25)';
    x.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ------------------------------------------------------------------
// Voirie et surfaces au sol
// ------------------------------------------------------------------

const LARGEURS = {
  primary: 12, secondary: 10, tertiary: 8, residential: 6.5, unclassified: 6, living_street: 5.5,
  pedestrian: 6, service: 4, footway: 2.5, path: 2, cycleway: 2, steps: 2.5, busway: 7,
};

// joints : disque à chaque sommet (raccords des tronçons, carrefours et extrémités sans vide)
export function geometrieRubans(lignes, y, { joints = false } = {}) {
  const pos = [];
  const N = 16;
  for (const { pts, largeur } of lignes) {
    const w = largeur / 2;
    if (joints) {
      for (const [x, z] of pts) {
        for (let k = 0; k < N; k++) {
          const t1 = (k / N) * 2 * Math.PI, t2 = ((k + 1) / N) * 2 * Math.PI;
          pos.push(x, y, z, x + w * Math.cos(t2), y, z + w * Math.sin(t2), x + w * Math.cos(t1), y, z + w * Math.sin(t1));
        }
      }
    }
    for (let i = 1; i < pts.length; i++) {
      const [x1, z1] = pts[i - 1];
      const [x2, z2] = pts[i];
      const dx = x2 - x1, dz = z2 - z1;
      const l = Math.hypot(dx, dz);
      if (l < 0.05) continue;
      const nx = (-dz / l) * w, nz = (dx / l) * w;
      const a = [x1 + nx, y, z1 + nz], b = [x1 - nx, y, z1 - nz], c = [x2 + nx, y, z2 + nz], d = [x2 - nx, y, z2 - nz];
      pos.push(...a, ...c, ...b, ...b, ...c, ...d);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  // normales toujours vers le haut
  const n = geo.getAttribute('normal');
  for (let i = 0; i < n.count; i++) n.setXYZ(i, 0, 1, 0);
  return geo;
}

// Sol urbain en trois couches opaques, chacune d'une seule teinte et d'un seul matériau (pas de recouvrement visible) :
// trottoirs (cheminements piétons, places, bande de trottoir de part et d'autre des chaussées, qui comble l'espace
// entre chaussée et bâti) < chaussée (rubans des voies et surfaces de voirie) < espaces verts, eau, stationnement.
// L'ordre est donné par la hauteur (plateau 0,01 < trottoirs 0,03 < chaussées 0,055 < végétal, eau, parkings 0,07 à 0,08 < noms des
// rues 0,1 m) et par polygonOffset ; les réseaux (-7 à -9, 0,10 m et plus) passent au-dessus. Avec le relief, toutes ces surfaces sont
// découpées en mailles de 2 m sur le plateau, 6 m au-delà (userData.reliefPas) : elles suivent le terrain de la même façon et gardent leur ordre.
export const LARGEUR_TROTTOIR = 2.5;
const materiauxSol = {};
export function materiauSol(couche) {
  if (!materiauxSol[couche]) {
    const defs = { trottoir: [COULEURS.cheminement, -3], chaussee: [COULEURS.voirie, -4] };
    const [couleur, o] = defs[couche];
    materiauxSol[couche] = new THREE.MeshStandardMaterial({ color: couleur, roughness: 1, polygonOffset: true, polygonOffsetFactor: o, polygonOffsetUnits: o * 2 });
  }
  return materiauxSol[couche];
}

export function construireVoirie(app, geojson) {
  const chaussees = [], chemins = [];
  const limite = app.config.rayonEtude * 1.3;
  for (const f of geojson.features) {
    const hw = f.properties?.highway;
    if (!hw || f.properties?.tunnel === 'yes' || f.properties?.layer < 0) continue;
    const largeur = LARGEURS[hw] ?? 3;
    for (const pts of lignesLocales(f.geometry, app.proj)) {
      if (!pts.some(([x, z]) => Math.hypot(x, z) < limite)) continue;
      (largeur >= 4 && hw !== 'pedestrian' ? chaussees : chemins).push({ pts, largeur });
    }
  }
  // bande de trottoir sous chaque chaussée (élargie de part et d'autre)
  const trottoirs = chemins.concat(chaussees.map(({ pts, largeur }) => ({ pts, largeur: largeur + 2 * LARGEUR_TROTTOIR })));
  const g = new THREE.Group();
  g.name = 'voirie';
  const mk = (lignes, couche, y, nom) => {
    if (!lignes.length) return;
    const m = new THREE.Mesh(geometrieRubans(lignes, y, { joints: true }), materiauSol(couche));
    m.name = nom;
    m.receiveShadow = true;
    m.raycast = () => {};
    m.userData.reliefPas = 2;
    g.add(m);
  };
  mk(trottoirs, 'trottoir', 0.03, 'trottoirs');
  mk(chaussees, 'chaussee', 0.055, 'chaussees');
  app.scene.add(g);
  return g;
}

export function construireSurfaces(app, geojson) {
  const g = new THREE.Group();
  g.name = 'surfaces';
  const parType = { vegetal: [], parking: [], pietonne: [], voirie: [], eau: [] };
  const parkingsPlateau = [];
  for (const f of geojson.features) {
    const type = f.properties?.surface;
    if (!parType[type]) continue;
    const polys = polygonesLocaux(f.geometry, app.proj);
    if (!polys.length) continue;
    const [cx, cz] = centroide(polys[0][0]);
    if (Math.hypot(cx, cz) > app.config.rayonEtude * 1.2) continue;
    if (type === 'parking' && Math.hypot(cx, cz) <= app.config.rayonPlateau) parkingsPlateau.push(polys);
    else parType[type].push(...polys);
  }
  const hachures = textureHachures('rgba(47,59,69,0.28)', 12, '#cfd3d4');
  hachures.repeat.set(1 / 3, 1 / 3);
  const defs = {
    voirie: { couche: 'chaussee', y: 0.055 },
    pietonne: { couche: 'trottoir', y: 0.03 },
    vegetal: { couleur: COULEURS.vegetal, y: 0.07 },
    eau: { couleur: COULEURS.eau, y: 0.075 },
    parking: { couleur: 0xffffff, y: 0.08, map: hachures },
  };
  const creer = (polys, def, nom) => {
    const geos = polys.flatMap((p) => geometriesPlates([p], def.y));
    if (!geos.length) return null;
    const m = new THREE.Mesh(
      mergeGeometries(geos, false),
      def.couche ? materiauSol(def.couche)
        : new THREE.MeshStandardMaterial({ color: def.couleur, map: def.map || null, roughness: 1, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 })
    );
    m.receiveShadow = true;
    m.name = nom;
    m.raycast = () => {};
    m.userData.reliefPas = 2;
    g.add(m);
    return m;
  };
  for (const [type, polys] of Object.entries(parType)) creer(polys, defs[type], type);
  const pk = creer(parkingsPlateau, defs.parking, 'parkings-plateau');
  if (pk) {
    pk.userData.nom = 'Stationnement de surface';
    // Les parkings de surface du plateau disparaissent dans l'état « avant 1943 ».
    app.temps?.enregistrer(pk, (a) => a.etat === 'actuel', 'aucune');
  }
  app.scene.add(g);
  return g;
}

// ------------------------------------------------------------------
// Arbres : patrimoine arboré de Nantes Métropole (data/arbres-nantes.geojson), arbres relevés (data/arbres.geojson)
// et OpenStreetMap ; feuillage des caducs selon la date (feuillage), branches nues l'hiver.
// ------------------------------------------------------------------

export const ATTRIBUTION_ARBRES = 'Patrimoine arboré, Nantes Métropole et Ville de Nantes (data.nantesmetropole.fr) — Licence Ouverte';

// Genres persistants (feuillage toute l'année) ; espèces persistantes de genres surtout caducs.
// Mélèzes, métaséquoias, cyprès chauves et ginkgos sont des conifères (ou assimilés) caducs.
const GENRES_PERSISTANTS = new Set(['abies', 'acacia', 'araucaria', 'arbutus', 'calocedrus', 'cedrus', 'chamaecyparis', 'chamaerops', 'cinnamomum',
  'cryptomeria', 'cupressocyparis', 'cupressus', 'elaeagnus', 'eriobotrya', 'eucalyptus', 'ilex', 'juniperus', 'laurus', 'ligustrum', 'olea',
  'phillyrea', 'phoenix', 'photinia', 'picea', 'pinus', 'pittosporum', 'pseudotsuga', 'sequoia', 'sequoiadendron', 'taxus', 'thuja', 'trachycarpus',
  'tsuga', 'washingtonia', 'xcupressocyparis']);
const ESPECES_PERSISTANTES = ['quercus ilex', 'quercus suber', 'quercus coccifera', 'prunus laurocerasus', 'prunus lusitanica', 'magnolia grandiflora', 'magnolia delavay'];
const CONIFERES_CADUCS = new Set(['larix', 'metasequoia', 'taxodium', 'ginkgo', 'glyptostrobus', 'pseudolarix']);
const sansAccents = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Lot d'un arbre : 'magnolia' (magnolias persistants), 'persistant' ou 'caduc', d'après le genre et l'espèce ;
// un arbre relevé à la main garde son champ « caduc » s'il est renseigné.
export function classerArbre(p, source) {
  const espece = sansAccents(`${p.espece || ''} ${p.species || ''} ${p['species:fr'] || ''}`).replace(/\s+/g, ' ').trim();
  const genre = sansAccents(p.genre || p.genus || espece.split(' ')[0]).replace(/[^a-z]/g, '');
  const magnolia = genre === 'magnolia' || espece.includes('magnolia');
  if (source === 'releve' && p.caduc != null) {
    const caduc = p.caduc === true || p.caduc === 'oui';
    return caduc ? 'caduc' : magnolia ? 'magnolia' : 'persistant';
  }
  if (magnolia) {
    // « Magnolia » sans espèce : lot magnolia, comme les relevés d'origine (M. grandiflora, le plus planté à Nantes)
    const precise = espece.replace(/magnolia/g, '').replace(/[^a-z]/g, '');
    return !precise || ESPECES_PERSISTANTES.some((e) => e.startsWith('magnolia') && espece.includes(e)) ? 'magnolia' : 'caduc';
  }
  if (GENRES_PERSISTANTS.has(genre) || ESPECES_PERSISTANTES.some((e) => espece.includes(e))) return 'persistant';
  if (p.leaf_cycle === 'evergreen') return 'persistant';
  if (p.leaf_cycle === 'deciduous' || CONIFERES_CADUCS.has(genre)) return 'caduc';
  if (p.leaf_type === 'needleleaved') return 'persistant';
  return 'caduc';
}

// Facteur de feuillage des arbres caducs, de 0 (branches nues) à 1 (pleine feuille), selon le jour de l'année :
// débourrement du 1er au 30 avril, pleine feuille jusqu'au 15 octobre, chute du 15 octobre au 15 novembre.
// Accepte un Date (date locale), un jour de l'année (1-366) ou { mois (0-11), jour }.
const J_DEBOURREMENT = [91, 120], J_CHUTE = [288, 319]; // 1er avril, 30 avril ; 15 octobre, 15 novembre (année non bissextile)
const lisse = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
export function feuillage(date) {
  let j;
  if (typeof date === 'number') j = date;
  else if (date instanceof Date) j = Math.floor((Date.UTC(2001, date.getMonth(), date.getDate()) - Date.UTC(2001, 0, 0)) / 86400000);
  else if (date && date.mois != null) j = Math.floor((Date.UTC(2001, date.mois, date.jour || 1) - Date.UTC(2001, 0, 0)) / 86400000);
  else return 1;
  if (j < J_DEBOURREMENT[0] || j >= J_CHUTE[1]) return 0;
  if (j < J_DEBOURREMENT[1]) return lisse(J_DEBOURREMENT[0], J_DEBOURREMENT[1], j);
  if (j >= J_CHUTE[0]) return 1 - lisse(J_CHUTE[0], J_CHUTE[1], j);
  return 1;
}
// Part de la lumière directe qui traverse la couronne (Chaleur) : persistants 12 % toute l'année,
// caducs de 12 % (en feuilles) à 65 % (branches nues).
export const TRANSMISSION_ARBRE = { feuille: 0.12, nu: 0.65 };
export const transmissionCaduc = (f) => TRANSMISSION_ARBRE.nu + (TRANSMISSION_ARBRE.feuille - TRANSMISSION_ARBRE.nu) * f;

// Sources fusionnées dans l'ordre de priorité : relevés > Nantes Métropole > OpenStreetMap
export const sourcesArbres = (app) => ({ releves: app.donnees.arbres, nantes: app.donnees.arbresNantes, osm: app.donnees.osm?.arbres });

// graine pseudo-aléatoire stable par arbre (branches)
function aleatoire(graine) {
  let s = graine >>> 0 || 1;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export function construireArbres(app, sources = sourcesArbres(app)) {
  const ancien = app.arbres;
  if (ancien?.groupe) {
    app.scene.remove(ancien.groupe);
    app.pickables = app.pickables.filter((p) => p.parent !== ancien.groupe);
    ancien.groupe.traverse((o) => { if (o.isInstancedMesh) o.dispose(); });
    for (const g of ancien.geometries || []) g.dispose();
    for (const m of [...Object.values(ancien.materiaux || {}), ancien.matTronc]) m?.dispose();
  }
  const g = new THREE.Group();
  g.name = 'arbres';
  const lots = { caduc: [], persistant: [], magnolia: [] };
  const R = app.config.rayonEtude * 1.1;
  const pris = { releve: [], nantes: [], osm: [] };
  const proche = (liste, x, z, d) => liste.some((v) => Math.abs(v[0] - x) < d && Math.abs(v[1] - z) < d && Math.hypot(v[0] - x, v[1] - z) < d);
  const ordre = [['releve', sources.releves], ['nantes', sources.nantes], ['osm', sources.osm]];
  for (const [source, col] of ordre) {
    for (const f of col?.features || []) {
      if (f.geometry?.type !== 'Point') continue;
      const p = f.properties || {};
      const [x, z] = app.proj.pt(f.geometry.coordinates);
      if (Math.hypot(x, z) > R) continue;
      // un arbre relevé remplace tout arbre voisin à moins de 2 m ; un arbre OSM est ignoré à moins de 3 m d'un arbre de Nantes
      if (proche(pris.releve, x, z, 2)) continue;
      if (source === 'osm' && (proche(pris.nantes, x, z, 3) || proche(pris.osm, x, z, 2))) continue;
      pris[source].push([x, z]);
      const lot = classerArbre(p, source);
      const estMagnolia = lot === 'magnolia' || /magnolia/i.test(`${p.espece || ''} ${p.genre || ''} ${p.genus || ''} ${p.species || ''}`);
      const h = parseFloat(p.hauteur ?? p.height) || (estMagnolia ? 9 : 12);
      const d = Math.min(parseFloat(p.diametre ?? p.diameter_crown) || h * 0.6, h * 1.2);
      const espece = p.espece || p.species || p['species:fr'] || p.genre || p.genus || null;
      lots[lot].push({
        x, z, h, d, lot, source, espece, genre: p.genre || p.genus || (source === 'nantes' && espece ? espece.split(' ')[0] : null), magnolia: estMagnolia, fiche: p.fiche,
        nom: p.nom || espece || (estMagnolia ? 'Magnolia' : null),
        gestionnaire: p.proprietaire ? (p.proprietaire === 'Nantes' ? 'Ville de Nantes' : p.proprietaire) : null,
        classe: p.hauteur_classe || null, couronneEstimee: p.diametre_estime || null, stade: p.stade || null,
        plantation: p.annee_plantation || p.start_date || null, inventaire: p.date_inventaire || null,
        id: p.id_emplacement ?? p.osm ?? null, attribution: p.attribution || null, feature: source === 'releve' ? f : null,
        graine: Number(p.id_emplacement) || Math.round(Math.abs(x * 7919 + z * 104729)) || 1,
      });
    }
  }

  for (const liste of Object.values(lots)) liste.sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
  // arbres schématiques : une boule lisse sur un tronc fin, comme dans une maquette d'architecte ;
  // caducs : squelette (tronc prolongé, 4 à 6 branches maîtresses et 2 rameaux chacune) visible quand ils perdent leurs feuilles
  const couronne = new THREE.SphereGeometry(1, 16, 10);
  const tronc = new THREE.CylinderGeometry(0.12, 0.18, 1, 6).translate(0, 0.5, 0);
  const branche = new THREE.CylinderGeometry(0.55, 1, 1, 5, 1, true).translate(0, 0.5, 0);
  const matTronc = new THREE.MeshStandardMaterial({ color: 0xb8b3a6, roughness: 1 });
  const matBranches = new THREE.MeshStandardMaterial({ color: 0xa39d90, roughness: 1 });
  const mats = {
    caduc: new THREE.MeshStandardMaterial({ color: COULEURS.arbre, roughness: 1, transparent: true, opacity: 1 }),
    persistant: new THREE.MeshStandardMaterial({ color: 0xb9d3a0, roughness: 1 }),
    magnolia: new THREE.MeshStandardMaterial({ color: COULEURS.magnolia, roughness: 0.9 }),
    branches: matBranches,
  };
  const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3(), haut = new THREE.Vector3(0, 1, 0);
  const meshes = {};
  for (const [lot, liste] of Object.entries(lots)) {
    if (!liste.length) continue;
    const c = new THREE.InstancedMesh(couronne, mats[lot], liste.length);
    const t = new THREE.InstancedMesh(tronc, matTronc, liste.length);
    liste.forEach((a, i) => {
      a.k = Math.min(1.6, Math.max(0.7, a.h / 12)); // grosseur du tronc
      m4.compose(v.set(a.x, a.h * 0.62, a.z), q.identity(), s.set(a.d / 2, a.h * 0.38, a.d / 2));
      c.setMatrixAt(i, m4);
      m4.compose(v.set(a.x, 0, a.z), q.identity(), s.set(a.k, a.h * 0.45, a.k));
      t.setMatrixAt(i, m4);
    });
    c.castShadow = t.castShadow = true;
    c.receiveShadow = true;
    c.userData.lot = lot;
    c.userData.arbres = liste;
    c.userData.interieurs = liste.filter((a) => Math.hypot(a.x, a.z) <= app.config.rayonPlateau).length;
    c.userData.tronc = t;
    g.add(c, t);
    meshes[lot] = c;
    app.pickables.push(c); // fiche de chaque arbre au clic (js/interface.js : userData.arbres[instanceId])
  }

  // branches des caducs (une seule géométrie instanciée)
  const caducs = lots.caduc;
  if (caducs.length) {
    const segs = [];
    const debut = new Int32Array(caducs.length + 1);
    // longueur jusqu'à l'enveloppe de la couronne (ellipsoïde centré à 0,62 h, demi-axes d/2 et 0,38 h) depuis le point P selon u
    const versEnveloppe = (a, px, py, pz, ux, uy, uz) => {
      const rx = a.d / 2, ry = a.h * 0.38, cy = a.h * 0.62;
      const X = px / rx, Y = (py - cy) / ry, Z = pz / rx, U = ux / rx, V = uy / ry, W = uz / rx;
      const A = U * U + V * V + W * W, B = 2 * (X * U + Y * V + Z * W), C = X * X + Y * Y + Z * Z - 1;
      const disc = B * B - 4 * A * C;
      return disc > 0 ? Math.max(0.3, (-B + Math.sqrt(disc)) / (2 * A)) : 0.5;
    };
    caducs.forEach((a, i) => {
      debut[i] = segs.length;
      const r = aleatoire(a.graine);
      const y0 = a.h * (0.36 + 0.08 * r());
      const rb = 0.075 * a.k;
      // flèche : prolonge le tronc vers le haut de la couronne
      const lf = versEnveloppe(a, 0, a.h * 0.43, 0, 0, 1, 0) * 0.85;
      segs.push([a, 0, a.h * 0.43, 0, (r() - 0.5) * 0.15, 1, (r() - 0.5) * 0.15, lf, 0.09 * a.k]);
      const n = 4 + Math.floor(r() * 3);
      const az0 = r() * Math.PI * 2;
      for (let b = 0; b < n; b++) {
        const az = az0 + (b / n) * Math.PI * 2 + (r() - 0.5) * 0.7;
        const el = (30 + r() * 35) * (Math.PI / 180);
        const ux = Math.cos(el) * Math.cos(az), uy = Math.sin(el), uz = Math.cos(el) * Math.sin(az);
        const yb = y0 + (r() - 0.5) * a.h * 0.06;
        const L = versEnveloppe(a, 0, yb, 0, ux, uy, uz) * 0.88;
        segs.push([a, 0, yb, 0, ux, uy, uz, L, rb]);
        for (const signe of [-1, 1]) {
          const u = 0.45 + r() * 0.2;
          const px = ux * L * u, py = yb + uy * L * u, pz = uz * L * u;
          const az2 = az + signe * (0.45 + r() * 0.35), el2 = Math.min(1.35, el + 0.15 + r() * 0.25);
          const vx = Math.cos(el2) * Math.cos(az2), vy = Math.sin(el2), vz = Math.cos(el2) * Math.sin(az2);
          segs.push([a, px, py, pz, vx, vy, vz, versEnveloppe(a, px, py, pz, vx, vy, vz) * 0.85, rb * 0.55]);
        }
      }
    });
    debut[caducs.length] = segs.length;
    const B = new THREE.InstancedMesh(branche, matBranches, segs.length);
    segs.forEach(([a, px, py, pz, ux, uy, uz, L, rr], j) => {
      v.set(ux, uy, uz).normalize();
      q.setFromUnitVectors(haut, v);
      m4.compose(v.set(a.x + px, py, a.z + pz), q, s.set(rr, L, rr));
      B.setMatrixAt(j, m4);
    });
    B.name = 'arbres-branches';
    B.castShadow = true;
    B.userData.debut = debut;
    B.visible = false;
    meshes.caduc.userData.branches = B;
    g.add(B);
  }
  app.scene.add(g);
  app.arbres = { groupe: g, lots, meshes, materiaux: mats, matTronc, geometries: [couronne, tronc, branche], f: 1, hiver: false, echelle: 1 };
  appliquerFeuillage(app, ancien?.f ?? 1, true);
  if (app.vueMaquette) arbresVueMaquette(app, true);
  return g;
}

// Affichage selon le facteur de feuillage f des caducs : couronne réduite (60 % à nu) et de plus en plus transparente,
// masquée sous f ≈ 0,17 (toujours cliquable) ; ombre portée de la couronne si f ≥ 0,5 ; branches visibles sous f = 0,97.
export function appliquerFeuillage(app, f, force = false) {
  const A = app.arbres;
  if (!A) return;
  if (!force && Math.abs((A.f ?? -1) - f) < 0.002) return;
  A.f = f;
  A.hiver = f < 0.5;
  const m = A.meshes.caduc;
  if (!m) return;
  const op = lisse(0.15, 0.8, f);
  const mat = A.materiaux.caduc;
  const transparent = op < 0.99;
  if (mat.transparent !== transparent) mat.needsUpdate = true;
  mat.transparent = transparent;
  mat.opacity = op;
  mat.depthWrite = !transparent;
  mat.visible = op > 0.02;
  m.castShadow = f >= 0.5;
  const e = 0.6 + 0.4 * f;
  if (force || Math.abs(e - A.echelle) > 0.004) {
    A.echelle = e;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    m.userData.arbres.forEach((a, i) => {
      m4.compose(v.set(a.x, a.h * 0.62, a.z), q, s.set((a.d / 2) * e, a.h * 0.38 * e, (a.d / 2) * e));
      m.setMatrixAt(i, m4);
    });
    m.instanceMatrix.needsUpdate = true;
    m.boundingSphere = null;
  }
  if (m.userData.branches) m.userData.branches.visible = f < 0.97;
}

// Saison des arbres à la date de la barre Soleil (appelée par js/soleil.js)
export function saisonArbres(app, date) {
  appliquerFeuillage(app, feuillage(date));
}

// En « vue maquette », seuls les arbres du plateau restent (ils sont triés du centre vers l'extérieur).
export function arbresVueMaquette(app, actif) {
  for (const m of Object.values(app.arbres?.meshes || {})) {
    const n = actif ? m.userData.interieurs : m.userData.arbres.length;
    m.count = n;
    m.userData.tronc.count = n;
    const B = m.userData.branches;
    if (B) B.count = B.userData.debut[n];
  }
}

// Fiche d'un arbre (clic sur la maquette) : espèce, hauteur, couronne, gestionnaire, source
export function ficheArbre(app, a) {
  const nb = (x) => String(Math.round(x * 10) / 10).replace('.', ',');
  const feuillageTxt = a.lot === 'caduc' ? 'feuillage caduc' : 'feuillage persistant';
  const texte = [
    `${a.genre ? `Genre *${a.genre}*, ` : ''}${feuillageTxt}.`,
    `Hauteur : environ ${nb(a.h)} m${a.classe ? ` (classe ${a.classe} de l'inventaire)` : ''} ; couronne : ${nb(a.d)} m de diamètre${a.couronneEstimee === 'mediane-classe' ? ' (estimée : médiane de la classe de hauteur)' : a.source === 'osm' && !a.classe ? ' (estimée)' : ''}.`,
  ];
  const details = [a.stade ? `stade ${a.stade.toLowerCase()}` : null, a.plantation ? `planté en ${a.plantation}` : null, a.inventaire ? `inventorié le ${a.inventaire.split('-').reverse().join('/')}` : null].filter(Boolean);
  if (details.length) texte.push(`${details.join(', ').replace(/^./, (c) => c.toUpperCase())}.`);
  if (a.gestionnaire) texte.push(`Gestionnaire : ${a.gestionnaire}.`);
  if (a.lot === 'caduc') {
    const f = app.arbres?.f ?? 1;
    texte.push(`À la date de la barre Soleil : ${f >= 0.97 ? 'en feuilles' : f <= 0.03 ? 'sans feuilles (branches nues)' : `feuillage à ${Math.round(f * 100)} %`} ; lumière directe sous la couronne (Chaleur) : ${Math.round(transmissionCaduc(f) * 100)} %.`);
  }
  if (a.magnolia) {
    const fm = app.fiches?.trouver?.('magnolias');
    for (const t of [].concat(fm?.texte || [])) texte.push(t);
  }
  const source = a.source === 'nantes' ? `${ATTRIBUTION_ARBRES}${a.id != null ? ` (emplacement ${a.id})` : ''}`
    : a.source === 'osm' ? `OpenStreetMap (ODbL)${a.id ? `, ${a.id}` : ''}` : 'arbre relevé sur place (data/arbres.geojson, outil Relevé)';
  return { titre: a.nom || a.espece || 'Arbre', type: 'Arbre', texte, source };
}
// Infobulle au survol
export const infobulleArbre = (a) => [a.magnolia && a.nom !== 'Magnolia' && !/magnolia/i.test(a.nom || '') ? 'Magnolia' : null,
  `${String(Math.round(a.h)).replace('.', ',')} m`, a.lot === 'caduc' ? 'caduc' : 'persistant', a.gestionnaire || (a.source === 'osm' ? 'OpenStreetMap' : a.source === 'releve' ? 'relevé' : null)].filter(Boolean).join(' · ');

// Colore chaque bâtiment (ou le remet en blanc) : couleur(empreinte) renvoie une couleur CSS ou null.
export function colorierBatiments(app, couleur) {
  const c = new THREE.Color();
  const modifies = new Set();
  for (const e of app.empreintes || []) {
    if (!e.mesh) continue;
    const attr = e.mesh.geometry.getAttribute('color');
    if (!attr) continue;
    const val = couleur ? couleur(e) : null;
    if (!val && e.couleurs && !app.toits?.etat?.blanc) attr.array.set(e.couleurs, e.debut * 3); // teintes des matériaux (mairie détaillée)
    else {
      if (val) c.set(val); else c.setRGB(1, 1, 1);
      for (let i = e.debut; i < e.debut + e.nb; i++) attr.setXYZ(i, c.r, c.g, c.b);
    }
    modifies.add(attr);
  }
  modifies.forEach((a) => { a.needsUpdate = true; });
}
