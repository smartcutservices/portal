'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(projectRoot, 'health-partner-results.html'), 'utf8');
const script = fs.readFileSync(path.join(projectRoot, 'health-partner-results.js'), 'utf8');

test('partner results page declares every static element used by its controller', () => {
  const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const idSet = new Set(htmlIds);
  const duplicates = htmlIds.filter((id, index) => htmlIds.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], 'HTML IDs must be unique');

  const referencedIds = [...new Set([...script.matchAll(/byId\('([^']+)'\)/g)].map((match) => match[1]))];
  const dynamicIds = new Set([
    'pr-load-more-orders', 'pr-load-more-own-results', 'pr-load-more-corrections', 'pr-load-more-results',
    'pr-load-more-settlements', 'pr-load-more-partner-audit', 'pr-load-more-audit', 'pr-confirm-exam-line', 'pr-select-exam-line'
  ]);
  const absentIds = referencedIds.filter((id) => !idSet.has(id) && !dynamicIds.has(id));
  assert.deepEqual(absentIds, [], 'controller references must resolve to HTML elements');
});

test('partner results page includes both workflows and administrative controls', () => {
  for (const id of [
    'pr-partner-view', 'pr-partner-metrics-panel', 'pr-partner-profile-panel', 'pr-partner-audit-panel',
    'pr-admin-view', 'pr-admin-metrics', 'pr-admin-alerts-panel', 'pr-admin-results-panel',
    'pr-internal-panel', 'pr-settlements-panel', 'pr-partner-report-form', 'pr-requirements-form', 'pr-partners-panel',
    'pr-result-history', 'pr-security-form'
  ]) assert.ok(html.includes(`id="${id}"`), `missing portal section ${id}`);
});

test('administration is limited to the embedded dashboard and portal sign-in is partner-only', () => {
  assert.match(html, /Identifiant partenaire ou e-mail du compte partenaire/);
  assert.doesNotMatch(html, /e-mail administrateur/i);
  assert.match(script, /embeddedAdminRequested[\s\S]*window\.parent !== window/);
  assert.match(script, /if \(!embeddedAdminContext\)[\s\S]*dashboard admin Smart Cut Health/);
  assert.match(script, /await call\('healthAdminGetPartnerResultsOverview'\)[\s\S]*setMode\('admin'\)/);
});
