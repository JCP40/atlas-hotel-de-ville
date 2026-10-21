import * as THREE from 'three';
import { h } from './util.js';
import { chargerJSON, interrogerAltitudes, lireJeuGeo, enregistrerDonnees } from './donnees.js';
import { empriseAutour } from './geo.js';

const JEU_MNT_NANTES = '244400404_modele-numerique-terrain-nantes-metropole';
import { lireCache, ecrireCache } from './cache.js';

// Topographie du site : la maquette reste posée à plat (comme la maquette physique),
// le relief est lu par des courbes de niveau, des teintes et des profils le long des axes.
export function creerTopo(app) {
  const memoire = parseFloat(localStorage.getItem('atlas-hdv-equidistance'));
  const etat = { grille: null, intervalle: Number.isFinite(memoire) ? memoire : (app.config.topographie?.intervalle ?? 1), erreur: null };

  // Courbes maîtresses : une sur cinq (tous les 5 m pour une équidistance de 1 m) ;
  // à partir de 5 m d'équidistance, chaque courbe est maîtresse et cotée.
  function estMaitresse(niveau) {
    if (etat.intervalle >= 5) return true;
    const pas = etat.intervalle * 5;
    return Math.abs(niveau / pas - Math.round(niveau / pas)) < 1e-6;
  }

  function changerIntervalle(v) {
    if (!(v > 0)) return;
    etat.intervalle = v;
    localStorage.setItem('atlas-hdv-equidistance', String(v));
    if (ui.libre?.isConnected) { ui.libre.value = v; ui.sel.value = [0.5, 1, 2, 2.5, 5, 10].includes(v) ? String(v) : 'autre'; }
    dessiner();
    majUI();
  }
  const groupe = new THREE.Group();
  groupe.name = 'topographie';
  groupe.visible = false;
  app.scene.add(groupe);
  const ui = {};

  function grilleVide() {
    const r = app.config.rayonEtude;
    const pas = app.config.topographie?.pas ?? 8;
    const n = Math.ceil((2 * r) / pas) + 1;
    return { x0: -r, z0: -r, pas, nx: n, nz: n };
  }

  // ---------------------------------------------------------------
  // Points d'altitude épars (MNT de Nantes Métropole, fichier CSV…) -> grille régulière
  // par pondération inverse de la distance, dans un rayon de 30 m
  // ---------------------------------------------------------------
  function grilleDepuisPoints(points, source) {
    const grille = grilleVide();
    const rayon = 30, cellule = 30;
    const index = new Map();
    for (const p of points) {
      const k = `${Math.floor(p.x / cellule)},${Math.floor(p.z / cellule)}`;
      if (!index.has(k)) index.set(k, []);
      index.get(k).push(p);
    }
    const z = [];
    for (let j = 0; j < grille.nz; j++) {
      for (let i = 0; i < grille.nx; i++) {
        const x = grille.x0 + i * grille.pas, y = grille.z0 + j * grille.pas;
        const ci = Math.floor(x / cellule), cj = Math.floor(y / cellule);
        let sw = 0, sa = 0;
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            for (const p of index.get(`${ci + di},${cj + dj}`) || []) {
              const d = Math.hypot(p.x - x, p.z - y);
              if (d > rayon) continue;
              const w = 1 / Math.max(d, 0.5) ** 2;
              sw += w; sa += w * p.alt;
            }
          }
        }
        z.push(sw ? Math.round((sa / sw) * 100) / 100 : null);
      }
    }
    return { ...grille, z, source, origine: [app.config.origine.lat, app.config.origine.lon] };
  }

  // Lecture tolérante d'un CSV ou d'un GeoJSON de points (colonnes longitude, latitude, altitude)
  function pointsDepuisTexte(texte) {
    const t = texte.replace(/^\uFEFF/, '').trim();
    if (t.startsWith('{')) {
      const fc = JSON.parse(t);
      return pointsDepuisGeoJSON(fc);
    }
    const lignes = t.split(/\r?\n/);
    const sep = [';', ',', '\t'].find((s) => lignes[0].split(s).length >= 3) || ';';
    const decouper = (l) => { const res = []; let cur = '', q = false; for (const c of l) { if (c === '"') q = !q; else if (c === sep && !q) { res.push(cur); cur = ''; } else cur += c; } res.push(cur); return res.map((v) => v.trim()); };
    const entetes = decouper(lignes[0]).map((e) => e.toLowerCase());
    const col = (re) => entetes.findIndex((e) => re.test(e));
    const iLon = col(/^lon|longitude/), iLat = col(/^lat|latitude/), iAlt = col(/alti|^z$|hauteur|elev/);
    if (iLon < 0 || iLat < 0 || iAlt < 0) throw new Error('colonnes longitude, latitude et altitude introuvables');
    const pts = [];
    for (const l of lignes.slice(1)) {
      const v = decouper(l);
      const lon = parseFloat(String(v[iLon]).replace(',', '.')), lat = parseFloat(String(v[iLat]).replace(',', '.')), alt = parseFloat(String(v[iAlt]).replace(',', '.'));
      if ([lon, lat, alt].every(Number.isFinite)) { const p = app.proj.versLocal(lat, lon); pts.push({ x: p.x, z: p.z, alt }); }
    }
    return pts;
  }

  function pointsDepuisGeoJSON(fc) {
    const pts = [];
    for (const f of fc.features || []) {
      if (f.geometry?.type !== 'Point') continue;
      const pr = f.properties || {};
      const k = Object.keys(pr).find((c) => /alti|^z$|elev/i.test(c));
      const alt = parseFloat(pr[k] ?? f.geometry.coordinates[2]);
      if (!Number.isFinite(alt)) continue;
      const p = app.proj.versLocal(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      pts.push({ x: p.x, z: p.z, alt });
    }
    return pts;
  }

  async function depuisNantes() {
    const e = empriseAutour(app.config.origine.lat, app.config.origine.lon, app.config.rayonEtude * 1.05);
    if (ui.etat) ui.etat.textContent = 'Lecture du modèle numérique de terrain de Nantes Métropole…';
    const fc = await lireJeuGeo(JEU_MNT_NANTES, e);
    const pts = pointsDepuisGeoJSON(fc);
    if (!pts.length) throw new Error('aucun point d\'altitude dans le périmètre');
    return grilleDepuisPoints(pts, `Nantes Métropole, modèle numérique de terrain (${pts.length} points), interpolé sur une grille de ${grilleVide().pas} m`);
  }

  // Complète les nœuds sans valeur avec le RGE ALTI de l'IGN
  async function completerAvecIGN() {
    const g = etat.grille;
    if (!g || !navigator.onLine) return;
    const vides = [];
    for (let k = 0; k < g.z.length; k++) if (!Number.isFinite(g.z[k])) vides.push(k);
    if (!vides.length) { app.signaler('La grille est déjà complète.'); return; }
    const pts = { x0: 0, z0: 0, pas: 1, nx: vides.length, nz: 1 };
    const projVides = { versGeo: (i) => { const k = vides[i]; return app.proj.versGeo(g.x0 + (k % g.nx) * g.pas, g.z0 + Math.floor(k / g.nx) * g.pas); } };
    const res = await interrogerAltitudes(pts, projVides, (t) => { if (ui.etat) ui.etat.textContent = t; });
    res.z.forEach((v, i) => { if (v != null) g.z[vides[i]] = v; });
    g.source = `${g.source} ; vides complétés par l'IGN (RGE ALTI)`;
    await installer({ ...g, z: Array.from(g.z, (v) => (Number.isFinite(v) ? v : null)) }, true);
  }

  async function installer(g, memoriser = false) {
    // une grille calculée pour un autre centre est recalée sur le centre actuel
    if (g.origine && (g.origine[0] !== app.config.origine.lat || g.origine[1] !== app.config.origine.lon)) {
      const o = app.proj.versLocal(g.origine[0], g.origine[1]);
      g = { ...g, x0: g.x0 + o.x, z0: g.z0 + o.z };
    }
    if (memoriser) await ecrireCache(`topo-${app.cleZone}`, { ...g, z: Array.from(g.z, (v) => (Number.isFinite(v) ? v : null)) });
    etat.grille = { ...g, z: Float32Array.from(g.z, (v) => (v == null || !Number.isFinite(v) ? NaN : v)) };
    const ok = [...etat.grille.z].filter(Number.isFinite);
    etat.min = Math.min(...ok);
    etat.max = Math.max(...ok);
    etat.h0 = altitude(0, 0);
    etat.erreur = null;
    // part du plateau couverte par des altitudes
    const gr = etat.grille, rp = app.config.rayonPlateau;
    let tot = 0, nb = 0;
    for (let j = 0; j < gr.nz; j++) for (let i = 0; i < gr.nx; i++) { const x = gr.x0 + i * gr.pas, z = gr.z0 + j * gr.pas; if (Math.hypot(x, z) <= rp) { tot++; if (Number.isFinite(gr.z[j * gr.nx + i])) nb++; } }
    etat.couverture = tot ? nb / tot : 0;
    dessiner();
    majUI();
    app.emettre('topographie');
  }

  async function charger({ enDirect = true, source = null } = {}) {
    let g = source ? null : await chargerJSON('data/ign/altimetrie.json', null);
    const cle = `topo-${app.cleZone}`;
    if (!g && !source) g = await lireCache(cle, 3650);
    if (!g && enDirect && navigator.onLine && app.mode !== 'borne') {
      const choix = source || app.config.topographie?.source || 'nantes';
      try {
        g = choix === 'ign'
          ? await interrogerAltitudes(grilleVide(), app.proj, (t) => { if (ui.etat) ui.etat.textContent = t; })
          : await depuisNantes();
        if (!g.origine) g.origine = [app.config.origine.lat, app.config.origine.lon];
        await ecrireCache(cle, g);
      } catch (e) {
        etat.erreur = e.message;
      }
    }
    if (g) {
      await installer(g);
      return etat.grille;
    }
    majUI();
    return null;
  }

  // altitude bilinéaire en un point local (NaN hors grille)
  function altitude(x, z) {
    const g = etat.grille;
    if (!g) return NaN;
    const fx = (x - g.x0) / g.pas, fz = (z - g.z0) / g.pas;
    const i = Math.floor(fx), j = Math.floor(fz);
    if (i < 0 || j < 0 || i >= g.nx - 1 || j >= g.nz - 1) return NaN;
    const u = fx - i, v = fz - j;
    const a = g.z[j * g.nx + i], b = g.z[j * g.nx + i + 1], c = g.z[(j + 1) * g.nx + i], d = g.z[(j + 1) * g.nx + i + 1];
    return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
  }

  // Courbes de niveau par la méthode des carrés (marching squares) : liste de segments par altitude
  function courbes(intervalle = etat.intervalle) {
    const g = etat.grille;
    const res = new Map();
    const debut = Math.ceil(etat.min / intervalle) * intervalle;
    for (let niveau = debut; niveau <= etat.max; niveau += intervalle) {
      const segs = [];
      for (let j = 0; j < g.nz - 1; j++) {
        for (let i = 0; i < g.nx - 1; i++) {
          const v = [g.z[j * g.nx + i], g.z[j * g.nx + i + 1], g.z[(j + 1) * g.nx + i + 1], g.z[(j + 1) * g.nx + i]];
          if (v.some((x) => !Number.isFinite(x))) continue;
          const p = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
          const croise = [];
          for (let k = 0; k < 4; k++) {
            const a = v[k], b = v[(k + 1) % 4];
            if ((a < niveau) !== (b < niveau)) {
              const t = (niveau - a) / (b - a);
              const [ia, ja] = p[k], [ib, jb] = p[(k + 1) % 4];
              croise.push([g.x0 + (ia + (ib - ia) * t) * g.pas, g.z0 + (ja + (jb - ja) * t) * g.pas]);
            }
          }
          if (croise.length === 2) segs.push(croise);
          else if (croise.length === 4) segs.push([croise[0], croise[1]], [croise[2], croise[3]]);
        }
      }
      res.set(Math.round(niveau * 100) / 100, segs);
    }
    return res;
  }

  function dessiner() {
    groupe.clear();
    app.etiquettes.retirerGroupe('topo');
    if (!etat.grille) return;
    const mineures = [], majeures = [];
    const r = app.config.rayonEtude;
    for (const [niveau, segs] of courbes()) {
      const majeure = estMaitresse(niveau);
      const cible = majeure ? majeures : mineures;
      for (const [[x1, z1], [x2, z2]] of segs) {
        if (Math.hypot(x1, z1) > r) continue;
        cible.push(x1, 0.28, z1, x2, 0.28, z2);
      }
      if (majeure && segs.length) {
        // une étiquette par courbe maîtresse, au segment le plus proche du centre
        let best = null, dmin = Infinity;
        for (const [[x1, z1]] of segs) { const d = Math.hypot(x1, z1); if (d < dmin) { dmin = d; best = [x1, z1]; } }
        if (best && dmin < r) app.etiquettes.ajouter({ texte: `${niveau} m`, position: new THREE.Vector3(best[0], 0.5, best[1]), classe: 'etiquette-altitude', groupe: 'topo', centre: true, distanceMax: 1500, visibleSi: () => groupe.visible });
      }
    }
    const lignes = (pos, couleur, opacite) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      // en plan, les courbes passent au-dessus des toits pour rester lisibles
      const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: couleur, transparent: true, opacity: opacite, depthTest: !app.vue2D }));
      l.renderOrder = 8;
      l.raycast = () => {};
      groupe.add(l);
    };
    if (mineures.length) lignes(mineures, 0x9a7a4a, 0.55);
    if (majeures.length) lignes(majeures, 0x6b4f26, 0.95);

    // teintes hypsométriques (facultatives)
    const g = etat.grille;
    const px = new Uint8Array(g.nx * g.nz * 4);
    for (let k = 0; k < g.z.length; k++) {
      if (!Number.isFinite(g.z[k])) continue;
      const t = (g.z[k] - etat.min) / Math.max(etat.max - etat.min, 1);
      const c = new THREE.Color().setHSL(0.30 - 0.22 * t, 0.35, 0.78 - 0.18 * t);
      px.set([c.r * 255, c.g * 255, c.b * 255, 150], k * 4);
    }
    const tex = new THREE.DataTexture(px, g.nx, g.nz, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    const larg = (g.nx - 1) * g.pas, haut = (g.nz - 1) * g.pas;
    const plan = new THREE.Mesh(new THREE.PlaneGeometry(larg, haut).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -7 }));
    const uv = plan.geometry.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) uv.setY(i, 1 - uv.getY(i));
    plan.position.set(g.x0 + larg / 2, 0.26, g.z0 + haut / 2);
    plan.name = 'teintes';
    plan.visible = !!app.couches.teintes;
    plan.raycast = () => {};
    groupe.add(plan);
  }

  function profil(A, B, n = 120) {
    const pts = [];
    const L = Math.hypot(B.x - A.x, B.z - A.z);
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      pts.push({ d: t * L, z: altitude(A.x + (B.x - A.x) * t, A.z + (B.z - A.z) * t) });
    }
    return pts;
  }

  // Profil en SVG, pour le panneau des coupes
  function svgProfil(ax) {
    if (!etat.grille) return h('p', { class: 'note' }, 'Topographie non chargée (outil Couches > Relief).');
    const pts = profil(ax.A, ax.B).filter((p) => Number.isFinite(p.z));
    if (pts.length < 2) return h('p', { class: 'note' }, 'Axe hors de la zone de relief.');
    const L = 300, H = 110, m = 24;
    const dMax = pts[pts.length - 1].d;
    const zMin = Math.floor(Math.min(...pts.map((p) => p.z))) - 1, zMax = Math.ceil(Math.max(...pts.map((p) => p.z))) + 1;
    const X = (d) => m + (d / dMax) * (L - m - 6), Y = (z) => H - 16 - ((z - zMin) / (zMax - zMin)) * (H - 28);
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, attrs, txt) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (txt != null) e.textContent = txt; return e; };
    const svg = el('svg', { viewBox: `0 0 ${L} ${H}`, class: 'graphique', role: 'img', 'aria-label': `Profil du terrain de ${ax.id} à ${ax.id}′` });
    svg.append(el('path', { d: `M${X(0)},${H - 16} ${pts.map((p) => `L${X(p.d).toFixed(1)},${Y(p.z).toFixed(1)}`).join(' ')} L${X(dMax)},${H - 16} Z`, fill: '#e9dcc0', stroke: '#6b4f26', 'stroke-width': 1.2 }));
    svg.append(el('text', { x: m - 3, y: Y(zMax) + 3, 'text-anchor': 'end', class: 'axe' }, `${zMax}`), el('text', { x: m - 3, y: Y(zMin) + 3, 'text-anchor': 'end', class: 'axe' }, `${zMin}`));
    svg.append(el('text', { x: X(0), y: H - 3, class: 'axe' }, ax.id), el('text', { x: X(dMax), y: H - 3, 'text-anchor': 'end', class: 'axe' }, `${ax.id}′, ${Math.round(dMax)} m`));
    const cont = h('div', {});
    cont.append(svg, h('p', { class: 'note' }, `Terrain naturel le long de l'axe, de ${zMin + 1} à ${zMax - 1} m NGF environ (hauteurs exagérées).`));
    return cont;
  }

  function nbCourbes() {
    const n = Math.floor(etat.max / etat.intervalle) - Math.ceil(etat.min / etat.intervalle) + 1;
    const eq = String(etat.intervalle).replace('.', ',');
    return n <= 0 ? `Aucune courbe tous les ${eq} m : le dénivelé du site est plus faible.` : `${n} courbe${n > 1 ? 's' : ''} tous les ${eq} m.`;
  }

  function majUI() {
    if (!ui.etat?.isConnected) return;
    if (etat.grille) {
      ui.etat.textContent = `Relief du site de ${etat.min.toFixed(1).replace('.', ',')} à ${etat.max.toFixed(1).replace('.', ',')} m NGF (grille de ${etat.grille.pas} m, ${etat.grille.source ?? 'RGE ALTI'}). Au centre : ${Number.isFinite(etat.h0) ? `${etat.h0.toFixed(1).replace('.', ',')} m` : '?'}. Plateau couvert à ${Math.round(etat.couverture * 100)} %. ${nbCourbes()}`;
    } else {
      ui.etat.textContent = etat.erreur ? `Relief indisponible : ${etat.erreur}.` : 'Relief non chargé.';
    }
  }

  function construireCommandes(conteneur) {
    ui.etat = h('p', { class: 'note', 'aria-live': 'polite' });
    const bascule = (cle, libelle, fn) => h('label', { class: 'case' },
      h('input', { type: 'checkbox', checked: !!app.couches[cle], onchange: (e) => { app.couches[cle] = e.target.checked; fn?.(); app.emettre('couches'); } }), libelle);
    const valeurs = [0.5, 1, 2, 2.5, 5, 10];
    const libre = h('input', { type: 'number', min: 0.25, max: 20, step: 0.25, value: etat.intervalle, 'aria-label': 'Équidistance libre en mètres' });
    const selInterv = h('select', { 'aria-label': 'Équidistance des courbes', onchange: (e) => { if (e.target.value !== 'autre') { changerIntervalle(+e.target.value); libre.value = e.target.value; } } },
      ...valeurs.map((v) => h('option', { value: v, selected: v === etat.intervalle }, `${String(v).replace('.', ',')} m`)),
      h('option', { value: 'autre', selected: !valeurs.includes(etat.intervalle) }, 'Autre valeur'));
    ui.libre = libre;
    ui.sel = selInterv;
    libre.addEventListener('change', () => {
      const v = parseFloat(libre.value);
      if (v > 0) { changerIntervalle(v); selInterv.value = valeurs.includes(v) ? String(v) : 'autre'; }
    });
    // relief réel : la maquette 3D est drapée sur le terrain
    const appliquerRelief = async (actif, exageration) => {
      try {
        if (actif) app.signaler('Pose de la maquette sur le relief…');
        await new Promise((r) => setTimeout(r, 30));
        await app.relief.activer(actif, { exageration });
        if (actif) app.signaler(`Relief réel affiché (hauteurs × ${String(app.relief.exageration).replace('.', ',')}).`);
      } catch (err) { app.signaler(`Relief impossible : ${err.message}`); }
    };
    const selExag = h('select', { 'aria-label': 'Exagération des hauteurs du relief', onchange: (e) => { if (app.relief.actif) appliquerRelief(true, +e.target.value); else app.relief.etat.exageration = +e.target.value; } },
      ...[1, 1.5, 2, 3, 5].map((k) => h('option', { value: k, selected: k === app.relief.exageration }, k === 1 ? 'Hauteurs réelles (× 1)' : `Exagérées × ${String(k).replace('.', ',')}`)));
    conteneur.append(
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: app.relief.actif, onchange: (e) => appliquerRelief(e.target.checked, +selExag.value) }), 'Relief réel en 3D (maquette posée sur le terrain)'),
      h('label', { class: 'champ' }, h('span', {}, 'Relief'), selExag),
      bascule('topographie', 'Courbes de niveau', async () => { if (app.couches.topographie && !etat.grille) await charger(); }),
      bascule('teintes', 'Teintes du relief', async () => { if (app.couches.teintes && !etat.grille) await charger(); }),
      h('div', { class: 'deux-champs' },
        h('label', { class: 'champ' }, h('span', {}, 'Équidistance'), selInterv),
        h('label', { class: 'champ' }, h('span', {}, 'En mètres'), libre)),
      ui.etat,
    );
    if (app.mode === 'borne') { majUI(); return; }
    const fichier = h('input', {
      type: 'file', accept: '.csv,.json,.geojson,text/csv,application/json', hidden: true,
      onchange: async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          const pts = pointsDepuisTexte(await f.text());
          if (!pts.length) throw new Error('aucun point lisible');
          await installer(grilleDepuisPoints(pts, `${f.name} (${pts.length} points), interpolé sur une grille de ${grilleVide().pas} m`), true);
          app.signaler(`${pts.length} points d'altitude importés.`);
        } catch (err) { app.signaler(`Import impossible : ${err.message}`); }
      },
    });
    const action = (libelle, fn) => h('button', { type: 'button', class: 'bouton discret petit', onclick: async () => { try { await fn(); } catch (err) { app.signaler(err.message); } } }, libelle);
    conteneur.append(
      fichier,
      h('div', { class: 'actions' },
        action('Nantes Métropole (MNT)', () => charger({ source: 'nantes' })),
        action('IGN (RGE ALTI)', () => charger({ source: 'ign' })),
        action('Importer des points (CSV)', () => fichier.click())),
      etat.grille ? h('div', { class: 'actions' },
        etat.couverture < 1 ? action('Compléter les vides avec l\'IGN', completerAvecIGN) : null,
        app.mode === 'presentateur' ? action('Enregistrer altimetrie.json', () => enregistrerDonnees('ign/altimetrie.json', JSON.stringify({ ...etat.grille, z: Array.from(etat.grille.z, (v) => (Number.isFinite(v) ? v : null)) }))) : null) : h('span'),
    );
    majUI();
  }

  // altitude sous le pointeur, quand le relief est affiché
  const affichage = document.querySelector('#orientation .altitude');
  app.on('pointeurSol', ([x, z]) => {
    if (!affichage) return;
    const a = altitude(x, z);
    const montrer = (app.couches.topographie || app.couches.teintes) && Number.isFinite(a);
    affichage.hidden = !montrer;
    if (montrer) affichage.textContent = `${a.toFixed(1).replace('.', ',')} m NGF`;
  });

  app.on('vue', () => groupe.children.forEach((c) => { if (c.isLineSegments) { c.material.depthTest = !app.vue2D; c.material.needsUpdate = true; } }));

  app.on('couches', () => {
    groupe.visible = !!(app.couches.topographie || app.couches.teintes);
    groupe.children.forEach((c) => { if (c.name === 'teintes') c.visible = !!app.couches.teintes; else c.visible = !!app.couches.topographie; });
  });

  return { charger, altitude, courbes, estMaitresse, changerIntervalle, profil, svgProfil, construireCommandes, etat, get disponible() { return !!etat.grille; } };
}
