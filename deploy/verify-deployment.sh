#!/usr/bin/env bash
# OSP-Data-Mesh: Prüfung einer laufenden Docker-Compose-Installation (deploy/docker-compose.yml)
#
# Prüft von außen, was sich mit statischer Prüfung nicht zeigen lässt:
#   - TLS: HTTPS mit gültiger Zertifikatskette (ohne -k), HTTP leitet auf HTTPS um
#   - Sicherheits-Header der Antworten (HSTS, CSP, nosniff, Frame-Schutz, Referrer-Policy, kein Server-Header)
#   - Netztrennung: nur Caddy veröffentlicht Ports (Knoten 4401 und Datenbank 5432 nicht); die Datenbank
#     ist weder aus dem Netz "frontend" noch aus einem fremden Docker-Netz noch vom Docker-Host aus
#     erreichbar; der Knoten ist nur über "frontend" erreichbar; die Datenbank hat keinen Zugang nach
#     außen, der Knoten schon
#   - Proxy-Vertrauen: X-Forwarded-For von einem anderen Container als Caddy wird ignoriert; über Caddy
#     gesetzte X-Forwarded-For-Angaben eines Clients werden von Caddy ersetzt
#   - optional: BI-Datenbankzugang (docker-compose.bi-db.yml) nur für mesh_bi mit TLS, Superset (Profil
#     "bi") über HTTPS, TLS-Vertrauen des Knotens zu einem Partnerknoten
#
# Aufruf im Verzeichnis deploy/ (dort, wo .env und docker-compose.yml liegen), auf dem Docker-Host:
#   ./verify-deployment.sh
# mit BI-Datenbankzugang:
#   COMPOSE_FILE=docker-compose.yml:docker-compose.bi-db.yml ./verify-deployment.sh
#
# Optionale Umgebungsvariablen:
#   VERIFY_ADDR        Adresse, unter der Caddy vom Docker-Host aus erreichbar ist (Standard: CADDY_BIND,
#                      bei 0.0.0.0 bzw. leer 127.0.0.1). Der DNS-Name (CADDY_DOMAIN) wird für die Prüfung
#                      per curl --resolve auf diese Adresse gelenkt; das Zertifikat wird für den Namen geprüft.
#   VERIFY_CACERT      Wurzelzertifikat für die TLS-Prüfung. Standard bei CADDY_TLS=internal: Caddys
#                      lokale CA (wird aus dem Container exportiert); sonst die CAs des Systems (ACME).
#   VERIFY_EGRESS_URL  Ziel für den Test des ausgehenden Zugangs des Knotens (Standard https://apt.postgresql.org/)
#   VERIFY_PEER_URL    MESH_PUBLIC_URL eines Partnerknotens: vom Knoten-Container aus per HTTPS abrufen
#                      (prüft, dass der Knoten dem Zertifikat des Partners vertraut)
#   VERIFY_SKIP_XFF=1  X-Forwarded-For-Prüfung auslassen. Sie schreibt zwei abgelehnte Anmeldeversuche
#                      (auth.login, E-Mail verify-deployment@example.invalid) in das Audit-Log.
#   COMPOSE_PROJECT_NAME, COMPOSE_FILE, COMPOSE_PROFILES: wie bei docker compose
#
# Voraussetzungen auf dem Docker-Host: docker (mit Compose-Plugin), curl; openssl optional (Anzeige des
# Zertifikats). Die Hilfscontainer verwenden die vorhandenen Abbilder (postgres, Knoten), es wird nichts
# heruntergeladen. Exit-Code 0 nur, wenn alle Prüfungen bestanden sind.
set -u

FAILS=0
WARNS=0
ok() { printf '  [ok]      %s\n' "$*"; }
fail() { printf '  [FEHLER]  %s\n' "$*"; FAILS=$((FAILS + 1)); }
warn() { printf '  [Hinweis] %s\n' "$*"; WARNS=$((WARNS + 1)); }
section() { printf '\n%s\n' "$*"; }
# expect_ok <ok-Text> <Fehlertext> <Befehl…>: Befehl erfolgreich → ok, sonst Fehler; expect_fail umgekehrt
expect_ok() { local m_ok=$1 m_fail=$2; shift 2; if "$@"; then ok "$m_ok"; else fail "$m_fail"; fi; }
expect_fail() { local m_ok=$1 m_fail=$2; shift 2; if "$@"; then fail "$m_fail"; else ok "$m_ok"; fi; }

