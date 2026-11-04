#!/bin/sh
# Einstiegspunkt des Knoten-Abbilds.
#
# Docker Compose kann Umgebungsvariablen nicht bedingt weglassen: optionale Werte, die in .env leer
# sind (z. B. MESH_MASTER_KEY_PREVIOUS außerhalb einer Schlüsselrotation), kämen als leere Zeichenkette
# an und würden die Konfigurationsprüfung verletzen. Leere MESH_*-Variablen werden daher entfernt,
# sodass die Standardwerte aus src/server/config.ts gelten.
set -eu

for name in $(env | sed -n 's/^\(MESH_[A-Z0-9_]*\)=$/\1/p'); do
  unset "$name"
done

exec "$@"
