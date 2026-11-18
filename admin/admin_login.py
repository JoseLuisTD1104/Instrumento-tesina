"""Login de la única persona administradora de "corto".

Clase independiente del feed y del servidor web: no importa Flask.
El servidor (app.py) solo usa sus métodos públicos.
"""
from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError


class ConfiguracionInvalida(Exception):
    """Faltan o están mal las variables de entorno del login."""


@dataclass(frozen=True)
class ResultadoLogin:
    ok: bool
    token: str | None = None
    motivo: str = "credenciales"  # "ok" | "credenciales" | "bloqueado"


@dataclass
class _Sesion:
    creada: float
    ultimo_uso: float
    csrf: str


class AdminLogin:
    # Límites de entrada
    MAX_USUARIO = 64
    MAX_PASSWORD = 128

    # Límite de intentos fallidos
    INTENTOS_POR_IP = 5
    INTENTOS_GLOBALES = 20
    VENTANA_SEG = 15 * 60
    BLOQUEO_SEG = 15 * 60
    MAX_IPS_REGISTRADAS = 10_000

    # Vida de la sesión
    INACTIVIDAD_SEG = 15 * 60
    DURACION_MAX_SEG = 8 * 60 * 60

    def __init__(self, hash_usuario: str, hash_password: str, clave_secreta: str) -> None:
        for nombre, valor in (("usuario", hash_usuario), ("contraseña", hash_password)):
            if not valor or not valor.startswith("$argon2id$"):
                raise ConfiguracionInvalida(f"El hash de {nombre} falta o no es Argon2id.")
        if not clave_secreta or len(clave_secreta) < 32:
            raise ConfiguracionInvalida("La clave secreta falta o tiene menos de 32 caracteres.")

        self._hasher = PasswordHasher()  # Argon2id con parámetros recomendados por la librería
        self._hash_usuario = hash_usuario
        self._hash_password = hash_password
        self._clave = clave_secreta.encode()

        self._lock = threading.Lock()
        self._sesiones: dict[str, _Sesion] = {}  # clave: SHA-256 del token, nunca el token
        self._fallos_ip: dict[str, list[float]] = {}
        self._bloqueo_ip: dict[str, float] = {}
        self._fallos_globales: list[float] = []
        self._bloqueo_global = 0.0

    @classmethod
    def desde_entorno(cls, entorno: dict | None = None) -> "AdminLogin":
        entorno = os.environ if entorno is None else entorno
        return cls(
            entorno.get("CORTO_ADMIN_USUARIO_HASH", ""),
            entorno.get("CORTO_ADMIN_PASSWORD_HASH", ""),
            entorno.get("CORTO_CLAVE_SECRETA", ""),
        )

    # ------------------------------------------------------------------ login
    def iniciar_sesion(self, usuario: object, password: object, ip: str) -> ResultadoLogin:
        ahora = time.monotonic()
        with self._lock:
            if self._esta_bloqueado(ip, ahora):
                return ResultadoLogin(False, motivo="bloqueado")

        valido = (
            isinstance(usuario, str) and isinstance(password, str)
            and 0 < len(usuario) <= self.MAX_USUARIO
            and 0 < len(password) <= self.MAX_PASSWORD
        )
        if not valido:
            usuario, password = "", ""

        # Siempre se verifican los dos hashes: mismo tiempo de respuesta
        # falle el usuario, la contraseña o ambos.
        usuario_ok = self._verificar(self._hash_usuario, usuario)
        password_ok = self._verificar(self._hash_password, password)

        with self._lock:
            if not (valido and usuario_ok and password_ok):
                self._registrar_fallo(ip, ahora)
                return ResultadoLogin(False, motivo="credenciales")

            self._fallos_ip.pop(ip, None)
            token = secrets.token_urlsafe(32)
            # Una sola persona administradora: un nuevo login cierra la sesión anterior.
            self._sesiones.clear()
            self._sesiones[self._id(token)] = _Sesion(ahora, ahora, secrets.token_urlsafe(32))
            return ResultadoLogin(True, token=token, motivo="ok")

    def validar_sesion(self, token: str | None) -> bool:
        if not token:
            return False
        ahora = time.monotonic()
        with self._lock:
            clave = self._id(token)
            sesion = self._sesiones.get(clave)
            if sesion is None:
                return False
            if (ahora - sesion.ultimo_uso > self.INACTIVIDAD_SEG
                    or ahora - sesion.creada > self.DURACION_MAX_SEG):
                del self._sesiones[clave]
                return False
            sesion.ultimo_uso = ahora
            return True

    def cerrar_sesion(self, token: str | None) -> None:
        if token:
            with self._lock:
                self._sesiones.pop(self._id(token), None)

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
    def _verificar(self, hash_guardado: str, valor: str) -> bool:
        try:
            return self._hasher.verify(hash_guardado, valor)
        except (VerifyMismatchError, VerificationError, InvalidHashError):
            return False

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
        """Evita que el registro de intentos crezca sin límite."""
        limite = ahora - self.VENTANA_SEG
        self._bloqueo_ip = {ip: t for ip, t in self._bloqueo_ip.items() if t > ahora}
        if len(self._fallos_ip) > self.MAX_IPS_REGISTRADAS:
            self._fallos_ip = {ip: f for ip, f in self._fallos_ip.items() if f and f[-1] > limite}

    def _firmar(self, valor: str) -> str:
        return hmac.new(self._clave, valor.encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def _id(token: str) -> str:
        return hashlib.sha256(token.encode()).hexdigest()
