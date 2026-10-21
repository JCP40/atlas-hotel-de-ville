// Calcul simplifié du vent autour du bâti (2D, à hauteur de piéton), sans Three.js.
// Repris de la page « Vent autour de l'Hôtel de Ville de Nantes » : ce n'est pas un calcul de mécanique des fluides,
// mais un écoulement potentiel qui contourne les bâtiments, plafonné, avec un sillage estimé sous le vent.
// - grille de N × N cellules de H mètres, centrée sur le centre du projet (±336 m) ;
// - le bâti est inscrit dans la grille (cellules pleines, hauteur) ;
// - champ uniforme, puis équation de Poisson (Jacobi, 350 itérations) et projection : le vent contourne les obstacles ;
// - plafond à 2,5 fois le vent libre, ralentissement derrière les bâtiments (sillage d'environ 6 fois leur hauteur).
// Repère du calcul : x vers l'est, y vers le NORD, en mètres (comme la page d'origine).
// Le repère de l'atlas a z vers le sud : y = -z (conversions versCalcul / versAtlas ci-dessous).

export const N = 192; // cellules par côté
export const H = 3.5; // taille d'une cellule (m)
export const HALF = (N * H) / 2; // demi-emprise (m)

export const versCalcul = ([x, z]) => [x, -z];
export const versAtlas = ([x, y]) => [x, -y];

// Phénomènes aérodynamiques repérés autour des bâtiments (classement usuel du CSTB)
export const TYPES_EFFETS = [
  { t: 1, nom: 'Rouleau tourbillonnaire', desc: 'Au pied de la face au vent', couleur: '#e8590c' },
  { t: 2, nom: 'Survitesses de coin', desc: 'À proximité des coins de la face au vent', couleur: '#e03131' },
  { t: 3, nom: 'Déviation en vrille', desc: 'Franchissement oblique d\'une barre', couleur: '#ae3ec9' },
  { t: 4, nom: 'Sillage', desc: 'À l\'arrière du bâtiment', couleur: '#1c7ed6' },
  { t: 5, nom: 'Passage sous bâtiment', desc: 'Survitesses et prolongements immédiats', couleur: '#e67700' },
  { t: 6, nom: 'Effet Venturi', desc: 'Étranglement d\'un angle ouvert au vent', couleur: '#c2255c' },
  { t: 7, nom: 'Effet Wise', desc: 'Rouleau accentué par un bâtiment plus bas en amont', couleur: '#5f3dc4' },
  { t: 8, nom: 'Pressions différentes', desc: 'Bâtiments en quinconce', couleur: '#2f9e44' },
];

// ------------------------------------------------------------------
// Bâti du calcul : anneaux en repère du calcul, fermés, extérieur dans le sens trigonométrique
// ------------------------------------------------------------------

// empreintes : [{ polys: [[ext, ...trous], ...] en repère atlas [x, z] (anneaux non fermés), hauteur }]
export function preparerBatiments(empreintes) {
  const res = [];
  for (const e of empreintes) {
    for (const [ext, ...trous] of e.polys) {
      if (!ext || ext.length < 3) continue;
      const fermer = (a) => { const r = a.map(versCalcul); r.push([...r[0]]); return r; };
      const ring = fermer(ext);
      let aire = 0, sx = 0, sy = 0;
      const n = ring.length - 1;
      for (let i = 0; i < n; i++) {
        const p = ring[i], q = ring[i + 1];
        aire += p[0] * q[1] - q[0] * p[1];
        sx += p[0]; sy += p[1];
      }
      if (aire < 0) ring.reverse(); // sens trigonométrique : la normale sortante est à droite de l'arête
      const b = { r: [ring, ...trous.filter((t) => t.length >= 3).map(fermer)], h: e.hauteur, cx: sx / n, cy: sy / n };
      preparerArretes(b);
      res.push(b);
    }
  }
  return res;
}

