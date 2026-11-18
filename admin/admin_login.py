"""Login de la única persona administradora de "corto" con Supabase Auth.

Clase independiente del feed y del servidor web: no importa Flask.
El servidor (app.py) solo usa sus métodos públicos.

Los tokens de Supabase nunca llegan al navegador: se guardan en memoria del
servidor y el navegador solo recibe un identificador de sesión aleatorio.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx


class ConfiguracionInvalida(Exception):
    """Faltan o están mal las variables de entorno del login."""


@dataclass(frozen=True)
class ResultadoLogin:
    ok: bool
    token: str | None = None
    motivo: str = "credenciales"  # "ok" | "credenciales" | "bloqueado" | "servicio"


@dataclass
class _Sesion:
    creada: float
    ultimo_uso: float
    csrf: str
    access_token: str
    refresh_token: str
    expira: float  # monotonic


class AdminLogin:
    MAX_CORREO = 254
    MAX_PASSWORD = 128

    # Límite local de intentos (además del que aplica Supabase)
    INTENTOS_POR_IP = 5
    INTENTOS_GLOBALES = 20
    VENTANA_SEG = 15 * 60
    BLOQUEO_SEG = 15 * 60
    MAX_IPS_REGISTRADAS = 10_000

    # Vida de la sesión del panel
    INACTIVIDAD_SEG = 15 * 60
    DURACION_MAX_SEG = 8 * 60 * 60
    MARGEN_RENOVACION_SEG = 60

    TIMEOUT_SEG = 10

    def __init__(self, url: str, clave_publicable: str, transporte: httpx.BaseTransport | None = None) -> None:
        url = (url or "").strip().rstrip("/")
        partes = urlparse(url)
        if partes.scheme != "https" or not partes.netloc or "." not in partes.netloc:
            raise ConfiguracionInvalida("SUPABASE_URL falta o no es una URL https completa (ej. https://xxxx.supabase.co).")
        if not clave_publicable or not clave_publicable.startswith("sb_publishable_"):
            raise ConfiguracionInvalida("SUPABASE_PUBLISHABLE_KEY falta o no es una clave publicable.")

        self._auth_url = f"{url}/auth/v1"
        self._http = httpx.Client(
            timeout=self.TIMEOUT_SEG,
            follow_redirects=False,
            headers={"apikey": clave_publicable, "Content-Type": "application/json"},
            transport=transporte,
        )
        self._clave_csrf = secrets.token_bytes(32)  # vive solo mientras corre el servidor

        self._lock = threading.Lock()
        self._sesiones: dict[str, _Sesion] = {}  # clave: SHA-256 del token, nunca el token
        self._fallos_ip: dict[str, list[float]] = {}
        self._bloqueo_ip: dict[str, float] = {}
        self._fallos_globales: list[float] = []
        self._bloqueo_global = 0.0

    @classmethod
    def desde_entorno(cls, entorno: dict | None = None) -> "AdminLogin":
        entorno = os.environ if entorno is None else entorno
        return cls(entorno.get("SUPABASE_URL", ""), entorno.get("SUPABASE_PUBLISHABLE_KEY", ""))

    # ------------------------------------------------------------------ login
    def iniciar_sesion(self, correo: object, password: object, ip: str) -> ResultadoLogin:
        ahora = time.monotonic()
        with self._lock:
            if self._esta_bloqueado(ip, ahora):
                return ResultadoLogin(False, motivo="bloqueado")

        valido = (
            isinstance(correo, str) and isinstance(password, str)
            and 3 <= len(correo) <= self.MAX_CORREO and "@" in correo
            and 0 < len(password) <= self.MAX_PASSWORD
        )
        if not valido:
            with self._lock:
                self._registrar_fallo(ip, ahora)
            return ResultadoLogin(False, motivo="credenciales")

        try:
            r = self._http.post(f"{self._auth_url}/token", params={"grant_type": "password"},
                                json={"email": correo.strip(), "password": password})
        except httpx.HTTPError:
            return ResultadoLogin(False, motivo="servicio")

        if r.status_code == 429:
            return ResultadoLogin(False, motivo="bloqueado")
        if r.status_code >= 500:
            return ResultadoLogin(False, motivo="servicio")

        datos = self._json(r)
        if r.status_code != 200 or not datos.get("access_token") or not datos.get("refresh_token"):
            # Supabase responde igual si falla el correo o la contraseña; aquí también.
            with self._lock:
                self._registrar_fallo(ip, ahora)
            return ResultadoLogin(False, motivo="credenciales")

        token = secrets.token_urlsafe(32)
        sesion = _Sesion(ahora, ahora, secrets.token_urlsafe(32),
                         datos["access_token"], datos["refresh_token"],
                         ahora + self._expira_en(datos))
        with self._lock:
            self._fallos_ip.pop(ip, None)
            self._sesiones.clear()  # una sola persona administradora: un login nuevo cierra el anterior
            self._sesiones[self._id(token)] = sesion
        return ResultadoLogin(True, token=token, motivo="ok")

    def validar_sesion(self, token: str | None) -> bool:
        if not token:
            return False
        ahora = time.monotonic()
        clave = self._id(token)
        with self._lock:
            sesion = self._sesiones.get(clave)
            if sesion is None:
                return False
            if (ahora - sesion.ultimo_uso > self.INACTIVIDAD_SEG
                    or ahora - sesion.creada > self.DURACION_MAX_SEG):
                del self._sesiones[clave]
                return False
            sesion.ultimo_uso = ahora
            necesita_renovar = sesion.expira - ahora < self.MARGEN_RENOVACION_SEG
            refresh = sesion.refresh_token

        if necesita_renovar:
            return self._renovar(clave, refresh)
        return True

    def cerrar_sesion(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            sesion = self._sesiones.pop(self._id(token), None)
        if sesion:
            try:  # revoca también los refresh tokens en Supabase
                self._http.post(f"{self._auth_url}/logout", params={"scope": "global"},
                                headers={"Authorization": f"Bearer {sesion.access_token}"})
            except httpx.HTTPError:
                pass  # la sesión local ya se borró; el access token vence solo

    def token_supabase(self, token: str | None) -> str | None:
        """Para el resto del panel: access token para llamar a Supabase como el administrador."""
        if not self.validar_sesion(token):
            return None
        with self._lock:
            sesion = self._sesiones.get(self._id(token))
            return sesion.access_token if sesion else None

    # ------------------------------------------------------------------- CSRF
    def csrf_de_sesion(self, token: str | None) -> str | None:
        if not token:
            return None
        with self._lock:
            sesion = self._sesiones.get(self._id(token))
            return sesion.csrf if sesion else None

    def verificar_csrf_sesion(self, token: str | None, enviado: object) -> bool:
        esperado = self.csrf_de_sesion(token)
        return bool(esperado) and isinstance(enviado, str) and hmac.compare_digest(esperado, enviado)

    def crear_csrf_previo(self) -> tuple[str, str]:
        """Para el formulario de login (aún sin sesión): (valor_cookie, valor_formulario)."""
        valor = secrets.token_urlsafe(32)
        return valor, self._firmar(valor)

    def verificar_csrf_previo(self, cookie: object, formulario: object) -> bool:
        if not isinstance(cookie, str) or not isinstance(formulario, str) or not cookie:
            return False
        return hmac.compare_digest(self._firmar(cookie), formulario)

    # --------------------------------------------------------------- internos
    def _renovar(self, clave: str, refresh: str) -> bool:
        try:
            r = self._http.post(f"{self._auth_url}/token", params={"grant_type": "refresh_token"},
                                json={"refresh_token": refresh})
            datos = self._json(r) if r.status_code == 200 else {}
        except httpx.HTTPError:
            datos = {}
        with self._lock:
            sesion = self._sesiones.get(clave)
            if sesion is None:
                return False
            if not datos.get("access_token") or not datos.get("refresh_token"):
                del self._sesiones[clave]  # refresh revocado o vencido: se cierra la sesión
                return False
            sesion.access_token = datos["access_token"]
            sesion.refresh_token = datos["refresh_token"]
            sesion.expira = time.monotonic() + self._expira_en(datos)
            return True

    @staticmethod
    def _json(r: httpx.Response) -> dict:
        try:
            datos = r.json()
            return datos if isinstance(datos, dict) else {}
        except ValueError:
            return {}

    @staticmethod
    def _expira_en(datos: dict) -> float:
        valor = datos.get("expires_in")
        return float(valor) if isinstance(valor, (int, float)) and valor > 0 else 300.0

    def _esta_bloqueado(self, ip: str, ahora: float) -> bool:
        return ahora < self._bloqueo_global or ahora < self._bloqueo_ip.get(ip, 0.0)

    def _registrar_fallo(self, ip: str, ahora: float) -> None:
        limite = ahora - self.VENTANA_SEG
        self._purgar(ahora)

        fallos = [t for t in self._fallos_ip.get(ip, []) if t > limite] + [ahora]
        self._fallos_ip[ip] = fallos
        if len(fallos) >= self.INTENTOS_POR_IP:
            self._bloqueo_ip[ip] = ahora + self.BLOQUEO_SEG
            self._fallos_ip.pop(ip, None)

        self._fallos_globales = [t for t in self._fallos_globales if t > limite] + [ahora]
        if len(self._fallos_globales) >= self.INTENTOS_GLOBALES:
            self._bloqueo_global = ahora + self.BLOQUEO_SEG
            self._fallos_globales.clear()

    def _purgar(self, ahora: float) -> None:
        limite = ahora - self.VENTANA_SEG
        self._bloqueo_ip = {ip: t for ip, t in self._bloqueo_ip.items() if t > ahora}
        if len(self._fallos_ip) > self.MAX_IPS_REGISTRADAS:
            self._fallos_ip = {ip: f for ip, f in self._fallos_ip.items() if f and f[-1] > limite}

    def _firmar(self, valor: str) -> str:
        return hmac.new(self._clave_csrf, valor.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _id(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()
