import * as THREE from 'three';
import { h } from './util.js';
import { geometrieRubans } from './maquette.js';
import { lignesLocales, polygonesLocaux } from './geo.js';

// Trajets d'un point à un autre et isochrones.
// Services ouverts : IGN Géoplateforme (piéton, voiture, isochrones, sans clé), OSRM de FOSSGIS (vélo, sans clé),
// OpenRouteService (fauteuil roulant, clé gratuite) et Navitia (bus et tram, clé gratuite).
export const MODES = {
  pied: { libelle: 'À pied', couleur: '#2f7fb5' },
  velo: { libelle: 'À vélo', couleur: '#3f9a6b' },
  voiture: { libelle: 'En voiture', couleur: '#5b6770' },
  fauteuil: { libelle: 'En fauteuil roulant', couleur: '#a85b9b', cle: 'ors' },
  tc: { libelle: 'En bus et tram', couleur: '#c77a2b', cle: 'navitia' },
};
const CLES = { ors: 'atlas-hdv-cle-ors', navitia: 'atlas-hdv-cle-navitia' };

async function json(url, options) {
  const r = await fetch(url, options);
  if (!r.ok) throw new Error(`${new URL(url).host} : réponse ${r.status}`);
  return r.json();
}

// Chaque service renvoie { distance (m), duree (s), sections: [{ coords: [[lon,lat]…], type, libelle }] }
const SERVICES = {
  async pied(a, b) {
    try {
      const d = await json(`https://data.geopf.fr/navigation/itineraire?resource=bdtopo-osrm&profile=pedestrian&optimization=shortest&start=${a.lon},${a.lat}&end=${b.lon},${b.lat}&geometryFormat=geojson&getSteps=false&timeUnit=second&distanceUnit=meter`);
      return { distance: d.distance, duree: d.duration, sections: [{ coords: d.geometry.coordinates, type: 'pied' }], service: 'IGN Géoplateforme (BD TOPO)' };
    } catch {
      return SERVICES.osrm('routed-foot', a, b, 'pied');
    }
  },
  async voiture(a, b) {
    try {
      const d = await json(`https://data.geopf.fr/navigation/itineraire?resource=bdtopo-osrm&profile=car&optimization=fastest&start=${a.lon},${a.lat}&end=${b.lon},${b.lat}&geometryFormat=geojson&getSteps=false&timeUnit=second&distanceUnit=meter`);
      return { distance: d.distance, duree: d.duration, sections: [{ coords: d.geometry.coordinates, type: 'voiture' }], service: 'IGN Géoplateforme (BD TOPO)' };
    } catch {
      return SERVICES.osrm('routed-car', a, b, 'voiture');
    }
  },
  velo(a, b) { return SERVICES.osrm('routed-bike', a, b, 'velo'); },
  async osrm(profil, a, b, type) {
    const d = await json(`https://routing.openstreetmap.de/${profil}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=full&geometries=geojson`);
    const r = d.routes?.[0];
    if (!r) throw new Error('aucun itinéraire trouvé');
    return { distance: r.distance, duree: r.duration, sections: [{ coords: r.geometry.coordinates, type }], service: 'OSRM de FOSSGIS (OpenStreetMap)' };
  },
  async fauteuil(a, b) {
    const cle = localStorage.getItem(CLES.ors);
    if (!cle) throw new Error('clé OpenRouteService absente (voir « Clés des services »)');
    const d = await json('https://api.openrouteservice.org/v2/directions/wheelchair/geojson', {
      method: 'POST', headers: { Authorization: cle, 'Content-Type': 'application/json' },
      body: JSON.stringify({ coordinates: [[a.lon, a.lat], [b.lon, b.lat]] }),
    });
    const f = d.features?.[0];
    if (!f) throw new Error('aucun itinéraire accessible trouvé');
    return { distance: f.properties.summary.distance, duree: f.properties.summary.duration, sections: [{ coords: f.geometry.coordinates, type: 'fauteuil' }], service: 'OpenRouteService (profil fauteuil roulant)' };
  },
  async tc(a, b) {
    const cle = localStorage.getItem(CLES.navitia);
    if (!cle) throw new Error('clé Navitia absente (voir « Clés des services »)');
    const maintenant = new Date();
    const z = (v) => String(v).padStart(2, '0');
    const dt = `${maintenant.getFullYear()}${z(maintenant.getMonth() + 1)}${z(maintenant.getDate())}T${z(maintenant.getHours())}${z(maintenant.getMinutes())}00`;
    const d = await json(`https://api.navitia.io/v1/journeys?from=${a.lon};${a.lat}&to=${b.lon};${b.lat}&datetime=${dt}&count=1`, { headers: { Authorization: cle } });
    const j = d.journeys?.[0];
    if (!j) throw new Error(d.error?.message || 'aucun trajet en transports trouvé');
    const sections = (j.sections || []).filter((s) => s.geojson?.coordinates?.length).map((s) => ({
      coords: s.geojson.coordinates,
      type: s.type === 'public_transport' ? 'tc' : 'pied',
      libelle: s.type === 'public_transport' ? `${s.display_informations?.commercial_mode ?? ''} ${s.display_informations?.code ?? ''}`.trim() : null,
    }));
    const distance = sections.reduce((t, s) => t + longueurLonLat(s.coords), 0);
    return { distance, duree: j.duration, sections, service: 'Navitia (horaires des réseaux de transport)', correspondances: j.nb_transfers };
  },
};

