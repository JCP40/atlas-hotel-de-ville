// Chargement des données de l'atlas.
// Principe : l'atlas lit d'abord des fichiers figés dans /data (préparés une fois avec preparer.html).
// S'ils manquent et qu'une connexion existe, il peut interroger directement les sources ouvertes.

// Essayés dans l'ordre. En septembre 2026, overpass-api.de était saturé (réponses 406 ou 504) et
// overpass.kumi.systems ne répondait plus (retiré) : le miroir de mail.ru (CORS ouvert) prend le relais.
export const OVERPASS = [
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

export async function chargerJSON(url, defaut = null) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    if (!r.ok) return defaut;
    return await r.json();
  } catch {
    return defaut;
  }
}

export async function fichierExiste(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-cache' });
    return r.ok;
  } catch {
    return false;
  }
}

export function collection(features = []) {
  return { type: 'FeatureCollection', features };
}

// ------------------------------------------------------------------
// OpenStreetMap via Overpass
// ------------------------------------------------------------------

// Deux requêtes : les éléments de la maquette, puis les lignes de bus et de tram (coupées à l'emprise).
export function requeteOverpass(e, partie = 'elements') {
  const b = `${e.sud},${e.ouest},${e.nord},${e.est}`;
  if (partie === 'lignes') {
    return `[out:json][timeout:90];
relation["route"~"^(bus|tram)$"](${b});
out geom(${b});`;
  }
  return `[out:json][timeout:90];
(
  way["building"](${b});
  relation["building"](${b});
  way["highway"](${b});
  way["area:highway"](${b});
  way["leisure"~"^(park|garden|playground|pitch)$"](${b});
  way["landuse"~"^(grass|flowerbed|village_green)$"](${b});
  way["amenity"="parking"](${b});
  way["natural"="water"](${b});
  node["natural"="tree"](${b});
  node["highway"="bus_stop"](${b});
  node["railway"="tram_stop"](${b});
  node["highway"="street_lamp"](${b});
  node["man_made"="manhole"](${b});
  node["emergency"="fire_hydrant"](${b});
  node["man_made"~"^(street_cabinet|utility_pole)$"](${b});
  way["power"~"^(line|minor_line|cable)$"](${b});
  way["man_made"="pipeline"](${b});
);
out geom;`;
}

// Une requête, essayée sur chaque serveur tour à tour
async function envoyerOverpass(requete, journal, quoi, tours = 2) {
  const corps = 'data=' + encodeURIComponent(requete);
  let derniereErreur;
  // deux tours : un serveur saturé se libère souvent en quelques secondes
  for (const [tour, url] of [...OVERPASS.map((u) => [1, u]), ...(tours > 1 ? OVERPASS.map((u) => [2, u]) : [])]) {
    if (tour === 2 && url === OVERPASS[0]) {
      journal('Serveurs OpenStreetMap saturés : nouvel essai dans 15 s…');
      await new Promise((ok) => setTimeout(ok, 15000));
    }
    try {
      journal(`Interrogation d'OpenStreetMap (${new URL(url).host}), ${quoi}…`);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: corps,
        signal: AbortSignal.timeout(75000), // un serveur muet ne doit pas bloquer les suivants
      });
      if (!r.ok) throw new Error(`réponse ${r.status}`);
      return await r.json();
    } catch (err) {
      derniereErreur = err;
      journal(`Échec sur ce serveur : ${err.message}`);
    }
  }
  throw new Error(`OpenStreetMap injoignable (${derniereErreur?.message ?? 'erreur inconnue'})`);
}

