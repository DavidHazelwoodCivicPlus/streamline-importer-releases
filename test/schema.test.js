'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { toSdl, checkSchema } = require('../src/lib/schema');

const S = n => ({ kind: 'SCALAR', name: n });
const nn = t => ({ kind: 'NON_NULL', ofType: t });
const obj = n => ({ kind: 'OBJECT', name: n });
const fld = (name, type, args) => ({ name, type, args: args || [], isDeprecated: false });

// A tiny schema in the introspection result shape.
const schema = {
  queryType: { name: 'Query' }, mutationType: { name: 'Mutation' },
  types: [
    S('String'), S('ID'), S('Boolean'),
    { kind: 'OBJECT', name: 'Query', fields: [fld('amplifyPages', nn(obj('PageConnection')), [{ name: 'first', type: S('Int') }, { name: 'after', type: S('String') }])] },
    { kind: 'OBJECT', name: 'Mutation', fields: [fld('amplifyUpsertPage', obj('UpsertPayload'), [{ name: 'input', type: nn({ kind: 'INPUT_OBJECT', name: 'AmplifyUpsertPageMutationInput' }) }])] },
    { kind: 'OBJECT', name: 'PageConnection', fields: [fld('nodes', { kind: 'LIST', ofType: obj('AmplifyPage') }), fld('pageInfo', obj('PageInfo'))] },
    { kind: 'OBJECT', name: 'UpsertPayload', fields: [fld('page', obj('AmplifyPage'))] },
    { kind: 'OBJECT', name: 'AmplifyPage', fields: [fld('id', nn(S('ID'))), fld('slug', S('String'))] },
    { kind: 'INPUT_OBJECT', name: 'AmplifyUpsertPageMutationInput', inputFields: [{ name: 'amplifyPage', type: { kind: 'INPUT_OBJECT', name: 'AmplifyPageInput' } }] },
    { kind: 'INPUT_OBJECT', name: 'AmplifyPageInput', inputFields: [{ name: 'amplifyTitle', type: S('String') }, { name: 'unpublished', type: S('Boolean') }] },
    { kind: 'ENUM', name: 'PageType', enumValues: [{ name: 'STANDARD', isDeprecated: false }] }
  ]
};

test('toSdl prints types, args and non-null markers', () => {
  const sdl = toSdl(schema);
  assert.match(sdl, /type Query \{\n {2}amplifyPages\(first: Int, after: String\): PageConnection!\n\}/);
  assert.match(sdl, /input AmplifyPageInput \{\n {2}amplifyTitle: String\n {2}unpublished: Boolean\n\}/);
  assert.match(sdl, /enum PageType \{\n {2}STANDARD\n\}/);
});

test('checkSchema reports present and missing calls and page input fields', () => {
  const r = checkSchema(schema);
  assert.match(r, /ok {7}mutation amplifyUpsertPage/);
  assert.match(r, /MISSING {2}mutation amplifyPromoteDraft/);
  assert.match(r, /ok {7}PageConnection\.pageInfo/);
  assert.match(r, /ok {7}amplifyPages\(after:\)/);
  assert.match(r, /amplifyTitle: String/);
  assert.match(r, /AmplifyPage fields[^\n]*\n {2}id: ID!/);
});
