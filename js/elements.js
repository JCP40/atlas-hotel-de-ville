import { h, info } from './util.js';

// Éléments de la maquette (onglet Site > Couches, 21/10/2026) : afficher ou masquer chaussées, trottoirs, bâti,
// toits détaillés et façades, projet, arbres, eau, sol, relief, noms de rues, étiquettes.
// Purement visuel : les objets ne sont masqués que le temps du rendu (renderer.render enveloppé), sans toucher
// à leur .visible ni aux données ; soleil, vent, confort, chaleur, coupes et exports DXF/GLB n'en tiennent pas
// compte (les images PNG, rendues par le même moteur, montrent ce qui est affiché).
// États dans app.couches (clés maq*, arbres, rues, etiquettes) : gardés par les points de vue (outil Vues) ;
// clés maq* mémorisées dans localStorage « atlas-hdv-elements ».
const CLE_MEMOIRE = 'atlas-hdv-elements';

export const ELEMENTS = [
  { cle: 'maqChaussees', libelle: 'Chaussées (routes)', objets: (s) => [s('voirie', 'chaussees'), s('surfaces', 'voirie')] },
  { cle: 'maqTrottoirs', libelle: 'Trottoirs, places et stationnements', objets: (s) => [s('voirie', 'trottoirs'), s('surfaces', 'pietonne'), s('surfaces', 'parking'), s('surfaces', 'parkings-plateau')] },
  { cle: 'maqBati', libelle: 'Bâtiments (bâti existant)', objets: (s) => (s('batiments')?.children || []).filter((m) => !m.userData.detail) },
  { cle: 'maqDetail', libelle: 'Toits détaillés et façades photo', objets: (s) => (s('batiments')?.children || []).filter((m) => m.userData.detail) },
  { cle: 'maqProjet', libelle: 'Projet (volumes et imports)', objets: (s) => [s('projet'), s('imports')] },
  { cle: 'arbres', libelle: 'Arbres', objets: (s) => [s('arbres')] },
  { cle: 'maqEspacesVerts', libelle: 'Espaces verts (pelouses, jardins, parcs)', objets: (s) => [s('surfaces', 'vegetal')] },
  { cle: 'maqEau', libelle: 'Eau', objets: (s) => [s('surfaces', 'eau')] },
  { cle: 'maqSol', libelle: 'Sol et plateau (socle)', objets: (s, app) => [app.sol?.groupe] },
];

export function creerElements(app) {
  for (const e of ELEMENTS) if (app.couches[e.cle] == null) app.couches[e.cle] = true;
  try {
    const m = JSON.parse(localStorage.getItem(CLE_MEMOIRE) || '{}');
    for (const e of ELEMENTS) if (e.cle.startsWith('maq') && typeof m[e.cle] === 'boolean') app.couches[e.cle] = m[e.cle];
  } catch { /* stockage indisponible */ }
  function memoriser() {
    try {
      const m = {};
      for (const e of ELEMENTS) if (e.cle.startsWith('maq')) m[e.cle] = !!app.couches[e.cle];
      localStorage.setItem(CLE_MEMOIRE, JSON.stringify(m));
    } catch { /* stockage indisponible */ }
  }

  const chercher = (nom, enfant) => {
    const g = app.scene.children.find((o) => o.name === nom);
    return enfant ? g?.children.find((o) => o.name === enfant) : g;
  };
  function masques() {
    const liste = [];
    for (const e of ELEMENTS) if (app.couches[e.cle] === false) for (const o of e.objets(chercher, app)) if (o) liste.push(o);
    return liste;
  }

  // rendu : éléments décochés masqués le temps de l'image, puis remis (calculs, lancers de rayons et exports intacts)
  const r = app.renderer;
  const rendre = r.render.bind(r);
  r.render = (scene, camera) => {
    const caches = [];
    if (scene === app.scene) {
      for (const o of masques()) if (o.visible) { o.visible = false; caches.push(o); }
      app.decoupe?.synchroniserFaces?.();
    }
    try { rendre(scene, camera); } finally { for (const o of caches) o.visible = true; }
  };

  // un objet cliqué appartient-il à un élément affiché ?
  function affiche(obj) {
    const m = new Set(masques());
    for (let v = obj; v; v = v.parent) if (m.has(v)) return false;
    return true;
  }

  function construireCommandes(conteneur) {
    const cases = [];
    const caseEl = (cle, libelle, apres) => {
      const input = h('input', { type: 'checkbox', checked: app.couches[cle] !== false, onchange: (e) => { app.couches[cle] = e.target.checked; apres?.(); memoriser(); app.emettre('couches'); } });
      cases.push([cle, input]);
      return h('label', { class: 'case' }, input, libelle);
    };
    const vueMaq = h('input', { type: 'checkbox', checked: !!app.vueMaquette, onchange: (e) => app.definirVueMaquette(e.target.checked) });
    const relief = h('input', {
      type: 'checkbox', checked: !!app.relief?.actif,
      onchange: async (e) => {
        try {
          if (e.target.checked) app.signaler('Pose de la maquette sur le relief…');
          await app.relief.activer(e.target.checked);
        } catch (err) { e.target.checked = false; app.signaler(`Relief impossible : ${err.message}`); }
      },
    });
    conteneur.append(
      h('div', { class: 'titre-info' }, h('h3', {}, 'Éléments de la maquette'),
        info('Affichage seulement : soleil, vent, confort, chaleur, coupes et exports DXF/GLB gardent tout le bâti. Le relief, lui, pose réellement la maquette sur le terrain (comme dans l\'onglet Topographie).')),
      h('label', { class: 'case' }, vueMaq, 'Vue maquette (plateau coupé net au bord, touche M)'),
      ...ELEMENTS.map((e) => caseEl(e.cle, e.libelle, e.cle === 'arbres' ? () => { if (app.arbres) app.arbres.groupe.visible = true; } : null)),
      h('label', { class: 'case' }, relief, 'Relief (maquette posée sur le terrain)'),
      caseEl('rues', 'Noms des rues (sur les voies)'),
      caseEl('etiquettes', 'Étiquettes (noms et repères)'),
    );
    const majCases = () => {
      for (const [cle, input] of cases) input.checked = app.couches[cle] !== false;
      vueMaq.checked = !!app.vueMaquette;
      relief.checked = !!app.relief?.actif;
    };
    app.on('couches', majCases);
    app.on('vueMaquette', majCases);
    app.on('relief', majCases);
  }

  return { affiche, construireCommandes, masques, ELEMENTS };
}
