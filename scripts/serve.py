"""Servidor local de KeyMix Pro.

Si el puerto ya lo ocupa otra instancia de KeyMix Pro, la reutiliza en lugar de fallar
(así F5 en VS Code funciona aunque el servidor anterior siga abierto).
Uso: python scripts/serve.py [puerto]
"""
import http.server
import os
import socketserver
import sys
import urllib.request

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def keymix_running(port):
    try:
        with urllib.request.urlopen(f"http://localhost:{port}/index.html", timeout=1) as r:
            return b"KeyMix" in r.read(4096)
    except Exception:
        return False


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # sin ruido en la terminal

    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}


socketserver.ThreadingTCPServer.daemon_threads = True

try:
    server = socketserver.ThreadingTCPServer(("", PORT), Handler)
except OSError:
    if keymix_running(PORT):
        print(f"Serving HTTP: KeyMix Pro ya estaba en marcha en http://localhost:{PORT} (se reutiliza)", flush=True)
        sys.exit(0)
    print(
        f"ERROR: el puerto {PORT} lo está usando otro programa.\n"
        f"Ciérralo (PowerShell):\n"
        f"  Get-NetTCPConnection -LocalPort {PORT} -State Listen | ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force }}\n"
        f"o usa otro puerto: python scripts/serve.py 8090",
        flush=True,
    )
    sys.exit(1)

print(f"Serving HTTP: KeyMix Pro en http://localhost:{PORT}  (Ctrl+C para detener)", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    print("Servidor detenido.")
