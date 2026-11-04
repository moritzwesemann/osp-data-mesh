/**
 * Deutsche HTML-Dokumentation: rendert docs/*.md und docs/adr/*.md mit marked zu einer statischen
 * Website unter dist/docs/ (vom Server unter /hilfe/ ausgeliefert).
 *
 *   bun run build:docs        (= bun scripts/build-docs.ts)
 *
 * - gemeinsames Layout mit Navigationsleiste (feste Reihenfolge der Abschnitte), deutsche Bedienelemente
 * - responsives, schlichtes CSS ohne externe Ressourcen, ohne JavaScript
 * - relative Links *.md → *.html, Überschriften erhalten Anker-IDs
 * - erzeugte Seiten: Startseite (docs/index.md + Seitenverzeichnis), Verzeichnis der ADRs
 * - abschließende Linkprüfung: jeder relative Link muss auf eine erzeugte Seite und ggf. einen
 *   vorhandenen Anker zeigen; sonst Exit-Code 1
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, relative, resolve } from 'node:path';
import { Marked, type Tokens } from 'marked';

const ROOT = resolve(import.meta.dir, '..');
const SRC = join(ROOT, 'docs');
const OUT = resolve(ROOT, process.env.MESH_DOCS_DIR ?? 'dist/docs');
const VERSION = (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const SITE_TITLE = 'OSP-Data-Mesh – Hilfe';

/** Navigationsabschnitte in fester Reihenfolge (Pfade relativ zu docs/, ohne .md). */
const SECTIONS: { title: string; pages: string[] }[] = [
  { title: 'Einstieg', pages: ['index', 'installation', 'betrieb'] },
  {
    title: 'Fachliches Konzept',
    pages: ['architektur', 'freigaberegeln', 'protokoll', 'datenmodell', 'rollen'],
  },
  {
    title: 'Sicherheit und Datenschutz',
    pages: ['sicherheit', 'datenschutz', 'widerruf-und-weitergabe', 'incident-response'],
  },
  { title: 'Schnittstellen', pages: ['api', 'bi'] },
  { title: 'Projekt und Übergabe', pages: ['requirements', 'abnahme', 'lizenzen', 'adr/index'] },
];

interface Page {
  /** Pfad relativ zu docs/ ohne Endung, z. B. "adr/0001-modularer-monolith" */
  id: string;
  title: string;
  markdown: string;
  generated: boolean;
}

// -------------------------------------------------------------------------------------------------
// Seiten einlesen
// -------------------------------------------------------------------------------------------------

function firstHeading(md: string, fallback: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m?.[1]?.trim() ?? fallback;
}

function readPages(): Page[] {
  const pages: Page[] = [];
  const add = (dir: string, prefix: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.md')) continue;
      const markdown = readFileSync(join(dir, f), 'utf8');
      const id = prefix + f.slice(0, -3);
      pages.push({ id, title: firstHeading(markdown, id), markdown, generated: false });
    }
  };
  add(SRC, '');
  add(join(SRC, 'adr'), 'adr/');
  return pages;
}

