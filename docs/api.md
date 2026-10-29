# Streamline API calls

Status of every call the importer makes. "Proven" means a working script already uses it against the CMS.
"Schema" means it is in `docs/schema.graphql` (read from the sandbox on 2026-10-23; checklist in `docs/schema-check.txt`).
"Sandbox" means the importer itself has run it on the sandbox.

## Milestone 1a (pages + primary menu)

| Call | Used for | Status |
|---|---|---|
| `amplifyLayouts { id name }` | find InteriorStandard on this site (known id first, then by name; stops if none or several) | Schema |
| `amplifyUpsertPage(input: {amplifyPage: {amplifyTitle, amplifyLayoutId, unpublished, colorIndex}})` → `page {id slug}` | create page | Proven (0.2.0), Schema: `amplifyTitle`, `unpublished`, `colorIndex` required |
| `amplifyPromoteDraft(input: {draftId})` | publish draft | Proven (0.2.0), Schema; "already published" treated as success |
| `amplifyPages(pageType: STANDARD, unpublished, first, after)` → `nodes {id amplifyTitle unpublished draftPageVersion{createdAt} activePageVersion{createdAt}}` `pageInfo` | resume check | Schema: paging confirmed. The `unpublished` filter's default is not documented, so the importer lists `false` and `true` and merges |
| `GET /api/pocs/{id}`, `PUT /api/pocs/{id}` with `deleted: true` | undo (delete page) | Proven (0.2.0). The schema also has `amplifyDeletePage(pageId)`, not used yet |
| `GET /api/menus` | find primary menu id | Proven (user6). No menu calls in GraphQL |
| `GET /api/menu_items` | list items (ignores `?menu_id`, may repeat items) | Proven (user6) |
| `POST /api/menu_items` `{title, poc_id, menu_id, parent_id, weight, ...}` | create item linked to page | Proven (0.2.0 with `poc_id`, user6 for trees) |
| `PUT /api/menu_items/{id}` with `deleted: true` | undo (delete item) | Proven (user6) |

## Answered by the schema

- **Paging:** `amplifyPages` takes `after` and returns `pageInfo { hasNextPage endCursor }`.
- **Layout:** looked up per site with `amplifyLayouts`.
- **Slug / URL:** there is no slug or parent input. The CMS sets `slug` from the title and returns it; the manifest records it.
- **Hidden marker:** none. Page input fields are all public or functional (`socialMediaDescription`, `tagIds`, `redirect`, `groupId`, …). The manifest is the record. Resume flags pages created after the run started that match a missing title, and leaves them for a person to check.
- **Image alt text (later):** `updateImage(input: {image: {id, altText}})`.

## Still open (sandbox run)

- Does a page created with `unpublished: true` stay unpublished after `amplifyPromoteDraft`?
- Does `amplifyPromoteDraft` succeed on a page with no sections?
- Rate limits.

## Possibly useful later

- `redirect` / `redirectUrl` on pages: D10 pages with `field_page_redirect` (40 in Harvard) could become redirect pages.
- `pageType: GROUP` and `groupId`: groups tie into meetings and agenda reminders, so board microsites may map to groups.
- `tagIds` / `upsertTags`: tags on pages. Not used as a marker because they may show on the public site.

## Content, media and links

| Call | Used for | Status |
|---|---|---|
| `amplifyDraft(pocId) { containers { columns { id columnType } } }` | find the main column | Proven (0.2.0), Schema |
| `amplifyUpsertSectionInstance` (`name: 'Freeform'`, `instanceableType: TRACTION_POC`) | add the content section | Proven (0.2.0), Schema |
| `amplifyUpsertFreeformContent(input: {sectionInstanceId, html, json})` | write converted body | Proven (0.2.0), Schema |
| `createFileUpload(input: {basename})` → `{putUrl, storagePath}` | signed upload URL (900 s) | HAR, Schema |
| `PUT putUrl`, body = file, `Content-Type` only | upload bytes | HAR |
| `createFile(input: {storagePath})` → `file {id friendlyUrl}` | documents | HAR, Schema |
| `createImage(input: {storagePath, mediaType: Image})` → `image {id largeUrl altText}` | images (the CMS writes its own alt text) | HAR, Schema |
| `updateImage(input: {image: {id, altText}})` | replace the generated alt text with D10's | Schema |
| `deleteFile` / `deleteImage(input: {id})` | undo | Schema |
| `amplifyUpdatePreferencesFreeform(input: {sectionInstanceId, preferences: {colorIndex, padding, highContrast, accordion, accordionTitle}})` | FAQ accordions | Sandbox (2026-10-28): renders as an accordion, the title is the question |
| `GET /api/pocs/{id}` → `url` | a page's public address for links between pages (e.g. `/boil-water-order-faqs`) | Sandbox (2026-10-28) |

## Freeform JSON node shapes

| Node | Source |
|---|---|
| `text`, `paragraph`, `heading` (h2-h6), `quote`, `table`/`tablerow`/`tablecell`, `resizeable-image`, `decorated-link-node` with `external: true` | 0.2.0, checked against the editor |
| `decorated-link-node` with `external: false` (links to new pages and uploaded files) | Same node with the flag off. **Needs a capture** of an internal link made in the editor to confirm |
| `list` / `listitem` (nested list in its own listitem), `linebreak` | Standard Lexical. **Needs a capture** to confirm the editor uses the same shapes |
| `<h1>` | Becomes h2 (pages already have a title) and is reported |
| `<hr>`, `<iframe>`, `<script>`, `<svg>`, forms | Dropped and reported |

The `html` sent with the json is rendered from the same tree, so the two always agree.

## Link cards (Teasers)

| Call | Used for | Status |
|---|---|---|
| `amplifyUpsertSectionInstance` with `name: 'Teasers'` in the `gutter` or `main` column | a card section | Proven (0.2.0) |
| `amplifyUpdatePreferencesTeaser(input: {sectionInstanceId, preferences: {layout: cards, columnDesign: three_column, colorIndex: light3, titleAlignment: centered, title, perPage, orderByIndex, paginationStyleIndex}})` | card style | Settings read from a card section built by hand on the sandbox (2026-10-29). `pageId` + `buttonText` (the button link) are left out: the button does not show on the public page |
| `amplifyAddTeasersToSectionInstance(input: {sectionInstanceId, isFirst: false, pocIds})` | the cards, in order | Sandbox (2026-10-29): cards keep the order given. Only shown when the section's `orderByIndex` is `manual`; with `alphabetical_by_title` or `date_published` the added cards are not shown, so the importer always uses manual and sorts the entries itself |

## Layout limits (sandbox, 2026-10-28)

On all four layouts (InteriorStandard, InteriorRoomToBreath, InteriorNoNavigation, InteriorLandingPage) the right column (`gutter`) accepts only `Teasers`. Freeform, HtmlEmbed and the rest are main-column only (`amplifyDraft` → `columns { columnType supportedSections }`). So right-column content from D10 cannot be recreated; FAQs go in the main column.

## Export quirks found

- `field_news_date` is sometimes a bare string with no array around it (70 Harvard pages, 7 Tieton). Handled.
- 46 Harvard page attachments point at media ids that are not in `www-media.json`. Reported per page as `attachment-missing`.
