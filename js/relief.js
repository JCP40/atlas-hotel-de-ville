import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Relief réel de la maquette 3D.
// La maquette est construite à plat (y = 0 au sol). Quand le relief est activé, toute la scène est
// « drapée » sur la grille d'altitudes de l'outil Relief (MNT de Nantes Métropole ou RGE ALTI) :
// - les surfaces au sol (sol, plateau, voirie, fonds de plan, cadastre, cartes de confort, bruit…) sont
//   redécoupées en petits triangles puis posées sur le terrain ;
// - chaque bâtiment est soulevé d'un bloc à l'altitude de son centre, sa base prolongée jusqu'au point
//   le plus bas de son emprise (pas de bâtiment qui flotte sur une pente) ;
// - les arbres, repères et objets isolés sont posés à l'altitude de leur pied.
// Les géométries d'origine sont gardées : désactiver le relief remet la maquette à plat.
// Les couches créées plus tard (calculs, trajets…) sont drapées au fil de l'eau.
// Hauteur de référence : l'altitude du centre du projet (y = 0 au centre), exagération réglable.

const Y_HAUT = new THREE.Vector3(0, 1, 0);

export function creerRelief(app) {
  const etat = { actif: false, exageration: 1, version: 0, grille: null, h0: 0, traites: [], dernierBalayage: 0 };

  // ---------------------------------------------------------------
  // Grille d'altitudes complétée (vides bouchés, bords prolongés)
  // ---------------------------------------------------------------
  function preparerGrille() {
    const src = app.topo?.etat?.grille;
    if (!src) return null;
    const { nx, nz } = src;
    const z = Float32Array.from(src.z);
    // les vides prennent la moyenne de leurs voisins connus, par passes successives
    for (let passe = 0; passe < 200; passe++) {
      let reste = 0;
      const copie = Float32Array.from(z);
      for (let j = 0; j < nz; j++) {
        for (let i = 0; i < nx; i++) {
          const k = j * nx + i;
          if (Number.isFinite(copie[k])) continue;
          let s = 0, n = 0;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const a = i + di, b = j + dj;
            if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
            const v = copie[b * nx + a];
            if (Number.isFinite(v)) { s += v; n++; }
          }
          if (n) z[k] = s / n; else reste++;
        }
      }
      if (!reste) break;
    }
    return { ...src, z };
  }

  function altitude(x, z) {
    const g = etat.grille;
    // hors de la grille : altitude du bord le plus proche
    const fx = Math.min(Math.max((x - g.x0) / g.pas, 0), g.nx - 1.001);
    const fz = Math.min(Math.max((z - g.z0) / g.pas, 0), g.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz), u = fx - i, v = fz - j;
    const k = j * g.nx + i;
    const a = g.z[k], b = g.z[k + 1], c = g.z[k + g.nx], d = g.z[k + g.nx + 1];
    const r = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    return Number.isFinite(r) ? r : etat.h0;
  }

  // décalage vertical (en mètres de scène) en un point du plan
  function dz(x, z) {
    if (!etat.actif) return 0;
    const g = etat.grille;
    // au-delà de la grille, le terrain rejoint doucement l'altitude du centre (sur 300 m)
    const hors = Math.max(g.x0 - x, x - (g.x0 + (g.nx - 1) * g.pas), g.z0 - z, z - (g.z0 + (g.nz - 1) * g.pas), 0);
    const w = Math.min(hors / 300, 1);
    return (altitude(x, z) - etat.h0) * etat.exageration * (1 - w * w * (3 - 2 * w));
  }

  // ---------------------------------------------------------------
  // Découpage des grandes surfaces pour qu'elles suivent le terrain
  // ---------------------------------------------------------------
  // L : longueur maximale d'arête, ou fonction (x, z) → longueur (maille plus fine près du plateau)
  function subdiviserTriangles(geo, L, limite = 400000) {
    const g = geo.index ? geo.toNonIndexed() : geo.clone();
    const noms = Object.keys(g.attributes);
    const src = noms.map((n) => g.getAttribute(n));
    const sortie = noms.map(() => []);
    const lire = (a, i) => Array.from({ length: a.itemSize }, (_, c) => a.getComponent(i, c));
    const pos = g.getAttribute('position');
    const pile = [];
    for (let t = 0; t < pos.count; t += 3) pile.push([0, 1, 2].map((d) => src.map((a) => lire(a, t + d))));
    const L2 = typeof L === 'function' ? null : L * L;
    let garde = 0;
    while (pile.length) {
      const tri = pile.pop();
      const p = tri.map((s) => s[0]);
      const d2 = [0, 1, 2].map((e) => { const a = p[e], b = p[(e + 1) % 3]; return (a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2; });
      const e = d2.indexOf(Math.max(...d2));
      const Lt2 = L2 ?? L((p[0][0] + p[1][0] + p[2][0]) / 3, (p[0][2] + p[1][2] + p[2][2]) / 3) ** 2;
      if (d2[e] <= Lt2 || ++garde > limite) {
        tri.forEach((s) => s.forEach((v, n) => sortie[n].push(...v)));
        continue;
      }
      const a = e, b = (e + 1) % 3, c = (e + 2) % 3;
      const m = tri[a].map((v, n) => v.map((x, q) => (x + tri[b][n][q]) / 2));
      pile.push([tri[a], m, tri[c]], [m, tri[b], tri[c]]);
    }
    const res = new THREE.BufferGeometry();
    noms.forEach((n, i) => res.setAttribute(n, new THREE.Float32BufferAttribute(sortie[i], src[i].itemSize, src[i].normalized)));
    res.groups = [];
    g.dispose();
    return res;
  }

  function subdiviserSegments(geo, L, bande) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const noms = Object.keys(g.attributes);
    const src = noms.map((n) => g.getAttribute(n));
    const sortie = noms.map(() => []);
    const pos = g.getAttribute('position');
    const lire = (a, i) => Array.from({ length: a.itemSize }, (_, c) => a.getComponent(i, c));
    const couper = (i, j, fermer) => {
      const A = [pos.getX(i), pos.getZ(i)], B = [pos.getX(j), pos.getZ(j)];
      const n = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / L));
      for (let s = 0; s < n; s++) {
        for (const t of bande ? [s / n] : [s / n, (s + 1) / n]) {
          src.forEach((a, q) => { const u = lire(a, i), v = lire(a, j); sortie[q].push(...u.map((x, c) => x + (v[c] - x) * t)); });
        }
      }
      if (bande && fermer) src.forEach((a, q) => sortie[q].push(...lire(a, j)));
    };
    if (bande) for (let i = 0; i < pos.count - 1; i++) couper(i, i + 1, i === pos.count - 2);
    else for (let i = 0; i + 1 < pos.count; i += 2) couper(i, i + 1);
    const res = new THREE.BufferGeometry();
    noms.forEach((n, i) => res.setAttribute(n, new THREE.Float32BufferAttribute(sortie[i], src[i].itemSize, src[i].normalized)));
    return res;
  }

  // ---------------------------------------------------------------
  // Traitement des objets
  // ---------------------------------------------------------------
  const v = new THREE.Vector3();
  const m3 = new THREE.Matrix3();
  const inv = new THREE.Matrix4();

  // vecteur local correspondant à +1 m vers le haut dans le monde
  function hautLocal(obj) {
    inv.copy(obj.matrixWorld).invert();
    return Y_HAUT.clone().applyMatrix3(m3.setFromMatrix4(inv));
  }

  function draperSommets(obj, geo) {
    const pos = geo.getAttribute('position');
    const haut = hautLocal(obj);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(obj.matrixWorld);
      const d = dz(v.x, v.z);
      pos.setXYZ(i, pos.getX(i) + haut.x * d, pos.getY(i) + haut.y * d, pos.getZ(i) + haut.z * d);
    }
    pos.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  }

  function marquerDescendants(obj) {
    obj.traverse((o) => { if (o !== obj) o.userData.reliefVersion = etat.version; });
  }

  function traiterBatiment(mesh, empreintes) {
    const geo = mesh.geometry;
    const pos = geo.getAttribute('position');
    const origine = pos.array.slice();
    const decalages = new Map();
    for (const e of empreintes) {
      const dC = dz(e.cx, e.cz);
      let dMin = dC;
      for (const [x, z] of e.polys[0][0]) dMin = Math.min(dMin, dz(x, z));
      let yMin = Infinity;
      for (let i = e.debut; i < e.debut + e.nb; i++) yMin = Math.min(yMin, pos.getY(i));
      e.decalageRelief = dC;
      for (let i = e.debut; i < e.debut + e.nb; i++) {
        const y = pos.getY(i);
        const d = dC - (y <= yMin + 0.05 ? dC - dMin + 0.3 : 0);
        decalages.set(`${pos.getX(i)},${y},${pos.getZ(i)}`, d);
        pos.setY(i, y + d);
      }
    }
    pos.needsUpdate = true;
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    etat.traites.push(() => { pos.array.set(origine); pos.needsUpdate = true; geo.computeBoundingBox(); geo.computeBoundingSphere(); empreintes.forEach((e) => { e.decalageRelief = 0; }); });
    // arêtes dessinées : mêmes sommets que le bâtiment
    for (const enfant of mesh.children) {
      if (!enfant.geometry) continue;
      const p = enfant.geometry.getAttribute('position');
      const o = p.array.slice();
      for (let i = 0; i < p.count; i++) {
        const cle = `${p.getX(i)},${p.getY(i)},${p.getZ(i)}`;
        // lignes d'étages (userData.blocRelief) : décalage du bâtiment au centre, comme ses façades
        p.setY(i, p.getY(i) + (decalages.get(cle) ?? (enfant.userData.blocRelief ? (empreintes[0]?.decalageRelief ?? 0) : dz(p.getX(i), p.getZ(i)))));
      }
      p.needsUpdate = true;
      enfant.geometry.computeBoundingSphere();
      enfant.userData.reliefVersion = etat.version;
      etat.traites.push(() => { p.array.set(o); p.needsUpdate = true; enfant.geometry.computeBoundingSphere(); });
    }
  }

  function traiterInstances(obj) {
    const arr = obj.instanceMatrix.array;
    const origine = arr.slice();
    const m4 = new THREE.Matrix4();
    const n = arr.length / 16;
    for (let i = 0; i < n; i++) {
      m4.fromArray(arr, i * 16);
      v.setFromMatrixPosition(m4).applyMatrix4(obj.matrixWorld);
      arr[i * 16 + 13] += dz(v.x, v.z);
    }
    obj.instanceMatrix.needsUpdate = true;
    obj.computeBoundingSphere?.();
    etat.traites.push(() => { arr.set(origine); obj.instanceMatrix.needsUpdate = true; obj.computeBoundingSphere?.(); });
  }

  function traiterObjet(obj) {
    obj.updateWorldMatrix(true, false);
    if (obj.isInstancedMesh) { traiterInstances(obj); return; }
    const geo = obj.geometry;
    if (!geo?.getAttribute('position')?.count) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const bb = geo.boundingBox.clone().applyMatrix4(obj.matrixWorld);
    const taille = bb.getSize(new THREE.Vector3());
    const empreinte = Math.hypot(taille.x, taille.z);
    const plat = taille.y < 3;

    // petit objet en volume (repère, borne, maquette d'arbre) : posé d'un bloc
    if (!plat && empreinte < 40) {
      const c = bb.getCenter(new THREE.Vector3());
      const d = dz(c.x, c.z);
      const y0 = obj.position.y;
      obj.position.y += d;
      obj.updateMatrixWorld(true);
      marquerDescendants(obj);
      etat.traites.push(() => { obj.position.y = y0; obj.updateMatrixWorld(true); });
      return;
    }

    // grande surface au sol : découpée pour épouser le terrain
    if (plat && (obj.isMesh || obj.isLine) && !Array.isArray(obj.material)) {
      // reliefPas : découpage fin imposé (sol urbain et plateau, 21/10/2026 : mêmes mailles de 2 m pour que chaussées,
      // trottoirs et plateau suivent le terrain de la même façon, sans se traverser) ; reliefDecalage : glissé sous les autres
      // (2 m sur le plateau et 30 m autour, 6 m au-delà : le nombre de triangles reste raisonnable)
      const rFin = app.config.rayonPlateau + 30;
      const L = obj.userData.reliefPas
        ? (x, z) => (Math.hypot(x, z) < rFin ? obj.userData.reliefPas : obj.userData.reliefPas * 3)
        : Math.min(25, Math.max(4, empreinte / 80));
      let nouvelle;
      if (obj.isMesh) {
        nouvelle = subdiviserTriangles(geo, L, obj.userData.reliefPas ? 4000000 : 400000);
        if (nouvelle.getAttribute('normal')) nouvelle = mergeVertices(nouvelle, 1e-4);
      } else {
        nouvelle = subdiviserSegments(geo, typeof L === 'function' ? obj.userData.reliefPas * 3 : L, !obj.isLineSegments);
      }
      draperSommets(obj, nouvelle);
      if (obj.userData.reliefDecalage) {
        const p = nouvelle.getAttribute('position');
        for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) + obj.userData.reliefDecalage);
      }
      if (obj.isMesh && nouvelle.getAttribute('normal')) nouvelle.computeVertexNormals();
      obj.geometry = nouvelle;
      etat.traites.push(() => { if (obj.geometry === nouvelle) { obj.geometry = geo; nouvelle.dispose(); } });
      return;
    }

    // grand volume (bâti disparu, plans de coupe…) : chaque sommet suit le terrain
    const pos = geo.getAttribute('position');
    const origine = pos.array.slice();
    draperSommets(obj, geo);
    etat.traites.push(() => { pos.array.set(origine); pos.needsUpdate = true; geo.computeBoundingBox(); geo.computeBoundingSphere(); });
  }

  function balayer() {
    const batiments = new Map();
    for (const e of app.empreintes || []) {
      if (!e.mesh) continue;
      if (!batiments.has(e.mesh)) batiments.set(e.mesh, []);
      batiments.get(e.mesh).push(e);
    }
    const parcourir = (o) => {
      if (o.userData.pasDeRelief) return;
      if (o.userData.reliefVersion !== etat.version) {
        o.userData.reliefVersion = etat.version;
        if (batiments.has(o)) traiterBatiment(o, batiments.get(o));
        else if ((o.isMesh || o.isLine || o.isPoints) && !o.isSprite) traiterObjet(o);
      }
      for (const c of [...o.children]) parcourir(c);
    };
    parcourir(app.scene);
  }

  // ---------------------------------------------------------------
  // Activation
  // ---------------------------------------------------------------
  function remettreAPlat() {
    for (let i = etat.traites.length - 1; i >= 0; i--) etat.traites[i]();
    etat.traites = [];
    etat.version++;
  }

  async function activer(oui, { exageration } = {}) {
    if (exageration) etat.exageration = exageration;
    if (etat.actif) { etat.actif = false; remettreAPlat(); }
    if (oui) {
      if (!app.topo.disponible) await app.topo.charger();
      etat.grille = preparerGrille();
      if (!etat.grille) throw new Error('aucune grille d\'altitudes : chargez le relief (Couches > Relief)');
      etat.h0 = 0;
      etat.h0 = altitude(0, 0);
      etat.actif = true;
      etat.version++;
      balayer();
    }
    app.emettre('relief', etat.actif);
  }

  // pour un calcul fait sur la maquette à plat (export) : relief retiré puis remis
  function suspendre() {
    if (!etat.actif) return () => {};
    etat.actif = false;
    remettreAPlat();
    return () => { etat.actif = true; etat.version++; balayer(); };
  }

  // les couches ajoutées ou reconstruites après l'activation sont drapées à leur tour
  function maj(t) {
    if (!etat.actif || t - etat.dernierBalayage < 400) return;
    etat.dernierBalayage = t;
    balayer();
  }

  // la grille change (autre source, import) : on redrape
  app.on('topographie', () => { if (etat.actif) activer(true).catch(() => {}); });

  return {
    activer, suspendre, maj, dz, etat,
    get actif() { return etat.actif; },
    get exageration() { return etat.exageration; },
  };
}