function adrStatus(md: string): string {
  const m = md.match(/^##\s+Status\s*\n+([^\n]+)/m);
  return m?.[1]?.trim() ?? '';
}

function generateAdrIndex(pages: Page[]): Page {
  const adrs = pages.filter((p) => p.id.startsWith('adr/') && p.id !== 'adr/index');
  const rows = adrs.map(
    (p) => `| [${p.title.replace(/\|/g, '\\|')}](${p.id.slice(4)}.md) | ${adrStatus(p.markdown)} |`,
  );
  const markdown = `# Architekturentscheidungen (ADR)

Die wesentlichen Architekturentscheidungen sind als *Architecture Decision Records* im Format nach
Michael Nygard festgehalten (Kontext, Entscheidung, Status, Konsequenzen). Neue Entscheidungen erhalten die
nächste freie Nummer; überholte Entscheidungen werden nicht gelöscht, sondern als "ersetzt durch …"
markiert. Quelle: \`docs/adr/\`.

| Entscheidung | Status |
|---|---|
${rows.join('\n')}
`;
  return { id: 'adr/index', title: 'Architekturentscheidungen (ADR)', markdown, generated: true };
}

function generateSiteIndex(pages: Page[], existing: Page | undefined): Page {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const listed = new Set<string>();
  const lines: string[] = [];
  for (const s of SECTIONS) {
    const items = s.pages.filter((id) => id !== 'index' && byId.has(id));
    if (!items.length) continue;
    lines.push(`\n### ${s.title}\n`);
    for (const id of items) {
      listed.add(id);
      lines.push(`- [${byId.get(id)!.title}](${id}.md)`);
    }
  }
  const rest = pages.filter((p) => p.id !== 'index' && !listed.has(p.id) && !p.id.startsWith('adr/'));
  if (rest.length) {
    lines.push('\n### Weitere Seiten\n');
    for (const p of rest) lines.push(`- [${p.title}](${p.id}.md)`);
  }
  const head = existing?.markdown ?? `# ${SITE_TITLE}\n`;
  return {
    id: 'index',
    title: existing?.title ?? SITE_TITLE,
    markdown: `${head.trimEnd()}\n\n## Alle Seiten\n${lines.join('\n')}\n`,
    generated: !existing,
  };
}

// -------------------------------------------------------------------------------------------------
// Markdown → HTML
// -------------------------------------------------------------------------------------------------

export function slugify(text: string): string {
  return text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[`*_~]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Relativen Link auf eine Markdown-Datei in einen Link auf die HTML-Seite umschreiben. */
function rewriteHref(href: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) return href;
  return href
    .replace(/^([^#?]*?)\.md(?=$|[#?])/, '$1.html')
    .replace(/^([^#?]*\/)README\.html/, '$1index.html');
}

function renderMarkdown(md: string): string {
  const used = new Map<string, number>();
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link') (token as Tokens.Link).href = rewriteHref((token as Tokens.Link).href);
    },
    renderer: {
      heading(this: { parser: { parseInline(t: Tokens.Heading['tokens']): string } }, token: Tokens.Heading) {
        const base = slugify(token.text) || 'abschnitt';
        const n = used.get(base) ?? 0;
        used.set(base, n + 1);
        const id = n === 0 ? base : `${base}-${n}`;
        const inner = this.parser.parseInline(token.tokens);
        return `<h${token.depth} id="${id}">${inner} <a class="anker" href="#${id}" aria-label="Link zu diesem Abschnitt">#</a></h${token.depth}>\n`;
      },
      table(this: { parser: { parseInline(t: Tokens.TableCell['tokens']): string } }, token: Tokens.Table) {
        const cell = (c: Tokens.TableCell, tag: 'th' | 'td') => {
          const align = c.align ? ` style="text-align:${c.align}"` : '';
          return `<${tag}${align}>${this.parser.parseInline(c.tokens)}</${tag}>`;
        };
        const head = `<tr>${token.header.map((c) => cell(c, 'th')).join('')}</tr>`;
        const body = token.rows.map((r) => `<tr>${r.map((c) => cell(c, 'td')).join('')}</tr>`).join('\n');
        return `<div class="tabelle"><table>\n<thead>${head}</thead>\n<tbody>${body}</tbody>\n</table></div>\n`;
      },
    },
  });
  return marked.parse(md, { async: false }) as string;
}

// -------------------------------------------------------------------------------------------------
// Layout
// -------------------------------------------------------------------------------------------------

function relPrefix(id: string): string {
  const depth = id.split('/').length - 1;
  return depth === 0 ? '' : '../'.repeat(depth);
}

function navHtml(current: string, pages: Page[]): string {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const prefix = relPrefix(current);
  const listed = new Set(SECTIONS.flatMap((s) => s.pages));
  const sections = [
    ...SECTIONS,
    {
      title: 'Weitere',
      pages: pages.map((p) => p.id).filter((id) => !listed.has(id) && !id.startsWith('adr/')),
    },
  ];
  const parts: string[] = [];
  for (const s of sections) {
    const items = s.pages.filter((id) => byId.has(id));
    if (!items.length) continue;
    parts.push(`<p class="nav-titel">${escapeHtml(s.title)}</p><ul>`);
    for (const id of items) {
      const p = byId.get(id)!;
      const active = id === current || (id === 'adr/index' && current.startsWith('adr/'));
      const label = id === 'index' ? 'Überblick' : p.title;
      parts.push(
        `<li><a href="${prefix}${id}.html"${active ? ' aria-current="page"' : ''}>${escapeHtml(label)}</a></li>`,
      );
    }
    parts.push('</ul>');
  }
  return parts.join('\n');
}

