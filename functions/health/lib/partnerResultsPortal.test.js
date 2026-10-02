'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '../../..');
const html = fs.readFileSync(path.join(projectRoot, 'health-partner-results.html'), 'utf8');
const script = fs.readFileSync(path.join(projectRoot, 'health-partner-results.js'), 'utf8');
const api = fs.readFileSync(path.join(projectRoot, 'functions/health/partnerResults.js'), 'utf8');
const css = fs.readFileSync(path.join(projectRoot, 'health-partner-results.css'), 'utf8');

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

test('partner creation reproduces the full two-column reference form and required controls', () => {
  for (const field of [
    'pr-create-partner', 'pr-generate-partner-password', 'pr-partner-phone-list', 'pr-add-partner-phone',
    'pr-partner-days', 'pr-partner-hours', 'pr-partner-additional-info', 'pr-partner-admin-notes',
    'pr-created-date', 'pr-create-status', 'pr-created-credentials', 'pr-save-partner', 'pr-cancel-partner-create'
  ]) assert.ok(html.includes(`id="${field}"`), `missing partner form control ${field}`);
  for (const field of ['name', 'responsibleName', 'email', 'taxId', 'address', 'country', 'department', 'commune', 'additionalInformation', 'administrativeNotes', 'contractDocuments']) {
    assert.match(html, new RegExp(`name="${field}"`), `missing partner data field ${field}`);
  }
  assert.match(html, /name="services" value="laboratory"/);
  assert.match(html, /name="services" value="imaging"/);
  assert.match(html, /name="services" value="mixed"/);
  for (const status of ['active', 'suspended', 'disabled']) assert.match(html, new RegExp(`name="status" value="${status}"`));
  assert.match(css, /\.pr-partner-form-main\{display:grid;grid-template-columns/);
  assert.match(css, /@media\(max-width:760px\)\{\.pr-partner-form-main\{grid-template-columns:1fr/);
  assert.match(script, /payload\.openingHours\[day\] = \{ enabled: true, open:/);
  assert.match(script, /healthAdminCreateResultsPartner/);
  assert.match(api, /const suppliedPassword = String\(payload\.initialPassword \|\| ''\)/);
  assert.match(api, /disabled: initialStatus !== 'active'/);
  assert.match(api, /active: status === 'active'/);
  assert.match(api, /const services = selectedServices \|\|/);
  assert.match(api, /requestedStatus !== previousStatus && statusReason\.length < 5/);
  assert.match(api, /statusReason: statusChanged \? statusReason \|\| null : current\.partnerProfile\?\.statusReason/);
});

test('partner directory matches the reference layout and only renders live API partner data', () => {
  for (const id of ['pr-partner-summary', 'pr-partner-search', 'pr-partner-filter-type', 'pr-partner-filter-status', 'pr-partner-filter-department', 'pr-partner-filter-commune', 'pr-partner-reset-filters', 'pr-partner-pages', 'pr-partner-page-size', 'pr-partner-profile-dialog']) {
    assert.ok(html.includes(`id="${id}"`), `missing partner directory control ${id}`);
  }
  assert.match(script, /call\('healthAdminListResultsPartners'\)/);
  assert.match(script, /partners\.filter\(\(partner\) => partnerHasService/);
  assert.match(script, /state\.partnersLoaded \? Number\(value\)\.toLocaleString/);
  assert.match(script, /data-partner-action="profile"/);
  assert.match(script, /data-partner-action="report"/);
  assert.match(css, /\.pr-partner-summary\{display:grid;grid-template-columns:repeat\(4/);
  assert.match(css, /\.pr-partner-table\{width:100%;min-width:/);
  assert.match(css, /body\.pr-embedded-admin \.pr-topbar\{display:flex!important;inset:0!important/);
  assert.match(html, /data-parent-health-module="partners"/);
});

test('administration is limited to the embedded dashboard and portal sign-in is partner-only', () => {
  assert.match(html, /Identifiant partenaire ou e-mail du compte partenaire/);
  assert.doesNotMatch(html, /e-mail administrateur/i);
  assert.match(script, /embeddedAdminRequested[\s\S]*window\.parent !== window/);
  assert.match(script, /if \(!embeddedAdminContext\)[\s\S]*dashboard admin Smart Cut Health/);
  assert.match(script, /await call\('healthAdminGetPartnerResultsOverview'\)[\s\S]*setMode\('admin'\)/);
});

test('embedded admin chrome fills the parent viewport and can switch Smart Cut Health modules', () => {
  assert.match(html, /id="pr-module-switcher"/);
  assert.match(html, /class="pr-admin-brand"/);
  assert.match(html, /id="pr-overview-range"/);
  assert.match(html, /data-parent-health-module="(?:pharmacy|laboratory|imaging|medical)"/);
  assert.match(script, /parentOrigin[\s\S]*postMessage\(\{ type: 'smartcut-health-module-switch'/);
  assert.match(script, /document\.body\.classList\.add\('pr-embedded-admin'\)/);
  assert.match(script, /byId\('pr-overview-range'\)\.addEventListener\('change'/);
});

test('overview API queries the fields used to count active partners and returns real dashboard rows', () => {
  assert.match(api, /where\('partnerStatus', '==', 'active'\)\.select\('partnerStatus', 'partnerType', 'partnerProfile'\)/);
  assert.match(api, /recentOrdersWithoutResult/);
  assert.match(api, /recentReviewRaw = resultRowsWindow\.filter/);
  assert.match(api, /partnerLabel = \(uid\) => partnerNames\.get\(uid\) \|\| 'Nom indisponible'/);
});
