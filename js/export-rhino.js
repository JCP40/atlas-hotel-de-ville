// Export Rhino (.3dm) de la maquette 3D : un objet par bâtiment et par façade photo, un calque par thème.
// La bibliothèque rhino3dm (McNeel, licence MIT) n'est pas livrée avec l'atlas : copier dans lib/rhino3dm/
//   rhino3dm.module.min.js (module ES) ou rhino3dm.min.js (script classique), et rhino3dm.wasm.
// Elle n'est chargée qu'au premier export Rhino : sans elle, l'atlas fonctionne et GLB / OBJ restent disponibles.
//
// Repère : mètres, origine locale de l'atlas (config.origine). Atlas : x est, y haut, z sud
// → Rhino : X est, Y nord, Z haut, soit (x, −z, y). Sommets en simple précision (coordonnées locales).
import * as THREE from 'three';

const BASE = new URL('../lib/rhino3dm/', import.meta.url);
const url = (f) => new URL(f, BASE).href;

export class ErreurRhino extends Error { constructor(m) { super(m); this.name = 'ErreurRhino'; } }

async function existe(f) {
  try { return (await fetch(url(f), { method: 'HEAD', cache: 'no-cache' })).ok; } catch { return false; }
}

function chargerScript(src) {
  return new Promise((ok, echec) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => echec(new ErreurRhino(`Impossible de lire ${src}.`));
    document.head.appendChild(s);
  });
}

const ABSENTE = 'Bibliothèque rhino3dm incomplète : le dossier lib/rhino3dm/ de l\'atlas doit contenir rhino3dm.wasm ET le script de la même version '
  + '(rhino3dm.module.min.js, ou rhino3dm.min.js), par exemple rhino3dm@8.4.0 (cdn.jsdelivr.net/npm/rhino3dm@8.4.0/) ou les deux fichiers ensemble de CL-WIND/js/lib/rhino3dm/ ; '
  + 'puis recharger la page (Ctrl+Maj+R). Les formats GLB et OBJ restent disponibles.';

let promesse = null;
export function chargerRhino3dm() {
  if (promesse) return promesse;
  promesse = (async () => {
    if (!await existe('rhino3dm.wasm')) throw new ErreurRhino(ABSENTE);
    let fabrique = null;
    for (const f of ['rhino3dm.module.min.js', 'rhino3dm.module.js']) {
      if (!await existe(f)) continue;
      fabrique = (await import(url(f))).default;
      break;
    }
    if (!fabrique) {
      for (const f of ['rhino3dm.min.js', 'rhino3dm.js']) {
        if (!await existe(f)) continue;
        if (typeof window.rhino3dm !== 'function') await chargerScript(url(f));
        fabrique = window.rhino3dm;
        break;
      }
    }
    if (typeof fabrique !== 'function') throw new ErreurRhino(ABSENTE);
    let rhino;
    try { rhino = await fabrique({ locateFile: (f) => url(f) }); } catch (err) {
      console.warn(err);
      throw new ErreurRhino('rhino3dm.wasm ne correspond pas au script de lib/rhino3dm/ (versions différentes ?) : y copier les deux fichiers d\'une même version de rhino3dm 8. Les formats GLB et OBJ restent disponibles.');
    }
    if (!rhino?.File3dm) throw new ErreurRhino('rhino3dm chargée mais inutilisable (version trop ancienne ?) : utiliser la version 8 dans lib/rhino3dm/.');
    return rhino;
  })();
  promesse.catch(() => { promesse = null; }); // nouvel essai au prochain export (fichiers copiés entre-temps)
  return promesse;
}

// couleur Three.js → { r, g, b, a } (0-255)
const rgba = (c, a = 255) => ({ r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), a });

// Maillage Rhino depuis une géométrie Three.js déjà placée dans le repère de l'atlas
function maillage(rhino, geo, avecCouleurs) {
  const pos = geo.getAttribute('position');
  if (!pos || pos.count < 3) return null;
  const m = new rhino.Mesh();
  const V = m.vertices(), F = m.faces();
  for (let i = 0; i < pos.count; i++) V.add(pos.getX(i), -pos.getZ(i), pos.getY(i));
  const ind = geo.index;
  const n = ind ? ind.count : pos.count;
  for (let t = 0; t + 2 < n; t += 3) {
    const a = ind ? ind.getX(t) : t, b = ind ? ind.getX(t + 1) : t + 1, c = ind ? ind.getX(t + 2) : t + 2;
    if (a !== b && b !== c && a !== c) F.addTriFace(a, b, c);
  }
  const uv = geo.getAttribute('uv');
  if (uv) { const T = m.textureCoordinates(); for (let i = 0; i < uv.count; i++) T.add(uv.getX(i), uv.getY(i)); }
  const col = avecCouleurs && geo.getAttribute('color');
  if (col) {
    const C = m.vertexColors();
    for (let i = 0; i < col.count; i++) C.add(Math.round(col.getX(i) * 255), Math.round(col.getY(i) * 255), Math.round(col.getZ(i) * 255));
  }
  V.useDoublePrecisionVertices = false; // coordonnées locales : simple précision (après l'ajout, qui passe en double)
  m.normals().computeNormals();
  if (!F.count) { m.delete?.(); return null; }
  return m;
}

