#!/bin/bash
# Atlas du site de l'Hôtel de Ville : double-cliquez pour lancer. Fermez la fenêtre du Terminal pour arrêter.
cd "$(dirname "$0")"
MODE=${1:-presentateur}
rm -f .port
python3 serveur.py 8000 &
SERVEUR=$!
for i in $(seq 1 20); do [ -f .port ] && break; sleep 0.5; done
PORT=$(cat .port 2>/dev/null || echo 8000)
URL="http://localhost:$PORT/?mode=$MODE"
if [ -d "/Applications/Google Chrome.app" ]; then open -a "Google Chrome" "$URL"; else open "$URL"; fi
echo "Atlas ouvert : $URL (fermez cette fenêtre pour l'arrêter)"
wait $SERVEUR