function longueurLonLat(coords) {
  let l = 0;
  for (let i = 1; i < coords.length; i++) {
    const [x1, y1] = coords[i - 1], [x2, y2] = coords[i];
    const dx = (x2 - x1) * Math.cos((((y1 + y2) / 2) * Math.PI) / 180) * 111320, dy = (y2 - y1) * 111320;
    l += Math.hypot(dx, dy);
  }
  return l;
}

const minutes = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);
const metres = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);

export function creerTrajets(app) {
  const groupe = new THREE.Group();
  groupe.name = 'trajets';
  app.scene.add(groupe);
  const etat = { depart: null, arrivee: null, mode: 'pied', resultats: [], isochrones: null, traces: [] };
  const ui = {};

  // ---------------------------------------------------------------
  // Points de départ et d'arrivée
  // ---------------------------------------------------------------
  function lieux() {
    const liste = [{ id: 'mairie', nom: 'Hôtel de Ville (centre de l\'atlas)', lat: app.config.origine.lat, lon: app.config.origine.lon }];
    const vus = new Set();
    for (const f of app.donnees.osm.arrets?.features || []) {
      const n = f.properties?.name;
      if (!n || vus.has(n)) continue;
      const [x, z] = app.proj.pt(f.geometry.coordinates);
      if (Math.hypot(x, z) > app.config.rayonEtude) continue;
      vus.add(n);
      liste.push({ id: `arret-${n}`, nom: `Arrêt ${n}`, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] });
    }
    for (const r of app.config.remarquables || []) {
      const e = (app.empreintes || []).find((x) => x.nom === r.etiquette || x.nom?.match?.(new RegExp(r.nom || '^$', 'i')));
      if (e) { const g = app.proj.versGeo(e.cx, e.cz); liste.push({ id: r.id, nom: r.etiquette, lat: g.lat, lon: g.lon }); }
    }
    return liste;
  }

  function marquer() {
    app.etiquettes.retirerGroupe('trajets-points');
    for (const [p, lettre] of [[etat.depart, 'Départ'], [etat.arrivee, 'Arrivée']]) {
      if (!p) continue;
      const l = app.proj.versLocal(p.lat, p.lon);
      app.etiquettes.ajouter({ texte: lettre, position: new THREE.Vector3(l.x, 3, l.z), classe: 'etiquette-trajet', groupe: 'trajets-points', toujours: true, distanceMax: 5000 });
    }
  }

  function choisirSurPlan(quoi) {
    if (!app.vue2D) app.vue.basculer(true);
    app.signaler(`Cliquez le point ${quoi === 'depart' ? 'de départ' : 'd\'arrivée'} sur le plan.`);
    app.captureSol = ([x, z]) => {
      app.captureSol = null;
      const g = app.proj.versGeo(x, z);
      etat[quoi] = { nom: 'Point choisi sur le plan', lat: g.lat, lon: g.lon };
      marquer();
      majUI();
    };
  }

  // ---------------------------------------------------------------
  // Calcul et tracé
  // ---------------------------------------------------------------
  function effacer() {
    groupe.clear();
    app.etiquettes.retirerGroupe('trajets-lignes');
    etat.resultats = [];
    etat.traces = [];
    etat.isochrones = null;
  }

  function tracer(res, mode) {
    const couleur = new THREE.Color(MODES[mode].couleur);
    const decalage = Object.keys(MODES).indexOf(mode) * 0.02;
    for (const s of res.sections) {
      const pts = lignesLocales({ type: 'LineString', coordinates: s.coords }, app.proj)[0];
      if (!pts || pts.length < 2) continue;
      etat.traces.push({ mode, pts, type: s.type });
      const pied = s.type === 'pied' && mode === 'tc';
      const m = new THREE.Mesh(geometrieRubans([{ pts, largeur: pied ? 1.2 : 2.4 }], 0.5 + decalage), new THREE.MeshBasicMaterial({ color: pied ? new THREE.Color(MODES.pied.couleur) : couleur, transparent: true, opacity: 0.9, depthWrite: false }));
      m.renderOrder = 9;
      m.raycast = () => {};
      groupe.add(m);
      if (s.libelle) {
        const mil = pts[Math.floor(pts.length / 2)];
        app.etiquettes.ajouter({ texte: s.libelle, position: new THREE.Vector3(mil[0], 3, mil[1]), classe: 'etiquette-trajet-ligne', groupe: 'trajets-lignes', distanceMax: 3000 });
      }
    }
  }

  // Profil de pente le long d'un trajet (relief de l'atlas)
  function pentes(pts) {
    if (!app.topo?.disponible) return null;
    const ech = [];
    let cumul = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i) cumul += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      ech.push({ d: cumul, x: pts[i][0], z: pts[i][1] });
    }
    const L = cumul;
    const profil = [];
    for (let d = 0; d <= L; d += 5) {
      let k = 1;
      while (k < ech.length - 1 && ech[k].d < d) k++;
      const a = ech[k - 1], b = ech[k];
      const t = (d - a.d) / Math.max(b.d - a.d, 0.001);
      const z = app.topo.altitude(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t);
      profil.push({ d, z });
    }
    const valides = profil.filter((p) => Number.isFinite(p.z));
    if (valides.length < 3) return null;
    let max = 0, sup4 = 0, sup8 = 0;
    for (let i = 2; i < profil.length; i++) {
      const p0 = profil[i - 2], p1 = profil[i];
      if (!Number.isFinite(p0.z) || !Number.isFinite(p1.z)) continue;
      const pente = Math.abs(p1.z - p0.z) / (p1.d - p0.d) * 100;
      max = Math.max(max, pente);
      if (pente > 4) sup4 += 5;
      if (pente > 8) sup8 += 5;
    }
    const zs = valides.map((p) => p.z);
    let montee = 0;
    for (let i = 1; i < valides.length; i++) montee += Math.max(0, valides[i].z - valides[i - 1].z);
    return { max, sup4, sup8, montee, zmin: Math.min(...zs), zmax: Math.max(...zs), profil: valides, longueur: L, couverture: valides.length / profil.length };
  }

  async function calculer(modes) {
    if (!etat.depart || !etat.arrivee) { app.signaler('Choisissez un départ et une arrivée.'); return; }
    if (!navigator.onLine) { app.signaler('Le calcul de trajet demande une connexion.'); return; }
    effacer();
    marquer();
    ui.resultats.replaceChildren(h('p', { class: 'note' }, 'Calcul en cours…'));
    for (const mode of modes) {
      try {
        const res = await SERVICES[mode](etat.depart, etat.arrivee);
        tracer(res, mode);
        const pts = etat.traces.filter((t) => t.mode === mode).flatMap((t) => t.pts);
        etat.resultats.push({ mode, ...res, pentes: ['pied', 'fauteuil'].includes(mode) ? pentes(pts) : null });
      } catch (e) {
        etat.resultats.push({ mode, erreur: e.message });
      }
      rendreResultats();
    }
  }

  function svgProfil(p) {
    const L = 300, H = 90, m = 22;
    const X = (d) => m + (d / p.longueur) * (L - m - 4);
    const zmin = Math.floor(p.zmin) - 1, zmax = Math.ceil(p.zmax) + 1;
    const Y = (z) => H - 12 - ((z - zmin) / (zmax - zmin)) * (H - 22);
    const NS = 'http://www.w3.org/2000/svg';
    const el = (tag, a, t) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); if (t != null) e.textContent = t; return e; };
    const svg = el('svg', { viewBox: `0 0 ${L} ${H}`, class: 'graphique', role: 'img', 'aria-label': 'Profil en long du trajet' });
    svg.append(el('path', { d: `M${X(p.profil[0].d)},${H - 12} ${p.profil.map((q) => `L${X(q.d).toFixed(1)},${Y(q.z).toFixed(1)}`).join(' ')} L${X(p.profil[p.profil.length - 1].d)},${H - 12} Z`, fill: '#e9dcc0', stroke: '#6b4f26' }));
    svg.append(el('text', { x: m - 3, y: Y(zmax) + 3, 'text-anchor': 'end', class: 'axe' }, zmax), el('text', { x: m - 3, y: Y(zmin) + 3, 'text-anchor': 'end', class: 'axe' }, zmin));
    return svg;
  }

  function rendreResultats() {
    ui.resultats.replaceChildren(...etat.resultats.map((r) => {
      const def = MODES[r.mode];
      if (r.erreur) return h('div', { class: 'trajet' }, h('i', { style: { background: def.couleur } }), h('div', {}, h('strong', {}, def.libelle), h('span', { class: 'note' }, ` indisponible : ${r.erreur}`)));
      const lignes = [h('strong', {}, `${def.libelle} : ${minutes(r.duree)}`), h('span', {}, ` ${metres(r.distance)}${r.correspondances != null ? `, ${r.correspondances} correspondance${r.correspondances > 1 ? 's' : ''}` : ''}`)];
      const bloc = h('div', { class: 'trajet' }, h('i', { style: { background: def.couleur } }), h('div', {}, ...lignes, h('span', { class: 'note' }, ` (${r.service})`)));
      if (r.pentes) {
        const p = r.pentes;
        bloc.lastChild.append(
          svgProfil(p),
          h('p', { class: 'note' }, `Dénivelé de ${p.zmin.toFixed(1).replace('.', ',')} à ${p.zmax.toFixed(1).replace('.', ',')} m, ${Math.round(p.montee)} m de montée cumulée. Pente maximale ${Math.round(p.max)} % ; ${Math.round(p.sup4)} m au-dessus de 4 %, ${Math.round(p.sup8)} m au-dessus de 8 %.${p.couverture < 0.9 ? ' Relief incomplet sur ce trajet.' : ''}`),
          h('p', { class: 'note' }, 'Repères d\'accessibilité : une pente de 4 % au plus est recommandée ; au-delà de 5 %, des paliers de repos sont nécessaires. Calculée sur un relief à 8 m, la pente fine (bordures, marches) n\'est pas visible.'));
      }
      return bloc;
    }));
  }

  // ---------------------------------------------------------------
  // Isochrones à pied (IGN)
  // ---------------------------------------------------------------
  async function isochrones() {
    const p = etat.depart || { lat: app.config.origine.lat, lon: app.config.origine.lon };
    if (!navigator.onLine) { app.signaler('Les isochrones demandent une connexion.'); return; }
    effacer();
    marquer();
    ui.resultats.replaceChildren(h('p', { class: 'note' }, 'Calcul des isochrones…'));
    const durees = [15, 10, 5];
    const couleurs = ['#cfe3f2', '#8fbfe0', '#2f7fb5'];
    const zones = [];
    try {
      for (const [i, min] of durees.entries()) {
        const d = await json(`https://data.geopf.fr/navigation/isochrone?resource=bdtopo-valhalla&profile=pedestrian&costType=time&costValue=${min * 60}&timeUnit=second&direction=departure&point=${p.lon},${p.lat}&geometryFormat=geojson`);
        const polys = polygonesLocaux(d.geometry, app.proj);
        zones.push({ min, polys });
        const forme = polys.map(([ext, ...trous]) => {
          const s = new THREE.Shape(ext.map(([x, z]) => new THREE.Vector2(x, -z)));
          trous.forEach((t) => s.holes.push(new THREE.Path(t.map(([x, z]) => new THREE.Vector2(x, -z)))));
          return s;
        });
        const geo = new THREE.ShapeGeometry(forme).rotateX(-Math.PI / 2).translate(0, 0.4 + i * 0.02, 0);
        const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: couleurs[i], transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -12, polygonOffsetUnits: -12 }));
        m.renderOrder = 7;
        m.raycast = () => {};
        groupe.add(m);
        await new Promise((r) => setTimeout(r, 250));
      }
      etat.isochrones = zones;
      ui.resultats.replaceChildren(
        h('ul', { class: 'legende' }, ...durees.map((min, i) => h('li', {}, h('i', { style: { background: couleurs[i] } }), `${min} minutes à pied`))),
        h('p', { class: 'note' }, 'Isochrones de l\'IGN (réseau BD TOPO, vitesse de marche standard), depuis le point de départ ou, à défaut, depuis la mairie.'));
      if (!app.vue2D) app.vue.basculer(true);
    } catch (e) {
      ui.resultats.replaceChildren(h('p', { class: 'note' }, `Isochrones indisponibles : ${e.message}`));
    }
  }

  // ---------------------------------------------------------------
  // Panneau
  // ---------------------------------------------------------------
  function majUI() {
    if (!ui.depart?.isConnected) return;
    ui.depart.textContent = etat.depart ? etat.depart.nom : 'non choisi';
    ui.arrivee.textContent = etat.arrivee ? etat.arrivee.nom : 'non choisie';
  }

  function construirePanneau(conteneur) {
    const liste = lieux();
    const selecteur = (quoi) => h('select', {
      'aria-label': quoi === 'depart' ? 'Départ' : 'Arrivée',
      onchange: (e) => { const l = liste.find((x) => x.id === e.target.value); if (l) { etat[quoi] = l; marquer(); majUI(); } },
    }, h('option', { value: '' }, 'Choisir un lieu…'), ...liste.map((l) => h('option', { value: l.id }, l.nom)));
    ui.depart = h('strong', {});
    ui.arrivee = h('strong', {});
    ui.resultats = h('div');
    const cle = (id, libelle, lien) => {
      const input = h('input', { type: 'password', autocomplete: 'off', value: localStorage.getItem(CLES[id]) || '' });
      input.addEventListener('change', () => localStorage.setItem(CLES[id], input.value.trim()));
      return h('label', { class: 'champ' }, h('span', {}, libelle, ' ', h('a', { href: lien, target: '_blank', rel: 'noopener' }, '(obtenir)')), input);
    };
    conteneur.append(
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Départ'), ui.depart),
      h('div', { class: 'deux-champs' }, selecteur('depart'), h('button', { type: 'button', class: 'bouton petit', onclick: () => choisirSurPlan('depart') }, 'Sur le plan')),
      h('div', { class: 'ligne-valeur' }, h('span', {}, 'Arrivée'), ui.arrivee),
      h('div', { class: 'deux-champs' }, selecteur('arrivee'), h('button', { type: 'button', class: 'bouton petit', onclick: () => choisirSurPlan('arrivee') }, 'Sur le plan')),
      h('div', { class: 'choix colonne', role: 'radiogroup' }, ...Object.entries(MODES).map(([k, m]) => h('label', {},
        h('input', { type: 'radio', name: 'mode-trajet', value: k, checked: k === etat.mode, onchange: () => { etat.mode = k; } }),
        h('i', { class: 'pastille-trajet', style: { background: m.couleur } }), m.libelle, m.cle ? h('em', { class: 'note' }, ' (clé)') : null))),
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton principal', onclick: () => calculer([etat.mode]) }, 'Calculer'),
        h('button', { type: 'button', class: 'bouton', onclick: () => calculer(Object.keys(MODES).filter((k) => !MODES[k].cle || localStorage.getItem(CLES[MODES[k].cle]))) }, 'Comparer les modes'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => { effacer(); app.etiquettes.retirerGroupe('trajets-points'); etat.depart = etat.arrivee = null; majUI(); ui.resultats.replaceChildren(); } }, 'Effacer')),
      ui.resultats,
      h('h3', {}, 'Isochrones à pied'),
      h('p', { class: 'note' }, 'Zones atteignables en 5, 10 et 15 minutes à pied depuis le départ (ou la mairie).'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: isochrones }, 'Calculer les isochrones')),
      h('details', { class: 'details' },
        h('summary', {}, 'Clés des services (fauteuil, bus et tram)'),
        cle('ors', 'OpenRouteService', 'https://openrouteservice.org/dev/#/signup'),
        cle('navitia', 'Navitia', 'https://www.navitia.io/'),
        h('p', { class: 'note' }, 'Clés gratuites, personnelles, gardées dans ce navigateur. À pied, à vélo et en voiture, aucune clé n\'est nécessaire.')),
      h('p', { class: 'note' }, 'Les trajets dépendent des réseaux décrits par l\'IGN et OpenStreetMap ; ils ne sont pas disponibles hors ligne.'),
    );
    majUI();
    if (etat.resultats.length) rendreResultats();
  }

  return { construirePanneau, calculer, isochrones, etat, get traces() { return etat.traces; }, get zones() { return etat.isochrones; } };
}
