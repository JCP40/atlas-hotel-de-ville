// Lissage des cartes d'analyse au sol (Confort, UTCI, Chaleur) : rendu VISUEL en dégradé continu entre les mailles.
// Les VALEURS de la grille sont interpolées (bilinéaire entre les centres des mailles, seulement entre mailles valides),
// puis colorées : pas de mélange de couleurs ni de halo noir au bord du cercle ou des bâtiments (une sous-maille dont la
// maille est masquée reste transparente). Le modèle n'est pas plus précis pour autant : la valeur lue au survol, les CSV
// et les statistiques restent celles de la maille.
// Préférence partagée par les panneaux Confort et Chaleur : localStorage `atlas-hdv-lissage` ('0' = désactivé ; défaut activé),
// événement `lissage` à chaque changement.
import * as THREE from 'three';
import { h, lireLS, ecrireLS } from './util.js';

const CLE = 'atlas-hdv-lissage';
export const lissageActif = () => lireLS(CLE) !== '0';

// case « Lisser la carte » (une par panneau, synchronisées par l'événement `lissage`)
export function caseLissage(app) {
  const c = h('input', { type: 'checkbox' });
  c.checked = lissageActif();
  c.addEventListener('change', () => { ecrireLS(CLE, c.checked ? null : '0'); app.emettre('lissage', c.checked); });
  app.on('lissage', (v) => { if (c.isConnected) c.checked = v; });
  return h('label', { class: 'case', title: 'Dégradé continu entre les mailles de la grille (rendu visuel : le calcul reste fait maille par maille, les valeurs au survol et les exports CSV sont celles de la maille).' },
    c, ' Lisser la carte');
}

// sous-échantillonnage : 4 sous-pixels par maille, moins pour une grande grille (≤ 2 048 px de côté)
const facteur = (nx, nz) => Math.max(1, Math.min(4, Math.floor(2048 / Math.max(nx, nz))));