TMP=$(mktemp -d "${TMPDIR:-/tmp}/osp-verify.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

dc() { docker compose "$@"; }
# Container eines Dienstes über die Compose-Kennzeichnung (unabhängig von aktiven Profilen); PROJECT
# wird nach dem Start bestimmt, vorher (für node) über docker compose ps
PROJECT=""
cid() {
  if [ -n "$PROJECT" ]; then
    docker ps -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=$1" | head -n 1
  else
    dc ps -q "$1" 2>/dev/null | head -n 1
  fi
}
cenv() { dc exec -T "$1" printenv "$2" 2>/dev/null | tr -d '\r'; }
# Adresse eines Containers im angegebenen Netz
cip() { docker inspect -f "{{with index .NetworkSettings.Networks \"$2\"}}{{.IPAddress}}{{end}}" "$1" 2>/dev/null; }
# TCP-Verbindungsversuch aus einem Hilfscontainer (Netz $1: Name, "host" oder "none"); 0 = erreichbar
tcp_probe() { docker run --rm --network "$1" --entrypoint timeout "$PROBE_IMAGE" 4 bash -c "</dev/tcp/$2/$3" >/dev/null 2>&1; }

command -v docker >/dev/null || { echo "docker fehlt" >&2; exit 2; }
command -v curl >/dev/null || { echo "curl fehlt" >&2; exit 2; }
[ -f docker-compose.yml ] || { echo "Bitte im Verzeichnis deploy/ aufrufen (docker-compose.yml fehlt)" >&2; exit 2; }

echo "OSP-Data-Mesh – Prüfung der Docker-Installation"

# ---------------------------------------------------------------------------------------------------
section "1. Container"
NODE=$(cid node)
[ -n "$NODE" ] && PROJECT=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$NODE")
DB=$(cid db); CADDY=$(cid caddy)
if [ -z "$DB" ] || [ -z "$NODE" ] || [ -z "$CADDY" ]; then
  fail "db, node und caddy müssen laufen (docker compose up -d)"
  echo; echo "Abbruch: $FAILS Fehler"; exit 1
fi
for svc in db node; do
  h=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}keine Prüfung{{end}}' "$(cid $svc)")
  expect_ok "$svc: healthy" "$svc: $h (erwartet healthy)" [ "$h" = healthy ]
done
s=$(docker inspect -f '{{.State.Status}}' "$CADDY")
expect_ok "caddy: running" "caddy: $s" [ "$s" = running ]
MIG=$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.service=migrate" | head -n 1)
if [ -n "$MIG" ]; then
  m=$(docker inspect -f '{{.State.Status}} {{.State.ExitCode}}' "$MIG")
  expect_ok "migrate: Exited (0)" "migrate: $m (erwartet exited 0)" [ "$m" = "exited 0" ]
fi
PROBE_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$DB")    # postgres:18 – bash, timeout, psql
NODE_IMAGE=$(docker inspect -f '{{.Config.Image}}' "$NODE")   # Bun für HTTP-Anfragen

# Netze über die Compose-Kennzeichnung bestimmen (zusätzliche Netze in Override-Dateien stören nicht)
net() { docker network ls -q --filter "label=com.docker.compose.project=$PROJECT" --filter "label=com.docker.compose.network=$1" \
  | head -n 1 | xargs docker network inspect -f '{{.Name}}' 2>/dev/null; }
FRONTEND=$(net frontend); BACKEND=$(net backend)
echo "  Projekt: $PROJECT, Netze: frontend=$FRONTEND backend=$BACKEND"
if [ -z "$FRONTEND" ] || [ -z "$BACKEND" ]; then
  fail "Netze frontend/backend des Projekts nicht gefunden"; echo; echo "Abbruch: $FAILS Fehler"; exit 1
fi

DOMAIN=$(cenv caddy CADDY_DOMAIN)
TLS_MODE=$(cenv caddy CADDY_TLS)
HTTPS_PORT=$(cenv caddy CADDY_HTTPS_PORT); HTTPS_PORT=${HTTPS_PORT:-443}
HTTP_PORT=$(cenv caddy CADDY_HTTP_PORT); HTTP_PORT=${HTTP_PORT:-80}
BI_DOMAIN=$(cenv caddy MESH_BI_DOMAIN)
PUBLIC_URL=$(cenv node MESH_PUBLIC_URL)