function pageHtml(page: Page, pages: Page[], built: string): string {
  const prefix = relPrefix(page.id);
  const body = renderMarkdown(page.markdown);
  const source = page.generated ? 'automatisch erzeugt' : `Quelle: <code>docs/${page.id}.md</code>`;
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="osp-data-mesh scripts/build-docs.ts">
<title>${escapeHtml(page.id === 'index' ? SITE_TITLE : `${page.title} – ${SITE_TITLE}`)}</title>
<link rel="stylesheet" href="${prefix}assets/hilfe.css">
</head>
<body>
<a class="sprung" href="#inhalt">Zum Inhalt springen</a>
<header class="kopf">
  <a class="marke" href="${prefix}index.html">OSP-Data-Mesh <span>Hilfe</span></a>
  <a class="zur-app" href="/">Zur Anwendung</a>
</header>
<div class="rahmen">
  <nav class="navigation" aria-label="Dokumentation">
    <details open>
      <summary>Inhalt</summary>
${navHtml(page.id, pages)}
    </details>
  </nav>
  <main id="inhalt">
${body}
    <footer class="fuss">OSP-Data-Mesh ${escapeHtml(VERSION)} · Stand ${built} · ${source}</footer>
  </main>
</div>
</body>
</html>
`;
}

const CSS = `:root {
  --text: #1d2329; --muted: #5b6672; --line: #d8dee4; --bg: #ffffff; --bg2: #f5f7f9;
  --accent: #0b5cad; --accent-bg: #e8f1fb; --code: #f0f2f4;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  line-height: 1.55; color: var(--text); background: var(--bg);
}
@media (prefers-color-scheme: dark) {
  :root { --text: #e6e9ec; --muted: #a3adb8; --line: #36404a; --bg: #14181c; --bg2: #1b2026;
    --accent: #6fb1f5; --accent-bg: #1d2e40; --code: #222830; }
}
* { box-sizing: border-box; }
body { margin: 0; }
a { color: var(--accent); }
.sprung { position: absolute; left: -999px; }
.sprung:focus { left: 1rem; top: 1rem; background: var(--bg); padding: .5rem; z-index: 10; }
.kopf { display: flex; justify-content: space-between; align-items: center; gap: 1rem;
  padding: .75rem 1.25rem; border-bottom: 1px solid var(--line); background: var(--bg2); }
.marke { font-weight: 700; text-decoration: none; color: var(--text); }
.marke span { font-weight: 400; color: var(--muted); }
.zur-app { font-size: .9rem; }
.rahmen { display: grid; grid-template-columns: 17rem minmax(0, 1fr); max-width: 84rem; margin: 0 auto; }
.navigation { border-right: 1px solid var(--line); padding: 1rem 1rem 2rem; font-size: .92rem; }
.navigation summary { display: none; }
.navigation ul { list-style: none; margin: 0 0 1rem; padding: 0; }
.navigation li a { display: block; padding: .2rem .5rem; border-radius: 4px; text-decoration: none; color: var(--text); }
.navigation li a:hover { background: var(--bg2); }
.navigation li a[aria-current="page"] { background: var(--accent-bg); color: var(--accent); font-weight: 600; }
.nav-titel { margin: .75rem 0 .25rem; font-size: .75rem; text-transform: uppercase; letter-spacing: .05em; color: var(--muted); }
main { padding: 1.5rem 2rem 3rem; min-width: 0; max-width: 60rem; }
h1 { font-size: 1.8rem; line-height: 1.25; margin-top: .5rem; }
h2 { font-size: 1.35rem; margin-top: 2.2rem; padding-bottom: .25rem; border-bottom: 1px solid var(--line); }
h3 { font-size: 1.1rem; margin-top: 1.6rem; }
.anker { visibility: hidden; text-decoration: none; color: var(--muted); font-weight: 400; }
h1:hover .anker, h2:hover .anker, h3:hover .anker, h4:hover .anker { visibility: visible; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .88em;
  background: var(--code); padding: .1em .3em; border-radius: 3px; }
pre { background: var(--code); padding: .9rem 1rem; border-radius: 6px; overflow-x: auto; line-height: 1.4; }
pre code { background: none; padding: 0; font-size: .85rem; }
.tabelle { overflow-x: auto; margin: 1rem 0; }
table { border-collapse: collapse; font-size: .92rem; min-width: 60%; }
th, td { border: 1px solid var(--line); padding: .35rem .6rem; vertical-align: top; text-align: left; }
th { background: var(--bg2); }
blockquote { margin: 1rem 0; padding: .5rem 1rem; border-left: 4px solid var(--accent); background: var(--accent-bg); }
blockquote p { margin: .3rem 0; }
.fuss { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
@media (max-width: 52rem) {
  .rahmen { grid-template-columns: 1fr; }
  .navigation { border-right: 0; border-bottom: 1px solid var(--line); padding: .5rem 1rem; }
  .navigation summary { display: list-item; cursor: pointer; font-weight: 600; padding: .4rem 0; }
  main { padding: 1rem 1rem 2rem; }
}
@media print {
  .kopf, .navigation, .anker, .sprung { display: none; }
  .rahmen { display: block; }
  main { max-width: none; padding: 0; }
  a { color: inherit; }
}
`;

// -------------------------------------------------------------------------------------------------
// Linkprüfung
// -------------------------------------------------------------------------------------------------

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const full = join(dir, f);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

export function checkLinks(outDir: string): string[] {
  const errors: string[] = [];
  const files = listFiles(outDir).filter((f) => f.endsWith('.html'));
  const ids = new Map<string, Set<string>>();
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    ids.set(f, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]!)));
  }
  for (const f of files) {
    const html = readFileSync(f, 'utf8');
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const href = m[1]!.replace(/&amp;/g, '&');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/')) continue;
      const [pathPart, anchor] = href.split('#') as [string, string | undefined];
      const target = pathPart ? resolve(dirname(f), pathPart) : f;
      const where = relative(outDir, f);
      if (!target.startsWith(outDir)) {
        errors.push(`${where}: Link verlässt die Dokumentation: ${href}`);
        continue;
      }
      if (!existsSync(target) || statSync(target).isDirectory()) {
        errors.push(`${where}: Ziel fehlt: ${href}`);
        continue;
      }
      if (anchor && target.endsWith('.html') && !ids.get(target)?.has(decodeURIComponent(anchor))) {
        errors.push(`${where}: Anker fehlt: ${href}`);
      }
    }
  }
  return errors;
}

// -------------------------------------------------------------------------------------------------
// Build
// -------------------------------------------------------------------------------------------------

if (import.meta.main) {
  const sourcePages = readPages();
  const pages = sourcePages.filter((p) => p.id !== 'index' && p.id !== 'adr/index');
  pages.push(generateAdrIndex(sourcePages));
  pages.unshift(
    generateSiteIndex(
      [...pages],
      sourcePages.find((p) => p.id === 'index'),
    ),
  );

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(join(OUT, 'assets'), { recursive: true });
  writeFileSync(join(OUT, 'assets', 'hilfe.css'), CSS);

  // Bilder und andere Dateien aus docs/ übernehmen
  for (const f of listFiles(SRC)) {
    if (f.endsWith('.md')) continue;
    const rel = relative(SRC, f);
    mkdirSync(dirname(join(OUT, rel)), { recursive: true });
    copyFileSync(f, join(OUT, rel));
  }

  const built = new Date().toISOString().slice(0, 10);
  for (const page of pages) {
    const file = join(OUT, `${page.id}.html`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, pageHtml(page, pages, built));
  }

  const errors = checkLinks(OUT);
  console.log(`Dokumentation erzeugt: ${posix.join(relative(ROOT, OUT))}/ (${pages.length} Seiten)`);
  if (errors.length) {
    console.error(`Linkprüfung: ${errors.length} Fehler`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('Linkprüfung: alle relativen Links und Anker gültig');
}