// arêtes, normales sortantes et rectangle englobant d'aire minimale (longueur, largeur, axe)
function preparerArretes(b) {
  const ring = b.r[0], n = ring.length - 1;
  b.edges = [];
  for (let i = 0; i < n; i++) {
    const p = ring[i], q = ring[i + 1], dx = q[0] - p[0], dy = q[1] - p[1], len = Math.hypot(dx, dy);
    if (len < 0.5) continue;
    b.edges.push({ x0: p[0], y0: p[1], x1: q[0], y1: q[1], nx: dy / len, ny: -dx / len, tx: dx / len, ty: dy / len, len });
  }
  let best = null;
  for (let a = 0; a < 180; a += 5) {
    const ca = Math.cos((a * Math.PI) / 180), sa = Math.sin((a * Math.PI) / 180);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9;
    for (let i = 0; i < n; i++) {
      const u = ring[i][0] * ca + ring[i][1] * sa, v = -ring[i][0] * sa + ring[i][1] * ca;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const aire = (u1 - u0) * (v1 - v0);
    if (!best || aire < best.aire) best = { aire, a, du: u1 - u0, dv: v1 - v0 };
  }
  const long1 = best.du >= best.dv;
  b.L = Math.max(best.du, best.dv);
  b.W = Math.min(best.du, best.dv);
  const ang = ((best.a + (long1 ? 0 : 90)) * Math.PI) / 180;
  b.ax = Math.cos(ang);
  b.ay = Math.sin(ang);
}

// ------------------------------------------------------------------
// Grille du bâti (partagée entre plusieurs solveurs)
// ------------------------------------------------------------------

export function creerGrille(batiments) {
  const solid = new Uint8Array(N * N);
  const hgt = new Float32Array(N * N);
  const dt = new Float32Array(N * N); // distance au bâtiment le plus proche (m)

  // rastérisation d'un polygone à trous (règle pair-impair)
  function remplir(rings, h) {
    let minY = Infinity, maxY = -Infinity;
    const gr = rings.map((ring) => ring.map((p) => {
      const gx = (p[0] + HALF) / H, gy = (p[1] + HALF) / H;
      minY = Math.min(minY, gy); maxY = Math.max(maxY, gy);
      return [gx, gy];
    }));
    const j0 = Math.max(0, Math.floor(minY)), j1 = Math.min(N - 1, Math.ceil(maxY));
    for (let j = j0; j <= j1; j++) {
      const yc = j + 0.5, xs = [];
      for (const ring of gr) {
        for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
          const y0 = ring[b][1], y1 = ring[a][1];
          if ((y0 <= yc) !== (y1 <= yc)) xs.push(ring[b][0] + ((yc - y0) * (ring[a][0] - ring[b][0])) / (y1 - y0));
        }
      }
      xs.sort((p, q) => p - q);
      for (let s = 0; s + 1 < xs.length; s += 2) {
        const i0 = Math.max(0, Math.ceil(xs[s] - 0.5)), i1 = Math.min(N - 1, Math.floor(xs[s + 1] - 0.5));
        for (let i = i0; i <= i1; i++) {
          const k = j * N + i;
          solid[k] = 1;
          if (h > hgt[k]) hgt[k] = h;
        }
      }
    }
  }
  for (const b of batiments) remplir(b.r, b.h);

  // transformée de distance (chanfrein 1 / √2), en mètres
  const INF = 1e6, d1 = 1, d2 = Math.SQRT2;
  for (let k = 0; k < N * N; k++) dt[k] = solid[k] ? 0 : INF;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const k = j * N + i;
    let v = dt[k];
    if (i > 0) v = Math.min(v, dt[k - 1] + d1);
    if (j > 0) v = Math.min(v, dt[k - N] + d1);
    if (i > 0 && j > 0) v = Math.min(v, dt[k - N - 1] + d2);
    if (i < N - 1 && j > 0) v = Math.min(v, dt[k - N + 1] + d2);
    dt[k] = v;
  }
  for (let j = N - 1; j >= 0; j--) for (let i = N - 1; i >= 0; i--) {
    const k = j * N + i;
    let w = dt[k];
    if (i < N - 1) w = Math.min(w, dt[k + 1] + d1);
    if (j < N - 1) w = Math.min(w, dt[k + N] + d1);
    if (i < N - 1 && j < N - 1) w = Math.min(w, dt[k + N + 1] + d2);
    if (i > 0 && j < N - 1) w = Math.min(w, dt[k + N - 1] + d2);
    dt[k] = w;
  }
  for (let k = 0; k < N * N; k++) dt[k] *= H;

  const indice = (x, y) => {
    const i = Math.floor((x + HALF) / H), j = Math.floor((y + HALF) / H);
    return i < 0 || j < 0 || i >= N || j >= N ? -1 : j * N + i;
  };
  return {
    solid, hgt, dt, batiments, indice,
    estPlein(x, y) { const k = indice(x, y); return k < 0 || solid[k] === 1; },
    hauteur(x, y) { const k = indice(x, y); return k < 0 ? 1e3 : (solid[k] ? hgt[k] : 0); },
  };
}

