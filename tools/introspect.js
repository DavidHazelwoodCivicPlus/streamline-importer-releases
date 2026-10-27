'use strict';
// Reads the sandbox GraphQL schema with the session in .env and saves docs/schema.graphql and docs/schema-check.txt.
// Read-only: one introspection query. The userscript's "Download API schema" button does the same from the browser.
//   node tools/introspect.js

const fs = require('fs');
const path = require('path');
const { makeClient, nodeTransport } = require('../src/api/client');
const { INTROSPECTION, toSdl, checkSchema } = require('../src/lib/schema');
const { readEnv, SANDBOX } = require('./env');

async function main() {
  const env = readEnv();
  const client = makeClient(nodeTransport(SANDBOX, env.SANDBOX_SESSION, env.SANDBOX_XSRF), { host: new URL(SANDBOX).host, allowedHosts: [new URL(SANDBOX).host], log: console.log });
  const schema = (await client.gql(INTROSPECTION)).__schema;
  const docs = path.join(__dirname, '..', 'docs');
  fs.writeFileSync(path.join(docs, 'schema.graphql'), toSdl(schema));
  const report = checkSchema(schema);
  fs.writeFileSync(path.join(docs, 'schema-check.txt'), report);
  console.log('Saved docs/schema.graphql (' + schema.types.length + ' types) and docs/schema-check.txt\n');
  console.log(report);
}

main().catch(e => { console.error(e.message); if (e.detail) console.error(JSON.stringify(e.detail, null, 2).slice(0, 3000)); process.exit(1); });
