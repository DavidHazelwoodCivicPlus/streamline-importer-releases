# Drupal 10 → Streamline Importer

Tampermonkey userscript that migrates a Drupal 10 site into Streamline CMS (Amplify pages) from the D10 JSON export (`www-*.json`) and, optionally, a site-map workbook.

It creates pages (empty, or with their converted D10 body), the primary menu linked to them, uploads the files and images those pages link to, and points `/node/N` and `/media/N` links at the new pages and files. Page sections (text, image + text, files, slideshows) and primary images come over under the body. Meetings, events, staff, FAQs and the other module records become pages of their own, linked from the right column of the pages that showed them in D10.

Runs only on the Streamline sites you turn it on for. Tampermonkey loads it on every https page, but on any site not in your list it does nothing at all (no button, no timers). The test sandbox is on by default. Running and undoing ask only for a click to confirm; erasing a whole site asks you to type WIPE and the site's address. The dev tools in `tools/` only ever talk to the sandbox.

## Install (once per person)

1. Install the Tampermonkey extension (Chrome, Edge or Firefox). In Chrome and Edge, turn on **Allow User Scripts** in the extension's settings.
2. Open **https://raw.githubusercontent.com/DavidHazelwoodCivicPlus/streamline-importer-releases/main/dist/streamline-importer.user.js** and click **Install**. Tampermonkey says the script can run on all sites; it only shows itself on the sites you turn it on for (next step).
3. Turn it on for each site you are working on: open that site's CMS, click the Tampermonkey icon in the browser toolbar → **Turn on D10 Importer for <site>**. **Choose D10 Importer sites…** in the same menu shows the whole list to edit (addresses or full URLs, separated by commas), and **Turn off D10 Importer for <site>** removes one. **Open D10 Importer** opens it even if the dock item is missing.
4. Updates install themselves: Tampermonkey checks about once a day. To get one right away: Tampermonkey dashboard → **Utilities** or the script's menu → **Check for userscript updates**.

If you had pasted an earlier copy by hand, delete that copy in the Tampermonkey dashboard so only the installed one runs.

## Release a new version (maintainer)

1. Commit your changes, then `npm run release` (or `npm run release -- minor`). It bumps the version, runs the tests, builds, and commits the public files into the releases repo clone at `../streamline-importer-releases`.
2. Push that clone: `git -C ../streamline-importer-releases push`. Everyone gets the update at their next check.

The releases repo is public. It gets every tracked file except the Streamline API schema (`docs/schema.graphql`, `docs/schema-check.txt`) and local tool settings; see `PRIVATE` in `scripts/release.js`.

## Use it

1. Sign in to the site's CMS (turned on for this site, see Install). **D10 Importer** appears in the dock above Support: an import icon (a page with an arrow) when the dock is collapsed, with its label when it expands. If the dock's items cannot be copied, a plain button appears under the menu instead.
2. Open it. A banner names the site (green for the sandbox, red for a live site). Tampermonkey asks once to allow downloads from the old site the first time media is uploaded.
3. **Load:** the folder with the `www-*.json` files. Optionally a site-map workbook and an override CSV. Or **Use the sample site**: a made-up town (Town of Maple Grove) that uses everything the importer handles (menus, pages with text, images, files and links between them, every kind of page section, every module type, right-column cards, an unpublished page, a microsite named like a listing). Import it to see what the tool makes, then remove it with **Undo last import**. Its images and PDFs are made in the browser, so nothing is downloaded.
4. **Options:** menu source (D10 data or site map), empty pages or pages with content, attachments, media upload, page URL pattern, pages unpublished in D10 (imported published by default), test-run limit.
5. **Preview:** a dry run with no writes. Menu tree, counts, a content preview of any page, and reports: dry run, match (site map), skipped, links, media, FAQs, not imported, warnings.
6. **Run:** pages → menu items → media → content → promote drafts. Every create is saved to a manifest in this browser right away.

**Erase this site** ("Resume, undo, other actions", for test sites): deletes every menu item in every menu and every page (events, meetings and groups too) whoever made them, and optionally every uploaded file and image. The homepage, products, forms, users and settings stay. Type `WIPE <site address>` to unlock it; a list of everything deleted downloads first. Deleted pages cannot be brought back.

**Imports and undo:** each export you run is its own import with its own manifest, so a site can be built in batches. Running the same export again continues its import (resume, and retry of files that failed) instead of starting a new one; exports are told apart by folder name (or by the old site address when files are chosen without their folder). **Undo last import** (first screen, or "Resume, undo, other actions") removes exactly what the newest import made: its menu items, pages and uploaded media. Any other import can be undone on its own from the same list. Each manifest can be downloaded and loaded in another browser. Erasing the site clears the list.

## Menu from D10 data

- Microsites on top, their pages under them, alphabetical (the export has no menu order). Imported top-level items go after the menu's existing items.
- News (`field_news_date`) and events (`field_smart_date`) are skipped. Home microsites are skipped, with any pages under them. Microsites with no pages are skipped unless the option is ticked.

## Menu from a site map