// Pour un grand périmètre, les serveurs publics coupent les requêtes trop longues (réponse 504) :
// on découpe alors l'emprise en quarts, et les éléments reçus deux fois sont fusionnés.
export async function interrogerOverpass(emprise, journal = () => {}) {
  let elements;
  try {
    elements = (await envoyerOverpass(requeteOverpass(emprise), journal, 'bâti et voirie')).elements;
  } catch (err) {
    journal(`Requête trop lourde (${err.message}) : découpage du périmètre en quatre.`);
    const mLat = (emprise.sud + emprise.nord) / 2, mLon = (emprise.ouest + emprise.est) / 2;
    const quarts = [
      { sud: emprise.sud, nord: mLat, ouest: emprise.ouest, est: mLon }, { sud: emprise.sud, nord: mLat, ouest: mLon, est: emprise.est },
      { sud: mLat, nord: emprise.nord, ouest: emprise.ouest, est: mLon }, { sud: mLat, nord: emprise.nord, ouest: mLon, est: emprise.est },
    ];
    const vus = new Map();
    for (const [i, q] of quarts.entries()) {
      const res = await envoyerOverpass(requeteOverpass(q), journal, `quart ${i + 1} sur 4`, 1);
      for (const el of res.elements) vus.set(`${el.type}/${el.id}`, el);
    }
    elements = [...vus.values()];
  }
  let lignes = [];
  try {
    lignes = (await envoyerOverpass(requeteOverpass(emprise, 'lignes'), journal, 'lignes de bus et de tram')).elements;
  } catch (err) {
    journal(`Lignes de bus et de tram non reçues (${err.message}) : la maquette est construite sans elles.`);
  }
  journal(`${elements.length + lignes.length} éléments OSM reçus.`);
  return { elements: [...elements, ...lignes] };
}

const versLonLat = (g) => (g ? [g.lon, g.lat] : null);

function fermer(anneau) {
  const a = anneau[0], b = anneau[anneau.length - 1];
  if (a[0] !== b[0] || a[1] !== b[1]) anneau.push([...a]);
  return anneau;
}

// Assemble des morceaux de voies (membres de relation) en anneaux fermés.
function assemblerAnneaux(morceaux) {
  const restants = morceaux.filter((m) => m.length > 1).map((m) => m.slice());
  const anneaux = [];
  const egal = (p, q) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
  while (restants.length) {
    let anneau = restants.shift();
    let progres = true;
    while (!egal(anneau[0], anneau[anneau.length - 1]) && progres) {
      progres = false;
      for (let i = 0; i < restants.length; i++) {
        const m = restants[i];
        const fin = anneau[anneau.length - 1];
        if (egal(fin, m[0])) anneau = anneau.concat(m.slice(1));
        else if (egal(fin, m[m.length - 1])) anneau = anneau.concat(m.slice(0, -1).reverse());
        else continue;
        restants.splice(i, 1);
        progres = true;
        break;
      }
    }
    if (anneau.length >= 4) anneaux.push(fermer(anneau));
  }
  return anneaux;
}

