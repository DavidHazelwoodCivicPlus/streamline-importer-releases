'use strict';
// Streamline CMS calls. Each one is taken from a script that already works against the CMS
// (Streamline Demo Tool 0.2.0 for pages, user6 for menus) unless marked UNCONFIRMED.
// docs/api.md tracks what has been checked against the live schema.

// InteriorStandard layout id from 0.2.0. Each run looks the layout up with amplifyLayouts (see runner.resolveLayout),
// since ids may differ per site; this id is only the first thing it tries.
const INTERIOR_STANDARD_LAYOUT_ID = '08ff0b88-28a9-4925-86d1-57eceb5aceca';

const MIME = {
  pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain', csv: 'text/csv', rtf: 'application/rtf', zip: 'application/zip',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff'
};
function mimeFor(name, blobType) {
  if (blobType && blobType !== 'application/octet-stream') return blobType.split(';')[0];
  const ext = (/\.([a-z0-9]+)$/i.exec(name || '') || [])[1];
  return (ext && MIME[ext.toLowerCase()]) || 'application/octet-stream';
}

// opts.storagePut(url, blob, contentType) -> Promise<status>: the PUT to the signed storage URL.
// The storage host is not the CMS, so this does not go through the client's host check.
function streamlineApi(client, opts) {
  const { gql, request } = client;
  const storagePut = (opts && opts.storagePut) || (async (url, blob, type) => (await fetch(url, { method: 'PUT', body: blob, headers: { 'Content-Type': type } })).status);

  // ---------- Pages ----------
  async function createPage({ title, layoutId, unpublished }) {
    const d = await gql(
      'mutation($i: AmplifyUpsertPageMutationInput!) { amplifyUpsertPage(input: $i) { page { id slug } } }',
      { i: { amplifyPage: { amplifyTitle: title, amplifyLayoutId: layoutId || INTERIOR_STANDARD_LAYOUT_ID, unpublished: !!unpublished, colorIndex: 'light1' } } }
    );
    return d.amplifyUpsertPage.page; // { id, slug }
  }

  async function draftColumns(pageId) {
    const d = await gql('query($id: ID!) { amplifyDraft(pocId: $id) { containers { columns { id columnType } } } }', { id: pageId });
    return d.amplifyDraft.containers.flatMap(c => c.columns);
  }

  // instanceableType TRACTION_POC + the page id is the combination that renders (from 0.2.0).
  async function addSection(pageId, name, columnId, weight) {
    const d = await gql(
      'mutation($i: AmplifyUpsertSectionInstanceMutationInput!) { amplifyUpsertSectionInstance(input: $i) { sectionInstance { id name } } }',
      { i: { sectionInstance: { name, amplifyColumnId: columnId, weight, instanceableType: 'TRACTION_POC', instanceableId: pageId } } }
    );
    return d.amplifyUpsertSectionInstance.sectionInstance.id;
  }

  async function setFreeform(sectionInstanceId, html, json) {
    await gql(
      'mutation($i: UpsertFreeformContentMutationInput!) { amplifyUpsertFreeformContent(input: $i) { clientMutationId } }',
      { i: { sectionInstanceId, html, json } }
    );
  }

  // "already published" is not an error: the public copy is current.
  async function promoteDraft(pageId) {
    try {
      await gql('mutation($i: AmplifyPromoteDraftMutationInput!) { amplifyPromoteDraft(input: $i) { clientMutationId } }', { i: { draftId: pageId } });
      return 'promoted';
    } catch (e) {
      if (/already published/i.test(e.message)) return 'already published';
      throw e;
    }
  }

  // Soft delete through the legacy POC endpoint, as 0.2.0 does. 404 means it is already gone.
  async function deletePage(pageId) {
    let rec;
    try { rec = await request('GET', '/api/pocs/' + encodeURIComponent(pageId)); }
    catch (e) { if (e.detail && e.detail.status === 404) return 'gone'; throw e; }
    if (!rec || rec.deleted) return 'gone';
    await request('PUT', '/api/pocs/' + encodeURIComponent(pageId), Object.assign({}, rec, { deleted: true }));
    return 'deleted';
  }

  // All standard Amplify pages: id, title, unpublished, and when each version was created.
  // Paging (after/pageInfo) is in the schema. amplifyPages has an `unpublished` filter and the schema does not
  // say what leaving it out returns, so both states are listed and merged.
  async function listPages() {
    const byId = new Map();
    for (const unpublished of [false, true]) {
      let after = null;
      for (let guard = 0; ; guard++) {
        if (guard >= 200) throw new Error('Stopped listing pages after 200 batches');
        const d = await gql(
          'query($after: String, $u: Boolean) { amplifyPages(pageType: STANDARD, unpublished: $u, first: 100, after: $after) { nodes { id amplifyTitle slug unpublished draftPageVersion { createdAt } activePageVersion { createdAt } } pageInfo { hasNextPage endCursor } } }',
          { after, u: unpublished }
        );
        const c = d.amplifyPages;
        for (const n of c.nodes || []) if (n) byId.set(String(n.id), n);
        if (!c.pageInfo.hasNextPage) break;
        after = c.pageInfo.endCursor;
      }
    }
    return [...byId.values()];
  }

  async function listLayouts() {
    const d = await gql('{ amplifyLayouts { id name } }');
    return d.amplifyLayouts;
  }

  // ---------- Media (calls confirmed from the HAR capture) ----------
  // 1. createFileUpload -> signed putUrl (expires in 900s, so it is requested right before the PUT)
  // 2. PUT the bytes with Content-Type only
  // 3. createFile (documents) or createImage (images)
  async function uploadMedia({ kind, basename, blob, altText }) {
    const type = mimeFor(basename, blob.type);
    const up = (await gql('mutation($b: String!) { createFileUpload(input: {basename: $b}) { putUrl storagePath } }', { b: basename })).createFileUpload;
    const status = await storagePut(up.putUrl, blob, type);
    if (status < 200 || status >= 300) throw new Error('Upload of ' + basename + ' to storage returned ' + status);
    if (kind === 'image') {
      const img = (await gql('mutation($p: String!) { createImage(input: {storagePath: $p, mediaType: Image}) { image { id largeUrl altText } } }', { p: up.storagePath })).createImage.image;
      // createImage writes its own alt text; the D10 alt text wins when there is one.
      if (altText && altText !== img.altText) {
        await gql('mutation($i: UpdateImageMutationInput!) { updateImage(input: $i) { image { id altText } } }', { i: { image: { id: img.id, altText } } });
        img.altText = altText;
      }
      return { kind, id: img.id, url: img.largeUrl, altText: img.altText, storagePath: up.storagePath };
    }
    const f = (await gql('mutation($p: String!) { createFile(input: {storagePath: $p}) { file { id friendlyUrl } } }', { p: up.storagePath })).createFile.file;
    return { kind, id: f.id, url: f.friendlyUrl, storagePath: up.storagePath };
  }

  async function deleteMedia(kind, id) {
    const m = kind === 'image' ? 'deleteImage' : 'deleteFile';
    await gql('mutation($i: ' + (kind === 'image' ? 'DeleteImageMutationInput!' : 'DeleteFileMutationInput!') + ') { ' + m + '(input: $i) { clientMutationId } }', { i: { id } });
  }

  // ---------- Menus ----------
  async function menuIdFor(name) {
    const ms = await request('GET', '/api/menus');
    const list = Array.isArray(ms) ? ms : (ms && ms.menus) || [];
    const m = list.find(x => x.name === name);
    if (!m) throw new Error('Menu not found: ' + name);
    return m.id;
  }

  // The API ignores ?menu_id and returns every menu's items, sometimes twice, so filter and de-duplicate.
  async function menuItems(menuId) {
    const items = await request('GET', '/api/menu_items');
    const seen = new Set();
    return (items || []).filter(i => {
      if (i.deleted || String(i.menu_id) !== String(menuId) || seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
  }

  async function createMenuItem({ menuId, title, pageId, parentId, weight }) {
    const res = await request('POST', '/api/menu_items', {
      title, poc_id: pageId || null, menu_id: menuId, parent_id: parentId == null ? null : parentId, weight,
      deleted: false, items: [], isNew: true, isDirty: true
    });
    if (!res || res.id == null) throw new Error('POST /api/menu_items returned no id for "' + title + '"');
    return res;
  }

  async function softDeleteMenuItem(item) {
    try {
      await request('PUT', '/api/menu_items/' + item.id, Object.assign({}, item, { deleted: true }));
      return 'deleted';
    } catch (e) {
      if (e.detail && e.detail.status === 404) return 'gone';
      throw e;
    }
  }

  return {
    createPage, draftColumns, addSection, setFreeform, promoteDraft, deletePage, listPages, listLayouts,
    uploadMedia, deleteMedia, probe: client.probe,
    menuIdFor, menuItems, createMenuItem, softDeleteMenuItem
  };
}

module.exports = { streamlineApi, INTERIOR_STANDARD_LAYOUT_ID, mimeFor };
