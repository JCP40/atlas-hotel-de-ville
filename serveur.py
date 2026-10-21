"""Petit serveur local de l'atlas.

Il sert les fichiers du dossier sans que le navigateur les garde en cache :
après chaque mise à jour de l'atlas, Chrome recharge bien les nouvelles versions
(avec le serveur Python standard, Chrome pouvait mélanger anciens et nouveaux fichiers).
Il permet aussi à l'atlas d'enregistrer ses fichiers directement dans data/
(boutons « Enregistrer … » et page preparer.html), l'ancienne version étant gardée
dans data/.sauvegardes/. Il n'écoute que l'ordinateur lui-même (127.0.0.1).
Usage : python serveur.py [port]
"""
import http.server
import json
import os
import shutil
import socket
import socketserver
import sys
import time
import urllib.parse

os.chdir(os.path.dirname(os.path.abspath(__file__)))


class Gestionnaire(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
        '.geojson': 'application/geo+json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml',
        '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
        '.obj': 'text/plain', '.mtl': 'text/plain',
    }

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        pass  # fenêtre silencieuse

    # Enregistrement direct dans data/ depuis l'atlas (boutons « Enregistrer … »).
    # POST /__enregistrer/data/<chemin> : le corps de la requête devient le fichier.
    # Seul l'atlas servi par ce serveur peut écrire (contrôle de l'origine), et seulement dans data/.
    # Un fichier remplacé est d'abord copié dans data/.sauvegardes/.
    def do_POST(self):
        prefixe = '/__enregistrer/'
        chemin = urllib.parse.unquote(urllib.parse.urlsplit(self.path).path)
        if not chemin.startswith(prefixe):
            return self.repondre(404, {'ok': False, 'erreur': 'adresse inconnue'})
        origine = self.headers.get('Origin')
        hote = self.headers.get('Host', '')
        if origine and urllib.parse.urlsplit(origine).netloc != hote:
            return self.repondre(403, {'ok': False, 'erreur': 'origine refusée'})
        relatif = os.path.normpath(chemin[len(prefixe):]).replace('\\', '/')
        racine = os.path.abspath('data')
        cible = os.path.abspath(relatif)
        ext = os.path.splitext(cible)[1].lower()
        if not relatif.startswith('data/') or os.path.commonpath([racine, cible]) != racine or '/.' in relatif or ext not in EXTENSIONS:
            return self.repondre(400, {'ok': False, 'erreur': f'chemin non autorisé : {relatif}'})
        taille = int(self.headers.get('Content-Length') or 0)
        if taille <= 0 or taille > 300 * 1024 * 1024:
            return self.repondre(400, {'ok': False, 'erreur': 'fichier vide ou trop gros'})
        contenu = self.rfile.read(taille)
        os.makedirs(os.path.dirname(cible), exist_ok=True)
        sauvegarde = None
        if os.path.exists(cible):
            dossier = os.path.join(racine, '.sauvegardes')
            os.makedirs(dossier, exist_ok=True)
            base, e = os.path.splitext(relatif[len('data/'):].replace('/', '_'))
            sauvegarde = os.path.join(dossier, f"{base}-{time.strftime('%Y%m%d-%H%M%S')}{e}")
            shutil.copy2(cible, sauvegarde)
        temporaire = cible + '.tmp'
        with open(temporaire, 'wb') as f:
            f.write(contenu)
        os.replace(temporaire, cible)
        self.repondre(200, {'ok': True, 'chemin': relatif, 'sauvegarde': os.path.relpath(sauvegarde).replace('\\', '/') if sauvegarde else None})

    def repondre(self, code, corps):
        donnees = json.dumps(corps, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(donnees)))
        self.end_headers()
        self.wfile.write(donnees)


# .glb, .gltf, .bin, .obj, .mtl : modèles 3D importés dans le projet (data/imports/)
EXTENSIONS = {'.json', '.geojson', '.jpg', '.jpeg', '.png', '.csv', '.txt', '.svg', '.pdf', '.glb', '.gltf', '.bin', '.obj', '.mtl'}


class Serveur(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def port_libre(depart):
    for port in range(depart, depart + 20):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
    return depart


if __name__ == '__main__':
    port = port_libre(int(sys.argv[1]) if len(sys.argv) > 1 else 8000)
    with open('.port', 'w') as f:
        f.write(str(port))
    print(f"Atlas disponible sur http://localhost:{port}/  (fermez cette fenêtre pour l'arrêter)")
    Serveur(('127.0.0.1', port), Gestionnaire).serve_forever()