// Convertit la réponse Overpass en couches GeoJSON thématiques.
export function convertirOSM(json) {
  const couches = {
    batiments: [], voirie: [], surfaces: [], arbres: [], arrets: [], lignes: [], reseaux: [],
  };
  const lignesParVoie = new Map();

  for (const el of json.elements) {
    const t = el.tags || {};
    const props = { osm: `${el.type}/${el.id}`, ...t };

    if (el.type === 'node') {
      const coord = [el.lon, el.lat];
      const pt = { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: coord } };
      if (t.natural === 'tree') couches.arbres.push(pt);
      else if (t.highway === 'bus_stop' || t.railway === 'tram_stop') couches.arrets.push(pt);
      else if (t.highway === 'street_lamp' || t.man_made || t.emergency) couches.reseaux.push(pt);
      continue;
    }

    if (el.type === 'way' && el.geometry) {
      const coords = el.geometry.map(versLonLat).filter(Boolean);
      if (coords.length < 2) continue;
      const ferme = coords.length > 3 && coords[0][0] === coords[coords.length - 1][0] && coords[0][1] === coords[coords.length - 1][1];
      if (t.power || t.man_made === 'pipeline') {
        couches.reseaux.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
      } else if (t.building && ferme) {
        couches.batiments.push({ type: 'Feature', properties: props, geometry: { type: 'Polygon', coordinates: [coords] } });
      } else if (t['area:highway'] && ferme) {
        couches.surfaces.push({ type: 'Feature', properties: { ...props, surface: 'voirie' }, geometry: { type: 'Polygon', coordinates: [coords] } });
      } else if (t.highway) {
        if (t.area === 'yes' && ferme) {
          couches.surfaces.push({ type: 'Feature', properties: { ...props, surface: 'pietonne' }, geometry: { type: 'Polygon', coordinates: [coords] } });
        } else {
          couches.voirie.push({ type: 'Feature', properties: props, geometry: { type: 'LineString', coordinates: coords } });
        }
      } else if (ferme && (t.leisure || t.landuse)) {
        couches.surfaces.push({ type: 'Feature', properties: { ...props, surface: 'vegetal' }, geometry: { type: 'Polygon', coordinates: [coords] } });
      } else if (ferme && t.amenity === 'parking') {
        couches.surfaces.push({ type: 'Feature', properties: { ...props, surface: 'parking' }, geometry: { type: 'Polygon', coordinates: [coords] } });
      } else if (ferme && t.natural === 'water') {
        couches.surfaces.push({ type: 'Feature', properties: { ...props, surface: 'eau' }, geometry: { type: 'Polygon', coordinates: [coords] } });
      }
      continue;
    }

    if (el.type === 'relation' && el.members) {
      if (t.building) {
        const ext = [], int = [];
        for (const m of el.members) {
          if (m.type !== 'way' || !m.geometry) continue;
          const c = m.geometry.map(versLonLat).filter(Boolean);
          (m.role === 'inner' ? int : ext).push(c);
        }
        const exterieurs = assemblerAnneaux(ext);
        const interieurs = assemblerAnneaux(int);
        if (!exterieurs.length) continue;
        const polys = exterieurs.map((a) => [a]);
        // trous rattachés au premier anneau extérieur (suffisant pour un bâti de centre ancien)
        if (interieurs.length) polys[0].push(...interieurs);
        couches.batiments.push({ type: 'Feature', properties: props, geometry: { type: 'MultiPolygon', coordinates: polys } });
      } else if (t.route === 'bus' || t.route === 'tram') {
        const ref = t.ref || t.name || `ligne ${el.id}`;
        for (const m of el.members) {
          if (m.type !== 'way' || !m.geometry) continue;
          // les nœuds hors emprise arrivent vides : on coupe la ligne à ces endroits
          let morceau = [];
          const morceaux = [];
          for (const g of m.geometry) {
            if (g && typeof g.lat === 'number') morceau.push([g.lon, g.lat]);
            else { if (morceau.length > 1) morceaux.push(morceau); morceau = []; }
          }
          if (morceau.length > 1) morceaux.push(morceau);
          morceaux.forEach((mc, i) => {
            const cle = `${m.ref}-${i}`;
            if (!lignesParVoie.has(cle)) lignesParVoie.set(cle, { coords: mc, lignes: new Set(), modes: new Set() });
            lignesParVoie.get(cle).lignes.add(ref);
            lignesParVoie.get(cle).modes.add(t.route);
          });
        }
      }
    }
  }

  for (const [cle, v] of lignesParVoie) {
    couches.lignes.push({
      type: 'Feature',
      properties: { voie: cle, lignes: [...v.lignes].sort(), mode: v.modes.has('tram') ? 'tram' : 'bus' },
      geometry: { type: 'LineString', coordinates: v.coords },
    });
  }

  const res = {};
  for (const k of Object.keys(couches)) res[k] = collection(couches[k]);
  return res;
}

// ------------------------------------------------------------------
// IGN : BD TOPO (bâtiments avec hauteur mesurée) via le WFS de la Géoplateforme
// ------------------------------------------------------------------

export async function interrogerBDTopo(emprise, journal = () => {}) {
  const bbox = `${emprise.sud},${emprise.ouest},${emprise.nord},${emprise.est},urn:ogc:def:crs:EPSG::4326`;
  const url = 'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature'
    + '&TYPENAMES=BDTOPO_V3:batiment&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326&COUNT=5000'
    + `&BBOX=${encodeURIComponent(bbox)}`;
  journal('Interrogation de la BD TOPO (IGN)…');
  const r = await fetch(url);
  if (!r.ok) throw new Error(`BD TOPO : réponse ${r.status}`);
  const json = await r.json();
  // Certains serveurs renvoient les coordonnées en [lat, lon] pour EPSG:4326 : on détecte et on corrige.
  const echantillon = premiereCoordonnee(json.features?.[0]?.geometry);
  const inverser = echantillon && Math.abs(echantillon[0] - emprise.sud) < 1 && Math.abs(echantillon[1] - emprise.ouest) < 1;
  for (const f of json.features || []) {
    f.geometry = nettoyerGeometrie(f.geometry, inverser);
    const p = f.properties || {};
    f.properties = {
      source: 'BD TOPO',
      id_ign: p.cleabs ?? f.id,
      hauteur: nombre(p.hauteur),
      niveaux: nombre(p.nombre_d_etages),
      usage: p.usage_1 ?? null,
      date_apparition: p.date_d_apparition ?? null,
    };
  }
  journal(`${json.features?.length ?? 0} bâtiments BD TOPO reçus${inverser ? ' (coordonnées remises dans l\'ordre)' : ''}.`);
  return json;
}

