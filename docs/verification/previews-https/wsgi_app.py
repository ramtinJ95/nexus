import sys
from wsgiref.simple_server import make_server, WSGIRequestHandler
from wsgiref.util import application_uri

def app(environ, start):
    base = application_uri(environ)
    if environ["PATH_INFO"] == "/":
        start("302 Found", [("Location", base + "login")])
        return [b""]
    if environ["PATH_INFO"] == "/static/app.css":
        start("200 OK", [("Content-Type", "text/css")])
        return [b"p { color: green }"]
    start("200 OK", [("Content-Type", "text/html")])
    return [f'<link rel="stylesheet" href="{base}static/app.css"><p>login</p>'.encode()]

class Quiet(WSGIRequestHandler):
    def log_message(self, *a): pass

make_server("127.0.0.1", int(sys.argv[1]), app, handler_class=Quiet).serve_forever()
