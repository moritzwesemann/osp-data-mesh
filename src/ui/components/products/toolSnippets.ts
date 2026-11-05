/**
 * Code-Beispiele für den Abruf eines freigegebenen Produkts über die REST-API (GET /api/v1/access/{id}/data,
 * Format CSV: UTF-8 mit BOM, Komma, CRLF). Als reine Funktion, damit genau die angezeigten Beispiele geprüft
 * werden können (tests/unit/tool-snippets.test.ts; Ausführung gegen einen Knoten: docs/bi.md).
 */
export interface ToolSnippetInput {
  /** absolute REST-Adresse inkl. purpose und format=csv */
  url: string;
  /** Dateiname ohne Endung (Produktkürzel, [a-z0-9_]) */
  fileBase: string;
  /** Platzhalter für das API-Token */
  token: string;
  /** Hinweis zur Anmeldeart in Power Query (Kommentarzeile, übersetzt) */
  powerQueryAuthHint: string;
}

export interface ToolSnippets {
  curl: string;
  python: string;
  powerQuery: string;
}

export function buildToolSnippets({
  url,
  fileBase,
  token,
  powerQueryAuthHint,
}: ToolSnippetInput): ToolSnippets {
  // --fail: bei HTTP-Fehlern (z. B. abgelaufenes Token) Exit-Code 22 statt der Fehlermeldung in der CSV-Datei
  const curl = `curl --fail -H "Authorization: Bearer ${token}" \\\n  "${url}" \\\n  -o ${fileBase}.csv`;

  const python = [
    'import io',
    '',
    'import pandas as pd',
    'import requests',
    '',
    `URL = "${url}"`,
    `TOKEN = "${token}"`,
    '',
    'resp = requests.get(URL, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=60)',
    'resp.raise_for_status()',
    'df = pd.read_csv(io.StringIO(resp.content.decode("utf-8-sig")))',
    'print(df.head())',
  ].join('\n');

  const powerQuery = [
    `// ${powerQueryAuthHint.replace(/[\r\n]+/g, ' ')}`,
    'let',
    `    Quelle = Web.Contents("${url}", [Headers = [Authorization = "Bearer ${token}"]]),`,
    '    Tabelle = Csv.Document(Quelle, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),',
    '    MitKopfzeile = Table.PromoteHeaders(Tabelle, [PromoteAllScalars = true])',
    'in',
    '    MitKopfzeile',
  ].join('\n');

  return { curl, python, powerQuery };
}