function nombre(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

function premiereCoordonnee(g) {
  if (!g) return null;
  let c = g.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return c;
}

function nettoyerGeometrie(g, inverser) {
  const f = (c) => (inverser ? [c[1], c[0]] : [c[0], c[1]]);
  const parcourir = (c) => (typeof c[0] === 'number' ? f(c) : c.map(parcourir));
  return { type: g.type, coordinates: parcourir(g.coordinates) };
}

// ------------------------------------------------------------------
// IGN : fonds de plan (photos aériennes, cartes anciennes) assemblés en une image
// Les caractéristiques de chaque couche (style, format, zoom maximal) sont lues
// dans le catalogue WMTS de la Géoplateforme, pour éviter les noms de style erronés.
// ------------------------------------------------------------------

const WMTS = 'https://data.geopf.fr/wmts';
let catalogue = null;

export async function catalogueWMTS() {
  if (catalogue) return catalogue;
  catalogue = (async () => {
    const r = await fetch(`${WMTS}?SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0`);
    if (!r.ok) throw new Error(`catalogue WMTS : réponse ${r.status}`);
    const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
    const couches = new Map();
    for (const c of xml.getElementsByTagName('Layer')) {
      const enfant = (nom) => [...c.children].filter((e) => e.localName === nom);
      const id = enfant('Identifier')[0]?.textContent;
      if (!id) continue;
      const styles = enfant('Style').map((st) => ({
        id: [...st.children].find((e) => e.localName === 'Identifier')?.textContent,
        defaut: st.getAttribute('isDefault') === 'true',
      }));
      const formats = enfant('Format').map((f) => f.textContent);
      let zmax = 18, zmin = 0;
      for (const lien of enfant('TileMatrixSetLink')) {
        // grille « PM » ou, depuis 2026, « PM_6_15 » (zooms 6 à 15) ; les tuiles se demandent toujours avec TILEMATRIXSET=PM
        const tms = [...lien.children].find((e) => e.localName === 'TileMatrixSet')?.textContent;
        const m = /^PM(?:_(\d+)_(\d+))?$/.exec(tms || '');
        if (!m) continue;
        if (m[1]) { zmin = +m[1]; zmax = +m[2]; }
        const niveaux = [...lien.getElementsByTagNameNS('*', 'TileMatrix')].map((e) => parseInt(e.textContent, 10)).filter(Number.isFinite);
        if (niveaux.length) { zmax = Math.max(...niveaux); zmin = Math.min(...niveaux); }
      }
      couches.set(id, {
        style: (styles.find((x) => x.defaut) || styles[0])?.id || 'normal',
        format: formats.find((f) => f.includes('jpeg')) || formats[0] || 'image/png',
        zmax, zmin,
        titre: enfant('Title')[0]?.textContent,
      });
    }
    return couches;
  })();
  catalogue.catch(() => { catalogue = null; });
  return catalogue;
}

function tuileDepuisLonLat(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  return { x, y };
}
function lonLatDepuisTuile(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  return { lon, lat };
}

function chargerImage(url) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error('image indisponible'));
    img.src = url;
  });
}

function urlTuile(layer, style, format, z, x, y) {
  return `${WMTS}?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0`
    + `&LAYER=${encodeURIComponent(layer)}&STYLE=${encodeURIComponent(style)}&TILEMATRIXSET=PM&TILEMATRIX=${z}&TILEROW=${y}&TILECOL=${x}`
    + `&FORMAT=${encodeURIComponent(format)}`;
}