- The rules are the user guide's (user6), unchanged: a 1 or x in Complete, Incomplete or Linked creates the row, Home is skipped, a skipped row takes its branch with it. Columns are found by header text ("Global", "Complete Pages", "Existing Website URLs"…), with user6's fixed C-J / K-M layout as the fallback.
- Rows match D10 pages by their old URL, then by title when exactly one page has it. Ambiguous and unmatched rows are never guessed: they are listed in the match report and become empty pages (or are skipped, per the option). To fix them, fill in the "D10 nid" column of the match report and load it back as the override CSV.

## Content

- The D10 body is converted to Streamline's freeform format (Lexical JSON + HTML): paragraphs, h2-h6, bold/italic/underline/strike, links, nested lists, tables, line breaks. Spans and styling are cleaned up. Scripts, iframes, rules and forms are dropped and reported.
- File attachments become a "Documents" list at the end of the body.
- **Sections** (Options → Import D10 page sections, on by default): each D10 text, image + text, files and slideshow section becomes its own freeform section under the body, in D10 order, with its heading. Images are uploaded and shown full width (Streamline images sit on their own line, so a left or right image goes above its text). Files sections become a list of links to the uploaded files. Sections D10 showed collapsed or open become accordions titled with the section heading. A page's primary image goes at the top of the body. Homepage widgets (cards, tabs, social media) are not imported.
- D10 FAQ sections: with the FAQs module on (the default), each FAQ is a page and the section becomes right-column cards to them. With it off, the section becomes one accordion per published question under the body (the FAQ accordion option).
- Links to other imported pages use each page's address as the CMS reports it (`GET /api/pocs/{id}` → `url`). A "Page URL pattern" in Options overrides that.
- Links to imported pages and uploaded files point at the new site. Links to anything not imported keep pointing at the old site and are listed in the links report with the reason.

## Module content and link cards

- **Modules (Options → Module content):** news, business directory, jobs, bids & RFPs, ordinances & resolutions, parks, projects and locations. Each record becomes a page: its details (status, dates, address, amenities…), its body and a Documents list. Each module gets a listing page that shows its entries as cards (news newest first, the rest A–Z), with an optional primary menu item. Date-times are stored in UTC by D10 and shown in the **Site time zone** set in Options. **Meetings, events, Staff Directory and FAQs** have no Streamline module pages can use yet, so they are pages too: meetings with date, location, agenda, packet, minutes and video links; events with dates and location; people with photo, position, email, phone and office hours. Everything is ticked by default. Meeting titles get their date ("Planning and Zoning Board – January 3, 2024").
- **Order of events and meetings:** upcoming ones first, soonest first (a recurring event by its next date), then past ones, most recent first. The order is set when the import runs; Streamline does not re-sort the cards later.
- **A microsite named like a listing** (for example a D10 "Events" microsite) becomes that listing: the cards for every entry go under its own content, and no second "Events" menu item is added.
- **Floating pages:** module entries never get a menu item. They are reached from their listing page and from the right column of the pages D10 showed them on: a staff section ("Board Members") lists those people, an FAQ section its category's FAQs, and each microsite page lists its own staff and FAQs not already shown, and 10 of its meetings and events (Streamline shows every card in a right-column section, so the rest are on the Meetings and Events listing pages). Streamline adds a "This item appears on" box to each floating page, linking back to those pages.
- **Failed downloads:** running the import again retries files that could not be downloaded, and rewrites (and promotes again) the pages that use the ones that now upload.
- **Right-column cards:** D10 "embedded pages" sections become a Teasers section in the page's right column, titled with the section heading, with one card per linked page in D10 order. Cards use the square card style (cards, three_column, light3, centered) and never the button link, which does not show on the public page. Links that cannot become cards (page not imported, module not selected, not in the export) are listed in the card report.
- Streamline's right column accepts only Teasers (link cards) on every layout, so other right-column content (FAQs, text) goes in the main column.

## Develop

- `npm test` runs the unit tests, including every body in the sample exports when they are on this machine (`SI_SAMPLE_DIRS`, separated by `;`).
- `npm run harness` serves `dev/harness.html` on http://localhost:8765: the real wizard against a fake in-memory CMS (content, media and menus), with buttons to inject 500s and 422s. `loadSample('cityofharvard')` in the console loads a sample export.
- "Download API schema" (in the wizard) or `node tools/introspect.js` (needs `.env`) saves `docs/schema.graphql` and `docs/schema-check.txt`.
- `docs/api.md` lists each API call and node shape and whether it is proven, confirmed or still open.

| Path | What |
|---|---|
| `src/lib/` | Pure logic: D10 loading, menu trees, site map and matching, HTML → Lexical, links, plan, manifest, import history, reports, CSV |
| `src/api/` | HTTP client (throttle, retry 429/5xx, stop on other errors) and Streamline calls |
| `src/runner.js` | Phases, resume, undo |
| `src/ui/panel.js` | The wizard |
| `build.js` | Bundles `src/` into `dist/streamline-importer.user.js` |

Never commit `.env`, `*.har` or client data (all ignored).