// ------------------------------------------------------------------
// Solveur : champ de vent pour une direction (d'où vient le vent, degrés depuis le nord) et une vitesse (m/s)
// ------------------------------------------------------------------

export function creerSolveur(grille) {
  const { solid, hgt } = grille;
  const U = new Float32Array(N * N); // composante est
  const V = new Float32Array(N * N); // composante nord
  const D = new Float32Array(N * N);
  const PA = new Float32Array(N * N);
  const PB = new Float32Array(N * N);
  const etat = { direction: null, vitesse: null };

  function resoudre(direction, vitesse) {
    const th = (direction * Math.PI) / 180;
    const u0 = -vitesse * Math.sin(th), v0 = -vitesse * Math.cos(th);
    const n = N * N;
    for (let k = 0; k < n; k++) {
      if (solid[k]) { U[k] = 0; V[k] = 0; } else { U[k] = u0; V[k] = v0; }
    }
    // divergence du champ uniforme tronqué par les bâtiments
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        D[k] = solid[k] ? 0 : (U[k + 1] - U[k - 1] + V[k + N] - V[k - N]) / (2 * H);
      }
    }
    PA.fill(0); PB.fill(0);
    let a = PA, b = PB;
    const hh = H * H;
    for (let it = 0; it < 350; it++) {
      for (let j = 1; j < N - 1; j++) {
        for (let i = 1; i < N - 1; i++) {
          const k = j * N + i;
          if (solid[k]) { b[k] = a[k]; continue; }
          const pl = solid[k - 1] ? a[k] : a[k - 1];
          const pr = solid[k + 1] ? a[k] : a[k + 1];
          const pd = solid[k - N] ? a[k] : a[k - N];
          const pu = solid[k + N] ? a[k] : a[k + N];
          b[k] = (pl + pr + pd + pu - D[k] * hh) * 0.25;
        }
      }
      for (let i = 0; i < N; i++) { b[i] = b[i + N]; b[(N - 1) * N + i] = b[(N - 2) * N + i]; }
      for (let j = 0; j < N; j++) { b[j * N] = b[j * N + 1]; b[j * N + N - 1] = b[j * N + N - 2]; }
      const t = a; a = b; b = t;
    }
    // projection : on retire le gradient de pression, vitesse plafonnée à 2,5 fois le vent libre
    const cap = vitesse * 2.5;
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (solid[k]) continue;
        const pl = solid[k - 1] ? a[k] : a[k - 1];
        const pr = solid[k + 1] ? a[k] : a[k + 1];
        const pd = solid[k - N] ? a[k] : a[k - N];
        const pu = solid[k + N] ? a[k] : a[k + N];
        U[k] -= (pr - pl) / (2 * H);
        V[k] -= (pu - pd) / (2 * H);
        const m = Math.hypot(U[k], V[k]);
        if (m > cap) { U[k] *= cap / m; V[k] *= cap / m; }
      }
    }
    // sillage : ralentissement sous le vent des bâtiments (estimation)
    const sp = Math.hypot(u0, v0) || 1;
    const ux = -u0 / sp, uy = -v0 / sp; // direction amont
    const pas = Math.ceil(90 / H);
    for (let j = 1; j < N - 1; j++) {
      for (let i = 1; i < N - 1; i++) {
        const k = j * N + i;
        if (solid[k]) { U[k] = 0; V[k] = 0; continue; }
        let abri = 0;
        for (let s = 1; s <= pas; s++) {
          const sx = Math.round(i + ux * s), sy = Math.round(j + uy * s);
          if (sx < 0 || sy < 0 || sx >= N || sy >= N) break;
          const kk = sy * N + sx;
          if (solid[kk]) {
            const L = Math.min(6 * hgt[kk], 90), dist = s * H;
            if (dist < L) abri = 0.8 * (1 - dist / L);
            break;
          }
        }
        if (abri > 0) { U[k] *= 1 - abri; V[k] *= 1 - abri; }
      }
    }
    for (let i = 0; i < N; i++) {
      for (const k of [i, (N - 1) * N + i, i * N, i * N + N - 1]) { U[k] = u0; V[k] = v0; }
    }
    etat.direction = direction;
    etat.vitesse = vitesse;
  }

  // vitesse bilinéaire en (x, y) du calcul ; renvoie false hors de la grille
  function echantillon(x, y, out) {
    const gx = (x + HALF) / H - 0.5, gy = (y + HALF) / H - 0.5;
    if (gx < 0 || gy < 0 || gx >= N - 1 || gy >= N - 1) return false;
    const i = Math.floor(gx), j = Math.floor(gy), fx = gx - i, fy = gy - j;
    const k = j * N + i;
    const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
    out[0] = U[k] * w00 + U[k + 1] * w10 + U[k + N] * w01 + U[k + N + 1] * w11;
    out[1] = V[k] * w00 + V[k + 1] * w10 + V[k + N] * w01 + V[k + N + 1] * w11;
    return true;
  }

  return { resoudre, echantillon, U, V, etat };
}