// Session Google Map Tiles API (clé personnelle, facturée au-delà du quota gratuit)
async function sessionGoogle(fond) {
  const cle = fond.cle || localStorage.getItem('atlas-hdv-cle-google');
  if (!cle) throw new Error('clé Google Maps absente : renseignez-la dans le panneau Couches');
  const r = await fetch(`https://tile.googleapis.com/v1/createSession?key=${encodeURIComponent(cle)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mapType: fond.mapType || 'satellite', language: 'fr-FR', region: 'FR', ...(fond.mapType === 'terrain' ? { layerTypes: ['layerRoadmap'] } : {}) }),
  });
  if (!r.ok) throw new Error(`Google Map Tiles : réponse ${r.status} (clé, facturation ou API non activée ?)`);
  const s = await r.json();
  return { cle, session: s.session };
}

// fond : { id, nom, type: 'wmts' | 'xyz' | 'google', layer | url, zoom? } ; renvoie { canvas, bornes, zoom }
export async function assemblerFond(emprise, fond, journal = () => {}) {
  let def;
  let url;
  if (fond.type === 'xyz') {
    def = { zmax: fond.zmax ?? 19 };
    url = (z, x, y) => fond.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  } else if (fond.type === 'google') {
    const { cle, session } = await sessionGoogle(fond);
    def = { zmax: 20 };
    url = (z, x, y) => `https://tile.googleapis.com/v1/2dtiles/${z}/${x}/${y}?session=${session}&key=${encodeURIComponent(cle)}`;
  } else {
    try {
      def = (await catalogueWMTS()).get(fond.layer);
    } catch (e) {
      journal(`Catalogue IGN illisible (${e.message}), essai avec des réglages par défaut.`);
    }
    if (!def) {
      if (catalogue) journal(`La couche ${fond.layer} n'est pas au catalogue de la Géoplateforme.`);
      def = { style: 'normal', format: 'image/jpeg', zmax: 18 };
    }
    url = (z, x, y) => urlTuile(fond.layer, def.style, def.format, z, x, y);
  }
  const z = Math.min(fond.zoom ?? 18, def.zmax ?? 18);
  const a = tuileDepuisLonLat(emprise.ouest, emprise.nord, z);
  const b = tuileDepuisLonLat(emprise.est, emprise.sud, z);
  const x0 = Math.floor(a.x), y0 = Math.floor(a.y), x1 = Math.floor(b.x), y1 = Math.floor(b.y);
  const canvas = document.createElement('canvas');
  canvas.width = (x1 - x0 + 1) * 256;
  canvas.height = (y1 - y0 + 1) * 256;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e8e6df';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  let reussies = 0;
  const taches = [];
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      taches.push(chargerImage(url(z, x, y))
        .then((img) => { ctx.drawImage(img, (x - x0) * 256, (y - y0) * 256); reussies++; })
        .catch(() => {}));
    }
  }
  await Promise.all(taches);
  if (!reussies) throw new Error(`aucune tuile reçue pour « ${fond.nom} »${fond.layer ? ` (couche ${fond.layer}, style ${def.style}, zoom ${z})` : ''}`);
  const no = lonLatDepuisTuile(x0, y0, z);
  const se = lonLatDepuisTuile(x1 + 1, y1 + 1, z);
  journal(`${fond.nom} : ${reussies}/${taches.length} tuiles, zoom ${z}.`);
  return { canvas, bornes: { nord: no.lat, ouest: no.lon, sud: se.lat, est: se.lon }, zoom: z };
}

// ------------------------------------------------------------------
// Cadastre (API Carto de l'IGN, Parcellaire Express)
// ------------------------------------------------------------------

export async function interrogerCadastre(emprise, journal = () => {}) {
  const geom = {
    type: 'Polygon',
    coordinates: [[[emprise.ouest, emprise.sud], [emprise.est, emprise.sud], [emprise.est, emprise.nord], [emprise.ouest, emprise.nord], [emprise.ouest, emprise.sud]]],
  };
  const vus = new Map();
  const limite = 1000;
  for (let debut = 0; debut < 20000; debut += limite) {
    const url = `https://apicarto.ign.fr/api/cadastre/parcelle?geom=${encodeURIComponent(JSON.stringify(geom))}&_limit=${limite}&_start=${debut}`;
    journal(`Cadastre : lecture des parcelles ${debut + 1} à ${debut + limite}…`);
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(`API Carto cadastre : réponse ${r.status}`);
    const json = await r.json();
    const lot = json.features || [];
    for (const f of lot) {
      const p = f.properties || {};
      const idu = p.idu || `${p.code_insee || ''}${p.com_abs || '000'}${p.section}${String(p.numero).padStart(4, '0')}`;
      vus.set(idu, {
        type: 'Feature',
        properties: {
          idu,
          section: p.section,
          numero: String(parseInt(p.numero, 10)),
          contenance: p.contenance ?? null,
          commune: p.code_insee ?? null,
        },
        geometry: f.geometry,
      });
    }
    if (lot.length < limite) break;
  }
  journal(`${vus.size} parcelles cadastrales reçues.`);
  return { type: 'FeatureCollection', features: [...vus.values()] };
}

