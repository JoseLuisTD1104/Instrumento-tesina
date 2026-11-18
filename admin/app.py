"""Servidor del panel de administrador de "corto" (separado del feed).

Solo conecta rutas HTTP con los métodos de AdminLogin.
"""
import logging
import secrets
from functools import wraps

from dotenv import load_dotenv
from flask import Flask, g, redirect, render_template_string, request, url_for

from admin_login import AdminLogin

load_dotenv()
auth = AdminLogin.desde_entorno()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 4 * 1024  # el login no necesita más

COOKIE_SESION = "__Host-corto_admin"
COOKIE_CSRF = "__Host-corto_csrf"
COOKIE_OPCIONES = {"secure": True, "httponly": True, "samesite": "Strict", "path": "/"}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("corto.admin")

MENSAJES = {
    "credenciales": "Usuario o contraseña incorrectos.",
    "bloqueado": "Demasiados intentos fallidos. Intenta de nuevo más tarde.",
    "solicitud": "La solicitud no es válida. Recarga la página e intenta de nuevo.",
}

PLANTILLA = """<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>corto · admin</title>
<style nonce="{{ nonce }}">
:root{--bg:#0f1013;--surface:#1c1d22;--text:#f2f2f4;--dim:#a6a7ad;--accent:#ff3b5c}
*{box-sizing:border-box;margin:0}
body{min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
.card{width:100%;max-width:360px;background:var(--surface);border-radius:14px;padding:28px}
.logo{font-weight:800;font-size:24px;text-align:center;margin-bottom:4px}.logo span{color:var(--accent)}
.sub{text-align:center;color:var(--dim);font-size:14px;margin-bottom:24px}
label{display:block;font-size:13px;color:var(--dim);margin:14px 0 6px}
input{width:100%;padding:11px 12px;border-radius:8px;border:1px solid #33343a;background:var(--bg);color:var(--text);font:inherit}
input:focus{outline:2px solid var(--text);outline-offset:1px}
button{width:100%;margin-top:22px;padding:11px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;cursor:pointer}
.error{background:#3a1820;color:#ffb3c0;border-radius:8px;padding:10px 12px;font-size:14px}
</style></head><body><main class="card">
<div class="logo">corto<span>.</span></div>
{% if panel %}
<p class="sub">Sesión de administrador iniciada.</p>
<form method="post" action="{{ url_for('logout') }}">
<input type="hidden" name="csrf" value="{{ csrf }}">
<button type="submit">Cerrar sesión</button></form>
{% else %}
<p class="sub">Panel de administrador</p>
{% if error %}<p class="error" role="alert">{{ error }}</p>{% endif %}
<form method="post" action="{{ url_for('login') }}" autocomplete="on">
<input type="hidden" name="csrf" value="{{ csrf }}">
<label for="usuario">Usuario</label>
<input id="usuario" name="usuario" autocomplete="username" maxlength="64" required autofocus>
<label for="password">Contraseña</label>
<input id="password" name="password" type="password" autocomplete="current-password" maxlength="128" required>
<button type="submit">Iniciar sesión</button></form>
{% endif %}
</main></body></html>"""


@app.before_request
def preparar_nonce():
    g.nonce = secrets.token_urlsafe(16)


@app.after_request
def cabeceras_seguridad(resp):
    resp.headers["Content-Security-Policy"] = (
        f"default-src 'none'; style-src 'nonce-{g.get('nonce', '')}'; "
        "form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
    )
    resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    resp.headers["Cross-Origin-Opener-Policy"] = "same-origin"
    resp.headers["Cache-Control"] = "no-store"
    resp.headers.pop("Server", None)
    return resp


def ip_cliente() -> str:
    # Sin proxy delante. Si se pone uno, configurar werkzeug ProxyFix
    # en vez de leer X-Forwarded-For a mano (se puede falsificar).
    return request.remote_addr or "desconocida"


def pagina_login(error_clave=None, estado=200):
    valor_cookie, valor_form = auth.crear_csrf_previo()
    html = render_template_string(PLANTILLA, nonce=g.nonce, panel=False, csrf=valor_form,
                                  error=MENSAJES.get(error_clave))
    resp = app.make_response((html, estado))
    resp.set_cookie(COOKIE_CSRF, valor_cookie, **COOKIE_OPCIONES)
    return resp


def requiere_admin(vista):
    """Punto de conexión para el resto del panel: protege cualquier ruta."""
    @wraps(vista)
    def envoltura(*args, **kwargs):
        token = request.cookies.get(COOKIE_SESION)
        if not auth.validar_sesion(token):
            resp = redirect(url_for("login"))
            resp.delete_cookie(COOKIE_SESION, path="/", secure=True, samesite="Strict")
            return resp
        g.token = token
        return vista(*args, **kwargs)
    return envoltura


@app.get("/admin/login")
def login():
    if auth.validar_sesion(request.cookies.get(COOKIE_SESION)):
        return redirect(url_for("panel"))
    return pagina_login()


@app.post("/admin/login")
def login_post():
    ip = ip_cliente()
    if not auth.verificar_csrf_previo(request.cookies.get(COOKIE_CSRF), request.form.get("csrf")):
        log.warning("login_csrf_invalido ip=%r", ip)
        return pagina_login("solicitud", 400)

    resultado = auth.iniciar_sesion(request.form.get("usuario"), request.form.get("password"), ip)
    if not resultado.ok:
        log.warning("login_fallido motivo=%s ip=%r", resultado.motivo, ip)
        return pagina_login(resultado.motivo, 429 if resultado.motivo == "bloqueado" else 401)

    log.info("login_correcto ip=%r", ip)
    resp = redirect(url_for("panel"))
    resp.set_cookie(COOKIE_SESION, resultado.token, **COOKIE_OPCIONES)  # cookie de sesión: sin max_age
    resp.delete_cookie(COOKIE_CSRF, path="/", secure=True, samesite="Strict")
    return resp


@app.get("/admin")
@requiere_admin
def panel():
    return render_template_string(PLANTILLA, nonce=g.nonce, panel=True,
                                  csrf=auth.csrf_de_sesion(g.token))


@app.post("/admin/logout")
@requiere_admin
def logout():
    if not auth.verificar_csrf_sesion(g.token, request.form.get("csrf")):
        log.warning("logout_csrf_invalido ip=%r", ip_cliente())
        return redirect(url_for("panel"))
    auth.cerrar_sesion(g.token)
    log.info("logout ip=%r", ip_cliente())
    resp = redirect(url_for("login"))
    resp.delete_cookie(COOKIE_SESION, path="/", secure=True, samesite="Strict")
    return resp


@app.errorhandler(400)
@app.errorhandler(404)
@app.errorhandler(405)
@app.errorhandler(413)
@app.errorhandler(500)
def error_generico(e):
    codigo = getattr(e, "code", 500)
    return "Error", codigo


if __name__ == "__main__":
    # HTTPS local con certificado autofirmado (las cookies __Host- exigen Secure).
    app.run(host="127.0.0.1", port=8443, ssl_context="adhoc", debug=False)
