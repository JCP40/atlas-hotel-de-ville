import * as THREE from 'three';
import { h } from './util.js';
import { enregistrerDonnees } from './donnees.js';
import { CERTITUDES, CONSTRUCTEURS } from './couches.js';
import { construireArbres } from './maquette.js';
import { pointDansPolygone } from './geo.js';

// Outil de relevé : dessiner directement sur la maquette les éléments de l'atlas
// (emprises disparues, parcelles, magnolias),
// les renseigner, puis exporter le fichier GeoJSON à placer dans /data.
const COUCHES = {
  fantomes: {
    libelle: 'Bâti disparu (fantôme)', geometrie: 'Polygon', fichier: 'fantomes.geojson',
    champs: [
      ['nom', 'Nom', 'texte'], ['niveaux', 'Nombre de niveaux', 'nombre'], ['hauteur', 'Hauteur à l\'égout (m)', 'nombre'],
      ['certitude', 'Certitude', Object.fromEntries(Object.entries(CERTITUDES).map(([k, v]) => [k, v.libelle]))],
      ['source', 'Source (plan, photo…)', 'texte'], ['fiche', 'Fiche liée (identifiant)', 'texte'],
    ],
  },
  parcelles: {
    libelle: 'Parcelle', geometrie: 'Polygon', fichier: 'parcelles.geojson',
    champs: [['numero', 'Numéro', 'texte'], ['fiche', 'Fiche liée', 'texte']],
  },
  arbres: {
    libelle: 'Arbre (magnolia…)', geometrie: 'Point', fichier: 'arbres.geojson',
    champs: [['espece', 'Espèce', 'texte'], ['hauteur', 'Hauteur (m)', 'nombre'], ['diametre', 'Diamètre de couronne (m)', 'nombre'], ['fiche', 'Fiche liée', 'texte']],
  },
};