// ------------------------------------------------------------------
// Phénomènes de vent : repérage géométrique à partir du bâti et du champ calculé
// ------------------------------------------------------------------

const borner = (x) => Math.max(0, Math.min(1, x));
function ccw(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; a += p[0] * q[1] - q[0] * p[1]; }
  return a < 0 ? poly.slice().reverse() : poly;
}
function cercle(x, y, r) {
  const pts = [];
  for (let i = 0; i < 18; i++) { const t = (i / 18) * Math.PI * 2; pts.push([x + r * Math.cos(t), y + r * Math.sin(t)]); }
  return pts;
}
const rectangle = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function dedoublonner(items, ecart, max) {
  items.sort((p, q) => q.s - p.s);
  const gardes = [];
  for (const it of items) {
    if (gardes.length >= max) break;
    if (gardes.every((g) => Math.hypot(g.x - it.x, g.y - it.y) >= ecart)) gardes.push(it);
  }
  return gardes;
}

// composantes connexes (8 voisins) d'un masque de cellules
function composantes(masque) {
  const vu = new Uint8Array(N * N), res = [], pile = [];
  for (let s = 0; s < N * N; s++) {
    if (!masque[s] || vu[s]) continue;
    const cellules = [];
    pile.length = 0; pile.push(s); vu[s] = 1;
    while (pile.length) {
      const k = pile.pop();
      cellules.push(k);
      const i = k % N, j = (k - i) / N;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= N || jj >= N) continue;
        const kk = jj * N + ii;
        if (masque[kk] && !vu[kk]) { vu[kk] = 1; pile.push(kk); }
      }
    }
    res.push(cellules);
  }
  return res;
}

// cellules -> rectangles (une bande par ligne de la grille)
export function cellulesEnPolygones(cellules, n = N, h = H, demi = HALF) {
  const lignes = {}, polys = [];
  for (const k of cellules) { const i = k % n, j = (k - i) / n; (lignes[j] ??= []).push(i); }
  for (const jk of Object.keys(lignes)) {
    const j = Number(jk), arr = lignes[jk].sort((a, b) => a - b);
    let i0 = arr[0], prec = arr[0];
    for (let m = 1; m <= arr.length; m++) {
      if (m === arr.length || arr[m] !== prec + 1) {
        polys.push(rectangle(i0 * h - demi, j * h - demi, (prec + 1) * h - demi, (j + 1) * h - demi));
        i0 = arr[m];
      }
      prec = arr[m];
    }
  }
  return polys;
}

