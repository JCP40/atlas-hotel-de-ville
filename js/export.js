import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { h } from './util.js';
import { telecharger, fichierExiste } from './donnees.js';
import { chargerMeteo, meteo, mention, casesPeuRepresentatives, csvRose, csvNormales, csvDepassements, libelleSaison, libelleTemperature } from './meteo.js';
import { polygonesLocaux, lignesLocales, centroide } from './geo.js';
import { INTERETS } from './cadastre.js';
import { geometriesExtrudees } from './maquette.js';

// ------------------------------------------------------------------
// Lambert-93 (EPSG:2154), formules de l'IGN (projection conique conforme)
// ------------------------------------------------------------------
const L93 = { e: 0.0818191910428158, n: 0.725607765053267, C: 11754255.426096, Xs: 700000, Ys: 12655612.049876, l0: (3 * Math.PI) / 180 };
export function versLambert93(lat, lon) {
  const p = (lat * Math.PI) / 180, l = (lon * Math.PI) / 180, { e, n, C, Xs, Ys, l0 } = L93;
  const L = Math.log(Math.tan(Math.PI / 4 + p / 2) * Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2));
  const R = C * Math.exp(-n * L);
  return [Xs + R * Math.sin(n * (l - l0)), Ys - R * Math.cos(n * (l - l0))];
}