export function creerReleve(app) {
  const etat = { couche: 'fantomes', points: [], dessin: false, aimant: true };
  const apercu = new THREE.Group();
  app.scene.add(apercu);
  const ui = {};

  const collectionDe = (cle) => app.donnees[COUCHES[cle].cible || cle];

  function aimanter([x, z]) {
    if (!etat.aimant) return [x, z];
    let best = null, dmin = 1.5;
    for (const e of app.empreintes || []) {
      for (const [ext] of e.polys) {
        for (const [px, pz] of ext) {
          const d = Math.hypot(px - x, pz - z);
          if (d < dmin) { dmin = d; best = [px, pz]; }
        }
      }
    }
    return best || [x, z];
  }

  function dessinerApercu() {
    apercu.clear();
    if (!etat.points.length) return;
    const pts = etat.points.map(([x, z]) => new THREE.Vector3(x, 0.6, z));
    const def = COUCHES[etat.couche];
    const ferme = def.geometrie === 'Polygon' && pts.length > 2;
    const ligne = new (ferme ? THREE.LineLoop : THREE.Line)(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xc8372d })
    );
    apercu.add(ligne);
    const bille = new THREE.SphereGeometry(0.5, 10, 8);
    const mat = new THREE.MeshBasicMaterial({ color: 0xc8372d });
    for (const p of pts) { const m = new THREE.Mesh(bille, mat); m.position.copy(p); apercu.add(m); }
  }

  function commencer() {
    etat.points = [];
    etat.dessin = true;
    dessinerApercu();
    app.captureSol = (p) => {
      etat.points.push(aimanter(p));
      dessinerApercu();
      majEtat();
      if (COUCHES[etat.couche].geometrie === 'Point') terminer();
      return true; // on garde la main pour les points suivants
    };
    majEtat();
  }

  function annuler() {
    etat.points = [];
    etat.dessin = false;
    app.captureSol = null;
    apercu.clear();
    ui.formulaire?.replaceChildren();
    majEtat();
  }

  function terminer() {
    const def = COUCHES[etat.couche];
    const min = { Polygon: 3, LineString: 2, Point: 1 }[def.geometrie];
    if (etat.points.length < min) { app.signaler(`Il faut au moins ${min} point${min > 1 ? 's' : ''}.`); return; }
    app.captureSol = null;
    etat.dessin = false;
    afficherFormulaire();
    majEtat();
  }

  function geometrie() {
    const def = COUCHES[etat.couche];
    const geo = etat.points.map(([x, z]) => { const g = app.proj.versGeo(x, z); return [+g.lon.toFixed(7), +g.lat.toFixed(7)]; });
    if (def.geometrie === 'Point') return { type: 'Point', coordinates: geo[0] };
    if (def.geometrie === 'LineString') return { type: 'LineString', coordinates: geo };
    return { type: 'Polygon', coordinates: [[...geo, geo[0]]] };
  }

  function afficherFormulaire() {
    const def = COUCHES[etat.couche];
    const champs = def.champs.map(([cle, libelle, type]) => {
      let input;
      if (typeof type === 'object') input = h('select', { name: cle }, ...Object.entries(type).map(([v, l]) => h('option', { value: v }, l)));
      else input = h('input', { name: cle, type: type === 'nombre' ? 'number' : 'text', step: 'any' });
      return h('label', { class: 'champ' }, h('span', {}, libelle), input);
    });
    const form = h('form', { class: 'formulaire' }, ...champs,
      h('div', { class: 'actions' },
        h('button', { type: 'submit', class: 'bouton principal' }, 'Ajouter à la couche'),
        h('button', { type: 'button', class: 'bouton discret', onclick: annuler }, 'Abandonner')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const props = { ...(def.proprietes || {}) };
      for (const [cle, , type] of def.champs) {
        const v = form.elements[cle].value.trim();
        if (v === '') continue;
        props[cle] = type === 'nombre' ? parseFloat(v) : v;
      }
      const col = collectionDe(etat.couche);
      col.features.push({ type: 'Feature', properties: props, geometry: geometrie() });
      reconstruire(etat.couche);
      annuler();
      app.signaler(`Ajouté. Pensez à exporter ${def.fichier}.`);
    });
    ui.formulaire.replaceChildren(h('h3', {}, 'Renseigner'), form);
    form.querySelector('input, select')?.focus();
  }

  function reconstruire(cle) {
    const cible = COUCHES[cle].cible || cle;
    if (CONSTRUCTEURS[cible]) CONSTRUCTEURS[cible](app);
    else if (cible === 'arbres') {
      const ancien = app.arbres?.groupe;
      if (ancien) { app.scene.remove(ancien); app.pickables = app.pickables.filter((p) => !ancien.children.includes(p)); }
      construireArbres(app, app.donnees.arbres, app.donnees.osm.arbres);
    }
    app.temps.appliquer({ instantane: true });
  }

  function exporter() {
    const def = COUCHES[etat.couche];
    const col = collectionDe(etat.couche);
    enregistrerDonnees(def.fichier, JSON.stringify(col, null, 2), { type: 'application/geo+json' });
  }

  // Suppression : cliquer un élément de la couche sur la maquette
  function supprimerParClic() {
    app.signaler('Cliquez l\'élément à supprimer sur la maquette.');
    app.captureObjet = (obj) => {
      app.captureObjet = null;
      const f = obj?.userData?.feature;
      const cle = obj?.userData?.couche;
      if (!f || !cle) { app.signaler('Cet élément ne peut pas être supprimé ici.'); return; }
      const col = app.donnees[cle];
      if (!window.confirm(`Supprimer « ${obj.userData.nom} » de la couche ${cle} ?`)) return;
      col.features = col.features.filter((x) => x !== f);
      reconstruire(cle);
      app.signaler(`Supprimé. Pensez à exporter ${COUCHES[cle].fichier}.`);
    };
  }

  // Désigner un bâtiment existant comme reconstruit après 1943
  function identifierBatiment() {
    app.signaler('Cliquez un bâtiment de la maquette (au pied de sa façade ou sur son emprise).');
    app.captureSol = ([x, z]) => {
      app.captureSol = null;
      const e = (app.empreintes || []).find((em) => em.polys.some(([ext]) => pointDansPolygone(x, z, ext)));
      if (!e) { ui.batiment.replaceChildren(h('p', { class: 'note' }, 'Aucun bâtiment à cet endroit.')); return; }
      const t = app.config.temps ??= { apres1943: [] };
      t.apres1943 ??= [];
      const bascule = (liste, libelle) => h('label', { class: 'case' },
        h('input', { type: 'checkbox', checked: liste.includes(e.id), onchange: (ev) => {
          const i = liste.indexOf(e.id);
          if (ev.target.checked && i < 0) liste.push(e.id);
          if (!ev.target.checked && i >= 0) liste.splice(i, 1);
          app.reconstruireBatiments();
        } }), libelle);
      ui.batiment.replaceChildren(
        h('p', { class: 'resultat' }, `${e.nom || 'Bâtiment'} (${e.id}), ${Math.round(e.hauteur)} m`),
        bascule(t.apres1943, 'Construit après 1943 (masqué dans l\'état « avant »)'),
        h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: () => enregistrerDonnees('config.json', JSON.stringify(app.config, null, 2)) }, 'Exporter config.json')),
      );
    };
  }

  function majEtat() {
    if (!ui.etat) return;
    const def = COUCHES[etat.couche];
    ui.etat.textContent = etat.dessin
      ? `${etat.points.length} point${etat.points.length > 1 ? 's' : ''}. ${def.geometrie === 'Point' ? '' : 'Entrée pour terminer, Retour arrière pour effacer le dernier point.'}`
      : '';
    ui.dessiner.disabled = etat.dessin;
    ui.terminer.hidden = !etat.dessin || def.geometrie === 'Point';
    ui.annuler.hidden = !etat.dessin;
  }

  function construirePanneau(conteneur) {
    ui.coords = h('p', { class: 'coordonnees', 'aria-live': 'off' }, 'Survolez la maquette pour lire les coordonnées.');
    ui.etat = h('p', { class: 'note' });
    ui.formulaire = h('div');
    ui.batiment = h('div');
    ui.dessiner = h('button', { type: 'button', class: 'bouton principal', onclick: commencer }, 'Dessiner');
    ui.terminer = h('button', { type: 'button', class: 'bouton', onclick: terminer, hidden: true }, 'Terminer');
    ui.annuler = h('button', { type: 'button', class: 'bouton discret', onclick: annuler, hidden: true }, 'Annuler');
    const choix = h('div', { class: 'choix colonne', role: 'radiogroup' },
      ...Object.entries(COUCHES).map(([cle, def]) => h('label', {},
        h('input', { type: 'radio', name: 'couche-releve', value: cle, checked: cle === etat.couche, onchange: () => { annuler(); etat.couche = cle; majEtat(); } }),
        def.libelle)));
    conteneur.append(
      h('p', { class: 'note' }, 'Dessinez sur le sol de la maquette. Les sommets s\'aimantent aux angles du bâti existant.'),
      choix,
      h('label', { class: 'case' }, h('input', { type: 'checkbox', checked: etat.aimant, onchange: (e) => { etat.aimant = e.target.checked; } }), 'Aimanter aux angles du bâti'),
      h('div', { class: 'actions' }, ui.dessiner, ui.terminer, ui.annuler),
      ui.etat,
      ui.formulaire,
      h('div', { class: 'actions' },
        h('button', { type: 'button', class: 'bouton', onclick: exporter }, 'Exporter la couche'),
        h('button', { type: 'button', class: 'bouton discret', onclick: supprimerParClic }, 'Supprimer un élément')),
      h('h3', {}, 'Bâti existant'),
      h('div', { class: 'actions' }, h('button', { type: 'button', class: 'bouton', onclick: identifierBatiment }, 'Identifier un bâtiment')),
      ui.batiment,
      ui.coords,
    );
    majEtat();
  }

  app.on('pointeurSol', ([x, z]) => {
    if (!ui.coords?.isConnected) return;
    const g = app.proj.versGeo(x, z);
    ui.coords.textContent = `lat ${g.lat.toFixed(6)}, lon ${g.lon.toFixed(6)}  (x ${x.toFixed(1)} m, z ${z.toFixed(1)} m)`;
  });

  window.addEventListener('keydown', (e) => {
    if (!etat.dessin) return;
    if (e.key === 'Enter') { e.preventDefault(); terminer(); }
    else if (e.key === 'Backspace') { e.preventDefault(); etat.points.pop(); dessinerApercu(); majEtat(); }
    else if (e.key === 'Escape') annuler();
  });

  return { construirePanneau, annuler, get actif() { return etat.dessin; } };
}