// texture d'une grille nx × nz (k = i + j·nx, j vers le sud) :
//  - valeur(k) → nombre (NaN = maille masquée) et couleur(v) → [r, g, b] | null : carte continue, lissée si `lisse` ;
//  - sans `valeur` : couleurBrute(k) → [r, g, b] | null maille par maille (carte par catégories, jamais lissée).
// userData { lisse, nx, nz, f } : les exports (PNG) redessinent la carte à la taille de la grille.
export function textureGrille({ nx, nz, valeur, couleur, couleurBrute, alpha = 215, lisse = lissageActif() }) {
  const N = nx * nz;
  const V = new Float32Array(N);
  if (valeur) for (let k = 0; k < N; k++) { const v = valeur(k); V[k] = Number.isFinite(v) ? v : NaN; }
  const parMaille = (k) => (valeur ? (Number.isFinite(V[k]) ? couleur(V[k]) : null) : couleurBrute(k));
  if (!valeur || !lisse) {
    const px = new Uint8Array(N * 4);
    for (let k = 0; k < N; k++) {
      const c = parMaille(k);
      if (c) { px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = alpha; }
    }
    return finir(new THREE.DataTexture(px, nx, nz, THREE.RGBAFormat), { lisse: false, nx, nz, f: 1 });
  }
  // table de couleurs (2 048 pas entre min et max) : couleur() n'est appelée que 2 048 fois
  let min = Infinity, max = -Infinity;
  for (let k = 0; k < N; k++) if (V[k] === V[k]) { if (V[k] < min) min = V[k]; if (V[k] > max) max = V[k]; }
  const f = facteur(nx, nz), W = nx * f, H = nz * f;
  const px = new Uint8Array(W * H * 4);
  if (!(max >= min)) return finir(new THREE.DataTexture(px, W, H, THREE.RGBAFormat), { lisse: true, nx, nz, f });
  const NL = 2048, et = max - min || 1, LUT = new Int16Array(NL * 3).fill(-1);
  for (let q = 0; q < NL; q++) {
    const c = couleur(min + (et * q) / (NL - 1));
    if (c) { LUT[q * 3] = c[0]; LUT[q * 3 + 1] = c[1]; LUT[q * 3 + 2] = c[2]; }
  }
  for (let J = 0; J < H; J++) {
    const cj = (J / f) | 0, v = (J + 0.5) / f - 0.5, j0 = Math.max(0, Math.min(nz - 1, Math.floor(v))), j1 = Math.min(nz - 1, j0 + 1), b = Math.max(0, Math.min(1, v - j0));
    for (let I = 0; I < W; I++) {
      const ci = (I / f) | 0;
      if (V[ci + cj * nx] !== V[ci + cj * nx]) continue; // maille masquée : transparente (pas de halo)
      const u = (I + 0.5) / f - 0.5, i0 = Math.max(0, Math.min(nx - 1, Math.floor(u))), i1 = Math.min(nx - 1, i0 + 1), a = Math.max(0, Math.min(1, u - i0));
      const v00 = V[i0 + j0 * nx], v10 = V[i1 + j0 * nx], v01 = V[i0 + j1 * nx], v11 = V[i1 + j1 * nx];
      let s = 0, w = 0, p;
      p = (1 - a) * (1 - b); if (p > 0 && v00 === v00) { s += p * v00; w += p; }
      p = a * (1 - b); if (p > 0 && v10 === v10) { s += p * v10; w += p; }
      p = (1 - a) * b; if (p > 0 && v01 === v01) { s += p * v01; w += p; }
      p = a * b; if (p > 0 && v11 === v11) { s += p * v11; w += p; }
      const val = w > 0 ? s / w : V[ci + cj * nx];
      const q = Math.round(((val - min) / et) * (NL - 1)) * 3;
      if (LUT[q] < 0) continue;
      const o = (I + J * W) * 4;
      px[o] = LUT[q]; px[o + 1] = LUT[q + 1]; px[o + 2] = LUT[q + 2]; px[o + 3] = alpha;
    }
  }
  // pixels vides : couleur (alpha nul) d'un voisin coloré, pour que le filtrage linéaire du GPU n'assombrisse pas les bords
  for (let J = 0; J < H; J++) for (let I = 0; I < W; I++) {
    const o = (I + J * W) * 4;
    if (px[o + 3]) continue;
    const o2 = I > 0 && px[o - 1] ? o - 4 : I < W - 1 && px[o + 7] ? o + 4 : J > 0 && px[o - W * 4 + 3] ? o - W * 4 : J < H - 1 && px[o + W * 4 + 3] ? o + W * 4 : -1;
    if (o2 >= 0) { px[o] = px[o2]; px[o + 1] = px[o2 + 1]; px[o + 2] = px[o2 + 2]; }
  }
  return finir(new THREE.DataTexture(px, W, H, THREE.RGBAFormat), { lisse: true, nx, nz, f });
}
function finir(tex, ud) {
  tex.colorSpace = THREE.SRGBColorSpace;
  // lissé : filtrage linéaire entre sous-pixels (ils ne sont jamais voisins d'un pixel vide à l'intérieur d'une maille valide) ;
  // brut : mailles nettes
  tex.magFilter = ud.lisse ? THREE.LinearFilter : THREE.NearestFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.userData = ud;
  tex.needsUpdate = true;
  return tex;
}

// dessine la texture d'une carte dans un contexte 2D (exports PNG) sur w × h px
export function dessinerTexture(ctx, tex, x, y, w, h) {
  const { data, width, height } = tex.image;
  const tmp = document.createElement('canvas'); tmp.width = width; tmp.height = height;
  tmp.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.buffer.slice(data.byteOffset, data.byteOffset + width * height * 4)), width, height), 0, 0);
  ctx.imageSmoothingEnabled = !!tex.userData?.lisse;
  ctx.drawImage(tmp, x, y, w, h);
  ctx.imageSmoothingEnabled = true;
}

