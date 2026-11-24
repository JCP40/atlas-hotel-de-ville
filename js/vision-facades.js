// Analyse d'image pour l'assistant d'îlot (js/assistant-ilot.js, 19/11/2026). JavaScript pur, sans DOM ni Three.js :
// testable sous Node (images synthétiques à vérité terrain).
// Repère de l'atlas : x est, y haut, z sud ; azimut depuis le nord, sens horaire.
// Caméra « pose » : { P: [x, y, z], M: [r, u, f] (lignes : monde → coordonnées caméra ; r droite, u haut, f avant), fpx, W, H }
// pixel = (W/2 + fpx·c0/c2, H/2 − fpx·c1/c2) avec c = M (X − P). M peut être de déterminant −1 (r, u, f sont « main gauche »
// dans js/redressement-facades.js : u = r × f) : toutes les formules ci-dessous le respectent.
//
// Chaîne de placement d'une façade (placerFacade) :
// 1. gradients (flou gaussien 5 points, Sobel) et segments de droite (croissance de régions de même orientation, à la LSD,
//    sans le test a contrario) ;
// 2. point de fuite vertical par RANSAC sur les segments quasi verticaux (pondérés par la longueur), affiné aux moindres
//    carrés (plus petit vecteur propre) ; point de fuite des horizontales de la façade de même, dans la zone prédite ;
//    rotation de la caméra déduite des deux directions (verticales redressées, lacet relatif à la façade) ;
// 3. position de la caméra : grille de ± 6,5 m autour du GPS ; pour chaque position, les arêtes verticales du modèle
//    (sommets visibles de l'emprise) sont projetées et notées sur le profil E(x) (contraste de signe constant le long de la
//    verticale : une arête de bâtiment le garde sur toute la hauteur, une colonne de fenêtres non), moins l'écart au GPS ;
// 4. pour les 30 meilleures positions, hauteur de prise de vue (± 0,8 m autour de l'a priori : moins qu'un étage) qui
//    aligne l'égout du modèle sur la corniche et le pied du mur sur le sol ; meilleur total, affinage au gradient (2 cm, 1 cm) ;
// 5. coins = projection des coins du modèle (sol, égout ou niveau choisi) par la caméra trouvée ; indicateur de confiance.

const RAD = Math.PI / 180;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ------------------------------------------------------------------ images
// image RGBA { data, width, height } → niveaux de gris (Float32, 0-255)
export function gris(img) {
  const { data, width: W, height: H } = img;
  const g = new Float32Array(W * H);
  for (let i = 0, o = 0; i < g.length; i++, o += 4) g[i] = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
  return { g, W, H };
}
function flou(g, W, H) {
  const k = [1, 4, 6, 4, 1];
  const t = new Float32Array(W * H), o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * g[y * W + clamp(x + i, 0, W - 1)];
    t[y * W + x] = s / 16;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let s = 0;
    for (let i = -2; i <= 2; i++) s += k[i + 2] * t[clamp(y + i, 0, H - 1) * W + x];
    o[y * W + x] = s / 16;
  }
  return o;
}
// gradients (Sobel sur l'image floutée) : { W, H, g (floutée), gx, gy, mag }
export function gradients({ g, W, H }) {
  const b = flou(g, W, H);
  const gx = new Float32Array(W * H), gy = new Float32Array(W * H), mag = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    const a = b[i - W - 1], c = b[i - W + 1], d = b[i + W - 1], e = b[i + W + 1];
    const X = (c + 2 * b[i + 1] + e - a - 2 * b[i - 1] - d) / 8;
    const Y = (d + 2 * b[i + W] + e - a - 2 * b[i - W] - c) / 8;
    gx[i] = X; gy[i] = Y; mag[i] = Math.hypot(X, Y);
  }
  return { W, H, g: b, gx, gy, mag };
}
const bil = (A, W, H, x, y) => {
  if (x < 0 || y < 0 || x > W - 1.001 || y > H - 1.001) return NaN;
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, i = y0 * W + x0;
  return (A[i] * (1 - fx) + A[i + 1] * fx) * (1 - fy) + (A[i + W] * (1 - fx) + A[i + W + 1] * fx) * fy;
};