# ---------------------------------------------------------------------------------------------------
section "2. Veröffentlichte Ports (nur Caddy; Datenbank nur mit docker-compose.bi-db.yml)"
BI_DB_PUBLISHED=""
for id in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
  name=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' "$id")
  pubs=$(docker inspect -f '{{range $p, $b := .NetworkSettings.Ports}}{{range $b}}{{$p}}={{.HostIp}}:{{.HostPort}} {{end}}{{end}}' "$id")
  [ -z "$pubs" ] && { ok "$name: keine veröffentlichten Ports"; continue; }
  case "$name" in
    caddy) ok "caddy: $pubs" ;;
    db)
      for p in $pubs; do case "$p" in 5432/tcp=*) BI_DB_PUBLISHED=${BI_DB_PUBLISHED:-${p#5432/tcp=}} ;; esac; done
      if printf '%s' "$pubs" | grep -q '=0\.0\.0\.0:\|=:::'; then
        fail "db: $pubs – auf allen Schnittstellen veröffentlicht (BI_DB_BIND auf die interne Adresse setzen)"
      else
        warn "db: $pubs – BI-Datenbankzugang (docker-compose.bi-db.yml), Prüfung unten"
      fi
      ;;
    *) fail "$name: $pubs – darf keine Ports veröffentlichen" ;;
  esac
done

# ---------------------------------------------------------------------------------------------------
section "3. TLS (HTTPS mit gültiger Kette, HTTP → HTTPS)"
BIND=$(docker inspect -f "{{range \$p, \$b := .NetworkSettings.Ports}}{{if eq \$p \"$HTTPS_PORT/tcp\"}}{{range \$b}}{{.HostIp}} {{end}}{{end}}{{end}}" "$CADDY" | awk '{print $1}')
ADDR=${VERIFY_ADDR:-$BIND}
case "$ADDR" in "" | 0.0.0.0 | "::") ADDR=127.0.0.1 ;; esac
case "$ADDR" in *:*) ADDR_URL="[$ADDR]" ;; *) ADDR_URL=$ADDR ;; esac
PORT_SUFFIX=":$HTTPS_PORT"; [ "$HTTPS_PORT" = 443 ] && PORT_SUFFIX=""
BASE="https://$DOMAIN$PORT_SUFFIX"
RESOLVE=(--resolve "$DOMAIN:$HTTPS_PORT:$ADDR" --resolve "$DOMAIN:$HTTP_PORT:$ADDR")
CACERT=(); CACERT_FILE=""
if [ -n "${VERIFY_CACERT:-}" ]; then
  CACERT_FILE=$VERIFY_CACERT
elif [ "${TLS_MODE:-internal}" = internal ]; then
  CACERT_FILE="$TMP/caddy-root.crt"
  if ! dc cp caddy:/data/caddy/pki/authorities/local/root.crt "$CACERT_FILE" >/dev/null 2>&1; then
    fail "Wurzelzertifikat von Caddy (tls internal) nicht exportierbar"; CACERT_FILE=""
  fi
fi
[ -n "$CACERT_FILE" ] && CACERT=(--cacert "$CACERT_FILE")
echo "  Ziel: $BASE (über $ADDR_URL), TLS: ${TLS_MODE:-internal}${CACERT_FILE:+, CA: $CACERT_FILE}"
[ -n "$PUBLIC_URL" ] && [ "${PUBLIC_URL%/}" != "$BASE" ] && warn "MESH_PUBLIC_URL ($PUBLIC_URL) weicht von $BASE ab"

body=$(curl -sS --max-time 10 "${RESOLVE[@]}" "${CACERT[@]}" "$BASE/healthz" 2>"$TMP/err") || true
if printf '%s' "$body" | grep -q '"status":"ok"'; then
  ok "GET $BASE/healthz über HTTPS, Zertifikatskette geprüft: $body"
else
  fail "GET $BASE/healthz: $(cat "$TMP/err") $body"
fi
if [ "${TLS_MODE:-internal}" = internal ] && [ -z "${VERIFY_CACERT:-}" ]; then
  if curl -s --max-time 10 "${RESOLVE[@]}" -o /dev/null "$BASE/healthz" 2>/dev/null; then
    warn "HTTPS ohne Caddys CA ebenfalls akzeptiert (CA im System-Speicher installiert?)"
  else
    ok "ohne Caddys CA wird das Zertifikat abgelehnt (TLS wird tatsächlich geprüft)"
  fi
