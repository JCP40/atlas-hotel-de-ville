// États du site : avant 1943, aujourd'hui.
// Chaque objet s'enregistre avec une règle de visibilité ; au changement d'état,
// les volumes s'élèvent ou s'effacent (animation de hauteur), les surfaces apparaissent simplement.

export const ETATS = [
  { id: 'avant', libelle: 'Avant 1943' },
  { id: 'actuel', libelle: 'Aujourd\'hui' },
];

export function creerTemps(app) {
  // config.json > epoques : false retire le sélecteur d'époque (en haut à droite) et les touches 1 et 2 ;
  // l'atlas reste sur « Aujourd'hui ». Le code et les données (bâti disparu, chapitres « avant ») sont gardés :
  // remettre epoques à true (ou retirer la clé) pour les retrouver.
  app.epoques = app.config.epoques !== false;
  const actifs = app.epoques ? (app.config.etats || ETATS.map((e) => e.id)) : ['actuel'];
  app.etatsActifs = () => ETATS.filter((e) => actifs.includes(e.id));
  const objets = [];
  const animations = new Map();
  const reduit = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function enregistrer(obj, visibleSi, anim = 'hauteur') {
    objets.push({ obj, visibleSi, anim });
    obj.visible = !!visibleSi(app);
    obj.userData.echelleY = obj.scale.y || 1;
  }

  function retirer(obj) {
    const i = objets.findIndex((o) => o.obj === obj);
    if (i >= 0) objets.splice(i, 1);
    animations.delete(obj);
  }

  function animer(obj, vers, duree, delai) {
    const cible = obj.userData.echelleY || 1;
    const depart = obj.visible ? obj.scale.y / cible : 0;
    if (vers === 1) { obj.visible = true; if (depart === 0) obj.scale.y = 0.0001; }
    animations.set(obj, { t0: performance.now() + delai, duree, de: depart, a: vers, cible });
  }

  function appliquer({ instantane = false } = {}) {
    let rang = 0;
    for (const { obj, visibleSi, anim } of objets) {
      const doit = !!visibleSi(app);
      const estVisible = obj.visible && !(animations.get(obj)?.a === 0);
      if (doit === estVisible) continue;
      if (anim === 'hauteur' && !instantane && !reduit) {
        animer(obj, doit ? 1 : 0, 900, doit ? 250 + (rang++ % 12) * 60 : 0);
      } else {
        animations.delete(obj);
        obj.visible = doit;
        obj.scale.y = obj.userData.echelleY || 1;
      }
    }
    app.emettre('couches');
  }

  function maj(maintenant) {
    for (const [obj, a] of animations) {
      const t = Math.min(Math.max((maintenant - a.t0) / a.duree, 0), 1);
      const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
      obj.scale.y = Math.max((a.de + (a.a - a.de) * e) * a.cible, 0.0001);
      if (t >= 1) {
        animations.delete(obj);
        if (a.a === 0) { obj.visible = false; obj.scale.y = a.cible; }
        else obj.scale.y = a.cible;
      }
    }
  }

  function changer(etat, options = {}) {
    if (!actifs.includes(etat)) return;
    app.etat = etat;
    document.body.dataset.etat = etat;
    appliquer(options);
    app.emettre('etat', etat);
  }

  return { enregistrer, retirer, appliquer, changer, maj, objets };
}
