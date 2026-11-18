"""Genera el contenido de .env: hashes Argon2id del usuario y la contraseña y la clave secreta.

No guarda nada en disco ni muestra la contraseña: solo imprime los hashes.
"""
import secrets
from getpass import getpass

from argon2 import PasswordHasher


def pedir(texto: str, minimo: int, maximo: int, oculto: bool) -> str:
    leer = getpass if oculto else input
    while True:
        valor = leer(texto)
        if not (minimo <= len(valor) <= maximo):
            print(f"Debe tener entre {minimo} y {maximo} caracteres.")
            continue
        if oculto and leer("Repítela: ") != valor:
            print("No coinciden.")
            continue
        return valor


if __name__ == "__main__":
    ph = PasswordHasher()
    usuario = pedir("Usuario: ", 3, 64, oculto=False)
    password = pedir("Contraseña (mín. 12): ", 12, 128, oculto=True)
    print("\n# Copia estas líneas en .env (las comillas simples son necesarias)")
    print(f"CORTO_ADMIN_USUARIO_HASH='{ph.hash(usuario)}'")
    print(f"CORTO_ADMIN_PASSWORD_HASH='{ph.hash(password)}'")
    print(f"CORTO_CLAVE_SECRETA='{secrets.token_urlsafe(48)}'")