// ------------------------------------------------------------------------------------------------
// Haute résolution (08/11/2026) : grille de 1 m, calcul fin dans une « Zone détaillée » autour du centre de l'analyse
// (rayon 50-150 m, défaut 100 m), un point de calcul par bloc de 2 × 2 m jusqu'à 150 m, de 3 × 3 m au-delà (comme les
// mailles de 2 et 3 m de la résolution normale). La grille reste uniforme à 1 m (matériaux, masques bâtis, texture, survol,
// exports) ; hors de la zone détaillée, les mailles d'un bloc reçoivent la valeur de son point de calcul (G.rep).
// Réglages communs à Confort, UTCI et Chaleur (même grille) : localStorage `atlas-hdv-haute-resolution` ('1' / '0' ;
// défaut : activée, sauf écran tactile `pointer: coarse`) et `atlas-hdv-zone-detaillee` (m) ; événement `resolution`.
// Détail VISUEL : le modèle reste une estimation pédagogique.
const CLE_HR = 'atlas-hdv-haute-resolution', CLE_ZONE = 'atlas-hdv-zone-detaillee';
const tactile = () => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } };
export const hauteResolution = () => { const v = lireLS(CLE_HR); return v === null ? !tactile() : v === '1'; };
export const zoneDetaillee = () => { const v = Number(lireLS(CLE_ZONE)); return v >= 50 && v <= 150 ? v : 100; };
export const signatureResolution = () => (hauteResolution() ? `hr${zoneDetaillee()}` : 'normal');
// côté du bloc de calcul (en mailles de 1 m) selon la distance au centre de l'analyse
export const tailleBloc = (d, Rd = zoneDetaillee()) => (d <= Rd ? 1 : d <= 150 ? 2 : 3);

// représentant de chaque maille (Int32Array, -1 = maille sans calcul) : la première maille retenue de son bloc
// (blocs alignés sur la grille, de côté tailleBloc(distance de la maille)) ; garder(k) = maille de calcul possible
export function representants({ nx, nz, x0, z0, pas = 1, garder, Rd = zoneDetaillee() }) {
  const rep = new Int32Array(nx * nz).fill(-1), vus = new Map();
  for (let j = 0; j < nz; j++) {
    const z = z0 + (j + 0.5) * pas;
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (!garder(k)) continue;
      const x = x0 + (i + 0.5) * pas, b = tailleBloc(Math.hypot(x, z), Rd);
      if (b === 1) { rep[k] = k; continue; }
      const cle = b * 1e9 + Math.floor(j / b) * 1e5 + Math.floor(i / b);
      const r = vus.get(cle);
      if (r === undefined) { vus.set(cle, k); rep[k] = k; } else rep[k] = r;
    }
  }
  return rep;
}
// recopie la valeur des représentants dans les autres mailles de leur bloc (en place)
export function etendre(arr, rep) {
  if (!arr || !rep) return arr;
  for (let k = 0; k < rep.length; k++) { const r = rep[k]; if (r >= 0 && r !== k) arr[k] = arr[r]; }
  return arr;
}
// nombre approximatif de points de calcul dans un cercle de rayon r (part de sol ouvert ≈ 0,65)
export function pointsEstimes(r, hr = hauteResolution(), Rd = zoneDetaillee()) {
  const A = (a) => Math.PI * a * a;
  if (!hr) return Math.round((0.65 * A(r)) / (r <= 150 ? 4 : r <= 300 ? 9 : 16));
  const a = Math.min(Rd, r), b = Math.min(150, r);
  return Math.round(0.65 * (A(a) + (A(b) - A(a)) / 4 + (A(r) - A(b)) / 9));
}
// durée par point mesurée au dernier calcul (par outil et par moteur), pour la durée estimée avant le lancement
export const noterDuree = (outil, ms, points) => { if (points > 50 && ms > 0) ecrireLS(`atlas-hdv-duree-${outil}`, String(ms / points)); };
const dureeParPoint = (outil) => { const v = Number(lireLS(`atlas-hdv-duree-${outil}`)); return v > 0 ? v : null; };
const texteDuree = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

