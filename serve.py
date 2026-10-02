"""Serve the dashboard (web/) with no-cache headers so browsers always pick up rebuilds.

Usage: python serve.py [port]   (default 8765)
"""
import functools
import http.server
import sys
from pathlib import Path


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")  # revalidate every load; 304s keep it fast
        super().end_headers()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    handler = functools.partial(NoCacheHandler, directory=str(Path(__file__).resolve().parent / "web"))
    http.server.ThreadingHTTPServer.request_queue_size = 64  # default 5 drops bursts of parallel requests
    http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