// distance de l'origine (0, 0) à un segment
function distanceSegment([x1, z1], [x2, z2]) {
  const dx = x2 - x1, dz = z2 - z1;
  const t = Math.max(0, Math.min(1, -(x1 * dx + z1 * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(x1 + t * dx, z1 + t * dz);
}

// Relie les segments d'une courbe de niveau en polylignes continues
function chainer(segs) {
  const cle = ([x, z]) => `${x.toFixed(2)},${z.toFixed(2)}`;
  const parPoint = new Map();
  segs.forEach((s, i) => { for (const p of s) { const k = cle(p); if (!parPoint.has(k)) parPoint.set(k, []); parPoint.get(k).push(i); } });
  const vu = new Uint8Array(segs.length);
  const suivant = (p) => (parPoint.get(cle(p)) || []).find((i) => !vu[i]);
  const lignes = [];
  for (let i = 0; i < segs.length; i++) {
    if (vu[i]) continue;
    vu[i] = 1;
    const ligne = [...segs[i]];
    for (const bout of ['fin', 'debut']) {
      for (;;) {
        const p = bout === 'fin' ? ligne[ligne.length - 1] : ligne[0];
        const j = suivant(p);
        if (j === undefined) break;
        vu[j] = 1;
        const [a, b] = segs[j];
        const autre = cle(a) === cle(p) ? b : a;
        if (bout === 'fin') ligne.push(autre); else ligne.unshift(autre);
      }
    }
    lignes.push(ligne);
  }
  return lignes;
}

const horodatage = () => {
  const d = new Date();
  const z = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
};

export function creerExport(app) {
  const reglages = { echelle: 2, legendes: true, format3D: 'glb', etendue: 'plateau', coords: 'lambert93', etendueDXF: 'perimetre', relief: false, vent: true, demolis3D: false, secteursMeteo: 16 };
  const ui = {};
  const rayon = (etendue) => (etendue === 'plateau' ? app.config.rayonPlateau : app.config.rayonEtude);
  const visibleDansScene = (o) => { for (let v = o; v; v = v.parent) if (!v.visible) return false; return true; };

  // ================================================================
  // 1. Image PNG de la vue
  // ================================================================
  function exporterImage() {
    const r = app.renderer;
    const ratio = r.getPixelRatio();
    const W = window.innerWidth, H = window.innerHeight;
    const k = reglages.echelle;
    const sortie = document.createElement('canvas');
    sortie.width = Math.round(W * k);
    sortie.height = Math.round(H * k);
    const ctx = sortie.getContext('2d');
    // rendu à haute définition, recopié immédiatement (avant que le navigateur n'efface l'image)
    r.setPixelRatio(k);
    r.setSize(W, H, false);
    r.render(app.scene, app.camera);
    ctx.drawImage(r.domElement, 0, 0, sortie.width, sortie.height);
    r.setPixelRatio(ratio);
    r.setSize(W, H, false);

    if (reglages.legendes) dessinerLegendes(ctx, k);
    sortie.toBlob((b) => {
      if (!b) { app.signaler('Image trop grande pour ce navigateur : essayez une taille plus petite.'); return; }
      telecharger(`atlas-hdv-${app.vue2D ? 'plan' : 'vue'}-${horodatage()}.png`, b, 'image/png');
      app.signaler(`Image enregistrée (${sortie.width} × ${sortie.height} px).`);
    }, 'image/png');
  }

  function dessinerLegendes(ctx, k) {
    const police = (taille, graisse = 400, famille = 'Plex Cond, Arial Narrow, sans-serif') => `${graisse} ${taille * k}px ${famille}`;
    // étiquettes visibles, à leur place à l'écran
    for (const it of app.etiquettes.liste) {
      if (it.el.hidden) continue;
      const b = it.el.getBoundingClientRect();
      if (b.width === 0) continue;
      const st = getComputedStyle(it.el);
      ctx.save();
      const fond = st.backgroundColor;
      if (fond && fond !== 'rgba(0, 0, 0, 0)' && fond !== 'transparent') {
        ctx.fillStyle = fond;
        ctx.fillRect(b.left * k, b.top * k, b.width * k, b.height * k);
        ctx.strokeStyle = st.borderTopColor;
        ctx.lineWidth = k;
        if (parseFloat(st.borderTopWidth) > 0) ctx.strokeRect(b.left * k, b.top * k, b.width * k, b.height * k);
      }
      ctx.font = `${st.fontStyle} ${st.fontWeight} ${parseFloat(st.fontSize) * k}px ${st.fontFamily}`;
      ctx.fillStyle = st.color;
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'center';
      const pb = parseFloat(st.paddingBottom) || 0;
      ctx.fillText(it.el.textContent, (b.left + b.width / 2) * k, (b.top + (b.height - pb) / 2) * k);
      ctx.restore();
    }
    // cartouche
    const W = ctx.canvas.width, H = ctx.canvas.height;
    const m = 16 * k;
    ctx.fillStyle = 'rgba(246,248,247,0.92)';
    ctx.fillRect(m, m, 380 * k, 74 * k);
    ctx.fillStyle = '#2f3b45';
    ctx.fillRect(m, m, 3 * k, 74 * k);
    ctx.font = police(30, 300, 'Spectral, Georgia, serif');
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';
    ctx.fillText(app.config.titre, m + 14 * k, m + 36 * k);
    ctx.font = police(13);
    ctx.fillStyle = '#5b6770';
    const etat = app.etatsActifs().find((e) => e.id === app.etat)?.libelle ?? '';
    ctx.fillText(`${app.config.sousTitre}, ${etat.toLowerCase()}, ${app.vue2D ? 'plan' : 'vue 3D'}`, m + 14 * k, m + 56 * k);
    ctx.fillText(`${app.config.auteur || ''}`, m + 14 * k, m + 70 * k);
    // échelle graphique (en plan, elle est exacte ; en perspective, valable au centre de la vue)
    const mParPx = app.vue.metresParPixel();
    const long = [5, 10, 20, 50, 100, 200, 500].find((v) => v / mParPx >= 90) || 500;
    const lpx = (long / mParPx) * k;
    const x0 = W - m - lpx, y0 = H - m - 22 * k;
    ctx.fillStyle = 'rgba(246,248,247,0.92)';
    ctx.fillRect(x0 - 10 * k, y0 - 50 * k, lpx + 20 * k, 70 * k);
    ctx.strokeStyle = '#2f3b45';
    ctx.lineWidth = 1.2 * k;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? '#fff' : '#2f3b45';
      ctx.fillRect(x0 + (i * lpx) / 4, y0, lpx / 4, 6 * k);
    }
    ctx.strokeRect(x0, y0, lpx, 6 * k);
    ctx.fillStyle = '#2f3b45';
    ctx.font = police(12);
    ctx.textAlign = 'right';
    ctx.fillText(`${long} m${app.vue2D ? '' : ' (au centre)'}`, x0 + lpx, y0 + 20 * k);
    // nord
    const dir = new THREE.Vector3().subVectors(app.controls.target, app.camera.position);
    const angle = app.vue2D ? 0 : Math.atan2(dir.x, -dir.z);
    ctx.save();
    ctx.translate(x0 + 14 * k, y0 - 26 * k);
    ctx.rotate(-angle);
    ctx.beginPath();
    ctx.moveTo(0, -16 * k); ctx.lineTo(6 * k, 8 * k); ctx.lineTo(0, 4 * k); ctx.lineTo(-6 * k, 8 * k); ctx.closePath();
    ctx.fill();
    ctx.font = police(10, 600);
    ctx.textAlign = 'center';
    ctx.fillText('N', 0, 20 * k);
    ctx.restore();
  }

  // ================================================================
  // 2. Maquette 3D (GLB ou OBJ)
  // ================================================================
  function extraireTriangles(geo, matrice, garder) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    g.applyMatrix4(matrice);
    if (!garder) return g;
    const pos = g.getAttribute('position');
    const attrs = Object.keys(g.attributes);
    const gardes = [];
    for (let t = 0; t < pos.count; t += 3) {
      const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
      const cz = (pos.getZ(t) + pos.getZ(t + 1) + pos.getZ(t + 2)) / 3;
      if (garder(cx, cz)) gardes.push(t);
    }
    const res = new THREE.BufferGeometry();
    for (const nom of attrs) {
      const a = g.getAttribute(nom);
      const arr = new Float32Array(gardes.length * 3 * a.itemSize);
      gardes.forEach((t, i) => { for (let v = 0; v < 3; v++) for (let c = 0; c < a.itemSize; c++) arr[(i * 3 + v) * a.itemSize + c] = a.array[(t + v) * a.itemSize + c]; });
      res.setAttribute(nom, new THREE.BufferAttribute(arr, a.itemSize));
    }
    return res;
  }

  function sceneExport(etendue) {
    const r = rayon(etendue);
    const dedans = (x, z) => Math.hypot(x, z) <= r;
    // relief : hauteur du terrain par rapport au centre (0 si la topographie n'est pas chargée)
    const relief = reglages.relief && app.topo?.disponible;
    const h0 = relief ? app.topo.etat.h0 : 0;
    const dz = (x, z) => { if (!relief) return 0; const a = app.topo.altitude(x, z); return Number.isFinite(a) ? a - h0 : 0; };
    const draper = (g) => { if (!relief) return g; const p = g.getAttribute('position'); for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + dz(p.getX(i), p.getZ(i))); g.computeVertexNormals(); return g; };
    const poser = (g, x, z) => (relief ? g.translate(0, dz(x, z), 0) : g);
    const scene = new THREE.Scene();
    const mat = (nom, couleur, options = {}) => new THREE.MeshStandardMaterial({ name: nom, color: couleur, roughness: 0.9, metalness: 0, ...options });
    const ajouter = (nom, geos, materiau) => {
      const liste = geos.filter((g) => g && g.getAttribute('position')?.count);
      if (!liste.length) return;
      // attributs communs à toutes les géométries du lot
      const communs = Object.keys(liste[0].attributes).filter((a) => liste.every((g) => g.getAttribute(a)));
      for (const g of liste) for (const a of Object.keys(g.attributes)) if (!communs.includes(a)) g.deleteAttribute(a);
      const m = new THREE.Mesh(mergeGeometries(liste, false), materiau);
      m.name = nom;
      scene.add(m);
    };

    // Bâti existant, bâtiment par bâtiment (couleurs PSMV comprises si elles sont affichées)
    const colores = !!app.couches.batimentsPSMV;
    const bati = [];
    for (const e of app.empreintes || []) {
      if (!e.mesh || !visibleDansScene(e.mesh) || !dedans(e.cx, e.cz)) continue;
      const src = e.mesh.geometry;
      const g = new THREE.BufferGeometry();
      for (const nom of ['position', 'normal', 'color']) {
        const a = src.getAttribute(nom);
        if (!a) continue;
        g.setAttribute(nom, new THREE.BufferAttribute(a.array.slice(e.debut * a.itemSize, (e.debut + e.nb) * a.itemSize), a.itemSize));
      }
      e.mesh.updateWorldMatrix(true, false);
      g.applyMatrix4(e.mesh.matrixWorld);
      if (!colores) g.deleteAttribute('color');
      bati.push(poser(g, e.cx, e.cz));
    }
    ajouter('Bati existant', bati, mat('Bati', 0xf7f6f2, { vertexColors: colores }));

    // Photos de façade (js/toits.js) : un objet texturé par façade, posé sur le mur (GLB : texture incluse ;
    // OBJ : archive ZIP avec le MTL et les JPEG des façades)
    {
      for (const e of app.empreintes || []) {
        if (!e.mesh || !e.detail || !visibleDansScene(e.mesh) || !dedans(e.cx, e.cz)) continue;
        for (const c of e.mesh.children) {
          if (!c.userData.facadePhoto || !c.visible || !c.material.map?.image) continue;
          c.updateWorldMatrix(true, false);
          const g = poser(c.geometry.clone().applyMatrix4(c.matrixWorld), e.cx, e.cz);
          const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ name: `Facade ${c.userData.facadePhoto}`, map: c.material.map, roughness: 0.9, metalness: 0 }));
          m.name = `Facade photo ${c.userData.facadePhoto}`;
          scene.add(m);
        }
      }
    }

    // Projet (js/projet.js) : chaque volume ajouté est un objet séparé ; le bâti démoli, un objet à part (option)
    // couleur de chaque volume (outil Projet), sinon la couleur par défaut du projet ; volumes importés : modèle d'origine
    const couleurProjet = app.projet?.etat?.couleurDefaut || 0x5e9384;
    for (const e of (app.batiEffectif?.() || []).filter((x) => x.projet && !x.importe)) {
      if (!dedans(e.cx, e.cz) || app.etat === 'avant') continue; // volumes absents de l'état « avant 1943 »
      const geos = geometriesExtrudees(e.polys, e.hauteur, 0).map((g) => { g.deleteAttribute('uv'); return poser(g, e.cx, e.cz); });
      const c = e.forme?.couleur || couleurProjet;
      ajouter(`Projet ${e.nom}`, geos, mat(`Projet ${String(c).replace('#', '')}`, c));
    }
    if (app.etat !== 'avant') for (const o of app.imports?.objetsExport?.(dedans) || []) { if (relief) o.position.y += dz(o.position.x, o.position.z); scene.add(o); }
    if (reglages.demolis3D) {
      const geos = [];
      for (const d of app.projet?.demolisVisibles() || []) {
        if (!dedans(d.cx, d.cz)) continue;
        for (const g of geometriesExtrudees(d.polys, Math.max(d.hauteur, 0.5), 0)) { g.deleteAttribute('uv'); geos.push(poser(g, d.cx, d.cz)); }
      }
      ajouter('Bati demoli (projet)', geos, mat('Demoli', 0xc8372d, { transparent: true, opacity: 0.35 }));
    }

    // Sol
    let sol;
    if (relief) {
      const n = Math.ceil((2 * r) / 4);
      sol = extraireTriangles(new THREE.PlaneGeometry(2 * r, 2 * r, n, n).rotateX(-Math.PI / 2), new THREE.Matrix4(), dedans);
      sol.deleteAttribute('uv');
      draper(sol);
    } else sol = new THREE.CircleGeometry(r, 128).rotateX(-Math.PI / 2);
    ajouter(relief ? 'Terrain (RGE ALTI)' : 'Sol', [sol], mat('Sol', 0xecedea));

    // Voirie et surfaces (triangles dont le centre est dans l'étendue)
    for (const [nomGroupe, nom, couleur] of [['voirie', 'Voirie', 0xc6cac8], ['surfaces', 'Surfaces', 0xd2dccb]]) {
      const g = app.scene.getObjectByName(nomGroupe);
      if (!g || !g.visible) continue;
      const geos = [];
      g.traverse((o) => { if (o.isMesh && visibleDansScene(o)) { o.updateWorldMatrix(true, false); geos.push(extraireTriangles(o.geometry, o.matrixWorld, dedans)); } });
      geos.forEach((x) => { x.deleteAttribute('uv'); x.deleteAttribute('color'); draper(x); x.translate(0, relief ? 0.08 : 0, 0); });
      ajouter(nom, geos, mat(nom, couleur));
    }

    // Arbres (les instances deviennent des géométries ordinaires)
    if (app.arbres?.groupe.visible) {
      const couronnes = [], troncs = [];
      const m4 = new THREE.Matrix4();
      for (const mesh of Object.values(app.arbres.meshes)) {
        const tronc = mesh.userData.tronc;
        for (let i = 0; i < mesh.count; i++) {
          const a = mesh.userData.arbres[i];
          if (!dedans(a.x, a.z)) continue;
          mesh.getMatrixAt(i, m4);
          couronnes.push(poser(mesh.geometry.clone().applyMatrix4(m4), a.x, a.z));
          tronc.getMatrixAt(i, m4);
          troncs.push(poser(tronc.geometry.clone().applyMatrix4(m4), a.x, a.z));
        }
      }
      ajouter('Arbres couronnes', couronnes.map((g) => { g.deleteAttribute('uv'); return g; }), mat('Arbres', 0xc8deb0));
      ajouter('Arbres troncs', troncs.map((g) => { g.deleteAttribute('uv'); return g; }), mat('Troncs', 0xd9d6cc));
    }

    // Couche de l'étudiant visible : mémoire de 1943
    for (const [nomGroupe, nom, couleur, options] of [
      ['fantomes', 'Bati disparu 1943', 0x6f86a6, { transparent: true, opacity: 0.45 }],
    ]) {
      const g = app.groupes[nomGroupe];
      if (!g) continue;
      const geos = [];
      g.traverse((o) => {
        if (!o.isMesh || !visibleDansScene(o)) return;
        o.updateWorldMatrix(true, false);
        const x = extraireTriangles(o.geometry, o.matrixWorld, dedans);
        x.deleteAttribute('uv');
        x.computeBoundingBox();
        const c = x.boundingBox.getCenter(new THREE.Vector3());
        geos.push(poser(x, c.x, c.z));
      });
      ajouter(nom, geos, mat(nom, couleur, options));
    }
    return scene;
  }

  async function exporterMaquette() {
    // l'export part de la maquette à plat : le relief affiché est retiré le temps du calcul
    const reprendre = app.relief?.suspendre() ?? (() => {});
    let scene;
    try { scene = sceneExport(reglages.etendue); } finally { reprendre(); }
    const nb = scene.children.length;
    if (!nb) { app.signaler('Rien à exporter : la maquette est vide.'); return; }
    const base = `atlas-hdv-maquette-${reglages.etendue}-${horodatage()}`;
    if (reglages.format3D === 'glb') {
      scene.userData = { origine: texteOrigine('3d') }; // écrit dans les « extras » du fichier glTF
      const res = await new GLTFExporter().parseAsync(scene, { binary: true });
      telecharger(`${base}.glb`, new Blob([res], { type: 'model/gltf-binary' }));
    } else {
      telecharger(`${base}.zip`, await archiveOBJ(scene, base), 'application/zip');
    }
    app.signaler(`Maquette exportée (${nb} objets), en mètres, origine à la mairie (voir l'aide du panneau).`);
  }

  // ---------------------------------------------------------------
  // OBJ texturé : archive ZIP (OBJ + MTL + JPEG des façades et des textures des modèles importés)
  // ---------------------------------------------------------------
  async function archiveOBJ(scene, base) {
    const fichiers = [];
    const materiaux = new Map(); // matériau -> nom propre
    const images = new Map(); // image -> nom du JPEG
    const propre = (t) => (String(t || 'materiau').normalize('NFD').replace(/\p{M}/gu, '').replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'materiau');
    const noms = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const liste = [].concat(o.material);
      for (const m of liste) {
        if (materiaux.has(m)) continue;
        let n = propre(m.name || o.name), k = 2;
        while (noms.has(n)) n = `${propre(m.name || o.name)}_${k++}`;
        noms.add(n);
        materiaux.set(m, n);
      }
    });
    // JPEG d'une texture (image, canevas ou ImageBitmap)
    const jpeg = async (img) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const b = await new Promise((ok) => c.toBlob(ok, 'image/jpeg', 0.9));
      return new Uint8Array(await b.arrayBuffer());
    };
    const mtl = [`# ${base}.mtl : matériaux de ${base}.obj (atlas du site de l'Hôtel de Ville)`];
    const renommes = [];
    for (const [m, n] of materiaux) {
      const c = m.color || new THREE.Color(1, 1, 1);
      mtl.push('', `newmtl ${n}`, `Kd ${c.r.toFixed(4)} ${c.g.toFixed(4)} ${c.b.toFixed(4)}`, 'Ka 0 0 0', 'Ks 0 0 0', 'illum 1');
      if (m.transparent && m.opacity < 1) mtl.push(`d ${m.opacity.toFixed(3)}`);
      const img = m.map?.image;
      if (img && (img.width || img.naturalWidth)) {
        if (!images.has(img)) {
          const nomImg = `textures/${n}.jpg`;
          images.set(img, nomImg);
          try { fichiers.push({ nom: nomImg, donnees: await jpeg(img) }); } catch { images.set(img, null); }
        }
        if (images.get(img)) mtl.push(`map_Kd ${images.get(img)}`);
      }
      renommes.push([m, m.name]);
      m.name = n;
    }
    let obj;
    try {
      const entete = texteOrigine('3d').split('\n').map((l) => `# ${l}`).join('\n');
      obj = `${entete}\nmtllib ${base}.mtl\n${new OBJExporter().parse(scene)}`;
    } finally { for (const [m, n] of renommes) m.name = n; }
    const texte = (t) => new TextEncoder().encode(t);
    fichiers.unshift({ nom: `${base}.obj`, donnees: texte(obj) }, { nom: `${base}.mtl`, donnees: texte(`${mtl.join('\n')}\n`) },
      { nom: 'LISEZ-MOI.txt', donnees: texte(`${texteOrigine('3d')}\n\nOuvrir ${base}.obj (Rhino, Blender, SketchUp…) : le fichier .mtl et le dossier textures/ doivent rester à côté.\n`) });
    return zip(fichiers);
  }

  // Archive ZIP sans compression (méthode « stockée »), CRC-32 calculé ici : aucune bibliothèque externe
  const TABLE_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) c = TABLE_CRC[(c ^ d[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  function zip(fichiers) {
    const morceaux = [], central = [];
    let decalage = 0;
    const d = new Date();
    const heure = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const jour = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of fichiers) {
      const nom = new TextEncoder().encode(f.nom), crc = crc32(f.donnees), n = f.donnees.length;
      const local = new DataView(new ArrayBuffer(30));
      [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, heure, 2], [12, jour, 2], [14, crc, 4], [18, n, 4], [22, n, 4], [26, nom.length, 2], [28, 0, 2]]
        .forEach(([o, v, t]) => (t === 4 ? local.setUint32(o, v, true) : local.setUint16(o, v, true)));
      const c = new DataView(new ArrayBuffer(46));
      [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, heure, 2], [14, jour, 2], [16, crc, 4], [20, n, 4], [24, n, 4], [28, nom.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2], [36, 0, 2], [38, 0, 4], [42, decalage, 4]]
        .forEach(([o, v, t]) => (t === 4 ? c.setUint32(o, v, true) : c.setUint16(o, v, true)));
      morceaux.push(local, nom, f.donnees);
      central.push(c, nom);
      decalage += 30 + nom.length + n;
    }
    const tailleCentral = central.reduce((s, x) => s + x.byteLength, 0);
    const fin = new DataView(new ArrayBuffer(22));
    [[0, 0x06054b50, 4], [4, 0, 2], [6, 0, 2], [8, fichiers.length, 2], [10, fichiers.length, 2], [12, tailleCentral, 4], [16, decalage, 4], [20, 0, 2]]
      .forEach(([o, v, t]) => (t === 4 ? fin.setUint32(o, v, true) : fin.setUint16(o, v, true)));
    return new Blob([...morceaux, ...central, fin], { type: 'application/zip' });
  }

  function texteOrigine(type) {
    const o = app.config.origine;
    const [X, Y] = versLambert93(o.lat, o.lon);
    const lignes = [
      `Atlas du site de l'Hôtel de Ville de Nantes, export du ${new Date().toLocaleString('fr-FR')}`,
      '',
      `Origine (0, 0) : ${o.lat}, ${o.lon} (WGS84), soit X ${X.toFixed(2)} m, Y ${Y.toFixed(2)} m en Lambert-93 (EPSG:2154).`,
      `Point de référence : ${o.nom || ''}`,
      'Unité : le mètre.',
    ];
    if (type === '3d') {
      lignes.push('Axes : x vers l\'est, y vers le haut, z vers le sud (convention glTF). Le nord est vers -z.',
        'Dans SketchUp, l\'import convertit en général y (haut) en axe bleu : vérifiez que le nord tombe sur l\'axe vert.',
        'Toitures simplifiées en terrasses ; hauteurs par défaut (14 m) quand la donnée manque.');
    } else {
      lignes.push(reglages.coords === 'lambert93' ? 'Coordonnées en Lambert-93 : le plan se superpose aux autres données géoréférencées (cadastre DXF, PLU...).' : 'Coordonnées locales : x vers l\'est, y vers le nord, origine au point ci-dessus.');
    }
    return lignes.join('\n');
  }

  // ================================================================
  // 3. Plan AutoCAD (DXF R12)
  // ================================================================
  const CALQUES_DXF = {
    PLATEAU: 8, BATI_EXISTANT: 7, BATI_REMARQUABLE: 5, BATI_HAUTEURS: 8,
    BATI_DEMOLI: 1, BATI_PROJET: 3, BATI_PROJET_HAUTEURS: 3,
    BATI_PSMV_TYPE_A: 30, BATI_PSMV_TYPE_B: 40, BATI_PSMV_PORTAIL: 82, BATI_PSMV_SANS_INTERET: 9,
    PARCELLES: 1, PARCELLES_NUMEROS: 1, PARCELLES_PROGRAMME: 6,
    VOIRIE_AXES: 8, ESPACES_VERTS: 3, PARKINGS: 9, EAU: 4,
    COURBES_NIVEAU: 34, COURBES_MAITRESSES: 32, COURBES_COTES: 32,
    RESEAUX_ECLAIRAGE: 40, RESEAUX_TAMPONS: 8, RESEAUX_INCENDIE: 1, RESEAUX_ARMOIRES: 200, RESEAUX_LIGNES: 30,
    RESEAU_GAZ: 2, RESEAU_ELEC_BT: 1, RESEAU_ELEC_HTA: 14, POSTES: 14,
    ARBRES: 3, MAGNOLIAS: 94, BATI_DISPARU_1943: 150, AXES_COUPE: 1,
  };

  function ecrireDXF(entites) {
    const out = [];
    const g = (code, val) => out.push(String(code), String(val));
    for (const l of texteOrigine('dxf').split('\n')) g(999, l.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '?'));
    const t = (s) => String(s).replace(/[^\x20-\x7e]/g, (c) => `\\U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (const e of entites) for (const [x, y] of e.pts || [[e.x, e.y]]) { xmin = Math.min(xmin, x); ymin = Math.min(ymin, y); xmax = Math.max(xmax, x); ymax = Math.max(ymax, y); }
    g(0, 'SECTION'); g(2, 'HEADER');
    g(9, '$ACADVER'); g(1, 'AC1009');
    g(9, '$EXTMIN'); g(10, xmin.toFixed(3)); g(20, ymin.toFixed(3)); g(30, 0);
    g(9, '$EXTMAX'); g(10, xmax.toFixed(3)); g(20, ymax.toFixed(3)); g(30, 0);
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'TABLES');
    g(0, 'TABLE'); g(2, 'LTYPE'); g(70, 2);
    g(0, 'LTYPE'); g(2, 'CONTINUOUS'); g(70, 0); g(3, 'Solid line'); g(72, 65); g(73, 0); g(40, '0.0');
    g(0, 'LTYPE'); g(2, 'DASHED'); g(70, 0); g(3, 'Dashed __ __ __'); g(72, 65); g(73, 2); g(40, '1.5'); g(49, '1.0'); g(49, '-0.5');
    g(0, 'ENDTAB');
    const calques = { ...CALQUES_DXF };
    for (const e of entites) if (!(e.calque in calques)) calques[e.calque] = 5;
    g(0, 'TABLE'); g(2, 'LAYER'); g(70, Object.keys(calques).length);
    for (const [nom, couleur] of Object.entries(calques)) { g(0, 'LAYER'); g(2, nom); g(70, 0); g(62, couleur); g(6, nom === 'BATI_DEMOLI' ? 'DASHED' : 'CONTINUOUS'); }
    g(0, 'ENDTAB');
    g(0, 'ENDSEC');
    g(0, 'SECTION'); g(2, 'ENTITIES');
    for (const e of entites) {
      if (e.type === 'poly') {
        const z = (e.altitude ?? 0).toFixed(2);
        g(0, 'POLYLINE'); g(8, e.calque); g(66, 1); g(70, e.ferme ? 1 : 0); g(10, 0); g(20, 0); g(30, z);
        for (const [x, y] of e.pts) { g(0, 'VERTEX'); g(8, e.calque); g(10, x.toFixed(3)); g(20, y.toFixed(3)); g(30, z); }
        g(0, 'SEQEND'); g(8, e.calque);
      } else if (e.type === 'cercle') {
        g(0, 'CIRCLE'); g(8, e.calque); g(10, e.x.toFixed(3)); g(20, e.y.toFixed(3)); g(30, 0); g(40, e.r.toFixed(3));
      } else if (e.type === 'texte') {
        g(0, 'TEXT'); g(8, e.calque); g(10, e.x.toFixed(3)); g(20, e.y.toFixed(3)); g(30, 0); g(40, e.hauteur); g(1, t(e.texte));
        g(72, 1); g(11, e.x.toFixed(3)); g(21, e.y.toFixed(3)); g(31, 0); g(73, 2);
      }
    }
    g(0, 'ENDSEC');
    g(0, 'EOF');
    return out.join('\r\n');
  }

  function exporterDXF() {
    const r = rayon(reglages.etendueDXF);
    const dedans = (x, z) => Math.hypot(x, z) <= r;
    const conv = reglages.coords === 'lambert93'
      ? ([x, z]) => { const p = app.proj.versGeo(x, z); return versLambert93(p.lat, p.lon); }
      : ([x, z]) => [x, -z];
    const E = [];
    const poly = (calque, pts, ferme = true, altitude = 0) => { if (pts.length >= 2) E.push({ type: 'poly', calque, pts: pts.map(conv), ferme, altitude }); };
    const texte = (calque, [x, z], txt, hauteur = 1.2) => { const [X, Y] = conv([x, z]); E.push({ type: 'texte', calque, x: X, y: Y, texte: txt, hauteur }); };
    const cercle = (calque, [x, z], rr) => { const [X, Y] = conv([x, z]); E.push({ type: 'cercle', calque, x: X, y: Y, r: rr }); };

    // plateau de la maquette
    const cercleplateau = [];
    for (let i = 0; i < 128; i++) { const a = (i / 128) * Math.PI * 2; cercleplateau.push([Math.cos(a) * app.config.rayonPlateau, Math.sin(a) * app.config.rayonPlateau]); }
    poly('PLATEAU', cercleplateau);

    // bâti, rangé par intérêt PSMV de la parcelle qui le porte
    for (const e of app.empreintes || []) {
      if (!dedans(e.cx, e.cz)) continue;
      let calque = e.rem ? 'BATI_REMARQUABLE' : 'BATI_EXISTANT';
      const it = app.cadastre?.trouver(e.cx, e.cz);
      if (it?.fichesPSMV.length) {
        const int = INTERETS.find((i) => i.test.test(it.fichesPSMV[0].interet || ''));
        calque = { 'Type A': 'BATI_PSMV_TYPE_A', 'Type B': 'BATI_PSMV_TYPE_B', 'Portail à conserver': 'BATI_PSMV_PORTAIL' }[int?.libelle] || 'BATI_PSMV_SANS_INTERET';
      }
      for (const [ext, ...trous] of e.polys) { poly(calque, ext); trous.forEach((t) => poly(calque, t)); }
      texte('BATI_HAUTEURS', [e.cx, e.cz], `${Math.round(e.hauteur)} m`, 0.9);
    }

    // projet : bâti démoli (contours pointillés) et volumes ajoutés (js/projet.js)
    for (const d of app.projet?.demolisVisibles() || []) {
      if (!dedans(d.cx, d.cz)) continue;
      for (const [ext, ...trous] of d.polys) { poly('BATI_DEMOLI', ext); trous.forEach((t) => poly('BATI_DEMOLI', t)); }
    }
    for (const e of (app.batiEffectif?.() || []).filter((x) => x.projet)) {
      if (!dedans(e.cx, e.cz)) continue;
      for (const [ext] of e.polys) poly('BATI_PROJET', ext);
      texte('BATI_PROJET_HAUTEURS', [e.cx, e.cz], `${e.nom} ${Math.round(e.hauteur)} m`, 1.2);
    }

    // parcelles et numéros
    for (const it of app.cadastre?.parcelles || []) {
      if (!dedans(it.cx, it.cz)) continue;
      for (const [ext, ...trous] of it.polys) { poly(it.programme ? 'PARCELLES_PROGRAMME' : 'PARCELLES', ext); trous.forEach((t) => poly('PARCELLES', t)); }
      const p = it.f.properties;
      texte('PARCELLES_NUMEROS', [it.cx, it.cz], `${p.section} ${p.numero}`, 1.2);
    }

    // voirie (axes) et surfaces
    for (const f of app.donnees.osm.voirie.features) {
      for (const pts of lignesLocales(f.geometry, app.proj)) if (pts.some((q, i) => i > 0 && distanceSegment(pts[i - 1], q) <= r)) poly('VOIRIE_AXES', pts, false);
    }
    const calqueSurface = { vegetal: 'ESPACES_VERTS', parking: 'PARKINGS', eau: 'EAU' };
    for (const f of app.donnees.osm.surfaces.features) {
      const c = calqueSurface[f.properties?.surface];
      if (!c) continue;
      for (const [ext] of polygonesLocaux(f.geometry, app.proj)) { const [cx, cz] = centroide(ext); if (dedans(cx, cz)) poly(c, ext); }
    }

    // arbres
    for (const [lot, liste] of Object.entries(app.arbres?.lots || {})) {
      for (const a of liste) if (dedans(a.x, a.z)) cercle(lot === 'magnolia' ? 'MAGNOLIAS' : 'ARBRES', [a.x, a.z], a.d / 2);
    }

    // couches de l'étudiant et axes de coupe
    for (const f of app.donnees.fantomes.features) for (const [ext] of polygonesLocaux(f.geometry, app.proj)) poly('BATI_DISPARU_1943', ext);
    for (const ax of app.coupes?.axes || []) {
      poly('AXES_COUPE', [[ax.A.x, ax.A.z], [ax.B.x, ax.B.z]], false);
      texte('AXES_COUPE', [ax.A.x, ax.A.z], ax.id, 4);
      texte('AXES_COUPE', [ax.B.x, ax.B.z], `${ax.id}'`, 4);
    }

    // courbes de niveau (polylignes à leur altitude NGF)
    if (app.topo?.disponible) {
      for (const [niveau, segs] of app.topo.courbes()) {
        const maitresse = app.topo.estMaitresse(niveau);
        let cote = null;
        const gardes = segs.filter(([a, b]) => dedans(a[0], a[1]) || dedans(b[0], b[1]));
        for (const ligne of chainer(gardes)) {
          poly(maitresse ? 'COURBES_MAITRESSES' : 'COURBES_NIVEAU', ligne, false, niveau);
          if (maitresse && !cote && ligne.length > 4) cote = ligne[Math.floor(ligne.length / 2)];
        }
        if (cote) texte('COURBES_COTES', cote, `${niveau}`, 1.5);
      }
    }

    // réseaux : OpenStreetMap, puis jeux de l'Open Data affichés
    for (const t of app.reseaux?.TYPES_OSM || []) {
      const calque = `RESEAUX_${t.id.toUpperCase()}`;
      for (const f of app.reseaux.osm) {
        if (!t.test(f.properties || {})) continue;
        if (f.geometry.type === 'Point') { const p = app.proj.pt(f.geometry.coordinates); if (dedans(p[0], p[1])) cercle(calque, p, 0.4); }
        else for (const pts of lignesLocales(f.geometry, app.proj)) poly(calque, pts, false);
      }
    }
    // réseaux souterrains open data (GRDF, Enedis) : couches cochées
    for (const r of app.reseaux?.souterrains || []) {
      if (!r.visible) continue;
      for (const f of r.fc.features) {
        const gm = f.geometry;
        if (!gm) continue;
        if (gm.type === 'Point') cercle(r.calque, app.proj.pt(gm.coordinates), 1.2);
        else for (const pts of lignesLocales(gm, app.proj)) poly(r.calque, pts, false);
      }
    }
    for (const j of app.reseaux?.jeux || []) {
      if (!j.visible) continue;
      const calque = `RESEAU_${j.titre.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`.slice(0, 31);
      for (const f of j.fc.features) {
        const gm = f.geometry;
        if (!gm) continue;
        if (gm.type === 'Point') cercle(calque, app.proj.pt(gm.coordinates), 0.5);
        else if (gm.type.includes('LineString')) for (const pts of lignesLocales(gm, app.proj)) poly(calque, pts, false);
        else if (gm.type.includes('Polygon')) for (const an of polygonesLocaux(gm, app.proj)) for (const a of an) poly(calque, a);
      }
    }

    // trajets et isochrones calculés
    for (const t of app.trajets?.traces || []) poly(`TRAJET_${t.mode.toUpperCase()}${t.type === 'pied' && t.mode === 'tc' ? '_MARCHE' : ''}`, t.pts, false);
    for (const z of app.trajets?.zones || []) for (const [ext, ...trous] of z.polys) { poly(`ISOCHRONE_${z.min}MIN`, ext); trous.forEach((tr) => poly(`ISOCHRONE_${z.min}MIN`, tr)); }

    // carte du bruit affichée
    if (app.bruit?.zones && app.couches.bruit) {
      for (const f of app.bruit.zones.features) {
        const n = app.bruit.niveauDe(f.properties);
        if (n == null) continue;
        const calque = `BRUIT_${app.bruit.estNuit() ? 'LN' : 'LDEN'}_${n >= 75 ? 'PLUS_75' : `${n}_${n + 5}`}`;
        for (const [ext, ...trous] of polygonesLocaux(f.geometry, app.proj)) { if (!dedans(...centroide(ext))) continue; poly(calque, ext); trous.forEach((tr) => poly(calque, tr)); }
      }
    }

    // vent : phénomènes et carte de confort du dernier calcul de l'outil Vent
    if (reglages.vent && app.vent) {
      const v = app.vent.entitesDXF();
      for (const p of v.polys) if (p.pts.some(([x, z]) => dedans(x, z))) poly(p.calque, p.pts);
      for (const t of v.textes) if (dedans(...t.pt)) texte(t.calque, t.pt, t.texte, 1.5);
    }

    const base = `atlas-hdv-plan-${reglages.coords}-${horodatage()}`;
    telecharger(`${base}.dxf`, ecrireDXF(E), 'application/dxf');
    app.signaler(`Plan exporté : ${E.length} entités sur ${Object.keys(CALQUES_DXF).length} calques.`);
  }

  // ================================================================
  // 4. Météo (data/meteo/meteo.json) : CSV, EPW et mesures horaires
  // ================================================================
  async function exporterMeteo(quoi) {
    if (!await chargerMeteo()) { ui.meteo.textContent = mention(); return; }
    const n = reglages.secteursMeteo;
    const [nom, contenu] = {
      rose: [`meteo-rose-${n}-secteurs.csv`, () => csvRose(n)],
      normales: ['meteo-normales-mensuelles.csv', csvNormales],
      depassements: [`meteo-depassements-${n}-secteurs.csv`, () => csvDepassements(n)],
    }[quoi];
    telecharger(`atlas-hdv-${nom}`, contenu(), 'text/csv;charset=utf-8');
  }

  // Liens vers les fichiers déposés dans data/meteo/ (testés par une requête HEAD)
  async function liensMeteo(zone) {
    const d = await chargerMeteo();
    const nomEPW = d?.source?.epw?.split(', ').pop();
    const epw = [nomEPW && `data/meteo/${nomEPW}.epw`, 'data/meteo/nantes.epw'].filter(Boolean);
    let trouve = null;
    for (const u of epw) if (await fichierExiste(u)) { trouve = u; break; }
    const csv = 'data/meteo/meteofrance_44020001_horaire.csv';
    const avecCSV = await fichierExiste(csv);
    const lien = (href, texte) => h('a', { class: 'bouton', href, download: href.split('/').pop() }, texte);
    zone.replaceChildren(...[
      trouve ? h('div', { class: 'actions' }, lien(trouve, 'EPW pour Ladybug/Rhino')) : null,
      h('p', { class: 'note' }, trouve
        ? `${trouve.split('/').pop()} : année météo type TMYx 2011-2025 de Nantes-Atlantique (Climate.OneBuilding.org, CC BY 4.0), à ouvrir dans Ladybug (Import EPW) pour les études de rayonnement et de confort sous Rhino. Année reconstituée, à comparer avec les statistiques de Météo-France ci-dessus (écart moyen de ${String(d?.comparatif?.ecart_abs_moyen_pts ?? '–').replace('.', ',')} point sur les fréquences de la rose).`
        : 'Fichier EPW absent : déposer le fichier EPW de Nantes (par exemple FRA_PL_Nantes.Atlantique.AP.072220_TMYx.2011-2025.epw, Climate.OneBuilding.org) dans le dossier data/meteo/ de l\'atlas, puis rouvrir cet onglet.'),
      avecCSV ? h('div', { class: 'actions' }, lien(csv, 'Mesures horaires (CSV)')) : null,
      h('p', { class: 'note' }, avecCSV
        ? 'Mesures horaires brutes de la station 44020001 depuis 2016 (Météo-France, Licence Ouverte Etalab 2.0) : vent (FF, DD, rafales), température, humidité, pression, pluie, rayonnement ; heures en UTC, environ 7 Mo.'
        : 'Mesures horaires absentes : déposer meteofrance_44020001_horaire.csv (produit par outils/meteo/filtre.py) dans data/meteo/.'),
    ].filter(Boolean));
  }

  // ================================================================
  // Panneau
  // ================================================================
  function choix(nom, options, cle) {
    return h('div', { class: 'choix', role: 'radiogroup' }, ...options.map(([v, l]) => h('label', {},
      h('input', { type: 'radio', name: nom, value: String(v), checked: String(reglages[cle]) === String(v), onchange: () => { reglages[cle] = typeof reglages[cle] === 'number' ? +v : v; } }), l)));
  }

  function construirePanneau(conteneur) {
    const W = window.innerWidth, H = window.innerHeight;
    ui.meteo = h('p', { class: 'note' });
    const liens = h('div');
    chargerMeteo().then(() => {
      const cases = casesPeuRepresentatives().filter((c) => c.saison !== 'annee' || c.temperature !== 'all');
      ui.meteo.textContent = `${mention()}${cases.length ? ` Cases peu représentatives (moins de 100 h), signalées dans le CSV de la rose : ${cases.map((c) => `${libelleSaison(c.saison).replace(/ \(.*/, '')} × ${libelleTemperature(c.temperature).replace(/^./, (x) => x.toLowerCase())} (${c.N} h)`).join(', ')}.` : ''}`;
      if (meteo()) liensMeteo(liens);
    });
    conteneur.append(
      h('h3', {}, 'Image de la vue'),
      h('p', { class: 'note' }, 'Ce qui est affiché, en PNG : maquette 3D ou plan, avec les couches actives.'),
      choix('echelle-image', [1, 2, 3].map((k) => [k, `${Math.round(W * k)} × ${Math.round(H * k)}`]), 'echelle'),
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: reglages.legendes, onchange: (e) => { reglages.legendes = e.target.checked; } }), 'Avec étiquettes, titre, échelle et nord'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton principal', onclick: exporterImage }, 'Enregistrer l\'image')),

      h('h3', {}, 'Maquette 3D'),
      h('p', { class: 'note' }, 'Bâti existant, volumes du projet (un objet chacun), sol, voirie, arbres et couches visibles, en mètres. Le GLB garde les couleurs ; l\'OBJ est lu par la plupart des logiciels.'),
      choix('format-3d', [['glb', 'GLB (glTF)'], ['obj', 'OBJ + textures (ZIP)']], 'format3D'),
      choix('etendue-3d', [['plateau', `Plateau (${Math.round(app.config.rayonPlateau * 2)} m)`], ['perimetre', `Périmètre (${Math.round(app.config.rayonEtude * 2)} m)`]], 'etendue'),
      h('label', { class: `case${app.topo?.disponible ? '' : ' indisponible'}` },
        h('input', { type: 'checkbox', disabled: !app.topo?.disponible, checked: reglages.relief, onchange: (e) => { reglages.relief = e.target.checked; } }),
        'Poser la maquette sur le relief', app.topo?.disponible ? null : h('em', {}, ' (chargez le relief dans Couches)')),
      app.projet ? h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: reglages.demolis3D, onchange: (e) => { reglages.demolis3D = e.target.checked; } }),
        'Avec le bâti démoli par le projet (objet séparé, translucide)') : h('span'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton principal', onclick: exporterMaquette }, 'Exporter la maquette')),

      h('h3', {}, 'Plan pour AutoCAD'),
      h('p', { class: 'note' }, 'DXF, un calque par thème : bâti existant (BATI_EXISTANT, ou selon l\'intérêt PSMV), démoli (BATI_DEMOLI, pointillé) et projeté (BATI_PROJET), hauteurs, parcelles et numéros, voirie, espaces verts, arbres, axes de coupe ; courbes de niveau à leur altitude et réseaux quand ils sont chargés.'),
      choix('coords-dxf', [['lambert93', 'Lambert-93 (géoréférencé)'], ['local', 'Local (mairie en 0,0)']], 'coords'),
      choix('etendue-dxf', [['plateau', 'Plateau'], ['perimetre', 'Périmètre']], 'etendueDXF'),
      app.vent ? h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: reglages.vent, onchange: (e) => { reglages.vent = e.target.checked; } }),
        'Avec le vent (phénomènes et carte de confort du dernier calcul de l\'outil Vent)') : h('span'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton principal', onclick: exporterDXF }, 'Exporter le plan DXF')),
      h('p', { class: 'note' }, (() => { const o = app.config.origine; const [X, Y] = versLambert93(o.lat, o.lon); return `Origine des exports locaux et de la maquette 3D : ${o.lat}, ${o.lon}, soit X ${X.toFixed(1)} m, Y ${Y.toFixed(1)} m en Lambert-93. En 3D, le nord est vers -z (glTF) : après import, vérifiez qu'il tombe sur l'axe vert de SketchUp.`; })()),
      app.coupes?.blocExport ? app.coupes.blocExport() : h('span'),
      h('h3', {}, 'Météo'),
      h('p', { class: 'note' }, 'Tableaux CSV (point-virgule, virgule décimale) tirés de data/meteo/meteo.json : rose des vents (secteurs × saisons × températures : fréquence, énergie, vitesses), normales mensuelles, dépassements de vitesse par secteur et par saison.'),
      choix('secteurs-meteo', [[16, '16 secteurs'], [12, '12 secteurs']], 'secteursMeteo'),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: () => exporterMeteo('rose') }, 'Rose des vents'),
        h('button', { type: 'button', class: 'bouton', onclick: () => exporterMeteo('normales') }, 'Normales mensuelles'),
        h('button', { type: 'button', class: 'bouton', onclick: () => exporterMeteo('depassements') }, 'Dépassements')),
      ui.meteo,
      liens,
    );
  }

  return { construirePanneau, exporterImage, exporterMaquette, exporterDXF, versLambert93 };
}