// ------------------------------------------------------------------ segments de droite
// Croissance de régions de pixels d'orientation voisine (tolérance en °), ajustement par composantes principales.
// Retour : [{ x1, y1, x2, y2, l (longueur px), cx, cy, dx, dy (direction unitaire) }]
export function segmentsLignes(G, { seuil = 4, tolerance = 22.5, longueurMin = 18, zone = null } = {}) {
  const { W, H, gx, gy, mag } = G;
  const n = W * H;
  const ang = new Float32Array(n);
  const NB = 1024;
  let mmax = 0;
  for (let i = 0; i < n; i++) if (mag[i] > mmax) mmax = mag[i];
  const comptes = new Uint32Array(NB + 1);
  const bac = (m) => Math.min(NB, Math.floor((m / (mmax || 1)) * NB));
  for (let i = 0; i < n; i++) {
    if (mag[i] <= seuil) continue;
    if (zone) { const x = i % W, y = (i / W) | 0; if (x < zone[0] || y < zone[1] || x > zone[2] || y > zone[3]) continue; }
    let a = Math.atan2(gx[i], -gy[i]); // direction de la ligne de niveau (perpendiculaire au gradient)
    if (a < 0) a += Math.PI;
    ang[i] = a;
    comptes[bac(mag[i])]++;
  }
  // tri par module décroissant (seaux)
  let total = 0;
  const offs = new Uint32Array(NB + 1);
  for (let k = NB; k >= 0; k--) { offs[k] = total; total += comptes[k]; }
  const ordre = new Uint32Array(total);
  for (let i = 0; i < n; i++) {
    if (mag[i] <= seuil) continue;
    if (zone) { const x = i % W, y = (i / W) | 0; if (x < zone[0] || y < zone[1] || x > zone[2] || y > zone[3]) continue; }
    ordre[offs[bac(mag[i])]++] = i;
  }
  const pris = new Uint8Array(n);
  const tol = tolerance * RAD;
  const ecart = (a, b) => { let d = Math.abs(a - b) % Math.PI; return d > Math.PI / 2 ? Math.PI - d : d; };
  const segs = [];
  const pile = [], region = [];
  for (let s = 0; s < total; s++) {
    const i0 = ordre[s];
    if (pris[i0]) continue;
    pris[i0] = 1;
    pile.length = 0; region.length = 0;
    pile.push(i0); region.push(i0);
    let Sx = Math.cos(2 * ang[i0]), Sy = Math.sin(2 * ang[i0]);
    let ar = ang[i0];
    while (pile.length) {
      const i = pile.pop();
      const x = i % W, y = (i / W) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 1 || yy >= H - 1) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((!dx && !dy) || xx < 1 || xx >= W - 1) continue;
          const j = yy * W + xx;
          if (pris[j] || mag[j] <= seuil) continue;
          if (zone && (xx < zone[0] || yy < zone[1] || xx > zone[2] || yy > zone[3])) continue;
          if (ecart(ang[j], ar) > tol) continue;
          pris[j] = 1; pile.push(j); region.push(j);
          Sx += Math.cos(2 * ang[j]); Sy += Math.sin(2 * ang[j]);
          ar = 0.5 * Math.atan2(Sy, Sx); if (ar < 0) ar += Math.PI;
        }
      }
    }
    if (region.length < longueurMin * 0.6) continue;
    // composantes principales pondérées par le module
    let sw = 0, mx = 0, my = 0;
    for (const i of region) { const w = mag[i]; sw += w; mx += w * (i % W); my += w * ((i / W) | 0); }
    mx /= sw; my /= sw;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const i of region) { const w = mag[i], X = (i % W) - mx, Y = ((i / W) | 0) - my; cxx += w * X * X; cyy += w * Y * Y; cxy += w * X * Y; }
    const th = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const dx = Math.cos(th), dy = Math.sin(th);
    let tmin = Infinity, tmax = -Infinity, lmax = 0;
    for (const i of region) {
      const X = (i % W) - mx, Y = ((i / W) | 0) - my;
      const t = X * dx + Y * dy, l = Math.abs(-X * dy + Y * dx);
      if (t < tmin) tmin = t; if (t > tmax) tmax = t; if (l > lmax) lmax = l;
    }
    const L = tmax - tmin;
    if (L < longueurMin || lmax > 2.5 + 0.06 * L || region.length < 0.7 * L) continue;
    segs.push({ x1: mx + tmin * dx, y1: my + tmin * dy, x2: mx + tmax * dx, y2: my + tmax * dy, l: L, cx: mx + ((tmin + tmax) / 2) * dx, cy: my + ((tmin + tmax) / 2) * dy, dx, dy });
  }
  return segs;
}

// ------------------------------------------------------------------ points de fuite
// Point de fuite en coordonnées homogènes pixel [x, y, w] (w = 0 : à l'infini)
// écart angulaire (°) entre un segment et la direction vers le point de fuite v
export function ecartPF(s, v) {
  let ex, ey;
  if (Math.abs(v[2]) < 1e-9 * (Math.abs(v[0]) + Math.abs(v[1]))) { ex = v[0]; ey = v[1]; } else { ex = v[0] / v[2] - s.cx; ey = v[1] / v[2] - s.cy; }
  const c = Math.abs(ex * s.dx + ey * s.dy) / (Math.hypot(ex, ey) || 1);
  return Math.acos(Math.min(1, c)) / RAD;
}
// plus petit vecteur propre d'une matrice 3 × 3 symétrique (Jacobi)
function vecteurPropreMin(A) {
  const a = [[A[0], A[1], A[2]], [A[1], A[4], A[5]], [A[2], A[5], A[8]]];
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let it = 0; it < 50; it++) {
    let p = 0, q = 1, m = Math.abs(a[0][1]);
    if (Math.abs(a[0][2]) > m) { p = 0; q = 2; m = Math.abs(a[0][2]); }
    if (Math.abs(a[1][2]) > m) { p = 1; q = 2; m = Math.abs(a[1][2]); }
    if (m < 1e-15) break;
    const th = 0.5 * Math.atan2(2 * a[p][q], a[q][q] - a[p][p]);
    const c = Math.cos(th), s = Math.sin(th);
    for (let k = 0; k < 3; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
    for (let k = 0; k < 3; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
    for (let k = 0; k < 3; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
  }
  let k = 0;
  if (a[1][1] < a[k][k]) k = 1;
  if (a[2][2] < a[k][k]) k = 2;
  return [V[0][k], V[1][k], V[2][k]];
}
// RANSAC + moindres carrés. segs : segments candidats ; options : W, H (normalisation), tolerance (°), iterations,
// accepter(vp) : rejette un point de fuite (par ex. trop loin de la direction nominale)
export function pointFuite(segs, { W, H, tolerance = 1.2, iterations = 600, alea = Math.random, accepter = null } = {}) {
  if (segs.length < 2) return null;
  const S = Math.max(W, H), ox = W / 2, oy = H / 2;
  // droites normalisées (coordonnées centrées et réduites)
  const L = segs.map((s) => {
    const p = [(s.x1 - ox) / S, (s.y1 - oy) / S, 1], q = [(s.x2 - ox) / S, (s.y2 - oy) / S, 1];
    const l = cross(p, q); const k = Math.hypot(l[0], l[1]) || 1;
    return [l[0] / k, l[1] / k, l[2] / k];
  });
  const versPix = (v) => [v[0] * S + ox * v[2], v[1] * S + oy * v[2], v[2]];
  const poidsTotal = segs.reduce((a, s) => a + s.l, 0);
  let meilleur = null, best = 0;
  const cumul = []; let c = 0; for (const s of segs) { c += s.l; cumul.push(c); }
  const tirer = () => { const r = alea() * c; let lo = 0, hi = cumul.length - 1; while (lo < hi) { const m = (lo + hi) >> 1; if (cumul[m] < r) lo = m + 1; else hi = m; } return lo; };
  for (let it = 0; it < iterations; it++) {
    const i = tirer(), j = tirer();
    if (i === j) continue;
    const v = cross(L[i], L[j]);
    if (Math.hypot(v[0], v[1], v[2]) < 1e-12) continue;
    const vp = versPix(unit(v));
    if (accepter && !accepter(vp)) continue;
    let sc = 0;
    for (let k = 0; k < segs.length; k++) if (ecartPF(segs[k], vp) < tolerance) sc += segs[k].l;
    if (sc > best) { best = sc; meilleur = vp; }
  }
  if (!meilleur) return null;
  // affinage : moindres carrés sur les inliers (poids = longueur²), deux passes
  let v = meilleur, inl = [];
  for (let pass = 0; pass < 3; pass++) {
    inl = segs.map((s, k) => k).filter((k) => ecartPF(segs[k], v) < tolerance);
    if (inl.length < 2) break;
    const A = new Array(9).fill(0);
    for (const k of inl) {
      const l = L[k], w = segs[k].l * segs[k].l;
      for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[a * 3 + b] += w * l[a] * l[b];
    }
    const e = vecteurPropreMin(A);
    const vp = versPix(e);
    if (accepter && !accepter(vp)) break;
    v = vp;
  }
  inl = segs.map((s, k) => k).filter((k) => ecartPF(segs[k], v) < tolerance);
  const poids = inl.reduce((a, k) => a + segs[k].l, 0);
  const residu = inl.length ? Math.sqrt(inl.reduce((a, k) => a + segs[k].l * ecartPF(segs[k], v) ** 2, 0) / poids) : 0;
  return { v, inliers: inl, n: inl.length, poids, part: poids / poidsTotal, residu };
}

// ------------------------------------------------------------------ caméras
export function poseDepuisCamera(cam) {
  return { P: [...cam.P], M: [[...cam.r], [...cam.u], [...cam.f]], fpx: cam.fpx, W: cam.W, H: cam.H };
}
export function versCamera(pose, X) { const v = sub(X, pose.P); return [dot(pose.M[0], v), dot(pose.M[1], v), dot(pose.M[2], v)]; }
export function projeter(pose, X) {
  const c = versCamera(pose, X);
  if (c[2] <= 1e-6) return null;
  return [pose.W / 2 + (pose.fpx * c[0]) / c[2], pose.H / 2 - (pose.fpx * c[1]) / c[2]];
}
// direction caméra (coordonnées c) d'un point homogène pixel
export function directionPixel(pose, v) { return [v[0] - (pose.W / 2) * v[2], (pose.H / 2) * v[2] - v[1], pose.fpx * v[2]]; }
// point de fuite (homogène pixel) d'une direction du monde
export function pfDirection(pose, d) {
  const c = [dot(pose.M[0], d), dot(pose.M[1], d), dot(pose.M[2], d)];
  return [pose.fpx * c[0] + (pose.W / 2) * c[2], -pose.fpx * c[1] + (pose.H / 2) * c[2], c[2]];
}
// monde → caméra M dont M·haut = dv (caméra) et M·U = dh (caméra), U = direction horizontale de la façade ; signe du
// déterminant de la caméra nominale conservé
export function rotationDepuisDirections(dv, dh, U, signe = -1) {
  const y = unit(dv);
  let x = sub(dh, y.map((v) => v * dot(dh, y)));
  x = unit(x);
  const z = cross(x, y).map((v) => v * signe);
  const Uw = unit([U[0], 0, U[2]]), up = [0, 1, 0], Zw = cross(Uw, up);
  // M = Bc · Bwᵀ (colonnes Bc = [x, y, z], Bw = [U, up, U × up])
  const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) M[i][j] = x[i] * Uw[j] + y[i] * up[j] + z[i] * Zw[j];
  return M;
}
export const determinant = (M) => dot(M[0], cross(M[1], M[2]));
// angle (°) entre deux rotations caméra (même convention)
export function ecartRotation(A, B) {
  let tr = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) tr += A[i][j] * B[i][j];
  return Math.acos(clamp((tr - 1) / 2, -1, 1)) / RAD;
}

