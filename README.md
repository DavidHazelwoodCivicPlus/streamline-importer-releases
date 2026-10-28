# Drupal 10 → Streamline Importer

Tampermonkey userscript that migrates a Drupal 10 site into Streamline CMS (Amplify pages) from the D10 JSON export (`www-*.json`) and, optionally, a site-map workbook.

It creates pages (empty, or with their converted D10 body), the primary menu linked to them, uploads the files and images those pages link to, and points `/node/N` and `/media/N` links at the new pages and files. FAQs, meetings, directories and other module content are reported, not imported.

Runs on any Streamline CMS admin page: Tampermonkey loads it on every https page, and it only adds its button where the CMS dock is present. On any site other than the test sandbox (davidhazelwoodcpsandbox.specialdistrict.org), running, undoing and removing ask you to type the site's address first. The dev tools in `tools/` only ever talk to the sandbox.

## Install (once per person)

1. Install the Tampermonkey extension (Chrome, Edge or Firefox). In Chrome and Edge, turn on **Allow User Scripts** in the extension's settings.
2. Open **https://raw.githubusercontent.com/DavidHazelwoodCivicPlus/streamline-importer-releases/main/dist/streamline-importer.user.js** and click **Install**. Tampermonkey says the script can run on all sites; it only shows itself on Streamline admin pages.
3. Updates install themselves: Tampermonkey checks about once a day. To get one right away: Tampermonkey dashboard → **Utilities** or the script's menu → **Check for userscript updates**.

If you had pasted an earlier copy by hand, delete that copy in the Tampermonkey dashboard so only the installed one runs.

## Release a new version (maintainer)

1. Commit your changes, then `npm run release` (or `npm run release -- minor`). It bumps the version, runs the tests, builds, and commits the public files into the releases repo clone at `../streamline-importer-releases`.
2. Push that clone: `git -C ../streamline-importer-releases push`. Everyone gets the update at their next check.

The releases repo is public. It gets every tracked file except the Streamline API schema (`docs/schema.graphql`, `docs/schema-check.txt`) and local tool settings; see `PRIVATE` in `scripts/release.js`.

## Use it

1. Sign in to the site's CMS. **D10 Importer** appears in the dock above Support: an import icon (a page with an arrow) when the dock is collapsed, with its label when it expands. If the dock's items cannot be copied, a plain button appears under the menu instead.
2. Open it. A banner names the site (green for the sandbox, red for a live site). Tampermonkey asks once to allow downloads from the old site the first time media is uploaded.
3. **Load:** the folder with the `www-*.json` files. Optionally a site-map workbook and an override CSV.
4. **Options:** menu source (D10 data or site map), empty pages or pages with content, attachments, media upload, page URL pattern, unpublished pages, test-run limit.
5. **Preview:** a dry run with no writes. Menu tree, counts, a content preview of any page, and reports: dry run, match (site map), skipped, links, media, FAQs, not imported, warnings.
6. **Run:** pages → menu items → media → content → promote drafts. Every create is saved to a manifest in this browser right away.

**Resume:** load the same files and run again with the same options; only what is missing is created. **Undo:** "Resume, undo, other actions" → Undo this run removes exactly what the manifest lists (menu items, pages, uploaded media). The manifest can be downloaded and loaded in another browser.

## Menu from D10 data

- Microsites on top, their pages under them, alphabetical (the export has no menu order). Imported top-level items go after the menu's existing items.
- News (`field_news_date`) and events (`field_smart_date`) are skipped. Home microsites are skipped, with any pages under them. Microsites with no pages are skipped unless the option is ticked.

## Menu from a site map

- The rules are the user guide's (user6), unchanged: a 1 or x in Complete, Incomplete or Linked creates the row, Home is skipped, a skipped row takes its branch with it. Columns are found by header text ("Global", "Complete Pages", "Existing Website URLs"…), with user6's fixed C-J / K-M layout as the fallback.
- Rows match D10 pages by their old URL, then by title when exactly one page has it. Ambiguous and unmatched rows are never guessed: they are listed in the match report and become empty pages (or are skipped, per the option). To fix them, fill in the "D10 nid" column of the match report and load it back as the override CSV.

## Content

- The D10 body is converted to Streamline's freeform format (Lexical JSON + HTML): paragraphs, h2-h6, bold/italic/underline/strike, links, nested lists, tables, line breaks. Spans and styling are cleaned up. Scripts, iframes, rules and forms are dropped and reported.
- File attachments become a "Documents" list at the end of the page.
- D10 FAQ sections become one accordion per published question (question as the title, answer inside), in D10's order, under the page body. Streamline's right column only takes link cards (Teasers) on every layout, so FAQs go in the main column. Turn this off with the FAQ option.
- Links to other imported pages use each page's address as the CMS reports it (`GET /api/pocs/{id}` → `url`). A "Page URL pattern" in Options overrides that.
- Links to imported pages and uploaded files point at the new site. Links to anything not imported keep pointing at the old site and are listed in the links report with the reason.

## Develop

- `npm test` runs the unit tests, including every body in the sample exports when they are on this machine (`SI_SAMPLE_DIRS`, separated by `;`).
- `npm run harness` serves `dev/harness.html` on http://localhost:8765: the real wizard against a fake in-memory CMS (content, media and menus), with buttons to inject 500s and 422s. `loadSample('cityofharvard')` in the console loads a sample export.
- "Download API schema" (in the wizard) or `node tools/introspect.js` (needs `.env`) saves `docs/schema.graphql` and `docs/schema-check.txt`.
- `docs/api.md` lists each API call and node shape and whether it is proven, confirmed or still open.

| Path | What |
|---|---|
| `src/lib/` | Pure logic: D10 loading, menu trees, site map and matching, HTML → Lexical, links, plan, manifest, reports, CSV |
| `src/api/` | HTTP client (throttle, retry 429/5xx, stop on other errors) and Streamline calls |
| `src/runner.js` | Phases, resume, undo |
| `src/ui/panel.js` | The wizard |
| `build.js` | Bundles `src/` into `dist/streamline-importer.user.js` |

Never commit `.env`, `*.har` or client data (all ignored).
