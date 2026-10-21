import * as THREE from 'three';
import { COULEURS } from './maquette.js';

// Vue maquette coupée net (21/10/2026) : comme une maquette physique, tout ce qui est posé sur le plateau
// (bâti, toits détaillés, façades photo, projet, imports, sol, arbres, couches d'analyse) est tranché au bord
// du cercle config.rayonPlateau.
// - Coupe : 64 plans de découpe locaux (material.clippingPlanes, polygone inscrit au cercle, écart ≤ 5 cm pour 42 m),
//   ajoutés aux matériaux de la scène tant que la vue maquette est active (balayage toutes les 500 ms pour les
//   couches ajoutées ensuite), retirés en vue étendue. Les ombres suivent (clipShadows).
// - Faces de coupe : pour chaque bâtiment traversé par le bord, mur de coupe calculé sur le polygone (de la base,
//   ou du terrain avec le relief, jusqu'au toit : hauteur du bâtiment simple, ou toit réel des ensembles détaillés
//   par empreinte.hauteurEn), teinte de poché unie ; projet et imports (formes libres) : faces arrière en poché.
// - Socle : bande verticale sous le bord du plateau, qui suit le terrain quand le relief est drapé.
// Seul l'affichage change : calculs (soleil, vent, confort, chaleur, coupes) et exports gardent tout le bâti.
// config.json > decoupeMaquette : false revient à l'ancienne vue maquette (bâtiments entiers selon leur centre).
const N = 64;
const POCHE = 0x434950; // poché des faces de coupe (gris ardoise sombre)
// objets jamais coupés : repères, aperçus (ou userData.horsDecoupe sur l'objet ou un parent, ou groupe sans nom à la racine)
const EXCLUS = new Set(['sol', 'socle-maquette', 'faces-coupe-maquette', 'observateur', 'vent-fleche', 'rose-vents']);