// ------------------------------------------------------------------ mesures le long d'une droite
// Mesures le long des points pts [[x, y]…] (normale n unitaire) :
// - c : contraste de signe constant, 20e centile de (gris d'un côté − gris de l'autre, à ± ecart px) pris dans le sens
//   dominant : une arête de bâtiment (changement de face, de matériau, ciel) le garde sur toute la longueur, une colonne de
//   tableaux de fenêtres ou un bandeau mince non (le centile tombe à 0 entre les fenêtres) ;
// - g : gradient perpendiculaire moyen (localisation fine au pixel).
function scoreLe(G, pts, n, ecartPx = 4) {
  const ds = [];
  let sg = 0;
  for (const [x, y] of pts) {
    const gx = bil(G.gx, G.W, G.H, x, y), gy = bil(G.gy, G.W, G.H, x, y);
    const a = bil(G.g, G.W, G.H, x - n[0] * ecartPx, y - n[1] * ecartPx), b = bil(G.g, G.W, G.H, x + n[0] * ecartPx, y + n[1] * ecartPx);
    if (Number.isNaN(gx) || Number.isNaN(a) || Number.isNaN(b)) continue;
    sg += Math.abs(gx * n[0] + gy * n[1]);
    ds.push(a - b);
  }
  const k = ds.length;
  if (k < 5 || k < pts.length * 0.6) return { s: 0, c: 0, g: 0, k };
  const m = ds.reduce((x, y) => x + y, 0) / k;
  const sg2 = Math.sign(m) || 1;
  const t = ds.map((v) => v * sg2).sort((x, y) => x - y);
  const c = Math.max(0, t[Math.floor(0.2 * k)]);
  return { s: c, c, g: sg / k, k };
}
// droite verticale (par le point de fuite vp) passant par (x0, yRef) : x(y)
function xSurVerticale(vp, x0, yRef, y) {
  if (Math.abs(vp[2]) < 1e-9 * (Math.abs(vp[0]) + Math.abs(vp[1]))) return x0 + (vp[0] / vp[1]) * (y - yRef);
  const vx = vp[0] / vp[2], vy = vp[1] / vp[2];
  return x0 + ((vx - x0) / (vy - yRef)) * (y - yRef);
}
function profilVertical(G, vp, x0, yRef, ya, yb, pas = 2, ecart = 4) {
  const pts = [];
  for (let y = ya; y <= yb; y += pas) pts.push([xSurVerticale(vp, x0, yRef, y), y]);
  if (pts.length < 2) return { s: 0 };
  const dx = pts[pts.length - 1][0] - pts[0][0], dy = pts[pts.length - 1][1] - pts[0][1], l = Math.hypot(dx, dy) || 1;
  return scoreLe(G, pts, [dy / l, -dx / l], ecart);
}
function profilSegment(G, A, B, pas = 2, ecart = 4) {
  const l = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (!(l > 4)) return { s: 0 };
  const pts = [];
  for (let t = 0.04; t <= 0.96; t += pas / l) pts.push([A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t]);
  return scoreLe(G, pts, [-(B[1] - A[1]) / l, (B[0] - A[0]) / l], ecart);
}
// maxima locaux d'un profil (suppression des non-maxima sur ± r) : [{ i, v }] décroissants
function pics(v, r, nmax = 6) {
  const res = [];
  for (let i = 0; i < v.length; i++) {
    let ok = v[i] > 0;
    for (let k = Math.max(0, i - r); ok && k <= Math.min(v.length - 1, i + r); k++) if (v[k] > v[i] || (v[k] === v[i] && k < i)) ok = false;
    if (ok) res.push({ i, v: v[i] });
  }
  return res.sort((a, b) => b.v - a.v).slice(0, nmax);
}
const mediane = (a) => { const s = [...a].filter((x) => x > 0).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 1; };
// demi-largeur (en indices) du pic i à mi-hauteur au-dessus de la médiane
function demiLargeur(v, i, base) {
  const m = base + (v[i] - base) / 2;
  let a = i, b = i;
  while (a > 0 && v[a - 1] > m) a--;
  while (b < v.length - 1 && v[b + 1] > m) b++;
  return (b - a + 1) / 2;
}