fi
if command -v openssl >/dev/null; then
  cert=$(openssl s_client -connect "$ADDR_URL:$HTTPS_PORT" -servername "$DOMAIN" ${CACERT_FILE:+-CAfile "$CACERT_FILE"} \
    -verify_hostname "$DOMAIN" -verify_return_error </dev/null 2>/dev/null)
  vr=$(printf '%s\n' "$cert" | sed -n 's/^ *Verify return code: //p' | head -n 1)
  proto=$(printf '%s\n' "$cert" | sed -n 's/^ *Protocol *: *//p; s/^New, \(TLSv[0-9.]*\),.*/\1/p' | head -n 1)
  info=$(printf '%s\n' "$cert" | openssl x509 -noout -issuer -enddate 2>/dev/null | tr '\n' ' ')
  san=$(printf '%s\n' "$cert" | openssl x509 -noout -text 2>/dev/null | grep -o 'DNS:[^,]*' | tr '\n' ' ')
  case "$vr" in
    0*) ok "openssl: $vr, ${proto:-?}; ${san}${info}" ;;
    *) fail "openssl: Verify return code ${vr:-?}" ;;
  esac
fi
body=$(curl -sS --max-time 10 "${RESOLVE[@]}" "${CACERT[@]}" "$BASE/readyz" 2>&1) || true
expect_ok "GET /readyz: $body" "GET /readyz: $body" grep -q '"db":true' <<<"$body"

HTTP_BASE="http://$DOMAIN"; [ "$HTTP_PORT" != 80 ] && HTTP_BASE="http://$DOMAIN:$HTTP_PORT"
r=$(curl -s --max-time 10 "${RESOLVE[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' "$HTTP_BASE/hilfe/" 2>&1) || true
code=${r%% *}; loc=${r#* }
case "$code" in
  301 | 302 | 307 | 308)
    if [ "$loc" = "$BASE/hilfe/" ]; then ok "$HTTP_BASE/hilfe/ → $code $loc"
    else fail "$HTTP_BASE/hilfe/ → $code $loc (erwartet $BASE/hilfe/)"; fi
    ;;
  *) fail "$HTTP_BASE/hilfe/ → $r (erwartet Weiterleitung auf HTTPS)" ;;
esac

# ---------------------------------------------------------------------------------------------------
section "4. Sicherheits-Header (GET $BASE/)"
curl -s --max-time 10 "${RESOLVE[@]}" "${CACERT[@]}" -o /dev/null -D "$TMP/h" "$BASE/" || true
hdr() { grep -i "^$1:" "$TMP/h" | head -n 1 | tr -d '\r'; }
check_hdr() {
  local v; v=$(hdr "$1")
  if [ -n "$v" ] && printf '%s' "$v" | grep -qi -- "$2"; then ok "$v"; else fail "$1 fehlt oder ohne '$2' (${v:-fehlt})"; fi
}
check_hdr strict-transport-security 'max-age=[1-9]'
check_hdr content-security-policy "frame-ancestors 'none'"
check_hdr x-content-type-options nosniff
check_hdr x-frame-options 'deny\|sameorigin'
check_hdr referrer-policy 'no-referrer'
check_hdr cross-origin-resource-policy 'same-origin'
expect_ok "kein Server-Header" "Server-Header vorhanden: $(hdr server)" [ -z "$(hdr server)" ]

# ---------------------------------------------------------------------------------------------------
section "5. Netztrennung"
DB_IP=$(cip "$DB" "$BACKEND"); NODE_FE_IP=$(cip "$NODE" "$FRONTEND"); NODE_BE_IP=$(cip "$NODE" "$BACKEND")
echo "  db=$DB_IP ($BACKEND), node=$NODE_FE_IP ($FRONTEND) / $NODE_BE_IP ($BACKEND)"
expect_ok "Gegenprobe: db:5432 aus dem Netz backend erreichbar" \
  "Gegenprobe: db:5432 aus dem Netz backend nicht erreichbar – Prüfung unzuverlässig" tcp_probe "$BACKEND" db 5432
expect_fail "db:5432 aus dem Netz frontend nicht erreichbar (Name db unbekannt)" \
  "db:5432 aus dem Netz frontend erreichbar (Name)" tcp_probe "$FRONTEND" db 5432
expect_fail "$DB_IP:5432 (db) aus dem Netz frontend nicht erreichbar" \
  "$DB_IP:5432 aus dem Netz frontend erreichbar" tcp_probe "$FRONTEND" "$DB_IP" 5432
expect_fail "$DB_IP:5432 (db) aus einem fremden Docker-Netz (bridge) nicht erreichbar" \
  "$DB_IP:5432 aus einem fremden Docker-Netz erreichbar" tcp_probe bridge "$DB_IP" 5432
