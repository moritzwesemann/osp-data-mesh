# ADR 0008: Geheimnisse mit AES-256-GCM und Master-Key aus der Umgebung

## Status

angenommen

Datum: 2026-11-04

## Kontext

Der Knoten speichert Geheimnisse: privaten Ed25519-Schlüssel, Pseudonym-Schlüssel, Zugangsdaten von
API-Quellen (S4). Sie dürfen weder im Klartext in der Datenbank noch in Sicherungen stehen. Ein externes
Schlüsselverwaltungssystem (HSM, Vault) ist bei den OSP nicht vorauszusetzen.

## Entscheidung

- Geheimnisse werden mit **AES-256-GCM** (`node:crypto`) verschlüsselt gespeichert; zufälliger IV je Wert,
  fester Verwendungszweck als zusätzliche authentisierte Daten (AAD), damit Chiffrate nicht zwischen
  Verwendungen vertauscht werden können.
- Der **Master-Key** (32 Byte) kommt ausschließlich aus der Umgebung (`MESH_MASTER_KEY`), nie aus der
  Datenbank.
- Format `v1.<Schlüssel-ID>.<IV|Chiffrat|Tag>`; die **Schlüssel-ID** (Präfix von SHA-256 des Schlüssels)
  steht im Chiffrat. Während einer **Rotation** entschlüsselt der Knoten zusätzlich mit
  `MESH_MASTER_KEY_PREVIOUS`; `rotate-master-key` verschlüsselt alle Geheimnisse neu.
- Sicherungen werden mit einem eigenen Schlüssel (`MESH_BACKUP_KEY`) verschlüsselt.

## Konsequenzen

- Datenbank-Dumps und Sicherungen enthalten keine Klartext-Geheimnisse.
- Der Master-Key muss organisatorisch geschützt und gesichert werden (Verlust = Neuaufbau der Identität).
- Wer Zugriff auf Umgebung und Datenbank zugleich hat, kann entschlüsseln; das ist das bewusst
  akzeptierte Modell ohne HSM. Eine spätere Anbindung eines Schlüsseldienstes ist über die Schlüssel-ID
  vorbereitet.