// ------------------------------------------------------------------ placement d'une façade
// G : gradients de l'image analysée ; nominale : pose nominale (GPS, azimut, hauteur a priori) de la même image ;
// facade : { gauche: [x, z], droite: [x, z], sol (altitude du pied du mur), hauts: { egout, brisis?, sommet? } (m au-dessus du sol) } ;
// sol(x, z) : terrain sous la caméra ; options : hCam (a priori), sigmaGPS (m), plageH (± m), inclinaisonMax (° : écart
// toléré entre verticale mesurée et verticale nominale, boîtier d'un panorama rarement penché de plus de 3°), lacetMax (° : azimut)
export function placerFacade(G, nominale, facade, { sol = () => 0, hCam = 2.5, plageH = 0.8, sigmaGPS = 4, rechercheGPS = 5, segs = null, alea = Math.random, inclinaisonMax = 4, lacetMax = 8 } = {}) {
  const { W, H } = G;
  const [gx, gz] = facade.gauche, [dx, dz] = facade.droite;
  const L = Math.hypot(dx - gx, dz - gz);
  const U = [(dx - gx) / L, 0, (dz - gz) / L];
  const y0 = facade.sol, He = facade.hauts.egout;
  const det = Math.sign(determinant(nominale.M)) || -1;
  const notes = [];
  const res = { notes, confiance: 'manuel', etapes: {} };
  const segments = segs || segmentsLignes(G);
  res.etapes.segments = segments.length;

  // 1. point de fuite vertical
  const pfV0 = pfDirection(nominale, [0, 1, 0]);
  const dirV0 = unit(directionPixel(nominale, pfV0));
  const angleCam = (vp, ref) => { let d = unit(directionPixel(nominale, vp)); if (dot(d, ref) < 0) d = d.map((x) => -x); return [Math.acos(clamp(dot(d, ref), -1, 1)) / RAD, d]; };
  const quasiV = segments.filter((s) => ecartPF(s, pfV0) < 20 && s.l >= 20);
  const fv = pointFuite(quasiV, { W, H, tolerance: 1.2, alea, accepter: (vp) => angleCam(vp, dirV0)[0] < inclinaisonMax });
  let dv = dirV0, inclinaison = 0;
  if (fv && fv.n >= 6) {
    const [a, d] = angleCam(fv.v, dirV0);
    dv = d; inclinaison = a;
    res.etapes.verticale = { n: fv.n, part: fv.part, residu: fv.residu, ecartNominal: a };
  } else notes.push('verticales : trop peu de segments, inclinaison nominale gardée');
  // 2. point de fuite des horizontales de la façade (zone prédite élargie)
  const dirH0 = (() => { let d = unit(directionPixel(nominale, pfDirection(nominale, U))); return d; })();
  // a priori : direction horizontale nominale orthogonalisée par rapport à la verticale trouvée
  let dh = unit(sub(dirH0, dv.map((v) => v * dot(dirH0, dv))));
  const coinsPred = [[gx, y0 + He, gz], [dx, y0 + He, dz], [dx, y0, dz], [gx, y0, gz]].map((X) => projeter(nominale, X));
  let zoneOk = coinsPred.every(Boolean);
  if (zoneOk) {
    const xs = coinsPred.map((p) => p[0]), ys = coinsPred.map((p) => p[1]);
    const mx = 0.25 * (Math.max(...xs) - Math.min(...xs)), my = 0.1 * (Math.max(...ys) - Math.min(...ys));
    const zone = [Math.min(...xs) - mx, Math.min(...ys) - my, Math.max(...xs) + mx, Math.max(...ys) + my];
    const pfH0 = (() => { const c = dh; return [nominale.fpx * c[0] + (W / 2) * c[2], -nominale.fpx * c[1] + (H / 2) * c[2], c[2]]; })();
    const quasiH = segments.filter((s) => s.cx > zone[0] && s.cx < zone[2] && s.cy > zone[1] && s.cy < zone[3] && ecartPF(s, pfH0) < 12 && s.l >= 15);
    const accepterH = (vp) => {
      let d = unit(directionPixel(nominale, vp));
      if (dot(d, dh) < 0) d = d.map((x) => -x);
      return Math.abs(90 - Math.acos(clamp(dot(d, dv), -1, 1)) / RAD) < 3 && Math.acos(clamp(dot(d, dh), -1, 1)) / RAD < lacetMax;
    };
    const fh = pointFuite(quasiH, { W, H, tolerance: 1.2, alea, accepter: accepterH });
    if (fh && fh.n >= 6) {
      let d = unit(directionPixel(nominale, fh.v));
      if (dot(d, dh) < 0) d = d.map((x) => -x);
      res.etapes.horizontale = { n: fh.n, part: fh.part, residu: fh.residu, orthogonalite: Math.abs(90 - Math.acos(clamp(dot(d, dv), -1, 1)) / RAD), ecartNominal: Math.acos(clamp(dot(d, dh), -1, 1)) / RAD };
      dh = d;
    } else notes.push('horizontales de la façade : trop peu de segments, lacet tiré de l\'azimut de la photo');
  }
  const M = rotationDepuisDirections(dv, dh, U, det);
  res.etapes.rotation = { ecartNominal: ecartRotation(M, nominale.M), inclinaison };
  const pose0 = { ...nominale, M };
  // position de départ : GPS ; hauteur a priori
  const P0 = [nominale.P[0], sol(nominale.P[0], nominale.P[2]) + hCam, nominale.P[2]];
  pose0.P = P0;
  // 3. arêtes gauche et droite
  const proj = (X, p = pose0) => projeter(p, X);
  const pm = [proj([gx, y0 + He / 2, gz]), proj([dx, y0 + He / 2, dz])];
  const pt = [proj([gx, y0 + He, gz]), proj([dx, y0 + He, dz])], pb = [proj([gx, y0, gz]), proj([dx, y0, dz])];
  if (!pm.every(Boolean) || !pt.every(Boolean) || !pb.every(Boolean)) { notes.push('façade derrière la caméra : placement impossible'); return fin(res, pose0, { manuel: true }); }
  const pfV = pfDirection(pose0, [0, 1, 0]);
  const depth = (X) => Math.max(2, versCamera(pose0, X)[2]);
  const dG = depth([gx, y0 + He / 2, gz]), dD = depth([dx, y0 + He / 2, dz]);
  const pxm = (d) => nominale.fpx / d; // px par mètre à la profondeur d
  // Profil d'arête E(x) : contraste de signe constant le long de la verticale (par le point de fuite) qui coupe la ligne de
  // référence en x, sur la bande 20 %-85 % de la hauteur prédite du mur (rez-de-chaussée encombré, corniche exclus)
  const dMoy = (dG + dD) / 2;
  const yHaut = Math.max(2, Math.min(pt[0][1], pt[1][1])), yBas = Math.min(H - 3, Math.max(pb[0][1], pb[1][1]));
  const yA = yHaut + 0.2 * (yBas - yHaut), yB = yHaut + 0.85 * (yBas - yHaut), yRef = (yA + yB) / 2;
  if (!(yB - yA > 20)) { notes.push('mur hors de la vue (hauteur)'); return fin(res, pose0, { manuel: true }); }
  const ec = clamp(0.3 * pxm(dMoy), 3, 10);
  const E = new Float32Array(W);
  for (let x = 2; x < W - 2; x++) E[x] = profilVertical(G, pfV, x, yRef, yA, yB, 3, ec).c;
  let Emax = 1e-6; for (let x = 0; x < W; x++) if (E[x] > Emax) Emax = E[x];
  // profils dilatés (maximum glissant) : le pic d'une arête est étroit (quelques px) ; recherche grossière avec un rayon
  // égal au déplacement d'arête produit par un pas de grille (0,25 m), fine avec 2 px
  const dilater = (r) => { const o = new Float32Array(W); for (let x = 0; x < W; x++) { let m = 0; for (let k = Math.max(0, x - r); k <= Math.min(W - 1, x + r); k++) if (E[k] > m) m = E[k]; o[x] = m / Emax; } return o; };
  const Egros = dilater(Math.max(2, Math.ceil(0.25 * pxm(dMoy) * 0.6))), Efin = dilater(2);
  let Ecour = Egros;
  const Ei = (x) => { if (!(x >= 2 && x < W - 3)) return null; const i = x | 0, f = x - i; return Ecour[i] * (1 - f) + Ecour[i + 1] * f; };
  // arêtes verticales du modèle : sommets de l'emprise (ou seulement les deux extrémités du mur)
  const anneau = (facade.emprise?.length >= 3 ? facade.emprise : null);
  const proche = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.3;
  const sommets = anneau ? anneau.map((p, i) => ({ p, prec: anneau[(i - 1 + anneau.length) % anneau.length], suiv: anneau[(i + 1) % anneau.length], cible: proche(p, facade.gauche) || proche(p, facade.droite) })) : [];
  if (!sommets.some((v) => proche(v.p, facade.gauche))) sommets.push({ p: facade.gauche, cible: true });
  if (!sommets.some((v) => proche(v.p, facade.droite))) sommets.push({ p: facade.droite, cible: true });
  const cx0 = anneau ? anneau.reduce((t, q) => t + q[0], 0) / anneau.length : 0, cz0 = anneau ? anneau.reduce((t, q) => t + q[1], 0) / anneau.length : 0;
  const tourne = (a2, b2, P) => { // mur a2-b2 tourné vers P (normale vers l'extérieur de l'anneau)
    let nx = b2[1] - a2[1], nz = -(b2[0] - a2[0]);
    const mx = (a2[0] + b2[0]) / 2, mz = (a2[1] + b2[1]) / 2;
    if ((mx - cx0) * nx + (mz - cz0) * nz < 0) { nx = -nx; nz = -nz; }
    return (P[0] - mx) * nx + (P[2] - mz) * nz > 0;
  };
  const Mn = [(gx + dx) / 2, (gz + dz) / 2];
  const nF = [-U[2], U[0]];
  const sNF = Math.sign((nominale.P[0] - Mn[0]) * nF[0] + (nominale.P[2] - Mn[1]) * nF[1]) || 1;
  const xRef = (P, q) => { const pp = projeter({ ...pose0, P }, [q[0], y0 + He / 2, q[1]]); return pp ? xSurVerticale(pfV, pp[0], pp[1], yRef) : null; };
  const evaluer = (x, z) => {
    if (((x - Mn[0]) * nF[0] + (z - Mn[1]) * nF[1]) * sNF < 1) return null;
    const P = [x, P0[1], z];
    let s = 0;
    for (const v of sommets) {
      if (v.prec && !tourne(v.prec, v.p, P) && !tourne(v.p, v.suiv, P)) continue; // arête cachée
      const xr = xRef(P, v.p);
      if (xr == null) { if (v.cible) return null; continue; }
      const e = Ei(xr);
      if (e == null) { if (v.cible) s -= 0.5; continue; }
      s += (v.cible ? 1 : 0.6) * (e - 0.25);
    }
    const d = Math.hypot(x - nominale.P[0], z - nominale.P[2]);
    return s - 0.5 * (d / sigmaGPS) ** 2;
  };
  const Rg = rechercheGPS * 1.3;
  const essais = [];
  for (let ix = -Rg; ix <= Rg + 1e-9; ix += 0.25) for (let iz = -Rg; iz <= Rg + 1e-9; iz += 0.25) {
    if (ix * ix + iz * iz > Rg * Rg) continue;
    const x = nominale.P[0] + ix, z = nominale.P[2] + iz, s = evaluer(x, z);
    if (s != null) essais.push({ x, z, s });
  }
  if (!essais.length) { notes.push('aucune position de caméra plausible (façade hors de la vue)'); return fin(res, pose0, { manuel: true }); }
  essais.sort((p, q) => q.s - p.s);
  // affinage des 30 meilleures positions éloignées de plus de 0,75 m (profil fin), puis, pour chacune, hauteur de prise de
  // vue : la corniche (égout du modèle) et le pied du mur doivent tomber sur une arête horizontale (± plageH autour de
  // l'a priori) ; une position fausse change l'échelle et déplace la corniche. Score total = arêtes + corniche + pied.
  Ecour = Efin;
  const departs = [];
  for (const e of essais) { if (departs.length >= 30) break; if (departs.every((d) => Math.hypot(d.x - e.x, d.z - e.z) > 0.75)) departs.push(e); }
  const ecH = clamp(0.25 * pxm(dMoy), 3, 10);
  const lignesH = (x, z, hc) => {
    const p = { ...pose0, P: [x, sol(x, z) + hc, z] };
    return [projeter(p, [gx, y0 + He, gz]), projeter(p, [dx, y0 + He, dz]), projeter(p, [gx, y0, gz]), projeter(p, [dx, y0, dz])];
  };
  const hs = [];
  for (let hc = hCam - plageH; hc <= hCam + plageH + 1e-9; hc += 0.02) hs.push(hc);
  let maxT = 1e-6, maxB = 1e-6;
  const candidats = departs.map((d0) => {
    let bb = { x: d0.x, z: d0.z, s: evaluer(d0.x, d0.z) ?? -1e9 };
    for (let ix = -0.3; ix <= 0.3 + 1e-9; ix += 0.05) for (let iz = -0.3; iz <= 0.3 + 1e-9; iz += 0.05) {
      const sc = evaluer(d0.x + ix, d0.z + iz);
      if (sc != null && sc > bb.s) bb = { x: d0.x + ix, z: d0.z + iz, s: sc };
    }
    bb.vT = []; bb.vB = [];
    for (const hc of hs) {
      const [A, B, C2, D2] = lignesH(bb.x, bb.z, hc);
      const t = A && B ? profilSegment(G, A, B, 2, ecH).c : 0, u = C2 && D2 ? profilSegment(G, C2, D2, 2, ecH).c : 0;
      bb.vT.push(t); bb.vB.push(u);
      if (t > maxT) maxT = t; if (u > maxB) maxB = u;
    }
    return bb;
  });
  for (const c of candidats) {
    c.tot = hs.map((hc, i) => c.vT[i] / maxT + 0.3 * (c.vB[i] / maxB) - 0.5 * ((hc - hCam) / 0.4) ** 2);
    c.iH = c.tot.reduce((k, v, i) => (v > c.tot[k] ? i : k), 0);
    c.total = c.s + c.tot[c.iH];
  }
  candidats.sort((p, q) => q.total - p.total);
  const best = candidats[0];
  const sec = candidats.find((q) => Math.hypot(q.x - best.x, q.z - best.z) > 1.0);
  // localisation fine : gradient perpendiculaire moyen Gp(x) le long des mêmes verticales ; la position (pas de 2 cm, ± 0,3 m)
  // maximise la somme des gradients aux arêtes qui ont du contraste à la position retenue (les arêtes muettes ne guident pas)
  const Gp = new Float32Array(W);
  let gMax = 1e-6;
  for (let x = 2; x < W - 2; x++) { Gp[x] = profilVertical(G, pfV, x, yRef, yA, yB, 3, ec).g; if (Gp[x] > gMax) gMax = Gp[x]; }
  const Gi = (x) => { if (!(x >= 2 && x < W - 3)) return 0; const i = x | 0, f = x - i; return (Gp[i] * (1 - f) + Gp[i + 1] * f) / gMax; };
  const P_ = (x, z) => [x, P0[1], z];
  const guides = sommets.filter((v) => {
    if (v.prec && !tourne(v.prec, v.p, P_(best.x, best.z)) && !tourne(v.p, v.suiv, P_(best.x, best.z))) return false;
    const xr = xRef(P_(best.x, best.z), v.p);
    return xr != null && (Ei(xr) ?? 0) >= 0.3;
  });
  let xz = [best.x, best.z];
  if (guides.length >= 1) {
    let sb = -1e9;
    for (let ix = -0.3; ix <= 0.3 + 1e-9; ix += 0.02) for (let iz = -0.3; iz <= 0.3 + 1e-9; iz += 0.02) {
      let sg = -0.5 * (ix * ix + iz * iz); // rappel faible vers la position retenue (une seule arête ne fixe qu'une direction)
      for (const v of guides) { const xr = xRef(P_(best.x + ix, best.z + iz), v.p); sg += xr == null ? 0 : (v.cible ? 1 : 0.6) * Gi(xr); }
      if (sg > sb) { sb = sg; xz = [best.x + ix, best.z + iz]; }
    }
  }
  const bord = (q) => {
    const x0 = xRef(P_(xz[0], xz[1]), q);
    const i = clamp(Math.round(x0), 2, W - 3);
    return { x: x0, ratio: Ei(x0) ?? 0, demi: demiLargeur(Array.from(E.subarray(Math.max(0, i - 40), i + 41)), Math.min(i, 40), 0), prominence: 9 };
  };
  const a = bord(facade.gauche), b = bord(facade.droite);
  res.etapes.guides = guides.length;
  const C = { a, b, xz, ecartGPS: Math.hypot(xz[0] - nominale.P[0], xz[1] - nominale.P[2]), s: best.total };
  res.etapes.couple = { gauche: a, droite: b, ecartGPS: C.ecartGPS, marge: sec ? best.total - sec.total : 9, n: essais.length, aretes: sommets.length, scoreAretes: best.s };
  if (facade.debug) res.profil = { E: Array.from(Efin), yA, yB, yRef, best, essais: candidats.slice(0, 5).map((c) => ({ x: c.x, z: c.z, s: c.total })), evaluer, xRef: (x, z, q) => xRef([x, P0[1], z], q), sommets };
  // hauteur : localisation fine sur la corniche (gradient perpendiculaire) à ± 0,06 m
  const iB = best.iH;
  let hc = hs[iB], gB = -1;
  for (let h2 = hs[iB] - 0.06; h2 <= hs[iB] + 0.06 + 1e-9; h2 += 0.01) { const [A, B] = lignesH(xz[0], xz[1], h2); const g = A && B ? profilSegment(G, A, B, 1, ecH).g : 0; if (g > gB) { gB = g; hc = h2; } }
  const vT = best.vT, ratioT = vT[iB] / maxT;
  // proéminence de la corniche : meilleur contraste / meilleur contraste à plus de 0,5 m
  const autre = Math.max(1e-6, ...vT.filter((v, i) => Math.abs(hs[i] - hs[iB]) > 0.5));
  const promT = vT[iB] / autre;
  const demiT = demiLargeur(best.tot, iB, Math.min(...best.tot)) * 0.02;
  res.etapes.hauteur = { hCam: hc, ratioCorniche: ratioT, proeminence: promT, ratioPied: best.vB[iB] / maxB, bord: iB === 0 || iB === hs.length - 1, demiLargeur_m: demiT };
  const pose = { ...pose0, P: [xz[0], sol(xz[0], xz[1]) + hc, xz[1]] };
  return fin(res, pose, { C, sec, ratioT: promT, demiT, dG, dD, pxm });

  function fin(r, p, info = {}) {
    r.pose = p;
    const hauts = facade.hauts;
    r.coins = {};
    for (const [k, h] of Object.entries(hauts)) if (Number.isFinite(h)) r.coins[k] = [[gx, y0 + h, gz], [dx, y0 + h, dz], [dx, y0, dz], [gx, y0, gz]].map((X) => projeter(p, X));
    if (info.manuel) { r.confiance = 'manuel'; r.erreur_m = null; return r; }
    const e = r.etapes;
    // erreur interne : localisation des arêtes (demi-largeur du pic, ≥ 1 px) et de la corniche, en mètres sur le mur
    const eL = Math.max(1, info.C.a.demi * 0.5) / info.pxm(info.dG), eR = Math.max(1, info.C.b.demi * 0.5) / info.pxm(info.dD);
    r.erreur_m = Math.round(Math.max(eL, eR, info.demiT * 0.5, 0.05) * 100) / 100;
    const bonV = e.verticale && e.verticale.n >= 10;
    const bonH = e.horizontale && e.horizontale.orthogonalite < 2;
    const bonsCotes = info.C.a.ratio >= 0.5 && info.C.b.ratio >= 0.5;
    const unique = e.couple.marge >= 0.25;
    const bonHaut = info.ratioT >= 1.15 && !e.hauteur.bord;
    const proche = info.C.ecartGPS <= 6;
    const raisons = [];
    if (!bonV) raisons.push('verticales peu sûres');
    if (!bonH) raisons.push('horizontales de la façade peu sûres');
    if (!bonsCotes) raisons.push('arête du mur peu marquée');
    if (!unique) raisons.push('deux positions d\'arêtes possibles');
    if (!bonHaut) raisons.push('corniche peu marquée (hauteur de prise de vue a priori)');
    if (!proche) raisons.push(`caméra déplacée de ${Math.round(info.C.ecartGPS)} m par rapport au GPS`);
    r.raisons = raisons;
    r.confiance = !raisons.length ? 'bon' : !bonsCotes && !unique ? 'manuel' : 'a-verifier';
    return r;
  }
}

