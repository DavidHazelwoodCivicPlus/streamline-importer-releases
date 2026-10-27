'use strict';
// Reads .env (never committed). Dev tools only ever talk to the sandbox.

const fs = require('fs');
const path = require('path');

const SANDBOX = 'https://davidhazelwoodcpsandbox.specialdistrict.org';

function readEnv() {
  const file = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(file)) throw new Error('No .env file. Add SANDBOX_SESSION (the _traction_session cookie) and SANDBOX_XSRF (the XSRF-TOKEN cookie) to ' + file);
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  for (const k of ['SANDBOX_SESSION', 'SANDBOX_XSRF']) if (!env[k]) throw new Error('.env is missing ' + k);
  return env;
}

module.exports = { readEnv, SANDBOX };
