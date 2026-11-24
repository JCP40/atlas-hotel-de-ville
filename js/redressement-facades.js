import * as THREE from 'three';
import { h, info, lireLS, ecrireLS } from './util.js';
import { enregistrerDonnees, telecharger } from './donnees.js';
import { pointDansPolygone } from './geo.js';
import { remplacerBlocFacade, serialiserFacades } from './calage-facades.js';

// Redressement des photos de façade à partir de Panoramax (19/11/2026). Ouvert depuis le panneau Calage (onglet Bâtiments,
// js/calage-facades.js : « Chercher une photo Panoramax / Redresser », « Ajouter une façade »), chargé à la demande.
// 1. Recherche : API STAC de Panoramax (api.panoramax.xyz/api/search, bbox autour du milieu de la façade ; ou identifiant de
//    photo / de séquence collé par l'utilisateur). Seule la position de la façade est envoyée (bbox publique), rien d'autre.
//    Chaque photo : position, azimut (view:azimuth), champ (pers:interior_orientation.field_of_view ; 360 = panorama
//    équirectangulaire), date, auteur, licence ; distance au milieu de la façade, obliquité (angle entre la visée vers la façade
//    et sa normale), côté rue, façade dans le champ, résolution estimée sur la façade (px/m) → classement.
// 2. Redressement : photo plane, ou vue perspective tirée du panorama 360 (lacet, tangage, champ réglables), quatre coins à
//    cliquer (haut gauche, haut droit, bas droit, bas gauche ; positions estimées d'après la position et l'azimut de la photo),
//    homographie (8 inconnues, normalisation de Hartley) vers un rectangle à l'échelle (longueur × hauteur_m de la façade),
//    rendu bilinéaire, aperçu en direct avec grille de 1 m, JPEG 0,9.
// 3. Sortie : aperçu sur la maquette (texture blob:, rien d'écrit), puis « Enregistrer » : le JPEG remplace
//    data/facades/<ensemble>/<image> (serveur.py garde l'ancienne dans data/.sauvegardes/) et l'entrée JSON est mise à jour
//    (source, auteur, licence, lien, date_prise, confiance, redressement { date, photo_id, coins, … }). Sans serveur : téléchargement.
// 4. Ajouter une façade : clic sur un mur (côté d'emprise d'un corps détaillé) → nouvelle entrée, même redressement.
// 5. Ma photo (19/11/2026) : photos personnelles choisies ou glissées dans la fenêtre (JPEG, PNG, WebP, HEIC si le navigateur
//    le lit), lues sur l'ordinateur seulement (createImageBitmap / objet URL, rien n'est envoyé). Orientation EXIF appliquée
//    (imageOrientation 'from-image'), EXIF lus par lireExif (date de prise de vue, GPS, GPSImgDirection, focale 24 × 36,
//    XMP GPano) : coins estimés si la position est connue, sinon rectangle à ajuster. Grand côté ≤ 8000 px pour le calcul,
//    affichage réduit. Panorama 360° (case, cochée d'office pour un rapport 2:1 ou GPano) : même vue perspective que Panoramax.
//    Auteur et licence choisis dans la fenêtre (localStorage), source « Photo personnelle », trace redressement { type:
//    'personnelle', nom_fichier, … }. « Reprendre le redressement » : photo d'origine relue (Panoramax) ou redemandée (fichier).

const API = 'https://api.panoramax.xyz/api';
const RAD = Math.PI / 180;
const H_CAMERA = 2.5; // m au-dessus du sol : véhicules immergis / Carto'Cité ; piéton ≈ 1,6 (réglable)
const PX_M_MAX_COTE = 2048; // côté maximal de l'image redressée (comme les images existantes)
// licences ouvertes acceptées (code Panoramax → libellé des fichiers de l'atlas)
const LICENCES = {
  'etalab-2.0': 'Licence Ouverte 2.0 (Etalab)',
  'lov2': 'Licence Ouverte 2.0 (Etalab)',
  'cc-by-sa-4.0': 'CC BY-SA 4.0',
  'cc-by-4.0': 'CC BY 4.0',
  'cc0-1.0': 'CC0 1.0',
  'cc0': 'CC0 1.0',
};
const URL_LICENCES = {
  'Licence Ouverte 2.0 (Etalab)': 'https://www.etalab.gouv.fr/licence-ouverte-open-licence/',
  'CC BY-SA 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/deed.fr',
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/deed.fr',
  'CC0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/deed.fr',
};
// licences proposées pour une photo personnelle (le dernier choix ouvre un champ texte)
export const LICENCES_PERSO = ['Photo personnelle — usage pédagogique', 'CC BY 4.0', 'CC BY-SA 4.0', 'Domaine public / CC0', 'Autre (texte)'];
const PEDAGOGIQUE = LICENCES_PERSO[0];
URL_LICENCES['Domaine public / CC0'] = URL_LICENCES['CC0 1.0'];
const AUTEUR_DEFAUT = 'Jean-Charles Poullain';
const CLE_AUTEUR = 'atlas-hdv-redressement-auteur', CLE_LICENCE = 'atlas-hdv-redressement-licence';
const MAX_COTE_PERSO = 8000; // grand côté maximal d'une photo personnelle pour le calcul (≈ 190 Mo en RGBA)
const MAX_AFFICHAGE = 3000; // grand côté de l'image affichée (le redressement lit la pleine résolution)
const NOMS_COINS = ['haut gauche', 'haut droit', 'bas droit', 'bas gauche'];
const ABR_COINS = ['HG', 'HD', 'BD', 'BG'];
const COULEURS_COINS = ['#d7263d', '#1b6fd8', '#1b9e5a', '#e08a00'];
const r2 = (v) => Math.round(v * 100) / 100;
const r1 = (v) => Math.round(v * 10) / 10;
const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

// ------------------------------------------------------------------
// Calculs purs (exportés pour les essais)
// ------------------------------------------------------------------

// Système linéaire (Gauss, pivot partiel) ; null si singulier
export function resoudre(A, b) {
  const n = b.length;
  const M = A.map((l, i) => [...l, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let i = c + 1; i < n; i++) if (Math.abs(M[i][c]) > Math.abs(M[p][c])) p = i;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let i = c + 1; i < n; i++) {
      const k = M[i][c] / M[c][c];
      if (!k) continue;
      for (let j = c; j <= n; j++) M[i][j] -= k * M[c][j];
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return x;
}
const mul3 = (A, B) => {
  const C = new Array(9).fill(0);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) C[i * 3 + j] += A[i * 3 + k] * B[k * 3 + j];
  return C;
};
// normalisation de Hartley : centre au barycentre, distance moyenne √2
function normaliser(pts) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const d = pts.reduce((s, p) => s + Math.hypot(p[0] - cx, p[1] - cy), 0) / pts.length || 1;
  const k = Math.SQRT2 / d;
  return { T: [k, 0, -k * cx, 0, k, -k * cy, 0, 0, 1], Ti: [1 / k, 0, cx, 0, 1 / k, cy, 0, 0, 1], p: pts.map(([x, y]) => [k * (x - cx), k * (y - cy)]) };
}
// Homographie H (3 × 3, ligne par ligne, H[8] = 1) qui envoie src[i] sur dst[i] (4 points) ; null si dégénérée
export function homographie(src, dst) {
  const S = normaliser(src), D = normaliser(dst);
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = S.p[i], [u, v] = D.p[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  const x = resoudre(A, b);
  if (!x || x.some((v) => !Number.isFinite(v))) return null;
  const H = mul3(D.Ti, mul3([...x, 1], S.T));
  return H.map((v) => v / H[8]);
}
export function appliquerH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}
export function erreurReprojection(H, src, dst) {
  return Math.max(...src.map(([x, y], i) => { const [u, v] = appliquerH(H, x, y); return Math.hypot(u - dst[i][0], v - dst[i][1]); }));
}
// quadrilatère convexe et dans l'ordre HG, HD, BD, BG (sens horaire à l'écran)
export function quadValide(c) {
  if (c.length !== 4) return false;
  let signe = 0;
  for (let i = 0; i < 4; i++) {
    const [a, b, d] = [c[i], c[(i + 1) % 4], c[(i + 2) % 4]];
    const z = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
    if (Math.abs(z) < 1e-9) return false;
    if (signe && Math.sign(z) !== signe) return false;
    signe = Math.sign(z);
  }
  return signe > 0;
}