// Météo : voir js/meteo.js (data/meteo/meteo.json, Météo-France ; plus aucun appel à Open-Meteo).

// ------------------------------------------------------------------
// Topographie : altitudes du RGE ALTI (IGN) sur une grille régulière
// ------------------------------------------------------------------

// grille : { x0, z0, pas, nx, nz } en mètres locaux ; proj : projection de l'atlas
export async function interrogerAltitudes(grille, proj, journal = () => {}) {
  const pts = [];
  for (let j = 0; j < grille.nz; j++) {
    for (let i = 0; i < grille.nx; i++) {
      const g = proj.versGeo(grille.x0 + i * grille.pas, grille.z0 + j * grille.pas);
      pts.push([+g.lon.toFixed(7), +g.lat.toFixed(7)]);
    }
  }
  const z = new Float32Array(pts.length);
  const lot = 4000;
  for (let k = 0; k < pts.length; k += lot) {
    const part = pts.slice(k, k + lot);
    journal(`Topographie : altitudes ${k + 1} à ${k + part.length} sur ${pts.length}…`);
    const r = await fetch('https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        lon: part.map((p) => p[0]).join('|'), lat: part.map((p) => p[1]).join('|'),
        resource: 'ign_rge_alti_wld', delimiter: '|', indent: 'false', measures: 'false', zonly: 'true',
      }),
    });
    if (!r.ok) throw new Error(`altimétrie IGN : réponse ${r.status}`);
    const json = await r.json();
    const vals = (json.elevations || []).map((v) => (typeof v === 'number' ? v : v.z));
    vals.forEach((v, i) => { z[k + i] = v <= -9999 ? NaN : v; });
    await new Promise((ok) => setTimeout(ok, 300)); // 5 requêtes par seconde au plus
  }
  return { ...grille, z: Array.from(z, (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null)), source: 'IGN, RGE ALTI (API de calcul altimétrique de la Géoplateforme)' };
}

// ------------------------------------------------------------------
// Open Data Nantes Métropole : recherche de jeux de données (réseaux…) et export GeoJSON
// ------------------------------------------------------------------

const ODS = 'https://data.nantesmetropole.fr/api/explore/v2.1/catalog/datasets';

export async function chercherJeux(mots) {
  // (le catalogue refuse désormais select=metas : on reçoit les fiches complètes)
  const url = `${ODS}?where=${encodeURIComponent(`"${mots}"`)}&refine=${encodeURIComponent('features:geo')}&limit=30`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`catalogue Open Data : réponse ${r.status}`);
  const json = await r.json();
  return (json.results || []).map((d) => ({ id: d.dataset_id, titre: d.metas?.default?.title || d.dataset_id, description: (d.metas?.default?.description || '').replace(/<[^>]+>/g, ' ').slice(0, 240) }));
}

export async function lireJeuGeo(id, emprise) {
  const bbox = `in_bbox(geo_point_2d, ${emprise.sud}, ${emprise.ouest}, ${emprise.nord}, ${emprise.est})`;
  let r = await fetch(`${ODS}/${id}/exports/geojson?where=${encodeURIComponent(bbox)}&limit=-1`);
  if (!r.ok) r = await fetch(`${ODS}/${id}/exports/geojson?limit=5000`); // jeu sans champ geo_point_2d : filtrage dans l'atlas
  if (!r.ok) throw new Error(`jeu ${id} : réponse ${r.status}`);
  const json = await r.json();
  const dedans = ([lon, lat]) => lon >= emprise.ouest && lon <= emprise.est && lat >= emprise.sud && lat <= emprise.nord;
  const premier = (g) => { let c = g?.coordinates; while (Array.isArray(c?.[0])) c = c[0]; return c; };
  json.features = (json.features || []).filter((f) => f.geometry && (() => {
    // garder si au moins un sommet est dans l'emprise
    const parcourir = (c) => (typeof c[0] === 'number' ? dedans(c) : c.some(parcourir));
    return parcourir(f.geometry.coordinates) || dedans(premier(f.geometry) || [0, 0]);
  })());
  return json;
}

