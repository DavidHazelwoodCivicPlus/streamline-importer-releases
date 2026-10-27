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
| `GET /<slug>` (same origin) | work out the page URL pattern from an existing published page | Not an API; checked per run |

## Freeform JSON node shapes

| Node | Source |
|---|---|
| `text`, `paragraph`, `heading` (h2-h6), `quote`, `table`/`tablerow`/`tablecell`, `resizeable-image`, `decorated-link-node` with `external: true` | 0.2.0, checked against the editor |
| `decorated-link-node` with `external: false` (links to new pages and uploaded files) | Same node with the flag off. **Needs a capture** of an internal link made in the editor to confirm |
| `list` / `listitem` (nested list in its own listitem), `linebreak` | Standard Lexical. **Needs a capture** to confirm the editor uses the same shapes |
| `<h1>` | Becomes h2 (pages already have a title) and is reported |
| `<hr>`, `<iframe>`, `<script>`, `<svg>`, forms | Dropped and reported |

The `html` sent with the json is rendered from the same tree, so the two always agree.

## Export quirks found

- `field_news_date` is sometimes a bare string with no array around it (70 Harvard pages, 7 Tieton). Handled.
- 46 Harvard page attachments point at media ids that are not in `www-media.json`. Reported per page as `attachment-missing`.