// lecture bilinéaire d'une image { data, width, height } (RGBA) ; enroule en x si wrap (panorama)
function lire(src, x, y, out, o, wrap = false) {
  const W = src.width, Hh = src.height, d = src.data;
  if (!wrap && (x < -0.5 || y < -0.5 || x > W - 0.5 || y > Hh - 0.5)) { out[o] = out[o + 1] = out[o + 2] = 200; out[o + 3] = 255; return; }
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cy = (v) => (v < 0 ? 0 : v >= Hh ? Hh - 1 : v);
  const cx = wrap ? (v) => ((v % W) + W) % W : (v) => (v < 0 ? 0 : v >= W ? W - 1 : v);
  const a = (cy(y0) * W + cx(x0)) * 4, b = (cy(y0) * W + cx(x0 + 1)) * 4, c = (cy(y0 + 1) * W + cx(x0)) * 4, e = (cy(y0 + 1) * W + cx(x0 + 1)) * 4;
  for (let k = 0; k < 3; k++) {
    out[o + k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy;
  }
  out[o + 3] = 255;
}
// Image redressée W × Hh : le rectangle (0,0)-(W,Hh) est envoyé sur les coins [HG, HD, BD, BG] de la source (pixels)
export function redresser(src, coins, W, Hh) {
  const H = homographie([[0, 0], [W, 0], [W, Hh], [0, Hh]], coins);
  if (!H) return null;
  const out = new Uint8ClampedArray(W * Hh * 4);
  for (let j = 0; j < Hh; j++) {
    for (let i = 0; i < W; i++) {
      const x = i + 0.5, y = j + 0.5;
      const w = H[6] * x + H[7] * y + H[8];
      lire(src, (H[0] * x + H[1] * y + H[2]) / w - 0.5, (H[3] * x + H[4] * y + H[5]) / w - 0.5, out, (j * W + i) * 4);
    }
  }
  return { data: out, width: W, height: Hh, H };
}

// Directions et caméras dans le repère de l'atlas (x est, y haut, z sud) ; azimut depuis le nord, horaire
export const direction = (az, el = 0) => [Math.cos(el * RAD) * Math.sin(az * RAD), Math.sin(el * RAD), -Math.cos(el * RAD) * Math.cos(az * RAD)];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norme = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
// caméra sténopé : P position, yaw azimut de visée, pitch tangage (°, + vers le haut), fov champ horizontal (°), W × H pixels
export function camera({ P, yaw, pitch = 0, fov, W, H }) {
  const f = direction(yaw, pitch);
  const r = [Math.cos(yaw * RAD), 0, Math.sin(yaw * RAD)];
  const u = cross(r, f);
  const fpx = (W / 2) / Math.tan((fov * RAD) / 2);
  return {
    P, yaw, pitch, fov, W, H, f, r, u, fpx,
    projeter(X) {
      const v = [X[0] - P[0], X[1] - P[1], X[2] - P[2]];
      const cf = dot(v, f);
      if (cf <= 1e-6) return null;
      return [W / 2 + (fpx * dot(v, r)) / cf, H / 2 - (fpx * dot(v, u)) / cf];
    },
    rayon(px, py) {
      const a = px - W / 2, b = H / 2 - py;
      return norme([f[0] * fpx + r[0] * a + u[0] * b, f[1] * fpx + r[1] * a + u[1] * b, f[2] * fpx + r[2] * a + u[2] * b]);
    },
  };
}
// direction → pixel d'un panorama équirectangulaire dont le centre regarde vers az0
export function pixelEqui(d, az0, We, He) {
  const A = Math.atan2(d[0], -d[2]) / RAD, E = Math.asin(Math.max(-1, Math.min(1, d[1]))) / RAD;
  return [((((A - az0) / 360 + 0.5) % 1) + 1) % 1 * We, (0.5 - E / 180) * He];
}
// vue perspective (caméra cam) tirée d'un panorama { data, width, height } dont le centre regarde vers az0
export function vueDepuisPanorama(equi, az0, cam) {
  const { W, H } = cam;
  const out = new Uint8ClampedArray(W * H * 4);
  const { f, r, u, fpx } = cam;
  const We = equi.width, He = equi.height;
  for (let j = 0; j < H; j++) {
    const b = H / 2 - (j + 0.5);
    for (let i = 0; i < W; i++) {
      const a = i + 0.5 - W / 2;
      const dx = f[0] * fpx + r[0] * a + u[0] * b, dy = f[1] * fpx + r[1] * a + u[1] * b, dz = f[2] * fpx + r[2] * a + u[2] * b;
      const l = Math.hypot(dx, dy, dz);
      const A = Math.atan2(dx, -dz) / RAD, E = Math.asin(dy / l) / RAD;
      const x = ((((A - az0) / 360 + 0.5) % 1) + 1) % 1 * We - 0.5, y = (0.5 - E / 180) * He - 0.5;
      lire(equi, x, y, out, (j * W + i) * 4, true);
    }
  }
  return { data: out, width: W, height: H };
}

// Repère d'une façade : u gauche → droite, n vers la rue (N = (sin az, −cos az), comme js/toits.js), coins 3D
export function geometrieFacade(f, { sol = 0 } = {}) {
  const [gx, gz] = f.gauche, [dx, dz] = f.droite;
  const L = Math.hypot(dx - gx, dz - gz) || 1;
  const u = [(dx - gx) / L, (dz - gz) / L];
  const N = [Math.sin(f.normale_az * RAD), -Math.cos(f.normale_az * RAD)];
  const s = u[1] * N[0] - u[0] * N[1] >= 0 ? 1 : -1;
  const n = [s * u[1], -s * u[0]];
  const b = sol + (Number.isFinite(f.base_m) ? f.base_m : 0), H = f.hauteur_m;
  return {
    L, u, n, M: [(gx + dx) / 2, (gz + dz) / 2],
    coins: [[gx, b + H, gz], [dx, b + H, dz], [dx, b, dz], [gx, b, gz]], // HG, HD, BD, BG
  };
}
const ecartAngle = (a, b) => { const d = (((a - b) % 360) + 540) % 360 - 180; return Math.abs(d); };
const azimutVers = (dx, dz) => ((Math.atan2(dx, -dz) / RAD) + 360) % 360;

// Analyse d'une photo Panoramax (feature STAC) pour une façade : indicateurs et note (plus bas = meilleur)
export function analyserPhoto(feat, f, proj) {
  const p = feat.properties || {};
  const [lon, lat] = feat.geometry?.coordinates || [];
  const { x, z } = proj.versLocal(lat, lon);
  const io = p['pers:interior_orientation'] || {};
  const dims = io.sensor_array_dimensions || null;
  const fovBrut = Number(io.field_of_view);
  const pano = fovBrut >= 359 || (!fovBrut && dims && Math.abs(dims[0] / dims[1] - 2) < 0.02 && dims[0] >= 3000);
  const fisheye = !pano && fovBrut > 130;
  const fov = pano ? 360 : (fovBrut > 0 ? fovBrut : 70);
  const az = Number(p['view:azimuth']);
  const G = geometrieFacade(f);
  const vx = G.M[0] - x, vz = G.M[1] - z;
  const distance = Math.hypot(vx, vz);
  const visee = azimutVers(vx, vz); // de la photo vers le milieu de la façade
  const obliquite = Math.acos(Math.max(-1, Math.min(1, -(vx * G.n[0] + vz * G.n[1]) / (distance || 1)))) / RAD;
  const coteRue = (x - G.M[0]) * G.n[0] + (z - G.M[1]) * G.n[1] > 0.3;
  const azG = azimutVers(f.gauche[0] - x, f.gauche[1] - z), azD = azimutVers(f.droite[0] - x, f.droite[1] - z);
  const angleFacade = ecartAngle(azG, azD); // largeur angulaire de la façade vue de la photo
  const dansChamp = pano || (Number.isFinite(az) && Math.max(ecartAngle(az, azG), ecartAngle(az, azD)) <= fov / 2);
  const largeur = dims?.[0] || (pano ? 5760 : 4000);
  const fpx = pano ? largeur / (2 * Math.PI) : (largeur / 2) / Math.tan((fov * RAD) / 2);
  const pxm = fpx / Math.max(distance, 1) * Math.cos(Math.min(obliquite, 80) * RAD);
  const code = String(p.license || '').toLowerCase();
  const licence = LICENCES[code] || null;
  const producteurs = (feat.providers || []).filter((v) => (v.roles || []).includes('producer')).map((v) => v.name);
  const auteur = [...new Set(producteurs.length ? producteurs : [p['geovisio:producer']].filter(Boolean))].join(', ') || 'inconnu';
  const date = String(p.datetimetz || p.datetime || '').slice(0, 10);
  const instance = (feat.links || []).find((l) => l.rel === 'via')?.instance_name || '';
  let note = obliquite;
  const raisons = [];
  if (!coteRue) { note += 1000; raisons.push('derrière la façade'); }
  if (!dansChamp) { note += 80; raisons.push('façade hors du champ'); }
  if (fisheye) { note += 500; raisons.push('fisheye non géré'); }
  if (!licence) { note += 2000; raisons.push(`licence non reconnue (${p.license || '?'})`); }
  if (!Number.isFinite(az)) { note += 30; raisons.push('azimut inconnu'); }
  if (distance < 4) note += 20;
  if (distance > 35) note += distance - 35;
  if (pxm < 40) note += (40 - pxm) * 0.5;
  // trop près (rue étroite) : façade très large dans le champ, et l'erreur GPS (3 à 5 m) y pèse le plus
  if (angleFacade > 90) note += (angleFacade - 90) * 0.5;
  if (angleFacade > 110) raisons.push('façade très large dans le champ (trop près ?)');
  return {
    id: feat.id, collection: feat.collection, lat, lon, x, z, az, fov, pano, fisheye, dims, largeur,
    date, auteur, licenceCode: p.license, licence, instance,
    modele: [io.camera_manufacturer, io.camera_model].filter(Boolean).join(' '),
    thumb: feat.assets?.thumb?.href || p['geovisio:thumbnail'], sd: feat.assets?.sd?.href, hd: feat.assets?.hd?.href || p['geovisio:image'],
    lien: (feat.links || []).find((l) => l.rel === 'self')?.href || `${API}/collections/${feat.collection}/items/${feat.id}`,
    distance, obliquite, visee, coteRue, dansChamp, angleFacade, pxm, note, raisons,
    utilisable: coteRue && !fisheye && !!licence,
  };
}

// vue perspective par défaut (panorama) : visée sur le milieu de la façade, champ couvrant les quatre coins (+12 %)
export function vueParDefaut(P, coins, largeurPano) {
  const m = [0, 1, 2].map((k) => coins.reduce((s, c) => s + c[k], 0) / 4);
  const v = [m[0] - P[0], m[1] - P[1], m[2] - P[2]];
  const yaw = azimutVers(v[0], v[2]);
  const pitch = Math.atan2(v[1], Math.hypot(v[0], v[2])) / RAD;
  const c0 = camera({ P, yaw, pitch, fov: 90, W: 1000, H: 1000 });
  let th = 0.3, tv = 0.3;
  for (const X of coins) {
    const w = [X[0] - P[0], X[1] - P[1], X[2] - P[2]];
    const cf = Math.max(dot(w, c0.f), 0.05);
    th = Math.max(th, Math.abs(dot(w, c0.r)) / cf); tv = Math.max(tv, Math.abs(dot(w, c0.u)) / cf);
  }
  th *= 1.12; tv *= 1.12;
  const fov = Math.min(120, Math.max(40, (2 * Math.atan(th)) / RAD));
  const tanH = Math.tan((fov * RAD) / 2);
  const W = Math.round(Math.min(4096, Math.max(1200, (2 * tanH * largeurPano) / (2 * Math.PI))));
  let Hpx = Math.round(Math.min(2 * W, Math.max(0.4 * W, (W * tv) / tanH)));
  // au plus 12 Mpx (mémoire et temps de calcul) : les deux côtés réduits ensemble
  const k = Math.min(1, Math.sqrt(12e6 / (W * Hpx)));
  return { yaw: r1(yaw), pitch: r1(pitch), fov: r1(fov), W: Math.round(W * k), H: Math.round(Hpx * k) };
}

// insère un bloc de façade après le dernier élément du tableau « facades » du texte (le reste du fichier inchangé) ; null sinon
export function insererFacade(texte, d, objet) {
  const der = d.facades?.[d.facades.length - 1];
  if (!der) return null;
  const cle = `"id": ${JSON.stringify(der.id)}`;
  const i = texte.indexOf(cle);
  if (i < 0) return null;
  const debut = texte.lastIndexOf('{', i);
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
  return `${texte.slice(0, fin + 1)},\n${ligne}${bloc}${texte.slice(fin + 1)}`;
}

// Lecture des métadonnées EXIF (JPEG APP1, WebP « EXIF », PNG « eXIf ») et XMP GPano d'un début de fichier (ArrayBuffer).
// → { orientation, marque, modele, date ('AAAA-MM-JJ'), heure, focale, focale35, gps { lat, lon }, direction, directionRef,
//     gpano (projection équirectangulaire déclarée), capPano (GPano:PoseHeadingDegrees) } ; champs absents si inconnus.
export function lireExif(buf) {
  const v = new DataView(buf);
  const n = v.byteLength;
  const res = {};
  let tiff = -1;
  if (n > 4 && v.getUint16(0) === 0xFFD8) {
    for (let o = 2; o + 4 <= n;) {
      if (v.getUint8(o) !== 0xFF) break;
      const m = v.getUint8(o + 1);
      if (m === 0xD9 || m === 0xDA) break;
      if (m === 0xE1 && tiff < 0 && o + 10 <= n && v.getUint32(o + 4) === 0x45786966) tiff = o + 10; // « Exif\0\0 »
      o += 2 + v.getUint16(o + 2);
    }
  } else if (n > 12 && v.getUint32(0) === 0x52494646 && v.getUint32(8) === 0x57454250) { // RIFF … WEBP
    for (let o = 12; o + 8 <= n;) {
      const L = v.getUint32(o + 4, true);
      if (v.getUint32(o) === 0x45584946) { tiff = o + 8; if (tiff + 6 <= n && v.getUint32(tiff) === 0x45786966) tiff += 6; break; }
      o += 8 + L + (L & 1);
    }
  } else if (n > 8 && v.getUint32(0) === 0x89504E47) { // PNG
    for (let o = 8; o + 8 <= n;) {
      const L = v.getUint32(o);
      if (v.getUint32(o + 4) === 0x65584966) { tiff = o + 8; break; }
      o += 12 + L;
    }
  }
  // XMP des panoramas (Photo Sphere) : texte brut cherché dans le tampon
  const texte = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(n, 1 << 20)));
  if (/GPano:ProjectionType\s*(=\s*["']|>)\s*equirectangular/i.test(texte)) res.gpano = true;
  const cap = texte.match(/GPano:PoseHeadingDegrees\s*(?:=\s*["']|>)\s*(-?[\d.]+)/i);
  if (cap && Number.isFinite(+cap[1])) res.capPano = ((+cap[1] % 360) + 360) % 360;
  if (tiff < 0 || tiff + 8 > n) return res;
  const le = v.getUint16(tiff) === 0x4949;
  const u16 = (o) => v.getUint16(o, le), u32 = (o) => v.getUint32(o, le);
  if (u16(tiff + 2) !== 42) return res;
  const TAILLES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const ifd = (off) => {
    const tags = {};
    const o = tiff + off;
    if (!Number.isFinite(off) || o + 2 > n) return tags;
    const k = u16(o);
    for (let i = 0; i < k; i++) { const e = o + 2 + i * 12; if (e + 12 > n) break; tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), e }; }
    return tags;
  };
  const val = (t) => {
    if (!t || !TAILLES[t.type]) return null;
    const sz = TAILLES[t.type] * t.count;
    const o = sz <= 4 ? t.e + 8 : tiff + u32(t.e + 8);
    if (o + sz > n) return null;
    if (t.type === 2) { let s = ''; for (let i = 0; i < t.count; i++) { const c = v.getUint8(o + i); if (!c) break; s += String.fromCharCode(c); } return s.trim(); }
    const out = [];
    for (let i = 0; i < t.count; i++) {
      const p = o + i * TAILLES[t.type];
      if (t.type === 1 || t.type === 7) out.push(v.getUint8(p));
      else if (t.type === 3) out.push(u16(p));
      else if (t.type === 4) out.push(u32(p));
      else if (t.type === 9) out.push(v.getInt32(p, le));
      else if (t.type === 5) out.push(u32(p) / (u32(p + 4) || 1));
      else if (t.type === 10) out.push(v.getInt32(p, le) / (v.getInt32(p + 4, le) || 1));
    }
    return out;
  };
  const i0 = ifd(u32(tiff + 4));
  res.orientation = val(i0[0x0112])?.[0] || 1;
  if (val(i0[0x010F])) res.marque = val(i0[0x010F]);
  if (val(i0[0x0110])) res.modele = val(i0[0x0110]);
  const ex = i0[0x8769] ? ifd(val(i0[0x8769])?.[0]) : {};
  const dt = val(ex[0x9003]) || val(ex[0x9004]) || val(i0[0x0132]);
  const m = typeof dt === 'string' ? dt.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/) : null;
  if (m && m[1] !== '0000') { res.date = `${m[1]}-${m[2]}-${m[3]}`; res.heure = `${m[4]}:${m[5]}`; }
  const f35 = val(ex[0xA405])?.[0], f = val(ex[0x920A])?.[0];
  if (f35 > 0) res.focale35 = f35;
  if (f > 0) res.focale = r1(f);
  if (i0[0x8825]) {
    const g = ifd(val(i0[0x8825])?.[0]);
    const dms = (a) => (a && a.length >= 3 && a.every(Number.isFinite) ? a[0] + a[1] / 60 + a[2] / 3600 : null);
    const lat = dms(val(g[2])), lon = dms(val(g[4]));
    if (lat != null && lon != null && (lat || lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      res.gps = { lat: /^S/i.test(val(g[1]) || '') ? -lat : lat, lon: /^W/i.test(val(g[3]) || '') ? -lon : lon };
    }
    const dir = val(g[17])?.[0];
    if (Number.isFinite(dir) && dir >= 0 && dir <= 360) { res.direction = r1(dir % 360); res.directionRef = val(g[16]) || 'T'; }
  }
  return res;
}
// champ horizontal (°) d'une photo plane d'après la focale équivalente 24 × 36 (36 mm de large en paysage, 24 en portrait)
export function champPhoto(focale35, W, H) {
  if (!(focale35 > 0)) return 65;
  return r1((2 * Math.atan((W >= H ? 18 : 12) / focale35)) / RAD);
}

// ------------------------------------------------------------------
// Outil
// ------------------------------------------------------------------
export function creerRedressementFacades(app, calage) {
  const T = app.toits;
  const etat = {
    f: null, // façade (objet de app.toits, ou nouvelle façade pas encore ajoutée)
    nouvelle: null, // { ensemble, corps } pour une façade ajoutée
    candidates: [], photo: null, // analyse choisie
    perso: [], // photos personnelles (en tête de liste, gardées d'une façade à l'autre)
    source: null, // { canvas, data (ImageData), cam (caméra de l'image affichée), equi?, hd }
    coins: [], // 4 × [x, y] en pixels de l'image affichée
    actif: -1, // coin sélectionné (flèches)
    ppm: 60, hCam: H_CAMERA, hd: true, grille: true,
    rendu: null, // { blob, url, W, H, coins, vue }
    apercu: false, // texture blob: posée sur la maquette (non enregistrée)
    choixMur: false,
  };
  const ui = {};

  // ---------------- styles ----------------
  if (!document.getElementById('styles-redressement')) {
    document.head.append(h('style', { id: 'styles-redressement' }, `
.redr-fond { position: fixed; inset: 0; z-index: 2000; background: rgba(30, 40, 48, 0.45); display: flex; }
.redr-boite { margin: 2vh 2vw; flex: 1; background: var(--calque-plein, #f6f8f7); color: var(--ardoise, #2f3b45); border-radius: 6px;
  box-shadow: var(--ombre); display: grid; grid-template-rows: auto 1fr; min-height: 0; overflow: hidden; font-size: 13px; }
.redr-tete { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--trait); flex-wrap: wrap; }
.redr-tete h2 { font: 500 17px var(--serif, serif); margin: 0 auto 0 0; }
.redr-corps { display: grid; grid-template-columns: minmax(260px, 340px) 1fr; min-height: 0; }
.redr-liste { overflow: auto; border-right: 1px solid var(--trait); padding: 8px; }
.redr-liste form { display: grid; gap: 4px; margin-bottom: 8px; }
.redr-liste label { display: flex; gap: 6px; align-items: center; }
.redr-carte { display: grid; grid-template-columns: 96px 1fr; gap: 6px; padding: 5px; border: 1px solid var(--trait); border-radius: 4px; margin: 0 0 6px; cursor: pointer; background: #fff; }
.redr-carte[aria-current='true'] { outline: 2px solid var(--ardoise); }
.redr-carte.inutilisable { opacity: 0.55; }
.redr-carte img { width: 96px; height: 64px; object-fit: cover; background: var(--ciel); }
.redr-carte .ind { font-variant-numeric: tabular-nums; line-height: 1.3; }
.redr-carte .bon { color: #1b7a45; } .redr-carte .moyen { color: #9a6a00; } .redr-carte .mauvais { color: #b3261e; }
.redr-travail { display: grid; grid-template-rows: auto 1fr auto; min-height: 0; min-width: 0; }
.redr-outils { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 6px 8px; border-bottom: 1px solid var(--trait); }
.redr-outils input[type=range] { width: 110px; }
.redr-vues { display: grid; grid-template-columns: 3fr 2fr; gap: 6px; min-height: 0; padding: 6px; }
.redr-vues > div { position: relative; min-height: 0; min-width: 0; background: #20282e; border-radius: 4px; overflow: hidden; }
.redr-vues canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; }
.redr-legende { position: absolute; left: 6px; bottom: 6px; color: #fff; background: rgba(0, 0, 0, 0.55); padding: 2px 6px; border-radius: 3px; pointer-events: none; }
.redr-pied { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; padding: 6px 8px; border-top: 1px solid var(--trait); }
.redr-pied .note { margin: 0; flex: 1 1 260px; }
.redr-credit { font-size: 12px; color: var(--ardoise-doux); }
.redr-perso { display: grid; gap: 4px; padding: 6px; margin-bottom: 8px; border: 1px dashed var(--trait); border-radius: 4px; background: #fff; }
.redr-perso.survol { outline: 2px dashed var(--ardoise); background: var(--ciel, #e8f0f4); }
.redr-perso .titre-info { display: flex; align-items: center; gap: 6px; }
.redr-perso input[type=text], .redr-perso select { min-width: 0; flex: 1; }
.redr-perso .avert { color: #9a6a00; margin: 0; font-size: 12px; }
.redr-carte.perso { border-color: var(--ardoise); }
@media (max-width: 900px) { .redr-corps { grid-template-columns: 1fr; grid-template-rows: 40% 1fr; } .redr-vues { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr; } }
`));
  }

  // ---------------- géométrie ----------------
  const sol = (x, z) => (app.relief?.dz ? app.relief.dz(x, z) || 0 : 0);
  function geometrie(f) {
    const G0 = geometrieFacade(f);
    return geometrieFacade(f, { sol: sol(G0.M[0], G0.M[1]) });
  }
  const positionPhoto = (ph) => [ph.x, sol(ph.x, ph.z) + etat.hCam, ph.z];

  // ---------------- recherche Panoramax ----------------
  async function lireJSON(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const r = await fetch(url, { signal: ctl.signal, referrerPolicy: 'no-referrer', credentials: 'omit' });
      if (!r.ok) throw new Error(`Panoramax a répondu ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  }
  function bbox(x, z, rayon) {
    const a = app.proj.versGeo(x - rayon, z + rayon), b = app.proj.versGeo(x + rayon, z - rayon);
    return [a.lon, a.lat, b.lon, b.lat].map((v) => v.toFixed(6)).join(',');
  }
  async function chercher() {
    const f = etat.f;
    if (!f) return;
    const rayon = Math.max(10, Math.min(150, +ui.rayon.value || 40));
    const G = geometrie(f);
    ui.etatRecherche.textContent = 'Recherche sur Panoramax…';
    const vus = new Map();
    const ajouter = (fs, parId = false) => { for (const x of fs || []) if (x?.id && x.geometry && !vus.has(x.id)) vus.set(x.id, { feat: x, parId }); };
    try {
      // identifiants collés (photo ou séquence) : photo par ?ids=, sinon séquence filtrée autour de la façade
      const ids = [...new Set((ui.ident.value.match(uuid) || []).map((s) => s.toLowerCase()))];
      for (const id of ids) {
        const d = await lireJSON(`${API}/search?ids=${id}`);
        if (d.features?.length) { ajouter(d.features, true); continue; }
        const c = await lireJSON(`${API}/search?collections=${id}&bbox=${bbox(G.M[0], G.M[1], Math.max(rayon, 60))}&limit=200`);
        if (c.features?.length) ajouter(c.features, true);
        else app.signaler(`Identifiant ${id} : aucune photo de cette séquence à moins de ${Math.max(rayon, 60)} m de la façade (ou identifiant inconnu).`);
      }
      let url = `${API}/search?bbox=${bbox(G.M[0], G.M[1], rayon)}&limit=200`;
      for (let page = 0; url && page < 4; page++) {
        const d = await lireJSON(url);
        ajouter(d.features);
        url = (d.links || []).find((l) => l.rel === 'next')?.href || null;
      }
    } catch (err) {
      console.error(err);
      ui.etatRecherche.textContent = `Panoramax injoignable (${err.name === 'AbortError' ? 'délai dépassé' : err.message}). Vérifiez la connexion ; sans réseau, utilisez « Ma photo » (photo de votre ordinateur).`;
      afficherListe();
      return;
    }
    const liste = [...vus.values()].map(({ feat, parId }) => ({ ...analyserPhoto(feat, f, app.proj), parId }))
      .filter((c) => c.parId || c.distance <= rayon);
    liste.sort((a, b) => a.note - b.note);
    etat.candidates = liste;
    const ok = liste.filter((c) => c.utilisable).length;
    ui.etatRecherche.textContent = `${liste.length} photo${liste.length > 1 ? 's' : ''} à moins de ${rayon} m (${ok} utilisable${ok > 1 ? 's' : ''}), les moins obliques d'abord. Positions GPS à 3-5 m près : vérifiez sur l'image que la façade est bien vue.`;
    afficherListe();
  }
  const classe = (v, bon, moyen) => (v <= bon ? 'bon' : v <= moyen ? 'moyen' : 'mauvais');
  function cartePerso(c) {
    const date = (c.date || '').split('-').reverse().join('/');
    return h('div', { class: 'redr-carte perso', tabindex: 0, role: 'button', 'aria-current': etat.photo?.id === c.id ? 'true' : 'false',
      title: `${c.nom}\n${c.modele || ''}\nphoto de cet ordinateur (rien n'est envoyé)`, onclick: () => choisirPhotoPerso(c), onkeydown: (e) => { if (e.key === 'Enter') choisirPhotoPerso(c); } },
    h('img', { src: c.thumb, alt: '' }),
    h('div', { class: 'ind' },
      h('div', {}, h('strong', {}, 'Ma photo'), ` · ${c.nom}`),
      h('div', {}, `${c.W} × ${c.H} px · ${c.pano ? '360°' : `plan ${Math.round(c.fov)}°`}${c.exif.orientation > 1 ? ` · orientation EXIF ${c.exif.orientation}` : ''}`),
      c.estimable ? h('div', {}, h('strong', { class: classe(c.obliquite, 15, 35) }, `obliquité ${Math.round(c.obliquite)}°`), ` · ${Math.round(c.distance)} m (GPS)`)
        : h('div', {}, c.gps ? 'GPS sans direction : coins à poser' : 'sans position GPS : coins à poser'),
      h('div', {}, `${date}${c.dateExif ? '' : ' (date du fichier)'} · ${auteurPerso()}`),
      c.raisons.length ? h('div', { class: 'moyen' }, c.raisons.join(', ')) : null));
  }
  function afficherListe(tout = false) {
    if (!ui.liste) return;
    const liste = tout ? etat.candidates : etat.candidates.slice(0, 40);
    ui.liste.replaceChildren(...etat.perso.map(cartePerso), ...liste.map((c) => {
      const carte = h('div', { class: `redr-carte${c.utilisable ? '' : ' inutilisable'}`, tabindex: 0, role: 'button', 'aria-current': etat.photo?.id === c.id ? 'true' : 'false',
        title: `${c.id}\n${c.modele}\n${c.lien}`, onclick: () => choisirPhoto(c), onkeydown: (e) => { if (e.key === 'Enter') choisirPhoto(c); } },
      h('img', { src: c.thumb, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }),
      h('div', { class: 'ind' },
        h('div', {}, h('strong', { class: classe(c.obliquite, 15, 35) }, `obliquité ${Math.round(c.obliquite)}°`), ` · ${Math.round(c.distance)} m · ${c.pano ? '360°' : `plan ${Math.round(c.fov)}°`}`),
        h('div', { class: classe(-c.pxm, -80, -40) }, `≈ ${Math.round(c.pxm)} px/m sur la façade`),
        h('div', {}, `${c.date.split('-').reverse().join('/')} · ${c.auteur}`),
        h('div', { class: c.licence ? '' : 'mauvais' }, c.licence || `licence ${c.licenceCode || '?'} : non utilisable`),
        c.raisons.length ? h('div', { class: 'mauvais' }, c.raisons.join(', ')) : null,
        c.parId ? h('div', {}, 'par identifiant') : null));
      return carte;
    }), etat.candidates.length > liste.length ? h('button', { type: 'button', class: 'bouton discret petit', onclick: () => afficherListe(true) }, `Afficher les ${etat.candidates.length} photos`) : '');
  }

  // ---------------- chargement d'une photo ----------------
  async function chargerImage(url) {
    const r = await fetch(url, { referrerPolicy: 'no-referrer', credentials: 'omit' });
    if (!r.ok) throw new Error(`image : ${r.status}`);
    const b = await r.blob();
    // certains stockages renvoient binary/octet-stream : type rétabli pour le décodage
    return createImageBitmap(b.type.startsWith('image/') ? b : new Blob([b], { type: 'image/jpeg' }));
  }
  // pixels pour le calcul (grand côté ≤ maxCote) et canevas d'affichage réduit (≤ MAX_AFFICHAGE ; aucun pour un panorama)
  function versDonnees(bmp, maxCote = 8192, affichage = true) {
    const k = Math.min(1, maxCote / Math.max(bmp.width, bmp.height));
    const W = Math.round(bmp.width * k), Hh = Math.round(bmp.height * k);
    const c = document.createElement('canvas');
    c.width = W; c.height = Hh;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, W, Hh);
    const data = ctx.getImageData(0, 0, W, Hh);
    let canvas = null;
    if (affichage) {
      const ka = Math.min(1, MAX_AFFICHAGE / Math.max(W, Hh));
      canvas = document.createElement('canvas');
      canvas.width = Math.round(W * ka); canvas.height = Math.round(Hh * ka);
      canvas.getContext('2d').drawImage(c, 0, 0, canvas.width, canvas.height);
    }
    c.width = c.height = 0; // mémoire du grand canevas rendue
    return { canvas, data, reduit: k < 1, largeurOrigine: bmp.width, hauteurOrigine: bmp.height };
  }
  // reprise : trace « redressement » d'un enregistrement précédent (coins, vue) appliquée à la photo rechargée
  async function choisirPhoto(c, reprise = null) {
    if (!c.perso) {
      if (!c.utilisable && !reprise && !confirm(`Photo ${c.raisons.join(', ')}. La charger quand même ?`)) return;
      if (!c.licence) { app.signaler('Licence non reconnue : photo non utilisable dans l\'atlas.'); return; }
    }
    etat.photo = c;
    // ancienne photo retirée pendant le chargement (pas d'enregistrement d'une image avec les métadonnées d'une autre)
    etat.source = null; etat.coins = []; etat.rendu = null; etat.actif = -1;
    afficherListe();
    majOutils(); dessinerSource(); majApercu();
    let bmp = null, hd = c.perso ? true : etat.hd;
    if (c.perso) {
      ui.etatTravail.textContent = `Lecture de ${c.nom}…`;
      bmp = await lireFichierImage(c).catch((e) => { ui.etatTravail.textContent = `${c.nom} : ${e.message}`; return null; });
    } else {
      ui.etatTravail.textContent = `Chargement de la photo ${etat.hd ? 'HD' : 'SD'}…`;
      try { bmp = await chargerImage(hd ? c.hd : c.sd); } catch (err) {
        console.warn(err);
        if (hd && c.sd) { hd = false; bmp = await chargerImage(c.sd).catch((e) => { ui.etatTravail.textContent = `Image illisible : ${e.message}`; return null; }); }
      }
    }
    if (!bmp || etat.photo !== c) { bmp?.close?.(); return; }
    let lu;
    try { lu = versDonnees(bmp, c.perso ? MAX_COTE_PERSO : 8192, !c.pano); } catch (err) {
      console.error(err);
      ui.etatTravail.textContent = `Image trop grande pour la mémoire du navigateur (${bmp.width} × ${bmp.height} px) : réduisez-la avant de l'ouvrir.`;
      bmp.close?.();
      return;
    }
    bmp.close?.();
    const { canvas, data } = lu;
    const G = geometrie(etat.f);
    const P = positionPhoto(c);
    const estimable = !c.perso || c.estimable;
    if (c.pano) {
      const vue = estimable ? vueParDefaut(P, G.coins, data.width)
        : { yaw: r1(c.az), pitch: 5, fov: 90, W: Math.round(Math.min(4096, Math.max(1200, data.width / Math.PI))), H: 0 };
      if (!vue.H) vue.H = Math.round(vue.W * 0.75);
      etat.source = { equi: data, hd, vue, perso: !!c.perso, reduit: lu.reduit, sansPosition: !estimable };
      construireVue();
    } else {
      const cam = estimable ? camera({ P, yaw: Number.isFinite(c.az) ? c.az : c.visee, pitch: 0, fov: c.fov, W: data.width, H: data.height }) : null;
      etat.source = { canvas, data, cam, hd, perso: !!c.perso, reduit: lu.reduit };
    }
    if (reprise?.coins?.length === 4) appliquerReprise(reprise);
    else etat.coins = estimerCoins() || coinsSimples();
    etat.rendu = null;
    const taille = `${data.width} × ${data.height} px${lu.reduit ? `, réduite depuis ${lu.largeurOrigine} × ${lu.hauteurOrigine}` : ''}${c.pano ? ', panorama : vue perspective tirée' : ''}`;
    ui.etatTravail.textContent = reprise ? `Photo d'origine rechargée (${taille}) : coins et vue du redressement enregistré repris ; corrigez-les puis Enregistrer.`
      : c.perso ? `${c.nom} lue sur cet ordinateur (${taille}). ${estimable ? 'Coins estimés d\'après le GPS et la direction de la photo : souvent décalés, vérifiez-les.' : `Sans position${c.pano ? ' ni direction' : ''} GPS : coins posés en rectangle, glissez-les sur les angles de la façade${c.pano ? ' (tournez d\'abord la vue avec le 1er curseur)' : ''}.`}`
        : `Photo ${hd ? 'HD' : 'SD'} chargée (${taille}). Coins estimés d'après le GPS et l'azimut de la photo, souvent décalés de plusieurs mètres : vérifiez qu'ils sont sur la bonne façade, sinon « Effacer les coins » et cliquez-les.`;
    majOutils();
    cadrer();
    majApercu();
  }
  function appliquerReprise(t) {
    const s = etat.source;
    if (s.equi && t.vue) {
      s.vue = { yaw: t.vue.lacet, pitch: t.vue.tangage, fov: t.vue.champ, W: t.vue.largeur, H: t.vue.hauteur };
      construireVue();
      etat.coins = t.coins.map(([x, y]) => [x, y]);
    } else {
      const k = t.largeur_source ? s.data.width / t.largeur_source : 1;
      etat.coins = t.coins.map(([x, y]) => [x * k, y * k]);
    }
  }
  // coins de départ sans position : rectangle au milieu de l'image (à glisser sur les angles de la façade)
  function coinsSimples() {
    const d = etat.source?.data;
    if (!d) return [];
    const W = d.width, Hh = d.height;
    return [[0.25 * W, 0.2 * Hh], [0.75 * W, 0.2 * Hh], [0.75 * W, 0.8 * Hh], [0.25 * W, 0.8 * Hh]];
  }

  // ---------------- photos personnelles ----------------
  const auteurPerso = () => ui.auteur?.value.trim() || lireLS(CLE_AUTEUR) || AUTEUR_DEFAUT;
  function licencePerso() {
    const v = ui.licencePerso?.value || lireLS(CLE_LICENCE) || PEDAGOGIQUE;
    if (v !== 'Autre (texte)') return v;
    return ui.licenceAutre?.value.trim() || 'Autre (droits non précisés)';
  }
  const dateFichier = (fichier) => { const d = new Date(fichier.lastModified || Date.now()); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let nPerso = 0;
  // fichiers choisis ou glissés → photos personnelles (en tête de la liste) ; renvoie celles qui ont pu être lues
  async function ajouterFichiers(fichiers) {
    const liste = [...(fichiers || [])].filter((f) => /^image\//.test(f.type) || /\.(jpe?g|png|webp|hei[cf]|avif)$/i.test(f.name));
    if (!liste.length) { app.signaler('Aucune image reconnue (JPEG, PNG, WebP ; HEIC si le navigateur le lit).'); return []; }
    const lues = [];
    for (const fichier of liste) {
      try { lues.push(await analyserPerso(fichier)); } catch (err) { console.warn(err); app.signaler(`${fichier.name} : ${err.message}`); }
    }
    etat.perso.unshift(...lues);
    afficherListe();
    return lues;
  }
  async function analyserPerso(fichier) {
    let ex = {};
    try { ex = lireExif(await fichier.slice(0, 1 << 20).arrayBuffer()); } catch (err) { console.warn('EXIF illisible', err); }
    const url = URL.createObjectURL(fichier);
    const img = new Image();
    img.src = url;
    try { await img.decode(); } catch {
      URL.revokeObjectURL(url);
      throw new Error(/\.hei[cf]$/i.test(fichier.name) || /heic|heif/i.test(fichier.type) ? 'format HEIC non lu par ce navigateur (Chrome) : exportez la photo en JPEG' : 'image illisible par ce navigateur');
    }
    // dimensions après orientation EXIF (Chrome l'applique aux images et à createImageBitmap 'from-image')
    const W = img.naturalWidth, Hh = img.naturalHeight;
    const c = { id: `perso-${++nPerso}`, perso: true, fichier, nom: fichier.name, taille: fichier.size, url, thumb: url, W, H: Hh, exif: ex,
      pano: !!ex.gpano || Math.abs(W / Hh - 2) < 0.02, date: ex.date || dateFichier(fichier), dateExif: !!ex.date };
    majPerso(c);
    return c;
  }
  // indicateurs d'une photo personnelle pour la façade courante (comme une photo Panoramax quand le GPS est connu)
  function majPerso(c) {
    const f = etat.f, ex = c.exif;
    c.fov = c.pano ? 360 : champPhoto(ex.focale35, c.W, c.H);
    const dir = Number.isFinite(c.azForce) ? c.azForce : Number.isFinite(ex.direction) ? ex.direction : c.pano && Number.isFinite(ex.capPano) ? ex.capPano : NaN;
    c.direction = Number.isFinite(dir);
    c.modele = [ex.marque, ex.modele].filter(Boolean).join(' ');
    c.raisons = []; c.utilisable = true; c.licence = licencePerso(); c.auteur = auteurPerso();
    c.gps = !!ex.gps; c.estimable = false; c.obliquite = null; c.distance = null; c.pxm = null;
    if (!f) return c;
    const G = geometrie(f);
    if (c.gps) {
      const a = analyserPhoto({ id: c.id, geometry: { coordinates: [ex.gps.lon, ex.gps.lat] },
        properties: { 'view:azimuth': dir, 'pers:interior_orientation': { field_of_view: c.fov, sensor_array_dimensions: [c.W, c.H] } } }, f, app.proj);
      for (const k of ['lat', 'lon', 'x', 'z', 'distance', 'obliquite', 'visee', 'coteRue', 'dansChamp', 'angleFacade', 'pxm']) c[k] = a[k];
      if (c.distance > 150) { c.raisons.push(`GPS à ${Math.round(c.distance)} m de la façade : coins à poser à la main`); }
      else {
        c.estimable = !c.pano || c.direction;
        if (!c.coteRue) c.raisons.push('GPS derrière la façade (à vérifier)');
        if (!c.pano && c.direction && !c.dansChamp) c.raisons.push('façade hors du champ d\'après la direction GPS');
      }
    }
    if (!c.estimable) {
      // position fictive devant la façade (sert seulement à construire la caméra ; aucune estimation de coins)
      c.x = G.M[0] + G.n[0] * 15; c.z = G.M[1] + G.n[1] * 15;
      c.visee = azimutVers(G.M[0] - c.x, G.M[1] - c.z);
    }
    c.az = c.direction ? dir : c.pano ? 0 : c.visee; // panorama sans direction : centre de l'image = azimut 0 (fictif)
    return c;
  }
  async function lireFichierImage(c) {
    try { return await createImageBitmap(c.fichier, { imageOrientation: 'from-image' }); } catch (err) {
      console.warn('createImageBitmap', err);
      const img = new Image();
      img.src = c.url;
      await img.decode();
      return createImageBitmap(img);
    }
  }
  function choisirPhotoPerso(c) {
    if (!c) return;
    majPerso(c);
    if (etat.f?.redressement?.type === 'personnelle' && etat.f.redressement.nom_fichier === c.nom && etat.photo !== c) {
      // même fichier que le redressement enregistré : proposé en reprise
      if (confirm(`« ${c.nom} » est la photo d'origine de cette façade. Reprendre ses coins enregistrés ?`)) { reprisePersoAvec(c); return; }
    }
    choisirPhoto(c);
  }
  // « Reprendre le redressement » : photo d'origine relue sur Panoramax, ou redemandée (photo personnelle)
  async function reprendre() {
    const t = etat.f?.redressement;
    if (!t?.coins) return;
    if (t.type === 'personnelle') {
      const deja = etat.perso.find((c) => c.nom === t.nom_fichier && (!t.taille_octets || c.taille === t.taille_octets));
      if (deja) { reprisePersoAvec(deja); return; }
      ui.fichierReprise.value = '';
      ui.fichierReprise.click();
      return;
    }
    if (!t.photo_id) { app.signaler('Trace de redressement sans identifiant de photo.'); return; }
    ui.etatRecherche.textContent = 'Photo d\'origine : lecture sur Panoramax…';
    try {
      const d = await lireJSON(`${API}/search?ids=${t.photo_id}`);
      const feat = d.features?.[0];
      if (!feat) throw new Error('photo introuvable (retirée de Panoramax ?)');
      let c = etat.candidates.find((x) => x.id === feat.id);
      if (!c) { c = { ...analyserPhoto(feat, etat.f, app.proj), parId: true }; etat.candidates.unshift(c); }
      etat.hd = t.image_source !== 'sd';
      if (ui.caseHD) ui.caseHD.checked = etat.hd;
      ui.etatRecherche.textContent = 'Photo d\'origine retrouvée sur Panoramax.';
      await choisirPhoto(c, t);
    } catch (err) {
      console.error(err);
      ui.etatRecherche.textContent = `Reprise impossible : ${err.name === 'AbortError' ? 'délai dépassé' : err.message}.`;
    }
  }
  async function reprisePerso(fichier) {
    const t = etat.f?.redressement;
    if (!fichier || !t) return;
    if (t.nom_fichier && fichier.name !== t.nom_fichier && !confirm(`Le redressement enregistré a été fait sur « ${t.nom_fichier} » ; vous avez choisi « ${fichier.name} ». Reprendre quand même (coins probablement faux) ?`)) return;
    const [c] = await ajouterFichiers([fichier]);
    if (c) reprisePersoAvec(c);
  }
  function reprisePersoAvec(c) {
    const t = etat.f.redressement;
    c.pano = t.projection === '360';
    if (Number.isFinite(t.vue?.azimut_centre)) c.azForce = t.vue.azimut_centre;
    if (etat.f.date_prise) c.date = etat.f.date_prise;
    majPerso(c);
    if (t.largeur_source && Math.abs(t.largeur_source / (t.hauteur_source || 1) - c.W / c.H) > 0.02 && t.hauteur_source) {
      if (!confirm('Les proportions de cette image diffèrent de celles du redressement enregistré (photo recadrée ou tournée ?). Reprendre quand même ?')) return;
    }
    choisirPhoto(c, t);
  }
  // vue perspective du panorama (lacet, tangage, champ) ; coins déjà posés reportés dans la nouvelle vue
  function construireVue(reporter = false) {
    const s = etat.source;
    const v = s.vue;
    const ancienne = s.cam;
    const cam = camera({ P: positionPhoto(etat.photo), yaw: v.yaw, pitch: v.pitch, fov: v.fov, W: v.W, H: v.H });
    const img = vueDepuisPanorama(s.equi, etat.photo.az, cam);
    const id = new ImageData(img.data, img.width, img.height);
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').putImageData(id, 0, 0);
    s.canvas = canvas; s.data = id; s.cam = cam;
    if (reporter && ancienne && etat.coins.length) {
      etat.coins = etat.coins.map(([x, y]) => {
        const d = ancienne.rayon(x, y);
        return cam.projeter([cam.P[0] + d[0], cam.P[1] + d[1], cam.P[2] + d[2]]) || [x, y];
      });
    }
  }
  // positions estimées des coins (position, azimut, champ de la photo ; hauteur de prise de vue supposée)
  function estimerCoins() {
    const cam = etat.source?.cam;
    if (!cam || etat.source.sansPosition) return null;
    const pts = geometrie(etat.f).coins.map((X) => cam.projeter(X));
    return pts.every(Boolean) ? pts : null;
  }

  // ---------------- canevas source : zoom, déplacement, coins ----------------
  const vue = { s: 1, ox: 0, oy: 0 };
  const versEcran = (x, y) => [vue.ox + vue.s * x, vue.oy + vue.s * y];
  const versImage = (cx, cy) => [(cx - vue.ox) / vue.s, (cy - vue.oy) / vue.s];
  function tailleCanevas(c) {
    const r = c.getBoundingClientRect(), k = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(r.width * k)), Hh = Math.max(1, Math.round(r.height * k));
    if (c.width !== W || c.height !== Hh) { c.width = W; c.height = Hh; }
    return { w: r.width, h: r.height, k };
  }
  function cadrer() {
    const s = etat.source;
    if (!s?.canvas || !ui.src) return;
    const { w, h: hh } = tailleCanevas(ui.src);
    const Ws = s.data.width, Hs = s.data.height; // repère des coins : pixels de calcul (affichage éventuellement réduit)
    let x0 = 0, y0 = 0, x1 = Ws, y1 = Hs;
    if (etat.coins.length === 4) {
      const xs = etat.coins.map((c) => c[0]), ys = etat.coins.map((c) => c[1]);
      const m = 0.15 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
      x0 = Math.max(0, Math.min(...xs) - m); x1 = Math.min(Ws, Math.max(...xs) + m);
      y0 = Math.max(0, Math.min(...ys) - m); y1 = Math.min(Hs, Math.max(...ys) + m);
      if (x1 - x0 < 50 || y1 - y0 < 50) { x0 = 0; y0 = 0; x1 = Ws; y1 = Hs; }
    }
    vue.s = Math.min(w / (x1 - x0), hh / (y1 - y0));
    vue.ox = (w - vue.s * (x1 + x0)) / 2; vue.oy = (hh - vue.s * (y1 + y0)) / 2;
    dessinerSource();
  }
  function dessinerSource() {
    const c = ui.src;
    if (!c?.isConnected) return;
    const { w, h: hh, k } = tailleCanevas(c);
    const ctx = c.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    const s = etat.source;
    if (!s?.canvas) { ui.legendeSrc.textContent = 'Choisissez une photo dans la liste.'; return; }
    ctx.imageSmoothingEnabled = vue.s * (s.data.width / s.canvas.width) < 2;
    ctx.drawImage(s.canvas, vue.ox, vue.oy, s.data.width * vue.s, s.data.height * vue.s);
    const P = etat.coins.map(([x, y]) => versEcran(x, y));
    if (P.length > 1) {
      ctx.beginPath(); P.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (P.length === 4) ctx.closePath();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.stroke();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#ffd400'; ctx.stroke();
    }
    P.forEach(([x, y], i) => {
      ctx.beginPath(); ctx.arc(x, y, i === etat.actif ? 9 : 7, 0, 2 * Math.PI);
      ctx.fillStyle = COULEURS_COINS[i]; ctx.globalAlpha = 0.35; ctx.fill(); ctx.globalAlpha = 1;
      ctx.lineWidth = 2; ctx.strokeStyle = COULEURS_COINS[i]; ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 12, y); ctx.lineTo(x + 12, y); ctx.moveTo(x, y - 12); ctx.lineTo(x, y + 12);
      ctx.lineWidth = 1; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.font = '600 12px sans-serif'; ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
      ctx.strokeText(ABR_COINS[i], x + 9, y - 9); ctx.fillText(ABR_COINS[i], x + 9, y - 9);
    });
    const n = etat.coins.length;
    const dehors = etat.coins.some(([x, y]) => x < 0 || y < 0 || x > s.data.width || y > s.data.height);
    ui.legendeSrc.textContent = (dehors ? (s.equi ? 'Coin hors de l\'image : élargissez le champ (3e curseur) ou tournez la vue. ' : 'Coin hors de l\'image : partie grisée sur l\'image redressée. ') : '') + (n < 4 ? `Cliquez le coin ${NOMS_COINS[n]} de la façade (${n + 1}/4) · molette : zoom · glisser : déplacer`
      : `Coins posés : glissez-les au nu du mur ; flèches = 1 px (Maj : 0,2 px) sur le coin choisi${etat.actif >= 0 ? ` (${NOMS_COINS[etat.actif]})` : ''} · zoom ×${vue.s.toFixed(2)}`);
  }
  let geste = null;
  function pointeur(e) {
    if (!etat.source?.canvas) return;
    const r = ui.src.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    if (e.type === 'pointerdown') {
      ui.src.setPointerCapture(e.pointerId);
      let k = -1, dmin = 14;
      etat.coins.forEach(([x, y], i) => { const [sx, sy] = versEcran(x, y); const d = Math.hypot(sx - cx, sy - cy); if (d < dmin) { dmin = d; k = i; } });
      geste = { cx, cy, ox: vue.ox, oy: vue.oy, coin: k, bouge: false, bouton: e.button };
      if (k >= 0) { etat.actif = k; dessinerSource(); }
    } else if (e.type === 'pointermove' && geste) {
      if (Math.hypot(cx - geste.cx, cy - geste.cy) > 3) geste.bouge = true;
      if (geste.coin >= 0 && geste.bouton === 0) {
        etat.coins[geste.coin] = versImage(cx, cy);
        etat.rendu = null; dessinerSource(); majApercu();
      } else if (geste.bouge) {
        vue.ox = geste.ox + cx - geste.cx; vue.oy = geste.oy + cy - geste.cy; dessinerSource();
      }
    } else if (e.type === 'pointerup' && geste) {
      if (!geste.bouge && geste.coin < 0 && geste.bouton === 0 && etat.coins.length < 4) {
        etat.coins.push(versImage(cx, cy));
        etat.actif = etat.coins.length - 1;
        etat.rendu = null; dessinerSource(); majApercu();
      }
      geste = null;
      majOutils();
    }
  }
  function molette(e) {
    if (!etat.source?.canvas) return;
    e.preventDefault();
    const r = ui.src.getBoundingClientRect();
    const cx = e.clientX - r.left, cy = e.clientY - r.top;
    const k = Math.exp(-e.deltaY * 0.0015);
    const s = Math.min(40, Math.max(0.02, vue.s * k));
    vue.ox = cx - ((cx - vue.ox) * s) / vue.s; vue.oy = cy - ((cy - vue.oy) * s) / vue.s; vue.s = s;
    dessinerSource();
  }
  function clavier(e) {
    e.stopPropagation(); // pas de raccourci de l'atlas pendant le redressement
    if (e.key === 'Escape') { if (etat.coins.length && etat.actif >= 0) { etat.actif = -1; dessinerSource(); } else fermer(); return; }
    if (e.target.matches?.('input, select, textarea')) return;
    const k = etat.actif;
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (k >= 0 && dirs[e.key] && etat.coins[k]) {
      e.preventDefault();
      const p = e.shiftKey ? 0.2 : 1;
      etat.coins[k] = [etat.coins[k][0] + dirs[e.key][0] * p, etat.coins[k][1] + dirs[e.key][1] * p];
      etat.rendu = null; dessinerSource(); majApercu();
    } else if (e.key === 'Tab' && etat.coins.length === 4 && e.target === ui.src) {
      e.preventDefault(); etat.actif = (k + (e.shiftKey ? 3 : 1)) % 4; dessinerSource();
    }
  }

  // ---------------- aperçu redressé ----------------
  function dimensions(ppm = etat.ppm) {
    const f = etat.f;
    const L = geometrieFacade(f).L;
    const k = Math.min(ppm, PX_M_MAX_COTE / Math.max(L, f.hauteur_m));
    return { W: Math.max(8, Math.round(L * k)), H: Math.max(8, Math.round(f.hauteur_m * k)), ppm: k, L };
  }
  let attente = 0;
  function majApercu() {
    if (attente) return;
    attente = requestAnimationFrame(() => { attente = 0; dessinerApercu(); });
  }
  function dessinerApercu() {
    const c = ui.dst;
    if (!c?.isConnected) return;
    const { w, h: hh, k } = tailleCanevas(c);
    const ctx = c.getContext('2d');
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    if (!etat.source?.data || etat.coins.length < 4) { ui.legendeDst.textContent = 'Aperçu redressé : posez les 4 coins.'; return; }
    if (!quadValide(etat.coins)) { ui.legendeDst.textContent = 'Coins croisés ou mal ordonnés (HG, HD, BD, BG).'; return; }
    const D = dimensions();
    const e = Math.min((w - 16) / D.W, (hh - 16) / D.H);
    const Wp = Math.max(8, Math.round(D.W * e * k)), Hp = Math.max(8, Math.round(D.H * e * k));
    const sc = Wp / D.W;
    const img = redresser(etat.source.data, etat.coins, Wp, Hp);
    if (!img) return;
    const tmp = document.createElement('canvas');
    tmp.width = Wp; tmp.height = Hp;
    tmp.getContext('2d').putImageData(new ImageData(img.data, Wp, Hp), 0, 0);
    const x0 = (w - Wp / k) / 2, y0 = (hh - Hp / k) / 2;
    ctx.drawImage(tmp, x0, y0, Wp / k, Hp / k);
    if (etat.grille) {
      // grille de 1 m (5 m en trait plus épais) : les arêtes verticales et les corniches doivent la suivre
      const pm = (sc * D.ppm) / k;
      ctx.lineWidth = 1;
      for (let m = 0; m <= D.L + 1e-6; m += 1) { ctx.strokeStyle = m % 5 ? 'rgba(0,255,255,0.35)' : 'rgba(0,255,255,0.8)'; ctx.beginPath(); ctx.moveTo(x0 + m * pm, y0); ctx.lineTo(x0 + m * pm, y0 + Hp / k); ctx.stroke(); }
      for (let m = 0; m <= etat.f.hauteur_m + 1e-6; m += 1) { const y = y0 + Hp / k - m * pm; ctx.strokeStyle = m % 5 ? 'rgba(0,255,255,0.35)' : 'rgba(0,255,255,0.8)'; ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x0 + Wp / k, y); ctx.stroke(); }
    }
    ui.legendeDst.textContent = `${r2(D.L)} × ${r2(etat.f.hauteur_m)} m → ${D.W} × ${D.H} px (${Math.round(D.ppm)} px/m) · grille 1 m`;
  }

  // ---------------- rendu final, aperçu sur la maquette, enregistrement ----------------
  async function rendre() {
    if (!etat.source?.data || etat.coins.length !== 4 || !quadValide(etat.coins)) { app.signaler('Posez les 4 coins de la façade (dans l\'ordre HG, HD, BD, BG).'); return null; }
    if (etat.rendu) return etat.rendu;
    const D = dimensions();
    ui.etatTravail.textContent = 'Redressement…';
    await new Promise((r) => setTimeout(r, 20));
    const img = redresser(etat.source.data, etat.coins, D.W, D.H);
    const c = document.createElement('canvas');
    c.width = D.W; c.height = D.H;
    c.getContext('2d').putImageData(new ImageData(img.data, D.W, D.H), 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const s = etat.source;
    etat.rendu = {
      blob, W: D.W, H: D.H, ppm: r1(D.ppm), url: null,
      coins: etat.coins.map(([x, y]) => [r1(x), r1(y)]),
      vue: s.equi ? { lacet: s.vue.yaw, tangage: s.vue.pitch, champ: s.vue.fov, largeur: s.vue.W, hauteur: s.vue.H, hauteur_prise_m: etat.hCam } : null,
      image_source: s.perso ? (s.reduit ? 'reduite' : 'originale') : s.hd ? 'hd' : 'sd',
      largeur_source: s.equi ? s.equi.width : s.data.width, hauteur_source: s.equi ? s.equi.height : s.data.height,
    };
    ui.etatTravail.textContent = `Image redressée : ${D.W} × ${D.H} px, ${Math.round(blob.size / 1024)} ko.`;
    return etat.rendu;
  }
  async function apercuMaquette() {
    const R = await rendre();
    if (!R) return;
    if (!R.url) R.url = URL.createObjectURL(R.blob);
    const f = etat.f;
    if (etat.nouvelle && !T.toutesFacades().includes(f)) {
      const id = ui.idNouv.value.trim();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { app.signaler('Identifiant : lettres minuscules, chiffres et tirets.'); return; }
      f.id = id; f.image = `${id}.jpg`; f.nom = ui.nomNouv.value.trim() || f.nom;
      ui.idNouv.disabled = true; // identifiant figé une fois la façade posée sur la maquette
      if (!T.ajouterFacade(etat.nouvelle.ensemble, f)) { app.signaler(`Identifiant « ${f.id} » déjà pris : changez-le.`); return; }
      calage?.rafraichirPanneau?.();
    }
    T.rechargerImageFacade(f, R.url);
    etat.apercu = true;
    if (T.representation?.() !== 'photos') app.signaler('Aperçu posé : choisissez « Détaillé avec photos » (Bâtiments > Bâti) pour le voir.');
    ui.etatTravail.textContent = 'Aperçu posé sur la maquette (rien n\'est enregistré). Contrôlez avec Calage > Vue de face, puis Enregistrer.';
    majOutils();
  }
  function confianceProposee() {
    if (etat.photo?.perso && etat.photo.obliquite == null) return 'moyenne';
    const o = etat.photo?.obliquite ?? 90;
    return o <= 15 ? 'bonne' : o <= 35 ? 'moyenne' : 'faible';
  }
  const aujourdhui = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  // champs à écrire pour la façade (repère du fichier : dx, dz = position de son origine dans le repère courant)
  function champsPhoto(R) {
    const c = etat.photo;
    if (c.perso) {
      return {
        pixels: [R.W, R.H],
        source: 'Photo personnelle',
        photo: c.nom,
        lien: undefined,
        auteur: auteurPerso(),
        licence: licencePerso(),
        date_prise: c.date || dateFichier(c.fichier),
        confiance: ui.confiance.value,
        remarque: ui.remarque.value.trim() || undefined,
      };
    }
    return {
      pixels: [R.W, R.H],
      source: 'Panoramax',
      photo: c.id,
      lien: c.lien,
      auteur: c.auteur,
      licence: c.licence,
      date_prise: c.date,
      confiance: ui.confiance.value,
      remarque: ui.remarque.value.trim() || undefined,
    };
  }
  function traceRedressement(R, ancien) {
    const c = etat.photo;
    if (c.perso) {
      const ex = c.exif || {};
      return {
        date: aujourdhui(), outil: 'atlas, Bâtiments > Calage > Redresser (photo personnelle)', type: 'personnelle',
        projection: c.pano ? '360' : 'perspective', nom_fichier: c.nom, taille_octets: c.taille,
        orientation_exif: ex.orientation || 1, ...(ex.date ? { date_exif: `${ex.date} ${ex.heure || ''}`.trim() } : {}),
        ...(c.modele ? { appareil: c.modele } : {}), ...(c.pano ? {} : { champ_deg: c.fov }),
        ...(ex.gps ? { gps: { lat: +ex.gps.lat.toFixed(6), lon: +ex.gps.lon.toFixed(6), ...(Number.isFinite(ex.direction) ? { direction_deg: ex.direction } : {}) } } : {}),
        image_source: R.image_source, largeur_source: R.largeur_source, hauteur_source: R.hauteur_source,
        ...(R.vue ? { vue: { ...R.vue, azimut_centre: r1(c.az) } } : {}), coins: R.coins, px_par_m: R.ppm,
        ...(c.estimable ? { obliquite_deg: Math.round(c.obliquite), distance_m: Math.round(c.distance) } : {}),
        ...(ancien ? { ancien } : {}),
      };
    }
    return {
      date: aujourdhui(), outil: 'atlas, Bâtiments > Calage > Redresser (Panoramax)', photo_id: c.id, collection: c.collection,
      type: c.pano ? '360' : 'perspective', image_source: R.image_source, largeur_source: R.largeur_source,
      ...(R.vue ? { vue: R.vue } : {}), coins: R.coins, px_par_m: R.ppm,
      obliquite_deg: Math.round(c.obliquite), distance_m: Math.round(c.distance),
      ...(ancien ? { ancien } : {}),
    };
  }
  async function enregistrer() {
    const f = etat.f;
    const R = await rendre();
    if (!R) return;
    const ens = etat.nouvelle?.ensemble || T.ensembleDeFacade(f)?.id;
    if (!ens) { app.signaler('Ensemble de la façade inconnu.'); return; }
    if (etat.nouvelle) {
      const id = ui.idNouv.value.trim();
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { app.signaler('Identifiant : lettres minuscules, chiffres et tirets.'); return; }
      if (!T.toutesFacades().includes(f)) { f.id = id; f.image = `${id}.jpg`; }
      f.nom = ui.nomNouv.value.trim() || f.nom;
    }
    const cheminImg = `facades/${ens}/${f.image}`;
    const pedago = etat.photo?.perso && licencePerso() === PEDAGOGIQUE;
    if (!confirm(`${etat.nouvelle ? 'Créer' : 'Remplacer'} data/${cheminImg} et mettre à jour data/facades/${ens}.json ?\n${etat.nouvelle ? '' : 'L\'ancienne image et l\'ancien fichier sont gardés dans data/.sauvegardes/ (serveur.py).'}${pedago ? '\n\nDroits « usage pédagogique » : la publication en ligne de l\'atlas avec cette image reste à votre appréciation.' : ''}`)) return;
    try {
      // fichier JSON relu (no-store) : la mémoire a été recalée sur config.origine par js/toits.js
      let texte = null, d = null;
      const r = await fetch(`data/facades/${ens}.json`, { cache: 'no-store' });
      if (r.ok) { texte = await r.text(); d = JSON.parse(texte); } else if (!etat.nouvelle) throw new Error(`data/facades/${ens}.json illisible (${r.status})`);
      const o = d?.origine || app.config.origine;
      const { x: dx, z: dz } = app.proj.versLocal(o.lat, o.lon);
      const champs = champsPhoto(R);
      let sortie;
      if (etat.nouvelle) {
        if (d?.facades?.some((x) => x.id === f.id)) throw new Error(`l'identifiant ${f.id} existe déjà dans data/facades/${ens}.json`);
        const entree = {
          id: f.id, nom: f.nom, rue: ui.rueNouv.value.trim() || undefined, corps: [etat.nouvelle.corps],
          gauche: [r2(f.gauche[0] - dx), r2(f.gauche[1] - dz)], droite: [r2(f.droite[0] - dx), r2(f.droite[1] - dz)],
          normale_az: f.normale_az, hauteur_m: r2(f.hauteur_m), image: f.image, ...champs, redressement: traceRedressement(R, null),
        };
        const propre = JSON.parse(JSON.stringify(entree));
        if (d) {
          d.facades = [...(d.facades || []), propre];
          sortie = insererFacade(texte, { facades: d.facades.slice(0, -1) }, propre) || serialiserFacades(d, texte);
        } else {
          const ensObj = T.ensembles.find((e) => e.id === ens);
          sortie = serialiserFacades({
            _note: 'Photos de façade (même format que data/facades/hotel-de-ville.json), créé par l\'outil de redressement Panoramax de l\'atlas. « gauche » et « droite » : extrémités vues depuis la rue (mètres, relatifs à « origine »), « normale_az » : direction de la rue, « hauteur_m » : hauteur couverte.',
            titre: `Photos de façade : ${ensObj?.donnees?.titre || ens}`, id: ens, date: aujourdhui(), origine: { lat: o.lat, lon: o.lon }, facades: [propre],
          }, '{\n "', 1);
        }
        Object.assign(f, { rue: propre.rue, corps: propre.corps, ...champs, redressement: propre.redressement });
      } else {
        const cible = d.facades?.find((x) => x.id === f.id);
        if (!cible) throw new Error(`façade ${f.id} absente de data/facades/${ens}.json`);
        const ancien = cible.redressement?.ancien || { image: cible.image, source: cible.source, photo: cible.photo, auteur: cible.auteur, licence: cible.licence, date_prise: cible.date_prise, confiance: cible.confiance, pixels: cible.pixels };
        const nouv = { ...cible };
        for (const [k, v] of Object.entries(champs)) { if (v === undefined) delete nouv[k]; else nouv[k] = v; }
        nouv.redressement = traceRedressement(R, ancien);
        const propre = JSON.parse(JSON.stringify(nouv));
        d.facades[d.facades.indexOf(cible)] = propre;
        sortie = remplacerBlocFacade(texte, f.id, propre) || serialiserFacades(d, texte);
        Object.assign(f, champs, { redressement: propre.redressement });
        if (!champs.remarque) delete f.remarque;
      }
      JSON.parse(sortie); // contrôle avant écriture
      const ouImg = await enregistrerDonnees(cheminImg, R.blob, { type: 'image/jpeg', apres: `façade ${f.id} redressée` });
      const ouJson = await enregistrerDonnees(`facades/${ens}.json`, sortie, { apres: `entrée ${f.id} (${etat.photo.perso ? `photo personnelle ${etat.photo.nom}` : `Panoramax ${etat.photo.id}`})` });
      if (etat.nouvelle && !T.toutesFacades().includes(f)) { T.ajouterFacade(ens, f); }
      if (ouImg === 'serveur') T.rechargerImageFacade(f); // relit le fichier enregistré
      else if (R.url) T.rechargerImageFacade(f, R.url);
      etat.apercu = false;
      etat.nouvelle = null;
      calage?.rafraichirPanneau?.();
      calage?.choisir?.(f);
      ui.etatTravail.textContent = ouImg === 'serveur' && ouJson === 'serveur'
        ? `Enregistré : data/${cheminImg} et data/facades/${ens}.json (anciennes versions dans data/.sauvegardes/).`
        : `Téléchargés : ${f.image} → data/facades/${ens}/ et ${ens}.json → data/facades/ (à copier à la main).`;
      majTete();
      majOutils();
    } catch (err) {
      console.error(err);
      app.signaler(`Enregistrement impossible : ${err.message}`);
    }
  }
  async function telechargerJPEG() {
    const R = await rendre();
    if (!R) return;
    telecharger(etat.f.image || `${etat.f.id}.jpg`, R.blob);
    const ens = etat.nouvelle?.ensemble || T.ensembleDeFacade(etat.f)?.id;
    app.signaler(`JPEG téléchargé : à copier dans data/facades/${ens}/ (l'entrée JSON n'est écrite que par « Enregistrer »).`);
  }

  // ---------------- choix d'un mur (Ajouter une façade) ----------------
  const ray = new THREE.Raycaster();
  const trait = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xff2bd6, depthTest: false, transparent: true }));
  trait.name = 'redressement-mur';
  trait.userData.horsDecoupe = true; trait.userData.pasDeRelief = true;
  trait.renderOrder = 22; trait.visible = false;
  app.scene.add(trait);
  const distSeg = (p, a, b) => {
    const vx = b[0] - a[0], vz = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vz) / (vx * vx + vz * vz || 1)));
    return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vz);
  };
  function pointVise(p, e) {
    if (e) {
      const r = app.renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), app.camera);
      const bati = app.scene.getObjectByName('batiments');
      const hit = bati?.visible ? ray.intersectObjects(bati.children.filter((m) => m.isMesh && m.visible), false)[0] : null;
      if (hit) return [hit.point.x, hit.point.z];
    }
    return p ? [p.x ?? p[0], p.z ?? p[1]] : null;
  }
  // côté d'emprise d'un corps détaillé le plus proche (< 3 m) : { ensemble, corps, a, b, n (vers l'extérieur) }
  function murSous(pt) {
    let best = null, dmin = 3;
    for (const e of T.ensembles || []) {
      for (const c of e.donnees?.corps || []) {
        const E = c.emprise || [];
        for (let i = 0; i < E.length; i++) {
          const a = E[i], b = E[(i + 1) % E.length];
          const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (L < 1.5) continue;
          const d = distSeg(pt, a, b);
          if (d >= dmin) continue;
          let n = [(b[1] - a[1]) / L, -(b[0] - a[0]) / L];
          const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
          if (pointDansPolygone(m[0] + n[0] * 0.3, m[1] + n[1] * 0.3, E)) n = [-n[0], -n[1]];
          dmin = d; best = { ensemble: e.id, ensObj: e, corps: c, a, b, n, L };
        }
      }
    }
    return best;
  }
  function montrerMur(m) {
    trait.visible = !!m;
    if (!m) return;
    const y0 = sol((m.a[0] + m.b[0]) / 2, (m.a[1] + m.b[1]) / 2) + 0.3;
    trait.geometry.dispose();
    trait.geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(m.a[0], y0, m.a[1]), new THREE.Vector3(m.b[0], y0, m.b[1]),
      new THREE.Vector3(m.b[0], y0 + (m.corps.toit?.h_egout || 10), m.b[1]), new THREE.Vector3(m.a[0], y0 + (m.corps.toit?.h_egout || 10), m.a[1]), new THREE.Vector3(m.a[0], y0, m.a[1])]);
  }
  let ancienneCapture = null;
  function ajouterFacade() {
    if (etat.choixMur) return;
    etat.choixMur = true;
    ancienneCapture = { c: app.captureSol, s: app.survolCapture };
    const clic = (p, e) => {
      const m = murSous(pointVise(p, e) || [0, 0]);
      if (!m) { app.signaler('Aucun mur d\'ensemble détaillé à moins de 3 m : cliquez sur un mur (Échap pour annuler).'); return; }
      finirChoix();
      // façade existante sur ce mur : on l'ouvre
      const deja = T.toutesFacades().find((f) => distSeg(f.gauche, m.a, m.b) < 1.5 && distSeg(f.droite, m.a, m.b) < 1.5);
      if (deja && !confirm(`Ce mur porte déjà la façade « ${deja.nom} ». Ajouter quand même une nouvelle façade ? (Annuler : ouvrir celle-ci)`)) { calage?.choisir?.(deja); ouvrir(deja); return; }
      const az = Math.round(((Math.atan2(m.n[0], -m.n[1]) / RAD) + 360) % 360);
      const R = [-Math.cos(az * RAD), -Math.sin(az * RAD)]; // droite de l'observateur tourné vers la façade
      const [g, d] = (m.b[0] - m.a[0]) * R[0] + (m.b[1] - m.a[1]) * R[1] >= 0 ? [m.a, m.b] : [m.b, m.a];
      const n = (T.ensembles.find((e) => e.id === m.ensemble)?.facades?.facades?.length || 0) + 1;
      const f = {
        id: `${m.ensemble}-${['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'][Math.round(az / 45) % 8]}-${n}`, nom: `${m.corps.nom?.split('(')[0].trim() || m.corps.id}, façade ${['nord', 'nord-est', 'est', 'sud-est', 'sud', 'sud-ouest', 'ouest', 'nord-ouest'][Math.round(az / 45) % 8]}`,
        gauche: [r2(g[0]), r2(g[1])], droite: [r2(d[0]), r2(d[1])], normale_az: az,
        hauteur_m: r2(m.corps.toit?.h_egout || 10), image: null,
      };
      f.image = `${f.id}.jpg`;
      ouvrir(f, { ensemble: m.ensemble, corps: m.corps.id });
    };
    clic.sansSol = true;
    app.captureSol = clic;
    app.survolCapture = (p, e) => { const m = murSous(pointVise(p, e) || [0, 0]); montrerMur(m); app.renderer.domElement.style.cursor = m ? 'pointer' : 'crosshair'; };
    const echap = (e) => { if (e.key === 'Escape' && etat.choixMur) { e.stopImmediatePropagation(); finirChoix(); app.signaler('Ajout de façade annulé.'); } };
    window.addEventListener('keydown', echap, true);
    etat.finEchap = () => window.removeEventListener('keydown', echap, true);
    app.signaler('Ajouter une façade : cliquez sur un mur d\'un ensemble détaillé (Hôtel de Ville, îlots…) ; Échap pour annuler.');
  }
  function finirChoix() {
    etat.choixMur = false;
    etat.finEchap?.();
    app.captureSol = ancienneCapture?.c || null;
    app.survolCapture = ancienneCapture?.s || null;
    app.renderer.domElement.style.cursor = '';
    setTimeout(() => montrerMur(null), 1500);
  }

  // ---------------- fenêtre ----------------
  function majTete() {
    if (!ui.titre) return;
    const f = etat.f;
    const ens = etat.nouvelle?.ensemble || T.ensembleDeFacade(f)?.id;
    const L = geometrieFacade(f).L;
    ui.titre.textContent = `${etat.nouvelle ? 'Nouvelle façade' : 'Redresser'} : ${f.nom}`;
    ui.sousTitre.textContent = `data/facades/${ens}/${f.image} · ${r2(L)} × ${r2(f.hauteur_m)} m · normale ${f.normale_az}°${f.source ? ` · actuelle : ${f.source}, ${f.auteur || ''}, ${f.licence || ''}` : ''}`;
    ui.nouvelleForme.hidden = !etat.nouvelle;
  }
  function majOutils() {
    if (!ui.boite) return;
    const s = etat.source;
    ui.reglagesVue.hidden = !s?.equi;
    if (s?.equi) { ui.lacet.value = s.vue.yaw; ui.tangage.value = s.vue.pitch; ui.champ.value = s.vue.fov; ui.valVue.textContent = `${Math.round(s.vue.yaw)}° / ${Math.round(s.vue.pitch)}° / ${Math.round(s.vue.fov)}°`; }
    const pret = !!s?.data && etat.coins.length === 4 && quadValide(etat.coins);
    for (const b of [ui.apercu, ui.enregistrer, ui.telecharger]) b.disabled = !pret;
    ui.estimer.disabled = !s?.cam || !!s.sansPosition;
    const c = etat.photo;
    ui.reprendre.hidden = !etat.f?.redressement?.coins;
    ui.reprendre.textContent = etat.f?.redressement?.type === 'personnelle' ? `Reprendre le redressement (${etat.f.redressement.nom_fichier || 'ma photo'})` : 'Reprendre le redressement (photo Panoramax d\'origine)';
    const perso = !!c?.perso;
    ui.datePerso.disabled = ui.panoPerso.disabled = !perso;
    if (perso) { ui.datePerso.value = c.date || ''; ui.panoPerso.checked = c.pano; }
    ui.avertPerso.hidden = licencePerso() !== PEDAGOGIQUE;
    ui.licenceAutre.hidden = ui.licencePerso.value !== 'Autre (texte)';
    const lic = licencePerso();
    if (perso) {
      ui.credit.replaceChildren('Ma photo ', h('strong', {}, c.nom), ` · ${auteurPerso()} · `,
        URL_LICENCES[lic] ? h('a', { href: URL_LICENCES[lic], target: '_blank', rel: 'noopener noreferrer' }, lic) : lic,
        ` · ${(c.date || '').split('-').reverse().join('/')} · ${c.pano ? 'panorama 360°' : `photo ${Math.round(c.fov)}°`}${c.modele ? ` · ${c.modele}` : ''}`,
        c.estimable ? ` · GPS ${Math.round(c.distance)} m, obliquité ${Math.round(c.obliquite)}°` : ' · position inconnue', ' · lue sur cet ordinateur, rien n\'est envoyé');
    } else ui.credit.replaceChildren(...(c ? [
      'Photo ', h('a', { href: `https://api.panoramax.xyz/?pic=${c.id}`, target: '_blank', rel: 'noopener noreferrer' }, c.id.slice(0, 8)),
      ` · ${c.auteur} · `, h('a', { href: URL_LICENCES[c.licence] || '#', target: '_blank', rel: 'noopener noreferrer' }, c.licence),
      ` · ${c.date.split('-').reverse().join('/')} · ${c.pano ? 'panorama 360°' : `photo ${Math.round(c.fov)}°`} · ${c.modele} · ${Math.round(c.distance)} m, obliquité ${Math.round(c.obliquite)}° · Panoramax`,
    ] : ['Aucune photo choisie.']));
    if (c && !ui.confiance.dataset.touche) ui.confiance.value = confianceProposee();
    if (c && !ui.remarque.dataset.touche) {
      ui.remarque.value = perso ? `Redressée dans l'atlas sur 4 coins (photo personnelle ${c.pano ? '360° reprojetée' : 'perspective'}${c.estimable ? `, ${Math.round(c.distance)} m, obliquité ${Math.round(c.obliquite)}°` : ''}).`
        : `Redressée dans l'atlas sur 4 coins (photo Panoramax ${c.pano ? '360° reprojetée' : 'perspective'}, ${Math.round(c.distance)} m, obliquité ${Math.round(c.obliquite)}°).`;
    }
  }
  function ouvrir(f, nouvelle = null) {
    if (!f) return;
    if (ui.fond?.isConnected) fermer();
    etat.f = f; etat.nouvelle = nouvelle; etat.photo = null; etat.source = null; etat.coins = []; etat.rendu = null; etat.candidates = []; etat.actif = -1; etat.apercu = false;
    for (const c of etat.perso) { delete c.azForce; majPerso(c); }
    const rayon = h('input', { type: 'number', min: 10, max: 150, step: 5, value: 40, style: { width: '5em' }, 'aria-label': 'Rayon de recherche (m)' });
    ui.rayon = rayon;
    ui.ident = h('input', { type: 'text', placeholder: 'identifiant de photo ou de séquence (facultatif)', 'aria-label': 'Identifiant Panoramax', style: { width: '100%' } });
    ui.etatRecherche = h('p', { class: 'note', role: 'status', style: { margin: '4px 0' } });
    ui.liste = h('div', {});
    ui.src = h('canvas', { tabindex: 0, 'aria-label': 'Photo : coins de la façade' });
    ui.dst = h('canvas', { 'aria-label': 'Aperçu redressé' });
    ui.legendeSrc = h('div', { class: 'redr-legende' });
    ui.legendeDst = h('div', { class: 'redr-legende' });
    for (const t of ['pointerdown', 'pointermove', 'pointerup']) ui.src.addEventListener(t, pointeur);
    ui.src.addEventListener('pointercancel', () => { geste = null; });
    ui.src.addEventListener('wheel', molette, { passive: false });
    ui.src.addEventListener('contextmenu', (e) => e.preventDefault());
    const curseurVue = (min, max, cle, libelle) => h('input', { type: 'range', min, max, step: 0.5, 'aria-label': libelle, title: libelle,
      onchange: (e) => { etat.source.vue[cle] = +e.target.value; construireVue(true); etat.rendu = null; majOutils(); cadrer(); majApercu(); } });
    ui.lacet = curseurVue(0, 360, 'yaw', 'Lacet de la vue (°)');
    ui.tangage = curseurVue(-30, 60, 'pitch', 'Tangage de la vue (°)');
    ui.champ = curseurVue(30, 130, 'fov', 'Champ horizontal de la vue (°)');
    ui.valVue = h('span', { class: 'discret' });
    ui.reglagesVue = h('span', { style: { display: 'contents' } }, h('span', {}, 'Vue 360 :'), ui.lacet, ui.tangage, ui.champ, ui.valVue);
    ui.estimer = h('button', { type: 'button', class: 'bouton discret petit', title: 'Coins calculés d\'après la position, l\'azimut et le champ de la photo (approximatifs : GPS ±3 m, azimut ±5°)',
      onclick: () => { etat.coins = estimerCoins() || etat.coins; etat.rendu = null; cadrer(); majApercu(); majOutils(); } }, 'Coins estimés');
    const hCam = h('input', { type: 'number', min: 0.5, max: 6, step: 0.1, value: etat.hCam, style: { width: '4.2em' }, 'aria-label': 'Hauteur de prise de vue (m)',
      onchange: (e) => { etat.hCam = +e.target.value || H_CAMERA; } });
    const ppm = h('select', { 'aria-label': 'Résolution de l\'image redressée', onchange: (e) => { etat.ppm = +e.target.value; etat.rendu = null; majApercu(); } },
      ...[40, 60, 80, 100].map((v) => h('option', { value: v, selected: v === etat.ppm }, `${v} px/m`)));
    ui.confiance = h('select', { 'aria-label': 'Confiance', onchange: () => { ui.confiance.dataset.touche = '1'; } }, ...['bonne', 'moyenne', 'faible'].map((v) => h('option', { value: v }, v)));
    ui.remarque = h('input', { type: 'text', 'aria-label': 'Remarque', style: { flex: '2 1 240px' }, oninput: () => { ui.remarque.dataset.touche = '1'; } });
    ui.apercu = h('button', { type: 'button', class: 'bouton', onclick: apercuMaquette, title: 'Pose l\'image redressée sur la maquette sans rien écrire' }, 'Aperçu sur la maquette');
    ui.enregistrer = h('button', { type: 'button', class: 'bouton principal', onclick: enregistrer }, 'Enregistrer');
    ui.telecharger = h('button', { type: 'button', class: 'bouton discret', onclick: telechargerJPEG }, 'Télécharger le JPEG');
    ui.etatTravail = h('p', { class: 'note', role: 'status' });
    ui.credit = h('div', { class: 'redr-credit' });
    ui.titre = h('h2', {});
    ui.sousTitre = h('span', { class: 'discret', style: { flexBasis: '100%', fontSize: '12px' } });
    ui.idNouv = h('input', { type: 'text', value: f.id, 'aria-label': 'Identifiant de la nouvelle façade', style: { width: '16em' } });
    ui.nomNouv = h('input', { type: 'text', value: f.nom, 'aria-label': 'Nom de la nouvelle façade', style: { width: '22em' } });
    ui.rueNouv = h('input', { type: 'text', placeholder: 'rue', 'aria-label': 'Rue', style: { width: '14em' } });
    ui.nouvelleForme = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', flexBasis: '100%' } }, 'Identifiant ', ui.idNouv, ' Nom ', ui.nomNouv, ' Rue ', ui.rueNouv);
    // bloc « Ma photo » : photo de l'ordinateur (choisie ou glissée), auteur, licence, date, 360°
    const accepte = 'image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,.jpg,.jpeg,.png,.webp,.heic,.heif,.avif';
    ui.fichier = h('input', { type: 'file', accept: accepte, multiple: true, hidden: true,
      onchange: async (e) => { const lues = await ajouterFichiers(e.target.files); e.target.value = ''; if (lues[0]) choisirPhotoPerso(lues[0]); } });
    ui.fichierReprise = h('input', { type: 'file', accept: accepte, hidden: true, onchange: (e) => reprisePerso(e.target.files?.[0]) });
    ui.auteur = h('input', { type: 'text', value: lireLS(CLE_AUTEUR) || AUTEUR_DEFAUT, 'aria-label': 'Auteur de la photo',
      onchange: () => { ecrireLS(CLE_AUTEUR, ui.auteur.value.trim() || null); if (etat.photo?.perso) etat.photo.auteur = auteurPerso(); afficherListe(); majOutils(); } });
    const licMem = lireLS(CLE_LICENCE);
    const licAutreMem = licMem && !LICENCES_PERSO.includes(licMem) ? licMem : '';
    ui.licencePerso = h('select', { 'aria-label': 'Licence ou droits de la photo',
      onchange: () => { ecrireLS(CLE_LICENCE, ui.licencePerso.value === 'Autre (texte)' ? (ui.licenceAutre.value.trim() || null) : ui.licencePerso.value); if (etat.photo?.perso) etat.photo.licence = licencePerso(); majOutils(); } },
    ...LICENCES_PERSO.map((v) => h('option', { value: v, selected: licAutreMem ? v === 'Autre (texte)' : v === (licMem || PEDAGOGIQUE) }, v)));
    ui.licenceAutre = h('input', { type: 'text', value: licAutreMem, placeholder: 'droits, licence, accord de l\'auteur…', 'aria-label': 'Licence (texte libre)',
      onchange: () => { ecrireLS(CLE_LICENCE, ui.licenceAutre.value.trim() || null); if (etat.photo?.perso) etat.photo.licence = licencePerso(); majOutils(); } });
    ui.avertPerso = h('p', { class: 'avert', 'data-garder': '' }, 'Usage pédagogique : la publication en ligne de l\'atlas avec cette image (site hébergé, partage) est à votre appréciation (personnes reconnaissables, œuvre architecturale récente).');
    ui.datePerso = h('input', { type: 'date', 'aria-label': 'Date de prise de vue', onchange: () => { if (etat.photo?.perso) { etat.photo.date = ui.datePerso.value; afficherListe(); majOutils(); } } });
    ui.panoPerso = h('input', { type: 'checkbox', onchange: () => { const c = etat.photo; if (!c?.perso) return; c.pano = ui.panoPerso.checked; majPerso(c); etat.coins = []; choisirPhoto(c); } });
    ui.reprendre = h('button', { type: 'button', class: 'bouton petit', hidden: true, onclick: reprendre,
      title: 'Recharge la photo d\'origine du redressement enregistré (Panoramax, ou votre fichier redemandé) avec ses coins et sa vue, pour les corriger' }, 'Reprendre le redressement');
    ui.depot = h('div', { class: 'redr-perso' },
      h('div', { class: 'titre-info' }, h('strong', {}, 'Ma photo'),
        info('Une photo de votre ordinateur (JPEG, PNG, WebP ; HEIC seulement si le navigateur sait la lire, sinon exportez-la en JPEG) : bouton ou glisser-déposer d\'un ou plusieurs fichiers dans cette fenêtre. Elle est lue sur l\'ordinateur, rien n\'est envoyé.',
          'L\'orientation de l\'appareil (EXIF) est appliquée. Date de prise de vue, position GPS et direction (GPSImgDirection) sont lues si l\'appareil les a enregistrées : coins estimés (approximatifs) ; sinon un rectangle est posé, à glisser sur les 4 angles de la façade. Photo plane : distorsion de l\'objectif non corrigée (préférez une focale moyenne, de face). Panorama 360° (rapport 2:1, case cochée d\'office) : vue perspective réglable comme pour Panoramax.',
          'Grandes images : calcul sur 8000 px au plus (grand côté), affichage réduit. L\'auteur et la licence sont écrits dans data/facades/<ensemble>.json (source « Photo personnelle ») et affichés dans les crédits des photos de façade.')),
      h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
        h('button', { type: 'button', class: 'bouton petit', onclick: () => ui.fichier.click() }, 'Choisir une photo…'), h('span', { class: 'discret' }, 'ou glissez-la ici'), ui.fichier, ui.fichierReprise),
      h('label', {}, 'Auteur ', ui.auteur),
      h('label', {}, 'Licence ', ui.licencePerso), ui.licenceAutre, ui.avertPerso,
      h('label', {}, 'Prise de vue le ', ui.datePerso),
      h('label', {}, ui.panoPerso, 'Photo 360° (équirectangulaire)'),
      ui.reprendre);
    ui.boite = h('div', { class: 'redr-boite', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Redressement de façade' },
      h('div', { class: 'redr-tete' }, ui.titre,
        info('Recherche des photos Panoramax (licences ouvertes : Licence Ouverte Etalab, CC BY, CC BY-SA, CC0) autour du milieu de la façade. Obliquité : angle entre la visée vers la façade et sa normale (0° = vue de face). Panoramas 360° : une vue perspective est tirée du panorama (lacet, tangage, champ réglables) ; les photos planes sont utilisées telles quelles (distorsion de l\'objectif non corrigée).',
          'Cliquez les 4 coins dans l\'ordre haut gauche, haut droit, bas droit, bas gauche (gauche et droite vus depuis la rue), au nu du mur : du pied de façade à la corniche (hauteur_m). Les coins estimés sont approximatifs (GPS, azimut, hauteur de prise de vue supposée).',
          'L\'image redressée a les proportions réelles de la façade (longueur du segment × hauteur_m). Contrôle : les arêtes verticales doivent suivre la grille de 1 m. Aperçu sur la maquette : rien n\'est écrit. Enregistrer : le JPEG remplace l\'image (ancienne gardée dans data/.sauvegardes/ par serveur.py) et l\'entrée JSON reçoit source, auteur, licence, lien, date et la trace « redressement ». Sans serveur : téléchargement.',
          'Seule l\'emprise autour de la façade est envoyée à api.panoramax.xyz ; les photos sont lues directement chez Panoramax.'),
        h('button', { type: 'button', class: 'bouton discret', onclick: fermer, 'aria-label': 'Fermer' }, '×'),
        ui.sousTitre, ui.nouvelleForme),
      h('div', { class: 'redr-corps' },
        h('div', { class: 'redr-liste' }, ui.depot,
          h('form', { onsubmit: (e) => { e.preventDefault(); chercher(); } },
            h('label', {}, 'Rayon', rayon, 'm', h('button', { type: 'submit', class: 'bouton petit' }, 'Chercher sur Panoramax')),
            ui.ident,
            h('label', {}, ui.caseHD = h('input', { type: 'checkbox', checked: etat.hd, onchange: (e) => { etat.hd = e.target.checked; } }), 'Image HD (sinon 2048 px)')),
          ui.etatRecherche, ui.liste),
        h('div', { class: 'redr-travail' },
          h('div', { class: 'redr-outils' }, ui.estimer,
            h('button', { type: 'button', class: 'bouton discret petit', onclick: () => { etat.coins = []; etat.actif = -1; etat.rendu = null; dessinerSource(); majApercu(); majOutils(); } }, 'Effacer les coins'),
            h('button', { type: 'button', class: 'bouton discret petit', onclick: cadrer }, 'Cadrer'),
            h('label', {}, 'Prise de vue ', hCam, ' m'),
            ui.reglagesVue,
            h('label', {}, h('input', { type: 'checkbox', checked: etat.grille, onchange: (e) => { etat.grille = e.target.checked; majApercu(); } }), 'Grille 1 m'),
            ppm),
          h('div', { class: 'redr-vues' }, h('div', {}, ui.src, ui.legendeSrc), h('div', {}, ui.dst, ui.legendeDst)),
          h('div', { class: 'redr-pied' }, ui.credit, h('span', { style: { flexBasis: '100%' } }),
            h('label', {}, 'Confiance ', ui.confiance), ui.remarque, ui.apercu, ui.telecharger, ui.enregistrer, ui.etatTravail))));
    ui.fond = h('div', { class: 'redr-fond' }, ui.boite);
    ui.fond.addEventListener('keydown', clavier);
    // glisser-déposer de photos n'importe où dans la fenêtre (le navigateur n'ouvre pas le fichier)
    const fichiersGlisses = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    ui.fond.addEventListener('dragover', (e) => { if (!fichiersGlisses(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; ui.depot.classList.add('survol'); });
    ui.fond.addEventListener('dragleave', (e) => { if (!e.relatedTarget || !ui.fond.contains(e.relatedTarget)) ui.depot.classList.remove('survol'); });
    ui.fond.addEventListener('drop', async (e) => {
      if (!fichiersGlisses(e)) return;
      e.preventDefault();
      ui.depot.classList.remove('survol');
      const lues = await ajouterFichiers(e.dataTransfer.files);
      if (lues[0]) choisirPhotoPerso(lues[0]);
    });
    document.body.append(ui.fond);
    ui.observateur = new ResizeObserver(() => { dessinerSource(); majApercu(); });
    ui.observateur.observe(ui.src); ui.observateur.observe(ui.dst);
    majTete(); majOutils(); dessinerSource(); dessinerApercu(); afficherListe();
    ui.boite.querySelector('button[type=submit]').focus();
    chercher();
  }
  function fermer() {
    if (etat.apercu && !confirm('L\'aperçu posé sur la maquette n\'est pas enregistré. Fermer et le retirer ?')) return;
    if (etat.apercu) {
      // aperçu retiré : image d'origine relue (façade existante) ou façade ajoutée laissée sans image
      if (!etat.nouvelle) T.rechargerImageFacade(etat.f);
      else T.rechargerImageFacade(etat.f, `${T.cheminImage(etat.f)}?absente`);
      etat.apercu = false;
    }
    ui.observateur?.disconnect();
    ui.fond?.remove();
    ui.fond = null; ui.boite = null;
    if (etat.rendu?.url) URL.revokeObjectURL(etat.rendu.url);
    etat.source = null;
  }

  return { ouvrir, fermer, ajouterFacade, chercher, choisirPhoto, rendre, enregistrer, etat, murSous, ajouterFichiers, choisirPhotoPerso, reprendre, reprisePerso };
}