// ------------------------------------------------------------------
// Cartes de bruit stratégiques de l'État en Loire-Atlantique (DDTM 44, 4e échéance, 2022)
// Zones de bruit « type A » par tranches de 5 dB(A), routes et voies ferrées, Lden et Ln.
// Service WFS de Géo-IDE (GML en Lambert-93 seulement), CORS ouvert.
// ------------------------------------------------------------------

export const CARTES_BRUIT_ETAT = [
  { uuid: '56e20800-dd3b-49ee-895a-e8f118f48ad0', couche: 'N_BRUIT_ZBR_R_A_LD_S_044', indicateur: 'Lden', source: 'routes' },
  { uuid: '9aa102a0-d7c9-48a0-8f5d-06c3a15d5ac5', couche: 'N_BRUIT_ZBR_R_A_LN_S_044', indicateur: 'Ln', source: 'routes' },
  { uuid: '16049988-8fbe-4fd3-a55d-80a117e8d6dd', couche: 'N_BRUIT_ZBR_INFRA_F_A_LD_S_044', indicateur: 'Lden', source: 'voies ferrées' },
  { uuid: '3650ef8f-539f-4add-a798-4414bf0b979b', couche: 'N_BRUIT_ZBR_INFRA_F_A_LN_S_044', indicateur: 'Ln', source: 'voies ferrées' },
];

// Lambert-93 -> WGS84 (formules de l'IGN, ellipsoïde GRS80)
export function depuisLambert93(X, Y) {
  const n = 0.7256077650532670, C = 11754255.426096, Xs = 700000, Ys = 12655612.049876, e = 0.0818191910428158, l0 = (3 * Math.PI) / 180;
  const dx = X - Xs, dy = Y - Ys;
  const R = Math.hypot(dx, dy), g = Math.atan2(dx, -dy);
  const L = -Math.log(Math.abs(R / C)) / n;
  let phi = 2 * Math.atan(Math.exp(L)) - Math.PI / 2;
  for (let i = 0; i < 12; i++) phi = 2 * Math.atan(((1 + e * Math.sin(phi)) / (1 - e * Math.sin(phi))) ** (e / 2) * Math.exp(L)) - Math.PI / 2;
  return [+(((l0 + g / n) * 180) / Math.PI).toFixed(7), +((phi * 180) / Math.PI).toFixed(7)];
}

export async function lireCartesBruitEtat(emprise, journal = () => {}) {
  const GML = 'http://www.opengis.net/gml';
  const features = [];
  for (const c of CARTES_BRUIT_ETAT) {
    journal(`Carte de bruit de l'État : ${c.source}, ${c.indicateur}…`);
    const url = `https://ogc.geo-ide.developpement-durable.gouv.fr/wxs?map=/opt/data/stack/mapfiles/1.4/org_38030/${c.uuid}.internet.map`
      + `&SERVICE=WFS&VERSION=1.1.0&REQUEST=GetFeature&TYPENAME=ms:${c.couche}&SRSNAME=EPSG:2154`
      + `&BBOX=${emprise.sud},${emprise.ouest},${emprise.nord},${emprise.est},EPSG:4326`
      + `&OUTPUTFORMAT=${encodeURIComponent('text/xml; subtype=gml/2.1.2')}`;
    const r = await fetch(url);
    if (!r.ok) throw new Error(`Géo-IDE : réponse ${r.status}`);
    const xml = new DOMParser().parseFromString(await r.text(), 'application/xml');
    for (const fm of xml.getElementsByTagNameNS(GML, 'featureMember')) {
      const el = fm.firstElementChild;
      if (!el) continue;
      const attr = (nom) => [...el.children].find((x) => x.localName === nom)?.textContent?.trim();
      const polys = [...el.getElementsByTagNameNS(GML, 'Polygon')].map((p) => [...p.getElementsByTagNameNS(GML, 'LinearRing')].map((lr) =>
        lr.getElementsByTagNameNS(GML, 'coordinates')[0].textContent.trim().split(/\s+/).map((t) => depuisLambert93(...t.split(',').map(Number)))));
      const niveau = parseFloat(attr('LEGENDE'));
      if (!polys.length || !Number.isFinite(niveau)) continue;
      features.push({
        type: 'Feature',
        properties: { indicateur: c.indicateur, db_lo: niveau, source: c.source, annee: parseInt(attr('ANNEE'), 10) || null, producteur: 'DDTM 44', id: attr('IDZONBRUIT') },
        geometry: { type: 'MultiPolygon', coordinates: polys },
      });
    }
  }
  journal(`${features.length} zones de bruit reçues.`);
  return { type: 'FeatureCollection', source: 'Cartes de bruit stratégiques de l\'État en Loire-Atlantique (DDTM 44), 4e échéance 2022, zones de type A ; Licence Ouverte', features };
}

