import { empriseAutour, creerProjection } from './geo.js';
import { chargerJSON, interrogerOverpass, convertirOSM, interrogerBDTopo, assemblerFond, interrogerCadastre, interrogerAltitudes, lireParkings, enregistrerDonnees, definirSignaleur } from './donnees.js';

const journal = document.getElementById('journal');
const log = (t) => { journal.textContent += `${new Date().toLocaleTimeString('fr-FR')}  ${t}\n`; journal.scrollTop = journal.scrollHeight; };
let dossier = null;

const config = await chargerJSON('data/config.json', null);
if (!config) {
  log('data/config.json introuvable : ouvrez cette page via le serveur local (lancer-windows.bat ou lancer-mac.command).');
  throw new Error('config absente');
}
const emprise = empriseAutour(config.origine.lat, config.origine.lon, config.rayonEtude * 1.2);
document.getElementById('emprise').textContent =
  `Emprise : ${Math.round(config.rayonEtude * 1.2)} m autour de ${config.origine.lat}, ${config.origine.lon} (sud ${emprise.sud.toFixed(5)}, ouest ${emprise.ouest.toFixed(5)}, nord ${emprise.nord.toFixed(5)}, est ${emprise.est.toFixed(5)}).`;

// Enregistrement : dans le dossier data choisi s'il y en a un, sinon directement par le serveur local
// (serveur.py), sinon téléchargement.
definirSignaleur(log);
async function enregistrer(chemin, contenu, type = 'application/json') {
  const blob = contenu instanceof Blob ? contenu : new Blob([contenu], { type });
  if (dossier) {
    try {
      const parties = chemin.split('/');
      let d = dossier;
      for (const p of parties.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
      const f = await d.getFileHandle(parties[parties.length - 1], { create: true });
      const w = await f.createWritable();
      await w.write(blob);
      await w.close();
      log(`Enregistré : data/${chemin}`);
      return;
    } catch (e) {
      log(`Écriture dans le dossier choisi impossible (${e.message}).`);
    }
  }
  await enregistrerDonnees(chemin, blob);
}

const bouton = (id, fn) => {
  const b = document.getElementById(id);
  b.addEventListener('click', async () => {
    b.disabled = true;
    try { await fn(); } catch (e) { log(`Erreur : ${e.message}`); } finally { b.disabled = false; }
  });
};

const choisir = document.getElementById('choisir-dossier');
if (!window.showDirectoryPicker) {
  choisir.disabled = true;
  choisir.textContent = 'Non disponible dans ce navigateur';
} else {
  choisir.addEventListener('click', async () => {
    try {
      dossier = await window.showDirectoryPicker({ mode: 'readwrite' });
      document.getElementById('dossier').textContent = `Dossier choisi : ${dossier.name}`;
      if (dossier.name !== 'data') log('Attention : le dossier choisi ne s\'appelle pas « data ». Vérifiez qu\'il s\'agit bien du dossier data de l\'atlas.');
    } catch { /* annulé */ }
  });
}

bouton('osm', async () => {
  const couches = convertirOSM(await interrogerOverpass(emprise, log));
  for (const [nom, fc] of Object.entries(couches)) {
    log(`${nom} : ${fc.features.length} éléments`);
    await enregistrer(`osm/${nom}.geojson`, JSON.stringify(fc));
  }
  log('OpenStreetMap : terminé.');
});

bouton('bdtopo', async () => {
  const fc = await interrogerBDTopo(emprise, log);
  await enregistrer('ign/batiments_bdtopo.geojson', JSON.stringify(fc));
});

bouton('cadastre', async () => {
  const fc = await interrogerCadastre(emprise, log);
  await enregistrer('cadastre/parcelles.geojson', JSON.stringify(fc));
});

const zoneFonds = document.getElementById('fonds');
for (const fond of (config.fonds || []).filter((f) => !f.pasDeCache)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'bouton';
  b.id = `fond-${fond.id}`;
  b.textContent = `${fond.nom}${fond.periode ? ` (${fond.periode})` : ''}`;
  zoneFonds.append(b);
  bouton(b.id, async () => {
    const { canvas, bornes } = await assemblerFond(emprise, fond, log);
    const blob = await new Promise((ok, ko) => {
      try { canvas.toBlob((x) => (x ? ok(x) : ko(new Error('image vide'))), 'image/jpeg', 0.86); } catch (e) { ko(new Error(`le serveur IGN n'autorise pas la réutilisation des tuiles (${e.message})`)); }
    });
    await enregistrer(`ign/fond-${fond.id}.jpg`, blob);
    await enregistrer(`ign/fond-${fond.id}.json`, JSON.stringify(bornes, null, 2));
  });
}

bouton('relief', async () => {
  // au-delà du périmètre d'étude, pour que le relief 3D de la maquette ne s'arrête pas net à son bord
  const pas = config.topographie?.pas ?? 8, r = Math.ceil(Math.max(config.rayonEtude * 1.4, 700) / pas) * pas, n = Math.ceil((2 * r) / pas) + 1;
  const g = await interrogerAltitudes({ x0: -r, z0: -r, pas, nx: n, nz: n }, creerProjection(config.origine.lat, config.origine.lon), log);
  // origine notée : si le centre change, l'atlas recale la grille au lieu de la décaler
  await enregistrer('ign/altimetrie.json', JSON.stringify({ ...g, origine: [config.origine.lat, config.origine.lon] }));
});

bouton('parkings', async () => {
  const liste = await lireParkings(config.flux.parkings.url);
  log(`${liste.length} parkings lus.`);
  await enregistrer('rejeu/parkings.json', JSON.stringify({ date: new Date().toISOString(), source: config.flux.parkings.url, parkings: liste }, null, 2));
});

log('Prêt.');
