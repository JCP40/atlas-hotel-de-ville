import { h } from './util.js';
import { enregistrerDonnees } from './donnees.js';
import { chargerMeteo, definirSource, definirSite, source, epwPersoGarde, EPW_NANTES } from './meteo.js';

// Sélecteur « Source météo » de l'onglet Ambiance (Climat, Vent, Confort, Chaleur) : météo de base (Météo-France
// 44020001, 2016-2025), EPW de Nantes fourni (data/meteo/) ou fichier EPW choisi par l'utilisateur (lu localement par
// FileReader, aucun envoi réseau ; gardé en IndexedDB ; enregistrable dans data/meteo/ si serveur.py tourne).
// Chaque bloc() affiche en permanence la source, la période et les avertissements (distance > 30 km, autre fuseau).
// Changement de source → événement « meteoSource » (les outils redessinent ou recalculent).
export function creerSourceMeteo(app) {
  definirSite(app.config.origine.lat, app.config.origine.lon);
  const blocs = new Set();
  const etat = { occupe: false, message: '', nomPerso: null, dernierPerso: null };
  chargerMeteo().then(async () => { etat.nomPerso = await epwPersoGarde(); majTous(); });

  async function choisir(type, opts) {
    if (etat.occupe) return;
    etat.occupe = true; etat.message = 'Lecture du fichier météo…'; majTous();
    try {
      await definirSource(type, opts);
      if (type === 'epw-perso' && opts?.nom) { etat.nomPerso = opts.nom; etat.dernierPerso = opts; }
      etat.message = '';
      app.emettre('meteoSource', source());
    } catch (e) {
      etat.message = `Source météo inchangée : ${e.message}`;
    } finally { etat.occupe = false; majTous(); }
  }

  function lireFichier(f) {
    if (!f) return;
    const lecteur = new FileReader();
    lecteur.onload = () => choisir('epw-perso', { nom: f.name, texte: String(lecteur.result) });
    lecteur.onerror = () => { etat.message = `Lecture impossible de ${f.name}.`; majTous(); };
    lecteur.readAsText(f);
  }

  function majBloc(b) {
    const s = source();
    const sel = b.querySelector('select');
    const optPerso = sel.querySelector('option[value="epw-perso"]');
    optPerso.hidden = !etat.nomPerso;
    optPerso.textContent = `Fichier EPW : ${etat.nomPerso || '…'}`;
    sel.value = s.type;
    sel.disabled = etat.occupe;
    b.querySelector('.source-meteo-ligne').textContent = `${s.titre} : ${s.libelle} · ${s.periode}${s.nom && s.type === 'epw-perso' ? ` · ${s.nom}` : ''}`;
    const al = b.querySelector('.source-meteo-alerte');
    al.replaceChildren(...[etat.message, ...s.avertissements].filter(Boolean).map((t) => h('span', {}, t, ' ')));
    al.hidden = !al.childNodes.length;
    b.querySelector('.source-meteo-enregistrer').hidden = !(s.type === 'epw-perso' && etat.dernierPerso);
  }
  function majTous() { for (const b of [...blocs]) { if (b.isConnected) majBloc(b); else blocs.delete(b); } }

  function bloc() {
    const entree = h('input', { type: 'file', accept: '.epw,text/plain', hidden: true, onchange: (e) => { lireFichier(e.target.files[0]); e.target.value = ''; } });
    const b = h('div', { class: 'source-meteo', 'data-garder': '' },
      h('label', { class: 'champ' }, h('span', {}, 'Source météo'),
        h('select', { 'aria-label': 'Source météo', onchange: (e) => choisir(e.target.value) },
          h('option', { value: 'base' }, 'Météo de base (Météo-France 2016–2025)'),
          h('option', { value: 'epw-nantes' }, 'Fichier EPW de Nantes (fourni)'),
          h('option', { value: 'epw-perso', hidden: true }, 'Fichier EPW'))),
      h('div', { class: 'boutons' },
        h('button', { type: 'button', class: 'bouton discret', title: 'Fichier .epw (EnergyPlus Weather), lu dans le navigateur, sans envoi', onclick: () => entree.click() }, 'Choisir un fichier EPW…'),
        h('button', { type: 'button', class: 'bouton discret source-meteo-enregistrer', hidden: true, title: 'Copier le fichier dans data/meteo/ (serveur local), sinon le télécharger',
          onclick: () => { const p = etat.dernierPerso; if (p) enregistrerDonnees(`meteo/${p.nom.replace(/[^\w.-]+/g, '_')}`, p.texte, { type: 'text/plain' }); } }, 'Enregistrer dans data/meteo/'),
        entree),
      h('p', { class: 'source-meteo-ligne', role: 'status' }),
      h('p', { class: 'source-meteo-alerte alerte', role: 'status', hidden: true }));
    b.title = `EPW de Nantes : ${EPW_NANTES}`;
    blocs.add(b);
    majBloc(b);
    return b;
  }

  return { bloc, choisir, lireFichier };
}
