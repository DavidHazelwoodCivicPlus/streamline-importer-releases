'use strict';
// GraphQL schema introspection: the query, a printer to SDL text, and a check of the calls the importer relies on.
// Pure: the caller runs the query (userscript button or tools/introspect.js) and saves the output.

const INTROSPECTION = `query {
  __schema {
    queryType { name } mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: true) { name description isDeprecated args { name type { ...T } defaultValue } type { ...T } }
      inputFields { name type { ...T } defaultValue }
      enumValues(includeDeprecated: true) { name isDeprecated }
      interfaces { name } possibleTypes { name }
    }
  }
}
fragment T on __Type { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }`;

const typeRef = t => t.kind === 'NON_NULL' ? typeRef(t.ofType) + '!' : t.kind === 'LIST' ? '[' + typeRef(t.ofType) + ']' : t.name;
const baseName = t => typeRef(t).replace(/[!\[\]]/g, '');

function toSdl(schema) {
  const out = [];
  const desc = (d, ind) => d ? ind + '"""' + d.replace(/"""/g, '\\"""') + '"""\n' : '';
  for (const t of schema.types.filter(t => !t.name.startsWith('__')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (t.kind === 'SCALAR') { out.push(desc(t.description, '') + 'scalar ' + t.name); continue; }
    if (t.kind === 'ENUM') { out.push(desc(t.description, '') + 'enum ' + t.name + ' {\n' + t.enumValues.map(v => '  ' + v.name + (v.isDeprecated ? ' @deprecated' : '')).join('\n') + '\n}'); continue; }
    if (t.kind === 'UNION') { out.push('union ' + t.name + ' = ' + t.possibleTypes.map(p => p.name).join(' | ')); continue; }
    const kw = t.kind === 'INPUT_OBJECT' ? 'input' : t.kind === 'INTERFACE' ? 'interface' : 'type';
    const impl = t.interfaces && t.interfaces.length ? ' implements ' + t.interfaces.map(i => i.name).join(' & ') : '';
    const fields = (t.fields || t.inputFields || []).map(f => {
      const args = f.args && f.args.length ? '(' + f.args.map(a => a.name + ': ' + typeRef(a.type) + (a.defaultValue != null ? ' = ' + a.defaultValue : '')).join(', ') + ')' : '';
      return desc(f.description, '  ') + '  ' + f.name + args + ': ' + typeRef(f.type) + (f.defaultValue != null ? ' = ' + f.defaultValue : '') + (f.isDeprecated ? ' @deprecated' : '');
    });
    out.push(desc(t.description, '') + kw + ' ' + t.name + impl + ' {\n' + fields.join('\n') + '\n}');
  }
  return out.join('\n\n') + '\n';
}

// Plain-text report of what the importer needs from the schema.
function checkSchema(schema) {
  const T = n => schema.types.find(t => t.name === n);
  const field = (type, name) => ((T(type) || {}).fields || []).find(f => f.name === name);
  const q = n => field(schema.queryType.name, n);
  const mu = n => field(schema.mutationType && schema.mutationType.name, n);
  const lines = [];
  const show = (label, ok, extra) => lines.push((ok ? 'ok       ' : 'MISSING  ') + label + (extra ? '  ' + extra : ''));
  const sig = f => '(' + f.args.map(a => a.name + ': ' + typeRef(a.type)).join(', ') + ') -> ' + typeRef(f.type);

  lines.push('Calls the importer uses:');
  for (const n of ['amplifyUpsertPage', 'amplifyUpsertSectionInstance', 'amplifyUpsertFreeformContent', 'amplifyPromoteDraft', 'createFileUpload', 'createFile', 'createImage']) {
    const f = mu(n); show('mutation ' + n, !!f, f ? sig(f) : '');
  }
  for (const n of ['amplifyPages', 'amplifyDraft', 'images', 'files']) {
    const f = q(n); show('query ' + n, !!f, f ? sig(f) : '');
  }
  const pages = q('amplifyPages');
  if (pages) {
    const conn = baseName(pages.type);
    show(conn + '.pageInfo (paging)', !!field(conn, 'pageInfo'));
    show('amplifyPages(after:) argument', pages.args.some(a => a.name === 'after'));
  }

  const pageInput = (T('AmplifyUpsertPageMutationInput') || {}).inputFields || [];
  const inner = pageInput.find(f => f.name === 'amplifyPage');
  if (inner) {
    const it = T(baseName(inner.type));
    lines.push('', baseName(inner.type) + ' input fields (slug, parent, hidden marker candidates):');
    for (const f of (it && it.inputFields) || []) lines.push('  ' + f.name + ': ' + typeRef(f.type));
  }
  const upsert = mu('amplifyUpsertPage');
  if (upsert) {
    const payload = T(baseName(upsert.type));
    const pf = payload && (payload.fields || []).find(f => f.name === 'page');
    const pt = pf && T(baseName(pf.type));
    if (pt) {
      lines.push('', pt.name + ' fields (what a created page returns):');
      for (const f of pt.fields || []) lines.push('  ' + f.name + ': ' + typeRef(f.type));
    }
  }
  const named = (type, re) => ((T(type) || {}).fields || []).filter(f => re.test(f.name)).map(f => f.name + sig(f).replace(/^\(\)/, ''));
  lines.push('', 'Layout queries:', ...named(schema.queryType.name, /layout/i).map(s => '  ' + s));
  lines.push('', 'Image mutations (alt text):', ...named(schema.mutationType.name, /image/i).map(s => '  ' + s));
  lines.push('', 'Menu-related queries and mutations:', ...named(schema.queryType.name, /menu/i).concat(named(schema.mutationType.name, /menu/i)).map(s => '  ' + s));
  return lines.join('\n') + '\n';
}

module.exports = { INTROSPECTION, typeRef, toSdl, checkSchema };