// direction : d'où vient le vent (degrés) ; ambiant : vitesse du vent libre (m/s) ; rayon : zone d'analyse (m)
// passages : polylignes des passages sous bâtiment, en repère du calcul
export function detecterEffets(grille, solveur, direction, ambiant, { rayon = 300, passages = [] } = {}) {
  const { solid, hgt, dt, batiments: B } = grille;
  const { U, V } = solveur;
  const th = (direction * Math.PI) / 180;
  const ux = Math.sin(th), uy = Math.cos(th); // vers l'amont (d'où vient le vent)
  const fx = -ux, fy = -uy; // sens de l'écoulement
  const cx = -fy, cy = fx; // transversal
  const idx = grille.indice;
  const ratioEn = (x, y) => { const k = idx(x, y); return k < 0 ? 0 : Math.hypot(U[k], V[k]) / ambiant; };
  const pleinEn = (x, y) => { const k = idx(x, y); return k < 0 ? true : solid[k] === 1; };
  // marche vers l'amont : distance au premier bâtiment et sa hauteur
  function amont(x, y, max) {
    for (let d = 0; d <= max; d += H * 0.7) {
      const k = idx(x + ux * d, y + uy * d);
      if (k < 0) return { d: max, h: 0, touche: false };
      if (solid[k]) return { d, h: hgt[k], touche: true };
    }
    return { d: max, h: 0, touche: false };
  }
  const items = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [], 7: [], 8: [] };

  const etendues = B.map((b) => {
    const ring = b.r[0];
    let c0 = 1e9, c1 = -1e9, f0 = 1e9, f1 = -1e9, loin = null, loinD = -1e9;
    for (let i = 0; i < ring.length - 1; i++) {
      const c = ring[i][0] * cx + ring[i][1] * cy, f = ring[i][0] * fx + ring[i][1] * fy;
      c0 = Math.min(c0, c); c1 = Math.max(c1, c); f0 = Math.min(f0, f); f1 = Math.max(f1, f);
      if (f > loinD) { loinD = f; loin = ring[i]; }
    }
    return { c0, c1, f0, f1, loin };
  });

  B.forEach((b, bi) => {
    if (Math.hypot(b.cx, b.cy) > rayon + 40) return;
    const ring = b.r[0], n = ring.length - 1;
    const auVent = b.edges.filter((ed) => ed.nx * ux + ed.ny * uy >= 0.7 && ed.len >= 10);

    // 1. rouleau tourbillonnaire au pied d'une face haute exposée au vent
    if (b.h >= 15) {
      let meilleur = null;
      for (const ed of auVent) {
        const mx = (ed.x0 + ed.x1) / 2 + ed.nx * 2.5, my = (ed.y0 + ed.y1) / 2 + ed.ny * 2.5;
        if (pleinEn(mx, my)) continue;
        const up = amont(mx, my, 45);
        if (up.d < 8) continue;
        if (up.touche && b.h < 1.3 * up.h) continue;
        const s = borner((b.h - 12) / 12) * 0.6 + borner(ed.len / 40) * 0.4;
        if (!meilleur || s > meilleur.s) meilleur = { s, ed };
      }
      if (meilleur) {
        const ed = meilleur.ed, p = Math.min(0.45 * b.h, 9);
        items[1].push({ t: 1, s: meilleur.s, x: (ed.x0 + ed.x1) / 2 + (ed.nx * p) / 2, y: (ed.y0 + ed.y1) / 2 + (ed.ny * p) / 2,
          polys: [ccw([[ed.x0, ed.y0], [ed.x1, ed.y1], [ed.x1 + ed.nx * p, ed.y1 + ed.ny * p], [ed.x0 + ed.nx * p, ed.y0 + ed.ny * p]])] });
      }
    }

    // 2. survitesses aux coins de la face au vent
    if (b.h >= 10) {
      for (let i = 0; i < n; i++) {
        let e0 = null, e1 = null;
        const p = ring[i];
        for (const E of b.edges) {
          if (Math.abs(E.x1 - p[0]) < 0.05 && Math.abs(E.y1 - p[1]) < 0.05) e0 = E;
          if (Math.abs(E.x0 - p[0]) < 0.05 && Math.abs(E.y0 - p[1]) < 0.05) e1 = E;
        }
        if (!e0 || !e1 || e0.len < 6 || e1.len < 6) continue;
        if (e0.tx * e1.ty - e0.ty * e1.tx <= 0.2) continue; // coin saillant seulement
        const a0 = e0.nx * ux + e0.ny * uy, a1 = e1.nx * ux + e1.ny * uy;
        if (!((a0 >= 0.5 && Math.abs(a1) <= 0.6) || (a1 >= 0.5 && Math.abs(a0) <= 0.6))) continue;
        const bx = e0.nx + e1.nx, by = e0.ny + e1.ny, bl = Math.hypot(bx, by) || 1;
        const sx = p[0] + (bx / bl) * 3.5, sy = p[1] + (by / bl) * 3.5;
        if (pleinEn(sx, sy)) continue;
        const r2 = ratioEn(sx, sy);
        if (r2 < 1.2) continue;
        items[2].push({ t: 2, s: borner((r2 - 1) / 0.8), x: sx, y: sy, polys: [cercle(sx, sy, 7)] });
      }
    }

    // 3. déviation en vrille : barre oblique (30 à 60°) par rapport au vent
    if (b.L >= 25 && b.L / b.W >= 2.2 && b.h >= 10) {
      let al = Math.abs(((Math.atan2(b.ay, b.ax) - Math.atan2(fy, fx)) * 180) / Math.PI) % 180;
      al = Math.min(al, 180 - al);
      if (al >= 30 && al <= 60) {
        const decale = ring.map((q) => [q[0] + fx * 6, q[1] + fy * 6]);
        const loin = etendues[bi].loin;
        items[3].push({ t: 3, s: borner(b.h / 20) * 0.5 + borner((b.L / b.W - 2) / 4) * 0.5, x: loin[0] + fx * 6, y: loin[1] + fy * 6, polys: [ccw(decale)] });
      }
    }

    // 7. effet Wise : bâtiment bas en amont d'une face plus haute
    if (b.h >= 12) {
      let meilleur = null;
      for (const ed of auVent) {
        const mx = (ed.x0 + ed.x1) / 2 + ed.nx * 1.5, my = (ed.y0 + ed.y1) / 2 + ed.ny * 1.5;
        if (pleinEn(mx, my)) continue;
        const up = amont(mx, my, 32);
        if (!up.touche || up.d < 3 || up.h < 2 || up.h > 0.7 * b.h) continue;
        let cotes = 0;
        for (const o of [-6, 6]) { const tt = amont(mx + ed.tx * o, my + ed.ty * o, 32); if (tt.touche && tt.h <= 0.7 * b.h) cotes++; }
        if (cotes < 1) continue;
        const s = borner((b.h - up.h) / b.h) * 0.7 + borner(ed.len / 30) * 0.3;
        if (!meilleur || s > meilleur.s) meilleur = { s, ed, d: up.d };
      }
      if (meilleur) {
        const ew = meilleur.ed, w0 = 1.5, w1 = meilleur.d;
        const q0 = [ew.x0 + ew.nx * w0, ew.y0 + ew.ny * w0], q1 = [ew.x1 + ew.nx * w0, ew.y1 + ew.ny * w0];
        const q2 = [ew.x1 + ew.nx * w1, ew.y1 + ew.ny * w1], q3 = [ew.x0 + ew.nx * w1, ew.y0 + ew.ny * w1];
        items[7].push({ t: 7, s: meilleur.s, x: (ew.x0 + ew.x1) / 2 + (ew.nx * (w0 + w1)) / 2, y: (ew.y0 + ew.y1) / 2 + (ew.ny * (w0 + w1)) / 2, polys: [ccw([q0, q1, q2, q3])] });
      }
    }
  });

  // 4. sillage : cellules abritées juste sous le vent d'un bâtiment
  const abri = new Uint8Array(N * N), r2max = rayon * rayon;
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    if (solid[k]) continue;
    const x = i * H - HALF + H / 2, y = j * H - HALF + H / 2;
    if (x * x + y * y > r2max) continue;
    if (Math.hypot(U[k], V[k]) / ambiant >= 0.5) continue;
    const up = amont(x, y, 14);
    if (up.touche && up.h >= 6) abri[k] = 1;
  }
  for (const cellules of composantes(abri)) {
    if (cellules.length < 8) continue;
    let sx = 0, sy = 0;
    for (const k of cellules) { const ii = k % N; sx += ii; sy += (k - ii) / N; }
    sx /= cellules.length; sy /= cellules.length;
    let kb = cellules[0], db = 1e9;
    for (const k of cellules) { const ii = k % N, jj = (k - ii) / N, d = Math.hypot(ii - sx, jj - sy); if (d < db) { db = d; kb = k; } }
    const bi = kb % N, bj = (kb - bi) / N;
    items[4].push({ t: 4, s: cellules.length, x: bi * H - HALF + H / 2, y: bj * H - HALF + H / 2, polys: cellulesEnPolygones(cellules) });
  }

  // 5. passages sous bâtiment (OpenStreetMap) alignés avec le vent
  for (const pl of passages) {
    const a = pl[0], b2 = pl[pl.length - 1], dx = b2[0] - a[0], dy = b2[1] - a[1], len = Math.hypot(dx, dy) || 1;
    if (Math.hypot((a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2) > rayon) continue;
    const al = Math.abs((dx * fx + dy * fy) / len);
    if (al < 0.5) continue;
    const sortie = (dx * fx + dy * fy) >= 0 ? b2 : a, entree = sortie === b2 ? a : b2;
    const ox = fx * 12, oy = fy * 12, wx = cx * 2.5, wy = cy * 2.5;
    const poly = [[entree[0] - wx, entree[1] - wy], [sortie[0] - wx + ox, sortie[1] - wy + oy], [sortie[0] + wx + ox, sortie[1] + wy + oy], [entree[0] + wx, entree[1] + wy]];
    items[5].push({ t: 5, s: al, x: sortie[0] + fx * 4, y: sortie[1] + fy * 4, polys: [ccw(poly)] });
  }

  // 6. Venturi : étranglement entre deux bâtiments, entonnoir côté vent et forte survitesse
  const vm = new Uint8Array(N * N);
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) {
    const k = j * N + i;
    if (solid[k]) continue;
    const vx = i * H - HALF + H / 2, vy = j * H - HALF + H / 2;
    if (vx * vx + vy * vy > r2max) continue;
    const r0 = Math.hypot(U[k], V[k]) / ambiant;
    if (r0 < 0.8) continue;
    const d0 = dt[k];
    if (d0 > 8) continue;
    let gauche = false, droite = false;
    for (let o = H; o <= 12; o += H) { if (pleinEn(vx + cx * o, vy + cy * o)) { gauche = true; break; } }
    for (let o = H; o <= 12; o += H) { if (pleinEn(vx - cx * o, vy - cy * o)) { droite = true; break; } }
    if (!gauche || !droite) continue;
    let large = 0, rAmont = 0;
    for (const sd of [10, 16, 24, 32, 40]) {
      const kk = idx(vx + ux * sd, vy + uy * sd);
      if (kk >= 0 && !solid[kk] && dt[kk] > large) { large = dt[kk]; rAmont = Math.hypot(U[kk], V[kk]) / ambiant; }
    }
    if (large >= 1.8 * Math.max(d0, 2.5) && r0 >= 1.2 * rAmont) vm[k] = 1;
  }
  for (const cellules of composantes(vm)) {
    if (cellules.length < 4) continue;
    let kb = cellules[0], sb = 0;
    for (const k of cellules) { const s = Math.hypot(U[k], V[k]) / ambiant; if (s > sb) { sb = s; kb = k; } }
    const bi = kb % N, bj = (kb - bi) / N;
    items[6].push({ t: 6, s: sb, x: bi * H - HALF + H / 2, y: bj * H - HALF + H / 2, polys: cellulesEnPolygones(cellules) });
  }

  // 8. pressions différentes : deux bâtiments en quinconce séparés par un passage où le vent circule
  const cand = [];
  B.forEach((b, bi) => { if (b.h >= 12 && b.L >= 15 && Math.hypot(b.cx, b.cy) <= rayon + 20) cand.push(bi); });
  for (let ai = 0; ai < cand.length; ai++) {
    for (let bj = ai + 1; bj < cand.length; bj++) {
      const A = B[cand[ai]], Bb = B[cand[bj]];
      if (Math.hypot(A.cx - Bb.cx, A.cy - Bb.cy) > 90) continue;
      const EA = etendues[cand[ai]], EB = etendues[cand[bj]];
      const gc = Math.max(EA.c0 - EB.c1, EB.c0 - EA.c1);
      const gf = Math.max(EA.f0 - EB.f1, EB.f0 - EA.f1);
      const hm = Math.min(A.h, Bb.h);
      if (gc < Math.max(6, 0.5 * hm) || gc > 30) continue;
      if (gf > 12 || gf < -25) continue;
      const df = (Bb.cx - A.cx) * fx + (Bb.cy - A.cy) * fy;
      if (Math.abs(df) < 10) continue;
      const mc = EA.c1 < EB.c0 ? (EA.c1 + EB.c0) / 2 : (EB.c1 + EA.c0) / 2;
      const mf = gf < 0 ? (Math.max(EA.f0, EB.f0) + Math.min(EA.f1, EB.f1)) / 2 : (gf > 0 ? (Math.min(EA.f1, EB.f1) + Math.max(EA.f0, EB.f0)) / 2 : (EA.f0 + EB.f1) / 2);
      const mx = mc * cx + mf * fx, my = mc * cy + mf * fy;
      if (pleinEn(mx, my) || mx * mx + my * my > r2max) continue;
      if (ratioEn(mx, my) < 1.0) continue;
      items[8].push({ t: 8, s: borner(1 - gc / 30) * 0.5 + borner(hm / 20) * 0.5, x: mx, y: my, polys: [cercle(mx, my, Math.max(6, gc / 2 + 3))] });
    }
  }

  const res = [], nombres = {};
  const ecart = { 1: 30, 2: 30, 3: 40, 4: 35, 5: 20, 6: 30, 7: 30, 8: 35 }, max = { 1: 10, 2: 12, 3: 8, 4: 8, 5: 6, 6: 10, 7: 10, 8: 10 };
  for (let t = 1; t <= 8; t++) {
    const gardes = dedoublonner(items[t], ecart[t], max[t]);
    nombres[t] = gardes.length;
    res.push(...gardes);
  }
  return { items: res, nombres };
}

