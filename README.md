# Atlas du site de l'Hôtel de Ville de Nantes

Atlas web d'analyse du site (maquette 3D et plan du quartier de l'Hôtel de Ville : cadastre et fiches du PSMV, relief, soleil, climat, vent, confort, chaleur, bruit, réseaux, trajets, coupes, exports). Version 8, octobre 2026.

**Auteur :** Jean-Charles Poullain, L3 FPC, ENSA Nantes, 2026-2027.

**Site en ligne :** https://jcp40.github.io/atlas-hotel-de-ville/?mode=web

Application statique (HTML, CSS, JavaScript en modules ES, sans compilation). Mode d'emploi complet : [LISEZMOI.md](LISEZMOI.md). En local : `python serveur.py` (ou `lancer-windows.bat`, `lancer-mac.command`).

## Sources et licences des données

- Bâti, voirie, arbres, transports : © contributeurs OpenStreetMap, ODbL (interrogé en direct via Overpass).
- IGN : BD TOPO, BD ORTHO, LiDAR HD, RGE ALTI, API Carto cadastre, géoservices : Licence Ouverte Etalab 2.0.
- Nantes Métropole Open Data (MNT, parkings…) : Licence Ouverte / ODbL selon les jeux.
- Réseaux souterrains (GRDF, Enedis) : Licence Ouverte Etalab 2.0.
- Carte du bruit : DDTM 44 (Géo-IDE), 2022.
- Météo : Météo-France, station 44020001 Nantes-Bouguenais, données horaires 2016-2025, Licence Ouverte Etalab 2.0 (`data/meteo/meteo*.json`, `data/meteo/meteofrance_44020001_horaire.csv`).
- Année météo type : `data/meteo/FRA_PL_Nantes.Atlantique.AP.072220_TMYx.2011-2025.epw`, Climate.OneBuilding.org (TMYx 2011-2025), CC BY 4.0.
- Photos de façade : Panoramax (immergis), Licence Ouverte 2.0 ; Koreller, CC BY-SA 4.0 (pavillon ouest) ; photos du PSMV redressées (crédits détaillés dans `data/facades/*.json`).
- Fiches du PSMV (`data/psmv/fiches.json`, texte seulement) : extraites du « Descriptif, environs de l'Hôtel de Ville », Secteur sauvegardé de Nantes, A.U.P. architectes urbanistes, ministère de la Culture et Nantes Métropole.

## Documents non publiés

Les documents du PSMV (PDF du descriptif, photos et planches des fiches, extraits de plans à caler) ne sont **pas publiés** dans ce dépôt, leurs droits de diffusion n'étant pas vérifiés. L'atlas affiche à leur place « document non publié en ligne ».

## Bibliothèques

- [three.js](https://threejs.org) (`lib/three/`) : licence MIT.
- [SunCalc](https://github.com/mourner/suncalc) (`lib/suncalc.js`) : licence BSD-2-Clause.
- Polices Spectral et IBM Plex Sans Condensed (`fonts/`) : SIL Open Font License 1.1.
