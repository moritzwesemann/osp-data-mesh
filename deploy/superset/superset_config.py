"""
Superset-Konfiguration für OSP-Data-Mesh (optional, Profil "bi").

NICHT LOKAL VERIFIZIERT. Wird über PYTHONPATH (/app/pythonpath) geladen und überschreibt die
Standardwerte von Superset. Keine Beispieldaten, keine öffentliche Rolle, Betrieb hinter Caddy (TLS).
"""

import os

# Geheimer Schlüssel für Sitzungen und die Verschlüsselung gespeicherter Verbindungsdaten.
# Erzeugen: openssl rand -base64 42  → SUPERSET_SECRET_KEY in deploy/.env
SECRET_KEY = os.environ.get("SUPERSET_SECRET_KEY", "")
if len(SECRET_KEY) < 32:
    raise RuntimeError(
        "SUPERSET_SECRET_KEY fehlt oder ist zu kurz (mind. 32 Zeichen, z. B. openssl rand -base64 42)"
    )

# Metadaten von Superset (Dashboards, Diagramme, Benutzer) in SQLite im Volume superset_home.
# Für den Referenzbetrieb ausreichend; für größere Installationen eine eigene PostgreSQL-Datenbank
# verwenden (nicht die Knotendatenbank).
SQLALCHEMY_DATABASE_URI = os.environ.get(
    "SUPERSET_METADATA_DB_URI", "sqlite:////app/superset_home/superset.db?check_same_thread=false"
)

# Betrieb hinter Caddy (X-Forwarded-Proto/-For auswerten)
ENABLE_PROXY_FIX = True
PREFERRED_URL_SCHEME = "https"

# Sitzungs-Cookies nur über HTTPS, nicht für Skripte lesbar
SESSION_COOKIE_SECURE = True
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
WTF_CSRF_ENABLED = True
TALISMAN_ENABLED = True

# Keine anonymen Zugriffe, keine Selbstregistrierung
PUBLIC_ROLE_LIKE = None
AUTH_USER_REGISTRATION = False

# Keine Verbindungen zu SQLite-Dateien als Datenquelle
PREVENT_UNSAFE_DB_CONNECTIONS = True

# Keine Jinja-Vorlagen in SQL; Dashboard-Zugriff über Rollen steuerbar
FEATURE_FLAGS = {
    "ENABLE_TEMPLATE_PROCESSING": False,
    "DASHBOARD_RBAC": True,
}

# Sprache der Oberfläche. Hinweis: die veröffentlichten Superset-Abbilder enthalten u. U. nur die
# englische Übersetzung; dann bleibt die Oberfläche englisch.
BABEL_DEFAULT_LOCALE = "de"
LANGUAGES = {
    "de": {"flag": "de", "name": "Deutsch"},
    "en": {"flag": "us", "name": "English"},
}

# Ergebnisgrößen begrenzen
ROW_LIMIT = 50000
SQL_MAX_ROW = 100000
