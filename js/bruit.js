import * as THREE from 'three';
import { h } from './util.js';
import { chercherJeux, lireJeuGeo, lireCartesBruitEtat, enregistrerDonnees } from './donnees.js';
import { lireCache, ecrireCache } from './cache.js';
import { empriseAutour, polygonesLocaux } from './geo.js';
import { geometriesPlates } from './maquette.js';

// Carte du bruit : zones de bruit des cartes de bruit stratégiques (directive européenne 2002/49/CE),
// indicateurs Lden (moyenne jour-soir-nuit) ou Ln (nuit), par tranches de 5 dB(A).
// Couleurs proches de la norme NF S 31-130.
export const CLASSES_BRUIT = [
  { min: 0, max: 50, libelle: 'moins de 50 dB(A)', couleur: '#b9dca4' },
  { min: 50, max: 55, libelle: '50 à 55 dB(A)', couleur: '#f0e442' },
  { min: 55, max: 60, libelle: '55 à 60 dB(A)', couleur: '#f7b32b' },
  { min: 60, max: 65, libelle: '60 à 65 dB(A)', couleur: '#ef7d2d' },
  { min: 65, max: 70, libelle: '65 à 70 dB(A)', couleur: '#d7263d' },
  { min: 70, max: 75, libelle: '70 à 75 dB(A)', couleur: '#8e2b53' },
  { min: 75, max: 200, libelle: 'plus de 75 dB(A)', couleur: '#3d3d9e' },
];
const CLE = 'atlas-hdv-bruit';

// Niveau (borne basse) lu dans les attributs, quelle que soit la forme du jeu de données
export function niveauDe(props) {
  const valeurs = Object.entries(props || {});
  for (const [k, v] of valeurs) {
    if (/db_?lo|dblo|isolevel|niv_?min|lden_?min|classe_?min/i.test(k) && Number.isFinite(parseFloat(v))) return parseFloat(v);
  }
  for (const [, v] of valeurs) {
    const s = String(v ?? '');
    let m = s.match(/(\d{2})\s*(?:-|à|a|_|\/)\s*(\d{2})\s*(?:db)?/i);
    if (m && +m[2] - +m[1] === 5) return +m[1];
    m = s.match(/(?:>|sup[ée]rieur\s*(?:à|a)?|plus de)\s*(\d{2})/i);
    if (m) return +m[1];
  }
  for (const [k, v] of valeurs) {
    if (/lden|niveau|db|legende|classe/i.test(k) && Number.isFinite(parseFloat(v)) && parseFloat(v) >= 40 && parseFloat(v) <= 90) return parseFloat(v);
  }
  return null;
}
const classeDe = (n) => CLASSES_BRUIT.find((c) => n >= c.min && n < c.max) || null;