// ------------------------------------------------------------------ qualité d'une image redressée (critères de choix)
// img : façade redressée { data, width, height } à pxm px/m, bas de l'image = sol ; hors : masque (Uint8) des pixels hors
// de la photo (gris neutre) ou null. Retour : { vegetation, encombrement (bande 0-4 m), masque (part estimée), nettete }
export function qualiteFacade(img, pxm, hors = null) {
  const { data, width: W, height: H } = img;
  let vert = 0, n = 0, bas = 0, nb = 0, dehors = 0;
  const yBas = H - Math.min(H, Math.round(4 * pxm));
  const g = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4;
    const r = data[o], v = data[o + 1], b = data[o + 2];
    g[i] = 0.299 * r + 0.587 * v + 0.114 * b;
    if (hors && hors[i]) { dehors++; continue; }
    n++;
    const mx = Math.max(r, v, b), mn = Math.min(r, v, b);
    const estVert = v > r + 6 && v > b + 4 && mx - mn > 14;
    if (estVert) vert++;
    if (y >= yBas) {
      nb++;
      const sat = mx ? (mx - mn) / mx : 0;
      if (estVert || g[i] < 50 || sat > 0.42) bas++;
    }
  }
  // netteté : écart type du laplacien rapporté à l'écart type de l'image
  let sl = 0, sl2 = 0, sg = 0, sg2 = 0, k = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x;
    if (hors && hors[i]) continue;
    const l = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - W] - g[i + W];
    sl += l; sl2 += l * l; sg += g[i]; sg2 += g[i] * g[i]; k++;
  }
  const sdl = k ? Math.sqrt(Math.max(0, sl2 / k - (sl / k) ** 2)) : 0, sdg = k ? Math.sqrt(Math.max(0, sg2 / k - (sg / k) ** 2)) : 1;
  const vegetation = n ? vert / n : 1, encombrement = nb ? bas / nb : 1;
  const partBas = Math.min(1, (H - yBas) / H);
  return {
    vegetation, encombrement, hors: (W * H) ? dehors / (W * H) : 1,
    masque: Math.min(1, vegetation + encombrement * partBas * (1 - vegetation)),
    nettete: sdl / (sdg + 8),
  };
}

