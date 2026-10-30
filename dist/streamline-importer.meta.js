// ==UserScript==
// @name         Drupal 10 to Streamline Importer
// @namespace    civicplus.streamline.d10importer
// @version      0.7.0
// @description  Create Streamline pages and the primary menu from a Drupal 10 export (www-*.json). Runs only on the Streamline sites you turn it on for (Tampermonkey menu).
// @match        https://*/*
// @resource     xlsx https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// @grant        GM_xmlhttpRequest
// @grant        GM_getResourceText
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-idle
// @noframes
// @homepageURL  https://github.com/DavidHazelwoodCivicPlus/streamline-importer-releases
// @updateURL    https://raw.githubusercontent.com/DavidHazelwoodCivicPlus/streamline-importer-releases/main/dist/streamline-importer.meta.js
// @downloadURL  https://raw.githubusercontent.com/DavidHazelwoodCivicPlus/streamline-importer-releases/main/dist/streamline-importer.user.js
// ==/UserScript==
