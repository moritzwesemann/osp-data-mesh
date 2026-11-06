# Konzepte zum Angebot

Die Ausschreibung „OSP-Data-Mesh“ des Landessportverbands Baden-Württemberg e. V. verlangt mit dem Angebot
mehrere Konzepte. Dieser Abschnitt enthält sie – jeweils in sich geschlossen und auf die Ausschreibung
bezogen. Einzelheiten stehen in der übrigen Dokumentation; die Konzepte verweisen dorthin.

> **Ausgangslage.** Die Software ist als Prototyp **fertig umgesetzt und getestet** (847 automatisierte
> Tests, 12 Abläufe im Browser, Demo mit drei Knoten und 57 Prüfungen, Neuinstallation nur nach
> Dokumentation). Die Konzepte beschreiben deshalb nicht, was gebaut *werden soll*, sondern was **gebaut
> ist**, wie es betrieben wird und was vor einem Echtbetrieb noch zu tun ist. Ein Projektplan für die
> Umsetzung entfällt.

## Übersicht

| Gefordert in der Ausschreibung | Konzept |
|---|---|
| Produktkonzept mit technischer Umsetzung (Architektur, Containerisierung, Datenintegration) | [Produktkonzept](produktkonzept.md) |
| Sicherheitskonzept (Verschlüsselung, Authentifizierung, Rollen und Rechte, Schwachstellenmanagement) | [Sicherheitskonzept (Kurzfassung)](sicherheitskonzept.md) |
| Datenschutzkonzept einschließlich Umgang mit personenbezogenen Daten und Einwilligungen | [Datenschutzkonzept (Kurzfassung)](datenschutzkonzept.md) |
| Betriebskonzept (Sicherung, Wiederherstellung, Bereitstellung, Incident Response, Updatefähigkeit) | [Betriebskonzept](betriebskonzept.md) |
| Konzept für Rollen, Zugriff und Einwilligung/Freigabe einschließlich Protokollierung | [Rollen-, Zugriffs- und Freigabekonzept](rollen-und-freigabekonzept.md) |
| Beschreibung der erforderlichen Mitwirkung und der Zugangsbedarfe des Auftraggebers | [Mitwirkung des Auftraggebers](mitwirkung.md) |
| Nachweis der Gleichwertigkeit bei Abweichung von geforderter Technik; Offenlegung aller Annahmen | [Annahmen, Abweichungen und Gleichwertigkeit](annahmen.md) |

Nicht Teil dieses Abschnitts: Projektplan (die Software ist fertig), Angaben zur Eignung (Team,
Referenzen, Erklärungen) und das Preisblatt.

## Kurzbeschreibung der Lösung

Jeder Olympiastützpunkt (OSP) betreibt einen eigenen **Knoten**: einen Server mit Web-Oberfläche, REST-API
und eigener PostgreSQL-Datenbank, als Container oder nativ. Daten kommen aus CSV- und Excel-Dateien oder
über HTTP-Schnittstellen von Messsystemen und Fachanwendungen in den Knoten, werden geprüft, als
**Datenprodukte** beschrieben und nur über ausdrückliche **Freigaben** weitergegeben – an Rollen im
eigenen OSP, an BI-Werkzeuge oder an andere OSP. Knoten tauschen Daten direkt miteinander aus, signiert und
mit Pseudonymen; es gibt **keine zentrale Datenhaltung** und keine Gesamtsynchronisation. Jeder Zugriff
auf Personendaten, jede Freigabe und jeder Austausch steht in einem manipulationsgeschützten Audit-Log.
Auswertungen laufen über Apache Superset (drei Referenz-Dashboards) oder über offene Schnittstellen für
Excel, Power BI, Tableau, SAP Analytics Cloud und Python.

## Nachweise

- Anforderungen der Ausschreibung mit Nachweis je Punkt: [Anforderungen und Nachverfolgbarkeit](../requirements.md)
- Abnahmekriterien und Prüfschritte: [Abnahme](../abnahme.md)
- Quellcode: öffentliches Repository https://github.com/moritzwesemann/osp-data-mesh (EUPL-1.2)