export function creerBruit(app) {
  const groupe = new THREE.Group();
  groupe.name = 'bruit';
  app.scene.add(groupe);
  const etat = { jeu: null, fc: null, nuit: false, resume: null };
  const ui = {};
  const emprise = () => empriseAutour(app.config.origine.lat, app.config.origine.lon, app.config.rayonEtude * 1.1);

  function dessiner() {
    groupe.clear();
    if (!etat.fc) return;
    const parClasse = new Map();
    let sansNiveau = 0;
    for (const f of etat.fc.features) {
      const p = f.properties || {};
      // si le jeu mélange Lden et Ln, on garde l'indicateur choisi
      const indic = Object.values(p).map(String).join(' ');
      const nuit = /\bLn\b|[-_]LN\b|nuit|night/i.test(indic), jour = /lden|[-_]LD\b/i.test(indic);
      if (nuit && !jour && !etat.nuit) continue;
      if (etat.nuit && jour && !nuit) continue;
      const n = niveauDe(p);
      const c = n == null ? null : classeDe(n);
      if (!c) { sansNiveau++; continue; }
      const polys = polygonesLocaux(f.geometry, app.proj);
      if (!parClasse.has(c)) parClasse.set(c, []);
      parClasse.get(c).push(...polys);
    }
    const rang = new Map(CLASSES_BRUIT.map((c, i) => [c, i]));
    for (const [c, polys] of parClasse) {
      const geos = geometriesPlates(polys, 0.34 + rang.get(c) * 0.004);
      if (!geos.length) continue;
      for (const g of geos) {
        const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: c.couleur, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -12 - rang.get(c), polygonOffsetUnits: -12 }));
        m.renderOrder = 6 + rang.get(c) * 0.1;
        m.raycast = () => {};
        m.userData.classe = c;
        groupe.add(m);
      }
    }
    etat.resume = { classes: [...parClasse.keys()].sort((a, b) => rang.get(a) - rang.get(b)), sansNiveau, total: etat.fc.features.length };
    groupe.visible = !!app.couches.bruit;
  }

  async function charger(id, titre) {
    const cle = `bruit-${id}-${app.cleZone}`;
    let fc = await lireCache(cle, 90);
    if (!fc) {
      if (!navigator.onLine || app.mode === 'borne') throw new Error('hors ligne : jeu non disponible');
      fc = await lireJeuGeo(id, emprise());
      await ecrireCache(cle, fc);
    }
    etat.jeu = { id, titre };
    etat.fc = fc;
    localStorage.setItem(CLE, JSON.stringify(etat.jeu));
    app.couches.bruit = true;
    dessiner();
    app.emettre('couches');
  }

  // Cartes de bruit stratégiques de l'État (DDTM 44), lues en direct pour le périmètre d'étude
  async function chargerEtat() {
    const id = 'etat-ddtm44';
    const cle = `bruit-${id}-${app.cleZone}`;
    let fc = await lireCache(cle, 365);
    if (!fc) {
      if (!navigator.onLine || app.mode === 'borne') throw new Error('hors ligne : cartes non disponibles');
      fc = await lireCartesBruitEtat(emprise(), (t) => { if (ui.liste?.isConnected) ui.liste.replaceChildren(h('p', { class: 'note' }, t)); });
      await ecrireCache(cle, fc);
    }
    etat.jeu = { id, titre: 'Cartes de bruit stratégiques de l\'État (DDTM 44, 2022), routes et voies ferrées' };
    etat.fc = fc;
    localStorage.setItem(CLE, JSON.stringify(etat.jeu));
    app.couches.bruit = true;
    dessiner();
    app.emettre('couches');
  }

  function importer(fichier) {
    return fichier.text().then((t) => {
      const fc = JSON.parse(t);
      if (!fc.features) throw new Error('le fichier n\'est pas un GeoJSON');
      etat.jeu = { id: `fichier-${fichier.name}`, titre: fichier.name };
      etat.fc = fc;
      ecrireCache(`bruit-${etat.jeu.id}-${app.cleZone}`, fc);
      localStorage.setItem(CLE, JSON.stringify(etat.jeu));
      app.couches.bruit = true;
      dessiner();
      app.emettre('couches');
    });
  }

  async function construire() {
    const memo = (() => { try { return JSON.parse(localStorage.getItem(CLE) || 'null'); } catch { return null; } })() || app.config.bruit || null;
    let fc = await (await fetch('data/bruit.geojson').then((r) => (r.ok ? r.json() : null)).catch(() => null));
    if (fc) { etat.jeu = { id: 'fichier', titre: 'data/bruit.geojson' }; etat.fc = fc; dessiner(); return; }
    if (memo) {
      fc = await lireCache(`bruit-${memo.id}-${app.cleZone}`, 365);
      if (!fc && memo.id === 'etat-ddtm44' && navigator.onLine && app.mode !== 'borne') { try { await chargerEtat(); return; } catch { /* hors ligne */ } }
      if (fc) { etat.jeu = memo; etat.fc = fc; dessiner(); }
    }
  }

  async function chercher() {
    ui.liste.replaceChildren(h('p', { class: 'note' }, 'Recherche des cartes de bruit dans l\'Open Data de Nantes Métropole…'));
    try {
      const res = [...await chercherJeux('bruit')].filter((d) => /bruit|sonore|lden|isophone/i.test(`${d.titre} ${d.description}`));
      ui.liste.replaceChildren(res.length
        ? h('ul', { class: 'liste-jeux' }, ...res.map((d) => h('li', {},
          h('div', {}, h('strong', {}, d.titre), h('span', { class: 'note' }, d.description)),
          h('button', { type: 'button', class: 'bouton petit', onclick: async (e) => { e.target.disabled = true; try { await charger(d.id, d.titre); rafraichir(); } catch (err) { app.signaler(`Carte de bruit illisible : ${err.message}`); e.target.disabled = false; } } }, 'Afficher'))))
        : h('p', { class: 'note' }, 'Aucune carte de bruit trouvée dans le catalogue. Importez un fichier GeoJSON (voir ci-dessous).'));
    } catch (e) {
      ui.liste.replaceChildren(h('p', { class: 'note' }, `Catalogue indisponible : ${e.message}`));
    }
  }

  let conteneurPanneau = null;
  function rafraichir() { if (conteneurPanneau?.isConnected) { conteneurPanneau.replaceChildren(); construirePanneau(conteneurPanneau); } }

  function construirePanneau(conteneur) {
    conteneurPanneau = conteneur;
    ui.liste = h('div');
    const fichier = h('input', { type: 'file', accept: '.geojson,.json,application/json', hidden: true, onchange: async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await importer(f); rafraichir(); } catch (err) { app.signaler(`Import impossible : ${err.message}`); } } });
    const r = etat.resume;
    conteneur.append(...[
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: !!app.couches.bruit, onchange: (e) => { app.couches.bruit = e.target.checked; groupe.visible = e.target.checked; } }), 'Afficher la carte du bruit'),
      h('div', { class: 'choix', role: 'radiogroup' }, ...[[false, 'Lden (jour, soir, nuit)'], [true, 'Ln (nuit)']].map(([v, l]) => h('label', {},
        h('input', { type: 'radio', name: 'indic-bruit', checked: etat.nuit === v, onchange: () => { etat.nuit = v; dessiner(); rafraichir(); } }), l))),
      etat.jeu ? h('p', { class: 'resultat' }, `${etat.jeu.titre} : ${r?.total ?? 0} zones${r?.sansNiveau ? `, dont ${r.sansNiveau} sans niveau lisible` : ''}.`) : h('p', { class: 'note' }, 'Aucune carte de bruit chargée.'),
      h('ul', { class: 'legende' }, ...CLASSES_BRUIT.filter((c) => !r || r.classes.includes(c)).map((c) => h('li', {}, h('i', { style: { background: c.couleur } }), c.libelle))),
      h('p', { class: 'note' }, 'Cartes de bruit stratégiques : niveaux calculés à 4 m de hauteur, moyennés sur l\'année. Le Lden pondère plus fortement le soir et la nuit. Au-delà de 68 dB(A) en Lden pour le bruit routier, la valeur limite réglementaire est dépassée.'),
      app.mode !== 'borne' ? h('h3', {}, 'Trouver une carte de bruit') : null,
      app.mode !== 'borne' ? h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: async (e) => { e.target.disabled = true; try { await chargerEtat(); rafraichir(); } catch (err) { app.signaler(`Cartes de l'État indisponibles : ${err.message}`); e.target.disabled = false; } } }, 'Cartes de l\'État (DDTM 44)'),
        h('button', { type: 'button', class: 'bouton discret', onclick: chercher }, 'Chercher dans l\'Open Data'),
        h('button', { type: 'button', class: 'bouton discret', onclick: () => fichier.click() }, 'Importer un GeoJSON')) : null,
      etat.fc && etat.jeu?.id !== 'fichier' && app.mode === 'presentateur' ? h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton discret petit', onclick: () => enregistrerDonnees('bruit.geojson', JSON.stringify(etat.fc), { type: 'application/geo+json', apres: 'affichée d\'office, y compris sur la borne hors ligne' }) }, 'Enregistrer dans data/bruit.geojson')) : null,
      fichier,
      ui.liste,
      h('p', { class: 'note' }, 'Cartes de l\'État : zones de bruit du réseau routier autoroutier, national et départemental et des voies ferrées (cartes de bruit stratégiques 2022 de la DDTM de Loire-Atlantique, type A). Les rues communales n\'y figurent pas : leur bruit relève de la carte de l\'agglomération de Nantes Métropole, qui n\'est pas publiée en données ouvertes (la demander au service environnement de la métropole, puis l\'importer en GeoJSON). Le fichier data/bruit.geojson, s\'il existe, est affiché d\'office.'),
    ].filter(Boolean));
  }

  app.on('couches', () => { groupe.visible = !!app.couches.bruit; });

  return { construire, construirePanneau, charger, etat, niveauDe, get zones() { return etat.fc; }, estNuit: () => etat.nuit };
}
