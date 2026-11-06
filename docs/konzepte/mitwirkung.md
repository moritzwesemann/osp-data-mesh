# Mitwirkung des Auftraggebers

Diese Seite beschreibt, welche Mitwirkung und welche Zugänge vom Landessportverband und von den
Olympiastützpunkten nötig sind, um die Lösung an echten Standorten einzuführen und abzunehmen. Ohne diese
Beiträge lassen sich insbesondere die Abnahmekriterien „drei Knoten an Pilotstandorten“ und
„Anbindung realer Quellen“ nicht erfüllen.

## Organisation

| Mitwirkung | Wer | Wann |
|---|---|---|
| Ansprechperson des Auftraggebers mit Entscheidungsbefugnis | Landessportverband | zu Beginn |
| Benennung von **drei Pilotstandorten** (OSP) mit je einer Ansprechperson für IT und für Daten | Landessportverband, OSP | zu Beginn |
| Je Pilot-OSP: Personen für die Rollen Administration, Datenverantwortung und Revision | OSP | vor der Installation |
| Teilnahme an Schulungen (Administration, Anwendung) | benannte Personen | vor dem Pilotbetrieb |
| Abstimmung von Abnahmeterminen, Durchführung der Abnahme nach Checkliste | Landessportverband | Abnahme |

## Infrastruktur je Pilotstandort

| Benötigt | Einzelheiten |
|---|---|
| Server oder VM | Linux (Debian 13 oder Ubuntu 24.04) oder Docker-Host, 2 vCPU, 4 GB RAM, 20 GB verschlüsselter Plattenplatz zuzüglich Sicherungen; alternativ beim Dienstleister oder in einer EU-Cloud |
| DNS-Name und Zertifikat | ein Hostname je Knoten (z. B. `mesh.osp-<ort>.de`), bei Superset ein zweiter (`bi.…`); öffentliche Erreichbarkeit für automatische Zertifikate oder ein Zertifikat der internen CA |
| Firewall-Freigaben | eingehend 443 (und 80 für die Weiterleitung) von den Partnerknoten und Nutzenden; ausgehend HTTPS zu den Partnerknoten und zu den angebundenen Messsystemen |
| Ablage für Sicherungen | zweites System für die tägliche Auslagerung der verschlüsselten Sicherungen |
| Passwortverwaltung | sichere Ablage für Master-Key, Sicherungsschlüssel und Datenbankpasswörter (mindestens zwei berechtigte Personen) |
| Zugang für die Einrichtung | zeitlich begrenzter Administrationszugang (SSH bzw. Fernwartung) für die Installation, oder Durchführung durch die IT des OSP nach Anleitung |

## Datenquellen

| Benötigt | Zweck |
|---|---|
| **Mindestens zwei CSV- oder Excel-Quellen** je Pilotstandort mit realistischen Inhalten (z. B. Athletenliste, Leistungsdiagnostik), vorab gerne als anonymisierte Beispieldatei | Einrichtung von Datensätzen, Connectoren und Prüfregeln; Abnahmekriterium AK1 |
| **Mindestens eine API-Quelle** (Messsystem, Fachanwendung oder Cloud-Dienst) mit Schnittstellenbeschreibung und Testzugang (Token oder OAuth2-Client) | Anbindung über den generischen HTTP-Connector; Abnahmekriterium AK1 |
| Kontakt zum Hersteller bzw. Betreiber dieser Systeme | Klärung von Feldbedeutungen, Einheiten, Abrufgrenzen |
| Fachliche Prüfregeln und Wertebereiche (z. B. plausible Sprunghöhen) | Plausibilitätsprüfung beim Import |
| Liste der Zwecke und der gewünschten Datenprodukte | Gestaltung von Produkten und Freigaben |

## Datenschutz und Recht

| Mitwirkung | Hinweis |
|---|---|
| Einbindung der Datenschutzbeauftragten der Pilot-OSP und des Landessportverbands | Prüfung des [Datenschutzkonzepts](datenschutzkonzept.md) |
| Festlegung des Verantwortlichkeitsmodells und der Rechtsgrundlagen je Zweck | Grundlage für die Freigaben |
| Einwilligungstexte (auch für Minderjährige) und Prozess zur Einholung | außerhalb des Systems; Dokumentation im System optional |
| Vereinbarung zum Datenaustausch zwischen den Pilot-OSP | Löschpflichten, Weitergabeverbot, Kontakte |
| Auftragsverarbeitungsvertrag, falls ein Dienstleister oder eine Cloud betreibt | Art. 28 DSGVO |
| Datenschutz-Folgenabschätzung | empfohlen vor dem Echtbetrieb mit Gesundheitsdaten |
| Aufbewahrungsfristen | Fachdaten, Einwilligungsnachweise, Audit-Log, Sicherungen |

## Sicherheit

- Entscheidung über einen **externen Penetrationstest** vor dem Echtbetrieb (Beauftragung durch den
  Auftraggeber oder als eigene Leistung).
- Entscheidung über **Zwei-Faktor-Anmeldung** bzw. Anbindung an einen vorhandenen Verzeichnisdienst
  (SAML/OIDC); dafür Zugang zu einer Testinstanz des Verzeichnisdienstes.
- Kontakte für die Vorlage der [Incident Response](../incident-response.md) (IT-Betrieb,
  Informationssicherheit, Datenschutz, Leitung, Dienstleister).
- Abgleich der Fingerabdrücke zwischen den Pilot-OSP über einen zweiten Kanal (Telefon) beim
  Vertrauensaufbau.

## BI-Werkzeuge

- Angabe, welche Werkzeuge genutzt werden sollen (Superset, Excel, Power BI, Tableau, SAP Analytics Cloud,
  Python).
- Für Werkzeuge mit eigener Lizenz: Bereitstellung von Lizenz und Arbeitsplatz für die Prüfung der
  Anbindung.
- Wünsche für die drei Referenz-Dashboards, falls sie von den mitgelieferten abweichen sollen.

## Was nicht vom Auftraggeber benötigt wird

- Keine zentrale Infrastruktur: kein zentraler Server, keine zentrale Datenbank, keine zentrale
  Registrierungsstelle.
- Keine Lizenzen für die Software selbst (EUPL-1.2) und keine Cloud-Dienste des Auftragnehmers.
- Keine Programmierung für neue Datensätze und für Quellen, die CSV, Excel oder eine JSON-Schnittstelle
  liefern; Datenverantwortliche richten sie in der Oberfläche ein.