// ------------------------------------------------------------------
// Confort au vent piéton : part du temps où le vent à hauteur de piéton dépasse un seuil
// ------------------------------------------------------------------

// Grille de la carte : NC × NC cellules de CH mètres sur ±CHALF (comme la page d'origine)
export const NC = 160, CH = 4, CHALF = 320;
// Vent libre à hauteur de piéton (2 m, rugosité urbaine z0 = 0,8 m) ramené au vent de la station (10 m, terrain dégagé) :
// 0,696 (facteur de la page d'origine, FPED × 0,3626). Le calcul 2D donne le rapport au vent libre.
export const KPED = 0.696;
export const CLASSES_CONFORT = [
  { c: [42, 120, 214], t: 'A, très bon', l: 'moins de 2,5 % du temps' },
  { c: [27, 175, 122], t: 'B, bon', l: '2,5 à 5 %' },
  { c: [237, 161, 0], t: 'C, moyen', l: '5 à 10 %' },
  { c: [235, 104, 52], t: 'D, médiocre', l: '10 à 20 %' },
  { c: [201, 42, 42], t: 'E, mauvais', l: 'plus de 20 %' },
];
export const classeConfort = (p) => (p < 0.025 ? 0 : p < 0.05 ? 1 : p < 0.1 ? 2 : p < 0.2 ? 3 : 4);

