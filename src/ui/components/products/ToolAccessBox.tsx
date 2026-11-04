import { Link } from 'react-router';
import { useI18n } from '../../i18n/index.tsx';
import { CodeBlock } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';

interface Props {
  /** absolute REST-Adresse (CSV) inkl. Zweck */
  url: string;
  /** Dateiname ohne Endung */
  fileBase: string;
  purposeLabel: string;
}

/** Hinweise und Code-Beispiele für den Zugriff aus Excel, Power BI, Python und curl. */
export function ToolAccessBox({ url, fileBase, purposeLabel }: Props) {
  const { t } = useI18n();
  const token = t('myData.tokenPlaceholder');

  const curl = `curl -H "Authorization: Bearer ${token}" \\\n  "${url}" \\\n  -o ${fileBase}.csv`;

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
    'let',
    `    Quelle = Web.Contents("${url}", [Headers = [Authorization = "Bearer ${token}"]]),`,
    '    Tabelle = Csv.Document(Quelle, [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),',
    '    MitKopfzeile = Table.PromoteHeaders(Tabelle, [PromoteAllScalars = true])',
    'in',
    '    MitKopfzeile',
  ].join('\n');

  return (
    <Section title={t('myData.toolsTitle')} description={t('myData.toolsIntro')}>
      <CodeBlock label={t('myData.toolsUrl', { purpose: purposeLabel })} code={url} />
      <p>
        <Link to="/konto">{t('myData.toolsTokenLink')}</Link>
      </p>
      <CodeBlock label={t('myData.snippetCurl')} code={curl} />
      <CodeBlock label={t('myData.snippetPython')} code={python} />
      <CodeBlock label={t('myData.snippetPowerQuery')} code={powerQuery} />
      <p className="small muted">{t('myData.toolsNote')}</p>
    </Section>
  );
}
