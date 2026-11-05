# Apache Superset für OSP-Data-Mesh (optional, Profil "bi" in deploy/docker-compose.yml)
# Das Abbild selbst ist NICHT LOKAL GEBAUT (kein Docker auf der Entwicklungsmaschine); Konfiguration und
# Einrichtungsskript sind mit Superset 6.1.0 aus PyPI und denselben Abhängigkeitsständen verifiziert
# (README.md, "Lokal ohne Docker prüfen").
#
# Das offizielle Abbild apache/superset:6.1.0 ist das schlanke Abbild ohne Datenbanktreiber;
# ergänzt wird nur der PostgreSQL-Treiber psycopg2-binary (für die Verbindung als mesh_bi).
FROM apache/superset:6.1.0

USER root
RUN . /app/.venv/bin/activate \
 && uv pip install --no-cache "psycopg2-binary==2.9.13"

# Konfiguration (wird über PYTHONPATH=/app/pythonpath geladen) und Einrichtungsskript
COPY superset_config.py /app/pythonpath/superset_config.py
COPY bootstrap_superset.py /app/osp/bootstrap_superset.py

USER superset