expect_fail "$DB_IP:5432 (db) vom Docker-Host aus nicht erreichbar (ohne Host-Adresse im Netz backend)" \
  "$DB_IP:5432 vom Docker-Host aus erreichbar (Netz backend ohne inhibit_ipv4?)" tcp_probe host "$DB_IP" 5432
expect_fail "$NODE_FE_IP:4401 (Knoten) aus einem fremden Docker-Netz (bridge) nicht erreichbar" \
  "$NODE_FE_IP:4401 (Knoten) aus einem fremden Docker-Netz erreichbar" tcp_probe bridge "$NODE_FE_IP" 4401
if tcp_probe host "$NODE_FE_IP" 4401; then
  ok "Knoten 4401: nicht veröffentlicht; nur vom Docker-Host selbst über die Container-Adresse $NODE_FE_IP erreichbar (Docker-Bridge, nicht von anderen Rechnern)"
else
  ok "$NODE_FE_IP:4401 (Knoten) vom Docker-Host aus nicht erreichbar"
fi
if dc exec -T db timeout 4 bash -c '</dev/tcp/1.1.1.1/443' >/dev/null 2>&1; then
  fail "db hat Zugang nach außen (1.1.1.1:443)"
else
  ok "db hat keinen Zugang nach außen (1.1.1.1:443 nicht erreichbar)"
