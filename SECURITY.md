# Sicherheit / Security

## Sicherheitslücke melden

Bitte melden Sie Sicherheitslücken **vertraulich** und nicht als öffentliches Issue:

**[Sicherheitslücke vertraulich melden](https://github.com/moritzwesemann/osp-data-mesh/security/advisories/new)**
(GitHub „Private vulnerability reporting“).

Hilfreich sind: betroffene Version bzw. Commit, Schritte zum Nachvollziehen, mögliche Auswirkungen und – wenn
vorhanden – ein Vorschlag zur Behebung. Wir bestätigen den Eingang in der Regel innerhalb weniger Tage,
stimmen das weitere Vorgehen mit Ihnen ab und nennen Sie auf Wunsch in der Veröffentlichung.

Bitte verwenden Sie für Tests ausschließlich eigene Installationen (z. B. `bun run demo`) und keine
fremden Systeme oder echten Personendaten.

## Unterstützte Versionen

OSP-Data-Mesh ist ein Prototyp (0.x). Sicherheitskorrekturen erfolgen nur für den aktuellen Stand des
Hauptzweigs `main`.

## Signaturschlüssel der SBOM

Die Software-Stücklisten (SBOM, CycloneDX) unter `sbom/` sind mit dem Ed25519-Schlüssel des Projekts signiert
(eingebettete JSF-Signatur). Öffentlicher Schlüssel: [`sbom/signing-key.pub.pem`](sbom/signing-key.pub.pem),
Fingerabdruck (SHA-256 über den öffentlichen Schlüssel, SPKI/DER):

```
sha256:dc51298d524644db4df630e71bda57e0e291ac8740c7cbc9d54f7feefbad9703
```

Prüfen: `bun run sbom -- verify sbom/osp-data-mesh.cdx.json --public-key sbom/signing-key.pub.pem` (ebenso
`sbom/osp-data-mesh.image.cdx.json`); Fingerabdruck nachrechnen mit
`openssl pkey -pubin -in sbom/signing-key.pub.pem -outform DER | shasum -a 256`.

## Weitere Informationen

Sicherheitskonzept, Schlüsselverwaltung, SBOM (BSI TR-03183-2) und offene Punkte:
[docs/sicherheit.md](docs/sicherheit.md); Vorgehen bei Vorfällen: [docs/incident-response.md](docs/incident-response.md).

---

**English:** Please report security vulnerabilities **privately** via
[GitHub private vulnerability reporting](https://github.com/moritzwesemann/osp-data-mesh/security/advisories/new),
not as a public issue. Only the latest `main` receives fixes. Test against your own installation only.
The SBOMs in `sbom/` are signed with the project key `sbom/signing-key.pub.pem`, fingerprint
`sha256:dc51298d524644db4df630e71bda57e0e291ac8740c7cbc9d54f7feefbad9703`.