// Rapports « vent local / vent libre » pour les 12 secteurs de 30° (vent de 1 m/s), sur la grille de la carte.
// Les centres des cellules sont en repère atlas : ligne 0 au nord (z minimal).
export async function rapportsSecteurs(grille, { journal = () => {}, attendre = () => new Promise((r) => setTimeout(r, 0)) } = {}) {
  const solveur = creerSolveur(grille);
  const R = [], o = [0, 0];
  for (let d = 0; d < 12; d++) {
    journal(`Vent du secteur ${d * 30}° (${d + 1} sur 12)…`);
    await attendre();
    solveur.resoudre(d * 30, 1);
    const arr = new Float32Array(NC * NC);
    for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
      const x = -CHALF + (i + 0.5) * CH, z = -CHALF + (j + 0.5) * CH;
      arr[j * NC + i] = solveur.echantillon(x, -z, o) ? Math.hypot(o[0], o[1]) : 1;
    }
    R.push(arr);
  }
  return R;
}

// R : rapports par secteur ; S : dépassements Météo-France { N, J[12][25] } ; seuil en m/s.
// Renvoie la part du temps (0 à 1) par cellule, -1 dans les bâtiments.
export function probabilitesDepassement(grille, R, S, seuil) {
  const P = new Float32Array(NC * NC);
  for (let j = 0; j < NC; j++) for (let i = 0; i < NC; i++) {
    const k = j * NC + i;
    const x = -CHALF + (i + 0.5) * CH, z = -CHALF + (j + 0.5) * CH;
    if (grille.estPlein(x, -z)) { P[k] = -1; continue; }
    let p = 0;
    for (let d = 0; d < 12; d++) {
      const r = KPED * R[d][k];
      if (r < 0.001) continue;
      const v = seuil / r; // vent de la station nécessaire pour dépasser le seuil ici
      if (v >= 24) continue;
      const k0 = Math.floor(v), f = v - k0, J = S.J[d];
      p += J[k0] * (1 - f) + J[k0 + 1] * f;
    }
    P[k] = p;
  }
  return P;
}
