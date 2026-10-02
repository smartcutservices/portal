import { auth, authReadyPromise, storage } from './firebase-init.js';
import { getIdTokenResult, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import { ref as storageRef, uploadBytes } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js';

const PROJECT_ID = 'smartcutservices-9ce54';
const REGION = 'us-central1';
const API = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/`;
const embeddedAdminRequested = new URLSearchParams(window.location.search).get('embedded') === 'admin';
const embeddedAdminContext = embeddedAdminRequested && window.parent !== window;
if (embeddedAdminContext) {
  document.body.classList.add('pr-embedded-admin');
}
const byId = (id) => document.getElementById(id);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, token: null, mode: null, lookup: null, results: [], corrections: [], orders: [], partners: [], partnersLoaded: false, partnerPage: 1, settlements: [], partnerAudit: [], adminAudit: [], activeResult: null, overview: null, loginAuditRecorded: false, partnerAuditCursor: null, partnerAuditHasMore: false, adminCursor: null, adminHasMore: false, partnerOrderCursor: null, partnerOrderHasMore: false, partnerResultCursor: null, partnerResultHasMore: false, correctionCursor: null, correctionsHasMore: false, settlementCursor: null, settlementsHasMore: false };
const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

const legacyContractsField = document.querySelector('#pr-create-partner [name="contractPaths"]')?.closest('label');
if (legacyContractsField) legacyContractsField.outerHTML = '<label>Documents contractuels / justificatifs (PDF, JPG, PNG · 10 Mo max.)<input name="contractDocuments" type="file" accept="application/pdf,image/jpeg,image/png" multiple><small>Jusqu’à 20 pièces par partenaire. Les fichiers restent privés et réservés à l’administration.</small></label>';

function showNotice(message, kind = '') {
  const node = byId('pr-notice'); node.textContent = message; node.className = `pr-notice ${kind}`; node.hidden = !message;
}
function showStatus(id, message, kind = '') {
  const node = byId(id); node.textContent = message; node.className = `pr-status ${kind}`;
}
async function call(name, { method = 'GET', body, query = {} } = {}) {
  if (!state.user) throw new Error('Connectez-vous pour continuer.');
  const token = await state.user.getIdToken();
  const params = new URLSearchParams(Object.entries(query).filter(([, value]) => value !== undefined && value !== null && value !== '').map(([key, value]) => [key, String(value)]));
  const response = await fetch(`${API}${name}${params.size ? `?${params}` : ''}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) throw new Error(payload.message || payload.error || `Échec de la requête (${response.status}).`);
  return payload;
}
function renderMetrics(summary = {}) {
  const counts = [
    ['Commandes affectées', summary.assignedOrders],
    ['Résultats à déposer', summary.awaitingUpload],
    ['Dépôts aujourd’hui', summary.resultsUploadedToday],
    ['Dépôts ce mois', summary.resultsUploadedThisMonth],
    ['Corrections demandées', summary.correctionsPending],
    ['En attente de contrôle', summary.awaitingAdminReview],
    ['Examens validés / réalisés', summary.examsValidated]
  ];
  byId('pr-metrics').innerHTML = counts.map(([label, value]) => `<div class="pr-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
}
function setMode(mode) {
  state.mode = mode;
  byId('pr-login').hidden = true; byId('pr-app').hidden = false;
  byId('pr-user').hidden = false; byId('pr-user').textContent = state.user?.email || state.user?.uid || '';
  byId('pr-partner-view').hidden = mode !== 'partner'; byId('pr-admin-view').hidden = mode !== 'admin';
  const modules = mode === 'admin' ? [
    ['Vue d’ensemble', 'admin-overview', 'pr-overview-panel'],
    ['Partenaires', 'admin-partners', 'pr-partners-list-panel'], ['Créer un partenaire', 'admin-create-partner', 'pr-partners-panel'],
    ['Commandes affectées', 'admin-orders', 'pr-assigned-orders-panel'], ['Résultats reçus', 'admin-results', 'pr-admin-results-panel'],
    ['À contrôler', 'admin-review', 'pr-admin-results-panel'], ['Corrections demandées', 'admin-corrections', 'pr-admin-results-panel'],
    ['Examens réalisés / validés', 'admin-validated', 'pr-admin-results-panel'], ['Examens sans résultat', 'admin-no-result', 'pr-no-result-panel'],
    ['Examens internes', 'admin-internal', 'pr-internal-panel'], ['Paiements prestataires', 'admin-settlements', 'pr-settlements-panel'],
    ['Litiges / anomalies', 'admin-alerts', 'pr-admin-alerts-panel'], ['Rapports', 'admin-reports', 'pr-partner-report-panel'],
    ['Historique & Audit', 'admin-audit', 'pr-audit-panel'], ['Paramètres du portail', 'admin-settings', 'pr-requirements-panel']
  ] : [
    ['Vue d’ensemble', 'partner-overview', 'pr-partner-metrics-panel'], ['Commandes à traiter', 'partner-orders', 'pr-lookup-panel,pr-upload-card,pr-partner-orders-panel'],
    ['Résultats déposés', 'partner-results', 'pr-own-results-panel'], ['Corrections demandées', 'partner-corrections', 'pr-corrections-panel'],
    ['Mon établissement', 'partner-profile', 'pr-partner-profile-panel'], ['Historique', 'partner-audit', 'pr-partner-audit-panel'],
    ['Sécurité', 'partner-security', 'pr-partner-security-panel']
  ];
  const allModules = $$('.pr-view > article').filter((panel) => panel.id !== 'pr-upload-card');
  allModules.forEach((panel) => { panel.classList.add('pr-module'); panel.hidden = true; });
  modules.forEach(([, module, ids]) => ids.split(',').forEach((id) => { const panel = byId(id); if (!panel) return; const current = (panel.dataset.modules || panel.dataset.module || '').split(/\s+/).filter(Boolean); if (!current.includes(module)) current.push(module); panel.dataset.modules = current.join(' '); }));
  byId('pr-title').textContent = mode === 'admin' ? 'Vue d’ensemble' : 'Vue d’ensemble';
  byId('pr-page-context').textContent = mode === 'admin' ? 'Administration · Résultats partenaires' : 'Espace partenaire · Résultats médicaux';
  byId('pr-nav').innerHTML = `<div class="pr-nav-header"><strong>Navigation</strong><button type="button" class="pr-nav-close" aria-label="Fermer le menu">×</button></div>${modules.map(([label, module], index) => `<button type="button" class="${index === 0 ? 'active' : ''}" data-module-target="${module}" aria-current="${index === 0 ? 'page' : 'false'}"><span class="pr-nav-marker"></span>${label}</button>`).join('')}`;
  const nav = byId('pr-nav');
  const sidebar = $('.pr-sidebar');
  const menuToggle = byId('pr-menu-toggle');
  const backdrop = byId('pr-nav-backdrop');
  const closeMenu = () => {
    sidebar.classList.remove('open');
    backdrop.classList.remove('visible');
    menuToggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('pr-menu-open');
  };
  menuToggle.onclick = () => {
    const open = !sidebar.classList.contains('open');
    sidebar.classList.toggle('open', open);
    backdrop.classList.toggle('visible', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('pr-menu-open', open);
    if (open) nav.querySelector('.pr-nav-close')?.focus();
  };
  backdrop.onclick = closeMenu;
  nav.querySelector('.pr-nav-close').onclick = closeMenu;
  document.onkeydown = (event) => { if (event.key === 'Escape') closeMenu(); };
  const activate = (module) => {
    allModules.forEach((panel) => { panel.hidden = !(panel.dataset.modules || panel.dataset.module || '').split(/\s+/).includes(module); });
    if (module !== 'partner-orders') byId('pr-upload-card').hidden = true;
    $$('#pr-nav button').forEach((button) => { const active = button.dataset.moduleTarget === module; button.classList.toggle('active', active); button.setAttribute('aria-current', active ? 'page' : 'false'); });
    const selected = modules.find((item) => item[1] === module);
    byId('pr-title').textContent = selected?.[0] || 'Portail';
    byId('pr-workspace').dataset.activeModule = module;
    if (mode === 'admin') {
      const moduleStatus = { 'admin-review': 'RESULT_PENDING_REVIEW', 'admin-corrections': 'CORRECTION_REQUESTED', 'admin-validated': 'VALIDATED' }[module] || '';
      if (byId('pr-filter-status')) byId('pr-filter-status').value = moduleStatus;
      if (module === 'admin-results' || module === 'admin-review' || module === 'admin-corrections' || module === 'admin-validated') loadAdminResults().catch((error) => showNotice(error.message, 'error'));
      if (module === 'admin-no-result') renderNoResultOrders();
      if (module === 'admin-orders') renderAssignedOrders();
      if (module === 'admin-partners') renderAdminPartners();
    }
  };
  $$('#pr-nav button[data-module-target]').forEach((button) => button.addEventListener('click', () => { activate(button.dataset.moduleTarget); closeMenu(); }));
  activate(modules[0][1]);
  const moduleSwitcher = byId('pr-module-switcher');
  const moduleDialog = byId('pr-module-dialog');
  if (moduleSwitcher) moduleSwitcher.hidden = !(mode === 'admin' && embeddedAdminContext);
  const notificationButton = byId('pr-notifications-button');
  if (notificationButton) notificationButton.hidden = !(mode === 'admin' && embeddedAdminContext);
  const adminLogout = byId('pr-admin-logout');
  if (adminLogout) adminLogout.hidden = !(mode === 'admin' && embeddedAdminContext);
  if (mode === 'admin' && embeddedAdminContext) {
    moduleSwitcher?.addEventListener('click', () => moduleDialog?.showModal());
    adminLogout?.addEventListener('click', () => signOut(auth));
    notificationButton?.addEventListener('click', () => { moduleDialog?.close(); nav.querySelector('[data-module-target="admin-alerts"]')?.click(); });
    moduleDialog?.querySelectorAll('[data-parent-health-module]').forEach((button) => button.addEventListener('click', () => {
      const module = button.dataset.parentHealthModule;
      if (!['pharmacy', 'laboratory', 'imaging', 'medical', 'partners'].includes(module)) return;
      const parentOrigin = new URLSearchParams(location.search).get('parentOrigin');
      if (embeddedAdminContext && parentOrigin && window.parent !== window) window.parent.postMessage({ type: 'smartcut-health-module-switch', module }, parentOrigin);
      moduleDialog.close();
    }));
    byId('pr-global-search')?.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      if (byId('pr-workspace').dataset.activeModule === 'admin-partners') {
        byId('pr-partner-search').value = event.currentTarget.value.trim();
        state.partnerPage = 1;
        renderAdminPartners();
        return;
      }
      const input = byId('pr-filter-search');
      if (input) input.value = event.currentTarget.value.trim();
      nav.querySelector('[data-module-target="admin-results"]')?.click();
    });
    $$('[data-open-module]').forEach((button) => button.addEventListener('click', () => nav.querySelector(`[data-module-target="${button.dataset.openModule}"]`)?.click()));
  }
}
async function initUser(user) {
  state.user = user;
  if (!user) { state.loginAuditRecorded = false; byId('pr-login').hidden = false; byId('pr-app').hidden = true; byId('pr-password-change').hidden = true; byId('pr-user').hidden = true; return; }
  const token = await getIdTokenResult(user, true); state.token = token;
  if (token.claims.healthPartnerMustChangePassword) { byId('pr-login').hidden = true; byId('pr-app').hidden = true; byId('pr-password-change').hidden = false; return; }
  const partnerLogin = String(user.email || '').endsWith('@partners.smartcuthealth.invalid') || token.claims.healthPartner === true;
  state.role = token.claims.role || token.claims.platformRole || '';
  if (partnerLogin) {
    if (!state.loginAuditRecorded) {
      try { await call('healthPartnerRecordPortalLogin', { method: 'POST', body: {} }); state.loginAuditRecorded = true; }
      catch (error) { showNotice(`Connexion active, mais l’audit de connexion n’a pas pu être enregistré : ${error.message}`, 'error'); }
    }
    setMode('partner');
    byId('pr-identity').textContent = `Compte partenaire · ${token.claims.healthPartnerId || user.uid}`;
    await Promise.all([loadPartnerOrders(), loadPartnerResults(), loadPartnerCorrections(), loadPartnerAudit(), loadPartnerOverview()]);
    return;
  }

  if (!embeddedAdminContext) {
    byId('pr-login').hidden = false; byId('pr-app').hidden = true; byId('pr-password-change').hidden = true;
    byId('pr-login-form').hidden = true;
    const status = byId('pr-login-status');
    status.textContent = 'L’administration des résultats est uniquement accessible depuis le dashboard admin Smart Cut Health. ';
    const dashboardLink = document.createElement('a');
    dashboardLink.href = 'https://smartcutservices.github.io/dashboard-/health-admin.html?module=partners';
    dashboardLink.textContent = 'Ouvrir le dashboard admin';
    status.append(dashboardLink);
    return;
  }

  try {
    await call('healthAdminGetPartnerResultsOverview');
  } catch (error) {
    byId('pr-login').hidden = false; byId('pr-app').hidden = true;
    byId('pr-login-form').hidden = true;
    showStatus('pr-login-status', `Accès Partenaires réservé aux administrateurs autorisés : ${error.message}`, 'error');
    return;
  }
  setMode('admin');
  byId('pr-identity').textContent = 'Smart Cut Health · Administration';
  await Promise.all([loadAdminOverview(), loadAdminResults(), loadAdminPartners(), loadAdminRequirements(), loadAdminSettlements(), loadAdminAudit(), loadAdminAlerts()]);
}
async function loadAdminOverview(days = Number(byId('pr-overview-range')?.value) || 30) {
  try {
    const response = await call('healthAdminGetPartnerResultsOverview', { query: { days } });
    state.overview = response.overview || null;
    renderAdminOverview(state.overview, days);
  } catch (error) {
    state.overview = null;
    renderAdminOverview(null, days);
    showNotice(`Les données réelles du tableau de bord n’ont pas pu être chargées : ${error.message}`, 'error');
  }
}
function metricText(value, currency = false) {
  const number = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isFinite(number)) return '—';
  return `${number.toLocaleString('fr-HT')}${currency ? ' HTG' : ''}`;
}
function dashboardDate(value) {
  const parsed = value?.toDate ? value.toDate() : new Date(value || '');
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleDateString('fr-HT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'America/Port-au-Prince' });
}
function renderOverviewTable(id, rows, columns, emptyText) {
  const host = byId(id);
  if (!host) return;
  if (!Array.isArray(rows) || !rows.length) { host.innerHTML = `<div class="pr-empty-data">${escapeHtml(emptyText)}</div>`; return; }
  host.innerHTML = `<table class="pr-table"><thead><tr>${columns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(column.render ? column.render(row) : row[column.key] || '—')}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
function renderTrendChart(trend) {
  const host = byId('pr-orders-chart');
  if (!host) return;
  if (!Array.isArray(trend) || !trend.length) { host.innerHTML = '<div class="pr-empty-data">Aucune donnée de tendance sur cette période.</div>'; return; }
  const width = 760, height = 168, left = 34, right = 8, top = 8, bottom = 24;
  const values = trend.flatMap((item) => [Number(item.assignedOrders), Number(item.resultsReceived)]).filter(Number.isFinite);
  const max = Math.max(1, ...values);
  const x = (index) => left + (trend.length <= 1 ? 0 : index * (width - left - right) / (trend.length - 1));
  const y = (value) => top + (height - top - bottom) * (1 - Number(value || 0) / max);
  const points = (key) => trend.map((item, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(item[key]).toFixed(1)}`).join(' ');
  const orderArea = `${points('assignedOrders')} L${x(trend.length - 1).toFixed(1)},${height - bottom} L${left},${height - bottom} Z`;
  const tickIndices = [...new Set([0, Math.round((trend.length - 1) / 4), Math.round((trend.length - 1) / 2), Math.round((trend.length - 1) * .75), trend.length - 1])];
  host.innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="pr-chart-fill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#1976e8" stop-opacity=".2"/><stop offset="1" stop-color="#1976e8" stop-opacity="0"/></linearGradient></defs>${[0,.25,.5,.75,1].map((fraction) => { const gridY = top + fraction * (height - top - bottom); return `<line class="pr-chart-grid" x1="${left}" x2="${width-right}" y1="${gridY}" y2="${gridY}"/><text class="pr-chart-axis" x="2" y="${gridY+3}">${Math.round(max * (1 - fraction))}</text>`; }).join('')}<path class="pr-chart-area" d="${orderArea}"/><path class="pr-chart-orders" d="${points('assignedOrders')}"/><path class="pr-chart-results" d="${points('resultsReceived')}"/>${trend.map((item,index)=>`<circle class="pr-chart-point" cx="${x(index)}" cy="${y(item.assignedOrders)}" r="2.5" fill="#1976e8"><title>${escapeHtml(item.label)} · commandes : ${metricText(item.assignedOrders)}</title></circle><circle class="pr-chart-point" cx="${x(index)}" cy="${y(item.resultsReceived)}" r="2.5" fill="#14aa85"><title>${escapeHtml(item.label)} · résultats : ${metricText(item.resultsReceived)}</title></circle>`).join('')}${tickIndices.map((index)=>`<text class="pr-chart-axis" text-anchor="${index===0?'start':index===trend.length-1?'end':'middle'}" x="${x(index)}" y="${height-5}">${escapeHtml(trend[index].label)}</text>`).join('')}</svg>`;
}
function renderPartnerDonut(data) {
  const host = byId('pr-partner-donut');
  if (!host) return;
  const groups = Array.isArray(data) ? data : [];
  const total = groups.reduce((sum, item) => sum + (Number(item.count) || 0), 0);
  if (!groups.length || !total) { host.innerHTML = '<div class="pr-empty-data">Aucun partenaire actif enregistré.</div>'; return; }
  const colors = ['#8d63e8', '#1976e8', '#14aa85'];
  let cursor = 0;
  const stops = groups.map((item, index) => { const start = cursor; cursor += Number(item.count) / total * 360; return `${colors[index % colors.length]} ${start.toFixed(2)}deg ${cursor.toFixed(2)}deg`; });
  host.innerHTML = `<div class="pr-donut" style="background:conic-gradient(${stops.join(',')})"><div class="pr-donut-center"><strong>${metricText(total)}</strong><span>Partenaires actifs</span></div></div><ul class="pr-donut-legend">${groups.map((item,index)=>`<li><i style="background:${colors[index % colors.length]}"></i><span>${escapeHtml(item.label)}</span><strong>${metricText(item.count)}</strong><small>${Math.round(Number(item.count)/total*100)}%</small></li>`).join('')}</ul>`;
}
function renderAssignedOrders() {
  const rows = state.overview?.assignedOrders || state.overview?.recentAssignedOrders || [];
  const columns = [{label:'N° Commande',key:'id'}, {label:'Type',render:(row)=>row.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'}, {label:'Partenaire',key:'partnerName'}, {label:'Date',render:(row)=>dashboardDate(row.createdAt)}];
  const count = state.overview?.assignedOrdersInPeriod;
  byId('pr-assigned-orders-scope').textContent = Number.isFinite(Number(count)) ? `Les ${metricText(rows.length)} plus récentes sur ${metricText(count)} commandes affectées dans la période.` : '';
  renderOverviewTable('pr-assigned-orders', rows, columns, 'Aucune commande payée et affectée sur cette période.');
}
function renderNoResultOrders() {
  const rows = state.overview?.recentOrdersWithoutResult || [];
  byId('pr-no-results-scope').textContent = `Commandes vérifiées dans la période sélectionnée; les 100 affectations les plus récentes sont comparées aux résultats reçus.`;
  renderOverviewTable('pr-no-results', rows, [{label:'N° Commande',key:'id'}, {label:'Type',render:(row)=>row.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'}, {label:'Partenaire',key:'partnerName'}, {label:'Date',render:(row)=>dashboardDate(row.createdAt)}], 'Aucune commande sans résultat parmi les 100 affectations les plus récentes.');
}
function renderAdminOverview(data, days) {
  const metrics = [
    ['Partenaires actifs', data?.activePartners, '♧', '#1976e8', '#eaf2ff', false, 'Total des partenaires actifs'],
    ['Laboratoires actifs', data?.activeLaboratories, '⚗', '#8d63e8', '#f1eaff', false, 'Partenaires laboratoires'],
    ['Centres d’imagerie actifs', data?.activeImagingCenters, '▣', '#14aa85', '#e8faf4', false, 'Partenaires d’imagerie'],
    ['Commandes affectées aujourd’hui', data?.assignedToday, '▤', '#e29a19', '#fff5df', false, 'Total des commandes assignées'],
    ['Commandes en attente de résultat', data?.ordersAwaitingResultToday, '◷', '#1976e8', '#eaf2ff', false, 'En attente de résultats'],
    ['Résultats reçus aujourd’hui', data?.resultsReceivedToday, '▤', '#e64d64', '#fff0f2', false, 'Résultats soumis'],
    ['Résultats à contrôler', data?.awaitingReview, '◉', '#8d63e8', '#f1eaff', false, 'En attente de validation'],
    ['Corrections en attente', data?.correctionsPending, '✎', '#e29a19', '#fff5df', false, 'Résultats nécessitant une correction'],
    ['Examens validés / réalisés', data?.examsValidatedAsPerformed, '✓', '#14aa85', '#e8faf4', false, 'Examens validés'],
    ['Examens non réalisés / annulés', data?.examsNotPerformed, '×', '#e64d64', '#fff0f2', false, 'Annulés ou non réalisés'],
    ['Montant à payer aux prestataires', data?.amountDueHTG, '$', '#1976e8', '#eaf2ff', true, 'Total à régler'],
    ['Montant déjà payé', data?.amountPaidHTG, '▣', '#14aa85', '#e8faf4', true, 'Total des paiements effectués']
  ];
  byId('pr-admin-metrics').innerHTML = metrics.map(([label, value, icon, color, wash, currency, caption]) => `<div class="pr-metric" data-icon="${icon}" style="--metric-color:${color};--metric-wash:${wash}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(metricText(value, currency))}</strong><small>${escapeHtml(caption)}</small></div>`).join('');
  byId('pr-trend-period').textContent = `${days} derniers jours`;
  renderTrendChart(data?.trend);
  renderPartnerDonut(data?.activePartnerBreakdown);
  const dateColumn = { label:'Date', render:(row)=>dashboardDate(row.createdAt) };
  renderOverviewTable('pr-recent-orders', data?.recentAssignedOrders, [{label:'Commande',key:'id'}, {label:'Type',render:(row)=>row.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'}, {label:'Partenaire',key:'partnerName'}, dateColumn], 'Aucune commande affectée sur cette période.');
  renderOverviewTable('pr-recent-results', data?.recentResults, [{label:'Commande',key:'orderId'}, {label:'Type',render:(row)=>row.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'}, {label:'Partenaire',key:'partnerName'}, dateColumn], 'Aucun résultat reçu sur cette période.');
  renderOverviewTable('pr-recent-review', data?.recentResultsAwaitingReview, [{label:'Commande',key:'orderId'}, {label:'Type',render:(row)=>row.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'}, {label:'Partenaire',key:'partnerName'}, dateColumn], 'Aucun résultat en attente de contrôle.');
  renderAssignedOrders();
  renderNoResultOrders();
}
async function loadPartnerOverview() {
  try { const response = await call('healthPartnerGetResultsOverview'); renderMetrics(response.overview || {}); }
  catch (error) { showNotice(error.message, 'error'); }
}
async function loadPartnerOrders({ append = false } = {}) {
  try {
    if (!append) { state.partnerOrderCursor = null; state.orders = []; }
    const response = await call('healthPartnerListOrders', { query: { cursor: append ? state.partnerOrderCursor : '' } });
    state.orders.push(...(response.orders || [])); state.partnerOrderCursor = response.nextCursor || null; state.partnerOrderHasMore = Boolean(response.hasMore && state.partnerOrderCursor);
    const partner = response.partner || {}; state.partner = partner; byId('pr-identity').textContent = [partner.name, partner.partnerId ? `ID ${partner.partnerId}` : '', partner.providerType, [partner.address, partner.commune, partner.department].filter(Boolean).join(', '), (partner.phones || []).join(' / '), partner.email, partner.status].filter(Boolean).join(' · ');
    const dayNames = { monday: 'Lundi', tuesday: 'Mardi', wednesday: 'Mercredi', thursday: 'Jeudi', friday: 'Vendredi', saturday: 'Samedi', sunday: 'Dimanche' };
    const hours = Object.entries(partner.openingHours || {}).filter(([, value]) => value?.enabled).map(([day, value]) => `${dayNames[day] || day} ${value.open || ''}-${value.close || ''}`);
    byId('pr-partner-profile').innerHTML = `<dl class="pr-profile"><dt>Nom légal / commercial</dt><dd>${escapeHtml(partner.name || '—')}</dd><dt>Identifiant partenaire</dt><dd>${escapeHtml(partner.partnerId || '—')}</dd><dt>Services autorisés</dt><dd>${escapeHtml((partner.services || []).join(', ') || partner.providerType || '—')}</dd><dt>Responsable / statut</dt><dd>${escapeHtml(partner.status || '—')}</dd><dt>Adresse</dt><dd>${escapeHtml([partner.address, partner.commune, partner.department].filter(Boolean).join(', ') || '—')}</dd><dt>Téléphones</dt><dd>${escapeHtml((partner.phones || []).join(' · ') || '—')}</dd><dt>E-mail</dt><dd>${escapeHtml(partner.email || '—')}</dd><dt>Horaires</dt><dd>${escapeHtml(hours.join(' · ') || 'Non renseignés')}</dd><dt>Informations au patient</dt><dd>${escapeHtml(partner.additionalInformation || '—')}</dd></dl>`;
    byId('pr-partner-orders').innerHTML = `${state.orders.length ? state.orders.map((order) => `<div class="pr-list-item"><strong>${escapeHtml(order.id)}</strong><small>${escapeHtml(order.examName)} · ${escapeHtml(order.resultStatus || order.status)}</small></div>`).join('') : '<p>Aucune commande éligible sur cette page.</p>'}${state.partnerOrderHasMore ? '<button type="button" id="pr-load-more-orders" class="pr-quiet">Charger plus de commandes</button>' : ''}`;
    byId('pr-load-more-orders')?.addEventListener('click', () => loadPartnerOrders({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadPartnerResults({ append = false } = {}) {
  try {
    if (!append) { state.partnerResultCursor = null; state.results = []; }
    const response = await call('healthPartnerListResults', { query: { cursor: append ? state.partnerResultCursor : '' } });
    state.results.push(...(response.results || [])); state.partnerResultCursor = response.nextCursor || null; state.partnerResultHasMore = Boolean(response.hasMore && state.partnerResultCursor);
    byId('pr-own-results').innerHTML = `${state.results.length ? state.results.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.examName || item.orderId)}</strong><small>${escapeHtml(item.orderId)} · ${escapeHtml(item.status)} · ${escapeHtml(item.createdAt || '')}</small>${item.status === 'CORRECTION_REQUESTED' ? `<p><strong>Motif :</strong> ${escapeHtml(item.reviewReason || 'Motif à confirmer auprès de Smart Cut Health.')}</p>` : ''}</div>`).join('') : '<p>Aucun résultat transmis.</p>'}${state.partnerResultHasMore ? '<button type="button" id="pr-load-more-own-results" class="pr-quiet">Charger plus de résultats</button>' : ''}`;
    byId('pr-load-more-own-results')?.addEventListener('click', () => loadPartnerResults({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadPartnerCorrections({ append = false } = {}) {
  try {
    if (!append) { state.correctionCursor = null; state.corrections = []; }
    const response = await call('healthPartnerListResults', { query: { status: 'CORRECTION_REQUESTED', cursor: append ? state.correctionCursor : '' } });
    state.corrections.push(...(response.results || []));
    state.correctionCursor = response.nextCursor || null;
    state.correctionsHasMore = Boolean(response.hasMore && state.correctionCursor);
    byId('pr-corrections-list').innerHTML = `${state.corrections.length ? state.corrections.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.examName || 'Examen')} · ${escapeHtml(item.orderId)}</strong><small>Version ${Number(item.version || 1)} · ${escapeHtml(item.createdAt || '')}</small><p><strong>Motif de correction :</strong> ${escapeHtml(item.reviewReason || 'Contactez Smart Cut Health pour connaître le motif.')}</p><button type="button" class="pr-primary" data-submit-correction="${escapeHtml(item.id)}">Soumettre une correction</button></div>`).join('') : '<p>Aucune correction en attente.</p>'}${state.correctionsHasMore ? '<button type="button" id="pr-load-more-corrections" class="pr-quiet">Charger plus de corrections</button>' : ''}`;
    $$('[data-submit-correction]').forEach((button) => button.addEventListener('click', async () => {
      const item = state.corrections.find((entry) => entry.id === button.dataset.submitCorrection);
      if (!item) return;
      try {
        byId('pr-upload-card').hidden = true;
        await doLookup(item.orderId, 'external-partner', item.examLineId || '');
        byId('pr-upload-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } catch (error) { showNotice(error.message, 'error'); }
    }));
    byId('pr-load-more-corrections')?.addEventListener('click', () => loadPartnerCorrections({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadPartnerAudit({ append = false } = {}) {
  try {
    if (!append) { state.partnerAudit = []; state.partnerAuditCursor = null; }
    const response = await call('healthPartnerListOwnAudit', { query: { cursor: append ? state.partnerAuditCursor : '' } });
    state.partnerAudit.push(...(response.events || [])); state.partnerAuditCursor = response.nextCursor || null; state.partnerAuditHasMore = Boolean(response.hasMore && state.partnerAuditCursor);
    byId('pr-partner-audit').innerHTML = `${state.partnerAudit.length ? state.partnerAudit.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.action || 'Action')}</strong><small>${escapeHtml(item.createdAt || 'Date inconnue')} · ${escapeHtml(item.resource || '')}</small></div>`).join('') : '<p>Aucune action enregistrée sur cette page.</p>'}${state.partnerAuditHasMore ? '<button type="button" id="pr-load-more-partner-audit" class="pr-quiet">Charger la suite de l’historique</button>' : ''}`;
    byId('pr-load-more-partner-audit')?.addEventListener('click', () => loadPartnerAudit({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function doLookup(orderId, source = 'external-partner', examLineId = '') {
  const response = await call('healthPartnerLookupOrder', { method: 'POST', body: { orderId, source, ...(examLineId ? { examLineId } : {}) } });
  const internal = source === 'smartcut-health';
  const summary = byId(internal ? 'pr-internal-summary' : 'pr-order-summary');
  if (response.needsExamSelection) {
    summary.innerHTML = `<div class="pr-summary"><p class="pr-eyebrow">Plusieurs examens dans cette commande</p><label>Choisissez l’examen exact<select id="pr-select-exam-line"><option value="">Sélectionner…</option>${response.examLines.map((line) => `<option value="${escapeHtml(line.id)}">${escapeHtml(line.name)}${line.examId ? ` · ${escapeHtml(line.examId)}` : ''}</option>`).join('')}</select></label><button type="button" class="pr-primary" id="pr-confirm-exam-line">Continuer avec cet examen</button></div>`;
    byId('pr-confirm-exam-line').addEventListener('click', async () => { const lineId = byId('pr-select-exam-line').value; if (!lineId) return showNotice('Sélectionnez un examen précis avant de continuer.', 'error'); try { await doLookup(orderId, source, lineId); } catch (error) { showNotice(error.message, 'error'); } });
    return;
  }
  const order = response.order; const patientLabel = order.patientLabel || 'Patient';
  state.lookup = { ...response, source, requiredCategories: order.requiredCategories || [] };
  summary.innerHTML = `<div class="pr-summary"><p class="pr-eyebrow">Commande identifiée · ${internal ? 'Smart Cut Health' : 'Partenaire affecté'}</p><div class="pr-summary-grid"><div><b>N° commande</b><br>${escapeHtml(order.id)}</div><div><b>Patient</b><br>${escapeHtml(patientLabel)}</div><div><b>Type d’examen</b><br>${order.providerType === 'imaging' ? 'Imagerie médicale' : 'Laboratoire'}</div><div><b>Examen</b><br>${escapeHtml(order.examName)}</div><div><b>Date de commande</b><br>${escapeHtml(order.orderedAt || '—')}</div><div><b>Prestataire</b><br>${escapeHtml(order.partnerName || '—')}</div><div><b>Statut</b><br>${escapeHtml(order.status)}</div></div>${order.reviewReason ? `<p class="pr-correction-reason"><strong>Correction demandée par Smart Cut Health :</strong> ${escapeHtml(order.reviewReason)}</p>` : ''}</div>`;
  renderUploadFields(order.providerType, response.order.requiredCategories || [], internal ? 'internal' : 'partner'); byId(internal ? 'pr-internal-upload-card' : 'pr-upload-card').hidden = false;
}
function renderUploadFields(type, required, scope = 'partner') {
  const categories = type === 'imaging' ? [['IMAGING', 'Images de l’examen'], ['RADIOLOGY_REPORT', 'Rapport radiologique'], ['SUPPLEMENTAL', 'Document complémentaire']] : [['LAB_RESULT', 'Résultat / rapport de laboratoire'], ['SUPPLEMENTAL', 'Document complémentaire']];
  const prefix = scope === 'internal' ? 'pr-internal' : 'pr';
  const checklist = byId(`${prefix}-checklist`); const fields = byId(`${prefix}-file-fields`);
  const labelFor = Object.fromEntries(categories);
  const maxFileMb = Math.ceil((state.lookup?.order?.maxFileBytes || 15 * 1024 * 1024) / 1048576);
  const allowedCategories = categories.filter(([category]) => category !== 'SUPPLEMENTAL' || state.lookup?.order?.allowSupplemental !== false);
  checklist.innerHTML = required.map((category) => `<span class="pr-chip" data-required="${escapeHtml(category)}">${escapeHtml(labelFor[category] || category)} · MANQUANT</span>`).join('');
  const accepted = (state.lookup?.order?.allowedMimeTypes || ['application/pdf', 'image/jpeg', 'image/png']).join(',');
  const formatLabel = (state.lookup?.order?.allowedMimeTypes || ['application/pdf', 'image/jpeg', 'image/png']).map((mime) => ({ 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' }[mime] || mime)).join(', ');
  fields.innerHTML = allowedCategories.map(([category, label]) => `<div class="pr-file-box"><label for="${prefix}-file-${category}">${label}${required.includes(category) ? ' *' : ''}</label><input id="${prefix}-file-${category}" data-category="${category}" type="file" accept="${escapeHtml(accepted)}" ${state.lookup?.order?.allowMultiplePerCategory === false ? '' : 'multiple'} ${required.includes(category) ? 'data-required="true"' : ''}><button type="button" class="pr-quiet" data-add-files="${category}">${state.lookup?.order?.allowMultiplePerCategory === false ? 'Choisir / remplacer le fichier' : 'Ajouter un autre fichier'}</button><small>${escapeHtml(formatLabel)} · ${maxFileMb} Mo maximum par fichier${Number(state.lookup?.order?.maxFiles) ? ` · ${state.lookup.order.maxFiles} fichier(s) au total maximum` : ''}</small><div data-file-status="${category}"></div></div>`).join('');
  const inputs = $$(`#${prefix}-file-fields input`);
  inputs.forEach((input) => input.addEventListener('change', () => {
    const incoming = [...input.files];
    const previous = state.fileSelections.get(input) || [];
    const multiple = state.lookup?.order?.allowMultiplePerCategory !== false;
    const selected = multiple ? [...previous, ...incoming.filter((file) => !previous.some((prior) => prior.name === file.name && prior.size === file.size && prior.lastModified === file.lastModified))] : incoming.slice(0, 1);
    setSelectedFiles(input, selected, prefix, scope);
  }));
  $$('[data-add-files]', fields).forEach((button) => button.addEventListener('click', () => {
    const input = $$(`#${prefix}-file-fields input`).find((item) => item.dataset.category === button.dataset.addFiles);
    input?.click();
  }));
  byId(`${prefix}-confirm-order`).checked = false; updateUploadReadiness(scope);
}
function setSelectedFiles(input, files, prefix, scope) {
  const transfer = new DataTransfer();
  files.forEach((file) => { transfer.items.add(file); if (!state.fileAddedAt.has(file)) state.fileAddedAt.set(file, new Date()); });
  input.files = transfer.files;
  state.fileSelections.set(input, [...files]);
  refreshFilePreviews(prefix, scope);
  updateUploadReadiness(scope);
}
function refreshFilePreviews(prefix, scope) {
  state.fileUrls.forEach((url) => URL.revokeObjectURL(url)); state.fileUrls = [];
  const fields = byId(`${prefix}-file-fields`);
  const labels = { LAB_RESULT: 'Résultat laboratoire', IMAGING: 'Images de l’examen', RADIOLOGY_REPORT: 'Rapport radiologique', SUPPLEMENTAL: 'Document complémentaire' };
  $$(`#${prefix}-file-fields input`).forEach((input) => {
    const category = input.dataset.category;
    const status = $(`[data-file-status="${category}"]`, fields);
    status.innerHTML = [...input.files].map((file, index) => {
      const url = URL.createObjectURL(file); state.fileUrls.push(url);
      const preview = file.type === 'application/pdf' ? `<iframe title="Aperçu ${escapeHtml(file.name)}" src="${url}" loading="lazy"></iframe>` : `<img alt="Aperçu ${escapeHtml(file.name)}" src="${url}">`;
      const addedAt = state.fileAddedAt.get(file)?.toLocaleString('fr-FR') || new Date().toLocaleString('fr-FR');
      return `<div class="pr-dialog-file"><span><strong>${escapeHtml(file.name)}</strong><small>${escapeHtml(labels[category] || category)} · ${escapeHtml(file.type || 'Format inconnu')} · ${(file.size / 1048576).toFixed(2)} Mo · Ajouté ${escapeHtml(addedAt)}</small></span><button type="button" class="pr-quiet" data-replace-file="${category}" data-file-index="${index}">Remplacer</button><button type="button" class="pr-quiet" data-remove-file="${category}" data-file-index="${index}">Supprimer</button><details><summary>Voir / prévisualiser</summary>${preview}</details></div>`;
    }).join('');
    status.querySelectorAll('[data-remove-file]').forEach((button) => button.addEventListener('click', () => {
      const inputForCategory = $$(`#${prefix}-file-fields input`).find((item) => item.dataset.category === button.dataset.removeFile);
      if (!inputForCategory) return;
      const selected = [...inputForCategory.files]; selected.splice(Number(button.dataset.fileIndex), 1);
      setSelectedFiles(inputForCategory, selected, prefix, scope);
    }));
    status.querySelectorAll('[data-replace-file]').forEach((button) => button.addEventListener('click', () => {
      const inputForCategory = $$(`#${prefix}-file-fields input`).find((item) => item.dataset.category === button.dataset.replaceFile);
      if (!inputForCategory) return;
      const picker = document.createElement('input'); picker.type = 'file'; picker.accept = inputForCategory.accept;
      picker.addEventListener('change', () => {
        const replacement = picker.files?.[0]; if (!replacement) return;
        const selected = [...inputForCategory.files]; selected[Number(button.dataset.fileIndex)] = replacement;
        setSelectedFiles(inputForCategory, selected, prefix, scope);
      }, { once: true });
      picker.click();
    }));
  });
}
function updateUploadReadiness(scope = 'partner') {
  const prefix = scope === 'internal' ? 'pr-internal' : 'pr';
  const required = state.lookup?.requiredCategories || [];
  const available = new Set($$(`#${prefix}-file-fields input`).filter((input) => input.files.length).map((input) => input.dataset.category));
  const labels = { LAB_RESULT: 'Résultat de laboratoire', IMAGING: 'Images de l’examen', RADIOLOGY_REPORT: 'Rapport radiologique', SUPPLEMENTAL: 'Document complémentaire' };
  $$(`#${prefix}-checklist .pr-chip`).forEach((chip) => { const ok = available.has(chip.dataset.required); chip.classList.toggle('ok', ok); chip.textContent = `${labels[chip.dataset.required] || chip.dataset.required} · ${ok ? 'AJOUTÉ' : 'MANQUANT'}`; });
  const inputs = $$(`#${prefix}-file-fields input`); const files = inputs.reduce((count, input) => count + input.files.length, 0);
  const maxFiles = Number(state.lookup?.order?.maxFiles) || 20; const maxBytes = Number(state.lookup?.order?.maxFileBytes) || 15 * 1024 * 1024;
  const multipleDisallowed = state.lookup?.order?.allowMultiplePerCategory === false && inputs.some((input) => input.files.length > 1);
  const allowedMimeTypes = state.lookup?.order?.allowedMimeTypes || ['application/pdf', 'image/jpeg', 'image/png'];
  const invalidFiles = inputs.some((input) => [...input.files].some((file) => file.size > maxBytes || !allowedMimeTypes.includes(file.type)));
  const completed = required.filter((category) => available.has(category)).length;
  const invalid = files === 0 || files > maxFiles || multipleDisallowed || invalidFiles;
  const confirmed = byId(`${prefix}-confirm-order`).checked;
  const ready = completed === required.length && !invalid && confirmed;
  const progress = byId(`${prefix}-progress`); progress.max = Math.max(1, required.length); progress.value = completed;
  byId(`${prefix}-progress-label`).textContent = `${completed}/${required.length} éléments obligatoires ajoutés · ${files} fichier(s)`;
  byId(`${prefix}-progress-state`).textContent = completed < required.length ? 'Dossier incomplet' : invalid ? 'Vérifiez le format, le nombre et la taille des fichiers' : !confirmed ? 'Confirmez l’identité et l’examen' : 'Prêt à transmettre';
  byId(`${prefix}-submit-result`).disabled = !ready;
}
async function submitResult(event, scope = 'partner') {
  event.preventDefault(); if (!state.lookup) return;
  const prefix = scope === 'internal' ? 'pr-internal' : 'pr';
  const statusId = `${prefix}-upload-status`; const inputs = $$(`#${prefix}-file-fields input`);
  const fileCount = inputs.reduce((sum, input) => sum + input.files.length, 0);
  if (!confirm(`Confirmer le dépôt de ${fileCount} fichier(s) pour ${state.lookup.order.examName} · commande ${state.lookup.order.id} · ${state.lookup.order.patientLabel} ?`)) return;
  byId(`${prefix}-submit-result`).disabled = true; showStatus(statusId, 'Envoi sécurisé des fichiers…');
  try {
    const files = [];
    for (const input of inputs) for (const file of [...input.files]) {
      const fileId = crypto.randomUUID(); const path = `health-partner-results/${state.user.uid}/${state.lookup.order.id}/${state.lookup.uploadSessionId}/${fileId}`;
      await uploadBytes(storageRef(storage, path), file, { contentType: file.type });
      files.push({ fileId, category: input.dataset.category, storagePath: path, fileName: file.name });
    }
    showStatus(statusId, 'Analyse de sécurité des fichiers avant transmission…');
    const response = await call('healthPartnerSubmitResult', { method: 'POST', body: { uploadSessionId: state.lookup.uploadSessionId, files, performedAt: byId(`${prefix}-performed-at`).value || null, comment: byId(`${prefix}-comment`).value.trim() } });
    showStatus(statusId, `Résultat transmis à Smart Cut Health · Référence ${response.resultId}`, 'success'); byId(`${prefix}-upload-card`).hidden = true; state.lookup = null;
    if (scope === 'partner') await Promise.all([loadPartnerOrders(), loadPartnerResults(), loadPartnerCorrections(), loadPartnerOverview()]); else await loadAdminResults();
  } catch (error) { showStatus(statusId, error.message, 'error'); byId(`${prefix}-submit-result`).disabled = false; }
}
async function loadAdminResults({ append = false } = {}) {
  try {
    if (!append) state.adminCursor = null;
    const response = await call('healthAdminListPartnerResults', { query: { status: byId('pr-filter-status').value, providerType: byId('pr-filter-type').value, partnerUid: byId('pr-filter-partner').value, examId: byId('pr-filter-exam').value, paymentStatus: byId('pr-filter-payment').value, q: byId('pr-filter-search').value.trim(), from: byId('pr-filter-from').value, to: byId('pr-filter-to').value, cursor: append ? state.adminCursor : '' } });
    const fetched = response.results || [];
    state.results = (append ? [...new Map([...state.results, ...fetched].map((item) => [item.id, item])).values()] : fetched).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    state.adminCursor = response.nextCursor || null; state.adminHasMore = Boolean(response.hasMore && state.adminCursor);
    syncAdminFilterOptions();
     byId('pr-admin-results').innerHTML = state.results.length ? `<table class="pr-table"><thead><tr><th>Relevé</th><th>N° commande</th><th>Patient</th><th>Examen / type</th><th>Prestataire</th><th>Date commande</th><th>Date réalisation</th><th>Date dépôt / fichiers</th><th>Contrôle</th><th>Montant dû</th><th>Paiement</th><th>Actions</th></tr></thead><tbody>${state.results.map((item) => `<tr><td>${item.paymentStatus === 'ELIGIBLE' && !item.settlementId ? `<input type="checkbox" data-payout-result="${escapeHtml(item.id)}" aria-label="Inclure ${escapeHtml(item.examName)} au relevé">` : '—'}</td><td>${escapeHtml(item.orderId)}<br><small>${escapeHtml(item.examLineId || '')}</small></td><td>${escapeHtml(item.patientName || item.patientLabel || '—')}</td><td>${escapeHtml(item.examName)}<br><small>${item.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'} · ${item.source === 'smartcut-health' ? 'Smart Cut Health' : 'Partenaire externe'}</small></td><td>${escapeHtml(item.partnerName || (item.source === 'smartcut-health' ? 'Smart Cut Health' : item.partnerUid) || 'Prestataire')}</td><td>${escapeHtml(item.orderedAt || '—')}</td><td>${escapeHtml(item.performedAt || '—')}</td><td>${escapeHtml(item.createdAt || '—')}<br>${item.files?.length || 0} fichier(s)</td><td>${escapeHtml(item.status)}</td><td>${item.source === 'smartcut-health' ? '—' : `${Number(item.partnerAmountSnapshot || 0).toLocaleString('fr-HT')} HTG`}</td><td>${item.paymentStatus === 'PAID' ? 'Payé' : item.paymentStatus === 'PENDING' ? 'Dans un relevé' : item.paymentStatus === 'NOT_APPLICABLE' ? 'Interne' : item.paymentStatus === 'ELIGIBLE' ? 'Éligible' : 'Bloqué'}</td><td><button class="pr-quiet" data-open-result="${escapeHtml(item.id)}">Voir / contrôler</button> <button class="pr-quiet" data-result-history="${escapeHtml(item.id)}">Historique</button> <button class="pr-quiet" data-report-result-issue="${escapeHtml(item.id)}">Signaler une anomalie</button>${item.status === 'VALIDATED' ? ` <button class="pr-primary" data-transfer-result="${escapeHtml(item.id)}">Transférer</button>` : ''}</td></tr>`).join('')}</tbody></table><p class="pr-pagination-status">${state.results.length} résultat(s) chargé(s)${state.adminHasMore ? ' · d’autres résultats sont disponibles' : ' · fin de la liste'}</p>${state.adminHasMore ? '<button type="button" id="pr-load-more-results" class="pr-quiet">Charger plus de résultats</button>' : ''}` : `<p>Aucun résultat reçu avec ces filtres.${state.adminHasMore ? ' Vous pouvez continuer la recherche dans les pages suivantes.' : ''}</p>${state.adminHasMore ? '<button type="button" id="pr-load-more-results" class="pr-quiet">Charger plus de résultats</button>' : ''}`;
    $$('[data-open-result]').forEach((button) => button.addEventListener('click', () => openReview(button.dataset.openResult)));
    $$('[data-result-history]').forEach((button) => button.addEventListener('click', () => openReview(button.dataset.resultHistory)));
    $$('[data-report-result-issue]').forEach((button) => button.addEventListener('click', () => reportResultIssue(button.dataset.reportResultIssue)));
    $$('[data-transfer-result]').forEach((button) => button.addEventListener('click', () => transferResult(button.dataset.transferResult)));
    byId('pr-load-more-results')?.addEventListener('click', () => loadAdminResults({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadAdminSettlements({ append = false } = {}) {
  try {
    if (!append) { state.settlementCursor = null; state.settlements = []; }
    const response = await call('healthAdminListPartnerResultSettlements', { query: { cursor: append ? state.settlementCursor : '' } });
    state.settlements.push(...(response.settlements || [])); state.settlementCursor = response.nextCursor || null; state.settlementsHasMore = Boolean(response.hasMore && state.settlementCursor);
    byId('pr-settlements-list').innerHTML = `${state.settlements.length ? state.settlements.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.partnerName || item.partnerUid)} · ${Number(item.partnerAmount || 0).toLocaleString('fr-HT')} HTG</strong><small>${escapeHtml(item.status)} · ${item.lineCount || 0} examen(s) · ${escapeHtml(item.createdAt || '')}</small><p>Référence : ${escapeHtml(item.paymentReference || 'Non renseignée')}</p>${item.status === 'PENDING' ? `<button type="button" class="pr-primary" data-mark-settlement-paid="${escapeHtml(item.id)}">Enregistrer le paiement</button>` : ''}</div>`).join('') : '<p>Aucun relevé de règlement créé.</p>'}${state.settlementsHasMore ? '<button type="button" id="pr-load-more-settlements" class="pr-quiet">Charger plus de règlements</button>' : ''}`;
    $$('[data-mark-settlement-paid]').forEach((button) => button.addEventListener('click', () => markSettlementPaid(button.dataset.markSettlementPaid)));
    byId('pr-load-more-settlements')?.addEventListener('click', () => loadAdminSettlements({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadAdminAudit({ append = false } = {}) {
  try {
    if (!append) { state.adminAudit = []; state.adminAuditCursor = null; }
    const response = await call('healthAdminListPartnerResultsAudit', { query: { cursor: append ? state.adminAuditCursor : '' } });
    state.adminAudit.push(...(response.events || [])); state.adminAuditCursor = response.nextCursor || null; state.adminAuditHasMore = Boolean(response.hasMore && state.adminAuditCursor);
    byId('pr-audit-list').innerHTML = `${state.adminAudit.length ? state.adminAudit.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.action || 'Action')}</strong><small>${escapeHtml(item.createdAt || 'Date inconnue')} · ${escapeHtml(item.actorUid || 'Utilisateur')} · ${escapeHtml(item.resource || '')}</small><p>${escapeHtml(JSON.stringify(item.context || {}))}</p></div>`).join('') : '<p>Aucune action enregistrée sur cette page.</p>'}${state.adminAuditHasMore ? '<button type="button" id="pr-load-more-audit" class="pr-quiet">Charger la suite de l’historique</button>' : ''}`;
    byId('pr-load-more-audit')?.addEventListener('click', () => loadAdminAudit({ append: true }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function loadAdminAlerts() {
  try {
    const response = await call('healthAdminListPartnerResultsAlerts'); const alerts = response.alerts || [];
    byId('pr-admin-alerts').innerHTML = alerts.length ? alerts.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.title || item.type || 'Alerte')}</strong><small>${escapeHtml(item.status || 'OPEN')} · ${escapeHtml(item.createdAt || '')} · Compte : ${escapeHtml(item.actorUid || '—')}</small><p>${item.orderId ? `Commande : ${escapeHtml(item.orderId)} · ` : ''}${item.attemptCount ? `${Number(item.attemptCount)} tentatives · ` : ''}${escapeHtml(item.issueReason || item.resolutionReason || (item.status === 'RESOLVED' ? 'Alerte clôturée' : 'À examiner'))}</p>${item.status !== 'RESOLVED' ? `<button type="button" class="pr-quiet" data-resolve-results-alert="${escapeHtml(item.id)}">Clôturer avec motif</button>` : ''}</div>`).join('') : '<p>Aucune alerte enregistrée.</p>';
    $$('[data-resolve-results-alert]').forEach((button) => button.addEventListener('click', () => resolveResultsAlert(button.dataset.resolveResultsAlert)));
  } catch (error) { byId('pr-admin-alerts').textContent = error.message || 'Alertes indisponibles.'; }
}
async function resolveResultsAlert(alertId) {
  const reason = prompt('Motif de clôture (minimum 5 caractères) :');
  if (!reason || reason.trim().length < 5) return;
  try { await call('healthAdminResolvePartnerResultsAlert', { method: 'POST', body: { alertId, reason: reason.trim() } }); await Promise.all([loadAdminAlerts(), loadAdminAudit()]); }
  catch (error) { showNotice(error.message, 'error'); }
}
async function reportResultIssue(resultId) {
  const reason = prompt('Décrivez l’anomalie constatée (minimum 5 caractères) :');
  if (!reason || reason.trim().length < 5) return;
  try { await call('healthAdminCreatePartnerResultIssue', { method: 'POST', body: { resultId, reason: reason.trim() } }); showNotice('Anomalie enregistrée dans les alertes du portail.', 'success'); await Promise.all([loadAdminAlerts(), loadAdminAudit()]); }
  catch (error) { showNotice(error.message, 'error'); }
}
async function createPartnerSettlement() {
  const resultIds = $$('[data-payout-result]:checked').map((input) => input.dataset.payoutResult);
  if (!resultIds.length) return showNotice('Cochez au moins un résultat externe validé et éligible.', 'error');
  if (!confirm(`Créer un relevé de paiement pour ${resultIds.length} examen(s) ? Tous doivent appartenir au même partenaire.`)) return;
  try { await call('healthAdminCreatePartnerResultSettlement', { method: 'POST', body: { resultIds } }); showNotice('Relevé de paiement créé. Vérifiez le partenaire et le montant avant le règlement.', 'success'); await Promise.all([loadAdminResults(), loadAdminSettlements()]); }
  catch (error) { showNotice(error.message, 'error'); }
}
async function markSettlementPaid(settlementId) {
  const paymentReference = prompt('Saisissez la référence du paiement effectué :');
  if (!paymentReference || paymentReference.trim().length < 3) return;
  if (!confirm('Confirmer que le paiement du relevé a bien été effectué ? Cette action sera auditée.')) return;
  try { await call('healthAdminMarkPartnerResultSettlementPaid', { method: 'POST', body: { settlementId, paymentReference: paymentReference.trim() } }); showNotice('Paiement enregistré.', 'success'); await Promise.all([loadAdminResults(), loadAdminSettlements()]); }
  catch (error) { showNotice(error.message, 'error'); }
}
async function openReview(resultId) {
  const result = state.results.find((item) => item.id === resultId); if (!result) return;
  state.activeResult = result; byId('pr-review-title').textContent = `${result.examName || 'Résultat'} · ${result.orderId}`;
  byId('pr-review-reason').value = '';
  byId('pr-review-summary').innerHTML = `<dl class="pr-profile"><dt>Patient</dt><dd>${escapeHtml(result.patientName || result.patientLabel || '—')}</dd><dt>N° commande</dt><dd>${escapeHtml(result.orderId || '—')}</dd><dt>Examen</dt><dd>${escapeHtml(result.examName || '—')}</dd><dt>Type</dt><dd>${result.providerType === 'imaging' ? 'Imagerie médicale' : 'Laboratoire'}</dd><dt>Prestataire</dt><dd>${escapeHtml(result.partnerName || (result.source === 'smartcut-health' ? 'Smart Cut Health' : result.partnerUid) || '—')}</dd><dt>Date de commande</dt><dd>${escapeHtml(result.orderedAt || '—')}</dd><dt>Date de réalisation</dt><dd>${escapeHtml(result.performedAt || '—')}</dd><dt>Statut</dt><dd>${escapeHtml(result.status || '—')}</dd></dl>`;
  byId('pr-review-files').innerHTML = (result.files || []).map((file) => `<div class="pr-dialog-file"><span>${escapeHtml(file.category)} · ${escapeHtml(file.fileName)} · ${(Number(file.size || 0) / 1048576).toFixed(2)} Mo</span><button type="button" class="pr-quiet" data-preview-file="${escapeHtml(file.id)}">VOIR</button><button type="button" class="pr-quiet" data-print-file="${escapeHtml(file.id)}">Imprimer</button></div>`).join('') || '<p>Aucun fichier.</p>';
  $$('[data-preview-file]').forEach((button) => button.addEventListener('click', () => openResultFile(resultId, button.dataset.previewFile, 'preview')));
  $$('[data-print-file]').forEach((button) => button.addEventListener('click', () => openResultFile(resultId, button.dataset.printFile, 'print')));
  $$('#pr-review-form [data-review]').forEach((button) => { button.hidden = result.status !== 'RESULT_PENDING_REVIEW'; button.onclick = () => reviewResult(resultId, button.dataset.review); });
  $('[data-transfer]', byId('pr-review-form')).hidden = result.status !== 'VALIDATED'; $('[data-transfer]', byId('pr-review-form')).onclick = () => transferResult(resultId);
  byId('pr-review-dialog').showModal();
  loadResultHistory(resultId);
}
async function loadResultHistory(resultId) {
  const root = byId('pr-result-history'); root.textContent = 'Chargement de l’historique…';
  try {
    const response = await call('healthAdminGetPartnerResultHistory', { query: { resultId } });
    const versions = response.versions || []; const events = response.events || [];
    root.innerHTML = `${versions.length ? versions.map((item) => `<div class="pr-list-item"><strong>Version ${escapeHtml(item.version || 1)} · ${escapeHtml(item.status)}</strong><small>${escapeHtml(item.createdAt || 'Date inconnue')} · ${escapeHtml(item.uploadedByUid || 'Utilisateur')}</small><span>${item.files?.length || 0} fichier(s) · ${item.id === resultId ? 'Version actuelle' : 'Version précédente'}</span>${(item.files || []).map((file) => `<button type="button" class="pr-quiet" data-history-file-result="${escapeHtml(item.id)}" data-history-file-id="${escapeHtml(file.id)}">Voir ${escapeHtml(file.fileName || file.category)}</button>`).join('')}</div>`).join('') : '<p>Aucune version historique.</p>'}${events.length ? events.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.action || 'Action')}</strong><small>${escapeHtml(item.createdAt || '')} · ${escapeHtml(item.actorUid || '')}</small><span>${escapeHtml(JSON.stringify(item.context || {}))}</span></div>`).join('') : '<p>Aucune action antérieure enregistrée.</p>'}`;
    $$('[data-history-file-result]', root).forEach((button) => button.addEventListener('click', () => openResultFile(button.dataset.historyFileResult, button.dataset.historyFileId, 'preview')));
  } catch (error) { root.textContent = error.message || 'Historique indisponible.'; }
}
async function openResultFile(resultId, fileId, action) {
  const tab = window.open('about:blank', '_blank');
  try {
    const response = await call('healthAdminGetPartnerResultFileUrl', { query: { resultId, fileId, action } });
    if (!tab) { window.location.href = response.url; return; }
    if (action !== 'print') { tab.location.href = response.url; return; }
    const result = state.results.find((item) => item.id === resultId) || state.activeResult || {};
    const file = (result.files || []).find((item) => item.id === fileId) || {};
    const labels = { LAB_RESULT: 'Résultat de laboratoire', IMAGING: 'Images d’imagerie médicale', RADIOLOGY_REPORT: 'Rapport radiologique', SUPPLEMENTAL: 'Document complémentaire' };
    const metadata = [
      ['Patient', result.patientName || result.patientLabel || 'Non renseigné'],
      ['Commande', result.orderId || 'Non renseigné'],
      ['Examen', result.examName || 'Non renseigné'],
      ['Prestataire', result.partnerName || (result.source === 'smartcut-health' ? 'Smart Cut Health' : result.partnerUid) || 'Non renseigné'],
      ['Date de réalisation', result.performedAt || 'Non renseignée'],
      ['Référence du fichier', labels[file.category] || file.category || file.fileName || 'Résultat']
    ];
    const details = metadata.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');
    const preview = String(file.contentType || '').startsWith('image/')
      ? `<img class="pr-print-image" src="${escapeHtml(response.url)}" alt="${escapeHtml(labels[file.category] || file.fileName || 'Résultat')}">`
      : `<iframe class="pr-print-document" title="Document médical" src="${escapeHtml(response.url)}"></iframe>`;
    tab.document.open();
    tab.document.write(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Résultat · ${escapeHtml(result.orderId || resultId)}</title><style>body{font:15px Arial,sans-serif;color:#182a36;margin:28px}header{border-bottom:2px solid #0c7566;padding-bottom:14px}h1{font-size:22px;margin:0 0 8px}p{margin:4px 0;color:#536773}dl{display:grid;grid-template-columns:1fr 1fr;gap:10px 20px;margin:20px 0}dl div{border-bottom:1px solid #d7e1e4;padding:8px 0}dt{font-size:12px;color:#536773}dd{margin:4px 0 0;font-weight:700;overflow-wrap:anywhere}.pr-print-document{width:100%;height:75vh;border:1px solid #d7e1e4}.pr-print-image{display:block;max-width:100%;max-height:75vh;margin:0 auto}.pr-print-actions{display:flex;gap:10px;margin:18px 0}.pr-print-actions button,.pr-print-actions a{padding:10px 14px;border:1px solid #b8cbcf;border-radius:8px;background:#fff;color:#0c6257;font-weight:700;text-decoration:none;cursor:pointer}@media print{body{margin:12mm}.pr-print-actions{display:none}.pr-print-document{height:230mm}header,dl{break-inside:avoid}}</style></head><body><header><h1>Smart Cut Health · Résultat d’examen</h1><p>Document médical confidentiel · Impression administrative</p></header><dl>${details}</dl><div class="pr-print-actions"><button id="pr-print-button" type="button">Imprimer ce résultat</button><a href="${escapeHtml(response.url)}" target="_blank" rel="noopener">Ouvrir le fichier original</a></div>${preview}</body></html>`);
    tab.document.close();
    tab.document.getElementById('pr-print-button')?.addEventListener('click', () => tab.print());
  }
  catch (error) { tab?.close(); showNotice(error.message, 'error'); }
}
function downloadCsv(fileName, columns, rows) {
  const csv = [columns, ...rows].map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })); const link = document.createElement('a'); link.href = url; link.download = fileName; link.click(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
function currentAdminResultFilters() {
  return { status: byId('pr-filter-status').value, providerType: byId('pr-filter-type').value, partnerUid: byId('pr-filter-partner').value, examId: byId('pr-filter-exam').value, paymentStatus: byId('pr-filter-payment').value, q: byId('pr-filter-search').value.trim(), from: byId('pr-filter-from').value, to: byId('pr-filter-to').value };
}
async function exportAdminResultsCsv() {
  const columns = ['Commande', 'Ligne examen', 'Patient', 'Identifiant patient', 'Examen', 'Type', 'Prestataire', 'Date commande', 'Date dépôt', 'Date réalisation', 'Statut contrôle', 'Statut paiement', 'Montant patient HTG', 'Montant prestataire HTG', 'Marge HTG', 'Source'];
  const button = byId('pr-export-results'); const original = button.textContent; button.disabled = true; button.textContent = 'Préparation de l’export…';
  try {
    const results = []; let cursor = ''; let pages = 0;
    do {
      const response = await call('healthAdminListPartnerResults', { query: { ...currentAdminResultFilters(), cursor } });
      results.push(...(response.results || [])); cursor = response.nextCursor || ''; pages += 1;
      button.textContent = `Export · ${results.length} lignes`;
      if (pages >= 1000 && cursor) throw new Error('Export trop volumineux. Réduisez la période ou les filtres.');
    } while (cursor);
    const rows = results.map((item) => [item.orderId, item.examLineId, item.patientName || item.patientLabel, item.patientUid, item.examName, item.providerType, item.partnerName, item.orderedAt, item.createdAt, item.performedAt, item.status, item.paymentStatus, item.patientPriceSnapshot, item.partnerAmountSnapshot, item.smartCutMarginSnapshot, item.source]);
    downloadCsv('smart-cut-resultats-admin.csv', columns, rows);
  } catch (error) { showNotice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = original; }
}
async function exportAdminSettlementsCsv() {
  const columns = ['Prestataire', 'ID prestataire', 'Référence relevé', 'Nombre examens', 'Montant HTG', 'Statut', 'Référence paiement', 'Créé le', 'Payé le'];
  const button = byId('pr-export-settlements'); const original = button.textContent; button.disabled = true; button.textContent = 'Préparation de l’export…';
  try {
    const settlements = []; let cursor = ''; let pages = 0;
    do {
      const response = await call('healthAdminListPartnerResultSettlements', { query: { cursor } });
      settlements.push(...(response.settlements || [])); cursor = response.nextCursor || ''; pages += 1;
      button.textContent = `Export · ${settlements.length} relevés`;
      if (pages >= 1000 && cursor) throw new Error('Export trop volumineux; exportez les paiements par périodes.');
    } while (cursor);
    const rows = settlements.flatMap((item) => (item.lines || []).length
      ? item.lines.map((line) => [item.partnerName || item.partnerUid, item.partnerUid, item.id, item.lineCount, line.partnerAmount, item.status, item.paymentReference, item.createdAt, item.paidAt, line.orderId, line.examLineId, line.examName])
      : [[item.partnerName || item.partnerUid, item.partnerUid, item.id, item.lineCount, item.partnerAmount, item.status, item.paymentReference, item.createdAt, item.paidAt, '', '', '']]);
    downloadCsv('smart-cut-paiements-prestataires.csv', [...columns, 'Commande', 'Ligne examen', 'Examen'], rows);
  } catch (error) { showNotice(error.message, 'error'); }
  finally { button.disabled = false; button.textContent = original; }
}
async function reviewResult(resultId, action) {
  const reason = byId('pr-review-reason').value.trim(); if (['REQUEST_CORRECTION', 'NOT_PERFORMED'].includes(action) && reason.length < 5) { showNotice('Indiquez un motif détaillé (au moins 5 caractères).', 'error'); return; }
  try { await call('healthAdminReviewPartnerResult', { method: 'POST', body: { resultId, action, reason } }); byId('pr-review-dialog').close(); showNotice('Décision enregistrée. Le patient ne voit pas encore le résultat.', 'success'); await loadAdminResults(); } catch (error) { showNotice(error.message, 'error'); }
}
async function transferResult(resultId) {
  if (!confirm('Transférer définitivement ce résultat validé dans Mes Résultats du patient ?')) return;
  try { await call('healthAdminTransferPartnerResult', { method: 'POST', body: { resultId } }); byId('pr-review-dialog').close(); showNotice('Résultat transféré au patient.', 'success'); await loadAdminResults(); } catch (error) { showNotice(error.message, 'error'); }
}
async function loadAdminPartners() {
  try {
    const response = await call('healthAdminListResultsPartners'); state.partners = response.partners || []; state.partnersLoaded = true;
    syncAdminFilterOptions();
    syncPartnerLocationFilters();
    renderAdminPartners();
  } catch (error) { state.partnersLoaded = false; renderAdminPartners(); showNotice(error.message, 'error'); }
}
const partnerHasService = (partner, service) => (partner.services || []).includes(service) || partner.providerType === service;
function partnerStatusLabel(status) { return ({ active: 'Actif', suspended: 'Suspendu', disabled: 'Désactivé' })[String(status || '').toLowerCase()] || 'En attente'; }
function partnerServiceLabel(partner) {
  const services = partner.services || [];
  if (services.includes('laboratory') && services.includes('imaging')) return 'Laboratoire / Imagerie';
  return partner.providerType === 'imaging' || services.includes('imaging') ? 'Imagerie' : 'Laboratoire';
}
function renderAdminPartners() {
  const partners = state.partners || [];
  const totalLabs = partners.filter((partner) => partnerHasService(partner, 'laboratory')).length;
  const totalImaging = partners.filter((partner) => partnerHasService(partner, 'imaging')).length;
  const inactive = partners.filter((partner) => ['suspended', 'disabled'].includes(String(partner.status || '').toLowerCase())).length;
  byId('pr-partner-summary').innerHTML = [
    ['♧', 'Total des partenaires', partners.length, 'Tous les partenaires', 'blue'],
    ['⚗', 'Laboratoires', totalLabs, 'Partenaires laboratoire', 'violet'],
    ['▧', 'Centres d’imagerie', totalImaging, 'Partenaires imagerie', 'mint'],
    ['⊘', 'Suspendus / désactivés', inactive, 'Partenaires non actifs', 'rose']
  ].map(([icon, label, value, caption, color]) => `<article class="pr-partner-stat ${color}"><span class="pr-partner-stat-icon" aria-hidden="true">${icon}</span><div><span>${label}</span><strong>${state.partnersLoaded ? Number(value).toLocaleString('fr-HT') : '—'}</strong><small>${caption}</small></div></article>`).join('');

  const term = byId('pr-partner-search').value.trim().toLocaleLowerCase('fr');
  const type = byId('pr-partner-filter-type').value;
  const status = byId('pr-partner-filter-status').value;
  const department = byId('pr-partner-filter-department').value;
  const commune = byId('pr-partner-filter-commune').value;
  const filtered = partners.filter((partner) => {
    const services = partner.services || [];
    const matchesType = !type || (type === 'mixed' ? services.includes('laboratory') && services.includes('imaging') : partnerHasService(partner, type));
    const searchText = [partner.name, partner.responsibleName, ...(partner.phones || []), partner.commune, partner.department, partner.partnerId].join(' ').toLocaleLowerCase('fr');
    return (!term || searchText.includes(term)) && matchesType && (!status || String(partner.status || '').toLowerCase() === status) && (!department || partner.department === department) && (!commune || partner.commune === commune);
  }).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'fr'));
  const pageSize = Number(byId('pr-partner-page-size').value) || 10;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.partnerPage = Math.min(state.partnerPage, pageCount);
  const start = (state.partnerPage - 1) * pageSize;
  const visible = filtered.slice(start, start + pageSize);
  const table = visible.length ? `<table class="pr-partner-table"><thead><tr><th><span class="pr-sr-only">Sélection</span><input type="checkbox" disabled aria-label="Sélectionner les partenaires de cette page"></th><th>Nom légal / nom commercial</th><th>Type(s) de service</th><th>Responsable</th><th>Téléphone(s)</th><th>Ville / Commune</th><th>Statut</th><th>Date de création</th><th>Actions</th></tr></thead><tbody>${visible.map((partner) => {
    const statusKey = ['active', 'suspended', 'disabled'].includes(String(partner.status || '').toLowerCase()) ? String(partner.status).toLowerCase() : 'pending';
    const statusText = partnerStatusLabel(statusKey);
    const icon = partnerHasService(partner, 'imaging') && !partnerHasService(partner, 'laboratory') ? '▧' : '⚗';
    const typeClass = icon === '▧' ? 'imaging' : 'laboratory';
    return `<tr><td><input type="checkbox" disabled aria-label="Sélectionner ${escapeHtml(partner.name)}"></td><td><div class="pr-partner-name-cell"><span class="pr-partner-type-icon ${typeClass}" aria-hidden="true">${icon}</span><strong>${escapeHtml(partner.name || '—')}</strong></div></td><td><span class="pr-partner-service ${typeClass}">${escapeHtml(partnerServiceLabel(partner))}</span></td><td>${escapeHtml(partner.responsibleName || '—')}</td><td>${escapeHtml((partner.phones || []).filter(Boolean).join(', ') || '—')}</td><td>${escapeHtml(partner.commune || '—')}</td><td><span class="pr-partner-status ${statusKey}"><i></i>${statusText}</span></td><td>${dashboardDate(partner.createdAt)}</td><td><details class="pr-partner-row-menu"><summary aria-label="Actions pour ${escapeHtml(partner.name)}">•••</summary><div class="pr-partner-row-menu-items"><button type="button" data-partner-action="profile" data-partner-uid="${escapeHtml(partner.uid)}">Voir le profil</button><button type="button" data-partner-action="edit" data-partner-uid="${escapeHtml(partner.uid)}">Modifier</button><button type="button" data-partner-action="services" data-partner-uid="${escapeHtml(partner.uid)}">Définir les services autorisés</button>${statusKey === 'active' ? `<button type="button" data-partner-action="status" data-partner-uid="${escapeHtml(partner.uid)}" data-next-status="suspended">Suspendre</button><button type="button" data-partner-action="status" data-partner-uid="${escapeHtml(partner.uid)}" data-next-status="disabled">Désactiver</button>` : `<button type="button" data-partner-action="status" data-partner-uid="${escapeHtml(partner.uid)}" data-next-status="active">Activer le compte</button>`}<button type="button" data-partner-action="reset" data-partner-uid="${escapeHtml(partner.uid)}" ${statusKey !== 'active' ? 'disabled title="Réactivez le compte avant de réinitialiser l’accès"' : ''}>Réinitialiser l’accès</button><button type="button" data-partner-action="results" data-partner-uid="${escapeHtml(partner.uid)}">Voir les résultats déposés</button><button type="button" data-partner-action="report" data-partner-uid="${escapeHtml(partner.uid)}">Voir le rapport du partenaire</button></div></details></td></tr>`;
  }).join('')}</tbody></table>` : `<div class="pr-partner-empty"><strong>${!state.partnersLoaded ? 'Chargement des partenaires…' : partners.length ? 'Aucun partenaire ne correspond aux filtres.' : 'Aucun partenaire enregistré.'}</strong><span>${!state.partnersLoaded ? 'Les données seront affichées dès que le chargement est terminé.' : partners.length ? 'Modifiez les critères de recherche.' : 'Les partenaires créés apparaîtront ici.'}</span></div>`;
  byId('pr-partners-list').innerHTML = table;
  byId('pr-partner-page-label').textContent = filtered.length ? `Affichage de ${start + 1} à ${Math.min(start + pageSize, filtered.length)} sur ${filtered.length} partenaire${filtered.length === 1 ? '' : 's'}` : '0 partenaire';
  byId('pr-partner-pages').innerHTML = pageCount > 1 ? `<button type="button" data-partner-page="${Math.max(1, state.partnerPage - 1)}" aria-label="Page précédente" ${state.partnerPage === 1 ? 'disabled' : ''}>‹</button>${Array.from({ length: pageCount }, (_, index) => index + 1).map((page) => `<button type="button" data-partner-page="${page}" class="${page === state.partnerPage ? 'active' : ''}" aria-current="${page === state.partnerPage ? 'page' : 'false'}">${page}</button>`).join('')}<button type="button" data-partner-page="${Math.min(pageCount, state.partnerPage + 1)}" aria-label="Page suivante" ${state.partnerPage === pageCount ? 'disabled' : ''}>›</button>` : '';
}
function syncPartnerLocationFilters() {
  const department = byId('pr-partner-filter-department');
  const commune = byId('pr-partner-filter-commune');
  const selectedDepartment = department.value;
  const selectedCommune = commune.value;
  const setOptions = (select, values, selected) => {
    select.innerHTML = '<option value="">Tous</option>' + values.filter(Boolean).sort((a, b) => a.localeCompare(b, 'fr')).map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
    if (values.includes(selected)) select.value = selected;
  };
  setOptions(department, [...new Set(state.partners.map((partner) => partner.department))], selectedDepartment);
  const selectedDepartmentValue = department.value;
  setOptions(commune, [...new Set(state.partners.filter((partner) => !selectedDepartmentValue || partner.department === selectedDepartmentValue).map((partner) => partner.commune))], selectedCommune);
}
function showPartnerProfile(uid) {
  const partner = state.partners.find((item) => item.uid === uid);
  if (!partner) return;
  const rows = [
    ['Nom légal / nom commercial', partner.name], ['Type(s) de service', partnerServiceLabel(partner)],
    ['Responsable', partner.responsibleName], ['E-mail', partner.email], ['Téléphone(s)', (partner.phones || []).join(', ')],
    ['Adresse', partner.address], ['Pays', partner.country], ['Département', partner.department], ['Commune', partner.commune],
    ['NIF', partner.taxId], ['Statut', partnerStatusLabel(partner.status)], ['Date de création', dashboardDate(partner.createdAt)],
    ['Informations complémentaires', partner.additionalInformation], ['Notes administratives', partner.administrativeNotes]
  ].filter(([, value]) => value !== null && value !== undefined && String(value).trim() !== '');
  byId('pr-partner-profile-title').textContent = partner.name || 'Profil partenaire';
  byId('pr-partner-profile-content').innerHTML = `<dl>${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>${(partner.contractDocuments || []).length ? `<section class="pr-profile-documents"><h3>Documents enregistrés</h3>${partner.contractDocuments.map((doc) => `<button type="button" class="pr-quiet" data-contract-document="${escapeHtml(doc.id)}" data-partner-uid="${escapeHtml(partner.uid)}">Ouvrir · ${escapeHtml(doc.name)}</button>`).join(' ')}</section>` : ''}`;
  byId('pr-partner-profile-dialog').showModal();
  $$('[data-contract-document]', byId('pr-partner-profile-content')).forEach((button) => button.addEventListener('click', () => openPartnerContractDocument(button.dataset.partnerUid, button.dataset.contractDocument)));
}
function syncAdminFilterOptions() {
  const partnerSelect = byId('pr-filter-partner'); const examSelect = byId('pr-filter-exam');
  if (partnerSelect) {
    const selected = partnerSelect.value;
    partnerSelect.innerHTML = '<option value="">Tous les partenaires</option>' + state.partners.map((partner) => `<option value="${escapeHtml(partner.uid)}">${escapeHtml(partner.name)}</option>`).join('');
    if (state.partners.some((partner) => partner.uid === selected)) partnerSelect.value = selected;
  }
  if (examSelect) {
    const selected = examSelect.value;
    const exams = [...new Map(state.results.filter((item) => item.examId).map((item) => [item.examId, item.examName || item.examId])).entries()].sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'fr'));
    examSelect.innerHTML = '<option value="">Tous les examens</option>' + exams.map(([id, name]) => `<option value="${escapeHtml(id)}">${escapeHtml(name)}</option>`).join('');
    if (exams.some(([id]) => id === selected)) examSelect.value = selected;
  }
  const reportSelect = byId('pr-report-partner');
  if (reportSelect) {
    const selected = reportSelect.value;
    reportSelect.innerHTML = '<option value="">Sélectionner un partenaire</option>' + state.partners.map((partner) => `<option value="${escapeHtml(partner.uid)}">${escapeHtml(partner.name)}</option>`).join('');
    if (state.partners.some((partner) => partner.uid === selected)) reportSelect.value = selected;
  }
}
async function loadPartnerReport(event) {
  event.preventDefault();
  const partnerUid = byId('pr-report-partner').value;
  if (!partnerUid) return showNotice('Sélectionnez un partenaire pour afficher son rapport.', 'error');
  const root = byId('pr-partner-report'); root.textContent = 'Calcul du rapport…';
  try {
    const response = await call('healthAdminGetResultsPartnerReport', { query: { partnerUid } }); const report = response.report || {};
    const metrics = [
      ['Commandes affectées', report.ordersAssigned], ['Examens réalisés', report.examsPerformed], ['Non réalisés', report.examsNotPerformed],
      ['Corrections en attente', report.correctionsPending], ['Validés, non transférés', report.examsValidated], ['Examens payés', report.examsPaid],
      ['Montant payé', `${Number(report.amountPaidHTG || 0).toLocaleString('fr-HT')} HTG`], ['Montant dû', `${Number(report.amountDueHTG || 0).toLocaleString('fr-HT')} HTG`]
    ];
    root.innerHTML = `<strong>${escapeHtml(report.partnerName)}</strong><div class="pr-metrics">${metrics.map(([label, value]) => `<div class="pr-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong></div>`).join('')}</div>`;
  } catch (error) { root.textContent = error.message || 'Rapport indisponible.'; }
}
function syncRequirementCategories() {
  const type = byId('pr-req-type').value;
  $$('[data-req-type]').forEach((label) => { label.hidden = label.dataset.reqType !== type; if (label.hidden) $('input', label).checked = false; });
  const supplemental = byId('pr-requirements-form').querySelector('input[name="requiredCategories"][value="SUPPLEMENTAL"]');
  supplemental.disabled = !byId('pr-requirements-form').elements.allowSupplemental.checked;
  if (supplemental.disabled) supplemental.checked = false;
}
async function loadAdminRequirements() {
  try {
    const response = await call('healthAdminListResultRequirements'); const items = response.requirements || [];
    byId('pr-requirements-list').innerHTML = items.length ? items.map((item) => `<div class="pr-list-item"><strong>${escapeHtml(item.examName)}</strong><small>${item.providerType === 'imaging' ? 'Imagerie' : 'Laboratoire'} · ${escapeHtml(item.examId)}</small><p>Pièces requises : ${escapeHtml((item.requiredCategories || []).join(', '))} · ${(item.allowedMimeTypes || []).map((mime) => ({ 'application/pdf': 'PDF', 'image/jpeg': 'JPG', 'image/png': 'PNG' }[mime] || mime)).join(', ')} · ${item.maxFiles} fichiers max. · ${Math.ceil(Number(item.maxFileBytes || 0) / 1048576)} Mo max.</p><button type="button" class="pr-quiet" data-edit-requirement="${escapeHtml(item.id)}">Modifier</button></div>`).join('') : '<p>Aucun réglage spécifique. Les exigences par défaut du laboratoire ou de l’imagerie s’appliquent.</p>';
    $$('[data-edit-requirement]').forEach((button) => button.addEventListener('click', () => {
      const item = items.find((entry) => entry.id === button.dataset.editRequirement); if (!item) return;
      const form = byId('pr-requirements-form'); form.elements.providerType.value = item.providerType; syncRequirementCategories(); form.elements.examId.value = item.examId; form.elements.examName.value = item.examName; form.elements.maxFiles.value = item.maxFiles || 10; form.elements.maxFileBytesMb.value = Math.ceil(Number(item.maxFileBytes || 15 * 1024 * 1024) / 1048576); form.elements.allowSupplemental.checked = item.allowSupplemental === true; syncRequirementCategories(); form.elements.allowMultiplePerCategory.checked = item.allowMultiplePerCategory !== false;
      $$('input[name="allowedMimeTypes"]', form).forEach((input) => { input.checked = (item.allowedMimeTypes || ['application/pdf', 'image/jpeg', 'image/png']).includes(input.value); });
      $$('input[name="requiredCategories"]', form).forEach((input) => { input.checked = (item.requiredCategories || []).includes(input.value); }); form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }));
  } catch (error) { showNotice(error.message, 'error'); }
}
async function saveRequirements(event) {
  event.preventDefault(); const form = event.currentTarget; const values = new FormData(form);
  const payload = { providerType: values.get('providerType'), examId: values.get('examId'), examName: values.get('examName'), requiredCategories: values.getAll('requiredCategories'), allowedMimeTypes: values.getAll('allowedMimeTypes'), maxFiles: Number(values.get('maxFiles')), maxFileBytes: Number(values.get('maxFileBytesMb')) * 1048576, allowSupplemental: form.elements.allowSupplemental.checked, allowMultiplePerCategory: form.elements.allowMultiplePerCategory.checked };
  try { await call('healthAdminSaveResultRequirements', { method: 'POST', body: payload }); showStatus('pr-requirements-status', 'Exigences enregistrées pour cet examen.', 'success'); form.reset(); syncRequirementCategories(); await loadAdminRequirements(); } catch (error) { showStatus('pr-requirements-status', error.message, 'error'); }
}
async function resetPartner(uid) {
  if (!confirm('Générer un mot de passe temporaire ? Il ne sera affiché qu’une fois.')) return;
  try { const response = await call('healthAdminResetResultsPartnerAccess', { method: 'POST', body: { uid } }); byId('pr-created-credentials').innerHTML = `<div class="pr-summary"><b>Identifiant</b>: ${escapeHtml(response.partnerId)}<br><b>Mot de passe temporaire</b>: <code>${escapeHtml(response.temporaryPassword)}</code><p>Transmettez-le directement au partenaire par un canal sûr.</p></div>`; } catch (error) { showNotice(error.message, 'error'); }
}
async function updatePartnerStatus(uid, status) {
  const label = status === 'disabled' ? 'désactivation' : 'suspension';
  const reason = status === 'active' ? '' : prompt(`Motif de ${label} (minimum 5 caractères) :`); if (status !== 'active' && (!reason || reason.trim().length < 5)) return;
  try { await call('healthAdminSetResultsPartnerStatus', { method: 'POST', body: { uid, status, reason } }); await loadAdminPartners(); } catch (error) { showNotice(error.message, 'error'); }
}
const legacyPartnerDays = [['monday', 'Lundi'], ['tuesday', 'Mardi'], ['wednesday', 'Mercredi'], ['thursday', 'Jeudi'], ['friday', 'Vendredi'], ['saturday', 'Samedi'], ['sunday', 'Dimanche']];
const legacyPhoneCountryCodes = ['+509', '+1', '+33', '+44', '+34', '+55', '+57', '+590', '+596'];
function legacyAddPartnerPhone(value = '') {
  const root = byId('pr-partner-phone-list'); const countryCode = phoneCountryCodes.find((code) => value.startsWith(code)) || '+509';
  const number = value.startsWith(countryCode) ? value.slice(countryCode.length).trim() : value; const row = document.createElement('div'); row.className = 'pr-phone-row';
  const country = document.createElement('select'); country.setAttribute('aria-label', 'Indicatif pays'); phoneCountryCodes.forEach((code) => country.add(new Option(code, code, false, code === countryCode)));
  const input = document.createElement('input'); input.type = 'tel'; input.name = 'phoneNumbers'; input.autocomplete = 'tel'; input.maxLength = 30; input.placeholder = 'Numéro de téléphone'; input.value = number; input.required = !root.children.length;
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'pr-icon-remove'; remove.setAttribute('aria-label', 'Supprimer ce numéro'); remove.textContent = '♜';
  remove.addEventListener('click', () => { if (root.children.length > 1) row.remove(); }); row.append(country, input, remove); root.append(row);
}
function legacyAddPartnerHourInterval(day, interval = { open: '08:00', close: '17:00' }) {
  const root = byId('pr-hours-' + day); if (!root) return; const row = document.createElement('div'); row.className = 'pr-hour-row';
  const open = document.createElement('input'); open.type = 'time'; open.dataset.hourOpen = ''; open.setAttribute('aria-label', 'Heure d’ouverture ' + day); open.value = interval.open || '';
  const separator = document.createElement('span'); separator.textContent = 'à';
  const close = document.createElement('input'); close.type = 'time'; close.dataset.hourClose = ''; close.setAttribute('aria-label', 'Heure de fermeture ' + day); close.value = interval.close || '';
  const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'pr-icon-remove'; remove.setAttribute('aria-label', 'Supprimer cette plage horaire'); remove.textContent = '♜'; remove.addEventListener('click', () => { if (root.children.length > 1) row.remove(); });
  row.append(open, separator, close, remove); root.append(row);
}
function legacyInitializePartnerSchedule() {
  const daysRoot = byId('pr-partner-days'); const hoursRoot = byId('pr-partner-hours'); if (!daysRoot || !hoursRoot || daysRoot.children.length) return;
  daysRoot.innerHTML = partnerDays.map(([day, label]) => '<label class="pr-day-chip"><input type="checkbox" name="day-' + day + '" checked><span>' + label + '</span></label>').join('');
  hoursRoot.innerHTML = partnerDays.map(([day, label]) => '<section class="pr-day-hours"><label class="pr-day-name"><input type="checkbox" name="hours-enabled-' + day + '" checked aria-label="Activer ' + label + '"><span>' + label + '</span></label><div class="pr-hour-intervals" id="pr-hours-' + day + '"></div><button type="button" class="pr-add-interval" data-add-interval="' + day + '" aria-label="Ajouter un horaire ' + label + '">＋</button></section>').join('');
  partnerDays.forEach(([day]) => addPartnerHourInterval(day));
  $$('[data-add-interval]').forEach((button) => button.addEventListener('click', () => addPartnerHourInterval(button.dataset.addInterval)));
  partnerDays.forEach(([day]) => { const dayInput = daysRoot.querySelector('[name="day-' + day + '"]'); const hourInput = hoursRoot.querySelector('[name="hours-enabled-' + day + '"]'); dayInput.addEventListener('change', () => { hourInput.checked = dayInput.checked; }); hourInput.addEventListener('change', () => { dayInput.checked = hourInput.checked; }); });
}
function resetPartnerFormExtras() {
  const phones = byId('pr-partner-phone-list'); phones.replaceChildren(); addPartnerPhone(); addPartnerPhone();
  byId('pr-partner-days').replaceChildren(); byId('pr-partner-hours').replaceChildren(); initializePartnerSchedule();
  byId('pr-created-date').value = 'Générée automatiquement'; byId('pr-created-credentials').replaceChildren();
  const form = byId('pr-create-partner'); form.querySelector('[name="services"][value="laboratory"]').checked = true; form.querySelector('[name="services"][value="imaging"]').checked = false; form.querySelector('[name="services"][value="mixed"]').checked = false; form.querySelector('[name="status"][value="active"]').checked = true; form.dataset.existingStatus = '';
}
function legacySetupPartnerForm() {
  initializePartnerSchedule(); addPartnerPhone(); addPartnerPhone();
  partnerDays.forEach(([day]) => ['open', 'close'].forEach((part) => { const name = part + '-' + day; if (!byId('pr-create-partner').elements[name]) { const input = document.createElement('input'); input.type = 'hidden'; input.name = name; byId('pr-create-partner').append(input); } }));
  byId('pr-add-partner-phone').addEventListener('click', () => addPartnerPhone());
  byId('pr-generate-partner-password').addEventListener('click', () => { const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%']; const alphabet = groups.join(''); const bytes = crypto.getRandomValues(new Uint32Array(24)); const chars = groups.map((group, index) => group[bytes[index] % group.length]); for (let index = groups.length; index < 24; index += 1) chars.push(alphabet[bytes[index] % alphabet.length]); for (let index = chars.length - 1; index > 0; index -= 1) { const swap = bytes[index] % (index + 1); [chars[index], chars[swap]] = [chars[swap], chars[index]]; } const input = byId('pr-create-partner').elements.initialPassword; input.value = chars.join(''); input.type = 'text'; input.focus(); });
  $('.pr-password-reveal').addEventListener('click', () => { const input = byId('pr-create-partner').elements.initialPassword; input.type = input.type === 'password' ? 'text' : 'password'; });
  $$('input[name="services"]', byId('pr-create-partner')).forEach((input) => input.addEventListener('change', () => { const mixed = byId('pr-create-partner').querySelector('[name="services"][value="mixed"]'); if (input.value === 'mixed' && input.checked) $$('input[name="services"]', byId('pr-create-partner')).filter((item) => item !== mixed).forEach((item) => { item.checked = false; }); else if (input.checked) mixed.checked = false; }));
  byId('pr-cancel-partner-create').addEventListener('click', () => byId('pr-nav').querySelector('[data-module-target="admin-partners"]')?.click());
}
const partnerDays = [['monday', 'Lundi'], ['tuesday', 'Mardi'], ['wednesday', 'Mercredi'], ['thursday', 'Jeudi'], ['friday', 'Vendredi'], ['saturday', 'Samedi'], ['sunday', 'Dimanche']];
const phoneCountryCodes = ['+509', '+1', '+33', '+44', '+34', '+55', '+57', '+590', '+596'];
const phoneCountryLabels = { '+509': '🇭🇹 +509', '+1': '🇺🇸 +1', '+33': '🇫🇷 +33', '+44': '🇬🇧 +44', '+34': '🇪🇸 +34', '+55': '🇧🇷 +55', '+57': '🇨🇴 +57', '+590': '🇬🇵 +590', '+596': '🇲🇶 +596' };
function addPartnerPhone(value = '') {
  const root = byId('pr-partner-phone-list'); const countryCode = phoneCountryCodes.find((code) => value.startsWith(code)) || '+509';
  const number = value.startsWith(countryCode) ? value.slice(countryCode.length).trim() : value; const row = document.createElement('div'); row.className = 'pr-phone-row';
  row.innerHTML = `<label class="pr-phone-country"><span class="pr-sr-only">Indicatif pays</span><select aria-label="Indicatif pays">${phoneCountryCodes.map((code) => `<option value="${code}"${code === countryCode ? ' selected' : ''}>${phoneCountryLabels[code]}</option>`).join('')}</select></label><label class="pr-phone-number"><span class="pr-sr-only">Numéro de téléphone</span><input type="tel" name="phoneNumbers" autocomplete="tel" maxlength="30" placeholder="Numéro de téléphone" value="${escapeHtml(number)}" ${root.children.length ? '' : 'required'}></label><button type="button" class="pr-icon-remove" aria-label="Supprimer ce numéro">♜</button>`;
  row.querySelector('.pr-icon-remove').addEventListener('click', () => { if (root.children.length > 1) row.remove(); }); root.append(row);
}
function addPartnerHourInterval(day, interval = { open: '08:00', close: '17:00' }) {
  const root = byId(`pr-hours-${day}`); if (!root) return; const row = document.createElement('div'); row.className = 'pr-hour-row';
  row.innerHTML = `<input type="time" data-hour-open aria-label="Heure d’ouverture ${day}" value="${escapeHtml(interval.open || '')}"><span>à</span><input type="time" data-hour-close aria-label="Heure de fermeture ${day}" value="${escapeHtml(interval.close || '')}"><button type="button" class="pr-icon-remove" aria-label="Supprimer cette plage horaire">♜</button>`;
  row.querySelector('.pr-icon-remove').addEventListener('click', () => { if (root.children.length > 1) row.remove(); }); root.append(row);
}
function initializePartnerSchedule() {
  const daysRoot = byId('pr-partner-days'); const hoursRoot = byId('pr-partner-hours'); if (!daysRoot || !hoursRoot || daysRoot.children.length) return;
  daysRoot.innerHTML = partnerDays.map(([day, label]) => `<label class="pr-day-chip"><input type="checkbox" name="day-${day}" checked><span>${label}</span></label>`).join('');
  hoursRoot.innerHTML = partnerDays.map(([day, label]) => `<section class="pr-day-hours" data-day-hours="${day}"><label class="pr-day-name"><input type="checkbox" name="hours-enabled-${day}" checked aria-label="Activer ${label}"><span>${label}</span></label><div class="pr-hour-intervals" id="pr-hours-${day}"></div><button type="button" class="pr-add-interval" data-add-interval="${day}" aria-label="Ajouter un horaire ${label}">＋</button></section>`).join('');
  partnerDays.forEach(([day]) => addPartnerHourInterval(day));
  $$('[data-add-interval]').forEach((button) => button.addEventListener('click', () => addPartnerHourInterval(button.dataset.addInterval)));
  partnerDays.forEach(([day]) => { const days = daysRoot.querySelector(`[name="day-${day}"]`); const hours = hoursRoot.querySelector(`[name="hours-enabled-${day}"]`); days.addEventListener('change', () => { hours.checked = days.checked; }); hours.addEventListener('change', () => { days.checked = hours.checked; }); });
}
function setupPartnerForm() {
  initializePartnerSchedule(); addPartnerPhone(); addPartnerPhone();
  byId('pr-add-partner-phone').addEventListener('click', () => addPartnerPhone());
  byId('pr-generate-partner-password').addEventListener('click', () => { const groups = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnopqrstuvwxyz', '23456789', '!@#$%']; const alphabet = groups.join(''); const bytes = crypto.getRandomValues(new Uint32Array(24)); const chars = groups.map((group, index) => group[bytes[index] % group.length]); for (let index = groups.length; index < 24; index += 1) chars.push(alphabet[bytes[index] % alphabet.length]); for (let index = chars.length - 1; index > 0; index -= 1) { const swap = bytes[index] % (index + 1); [chars[index], chars[swap]] = [chars[swap], chars[index]]; } const input = byId('pr-create-partner').elements.initialPassword; input.value = chars.join(''); input.type = 'text'; input.focus(); });
  $('.pr-password-reveal').addEventListener('click', (event) => { const input = byId('pr-create-partner').elements.initialPassword; input.type = input.type === 'password' ? 'text' : 'password'; event.currentTarget.setAttribute('aria-label', input.type === 'password' ? 'Afficher le mot de passe' : 'Masquer le mot de passe'); });
  $$('input[name="services"]', byId('pr-create-partner')).forEach((input) => input.addEventListener('change', () => { const mixed = $('#pr-create-partner [name="services"][value="mixed"]'); if (input.value === 'mixed' && input.checked) $$('input[name="services"]', byId('pr-create-partner')).filter((item) => item !== mixed).forEach((item) => { item.checked = false; }); else if (input.checked) mixed.checked = false; }));
  byId('pr-cancel-partner-create').addEventListener('click', () => byId('pr-nav').querySelector('[data-module-target="admin-partners"]')?.click());
}
function populatePartnerFormExtras(partner, form) {
  const phoneList = byId('pr-partner-phone-list'); phoneList.replaceChildren(); (partner.phones || []).slice(0, 10).forEach((phone) => addPartnerPhone(phone)); if (!phoneList.children.length) addPartnerPhone();
  const selected = partner.services || (partner.providerType === 'mixed' ? ['laboratory', 'imaging'] : [partner.providerType]);
  $$('input[name="services"]', form).forEach((input) => { input.checked = input.value === 'mixed' ? selected.includes('laboratory') && selected.includes('imaging') : selected.includes(input.value) && selected.length < 2; });
  const status = form.querySelector('[name="status"][value="' + (partner.status || 'active') + '"]'); if (status) status.checked = true;
  form.dataset.existingStatus = partner.status || 'active'; byId('pr-partner-days').replaceChildren(); byId('pr-partner-hours').replaceChildren(); initializePartnerSchedule();
  partnerDays.forEach(([day]) => { const hours = partner.openingHours?.[day] || {}; const enabled = hours.enabled === true; form.querySelector('[name="day-' + day + '"]').checked = enabled; form.querySelector('[name="hours-enabled-' + day + '"]').checked = enabled; const root = byId('pr-hours-' + day); root.replaceChildren(); const intervals = Array.isArray(hours.intervals) ? hours.intervals : hours.open && hours.close ? [{ open: hours.open, close: hours.close }] : []; (intervals.length ? intervals : [{ open: '08:00', close: '17:00' }]).forEach((interval) => addPartnerHourInterval(day, interval)); });
  byId('pr-created-date').value = partner.createdAt ? new Date(partner.createdAt).toLocaleDateString('fr-HT') : 'Générée automatiquement';
}
async function createPartner(event) {
  event.preventDefault(); const htmlForm = event.currentTarget; const form = new FormData(htmlForm); const contractFiles = form.getAll('contractDocuments').filter((file) => file instanceof File && file.size); const services = form.getAll('services');
  if (!services.length) return showStatus('pr-create-status', 'Sélectionnez au moins un service autorisé.', 'error');
  const phoneNumbers = $$('#pr-partner-phone-list .pr-phone-row').map((row) => `${row.querySelector('select').value} ${row.querySelector('input').value.trim()}`).filter((value) => !/^\+\d+\s*$/.test(value));
  if (!phoneNumbers.length) return showStatus('pr-create-status', 'Ajoutez au moins un numéro de téléphone.', 'error');
  const status = form.get('status') || 'active'; let reason = '';
  if (status !== 'active' && status !== htmlForm.dataset.existingStatus) { reason = prompt(`Motif de ${status === 'disabled' ? 'désactivation' : 'suspension'} du partenaire (minimum 5 caractères) :`) || ''; if (reason.trim().length < 5) return showStatus('pr-create-status', 'Un motif d’au moins 5 caractères est requis pour un compte suspendu ou désactivé.', 'error'); }
  const payload = Object.fromEntries([...form.entries()].filter(([key]) => !['contractDocuments', 'services', 'status', 'initialPassword'].includes(key) && !key.startsWith('day-') && !key.startsWith('hours-enabled-')));
  payload.phones = phoneNumbers.slice(0, 10); payload.phone = phoneNumbers[0]; payload.services = services.includes('mixed') ? ['laboratory', 'imaging'] : services; payload.providerType = payload.services.length > 1 ? 'mixed' : payload.services[0]; payload.status = status; payload.reason = reason.trim();
  const initialPassword = String(form.get('initialPassword') || '');
  if (initialPassword && (initialPassword.length < 12 || !/[a-z]/.test(initialPassword) || !/[A-Z]/.test(initialPassword) || !/\d/.test(initialPassword) || !/[^A-Za-z0-9]/.test(initialPassword))) return showStatus('pr-create-status', 'Le mot de passe doit compter au moins 12 caractères avec minuscule, majuscule, chiffre et symbole.', 'error');
  if (initialPassword) payload.initialPassword = initialPassword; payload.openingHours = {};
  if (contractFiles.length > 20 || contractFiles.some((file) => file.size > 10 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type))) return showStatus('pr-create-status', 'Choisissez au plus 20 fichiers PDF/JPG/PNG de 10 Mo maximum chacun.', 'error');
  for (const [day, label] of partnerDays) { if (form.has(`day-${day}`) && form.has(`hours-enabled-${day}`)) { const intervals = $$(`#pr-hours-${day} .pr-hour-row`).map((row) => ({ open: row.querySelector('[data-hour-open]').value, close: row.querySelector('[data-hour-close]').value })).filter((item) => item.open && item.close); if (!intervals.length) return showStatus('pr-create-status', `Indiquez au moins une plage horaire valide pour ${label}.`, 'error'); payload.openingHours[day] = { enabled: true, open: intervals[0].open, close: intervals.at(-1).close, intervals }; } else payload.openingHours[day] = { enabled: false, intervals: [] }; }
  try {
    const saveButton = byId('pr-save-partner'); saveButton.disabled = true; saveButton.textContent = payload.uid ? 'Enregistrement…' : 'Création…';
    const response = await call('healthAdminCreateResultsPartner', { method: 'POST', body: payload });
    const partnerUid = response.partner.uid;
    if (contractFiles.length) {
      showStatus('pr-create-status', `Profil enregistré. Téléversement de ${contractFiles.length} justificatif(s)…`);
      const documents = [];
      for (const file of contractFiles) {
        const id = crypto.randomUUID(); const storagePath = `health-partner-contracts/${state.user.uid}__${partnerUid}/${id}`;
        await uploadBytes(storageRef(storage, storagePath), file, { contentType: file.type, customMetadata: { uploadedByUid: state.user.uid, partnerUid } });
        documents.push({ id, storagePath, name: file.name });
      }
      await call('healthAdminSaveResultsPartnerContractDocuments', { method: 'POST', body: { uid: partnerUid, documents } });
    }
    showStatus('pr-create-status', `${payload.uid ? 'Profil partenaire modifié.' : 'Compte partenaire créé.'}${contractFiles.length ? ` ${contractFiles.length} justificatif(s) privé(s) ajouté(s).` : ''}`, 'success');
    byId('pr-created-credentials').innerHTML = `<div class="pr-summary"><b>ID Partenaire</b>: ${escapeHtml(response.partner.partnerId || '—')}${response.partner.temporaryPassword ? `<br><b>Mot de passe temporaire</b>: <code>${escapeHtml(response.partner.temporaryPassword)}</code><p>Copiez-le maintenant et remettez-le au partenaire par un canal sûr.</p>` : ''}</div>`;
    htmlForm.reset(); htmlForm.elements.uid.value = ''; byId('pr-partner-form-title').textContent = 'Créer un partenaire'; resetPartnerFormExtras(); await loadAdminPartners();
  } catch (error) { showStatus('pr-create-status', error.message, 'error'); }
  finally { const saveButton = byId('pr-save-partner'); saveButton.disabled = false; saveButton.innerHTML = '<span aria-hidden="true">▣</span> Créer le partenaire'; }
}
async function openPartnerContractDocument(uid, documentId) {
  const tab = window.open('', '_blank', 'noopener');
  try { const response = await call('healthAdminGetResultsPartnerContractDocumentUrl', { query: { uid, documentId } }); if (tab) tab.location = response.url; else window.location.assign(response.url); }
  catch (error) { tab?.close(); showNotice(error.message, 'error'); }
}
function editPartnerLegacy(uid) {
  const partner = state.partners.find((item) => item.uid === uid); if (!partner) return;
  const form = byId('pr-create-partner'); const fields = form.elements;
  for (const [name, value] of Object.entries({ uid, name: partner.name, responsibleName: partner.responsibleName, email: partner.email, phone: (partner.phones || [])[0] || '', phones: (partner.phones || []).slice(1).join(', '), address: partner.address, country: partner.country, department: partner.department, commune: partner.commune, taxId: partner.taxId, providerType: partner.providerType, additionalInformation: partner.additionalInformation, administrativeNotes: partner.administrativeNotes, contractPaths: (partner.contractPaths || []).join('\n') })) if (fields[name]) fields[name].value = value || '';
  for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) { const hours = partner.openingHours?.[day] || {}; fields[`day-${day}`].checked = hours.enabled === true; fields[`open-${day}`].value = hours.open || ''; fields[`close-${day}`].value = hours.close || ''; }
  populatePartnerFormExtras(partner, form);
  byId('pr-partner-form-title').textContent = `Modifier · ${partner.name}`; form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function editPartner(uid) {
  const partner = state.partners.find((item) => item.uid === uid); if (!partner) return;
  byId('pr-nav').querySelector('[data-module-target="admin-create-partner"]')?.click();
  const form = byId('pr-create-partner'); const fields = form.elements;
  for (const [name, value] of Object.entries({ uid, name: partner.name, responsibleName: partner.responsibleName, email: partner.email, address: partner.address, country: partner.country || 'Haïti', department: partner.department, commune: partner.commune, taxId: partner.taxId, additionalInformation: partner.additionalInformation, administrativeNotes: partner.administrativeNotes })) if (fields[name]) fields[name].value = value || '';
  if (fields.initialPassword) fields.initialPassword.value = '';
  populatePartnerFormExtras(partner, form); byId('pr-created-credentials').replaceChildren();
  byId('pr-partner-form-title').textContent = 'Modifier · ' + partner.name;
  byId('pr-save-partner').innerHTML = '<span aria-hidden="true">▣</span> Enregistrer les modifications';
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

byId('pr-login-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const id = byId('pr-login-id').value.trim(); const password = byId('pr-login-password').value;
  const email = id.includes('@') ? id.toLowerCase() : `${id.toLowerCase()}@partners.smartcuthealth.invalid`;
  try { showStatus('pr-login-status', 'Connexion…'); const credential = await signInWithEmailAndPassword(auth, email, password); await initUser(credential.user); }
  catch (error) { showStatus('pr-login-status', error.message || 'Connexion refusée.', 'error'); }
});
byId('pr-password-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const password = byId('pr-new-password').value;
  if (password !== byId('pr-confirm-password').value || password.length < 12 || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) { showStatus('pr-password-status', 'Utilisez au moins 12 caractères avec minuscule, majuscule, chiffre et symbole; les deux saisies doivent correspondre.', 'error'); return; }
  try { await call('healthPartnerCompletePasswordChange', { method: 'POST', body: { newPassword: password } }); await state.user.getIdToken(true); byId('pr-password-change').hidden = true; await initUser(state.user); }
  catch (error) { showStatus('pr-password-status', error.message || 'Mise à jour impossible. Reconnectez-vous puis réessayez.', 'error'); }
});
byId('pr-security-form').addEventListener('submit', async (event) => {
  event.preventDefault(); const form = event.currentTarget; const password = form.elements.password.value;
  if (password.length < 12 || password !== form.elements.confirmation.value || !/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password) || !/[^A-Za-z0-9]/.test(password)) return showStatus('pr-security-status', 'Utilisez au moins 12 caractères avec minuscule, majuscule, chiffre et symbole; les deux saisies doivent correspondre.', 'error');
  try { await call('healthPartnerCompletePasswordChange', { method: 'POST', body: { newPassword: password } }); await state.user.getIdToken(true); form.reset(); showStatus('pr-security-status', 'Mot de passe mis à jour.', 'success'); }
  catch (error) { showStatus('pr-security-status', error.message || 'Mise à jour impossible. Reconnectez-vous puis réessayez.', 'error'); }
});
byId('pr-lookup-form').addEventListener('submit', async (event) => { event.preventDefault(); byId('pr-upload-card').hidden = true; try { await doLookup(byId('pr-order-id').value.trim()); showNotice('Commande vérifiée. Confirmez les informations avant tout envoi.', 'success'); } catch (error) { showNotice(error.message, 'error'); } });
byId('pr-upload-form').addEventListener('submit', (event) => submitResult(event, 'partner'));
byId('pr-confirm-order').addEventListener('change', () => updateUploadReadiness('partner'));
byId('pr-internal-lookup-form').addEventListener('submit', async (event) => { event.preventDefault(); byId('pr-internal-upload-card').hidden = true; try { await doLookup(byId('pr-internal-order-id').value.trim(), 'smartcut-health'); showNotice('Commande interne identifiée. Vérifiez le patient et l’examen avant le dépôt.', 'success'); } catch (error) { showNotice(error.message, 'error'); } });
byId('pr-internal-upload-form').addEventListener('submit', (event) => submitResult(event, 'internal'));
byId('pr-internal-confirm-order').addEventListener('change', () => updateUploadReadiness('internal'));
byId('pr-refresh-results').addEventListener('click', loadAdminResults);
byId('pr-export-results').addEventListener('click', exportAdminResultsCsv);
byId('pr-export-settlements').addEventListener('click', exportAdminSettlementsCsv);
byId('pr-create-settlement').addEventListener('click', createPartnerSettlement);
byId('pr-overview-range').addEventListener('change', (event) => loadAdminOverview(Number(event.currentTarget.value)));
['pr-filter-partner', 'pr-filter-exam', 'pr-filter-status', 'pr-filter-type', 'pr-filter-payment', 'pr-filter-from', 'pr-filter-to'].forEach((id) => byId(id).addEventListener('change', () => loadAdminResults()));
byId('pr-filter-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadAdminResults(); } });
byId('pr-partner-search').addEventListener('input', () => { state.partnerPage = 1; renderAdminPartners(); });
['pr-partner-filter-type', 'pr-partner-filter-status', 'pr-partner-filter-commune'].forEach((id) => byId(id).addEventListener('change', () => { state.partnerPage = 1; renderAdminPartners(); }));
byId('pr-partner-filter-department').addEventListener('change', () => { syncPartnerLocationFilters(); state.partnerPage = 1; renderAdminPartners(); });
byId('pr-partner-reset-filters').addEventListener('click', () => { byId('pr-partner-search').value = ''; byId('pr-partner-filter-type').value = ''; byId('pr-partner-filter-status').value = ''; byId('pr-partner-filter-department').value = ''; syncPartnerLocationFilters(); byId('pr-partner-filter-commune').value = ''; state.partnerPage = 1; renderAdminPartners(); });
byId('pr-partner-page-size').addEventListener('change', () => { state.partnerPage = 1; renderAdminPartners(); });
byId('pr-partner-pages').addEventListener('click', (event) => { const button = event.target.closest('[data-partner-page]'); if (!button || button.disabled) return; state.partnerPage = Number(button.dataset.partnerPage); renderAdminPartners(); });
byId('pr-partners-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-partner-action]');
  if (!button) return;
  const { partnerUid, partnerAction, nextStatus } = button.dataset;
  button.closest('details')?.removeAttribute('open');
  if (partnerAction === 'profile') showPartnerProfile(partnerUid);
  if (partnerAction === 'edit') editPartner(partnerUid);
  if (partnerAction === 'services') editPartner(partnerUid);
  if (partnerAction === 'status') updatePartnerStatus(partnerUid, nextStatus);
  if (partnerAction === 'reset') resetPartner(partnerUid);
  if (partnerAction === 'results') {
    byId('pr-filter-partner').value = partnerUid;
    byId('pr-nav').querySelector('[data-module-target="admin-results"]')?.click();
  }
  if (partnerAction === 'report') {
    byId('pr-report-partner').value = partnerUid;
    byId('pr-nav').querySelector('[data-module-target="admin-reports"]')?.click();
    byId('pr-partner-report-form').requestSubmit();
  }
});
setupPartnerForm();
byId('pr-create-partner').addEventListener('submit', createPartner);
byId('pr-partner-report-form').addEventListener('submit', loadPartnerReport);
byId('pr-requirements-form').addEventListener('submit', saveRequirements);
byId('pr-requirements-form').elements.allowSupplemental.addEventListener('change', syncRequirementCategories);
const formatsFieldset = document.createElement('fieldset'); formatsFieldset.className = 'pr-category-options'; formatsFieldset.innerHTML = '<legend>Formats acceptés</legend><label><input type="checkbox" name="allowedMimeTypes" value="application/pdf" checked> PDF</label><label><input type="checkbox" name="allowedMimeTypes" value="image/jpeg" checked> JPG / JPEG</label><label><input type="checkbox" name="allowedMimeTypes" value="image/png" checked> PNG</label>'; byId('pr-requirements-form').insertBefore(formatsFieldset, byId('pr-requirements-form').querySelector('button'));
byId('pr-req-type').addEventListener('change', syncRequirementCategories); syncRequirementCategories();
$$('#pr-review-form [data-review]').forEach((button) => button.addEventListener('click', () => state.activeResult && reviewResult(state.activeResult.id, button.dataset.review)));
byId('pr-logout').addEventListener('click', () => signOut(auth));

await authReadyPromise;
if (auth.currentUser) await initUser(auth.currentUser);