// ------------------------------------------------------------------ caméras nominales, vues, redressement
const direction = (az, el = 0) => [Math.cos(el * RAD) * Math.sin(az * RAD), Math.sin(el * RAD), -Math.cos(el * RAD) * Math.cos(az * RAD)];
const azimutVers = (dx, dz) => ((Math.atan2(dx, -dz) / RAD) + 360) % 360;
// même modèle que camera() de js/redressement-facades.js, au format pose
export function poseNominale({ P, yaw, pitch = 0, fov, W, H }) {
  const f = direction(yaw, pitch);
  const r = [Math.cos(yaw * RAD), 0, Math.sin(yaw * RAD)];
  const u = cross(r, f);
  return { P: [...P], M: [r, u, f], fpx: (W / 2) / Math.tan((fov * RAD) / 2), W, H, yaw, pitch, fov };
}
// vue d'analyse tirée d'un panorama : visée sur le milieu des points, champ couvrant les points (+ marge), fpx ≤ fpxMax
export function vueAnalyse(P, pts, { fpxMax = 700, marge = 1.1, fovMax = 125, ratioMax = 1.6 } = {}) {
  const m = [0, 1, 2].map((k) => pts.reduce((s, c) => s + c[k], 0) / pts.length);
  const v = sub(m, P);
  const yaw = azimutVers(v[0], v[2]);
  const pitch = clamp(Math.atan2(v[1], Math.hypot(v[0], v[2])) / RAD, -10, 45);
  const c0 = poseNominale({ P, yaw, pitch, fov: 90, W: 1000, H: 1000 });
  let th = 0.3, tv = 0.3;
  for (const X of pts) {
    const c = versCamera(c0, X);
    const cf = Math.max(c[2], 0.05);
    th = Math.max(th, Math.abs(c[0]) / cf); tv = Math.max(tv, Math.abs(c[1]) / cf);
  }
  th *= marge; tv *= marge;
  const fov = Math.min(fovMax, Math.max(40, (2 * Math.atan(th)) / RAD));
  const tanH = Math.tan((fov * RAD) / 2);
  const W = Math.round(2 * tanH * fpxMax);
  const Hp = Math.round(clamp((W * tv) / tanH, 0.4 * W, ratioMax * W));
  return { yaw, pitch, fov, W, H: Hp };
}
const lireBil = (src, x, y, out, o, wrap) => {
  const W = src.width, Hh = src.height, d = src.data;
  if (!wrap && (x < -0.5 || y < -0.5 || x > W - 0.5 || y > Hh - 0.5)) { out[o] = out[o + 1] = out[o + 2] = 200; out[o + 3] = 255; return false; }
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const cy = (v) => (v < 0 ? 0 : v >= Hh ? Hh - 1 : v);
  const cx = wrap ? (v) => ((v % W) + W) % W : (v) => (v < 0 ? 0 : v >= W ? W - 1 : v);
  const a = (cy(y0) * W + cx(x0)) * 4, b = (cy(y0) * W + cx(x0 + 1)) * 4, c = (cy(y0 + 1) * W + cx(x0)) * 4, e = (cy(y0 + 1) * W + cx(x0 + 1)) * 4;
  for (let k = 0; k < 3; k++) out[o + k] = (d[a + k] * (1 - fx) + d[b + k] * fx) * (1 - fy) + (d[c + k] * (1 - fx) + d[e + k] * fx) * fy;
  out[o + 3] = 255;
  return true;
};
const pixelEqui = (d, az0, We, He) => {
  const A = Math.atan2(d[0], -d[2]) / RAD, E = Math.asin(clamp(d[1] / (Math.hypot(d[0], d[1], d[2]) || 1), -1, 1)) / RAD;
  return [((((A - az0) / 360 + 0.5) % 1) + 1) % 1 * We - 0.5, (0.5 - E / 180) * He - 0.5];
};
// vue perspective (pose nominale) tirée d'un panorama équirectangulaire dont le centre regarde vers az0
export function rendreVue(equi, az0, pose) {
  const { W, H, fpx, M } = pose;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    const b = H / 2 - (j + 0.5);
    for (let i = 0; i < W; i++) {
      const a = i + 0.5 - W / 2;
      const d = [M[0][0] * a + M[1][0] * b + M[2][0] * fpx, M[0][1] * a + M[1][1] * b + M[2][1] * fpx, M[0][2] * a + M[1][2] * b + M[2][2] * fpx];
      const [x, y] = pixelEqui(d, az0, equi.width, equi.height);
      lireBil(equi, x, y, out, (j * W + i) * 4, true);
    }
  }
  return { data: out, width: W, height: H };
}
// Façade redressée W × H px, du sol (bas) au niveau « haut » (m) : chaque pixel est un point du mur projeté par la pose
// trouvée. Source : panorama (equi + az0 + pose nominale de la vue analysée : direction réelle = Mnomᵀ Mpose (X − P),
// valable même hors de la vue) ou image plane (src, coordonnées de la vue analysée × echelle).
// decalageHaut (m) : réglage fin de la corniche (le haut du rectangle suit la photo, l'image reste à la cote du modèle).
export function redresserPose({ equi = null, az0 = 0, src = null, echelle = 1, nominale, pose, gauche, droite, sol, haut, decalageHaut = 0, W, H }) {
  const out = new Uint8ClampedArray(W * H * 4);
  const hors = new Uint8Array(W * H);
  const L = Math.hypot(droite[0] - gauche[0], droite[1] - gauche[1]);
  const ux = (droite[0] - gauche[0]) / L, uz = (droite[1] - gauche[1]) / L;
  const k = (haut + decalageHaut) / haut; // hauteur photo par mètre de modèle
  const Mn = nominale.M, Mp = pose.M, P = pose.P;
  for (let j = 0; j < H; j++) {
    const yM = haut * (1 - (j + 0.5) / H); // cote du modèle
    const y = sol + yM * k;
    for (let i = 0; i < W; i++) {
      const s = ((i + 0.5) / W) * L;
      const X = [gauche[0] + ux * s, y, gauche[1] + uz * s];
      const v = [X[0] - P[0], X[1] - P[1], X[2] - P[2]];
      const c = [dot(Mp[0], v), dot(Mp[1], v), dot(Mp[2], v)];
      const o = (j * W + i) * 4;
      let ok;
      if (equi) {
        const d = [Mn[0][0] * c[0] + Mn[1][0] * c[1] + Mn[2][0] * c[2], Mn[0][1] * c[0] + Mn[1][1] * c[1] + Mn[2][1] * c[2], Mn[0][2] * c[0] + Mn[1][2] * c[1] + Mn[2][2] * c[2]];
        const [px, py] = pixelEqui(d, az0, equi.width, equi.height);
        ok = lireBil(equi, px, py, out, o, true);
      } else if (c[2] > 1e-6) {
        const px = (pose.W / 2 + (pose.fpx * c[0]) / c[2]) * echelle - 0.5, py = (pose.H / 2 - (pose.fpx * c[1]) / c[2]) * echelle - 0.5;
        ok = lireBil(src, px, py, out, o, false);
      } else { out[o] = out[o + 1] = out[o + 2] = 200; out[o + 3] = 255; ok = false; }
      if (!ok) hors[j * W + i] = 1;
    }
  }
  return { data: out, width: W, height: H, hors };
}
// pixel d'un point du monde dans un panorama (pose de la vue analysée, centre az0) : pour la trace « coins » du fichier
export function pixelPanorama(X, { nominale, pose, az0, We, He }) {
  const c = versCamera(pose, X), Mn = nominale.M;
  const d = [Mn[0][0] * c[0] + Mn[1][0] * c[1] + Mn[2][0] * c[2], Mn[0][1] * c[0] + Mn[1][1] * c[1] + Mn[2][1] * c[2], Mn[0][2] * c[0] + Mn[1][2] * c[1] + Mn[2][2] * c[2]];
  const [x, y] = pixelEqui(d, az0, We, He);
  return [x + 0.5, y + 0.5];
}