// scene : scène d'export de js/export.js (objets nommés, userData.calque, userData.attributs)
// infos : { texte, origine: { lat, lon, nom }, L93: [X, Y], h0 } → Uint8Array du fichier .3dm (Rhino 7 et 8)
export async function fichier3dm(scene, infos) {
  const rhino = await chargerRhino3dm();
  const doc = new rhino.File3dm();
  doc.applicationName = 'Atlas du site de l\'Hôtel de Ville de Nantes';
  doc.applicationDetails = 'Export de la maquette 3D (js/export-rhino.js, rhino3dm)';
  doc.startSectionComments = infos.texte;

  const reglages = doc.settings();
  reglages.modelUnitSystem = rhino.UnitSystem.Meters;
  reglages.modelAbsoluteTolerance = 0.001;
  // point d'ancrage terrestre : l'origine locale (0, 0, 0) est au point de référence, Y au nord, X à l'est
  const ancre = reglages.earthAnchorPoint;
  ancre.earthBasepointLatitude = infos.origine.lat;
  ancre.earthBasepointLongitude = infos.origine.lon;
  ancre.earthBasepointElevation = infos.h0 ?? 0;
  ancre.modelBasePoint = [0, 0, 0];
  ancre.modelNorth = [0, 1, 0];
  ancre.modelEast = [1, 0, 0];
  ancre.name = infos.origine.nom || 'Origine de l\'atlas';
  ancre.description = `Lambert-93 (EPSG:2154) de l'origine : X ${infos.L93[0].toFixed(3)} m, Y ${infos.L93[1].toFixed(3)} m`;
  reglages.earthAnchorPoint = ancre;

  // texte du document (Rhino : commande SetDocumentUserText / GetDocumentUserText)
  const S = doc.strings();
  const chaines = {
    atlas_origine_lat: String(infos.origine.lat),
    atlas_origine_lon: String(infos.origine.lon),
    atlas_origine_nom: infos.origine.nom || '',
    L93_decalage_x: infos.L93[0].toFixed(3),
    L93_decalage_y: infos.L93[1].toFixed(3),
    L93_epsg: '2154',
    L93_mode_emploi: 'Coordonnées Lambert-93 = coordonnées Rhino + (L93_decalage_x, L93_decalage_y) ; Z = altitude relative (0 au sol de l\'origine).',
    altitude_reference_NGF_m: infos.h0 != null ? infos.h0.toFixed(2) : '',
    axes: 'X est, Y nord, Z haut ; unité le mètre',
    export_date: new Date().toISOString(),
    notes: infos.texte,
  };
  for (const [k, v] of Object.entries(chaines)) S.set(k, v);

  // calques (un par thème) et matériau du calque
  const calques = new Map();
  const calque = (nom, couleur) => {
    if (calques.has(nom)) return calques.get(nom);
    const mat = new rhino.Material();
    mat.name = nom;
    mat.diffuseColor = rgba(couleur);
    doc.materials().add(mat);
    const L = new rhino.Layer();
    L.name = nom;
    L.color = rgba(couleur);
    L.renderMaterialIndex = doc.materials().count - 1;
    doc.layers().add(L);
    const i = doc.layers().count - 1;
    calques.set(nom, i);
    return i;
  };

  scene.updateMatrixWorld(true);
  let n = 0;
  const objets = [];
  scene.traverse((o) => { if (o.isMesh) objets.push(o); });
  for (const o of objets) {
    let nomCalque = null;
    for (let p = o; p && !nomCalque; p = p.parent) nomCalque = p.userData?.calque || null;
    const mat0 = [].concat(o.material)[0];
    const couleur = mat0?.color || new THREE.Color(0.8, 0.8, 0.8);
    const iCalque = calque(nomCalque || 'Divers', couleur);
    const geo = o.geometry.clone().applyMatrix4(o.matrixWorld);
    const m = maillage(rhino, geo, !!mat0?.vertexColors);
    geo.dispose();
    if (!m) continue;
    const at = new rhino.ObjectAttributes();
    at.name = o.name || '';
    at.layerIndex = iCalque;
    at.materialSource = rhino.ObjectMaterialSource.MaterialFromLayer;
    // objet d'une autre couleur que son calque (volumes du projet colorés)
    if (o.userData.couleurPropre && mat0?.color) { at.colorSource = rhino.ObjectColorSource.ColorFromObject; at.objectColor = rgba(mat0.color); }
    for (const [k, v] of Object.entries(o.userData.attributs || {})) if (v != null && v !== '') at.setUserString(k, String(v));
    doc.objects().addMesh(m, at);
    m.delete?.();
    at.delete?.();
    n++;
  }
  const opt = new rhino.File3dmWriteOptions();
  opt.version = 7; // lisible par Rhino 7 et 8
  const octets = doc.toByteArrayOptions(opt);
  doc.delete?.();
  return { octets, objets: n, calques: calques.size };
}