// ------------------------------------------------------------------
// Parkings publics de Nantes (Open Data Nantes Métropole, temps réel)
// Le modèle de données de ce jeu a changé le 28/07/2026 : la lecture des champs est volontairement tolérante.
// ------------------------------------------------------------------

export async function lireParkings(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`parkings : réponse ${r.status}`);
  const json = await r.json();
  const enregistrements = json.results || json.records?.map((x) => x.fields || x.record?.fields) || [];
  return enregistrements.map(normaliserParking).filter((p) => p.lat != null);
}

export function normaliserParking(e) {
  const cles = Object.keys(e);
  const trouver = (re, filtre = () => true) => cles.find((k) => re.test(k) && filtre(e[k]));
  const num = (v) => (typeof v === 'number' ? v : parseFloat(v));
  const kNom = trouver(/(^|_)(nom|name|libelle)/i, (v) => typeof v === 'string');
  const kDispo = trouver(/dispo|disponible|libre/i, (v) => Number.isFinite(num(v)));
  const kCapa = trouver(/exploitation|capacit|total|max/i, (v) => Number.isFinite(num(v)));
  const kStatut = trouver(/statut|status/i);
  let lat = null, lon = null;
  const kGeo = trouver(/geo_point|location|coord|position|geo/i, (v) => v && typeof v === 'object');
  if (kGeo) {
    const g = e[kGeo];
    if (Array.isArray(g)) { lat = num(g[0]); lon = num(g[1]); }
    else if (g.lat != null) { lat = num(g.lat); lon = num(g.lon ?? g.lng); }
    else if (g.coordinates) { lon = num(g.coordinates[0]); lat = num(g.coordinates[1]); }
  }
  return {
    nom: kNom ? e[kNom] : 'Parking',
    disponibles: kDispo ? num(e[kDispo]) : null,
    capacite: kCapa ? num(e[kCapa]) : null,
    statut: kStatut ? e[kStatut] : null,
    lat, lon,
  };
}

// ------------------------------------------------------------------
// Téléchargement d'un fichier produit dans le navigateur
// ------------------------------------------------------------------

// Enregistrement d'un fichier de données directement à sa place dans data/ (chemin relatif à data/),
// quand l'atlas est servi par serveur.py ; sinon (version en ligne), téléchargement classique.
let signaler = (t) => console.info(t);
export function definirSignaleur(fn) { signaler = fn; }

export async function enregistrerDonnees(chemin, contenu, { type = 'application/json', apres = null } = {}) {
  const blob = contenu instanceof Blob ? contenu : new Blob([contenu], { type });
  try {
    const r = await fetch(`__enregistrer/data/${chemin.split('/').map(encodeURIComponent).join('/')}`, { method: 'POST', body: blob });
    const rep = r.ok ? await r.json() : null;
    if (rep?.ok) {
      signaler(`Enregistré dans data/${chemin}${rep.sauvegarde ? ' (ancienne version gardée dans data/.sauvegardes)' : ''}${apres ? ` : ${apres}` : ''}.`);
      return 'serveur';
    }
  } catch { /* pas de serveur local : téléchargement */ }
  const nom = chemin.split('/').pop();
  const dossier = ['data', ...chemin.split('/').slice(0, -1)].join('/');
  telecharger(nom, blob);
  signaler(`${nom} téléchargé : placez-le dans ${dossier}/${apres ? ` (${apres})` : ''}.`);
  return 'telechargement';
}

export function telecharger(nom, contenu, type = 'application/json') {
  const blob = contenu instanceof Blob ? contenu : new Blob([contenu], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = nom;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
