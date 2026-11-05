import { Link } from 'react-router';
import { useI18n } from '../../i18n/index.tsx';
import { CodeBlock } from '../Misc.tsx';
import { Section } from '../PageHeader.tsx';
import { buildToolSnippets } from './toolSnippets.ts';

interface Props {
  /** absolute REST-Adresse (CSV) inkl. Zweck */
  url: string;
  /** Dateiname ohne Endung */
  fileBase: string;
  purposeLabel: string;
}

/** Hinweise und Code-Beispiele für den Zugriff aus Excel, Power BI, Python und curl (zugeklappt). */
export function ToolAccessBox({ url, fileBase, purposeLabel }: Props) {
  const { t } = useI18n();
  const token = t('myData.tokenPlaceholder');

  const { curl, python, powerQuery } = buildToolSnippets({
    url,
    fileBase,
    token,
    powerQueryAuthHint: t('myData.powerQueryAuthHint'),
  });

  return (
    <Section title={t('myData.toolsTitle')} description={t('myData.toolsIntro')} collapsible>
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