fi
EGRESS=${VERIFY_EGRESS_URL:-https://apt.postgresql.org/}
if out=$(dc exec -T node bun -e "fetch(process.argv[1],{method:'HEAD',redirect:'manual',signal:AbortSignal.timeout(10000)}).then(r=>{console.log('HTTP '+r.status);process.exit(0)},e=>{console.log(String(e&&e.message||e));process.exit(1)})" "$EGRESS" 2>&1); then
  ok "Knoten erreicht $EGRESS ($out)"
else
  fail "Knoten erreicht $EGRESS nicht: $out"
fi

# ---------------------------------------------------------------------------------------------------
section "6. Proxy-Vertrauen (X-Forwarded-For)"
if [ "${VERIFY_SKIP_XFF:-}" = 1 ]; then
  warn "übersprungen (VERIFY_SKIP_XFF=1)"
else
  audit_ip() {
    dc exec -T db psql -U postgres -d mesh -Atc \
      "select coalesce(host(ip::inet), '(leer)') from audit_log where request_id = '$1' and action = 'auth.login'" 2>/dev/null | tr -d '\r' | head -n 1
  }
  LOGIN_BODY='{"email":"verify-deployment@example.invalid","password":"verify-deployment-0000"}'
  # a) direkt aus dem Netz frontend (nicht von Caddy) mit gefälschter Adresse
  rid=$(docker run --rm --network "$FRONTEND" --entrypoint bun "$NODE_IMAGE" -e "
    fetch('http://node:4401/api/v1/auth/login',{method:'POST',headers:{'content-type':'application/json','x-osp-csrf':'1','x-forwarded-for':'203.0.113.77'},body:process.argv[1]})
      .then(r=>{console.log(r.headers.get('x-request-id')||'');process.exit(0)},e=>{console.error(e.message);process.exit(1)})" "$LOGIN_BODY" 2>/dev/null | tr -d '\r')
  ip=$( [ -n "$rid" ] && audit_ip "$rid")
  if [ -z "$rid" ] || [ -z "$ip" ]; then fail "direkte Anfrage aus frontend: kein Audit-Eintrag gefunden (request_id=${rid:-?})"
  elif [ "$ip" = 203.0.113.77 ]; then fail "X-Forwarded-For eines anderen Containers als Caddy wurde übernommen ($ip)"
  else ok "X-Forwarded-For: 203.0.113.77 von einem anderen Container ignoriert; protokolliert: $ip (TCP-Gegenstelle)"; fi
  # b) über Caddy mit vom Client gesetzter Adresse: Caddy ersetzt den Header
  # Caddys feste Adresse = vertrauenswürdiger Proxy des Knotens (aus FRONTEND_NET_PREFIX, Standard 172.31.252.10)
  CADDY_IP=$(cenv node MESH_TRUSTED_PROXIES)
  rid=$(curl -s --max-time 10 "${RESOLVE[@]}" "${CACERT[@]}" -o /dev/null -D - -H 'content-type: application/json' \
    -H 'x-osp-csrf: 1' -H 'x-forwarded-for: 203.0.113.78' --data "$LOGIN_BODY" "$BASE/api/v1/auth/login" \
    | tr -d '\r' | sed -n 's/^[Xx]-[Rr]equest-[Ii]d: //p')
  ip=$( [ -n "$rid" ] && audit_ip "$rid")
  if [ -z "$rid" ] || [ -z "$ip" ]; then fail "Anfrage über Caddy: kein Audit-Eintrag gefunden (request_id=${rid:-?})"
  elif [ "$ip" = 203.0.113.78 ]; then fail "über Caddy vom Client gesetzte X-Forwarded-For-Adresse übernommen"
  elif [ "$ip" = "$CADDY_IP" ]; then fail "über Caddy: Client-Adresse fehlt, protokolliert wurde Caddy selbst ($ip)"
  else ok "über Caddy: Client-Angabe 203.0.113.78 ersetzt; protokolliert: $ip (Client-Adresse aus Caddys Sicht)"; fi
fi

# ---------------------------------------------------------------------------------------------------
if [ -n "$BI_DB_PUBLISHED" ]; then
  section "7. BI-Datenbankzugang ($BI_DB_PUBLISHED, docker-compose.bi-db.yml)"
  BI_HOST=${BI_DB_PUBLISHED%:*}; BI_PORT=${BI_DB_PUBLISHED##*:}
  case "$BI_HOST" in "" | 0.0.0.0) BI_HOST=127.0.0.1 ;; esac
  BI_PW=$(cenv db MESH_DB_BI_PASSWORD)
  pg() { # $1 Rolle, $2 sslmode, $3 Passwort
    # Passwort über die Umgebung weiterreichen (-e PGPASSWORD ohne Wert), nicht in der Befehlszeile (ps)
    PGPASSWORD="$3" docker run --rm --network host -e PGPASSWORD -e PGCONNECT_TIMEOUT=5 --entrypoint psql "$PROBE_IMAGE" \
      "host=$BI_HOST port=$BI_PORT dbname=mesh user=$1 sslmode=$2" -Atc 'select current_user, ssl from pg_stat_ssl where pid = pg_backend_pid()' 2>&1
  }
  out=$(pg mesh_bi require "$BI_PW")
  expect_ok "mesh_bi mit TLS: angemeldet ($out)" "mesh_bi mit TLS: $out" [ "$out" = "mesh_bi|t" ]
  out=$(pg mesh_bi disable "$BI_PW")
  expect_ok "mesh_bi ohne TLS abgelehnt" "mesh_bi ohne TLS: $out" grep -q 'pg_hba.conf' <<<"$out"
  for role in mesh_app mesh_owner postgres; do
    out=$(pg "$role" require "falsch")
    expect_ok "$role über den BI-Port abgelehnt (pg_hba)" "$role über den BI-Port: $out" \
      grep -q 'pg_hba.conf rejects\|no pg_hba.conf entry' <<<"$out"
  done
fi

if [ -n "$(cid superset)" ]; then
  section "8. Apache Superset (Profil bi)"
  BI_BASE="https://$BI_DOMAIN$PORT_SUFFIX"
  r=$(curl -sS --max-time 15 --resolve "$BI_DOMAIN:$HTTPS_PORT:$ADDR" "${CACERT[@]}" -o "$TMP/bi" -w '%{http_code}' "$BI_BASE/health" 2>&1) || true
  expect_ok "GET $BI_BASE/health über HTTPS: $(cat "$TMP/bi" 2>/dev/null)" "GET $BI_BASE/health: $r" [ "$r" = 200 ]
fi

if [ -n "${VERIFY_PEER_URL:-}" ]; then
  section "9. TLS-Vertrauen des Knotens zum Partner ($VERIFY_PEER_URL)"
  if out=$(dc exec -T node bun -e "fetch(process.argv[1].replace(/\/\$/,'')+'/healthz',{signal:AbortSignal.timeout(10000)}).then(async r=>{console.log('HTTP '+r.status+' '+(await r.text()));process.exit(r.ok?0:1)},e=>{console.log(String(e&&e.code||'')+' '+String(e&&e.message||e));process.exit(1)})" "$VERIFY_PEER_URL" 2>&1); then
    ok "Knoten → Partner über HTTPS mit geprüftem Zertifikat: $out"
  else
    fail "Knoten → Partner: $out"
  fi
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "Ergebnis: alle Prüfungen bestanden ($WARNS Hinweise)"
  exit 0
fi
echo "Ergebnis: $FAILS Fehler, $WARNS Hinweise"
exit 1