export function creerDecoupe(app) {
  const R = app.config.rayonPlateau;
  const Rin = R * Math.cos(Math.PI / N);
  const disponible = app.config.decoupeMaquette !== false;
  // sommets du polygone (mêmes angles que CircleGeometry(R, N) tournée à plat) et plans (normale vers l'intérieur)
  const sommets = [], plans = [], dirs = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    sommets.push([R * Math.cos(a), -R * Math.sin(a)]);
    const b = ((i + 0.5) / N) * Math.PI * 2;
    dirs.push([Math.cos(b), -Math.sin(b)]);
    plans.push(new THREE.Plane(new THREE.Vector3(-Math.cos(b), 0, Math.sin(b)), Rin));
  }
  const ensemblePlans = new Set(plans);
  const patches = new Set();
  let actif = false, dernier = 0;

  const groupeFaces = new THREE.Group();
  groupeFaces.name = 'faces-coupe-maquette';
  groupeFaces.userData.pasDeRelief = true;
  groupeFaces.visible = false;
  app.scene.add(groupeFaces);
  const matTrait = new THREE.LineBasicMaterial({ color: COULEURS.trait, transparent: true, opacity: 0.7 });

  const dz = (x, z) => (app.relief?.actif ? app.relief.dz(x, z) : 0);

  // ---------------------------------------------------------------
  // Socle : bande verticale le long du polygone, du terrain jusqu'à 8 m sous le plus bas
  // ---------------------------------------------------------------
  function construireSocle() {
    const ep = app.sol?.epaisseur;
    if (!ep) return;
    const pts = [];
    for (let i = 0; i < N; i++) {
      const [ax, az] = sommets[i], [bx, bz] = sommets[(i + 1) % N];
      const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az) / 1.5));
      for (let s = 0; s < n; s++) pts.push([ax + (bx - ax) * (s / n), az + (bz - az) * (s / n)]);
    }
    const hauts = pts.map(([x, z]) => dz(x, z) + 0.02);
    const bas = Math.min(...hauts) - 8;
    const pos = [];
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const [ax, az] = pts[i], [bx, bz] = pts[j];
      pos.push(ax, bas, az, bx, bas, bz, bx, hauts[j], bz, ax, bas, az, bx, hauts[j], bz, ax, hauts[i], az);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.computeVertexNormals();
    ep.geometry.dispose();
    ep.geometry = geo;
    ep.position.set(0, 0, 0);
    ep.name = 'socle-maquette';
    ep.userData.pasDeRelief = true;
    ep.userData.reliefVersion = Infinity;
    // fond du socle, pour une vue rasante par-dessous
    if (!ep.userData.fond) {
      const fond = new THREE.Mesh(new THREE.CircleGeometry(R, N).rotateX(Math.PI / 2), ep.material);
      fond.userData.pasDeRelief = true;
      ep.add(fond);
      ep.userData.fond = fond;
    }
    ep.userData.fond.position.y = bas;
  }

  // ---------------------------------------------------------------
  // Faces de coupe du bâti
  // ---------------------------------------------------------------
  function anneaux(e) {
    const r = [];
    for (const poly of e.polys || []) for (const ring of poly) if (ring?.length >= 3) r.push(ring);
    return r;
  }
  function dedansEmpreinte(rings, x, z) {
    let c = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, zi] = ring[i], [xj, zj] = ring[j];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c;
      }
    }
    return c;
  }
  function intersections(ax, az, bx, bz, rings) {
    const ts = [0, 1];
    const dx = bx - ax, dzz = bz - az;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [cx, cz] = ring[j], [ex, ez] = ring[i];
        const fx = ex - cx, fz = ez - cz;
        const den = dx * fz - dzz * fx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((cx - ax) * fz - (cz - az) * fx) / den;
        const u = ((cx - ax) * dzz - (cz - az) * dx) / den;
        if (t > 0 && t < 1 && u >= 0 && u <= 1) ts.push(t);
      }
    }
    return ts.sort((a, b) => a - b);
  }

  // murs de coupe d'une empreinte : { pos[], lignes[] }
  function coupeEmpreinte(e, sortie) {
    const rings = anneaux(e);
    if (!rings.length) return;
    let dmin = Infinity, dmax = 0;
    for (const ring of rings) for (const [x, z] of ring) { const d = Math.hypot(x, z); dmin = Math.min(dmin, d); dmax = Math.max(dmax, d); }
    if (dmax < Rin - 0.01) return; // entièrement sur le plateau
    if (dmin > R + 60) return; // loin du bord (une arête longue peut quand même le traverser : marge)
    const detail = typeof e.hauteurEn === 'function';
    const dC = app.relief?.actif ? dz(e.cx, e.cz) : 0; // bâtiment soulevé d'un bloc (js/relief.js)
    const base = e.base || 0;
    const haut = (x, z) => {
      if (detail) { const h = e.hauteurEn(x, z); return Number.isFinite(h) && h > 0.2 ? h + dC : null; }
      return e.hauteur > base ? e.hauteur + dC : null;
    };
    const bas = (x, z) => (base > 0.2 ? base + dC : dz(x, z));
    for (let k = 0; k < N; k++) {
      const [ax, az] = sommets[k], [bx, bz] = sommets[(k + 1) % N];
      const ts = intersections(ax, az, bx, bz, rings);
      const [nx, nz] = dirs[k];
      for (let q = 0; q + 1 < ts.length; q++) {
        const t0 = ts[q], t1 = ts[q + 1];
        if (t1 - t0 < 1e-6) continue;
        const tm = (t0 + t1) / 2;
        if (!dedansEmpreinte(rings, ax + (bx - ax) * tm, az + (bz - az) * tm)) continue;
        const L = Math.hypot(bx - ax, bz - az) * (t1 - t0);
        const n = Math.max(1, Math.ceil(L / (detail ? 0.5 : 2)));
        let prec = null;
        for (let s = 0; s <= n; s++) {
          // échantillons un peu à l'intérieur des bords pour la hauteur des toits détaillés
          const t = t0 + (t1 - t0) * (s / n);
          const tH = t0 + (t1 - t0) * Math.min(Math.max(s / n, 0.02), 0.98);
          const x = ax + (bx - ax) * t, z = az + (bz - az) * t;
          const yH = haut(ax + (bx - ax) * tH - nx * 0.02, az + (bz - az) * tH - nz * 0.02);
          const cur = yH == null ? null : { x, z, yt: yH, yb: Math.min(bas(x, z), yH) };
          if (cur && prec) {
            sortie.pos.push(prec.x, prec.yb, prec.z, cur.x, cur.yb, cur.z, cur.x, cur.yt, cur.z,
              prec.x, prec.yb, prec.z, cur.x, cur.yt, cur.z, prec.x, prec.yt, prec.z);
            for (let r = 0; r < 6; r++) sortie.nor.push(nx, 0, nz);
            sortie.lignes.push(prec.x, prec.yt, prec.z, cur.x, cur.yt, cur.z, prec.x, prec.yb, prec.z, cur.x, cur.yb, cur.z);
          }
          if (cur && (!prec || s === n)) sortie.lignes.push(x, cur.yb, z, x, cur.yt, z);
          if (!cur && prec) sortie.lignes.push(prec.x, prec.yb, prec.z, prec.x, prec.yt, prec.z);
          prec = cur;
        }
      }
    }
  }

  function viderFaces() {
    for (const c of [...groupeFaces.children]) {
      c.traverse((o) => { o.geometry?.dispose(); if (o.material && o.material !== matTrait) o.material.dispose(); });
      groupeFaces.remove(c);
    }
  }

  function construireFaces() {
    viderFaces();
    if (!actif) return;
    const parMesh = new Map();
    for (const e of app.empreintes || []) {
      if (!e.mesh) continue;
      if (!parMesh.has(e.mesh)) parMesh.set(e.mesh, { pos: [], nor: [], lignes: [] });
      coupeEmpreinte(e, parMesh.get(e.mesh));
    }
    for (const [mesh, s] of parMesh) {
      if (!s.pos.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(s.nor, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: POCHE, side: THREE.DoubleSide }));
      m.userData.batiment = mesh;
      m.userData.pasDeRelief = true;
      m.raycast = () => {};
      const l = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(s.lignes, 3)), matTrait);
      l.userData.pasDeRelief = true;
      l.raycast = () => {};
      m.add(l);
      groupeFaces.add(m);
    }
  }

  function visibleChaine(o) {
    for (let v = o; v; v = v.parent) if (!v.visible) return false;
    return true;
  }
  // avant chaque rendu : une face de coupe suit son bâtiment (masqué, transparent, époque)
  function synchroniserFaces() {
    for (const m of groupeFaces.children) {
      const b = m.userData.batiment;
      const mat = Array.isArray(b.material) ? b.material[0] : b.material;
      m.visible = visibleChaine(b) && mat?.visible !== false && b.scale.y > 0.98;
      if (m.visible && mat) {
        const t = !!mat.transparent && mat.opacity < 1;
        if (m.material.transparent !== t) { m.material.transparent = t; m.material.needsUpdate = true; }
        m.material.opacity = t ? mat.opacity : 1;
        m.material.depthWrite = !t;
      }
    }
  }

  // ---------------------------------------------------------------
  // Plans de découpe sur les matériaux
  // ---------------------------------------------------------------
  function exclu(o) {
    for (let v = o; v && v !== app.scene; v = v.parent) {
      if (EXCLUS.has(v.name) || v.userData?.horsDecoupe) return true;
      // aperçus sans nom posés à la racine (trajectoire du soleil, cercle de l'outil Centre, tracés Relevé et Coupes)
      // et cercle d'analyse du Confort (anneau) : jamais coupés ; les cartes d'analyse sans nom (Mesh plans) le sont
      if (v.parent === app.scene && !v.name && (v.isGroup || v.geometry?.type === 'RingGeometry')) return true;
    }
    return false;
  }
  function pocheAutorise(o) {
    for (let v = o; v && v !== app.scene; v = v.parent) if (v.name === 'projet' || v.name === 'imports') return true;
    return false;
  }
  function patcherMateriau(m, poche) {
    const d = m.userData.decoupe;
    if (d && m.clippingPlanes?.includes(plans[0])) return;
    if (!d) m.userData.decoupe = { clipShadows: m.clipShadows, side: m.side, poche: false };
    m.clippingPlanes = [...(m.clippingPlanes || []).filter((p) => !ensemblePlans.has(p)), ...plans];
    m.clipShadows = true;
    if (poche && !m.userData.decoupe.poche && (m.isMeshStandardMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshBasicMaterial)) {
      // formes libres (projet, imports) : l'intérieur vu par la coupe est peint en poché
      m.userData.decoupe.poche = true;
      if (!m.userData.decoupeShader) {
        m.userData.decoupeShader = true;
        const avant = m.onBeforeCompile, cleAvant = m.customProgramCacheKey;
        const c = new THREE.Color(POCHE);
        m.onBeforeCompile = function (s, r) {
          avant?.call(this, s, r);
          if (!this.userData.decoupe?.poche) return;
          s.fragmentShader = s.fragmentShader.replace(/}\s*$/, `  if (!gl_FrontFacing) gl_FragColor = vec4(${c.r.toFixed(3)}, ${c.g.toFixed(3)}, ${c.b.toFixed(3)}, gl_FragColor.a);\n}`);
        };
        m.customProgramCacheKey = function () { return `${cleAvant ? cleAvant.call(this) : ''}|poche${this.userData.decoupe?.poche ? 1 : 0}`; };
      }
      m.side = THREE.DoubleSide;
      m.shadowSide = THREE.BackSide;
    }
    m.needsUpdate = true;
    patches.add(m);
  }
  function retirerMateriau(m) {
    const d = m.userData.decoupe;
    if (!d) return;
    const reste = (m.clippingPlanes || []).filter((p) => !ensemblePlans.has(p));
    m.clippingPlanes = reste.length ? reste : null;
    m.clipShadows = d.clipShadows;
    if (d.poche) { m.side = d.side; m.shadowSide = null; }
    delete m.userData.decoupe;
    m.needsUpdate = true;
  }
  function balayer() {
    app.scene.traverse((o) => {
      if (!o.material || !(o.isMesh || o.isLine || o.isPoints || o.isSprite)) return;
      if (exclu(o)) return;
      const poche = o.isMesh && pocheAutorise(o);
      for (const m of [].concat(o.material)) if (m && !m.isShaderMaterial) patcherMateriau(m, poche);
    });
  }

  function appliquer() {
    const doit = disponible && !!app.vueMaquette;
    if (doit === actif) { if (actif) { balayer(); construireFaces(); } return; }
    actif = doit;
    if (actif) { construireSocle(); balayer(); construireFaces(); }
    else { for (const m of patches) retirerMateriau(m); patches.clear(); viderFaces(); }
    groupeFaces.visible = actif;
  }

  function maj(t) {
    if (!actif) return;
    if (t - dernier < 500) return;
    dernier = t;
    balayer();
  }

  // un point (Vector3 ou [x, z]) est-il sur le plateau ?
  function dedans(p) {
    const x = Array.isArray(p) ? p[0] : p.x, z = Array.isArray(p) ? p[1] : p.z;
    return plans.every((pl) => pl.normal.x * x + pl.normal.z * z + pl.constant >= -1e-3);
  }

  app.on('bati', () => { if (actif) construireFaces(); });
  app.on('relief', () => { construireSocle(); if (actif) construireFaces(); });
  construireSocle();

  return {
    appliquer, maj, dedans, construireFaces, synchroniserFaces, plans,
    get actif() { return actif; },
    get disponible() { return disponible; },
    get groupeFaces() { return groupeFaces; },
  };
}
