import { h, texteRiche, allerVers, estNonPublie, NON_PUBLIE } from './util.js';

// Fiches d'information : un panneau latéral (feuille de calque) qui s'ouvre au clic
// sur un élément de la maquette. Une fiche peut raconter les trois états du site.
export function creerFiches(app) {
  const panneau = document.getElementById('fiche');
  const corps = panneau.querySelector('.fiche-corps');
  const visionneuse = document.getElementById('visionneuse');
  let courante = null;
  let contexte = null; // point cliqué sur la maquette (corps de bâtiment de la mairie, js/toits.js)

  const toutes = () => app.donnees.fiches.fiches || [];
  const trouver = (id) => toutes().find((f) => f.id === id);

  function contenuPourEtat(f) {
    if (!f.etats) return f;
    const cle = f.etats[app.etat] ? app.etat : Object.keys(f.etats)[0];
    return { ...f, ...f.etats[cle], etatAffiche: cle };
  }

  function rendre() {
    const f = courante;
    corps.replaceChildren();
    if (!f) return;
    const c = contenuPourEtat(f);
    const chapitre = (app.chapitres?.liste || app.donnees.chapitres.chapitres)?.find((ch) => ch.id === f.chapitre); // chapitres affichés (renumérotés)

    corps.append(
      h('p', { class: 'fiche-type' }, [f.type, chapitre ? `chapitre ${chapitre.numero ?? ''} ${chapitre.titre}` : null].filter(Boolean).join(', ')),
      h('h2', { id: 'fiche-titre' }, f.titre),
    );

    if (f.etats) {
      const onglets = h('div', { class: 'onglets', role: 'tablist', 'aria-label': 'États du site' },
        ...app.etatsActifs().filter((e) => f.etats[e.id]).map((e) => h('button', {
          type: 'button', role: 'tab', 'aria-selected': String(c.etatAffiche === e.id),
          onclick: () => app.temps.changer(e.id),
        }, e.libelle)));
      corps.append(onglets);
    }

    for (const p of [].concat(c.texte || [])) {
      const el = h('p');
      el.innerHTML = texteRiche(p);
      corps.append(el);
    }

    if (c.images?.length) {
      corps.append(h('div', { class: 'fiche-images' }, ...c.images.map((img) => {
        const src = img.fichier.startsWith('http') ? img.fichier : `data/medias/${img.fichier}`;
        if (estNonPublie(src)) return h('figure', { class: 'non-publie' }, h('p', { class: 'mots' }, h('span', {}, NON_PUBLIE)), img.legende ? h('figcaption', {}, img.legende) : null);
        return h('figure', {},
          h('button', { type: 'button', class: 'vignette', onclick: () => ouvrirImage(src, img.legende), 'aria-label': `Agrandir : ${img.legende || f.titre}` },
            h('img', { src, alt: img.legende || '', loading: 'lazy' })),
          img.legende ? h('figcaption', {}, img.legende) : null);
      })));
    }

    if (c.motsCles?.length) {
      corps.append(h('p', { class: 'mots' }, ...c.motsCles.map((m) => h('span', {}, m))));
    }

    if (c.liens?.length) {
      corps.append(h('ul', { class: 'liens' }, ...c.liens.map((l) => h('li', {}, estNonPublie(l.url) ? `${l.titre} (${NON_PUBLIE})` : h('a', { href: l.url, target: '_blank', rel: 'noopener' }, l.titre)))));
    }

    const actions = h('div', { class: 'actions' });
    if (f.position) {
      actions.append(h('button', {
        type: 'button', class: 'bouton', onclick: () => {
          const { x, z } = app.proj.versLocal(f.position[0], f.position[1]);
          allerVers(app, [x - 45, 38, z + 60], [x, 4, z], 1400);
        },
      }, 'Voir sur la maquette'));
    }
    const blocBatiment = app.toits?.blocFiche?.(f, contexte);
    if (blocBatiment) corps.append(blocBatiment);
    if (f.source) corps.append(h('p', { class: 'source' }, `Source : ${f.source}`));
    if (actions.children.length) corps.append(actions);
  }

  function ouvrir(id, ctx = null) {
    const f = trouver(id);
    if (!f) {
      app.signaler(`La fiche « ${id} » n'existe pas encore dans data/fiches.json.`);
      return;
    }
    courante = f;
    contexte = ctx;
    rendre();
    panneau.hidden = false;
    panneau.setAttribute('aria-labelledby', 'fiche-titre');
    document.body.classList.add('fiche-ouverte');
    corps.scrollTop = 0;
    app.emettre('fiche', id);
  }

  // Fiche construite à la volée (parcelle, fiche PSMV…)
  function afficher(objet) {
    courante = objet;
    contexte = null;
    rendre();
    panneau.hidden = false;
    document.body.classList.add('fiche-ouverte');
    corps.scrollTop = 0;
  }

  function fermer() {
    courante = null;
    panneau.hidden = true;
    document.body.classList.remove('fiche-ouverte');
  }

  function ouvrirImage(src, legende) {
    visionneuse.querySelector('img').src = src;
    visionneuse.querySelector('img').alt = legende || '';
    visionneuse.querySelector('p').textContent = legende || '';
    visionneuse.showModal();
  }

  panneau.querySelector('.fermer').addEventListener('click', fermer);
  visionneuse.addEventListener('click', () => visionneuse.close());
  app.on('etat', () => { if (courante?.etats) rendre(); });

  function construireSommaire(conteneur) {
    // chapitres affichés (renumérotés) ; les fiches d'un chapitre masqué passent dans « Autres fiches »
    const chapitres = app.chapitres?.liste || app.donnees.chapitres.chapitres || [];
    const groupes = new Map();
    for (const f of toutes()) {
      const cle = chapitres.some((c) => c.id === f.chapitre) ? f.chapitre : 'autres';
      if (!groupes.has(cle)) groupes.set(cle, []);
      groupes.get(cle).push(f);
    }
    const ordre = [...chapitres.map((c) => c.id), 'autres'];
    for (const cle of ordre) {
      const liste = groupes.get(cle);
      if (!liste) continue;
      const ch = chapitres.find((c) => c.id === cle);
      conteneur.append(
        h('h3', {}, ch ? `${ch.numero}. ${ch.titre}` : 'Autres fiches'),
        h('ul', { class: 'sommaire' }, ...liste.map((f) => h('li', {}, h('button', { type: 'button', onclick: () => ouvrir(f.id) }, f.titre)))),
      );
    }
    if (!toutes().length) conteneur.append(h('p', { class: 'note' }, 'Aucune fiche : ajoutez-en dans data/fiches.json.'));
  }

  return { ouvrir, afficher, fermer, construireSommaire, trouver, get courante() { return courante; } };
}