// barres de progression des blocs affichés (une par panneau)
const barres = new Set();
export function progresGrille(u) {
  for (const b of barres) {
    if (!b.isConnected) { barres.delete(b); continue; }
    if (u == null || !(u >= 0)) { b.hidden = true; continue; }
    b.hidden = false; b.value = Math.min(1, u);
  }
}
// suit les notes « … : 42 % » d'un panneau (Chaleur, Confort) et masque la barre aux autres messages
export const suivreNote = (t) => { const m = /(\d+) %/.exec(t || ''); progresGrille(m ? Number(m[1]) / 100 : null); };

// bloc du panneau : case « Haute résolution », curseur « Zone détaillée », durée estimée, barre de progression
// options : outil (clé de la durée mesurée), rayon() (m)
export function blocResolution(app, { outil, rayon }) {
  const c = h('input', { type: 'checkbox' });
  const curseur = h('input', { type: 'range', min: 50, max: 150, step: 10, 'aria-label': 'Rayon de la zone détaillée (m)' });
  const valeur = h('span', { class: 'valeur-zone' });
  const estimation = h('p', { class: 'note', 'data-garder': '' });
  const barre = h('progress', { max: 1, value: 0, hidden: true, class: 'progres-grille', style: { width: '100%' }, 'aria-label': 'Avancement du calcul' });
  barres.add(barre);
  const ligneZone = h('label', { class: 'champ' }, h('span', {}, 'Zone détaillée (rayon)'), curseur, valeur);
  const maj = () => {
    const hr = hauteResolution(), Rd = zoneDetaillee(), r = rayon();
    c.checked = hr; curseur.value = Rd; valeur.textContent = ` ${Rd} m`;
    ligneZone.hidden = !hr;
    const n = pointsEstimes(r, hr, Rd), n0 = pointsEstimes(r, false), v = dureeParPoint(outil);
    estimation.textContent = hr
      ? `Maille de 1 m dans ${Math.min(Rd, r)} m autour du centre, blocs de 2 m jusqu'à 150 m${r > 150 ? ', 3 m au-delà' : ''} : environ ${n.toLocaleString('fr-FR')} points de calcul (${(n / n0).toFixed(1).replace('.', ',')} fois la résolution normale)${v ? `, durée estimée ≈ ${texteDuree(v * n)} sur cet ordinateur` : ''}. Détail visuel : l'estimation n'est pas plus précise pour autant.`
      : `Résolution normale : mailles de ${r <= 150 ? 2 : 3} m, environ ${n0.toLocaleString('fr-FR')} points de calcul${v ? `, durée estimée ≈ ${texteDuree(v * n0)}` : ''}.`;
  };
  c.addEventListener('change', () => { ecrireLS(CLE_HR, c.checked ? '1' : '0'); maj(); app.emettre('resolution'); });
  curseur.addEventListener('input', () => { valeur.textContent = ` ${curseur.value} m`; });
  curseur.addEventListener('change', () => { ecrireLS(CLE_ZONE, curseur.value); maj(); app.emettre('resolution'); });
  app.on('resolution', () => { if (c.isConnected) maj(); });
  maj();
  const bloc = h('div', { class: 'bloc-resolution', 'data-garder': '' },
    h('label', { class: 'case', title: 'Grille de 1 m près du centre de l\'analyse (détail visuel ; calcul plus long). Désactivée par défaut sur écran tactile.' }, c, ' Haute résolution'),
    ligneZone, estimation, barre);
  bloc.maj = maj;
  return bloc;
}
