import { auth, authReadyPromise, storage } from './firebase-init.js';
import { getIdTokenResult, signInWithEmailAndPassword, signOut } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-auth.js';
import { ref as storageRef, uploadBytes } from 'https://www.gstatic.com/firebasejs/10.7.0/firebase-storage.js';

const PROJECT_ID = 'smartcutservices-9ce54';
const REGION = 'us-central1';
const API = `https://${REGION}-${PROJECT_ID}.cloudfunctions.net/`;
const byId = (id) => document.getElementById(id);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { user: null, token: null, mode: null, lookup: null, results: [], corrections: [], orders: [], partners: [], settlements: [], partnerAudit: [], adminAudit: [], activeResult: null, loginAuditRecorded: false, partnerAuditCursor: null, partnerAuditHasMore: false, adminAuditCursor: null, adminAuditHasMore: false, fileUrls: [], fileAddedAt: new WeakMap(), fileSelections: new WeakMap(), adminCursor: null, adminHasMore: false, partnerOrderCursor: null, partnerOrderHasMore: false, partnerResultCursor: null, partnerResultHasMore: false, correctionCursor: null, correctionsHasMore: false, settlementCursor: null, settlementsHasMore: false };
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
  byId('pr-title').textContent = mode === 'admin' ? 'Administration des résultats' : 'Espace partenaire';
  const adminSections = [['Vue d’ensemble', 'pr-admin-metrics'], ['Alertes & anomalies', 'pr-admin-alerts-panel'], ['Résultats reçus', 'pr-admin-results-panel'], ['Examens internes', 'pr-internal-lookup-form'], ['Partenaires', 'pr-partners-list'], ['Paiements prestataires', 'pr-settlements-list'], ['Historique & audit', 'pr-audit-list'], ['Paramètres des fichiers', 'pr-requirements-form']];
  const partnerSections = [['Commandes à traiter', 'pr-lookup-form'], ['Résultats déposés', 'pr-own-results'], ['Corrections demandées', 'pr-corrections-panel'], ['Historique', 'pr-partner-audit-panel'], ['Profil / sécurité', 'pr-partner-profile-panel']];
  const sections = mode === 'admin' ? adminSections : partnerSections;
  byId('pr-nav').innerHTML = sections.map(([label, target], index) => `<button type="button" class="${index === 0 ? 'active' : ''}" data-target="${target}">${label}</button>`).join('');
  $$('#pr-nav button').forEach((button) => button.addEventListener('click', () => {
    $$('#pr-nav button').forEach((item) => item.classList.toggle('active', item === button));
    byId(button.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}
async function initUser(user) {
  state.user = user;
  if (!user) { state.loginAuditRecorded = false; byId('pr-login').hidden = false; byId('pr-app').hidden = true; byId('pr-password-change').hidden = true; byId('pr-user').hidden = true; return; }
  const token = await getIdTokenResult(user, true); state.token = token;
  if (!state.loginAuditRecorded) {
    try { await call('healthPartnerRecordPortalLogin', { method: 'POST', body: {} }); state.loginAuditRecorded = true; }
    catch (error) { showNotice(`Connexion active, mais l’audit de connexion n’a pas pu être enregistré : ${error.message}`, 'error'); }
  }
  if (token.claims.healthPartnerMustChangePassword) { byId('pr-login').hidden = true; byId('pr-app').hidden = true; byId('pr-password-change').hidden = false; return; }
  const partnerLogin = String(user.email || '').endsWith('@partners.smartcuthealth.invalid') || token.claims.healthPartner === true;
  state.role = token.claims.role || token.claims.platformRole || '';
  setMode(partnerLogin ? 'partner' : 'admin');
  byId('pr-identity').textContent = partnerLogin ? `Compte partenaire · ${token.claims.healthPartnerId || user.uid}` : 'Smart Cut Health · Administration';
  if (partnerLogin) { await Promise.all([loadPartnerOrders(), loadPartnerResults(), loadPartnerCorrections(), loadPartnerAudit(), loadPartnerOverview()]); }
  else { await Promise.all([loadAdminOverview(), loadAdminResults(), loadAdminPartners(), loadAdminRequirements(), loadAdminSettlements(), loadAdminAudit(), loadAdminAlerts()]); }
}
async function loadAdminOverview() {
  try {
    const response = await call('healthAdminGetPartnerResultsOverview'); const data = response.overview || {};
    const metrics = [
      ['Partenaires actifs', data.activePartners], ['Laboratoires actifs', data.activeLaboratories], ['Centres d’imagerie actifs', data.activeImagingCenters],
      ['Commandes affectées aujourd’hui', data.assignedToday], ['Commandes sans résultat aujourd’hui', data.ordersAwaitingResultToday], ['Résultats reçus aujourd’hui', data.resultsReceivedToday], ['Résultats à contrôler', data.awaitingReview],
      ['Corrections en attente', data.correctionsPending], ['Examens validés / réalisés', data.examsValidatedAsPerformed], ['Examens non réalisés', data.examsNotPerformed],
      ['Montant externe à payer', `${Number(data.amountDueHTG || 0).toLocaleString('fr-HT')} HTG`], ['Montant déjà payé', `${Number(data.amountPaidHTG || 0).toLocaleString('fr-HT')} HTG`]
    ];
    byId('pr-admin-metrics').innerHTML = metrics.map(([label, value]) => `<div class="pr-metric"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 0)}</strong></div>`).join('');
  } catch (error) { showNotice(error.message, 'error'); }
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
    const response = await call('healthAdminListResultsPartners'); state.partners = response.partners || [];
    syncAdminFilterOptions();
    byId('pr-partners-list').innerHTML = state.partners.length ? state.partners.map((partner) => {
      const actions = partner.status === 'active'
        ? `<button class="pr-quiet" data-toggle-partner="${escapeHtml(partner.uid)}" data-next-status="suspended">Suspendre</button> <button class="pr-quiet" data-toggle-partner="${escapeHtml(partner.uid)}" data-next-status="disabled">Désactiver</button>`
        : `<button class="pr-quiet" data-toggle-partner="${escapeHtml(partner.uid)}" data-next-status="active">Réactiver</button>`;
      return `<div class="pr-list-item"><strong>${escapeHtml(partner.name)}</strong><small>${escapeHtml(partner.providerType || (partner.services || []).join(' / '))} · ${escapeHtml(partner.status)} · ${escapeHtml(partner.partnerId || partner.uid)}</small><p>${escapeHtml((partner.phones || []).join(' · '))} · ${escapeHtml(partner.address)} · ${escapeHtml([partner.commune, partner.department, partner.country].filter(Boolean).join(', '))}</p>${(partner.contractDocuments || []).length ? `<p><strong>Documents :</strong> ${(partner.contractDocuments || []).map((doc) => `<button type="button" class="pr-quiet" data-contract-document="${escapeHtml(doc.id)}" data-partner-uid="${escapeHtml(partner.uid)}">Ouvrir · ${escapeHtml(doc.name)}</button>`).join(' ')}</p>` : '<p>Aucun justificatif joint.</p>'}<button class="pr-quiet" data-edit-partner="${escapeHtml(partner.uid)}">Modifier</button> <button class="pr-quiet" data-reset-partner="${escapeHtml(partner.uid)}" ${partner.status !== 'active' ? 'disabled title="Réactivez le compte avant de réinitialiser l’accès"' : ''}>Réinitialiser l’accès</button> ${actions}</div>`;
    }).join('') : '<p>Aucun partenaire inscrit.</p>';
    $$('[data-reset-partner]').forEach((button) => button.addEventListener('click', () => resetPartner(button.dataset.resetPartner)));
    $$('[data-toggle-partner]').forEach((button) => button.addEventListener('click', () => updatePartnerStatus(button.dataset.togglePartner, button.dataset.nextStatus)));
    $$('[data-edit-partner]').forEach((button) => button.addEventListener('click', () => editPartner(button.dataset.editPartner)));
    $$('[data-contract-document]').forEach((button) => button.addEventListener('click', () => openPartnerContractDocument(button.dataset.partnerUid, button.dataset.contractDocument)));
  } catch (error) { showNotice(error.message, 'error'); }
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
async function createPartner(event) {
  event.preventDefault(); const htmlForm = event.currentTarget; const form = new FormData(htmlForm); const contractFiles = form.getAll('contractDocuments').filter((file) => file instanceof File && file.size); const payload = Object.fromEntries([...form.entries()].filter(([key]) => key !== 'contractDocuments')); payload.phones = String(payload.phones || '').split(',').map((item) => item.trim()).filter(Boolean); payload.openingHours = {};
  if (contractFiles.length > 20 || contractFiles.some((file) => file.size > 10 * 1024 * 1024 || !['application/pdf', 'image/jpeg', 'image/png'].includes(file.type))) return showStatus('pr-create-status', 'Choisissez au plus 20 fichiers PDF/JPG/PNG de 10 Mo maximum chacun.', 'error');
  for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) if (form.has(`day-${day}`)) payload.openingHours[day] = { enabled: true, open: String(form.get(`open-${day}`) || ''), close: String(form.get(`close-${day}`) || '') };
  for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) { delete payload[`day-${day}`]; delete payload[`open-${day}`]; delete payload[`close-${day}`]; }
  try {
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
    htmlForm.reset(); htmlForm.elements.uid.value = ''; byId('pr-partner-form-title').textContent = 'Créer un partenaire'; await loadAdminPartners();
  } catch (error) { showStatus('pr-create-status', error.message, 'error'); }
}
async function openPartnerContractDocument(uid, documentId) {
  const tab = window.open('', '_blank', 'noopener');
  try { const response = await call('healthAdminGetResultsPartnerContractDocumentUrl', { query: { uid, documentId } }); if (tab) tab.location = response.url; else window.location.assign(response.url); }
  catch (error) { tab?.close(); showNotice(error.message, 'error'); }
}
function editPartner(uid) {
  const partner = state.partners.find((item) => item.uid === uid); if (!partner) return;
  const form = byId('pr-create-partner'); const fields = form.elements;
  for (const [name, value] of Object.entries({ uid, name: partner.name, responsibleName: partner.responsibleName, email: partner.email, phone: (partner.phones || [])[0] || '', phones: (partner.phones || []).slice(1).join(', '), address: partner.address, country: partner.country, department: partner.department, commune: partner.commune, taxId: partner.taxId, providerType: partner.providerType, additionalInformation: partner.additionalInformation, administrativeNotes: partner.administrativeNotes, contractPaths: (partner.contractPaths || []).join('\n') })) if (fields[name]) fields[name].value = value || '';
  for (const day of ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']) { const hours = partner.openingHours?.[day] || {}; fields[`day-${day}`].checked = hours.enabled === true; fields[`open-${day}`].value = hours.open || ''; fields[`close-${day}`].value = hours.close || ''; }
  byId('pr-partner-form-title').textContent = `Modifier · ${partner.name}`; form.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
['pr-filter-partner', 'pr-filter-exam', 'pr-filter-status', 'pr-filter-type', 'pr-filter-payment', 'pr-filter-from', 'pr-filter-to'].forEach((id) => byId(id).addEventListener('change', () => loadAdminResults()));
byId('pr-filter-search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); loadAdminResults(); } });
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
