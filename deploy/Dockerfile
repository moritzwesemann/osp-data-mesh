# syntax=docker/dockerfile:1
#
# OSP-Data-Mesh – Container-Abbild eines Knotens (Server, CLI, Web-Oberfläche, HTML-Dokumentation)
#
# Bauen im Wurzelverzeichnis des Repositorys (Build-Kontext = Repository, siehe .dockerignore):
#   docker build -f deploy/Dockerfile -t osp-data-mesh:0.1.0 .
# Üblicherweise baut docker compose das Abbild (deploy/docker-compose.yml).
#
# Stufen:
#   build    alle Abhängigkeiten (inkl. Build-Werkzeuge), baut dist/ui (Vite) und dist/docs (Doku)
#   deps     nur Laufzeit-Abhängigkeiten (bun install --production)
#   runtime  schlankes Abbild: Bun, PostgreSQL-18-Client (pg_dump/pg_restore/psql), Quellcode,
#            Migrationen, gebaute Oberfläche/Doku; läuft als unprivilegierter Benutzer "bun"

# Bun-Version fest auf einen 1.x-Tag gepinnt (auch von scripts/sbom.ts gelesen)
ARG BUN_VERSION=1.4.3

# ------------------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS build
WORKDIR /app
COPY package.json bun.lock ./
# --frozen-lockfile: bricht ab, wenn bun.lock nicht zu package.json passt (reproduzierbarer Build)
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# ------------------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION} AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ------------------------------------------------------------------------------------------------
FROM oven/bun:${BUN_VERSION}-slim AS runtime

# PostgreSQL-18-Client-Werkzeuge (pg_dump, pg_restore, psql) für Sicherung, Wiederherstellung und
# db-bootstrap. Debian liefert nicht in jeder Version PostgreSQL 18 aus; daher wird das offizielle
# Paket-Repository der PostgreSQL-Gemeinschaft (PGDG, https://apt.postgresql.org) eingebunden.
# Der Signaturschlüssel wird per HTTPS von postgresql.org geladen und nur für dieses Repository
# zugelassen (signed-by). Die Debian-Version (z. B. "trixie") wird aus /etc/os-release gelesen.
# pg_dump muss mindestens die Hauptversion des Servers haben (hier 18). Die Hauptversion ist über den
# Paketnamen festgelegt; Patch-Versionen werden bewusst nicht gepinnt, damit ein Neubau
# Sicherheitsupdates erhält (PGDG entfernt ältere Patch-Versionen ohnehin aus dem Repository).
# hadolint ignore=DL3008
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    install -d -m 0755 /usr/share/postgresql-common/pgdg; \
    curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
      https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
    . /etc/os-release; \
    echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-client-18; \
    apt-get purge -y --auto-remove curl; \
    rm -rf /var/lib/apt/lists/*; \
    /usr/lib/postgresql/18/bin/pg_dump --version

ENV NODE_ENV=production \
    MESH_DEPLOYMENT=docker \
    PATH=/usr/lib/postgresql/18/bin:$PATH \
    MESH_HOST=0.0.0.0 \
    MESH_PORT=4401 \
    MESH_UI_DIR=/app/dist/ui \
    MESH_DOCS_DIR=/app/dist/docs \
    MESH_BACKUP_DIR=/var/lib/osp-mesh/backups \
    MESH_PG_DUMP=/usr/lib/postgresql/18/bin/pg_dump

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json bun.lock tsconfig.json LICENSE ./
COPY src ./src
COPY migrations ./migrations
COPY deploy/postgres/bootstrap.sql ./deploy/postgres/bootstrap.sql
COPY --chmod=0755 deploy/docker-entrypoint.sh ./deploy/docker-entrypoint.sh

# Sicherungsverzeichnis; Benutzer "bun" (UID 1000) stammt aus dem Basisabbild. Ein benanntes Volume
# (docker-compose.yml: "backups") übernimmt beim ersten Einbinden Eigentümer und Rechte von hier.
# Bewusst keine VOLUME-Anweisung: Sonst legte jeder Container ohne diese Einbindung (z. B. "migrate")
# ein anonymes Volume an, das nach dem Entfernen des Containers liegen bliebe.
RUN install -d -o bun -g bun -m 0750 /var/lib/osp-mesh /var/lib/osp-mesh/backups

# Benutzer "bun" des Basisabbilds (UID/GID 1000), numerisch angegeben
USER 1000:1000
EXPOSE 4401

# Lebenszeichen ohne Datenbank (/healthz); curl ist im Laufzeitabbild nicht enthalten
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.MESH_PORT||4401)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

ENTRYPOINT ["/app/deploy/docker-entrypoint.sh"]
CMD ["bun", "src/server/main.ts"]
