import { h, info } from './util.js';
import { ATTRIBUTION_ARBRES } from './maquette.js';

// Éléments de la maquette (onglet Site > Couches, 21/10/2026) : afficher ou masquer chaussées, trottoirs, bâti,
// toits détaillés et façades, projet, arbres, eau, sol, relief, noms de rues, étiquettes.
// Purement visuel : les objets ne sont masqués que le temps du rendu (renderer.render enveloppé), sans toucher
// à leur .visible ni aux données ; soleil, vent, confort, chaleur, coupes et exports DXF/GLB n'en tiennent pas
// compte (les images PNG, rendues par le même moteur, montrent ce qui est affiché).
// États dans app.couches (clés maq*, arbres, rues, etiquettes) : gardés par les points de vue (outil Vues) ;
// clés maq* mémorisées dans localStorage « atlas-hdv-elements ».
// Case « Routes » (30/10/2026, reprise des bascules rapides Arbres / Routes qui étaient en haut à gauche, js/phase.js) :
// chaussées + trottoirs ensemble, cochée si les deux le sont, indéterminée si une seule ; les deux cases restent dessous.
const CLE_MEMOIRE = 'atlas-hdv-elements';
const ROUTES = ['maqChaussees', 'maqTrottoirs'];

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
  // Vue Plan (31/10/2026, demande de l'utilisateur) : le cercle du plateau (trait app.sol.bord, anneau sombre de rayonPlateau,
  // et disque plus clair app.sol.plateau posé sur le sol) n'est pas dessiné quand la caméra est celle du plan (app.vue.ortho) ;
  // gardé en 3D, en axonométrie et dans la planche (caméras à part). En vue maquette coupée, le disque reste (c'est le sol du plateau).
  function cerclePlan(camera) {
    if (!app.vue2D || camera !== app.vue?.ortho || !app.sol) return [];
    return app.vueMaquette ? [app.sol.bord] : [app.sol.bord, app.sol.plateau];
  }

  // rendu : éléments décochés masqués le temps de l'image, puis remis (calculs, lancers de rayons et exports intacts)
  const r = app.renderer;
  const rendre = r.render.bind(r);
  r.render = (scene, camera) => {
    const caches = [];
    if (scene === app.scene) {
      for (const o of [...masques(), ...cerclePlan(camera)]) if (o?.visible) { o.visible = false; caches.push(o); }
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
    const caseEl = (cle, libelle, apres, classe = 'case') => {
      const input = h('input', { type: 'checkbox', checked: app.couches[cle] !== false, onchange: (e) => { app.couches[cle] = e.target.checked; apres?.(); memoriser(); app.emettre('couches'); } });
      cases.push([cle, input]);
      return h('label', { class: classe }, input, libelle);
    };
    const routes = h('input', { type: 'checkbox', onchange: (e) => { for (const k of ROUTES) app.couches[k] = e.target.checked; memoriser(); app.emettre('couches'); } });
    const majRoutes = () => {
      const n = ROUTES.filter((k) => app.couches[k] !== false).length;
      routes.checked = n === ROUTES.length; routes.indeterminate = n > 0 && n < ROUTES.length;
    };
    majRoutes();
    const caseRoutes = h('label', { class: 'case', title: 'Chaussées, trottoirs, places et stationnements ensemble' }, routes, 'Routes (chaussées et trottoirs)');
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
        info('Affichage seulement : soleil, vent, confort, chaleur, coupes et exports DXF/GLB gardent tout le bâti. Le relief, lui, pose réellement la maquette sur le terrain (comme dans l\'onglet Topographie).',
          h('br'), h('br'), `Arbres : ${ATTRIBUTION_ARBRES} (data/arbres-nantes.geojson : espèce, classe de hauteur, couronne, gestionnaire), complété par OpenStreetMap (ODbL) à plus de 3 m d'un arbre de l'inventaire et par les arbres relevés avec l'outil Relevé (prioritaires). Clic sur un arbre : sa fiche. Les caducs suivent la date de la barre Soleil : feuilles du 1er au 30 avril, chute du 15 octobre au 15 novembre, branches nues l'hiver (ombres, Soleil et Chaleur en tiennent compte).`)),
      h('label', { class: 'case' }, vueMaq, 'Vue maquette (plateau coupé net au bord, touche M)'),
      caseRoutes,
      ...ELEMENTS.map((e) => caseEl(e.cle, e.libelle, e.cle === 'arbres' ? () => { if (app.arbres) app.arbres.groupe.visible = true; } : null, ROUTES.includes(e.cle) ? 'case sous-case' : 'case')),
      h('label', { class: 'case' }, relief, 'Relief (maquette posée sur le terrain)'),
      caseEl('rues', 'Noms des rues (sur les voies)'),
      caseEl('etiquettes', 'Étiquettes (noms et repères)'),
    );
    const majCases = () => {
      for (const [cle, input] of cases) input.checked = app.couches[cle] !== false;
      majRoutes();
      vueMaq.checked = !!app.vueMaquette;
      relief.checked = !!app.relief?.actif;
    };
    majCasesCourant = majCases; // écouteurs posés une seule fois (le panneau Couches est reconstruit à chaque ouverture)
  }
  let majCasesCourant = null;
  const majSiAffiche = () => majCasesCourant?.();
  app.on('couches', majSiAffiche);
  app.on('vueMaquette', majSiAffiche);
  app.on('relief', majSiAffiche);

  return { affiche, construireCommandes, masques, ELEMENTS };
}
