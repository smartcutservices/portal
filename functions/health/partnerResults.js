'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const { onRequest } = require('firebase-functions/v2/https');
const { defineString } = require('firebase-functions/params');
const { HttpError, requireBearerUser, withErrorHandling } = require('../smartsolutiontek/auth');
const { sanitizeText } = require('./lib/validation');
const { notifyUser } = require('./lib/healthNotify');
const { RESULT_STATUS, requiredCategories, validateResultFiles, canReviewResult, canTransferResult, adminViewedEveryResultFile, recordAdminResultFileView, isAuthorizedOrderDoctor, isAuthorizedResultDoctor, canDoctorReadRecordResults, isAuthorizedRecordDoctor, isEligiblePaidOrder, maskPatientName, isStrongPartnerPassword, matchesAdminResultFilters, countOrdersAwaitingResults, summarizePartnerResults, nextPartnerLookupAbuseAttempt } = require('./lib/partnerResultsWorkflow');
const { isManagedProviderId } = require('./lib/managedProvider');
const { isPayoutEligible, payoutTotals } = require('./lib/partnerResultPayoutWorkflow');
const { scanPartnerResultFile } = require('./lib/partnerResultsMalwareScan');
const { buildPartnerResultsTrend } = require('./lib/partnerResultsDashboard');

const HEALTH_RESULTS_SCANNER_URL = defineString('HEALTH_RESULTS_SCANNER_URL', { default: '' });

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_FILES = 20;
const MAX_CONTRACT_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CONTRACT_FILES = 20;
const ALLOWED_CONTRACT_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const ACTIVE_ORDER_STATUSES = new Set(['PAID', 'ACCEPTED', 'PROVIDER_ACCEPTED', 'PATIENT_PRESENTED', 'SAMPLE_COLLECTED', 'SAMPLE_RECEIVED', 'ANALYSIS_IN_PROGRESS', 'EXAM_COMPLETED', 'RESULT_PENDING_REVIEW', 'CORRECTION_REQUESTED']);
const ADMIN_ROLES = new Set(['super_admin', 'platform_admin', 'health_laboratory_admin', 'health_imaging_admin', 'admin_orders']);
const RESULTS_ADMIN_PERMISSIONS = new Set(['*', 'health.partner-results.*', 'partner-results.*', 'lab.orders.read', 'lab.orders.write', 'imaging.results.read', 'imaging.results.write']);

function buildPartnerResults(sst) {
  const { db, admin: adminSDK, REGION: region, verifyBearerUser: verifyBearer } = sst;
  const body = (req) => req.body && typeof req.body === 'object' ? req.body : {};
  const nowIso = () => new Date().toISOString();
  const clean = (value, max = 500) => sanitizeText(value, max);
  const audit = async (actorUid, action, resource, context = {}) => db.collection('healthAuditLogs').add({ actorUid, action, resource, context, createdAt: nowIso() });

  async function partner(user, providerType) {
    if (user.healthPartnerMustChangePassword === true) throw new HttpError(403, 'password-change-required', 'Changez le mot de passe temporaire pour accéder au portail.');
    const snap = await db.collection('clients').doc(user.uid).get();
    const profile = snap.data() || {};
    const role = String(profile.role || '').toLowerCase();
    const partnerProfile = profile.partnerProfile || profile.labProfile || profile.imagingProfile || {};
    const services = Array.isArray(profile.partnerServices) ? profile.partnerServices.map((value) => String(value).toLowerCase()) : [];
    const roleMatches = providerType === 'laboratory' ? ['laboratory', 'lab', 'health_partner'].includes(role) : ['imaging', 'health_partner'].includes(role);
    const serviceMatches = services.length === 0 || services.includes(providerType) || services.includes('mixed');
    const state = String(profile.partnerStatus || profile.labStatus || profile.imagingStatus || '').toLowerCase();
    if (!snap.exists || !roleMatches || !serviceMatches || !['active', 'verified', 'approved'].includes(state) || partnerProfile.active === false) {
      throw new HttpError(403, 'partner-account-inactive', 'Compte partenaire non autorisé ou suspendu.');
    }
    return { profile, partnerProfile, providerType };
  }

  async function loadResultsAdminProfile(user) {
    if (await sst.isAdminUser?.(user.uid)) return { role: 'super_admin', permissions: ['*'] };
    const snap = await db.collection('platformRoles').doc(user.uid).get();
    const data = snap.data() || {};
    const role = String(data.role || '').toLowerCase();
    const permissions = Array.isArray(data.permissions) ? data.permissions : [];
    const permitted = ADMIN_ROLES.has(role) || permissions.some((value) => RESULTS_ADMIN_PERMISSIONS.has(value));
    if (!snap.exists || String(data.status || '').toLowerCase() !== 'active' || !permitted) return null;
    return { ...data, role, permissions };
  }

  async function hasResultsAdminAccess(user) {
    return Boolean(await loadResultsAdminProfile(user));
  }

  async function authorizeAdmin(user, write = false) {
    const profile = await loadResultsAdminProfile(user);
    if (!profile || (write && profile.role === 'support_agent')) {
      throw new HttpError(403, 'partner-results-admin-required', 'Accès administrateur au portail résultats requis.');
    }
    return profile;
  }

  async function recordDeniedPartnerLookup(user, orderId, reason, providerType = '') {
    let activePartner = false;
    for (const type of (providerType ? [providerType] : ['laboratory', 'imaging'])) {
      try { await partner(user, type); activePartner = true; break; } catch (_) {}
    }
    if (!activePartner) return;
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const windowKey = Math.floor(now / windowMs);
    const encodedUid = Buffer.from(user.uid).toString('base64url');
    const counterRef = db.collection('healthPartnerLookupAbuse').doc(encodedUid);
    const alertRef = db.collection('healthAdminAlerts').doc(`partner-lookup-${encodedUid}`);
    const timestamp = new Date(now).toISOString();
    await audit(user.uid, 'partner_order_lookup_denied', orderId ? `healthOrders/${orderId}` : 'healthOrders', { reason });
    await db.runTransaction(async (transaction) => {
      const counterSnap = await transaction.get(counterRef);
      const alertSnap = await transaction.get(alertRef);
      const previous = counterSnap.data() || {};
      const nextAttempt = nextPartnerLookupAbuseAttempt(previous, windowKey);
      const { attemptCount, shouldAlert } = nextAttempt;
      transaction.set(counterRef, { actorUid: user.uid, windowKey, windowStart: new Date(windowKey * windowMs).toISOString(), attemptCount, updatedAt: timestamp, alertCreated: nextAttempt.alertCreated }, { merge: true });
      if (shouldAlert) {
        const alertData = { module: 'health-partner-results', type: 'UNASSIGNED_ORDER_LOOKUP_PATTERN', status: 'OPEN', actorUid: user.uid, attemptCount, windowStart: new Date(windowKey * windowMs).toISOString(), updatedAt: timestamp, title: 'Tentatives répétées sur des commandes non attribuées' };
        if (alertSnap.exists && alertSnap.data()?.status !== 'RESOLVED') transaction.update(alertRef, { attemptCount, lastWindowStart: alertData.windowStart, updatedAt: timestamp });
        else transaction.set(alertRef, { ...alertData, createdAt: timestamp, resolutionReason: null, resolvedByUid: null, resolvedAt: null });
      }
    });
  }

  async function loadOrder(orderId) {
    const ref = db.collection('healthOrders').doc(orderId);
    const snap = await ref.get();
    if (!snap.exists) return null;
    const order = snap.data() || {};
    const providerType = order.kind === 'laboratory_exam' && order.providerType === 'laboratory' ? 'laboratory' : order.kind === 'imaging' && order.providerType === 'imaging' ? 'imaging' : null;
    return providerType ? { ref, order: { id: snap.id, ...order }, providerType } : null;
  }

  function orderLines(order) {
    const lines = (Array.isArray(order.items) ? order.items : []).map((item, index) => ({
      ...item,
      resultLineId: clean(item.resultLineId || item.lineId || item.id || item.orderItemId || (order.id ? `${order.id}_${index + 1}` : `line_${index}`), 200),
      resultExamId: clean(item.examId || item.catalogExamId || item.normalizedExamId || item.offerId, 200),
      resultExamName: clean(item.name || item.examName, 180) || 'Examen médical'
    }));
    if (lines.length) return lines;
    return [{ resultLineId: clean(order.examId || order.orderItemId || 'primary', 200), resultExamId: clean(order.examId || order.catalogExamId, 200), resultExamName: clean(order.examName || order.name, 180) || 'Examen médical' }];
  }

  function orderLine(order, examLineId) {
    const lines = orderLines(order);
    if (!examLineId && lines.length === 1) return lines[0];
    return lines.find((line) => line.resultLineId === examLineId) || null;
  }

  function orderExamName(order, examLineId) {
    const item = orderLine(order, examLineId) || {};
    return clean(item.resultExamName || order.examName || item.name || order.name, 180) || 'Examen médical';
  }

  function orderExamId(order, examLineId) {
    const item = orderLine(order, examLineId) || {};
    return item.resultExamId || clean(order.examId || order.catalogExamId, 200);
  }

  async function resultRequirements(order, providerType, line) {
    const itemConfig = line?.resultRequirements;
    if (itemConfig && Array.isArray(itemConfig.requiredCategories) && itemConfig.requiredCategories.length) return itemConfig;
    const orderConfig = order.resultRequirements;
    if (orderConfig && Array.isArray(orderConfig.requiredCategories) && orderConfig.requiredCategories.length) return orderConfig;
    const examId = line?.resultExamId || order.examId || order.catalogExamId || 'default';
    const key = `${providerType}_${Buffer.from(String(examId)).toString('base64url')}`;
    const settings = await db.collection('healthResultRequirements').doc(key).get();
    return settings.exists ? settings.data() : { requiredCategories: requiredCategories(order, providerType) };
  }

  async function safePatientLabel(uid) {
    const snap = await db.collection('clients').doc(uid).get();
    const data = snap.data() || {};
    const profile = data.profile || data.patientProfile || data;
    return maskPatientName({ firstName: profile.firstName || profile.prenom, lastName: profile.lastName || profile.nom });
  }

  function publicResult(doc) {
    const value = doc.data ? doc.data() : doc;
    const { files = [], ...metadata } = value || {};
    return { ...metadata, files: files.map(({ storagePath, md5Hash, ...file }) => file) };
  }

  const healthPartnerListOrders = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const requestedType = clean(req.query?.providerType, 40).toLowerCase();
    const types = requestedType ? [requestedType] : ['laboratory', 'imaging'];
    const cursor = clean(req.query?.cursor, 200);
    let partnerIdentity = null;
    const allowedTypes = [];
    for (const type of types) {
      if (!['laboratory', 'imaging'].includes(type)) continue;
      let access;
      try { access = await partner(user, type); } catch (_) { continue; }
      allowedTypes.push(type);
      const p = access.partnerProfile || {};
      partnerIdentity = { name: p.businessName || access.profile.displayName || user.uid, partnerId: access.profile.partnerId || access.profile.partnerProfile?.partnerId || null, providerType: access.profile.partnerType || access.profile.role, address: p.address || '', commune: p.commune || '', department: p.department || '', phones: p.phones || [access.profile.phone].filter(Boolean), email: p.email || access.profile.email || '', status: access.profile.partnerStatus || access.profile.labStatus || access.profile.imagingStatus || '', services: access.profile.partnerServices || p.services || [], openingHours: p.openingHours || {}, additionalInformation: p.additionalInformation || '' };
    }
    if (!allowedTypes.length) throw new HttpError(403, 'partner-account-inactive', 'Compte partenaire non autorisé ou suspendu.');
    let query = db.collection('healthOrders').where('providerUid', '==', user.uid).orderBy(adminSDK.firestore.FieldPath.documentId());
    if (cursor) {
      const cursorDoc = await db.collection('healthOrders').doc(cursor).get();
      if (!cursorDoc.exists || cursorDoc.data()?.providerUid !== user.uid) throw new HttpError(400, 'invalid-cursor', 'Curseur de pagination invalide.');
      query = query.startAfter(cursorDoc);
    }
    const page = await query.limit(101).get();
    const hasMore = page.docs.length > 100;
    const pageDocs = page.docs.slice(0, 100);
    const ownOrders = [];
    for (const doc of pageDocs) {
      const order = doc.data() || {};
      const type = allowedTypes.find((value) => value === order.providerType && (value === 'laboratory' ? order.kind === 'laboratory_exam' : order.kind === 'imaging'));
      if (!type) continue;
      const status = String(order.status || '').toUpperCase();
      const completedLabLine = type === 'laboratory' && (Array.isArray(order.items) ? order.items : []).some((item) => ['PERFORMED', 'COMPLETED', 'EXAM_COMPLETED'].includes(String(item.realizationStatus || '').toUpperCase()));
      if (!isEligiblePaidOrder(order) || (!ACTIVE_ORDER_STATUSES.has(status) && !completedLabLine)) continue;
      const latest = order.partnerResultStatus || (order.resultId ? 'LEGACY_RESULT' : '');
      ownOrders.push({ id: doc.id, providerType: type, examName: orderExamName(order), orderedAt: order.createdAt || null, status: order.status || 'UNKNOWN', resultStatus: latest || 'TO_DO', resultId: order.partnerResultId || null, patientLabel: await safePatientLabel(order.patientUid) });
    }
    await audit(user.uid, 'partner_orders_listed', `clients/${user.uid}`, { count: ownOrders.length });
    res.status(200).json({ ok: true, partner: partnerIdentity, orders: ownOrders, hasMore, nextCursor: hasMore ? pageDocs.at(-1)?.id || null : null });
  }));

  const healthPartnerGetResultsOverview = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const allowedTypes = [];
    for (const type of ['laboratory', 'imaging']) {
      try { await partner(user, type); allowedTypes.push(type); } catch (_) {}
    }
    if (!allowedTypes.length) throw new HttpError(403, 'partner-account-inactive', 'Compte partenaire non autorisé ou suspendu.');
    const now = new Date();
    const dayKey = now.toLocaleDateString('en-CA', { timeZone: 'America/Port-au-Prince' });
    const monthKey = dayKey.slice(0, 7);
    const todayStart = new Date(`${dayKey}T00:00:00-04:00`).toISOString();
    const monthStart = new Date(`${monthKey}-01T00:00:00-04:00`).toISOString();
    const [ordersSnap, resultsSnap] = await Promise.all([
      db.collection('healthOrders').where('providerUid', '==', user.uid).select('kind', 'providerType', 'status', 'paymentStatus', 'items', 'examId', 'orderItemId', 'catalogExamId', 'partnerResultId', 'resultId').get(),
      db.collection('healthPartnerResults').where('partnerUid', '==', user.uid).select('orderId', 'examLineId', 'version', 'status', 'createdAt').get()
    ]);
    const orders = ordersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((order) => allowedTypes.includes(providerTypeForOrder(order)));
    const results = resultsSnap.docs.map((doc) => doc.data());
    const summary = summarizePartnerResults(orders, results, { todayStart, monthStart });
    await audit(user.uid, 'partner_results_overview_viewed', `clients/${user.uid}`, summary);
    res.status(200).json({ ok: true, overview: summary });
  }));

  const healthPartnerLookupOrder = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const payload = body(req);
    const orderId = clean(payload.orderId, 200);
    const internal = payload.source === 'smartcut-health';
    if (!orderId) throw new HttpError(400, 'order-id-required', 'Numéro de commande requis.');
    const loaded = await loadOrder(orderId);
    if (!loaded) {
      if (internal) await audit(user.uid, 'internal_order_lookup_denied', `healthOrders/${orderId}`, { reason: 'not-found-or-not-internal' });
      else await recordDeniedPartnerLookup(user, orderId, 'not-found-or-not-assigned');
      throw new HttpError(404, 'order-not-found-or-not-assigned', 'Commande introuvable ou non affectée à ce partenaire.');
    }
    const { order, providerType } = loaded;
    if (internal) {
      await authorizeAdmin(user, false);
      if (!isManagedProviderId(order.providerUid)) throw new HttpError(404, 'order-not-found-or-not-internal', 'Commande introuvable ou non affectée à Smart Cut Health.');
    } else {
      await partner(user, providerType);
      if (order.providerUid !== user.uid) {
        await recordDeniedPartnerLookup(user, orderId, 'not-found-or-not-assigned', providerType);
        throw new HttpError(404, 'order-not-found-or-not-assigned', 'Commande introuvable ou non affectée à ce partenaire.');
      }
    }
    const orderStatus = String(order.status || '').toUpperCase();
    const completedLabLine = providerTypeForOrder(order) === 'laboratory' && (Array.isArray(order.items) ? order.items : []).some((item) => ['PERFORMED', 'COMPLETED', 'EXAM_COMPLETED'].includes(String(item.realizationStatus || '').toUpperCase()));
    if (!isEligiblePaidOrder(order) || (!ACTIVE_ORDER_STATUSES.has(orderStatus) && !completedLabLine)) {
      await audit(user.uid, 'partner_order_lookup_denied', `healthOrders/${orderId}`, { reason: 'inactive-or-not-paid' });
      throw new HttpError(404, 'order-not-found-or-not-assigned', 'Commande introuvable ou non affectée à ce partenaire.');
    }

  function providerTypeForOrder(order) {
    return order.kind === 'laboratory_exam' && order.providerType === 'laboratory' ? 'laboratory' : order.kind === 'imaging' && order.providerType === 'imaging' ? 'imaging' : null;
  }
    const line = orderLine(order, clean(payload.examLineId, 200));
    if (!line) {
      res.status(200).json({ ok: true, needsExamSelection: true, examLines: orderLines(order).map((entry) => ({ id: entry.resultLineId, examId: entry.resultExamId, name: entry.resultExamName })) });
      return;
    }
    const requirements = await resultRequirements(order, providerType, line);
    const [resultSnap, uploadRef] = await Promise.all([
      db.collection('healthPartnerResults').where('orderId', '==', orderId).limit(20).get(),
      Promise.resolve(db.collection('healthPartnerUploadSessions').doc())
    ]);
    const firstLineId = orderLines(order)[0]?.resultLineId;
    const belongsToLine = (item) => item.examLineId === line.resultLineId || (!item.examLineId && line.resultLineId === firstLineId);
    const previous = resultSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => belongsToLine(item) && item.status === RESULT_STATUS.CORRECTION_REQUESTED).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    const priorResult = resultSnap.docs.some((doc) => belongsToLine(doc.data() || {}) && ![RESULT_STATUS.CORRECTION_REQUESTED, RESULT_STATUS.NOT_PERFORMED, RESULT_STATUS.SUPERSEDED].includes(doc.data()?.status));
    if (!previous && priorResult) {
      throw new HttpError(409, 'result-already-submitted', 'Un résultat est déjà transmis. Utilisez la procédure de correction ou contactez Smart Cut Health.');
    }
    const resultRef = db.collection('healthPartnerResults').doc();
    const expiresAtMs = Date.now() + 20 * 60 * 1000;
    const claimId = Buffer.from(`${orderId}:${line.resultLineId}`).toString('base64url');
    const claimRef = db.collection('healthPartnerResultClaims').doc(claimId);
    await db.runTransaction(async (transaction) => {
      const claimSnap = await transaction.get(claimRef);
      const claim = claimSnap.data() || {};
      const openAndLive = claim.status === 'OPEN' && claim.expiresAt?.toMillis?.() > Date.now();
      if (openAndLive || (claim.status === 'SUBMITTED' && !previous)) throw new HttpError(409, 'result-already-submitted', 'Un dépôt est déjà en cours ou terminé pour cet examen.');
      transaction.set(claimRef, { orderId, examLineId: line.resultLineId, sessionId: uploadRef.id, resultId: resultRef.id, previousResultId: previous?.id || null, status: 'OPEN', updatedAt: nowIso(), expiresAt: adminSDK.firestore.Timestamp.fromMillis(expiresAtMs) });
      transaction.create(uploadRef, { partnerUid: user.uid, source: internal ? 'smartcut-health' : 'external-partner', orderId, examLineId: line.resultLineId, claimId, providerType, resultId: resultRef.id, previousResultId: previous?.id || null, previousVersion: Number(previous?.version) || 0, status: 'OPEN', createdAt: nowIso(), expiresAt: adminSDK.firestore.Timestamp.fromMillis(expiresAtMs) });
    });
    await audit(user.uid, internal ? 'internal_order_lookup_allowed' : 'partner_order_lookup_allowed', `healthOrders/${orderId}`, { providerType, examLineId: line.resultLineId });
    res.status(200).json({ ok: true, uploadSessionId: uploadRef.id, resultId: resultRef.id, expiresInSeconds: 1200, order: { id: orderId, examLineId: line.resultLineId, examName: orderExamName(order, line.resultLineId), examId: orderExamId(order, line.resultLineId), providerType, patientLabel: await safePatientLabel(order.patientUid), orderedAt: order.createdAt || null, status: order.status, resultStatus: previous ? RESULT_STATUS.CORRECTION_REQUESTED : 'TO_DO', reviewReason: previous?.reviewReason || null, requiredCategories: requirements.requiredCategories, maxFiles: Math.min(MAX_FILES, Number(requirements.maxFiles) || MAX_FILES), maxFileBytes: Math.min(MAX_FILE_BYTES, Number(requirements.maxFileBytes) || MAX_FILE_BYTES), allowedMimeTypes: Array.isArray(requirements.allowedMimeTypes) ? requirements.allowedMimeTypes.filter((type) => ALLOWED_MIME.has(type)) : [...ALLOWED_MIME], allowSupplemental: requirements.allowSupplemental !== false, allowMultiplePerCategory: requirements.allowMultiplePerCategory !== false, partnerName: internal ? 'Smart Cut Health' : clean(order.providerName || order.providerSnapshot?.businessName, 180) || 'Prestataire affecté', source: internal ? 'smartcut-health' : 'external-partner' } });
  }));

  const healthPartnerSubmitResult = onRequest({ region, memory: '1GiB', timeoutSeconds: 3600 }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const payload = body(req);
    const sessionId = clean(payload.uploadSessionId, 200);
    const sessionRef = db.collection('healthPartnerUploadSessions').doc(sessionId);
    const sessionSnap = await sessionRef.get();
    const session = sessionSnap.data() || {};
    if (!sessionSnap.exists || session.partnerUid !== user.uid || session.status !== 'OPEN' || session.expiresAt?.toMillis?.() <= Date.now()) throw new HttpError(403, 'upload-session-invalid', 'Session de dépôt expirée ou non autorisée. Recherchez à nouveau la commande.');
    const internal = session.source === 'smartcut-health';
    const loaded = await loadOrder(session.orderId);
    if (!loaded || loaded.providerType !== session.providerType || (internal ? !isManagedProviderId(loaded.order.providerUid) : loaded.order.providerUid !== user.uid)) throw new HttpError(403, 'order-assignment-changed', 'L’affectation de la commande a changé.');
    const { order, providerType } = loaded;
    if (internal) await authorizeAdmin(user, false); else await partner(user, providerType);
    const line = orderLine(order, session.examLineId);
    if (!line) throw new HttpError(409, 'order-exam-changed', 'L’examen sélectionné ne correspond plus à cette commande.');
    const requirements = await resultRequirements(order, providerType, line);
    const required = requirements.requiredCategories || requiredCategories(order, providerType);
    const allowedMimeTypes = Array.isArray(requirements.allowedMimeTypes) && requirements.allowedMimeTypes.length ? requirements.allowedMimeTypes.filter((type) => ALLOWED_MIME.has(type)) : [...ALLOWED_MIME];
    const rawFiles = Array.isArray(payload.files) ? payload.files : [];
    const categoryCheck = validateResultFiles(rawFiles, providerType, required);
    if (!categoryCheck.ok) throw new HttpError(400, categoryCheck.code, categoryCheck.code === 'required-file-missing' ? `Fichier requis manquant : ${categoryCheck.missing.join(', ')}.` : 'Liste de fichiers invalide.');
    const categoryCounts = rawFiles.reduce((counts, file) => { const category = clean(file?.category, 40).toUpperCase(); counts[category] = (counts[category] || 0) + 1; return counts; }, {});
    if (requirements.allowSupplemental === false && categoryCounts.SUPPLEMENTAL) throw new HttpError(400, 'supplemental-not-allowed', 'Les documents complémentaires ne sont pas autorisés pour cet examen.');
    if (requirements.allowMultiplePerCategory === false && Object.values(categoryCounts).some((count) => count > 1)) throw new HttpError(400, 'multiple-files-not-allowed', 'Un seul fichier par catégorie est autorisé pour cet examen.');
    if (rawFiles.length > Math.min(MAX_FILES, Number(requirements.maxFiles) || MAX_FILES)) throw new HttpError(400, 'too-many-files', 'Nombre maximal de fichiers dépassé.');
    const seenHashes = new Set();
    const storedFiles = [];
    for (const item of rawFiles) {
      const fileId = clean(item.fileId, 100);
      const category = clean(item.category, 40).toUpperCase();
      const storagePath = clean(item.storagePath, 600);
      const prefix = `health-partner-results/${user.uid}/${session.orderId}/${sessionId}/`;
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(fileId) || !storagePath.startsWith(prefix) || storagePath.slice(prefix.length) !== fileId) throw new HttpError(400, 'invalid-storage-path', 'Chemin de fichier invalide.');
      const file = adminSDK.storage().bucket().file(storagePath);
      const [exists] = await file.exists();
      if (!exists) throw new HttpError(400, 'file-not-found', 'Un fichier transmis est introuvable.');
      const [metadata] = await file.getMetadata();
      const contentType = String(metadata?.contentType || '').toLowerCase();
      const size = Number(metadata?.size || 0);
      const maxFileBytes = Math.min(MAX_FILE_BYTES, Number(requirements.maxFileBytes) || MAX_FILE_BYTES);
      if (!allowedMimeTypes.includes(contentType) || !size || size > maxFileBytes) throw new HttpError(400, 'invalid-result-file', 'Format ou taille invalide. Respectez les formats et la taille maximale configurés pour cet examen.');
      const hash = String(metadata?.md5Hash || '');
      if (hash && seenHashes.has(hash)) throw new HttpError(409, 'duplicate-result-file', 'Le même fichier a été sélectionné plusieurs fois.');
      if (hash) seenHashes.add(hash);
      storedFiles.push({ id: fileId, category, storagePath, fileName: clean(item.fileName, 240) || 'resultat', contentType, size, md5Hash: hash || null });
    }
    const storageBucket = adminSDK.storage().bucket();
    try {
      const scannerUrl = HEALTH_RESULTS_SCANNER_URL.value();
      if (!scannerUrl) throw new Error('scanner-not-configured');
      for (const storedFile of storedFiles) {
        const [contents] = await storageBucket.file(storedFile.storagePath).download();
        const verdict = await scanPartnerResultFile({ scannerUrl, fileBuffer: contents, contentType: storedFile.contentType });
        storedFile.antivirusStatus = verdict.status;
        storedFile.antivirusScannerVersion = verdict.scannerVersion;
        storedFile.antivirusScannedAt = nowIso();
      }
    } catch (error) {
      await Promise.allSettled(storedFiles.map((storedFile) => storageBucket.file(storedFile.storagePath).delete({ ignoreNotFound: true })));
      const reason = String(error?.message || 'scanner-unavailable');
      await audit(user.uid, 'partner_result_scan_blocked', `healthPartnerUploadSessions/${sessionId}`, { providerType, fileCount: storedFiles.length, reason });
      if (reason === 'malware-detected') throw new HttpError(422, 'malware-detected', 'Un fichier a été bloqué par l’analyse antivirus. Vérifiez les documents puis recommencez le dépôt.');
      if (reason === 'scanner-file-invalid' || reason === 'scanner-file-type-invalid') throw new HttpError(400, 'invalid-result-file', 'Un fichier n’a pas pu être transmis à l’analyse de sécurité. Sélectionnez à nouveau les fichiers autorisés.');
      throw new HttpError(503, 'malware-scanner-unavailable', 'L’analyse de sécurité est temporairement indisponible. Aucun résultat n’a été transmis; réessayez plus tard.');
    }
    const patientSnap = await db.collection('clients').doc(order.patientUid).get();
    const patient = patientSnap.data() || {};
    const patientProfile = patient.profile || patient.patientProfile || patient;
    const timestamp = nowIso();
    const previousId = session.previousResultId || null;
    const resultRef = db.collection('healthPartnerResults').doc(session.resultId);
    const claimRef = db.collection('healthPartnerResultClaims').doc(clean(session.claimId, 200));
    const previousRef = previousId ? db.collection('healthPartnerResults').doc(previousId) : null;
    const result = {
      orderId: session.orderId, resultId: session.resultId, patientUid: order.patientUid, patientLabel: maskPatientName({ firstName: patientProfile.firstName || patientProfile.prenom, lastName: patientProfile.lastName || patientProfile.nom }),
      partnerUid: internal ? null : user.uid, uploadedByUid: user.uid, providerUid: internal ? 'smartcut-health' : user.uid, source: internal ? 'smartcut-health' : 'external-partner', examLineId: session.examLineId, providerType, examId: orderExamId(order, session.examLineId), examName: orderExamName(order, session.examLineId), prescribingDoctorUid: order.prescribingDoctorUid || null,
      patientPriceSnapshot: Number(line.patientPriceSnapshot ?? line.lineTotal ?? line.unitPrice ?? line.price ?? order.total ?? 0) || 0,
      partnerAmountSnapshot: internal ? 0 : Number(line.partnerAmountSnapshot ?? line.partnerAmount ?? order.centerNetAmount ?? 0) || 0,
      smartCutMarginSnapshot: internal ? 0 : Number(line.smartCutMarginSnapshot ?? line.smartCutMargin ?? Math.max(0, Number(line.patientPriceSnapshot ?? line.lineTotal ?? order.total ?? 0) - Number(line.partnerAmountSnapshot ?? line.partnerAmount ?? order.centerNetAmount ?? order.total ?? 0))) || 0,
      files: storedFiles, comment: clean(payload.comment, 1000) || null, performedAt: clean(payload.performedAt, 40) || null,
      status: RESULT_STATUS.PENDING_REVIEW, version: previousId ? (Number(session.previousVersion) || 1) + 1 : 1, previousResultId: previousId,
      createdAt: timestamp, updatedAt: timestamp, reviewedAt: null, reviewedByUid: null, patientTransferredAt: null, paymentEligibleAt: null
    };
    await db.runTransaction(async (transaction) => {
      const reads = [transaction.get(sessionRef), transaction.get(loaded.ref), transaction.get(resultRef), transaction.get(claimRef)];
      if (previousRef) reads.push(transaction.get(previousRef));
      const [freshSession, freshOrder, freshResult, freshClaim, freshPrevious] = await Promise.all(reads);
      const freshOrderData = freshOrder.data() || {};
      if (!freshSession.exists || freshSession.data()?.status !== 'OPEN' || freshSession.data()?.partnerUid !== user.uid || !freshOrder.exists || (internal ? !isManagedProviderId(freshOrderData.providerUid) : freshOrderData.providerUid !== user.uid) || freshSession.data()?.examLineId !== session.examLineId || !freshClaim.exists || freshClaim.data()?.status !== 'OPEN' || freshClaim.data()?.sessionId !== sessionId || freshResult.exists) throw new HttpError(409, 'submission-conflict', 'Le dépôt a déjà été envoyé ou l’affectation a changé.');
      if (previousRef && (!freshPrevious?.exists || freshPrevious.data()?.status !== RESULT_STATUS.CORRECTION_REQUESTED || (internal ? freshPrevious.data()?.source !== 'smartcut-health' : freshPrevious.data()?.partnerUid !== user.uid))) throw new HttpError(409, 'correction-session-stale', 'La demande de correction a déjà été traitée. Recherchez à nouveau la commande.');
      transaction.create(resultRef, result);
      transaction.update(sessionRef, { status: 'SUBMITTED', submittedAt: timestamp });
      transaction.update(claimRef, { status: 'SUBMITTED', resultId: resultRef.id, updatedAt: timestamp });
      transaction.set(loaded.ref, { partnerResultId: resultRef.id, partnerResultStatus: RESULT_STATUS.PENDING_REVIEW, partnerResultSubmittedAt: timestamp, updatedAt: timestamp }, { merge: true });
      if (previousRef) transaction.update(previousRef, { status: RESULT_STATUS.SUPERSEDED, replacedByResultId: resultRef.id, supersededAt: timestamp, updatedAt: timestamp });
    });
    await audit(user.uid, previousId ? 'partner_result_correction_submitted' : 'partner_result_submitted', `healthPartnerResults/${resultRef.id}`, { orderId: session.orderId, providerType, version: result.version, fileCount: storedFiles.length });
    await db.collection('healthAdminAlerts').add({ module: 'health-partner-results', type: 'RESULT_RECEIVED', status: 'OPEN', orderId: session.orderId, resultId: resultRef.id, providerType, createdAt: timestamp, title: 'Un nouveau résultat attend un contrôle' });
    res.status(200).json({ ok: true, resultId: resultRef.id, status: result.status, version: result.version });
  }));

  const healthAdminListPartnerResults = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const status = clean(req.query?.status, 40).toUpperCase();
    const providerType = clean(req.query?.providerType, 40).toLowerCase();
    const q = clean(req.query?.q, 180).toLowerCase();
    const paymentStatus = clean(req.query?.paymentStatus, 30).toUpperCase();
    const partnerUid = clean(req.query?.partnerUid, 200);
    const examId = clean(req.query?.examId, 200);
    const from = clean(req.query?.from, 40);
    const to = clean(req.query?.to, 40);
    const cursor = clean(req.query?.cursor, 200);
    let query = db.collection('healthPartnerResults').orderBy(adminSDK.firestore.FieldPath.documentId()).limit(250);
    if (cursor) {
      const cursorSnap = await db.collection('healthPartnerResults').doc(cursor).get();
      if (!cursorSnap.exists) throw new HttpError(400, 'invalid-results-cursor', 'Le curseur de pagination est invalide. Actualisez la liste.');
      query = query.startAfter(cursorSnap);
    }
    const snap = await query.get();
    const sourceResults = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const refs = [...new Map(sourceResults.flatMap((item) => [
      ...(item.orderId ? [[`order:${item.orderId}`, db.collection('healthOrders').doc(item.orderId)]] : []),
      ...(item.partnerUid ? [[`client:${item.partnerUid}`, db.collection('clients').doc(item.partnerUid)]] : []),
      ...(item.patientUid ? [[`client:${item.patientUid}`, db.collection('clients').doc(item.patientUid)]] : [])
    ])).entries()];
    const records = refs.length ? await db.getAll(...refs.map(([, ref]) => ref)) : [];
    const recordMap = new Map(refs.map(([key], index) => [key, records[index]?.data() || {}]));
    const results = sourceResults.map((item) => {
      const order = recordMap.get(`order:${item.orderId}`) || {};
      const patient = recordMap.get(`client:${item.patientUid}`) || {};
      const partnerDoc = recordMap.get(`client:${item.partnerUid}`) || {};
      const patientProfile = patient.profile || patient.patientProfile || patient;
      const partnerProfile = partnerDoc.partnerProfile || partnerDoc.labProfile || partnerDoc.imagingProfile || {};
      const fullPatientName = [patientProfile.firstName || patientProfile.prenom, patientProfile.lastName || patientProfile.nom].filter(Boolean).join(' ');
      return publicResult({ ...item, patientName: fullPatientName || item.patientLabel || 'Patient', examName: item.examName || orderExamName(order), partnerName: item.source === 'smartcut-health' ? 'Smart Cut Health' : partnerProfile.businessName || partnerDoc.displayName || item.partnerUid || 'Prestataire', orderedAt: order.createdAt || null, paymentStatus: item.source === 'smartcut-health' ? 'NOT_APPLICABLE' : item.paymentStatus || (isPayoutEligible(item) ? 'ELIGIBLE' : 'BLOCKED') });
    }).filter((item) => matchesAdminResultFilters(item, { status, providerType, partnerUid, examId, paymentStatus, from, to, q }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const nextCursor = snap.docs.length === 250 ? snap.docs[snap.docs.length - 1].id : null;
    await audit(user.uid, 'partner_results_admin_listed', 'healthPartnerResults', { count: results.length, status: status || null, providerType: providerType || null, partnerUid: partnerUid || null, examId: examId || null, q: q || null, paymentStatus: paymentStatus || null, from: from || null, to: to || null, pageSize: 250, hasMore: Boolean(nextCursor) });
    res.status(200).json({ ok: true, results, nextCursor, hasMore: Boolean(nextCursor) });
  }));

  const healthAdminGetPartnerResultsOverview = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const zone = 'America/Port-au-Prince';
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset' }).formatToParts(new Date()).map((part) => [part.type, part.value]));
    const offsetMatch = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(parts.timeZoneName || 'GMT-4');
    const offsetMinutes = offsetMatch ? (offsetMatch[1] === '-' ? -1 : 1) * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] || 0)) : -240;
    const localMidnightUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) - offsetMinutes * 60_000;
    const todayStart = new Date(localMidnightUtc).toISOString();
    const tomorrowStart = new Date(localMidnightUtc + 86_400_000).toISOString();
    const requestedDays = Number(req.query?.days);
    const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
    const windowStart = new Date(localMidnightUtc - (days - 1) * 86_400_000).toISOString();
    const results = db.collection('healthPartnerResults');
    const count = async (query) => (await query.count().get()).data().count;
    const sum = async (query) => {
      const snapshot = await query.aggregate({ amount: adminSDK.firestore.AggregateField.sum('partnerAmountSnapshot') }).get();
      return Number(snapshot.data().amount) || 0;
    };
    const [partnersSnap, ordersTodaySnap, ordersWindowSnap, resultsWindowSnap, resultsToday, awaitingReview, corrections, validated, notPerformed, eligible, inSettlement, paid] = await Promise.all([
      db.collection('clients').where('partnerStatus', '==', 'active').select('partnerStatus', 'partnerType', 'partnerProfile').get(),
      db.collection('healthOrders').where('createdAt', '>=', todayStart).where('createdAt', '<', tomorrowStart).select('kind', 'providerType', 'providerUid', 'status', 'paymentStatus', 'items', 'examId', 'orderItemId', 'catalogExamId', 'examName', 'name', 'partnerResultId', 'resultId').get(),
      db.collection('healthOrders').where('createdAt', '>=', windowStart).where('createdAt', '<', tomorrowStart).select('createdAt', 'kind', 'providerType', 'providerUid', 'status', 'paymentStatus', 'items', 'examId', 'orderItemId', 'catalogExamId', 'examName', 'name').get(),
      results.where('createdAt', '>=', windowStart).where('createdAt', '<', tomorrowStart).orderBy('createdAt', 'desc').select('orderId', 'partnerUid', 'providerType', 'source', 'status', 'createdAt', 'examName').get(),
      count(results.where('createdAt', '>=', todayStart).where('createdAt', '<', tomorrowStart)),
      count(results.where('status', '==', RESULT_STATUS.PENDING_REVIEW)),
      count(results.where('status', '==', RESULT_STATUS.CORRECTION_REQUESTED)),
      count(results.where('status', 'in', [RESULT_STATUS.VALIDATED, RESULT_STATUS.PATIENT_VISIBLE])),
      count(results.where('status', '==', RESULT_STATUS.NOT_PERFORMED)),
      sum(results.where('paymentStatus', '==', 'ELIGIBLE')),
      sum(results.where('paymentStatus', '==', 'PENDING')),
      sum(results.where('paymentStatus', '==', 'PAID'))
    ]);
    const activePartners = partnersSnap.docs.map((doc) => doc.data()).filter((data) => data.partnerProfile && data.partnerStatus === 'active');
    const assignedOrdersToday = ordersTodaySnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((order) => {
      const isExam = (order.kind === 'laboratory_exam' && order.providerType === 'laboratory') || (order.kind === 'imaging' && order.providerType === 'imaging');
      const active = ACTIVE_ORDER_STATUSES.has(String(order.status || '').toUpperCase()) || (order.kind === 'laboratory_exam' && (order.items || []).some((item) => ['PERFORMED', 'COMPLETED', 'EXAM_COMPLETED'].includes(String(item.realizationStatus || '').toUpperCase())));
      return isExam && Boolean(order.providerUid) && isEligiblePaidOrder(order) && active;
    });
    const isAssignedPartnerOrder = (order) => {
      const providerType = String(order.providerType || '').toLowerCase();
      const isExam = (order.kind === 'laboratory_exam' && providerType === 'laboratory') || (order.kind === 'imaging' && providerType === 'imaging');
      const active = ACTIVE_ORDER_STATUSES.has(String(order.status || '').toUpperCase()) || (order.kind === 'laboratory_exam' && (order.items || []).some((item) => ['PERFORMED', 'COMPLETED', 'EXAM_COMPLETED'].includes(String(item.realizationStatus || '').toUpperCase())));
      return isExam && Boolean(order.providerUid) && !isManagedProviderId(order.providerUid) && isEligiblePaidOrder(order) && active;
    };
    const assignedOrdersWindow = ordersWindowSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter(isAssignedPartnerOrder);
    const resultRowsWindow = resultsWindowSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    const trend = buildPartnerResultsTrend({ days, now: new Date(), orders: assignedOrdersWindow, results: resultRowsWindow, isAssignedOrder: isAssignedPartnerOrder });
    const recentAssignedRaw = assignedOrdersWindow.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).slice(0, 100);
    const recentResultsRaw = resultRowsWindow.slice(0, 5);
    const recentReviewRaw = resultRowsWindow.filter((item) => item.status === RESULT_STATUS.PENDING_REVIEW).slice(0, 5);
    const partnerUids = [...new Set([
      ...recentAssignedRaw.map((item) => item.providerUid),
      ...recentResultsRaw.map((item) => item.partnerUid)
    ].filter((uid) => uid && !isManagedProviderId(uid)))];
    const partnerDocs = partnerUids.length ? await db.getAll(...partnerUids.map((uid) => db.collection('clients').doc(uid))) : [];
    const partnerNames = new Map(partnerDocs.map((doc) => {
      const data = doc.data() || {};
      const profile = data.partnerProfile || data.labProfile || data.imagingProfile || {};
      return [doc.id, profile.businessName || profile.name || data.displayName || doc.id];
    }));
    const partnerLabel = (uid) => partnerNames.get(uid) || 'Nom indisponible';
    const recentAssignedOrders = recentAssignedRaw.slice(0, 5).map((item) => ({ id: item.id, providerType: item.providerType, partnerName: partnerLabel(item.providerUid), createdAt: item.createdAt || null }));
    const assignedOrders = recentAssignedRaw.map((item) => ({ id: item.id, providerType: item.providerType, partnerName: partnerLabel(item.providerUid), createdAt: item.createdAt || null }));
    const resultOrderIds = new Set(resultRowsWindow.map((item) => item.orderId).filter(Boolean));
    const recentOrdersWithoutResult = recentAssignedRaw.filter((item) => !resultOrderIds.has(item.id)).slice(0, 5).map((item) => ({ id: item.id, providerType: item.providerType, partnerName: partnerLabel(item.providerUid), createdAt: item.createdAt || null }));
    const toPublicDashboardResult = (item) => ({ id: item.id, orderId: item.orderId || '—', providerType: item.providerType || '—', partnerName: item.source === 'smartcut-health' ? 'Smart Cut Health' : partnerLabel(item.partnerUid), createdAt: item.createdAt || null, status: item.status || '—' });
    const recentResults = recentResultsRaw.slice(0, 5).map(toPublicDashboardResult);
    const recentResultsAwaitingReview = recentReviewRaw.map(toPublicDashboardResult);
    const partnerType = (data) => String(data.partnerType || data.partnerProfile?.providerType || data.partnerProfile?.type || '').toLowerCase();
    const activeLaboratories = activePartners.filter((data) => ['laboratory', 'mixed'].includes(partnerType(data))).length;
    const activeImagingCenters = activePartners.filter((data) => ['imaging', 'mixed'].includes(partnerType(data))).length;
    const activeMixedPartners = activePartners.filter((data) => partnerType(data) === 'mixed').length;
    const unclassifiedPartners = Math.max(0, activePartners.length - activeLaboratories - activeImagingCenters + activeMixedPartners);
    const resultsForTodayOrders = [];
    for (let index = 0; index < assignedOrdersToday.length; index += 30) {
      const orderIds = assignedOrdersToday.slice(index, index + 30).map((order) => order.id);
      if (!orderIds.length) continue;
      const resultSnap = await results.where('orderId', 'in', orderIds).select('orderId', 'examLineId').get();
      resultsForTodayOrders.push(...resultSnap.docs.map((doc) => doc.data()));
    }
    const assignedToday = assignedOrdersToday.length;
    const ordersAwaitingResultToday = countOrdersAwaitingResults(assignedOrdersToday, resultsForTodayOrders);
    const externalResultsAwaitingPayment = Math.round((eligible + inSettlement) * 100) / 100;
    await audit(user.uid, 'partner_results_overview_viewed', 'healthPartnerResults', {});
    res.status(200).json({ ok: true, overview: {
      activePartners: activePartners.length,
      activeLaboratories,
      activeImagingCenters,
      assignedToday,
      ordersAwaitingResultToday,
      resultsReceivedToday: resultsToday,
      awaitingReview,
      correctionsPending: corrections,
      examsValidatedAsPerformed: validated,
      examsNotPerformed: notPerformed,
      amountDueHTG: externalResultsAwaitingPayment,
      amountPaidHTG: Math.round(paid * 100) / 100,
      activePartnerBreakdown: [
        { label: 'Laboratoires', count: activeLaboratories - activeMixedPartners },
        { label: 'Imagerie médicale', count: activeImagingCenters - activeMixedPartners },
        { label: 'Laboratoire et imagerie', count: activeMixedPartners },
        { label: 'Autres partenaires', count: unclassifiedPartners }
      ].filter((item) => item.count > 0),
      trend,
      recentAssignedOrders,
      assignedOrders,
      recentResults,
      recentResultsAwaitingReview,
      recentOrdersWithoutResult,
      assignedOrdersDisplayed: assignedOrders.length,
      assignedOrdersInPeriod: assignedOrdersWindow.length
    } });
  }));

  const healthAdminGetResultsPartnerReport = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const partnerUid = clean(req.query?.partnerUid, 200);
    if (!partnerUid) throw new HttpError(400, 'partner-required', 'Sélectionnez un partenaire.');
    const partnerSnap = await db.collection('clients').doc(partnerUid).get();
    if (!partnerSnap.exists || !partnerSnap.data()?.partnerProfile) throw new HttpError(404, 'results-partner-not-found', 'Partenaire introuvable.');
    const [ordersCount, resultSnap] = await Promise.all([
      db.collection('healthOrders').where('providerUid', '==', partnerUid).count().get(),
      db.collection('healthPartnerResults').where('partnerUid', '==', partnerUid).get()
    ]);
    const latestByLine = new Map();
    for (const doc of resultSnap.docs) {
      const item = doc.data() || {};
      const key = `${item.orderId || ''}:${item.examLineId || ''}`;
      const previous = latestByLine.get(key);
      if (!previous || Number(item.version || 1) > Number(previous.version || 1)
        || Number(item.version || 1) === Number(previous.version || 1) && String(item.createdAt || '') > String(previous.createdAt || '')) latestByLine.set(key, item);
    }
    const currentResults = [...latestByLine.values()];
    const isValidated = (item) => [RESULT_STATUS.VALIDATED, RESULT_STATUS.PATIENT_VISIBLE].includes(item.status);
    const amountFor = (items) => Math.round(items.reduce((sum, item) => sum + (Number(item.partnerAmountSnapshot) || 0), 0) * 100) / 100;
    const due = currentResults.filter((item) => ['ELIGIBLE', 'PENDING'].includes(String(item.paymentStatus || '').toUpperCase())
      && isValidated(item) && item.examPerformed === true && Number(item.partnerAmountSnapshot) > 0);
    const partnerProfile = partnerSnap.data().partnerProfile || {};
    const report = {
      partnerUid,
      partnerName: partnerProfile.businessName || partnerSnap.data().displayName || partnerUid,
      ordersAssigned: ordersCount.data().count,
      examsPerformed: currentResults.filter(isValidated).length,
      examsNotPerformed: currentResults.filter((item) => item.status === RESULT_STATUS.NOT_PERFORMED).length,
      correctionsPending: currentResults.filter((item) => item.status === RESULT_STATUS.CORRECTION_REQUESTED).length,
      examsValidated: currentResults.filter((item) => item.status === RESULT_STATUS.VALIDATED).length,
      examsPaid: currentResults.filter((item) => String(item.paymentStatus || '').toUpperCase() === 'PAID').length,
      amountPaidHTG: amountFor(currentResults.filter((item) => String(item.paymentStatus || '').toUpperCase() === 'PAID')),
      amountDueHTG: amountFor(due)
    };
    await audit(user.uid, 'results_partner_report_viewed', `clients/${partnerUid}`, { orderCount: report.ordersAssigned, resultCount: currentResults.length });
    res.status(200).json({ ok: true, report });
  }));

  const healthAdminGetPartnerResultHistory = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const resultId = clean(req.query?.resultId, 200);
    const currentSnap = await db.collection('healthPartnerResults').doc(resultId).get();
    if (!currentSnap.exists) throw new HttpError(404, 'result-not-found', 'Résultat introuvable.');
    const current = currentSnap.data() || {};
    const versionsSnap = await db.collection('healthPartnerResults').where('orderId', '==', current.orderId).limit(100).get();
    const versions = versionsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => item.examLineId === current.examLineId || (!item.examLineId && !current.examLineId))
      .sort((a, b) => Number(a.version || 1) - Number(b.version || 1))
      .map((item) => publicResult(item));
    const resources = versions.map((item) => `healthPartnerResults/${item.id}`);
    const auditSnap = resources.length ? await db.collection('healthAuditLogs').where('resource', 'in', resources.slice(0, 30)).limit(300).get() : { docs: [] };
    const events = auditSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    await audit(user.uid, 'partner_result_history_viewed', `healthPartnerResults/${resultId}`, { versionCount: versions.length });
    res.status(200).json({ ok: true, versions, events });
  }));

  const healthPartnerListResults = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const orderId = clean(req.query?.orderId, 200);
    const recordId = clean(req.query?.recordId, 200);
    const requestedStatus = clean(req.query?.status, 40).toUpperCase();
    if (orderId && recordId) throw new HttpError(400, 'single-result-scope-required', 'Utilisez une seule référence de dossier à la fois.');
    if (requestedStatus && (orderId || recordId || requestedStatus !== RESULT_STATUS.CORRECTION_REQUESTED)) throw new HttpError(400, 'invalid-result-filter', 'Filtre de résultat invalide.');
    const role = String((await db.collection('clients').doc(user.uid).get()).data()?.role || '').toLowerCase();
    const isAdmin = await hasResultsAdminAccess(user);
    let snap;
    let loadedOrder = null;
    let recordOrders = new Map();
    let recordContext = null;
    if (orderId) {
      loadedOrder = await loadOrder(orderId);
      if (!loadedOrder || !isAdmin && loadedOrder.order.patientUid !== user.uid && loadedOrder.order.providerUid !== user.uid && !isAuthorizedOrderDoctor(user.uid, loadedOrder.order)) throw new HttpError(404, 'order-not-found', 'Commande introuvable.');
      snap = await db.collection('healthPartnerResults').where('orderId', '==', orderId).limit(50).get();
    } else if (recordId) {
      const recordSnap = await db.collection('electronicPatientRecords').doc(recordId).get();
      const record = recordSnap.data() || {};
      const appointmentId = clean(record.appointmentId, 200);
      const appointmentSnap = appointmentId ? await db.collection('healthAppointments').doc(appointmentId).get() : null;
      const appointment = appointmentSnap?.exists ? { id: appointmentSnap.id, ...appointmentSnap.data() } : {};
      if (!recordSnap.exists || !appointmentSnap?.exists || !canDoctorReadRecordResults(user.uid, record, appointment)) throw new HttpError(404, 'record-not-found', 'Dossier introuvable.');
      recordContext = { record, appointment };
      const [appointmentOrders, prescriptionsSnap] = await Promise.all([
        db.collection('healthOrders').where('appointmentId', '==', appointmentId).limit(30).get(),
        db.collection('healthClinicalPrescriptions').where('appointmentId', '==', appointmentId).limit(20).get()
      ]);
      const prescriptionIds = prescriptionsSnap.docs.filter((doc) => {
        const prescription = doc.data() || {};
        return prescription.patientUid === record.patientUid && prescription.providerUid === user.uid;
      }).map((doc) => doc.id);
      const prescriptionOrders = prescriptionIds.length
        ? await db.collection('healthOrders').where('prescriptionId', 'in', prescriptionIds.slice(0, 30)).limit(30).get()
        : { docs: [] };
      const linkedPrescriptions = new Map(prescriptionsSnap.docs.filter((doc) => {
        const prescription = doc.data() || {};
        return prescription.patientUid === record.patientUid && prescription.providerUid === user.uid;
      }).map((doc) => [doc.id, { id: doc.id, ...doc.data() }]));
      const candidateOrders = new Map([...appointmentOrders.docs, ...prescriptionOrders.docs].map((doc) => [doc.id, doc]));
      const resultSnapshots = await Promise.all([...candidateOrders.values()].map(async (orderDoc) => {
        const order = { id: orderDoc.id, ...orderDoc.data() };
        const prescription = linkedPrescriptions.get(order.prescriptionId) || null;
        const appointmentOrder = order.appointmentId === appointmentId && order.patientUid === record.patientUid;
        const prescriptionOrder = Boolean(prescription && prescription.patientUid === record.patientUid);
        if (!appointmentOrder && !prescriptionOrder) return { docs: [] };
        recordOrders.set(order.id, { order, prescription });
        return db.collection('healthPartnerResults').where('orderId', '==', order.id).limit(50).get();
      }));
      snap = { docs: resultSnapshots.flatMap((resultSnap) => resultSnap.docs) };
    } else {
      const isPartner = !isAdmin && ['laboratory', 'imaging', 'health_partner'].includes(role);
      if (requestedStatus && !isPartner) throw new HttpError(403, 'partner-only-filter', 'Filtre réservé au compte partenaire.');
      const ownerField = isPartner ? 'partnerUid' : 'patientUid';
      const cursor = clean(req.query?.cursor, 200);
      let query = db.collection('healthPartnerResults').where(ownerField, '==', user.uid).orderBy(adminSDK.firestore.FieldPath.documentId());
      if (requestedStatus) query = db.collection('healthPartnerResults').where(ownerField, '==', user.uid).where('status', '==', requestedStatus).orderBy(adminSDK.firestore.FieldPath.documentId());
      if (cursor) {
        const cursorDoc = await db.collection('healthPartnerResults').doc(cursor).get();
        if (!cursorDoc.exists || cursorDoc.data()?.[ownerField] !== user.uid || requestedStatus && cursorDoc.data()?.status !== requestedStatus) throw new HttpError(400, 'invalid-cursor', 'Curseur de pagination invalide.');
        query = query.startAfter(cursorDoc);
      }
      snap = await query.limit(101).get();
    }
    const results = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => {
      if (isAdmin || item.partnerUid === user.uid) return true;
      if (item.patientUid === user.uid && item.status === RESULT_STATUS.PATIENT_VISIBLE && Boolean(item.patientTransferredAt)) return true;
      if (orderId && loadedOrder) return isAuthorizedResultDoctor(user.uid, item, loadedOrder.order);
      const linked = recordOrders.get(item.orderId);
      return Boolean(recordId && linked && recordContext && isAuthorizedRecordDoctor(user.uid, recordContext.record, recordContext.appointment, linked.order, item, linked.prescription));
    }).map(publicResult);
    if (!isAdmin && role !== 'patient') await audit(user.uid, 'partner_results_listed', recordId ? `electronicPatientRecords/${recordId}` : `clients/${user.uid}`, { count: results.length });
    const scoped = Boolean(orderId || recordId);
    const hasMore = !scoped && snap.docs.length > 100;
    res.status(200).json({ ok: true, results: scoped ? results : results.slice(0, 100), hasMore, nextCursor: hasMore ? snap.docs[99]?.id || null : null });
  }));

  const healthPartnerListOwnAudit = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    let allowed = false;
    for (const type of ['laboratory', 'imaging']) { try { await partner(user, type); allowed = true; break; } catch (_) {} }
    if (!allowed) throw new HttpError(403, 'partner-account-inactive', 'Compte partenaire non autorisé ou suspendu.');
    const cursor = clean(req.query?.cursor, 200);
    let query = db.collection('healthAuditLogs').where('actorUid', '==', user.uid).orderBy('createdAt', 'desc');
    if (cursor) {
      const cursorDoc = await db.collection('healthAuditLogs').doc(cursor).get();
      if (!cursorDoc.exists || cursorDoc.data()?.actorUid !== user.uid) throw new HttpError(400, 'invalid-cursor', 'Curseur d’historique invalide.');
      query = query.startAfter(cursorDoc);
    }
    const snap = await query.limit(201).get();
    const pageDocs = snap.docs.slice(0, 200);
    const events = pageDocs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => /^(partner_portal_login|partner_result_|partner_order_|partner_results_)/.test(String(item.action || '')))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    res.status(200).json({ ok: true, events, hasMore: snap.docs.length > 200, nextCursor: snap.docs.length > 200 ? pageDocs.at(-1)?.id || null : null });
  }));

  const healthPartnerRecordPortalLogin = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const adminProfile = await loadResultsAdminProfile(user);
    if (adminProfile) {
      await audit(user.uid, 'partner_portal_login', `clients/${user.uid}`, { accountType: 'admin', role: adminProfile.role });
      return res.status(200).json({ ok: true });
    }

    const partnerSnap = await db.collection('clients').doc(user.uid).get();
    const profile = partnerSnap.data() || {};
    const partnerProfile = profile.partnerProfile || profile.labProfile || profile.imagingProfile || {};
    const status = String(profile.partnerStatus || profile.labStatus || profile.imagingStatus || '').toLowerCase();
    const partnerRole = ['laboratory', 'lab', 'imaging', 'health_partner'].includes(String(profile.role || '').toLowerCase());
    if (!partnerSnap.exists || !partnerRole || !profile.partnerId || partnerProfile.active === false
      || !['active', 'verified', 'approved'].includes(status) || user.healthPartner !== true) {
      throw new HttpError(403, 'partner-account-inactive', 'Compte partenaire non autorisé ou suspendu.');
    }
    await audit(user.uid, 'partner_portal_login', `clients/${user.uid}`, {
      accountType: 'partner',
      partnerId: profile.partnerId,
      providerType: profile.partnerType || profile.role,
      mustChangePassword: user.healthPartnerMustChangePassword === true
    });
    res.status(200).json({ ok: true });
  }));

  const healthPartnerGetResultFileUrl = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const resultId = clean(req.query?.resultId, 200);
    const fileId = clean(req.query?.fileId, 120);
    const recordId = clean(req.query?.recordId, 200);
    const ref = db.collection('healthPartnerResults').doc(resultId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpError(404, 'result-not-found', 'Résultat introuvable.');
    const result = snap.data() || {};
    const isAdmin = await hasResultsAdminAccess(user);
    const isPatient = result.patientUid === user.uid && result.status === RESULT_STATUS.PATIENT_VISIBLE && Boolean(result.patientTransferredAt);
    let isDoctor = false;
    if (!isAdmin && result.partnerUid !== user.uid && !isPatient) {
      const orderSnap = await db.collection('healthOrders').doc(clean(result.orderId, 200)).get();
      const order = orderSnap.exists ? { id: orderSnap.id, ...orderSnap.data() } : {};
      isDoctor = orderSnap.exists && isAuthorizedResultDoctor(user.uid, result, order);
      if (!isDoctor && orderSnap.exists && recordId) {
        const recordSnap = await db.collection('electronicPatientRecords').doc(recordId).get();
        const record = recordSnap.data() || {};
        const appointmentSnap = record.appointmentId ? await db.collection('healthAppointments').doc(clean(record.appointmentId, 200)).get() : null;
        const appointment = appointmentSnap?.exists ? { id: appointmentSnap.id, ...appointmentSnap.data() } : {};
        const prescriptionSnap = order.prescriptionId ? await db.collection('healthClinicalPrescriptions').doc(clean(order.prescriptionId, 200)).get() : null;
        const prescription = prescriptionSnap?.exists ? { id: prescriptionSnap.id, ...prescriptionSnap.data() } : null;
        isDoctor = Boolean(appointmentSnap?.exists && isAuthorizedRecordDoctor(user.uid, record, appointment, order, { id: resultId, ...result }, prescription));
      }
    }
    if (!isAdmin && result.partnerUid !== user.uid && !isPatient && !isDoctor) throw new HttpError(403, 'result-file-forbidden', 'Accès refusé.');
    const file = (Array.isArray(result.files) ? result.files : []).find((item) => !fileId || item.id === fileId);
    if (!file?.storagePath) throw new HttpError(404, 'result-file-not-found', 'Fichier introuvable.');
    if (file.antivirusStatus !== 'CLEAN') throw new HttpError(409, 'result-file-not-cleared', 'Ce fichier ne peut pas être ouvert tant que son analyse de sécurité n’est pas confirmée.');
    const disposition = clean(req.query?.action, 20).toLowerCase() === 'download' ? 'attachment' : 'inline';
    const safeFileName = String(file.fileName || 'resultat').replace(/[\r\n"\\]/g, '_');
    const [url] = await adminSDK.storage().bucket().file(file.storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 5 * 60 * 1000, responseDisposition: `${disposition}; filename="${safeFileName}"` });
    await audit(user.uid, 'partner_result_file_viewed', `healthPartnerResults/${resultId}`, { orderId: result.orderId, fileId: file.id, role: isAdmin ? 'admin' : isPatient ? 'patient' : isDoctor ? 'authorized-doctor' : 'partner' });
    res.status(200).json({ ok: true, url, expiresInSeconds: 300, file: { id: file.id, category: file.category, fileName: file.fileName, contentType: file.contentType, size: file.size } });
  }));

  const healthAdminGetPartnerResultFileUrl = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const resultId = clean(req.query?.resultId, 200);
    const fileId = clean(req.query?.fileId, 120);
    const requestedAction = clean(req.query?.action, 20).toLowerCase() === 'print' ? 'print' : 'preview';
    const resultSnap = await db.collection('healthPartnerResults').doc(resultId).get();
    if (!resultSnap.exists) throw new HttpError(404, 'result-not-found', 'Résultat introuvable.');
    const result = resultSnap.data() || {};
    const file = (Array.isArray(result.files) ? result.files : []).find((item) => !fileId || item.id === fileId);
    if (!file?.storagePath) throw new HttpError(404, 'result-file-not-found', 'Fichier introuvable.');
    if (file.antivirusStatus !== 'CLEAN') throw new HttpError(409, 'result-file-not-cleared', 'Ce fichier ne peut pas être ouvert tant que son analyse de sécurité n’est pas confirmée.');
    const [url] = await adminSDK.storage().bucket().file(file.storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 5 * 60 * 1000 });
    const timestamp = nowIso();
    await db.runTransaction(async (transaction) => {
      const fresh = await transaction.get(resultSnap.ref);
      if (!fresh.exists || !(fresh.data()?.files || []).some((item) => item.id === file.id)) throw new HttpError(409, 'result-file-changed', 'Le fichier a changé. Actualisez le résultat avant de continuer.');
      transaction.set(resultSnap.ref, { ...recordAdminResultFileView(fresh.data(), user.uid, file.id, timestamp), ...(requestedAction === 'print' ? { adminPrintRequestedAt: timestamp, adminPrintRequestedByUid: user.uid } : {}) }, { merge: true });
    });
    await audit(user.uid, requestedAction === 'print' ? 'partner_result_print_requested' : 'partner_result_admin_previewed', `healthPartnerResults/${resultId}`, { orderId: result.orderId, fileId: file.id });
    res.status(200).json({ ok: true, url, expiresInSeconds: 300, file: { id: file.id, category: file.category, fileName: file.fileName, contentType: file.contentType, size: file.size } });
  }));

  const healthAdminReviewPartnerResult = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const payload = body(req);
    const resultId = clean(payload.resultId, 200);
    const action = clean(payload.action, 40).toUpperCase();
    const reason = clean(payload.reason, 1000);
    const ref = db.collection('healthPartnerResults').doc(resultId);
    const timestamp = nowIso();
    let current;
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      current = snap.data() || {};
      if (!snap.exists || !canReviewResult(current.status, action)) throw new HttpError(409, 'invalid-result-transition', 'Ce résultat ne peut pas recevoir cette décision.');
      if (!adminViewedEveryResultFile(current, user.uid)) throw new HttpError(409, 'result-must-be-viewed', 'Ouvrez et vérifiez chaque fichier avant de prendre une décision.');
      if (['REQUEST_CORRECTION', 'NOT_PERFORMED'].includes(action) && reason.length < 5) throw new HttpError(400, 'reason-required', 'Un motif détaillé est obligatoire.');
      const next = action === 'VALIDATE' ? RESULT_STATUS.VALIDATED : action === 'REQUEST_CORRECTION' ? RESULT_STATUS.CORRECTION_REQUESTED : RESULT_STATUS.NOT_PERFORMED;
      const externalPartner = current.source !== 'smartcut-health' && current.providerUid !== 'smartcut-health';
      const payable = externalPartner && Number(current.partnerAmountSnapshot) > 0;
      transaction.update(ref, { status: next, reviewAction: action, reviewReason: reason || null, reviewedAt: timestamp, reviewedByUid: user.uid, updatedAt: timestamp, ...(action === 'VALIDATE' ? { ...(payable ? { paymentEligibleAt: timestamp } : { paymentEligibleAt: null }), examPerformed: true, paymentStatus: payable ? 'ELIGIBLE' : 'NOT_APPLICABLE' } : { paymentEligibleAt: null, paymentStatus: 'BLOCKED', examPerformed: action === 'NOT_PERFORMED' ? false : null }) });
    });
    const loaded = await loadOrder(current.orderId);
    if (action === 'VALIDATE' && loaded?.providerType === 'laboratory') {
      await db.runTransaction(async (transaction) => {
        const fresh = await transaction.get(loaded.ref);
        const order = fresh.data() || {};
        const items = Array.isArray(order.items) ? order.items.slice() : [];
        const resultLineId = current.examLineId || orderLines({ ...order, id: loaded.order.id })[0]?.resultLineId;
        const idx = orderLines({ ...order, id: loaded.order.id }).findIndex((line) => line.resultLineId === resultLineId);
        if (idx >= 0 && !['CANCELLED', 'REFUNDED'].includes(String(items[idx].realizationStatus || '').toUpperCase())) {
          items[idx] = { ...items[idx], realizationStatus: 'PERFORMED', realizedAt: timestamp, realizedBy: user.uid, resultId, resultValidatedAt: timestamp };
          transaction.update(loaded.ref, { items, partnerResultStatus: RESULT_STATUS.VALIDATED, partnerResultValidatedAt: timestamp, updatedAt: timestamp });
        } else {
          transaction.update(loaded.ref, { partnerResultStatus: RESULT_STATUS.VALIDATED, partnerResultValidatedAt: timestamp, updatedAt: timestamp });
        }
      });
    } else if (loaded) {
      await loaded.ref.set({ partnerResultStatus: action === 'VALIDATE' ? RESULT_STATUS.VALIDATED : action === 'REQUEST_CORRECTION' ? RESULT_STATUS.CORRECTION_REQUESTED : RESULT_STATUS.NOT_PERFORMED, ...(action === 'VALIDATE' ? { partnerResultValidatedAt: timestamp } : {}), updatedAt: timestamp }, { merge: true });
    }
    await audit(user.uid, 'partner_result_reviewed', `healthPartnerResults/${resultId}`, { orderId: current.orderId, action, reason: reason || null });
    if (action === 'REQUEST_CORRECTION' && current.partnerUid) await notifyUser(db, current.partnerUid, 'partner_result_correction_requested', { title: 'Une action est requise dans le portail partenaire', body: 'Connectez-vous au portail sécurisé pour consulter la demande de correction.', url: './health-partner-results.html', context: { orderId: current.orderId, resultId } });
    res.status(200).json({ ok: true, resultId, status: action === 'VALIDATE' ? RESULT_STATUS.VALIDATED : action === 'REQUEST_CORRECTION' ? RESULT_STATUS.CORRECTION_REQUESTED : RESULT_STATUS.NOT_PERFORMED, patientVisible: false, paymentEligible: action === 'VALIDATE' && current.source !== 'smartcut-health' && current.providerUid !== 'smartcut-health' && Number(current.partnerAmountSnapshot) > 0 });
  }));

  const healthAdminTransferPartnerResult = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const resultId = clean(body(req).resultId, 200);
    const ref = db.collection('healthPartnerResults').doc(resultId);
    const timestamp = nowIso();
    let result;
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      result = snap.data() || {};
      if (!snap.exists || !canTransferResult(result.status, result.examPerformed)) throw new HttpError(409, 'result-not-transferable', 'Le résultat doit être validé comme examen réalisé avant son transfert au patient.');
      const orderRef = db.collection('healthOrders').doc(clean(result.orderId, 200));
      const orderSnap = await transaction.get(orderRef);
      const order = orderSnap.data() || {};
      const internal = result.source === 'smartcut-health' || result.providerUid === 'smartcut-health';
      const providerMatches = internal ? isManagedProviderId(order.providerUid) : order.providerUid === result.partnerUid;
      const lineMatches = providerTypeForOrder(order) === result.providerType && Boolean(orderLine({ ...order, id: result.orderId }, result.examLineId));
      if (!orderSnap.exists || order.patientUid !== result.patientUid || !providerMatches || !lineMatches) {
        throw new HttpError(409, 'result-order-link-invalid', 'Le patient, le prestataire ou l’examen ne correspond plus à la commande. Le transfert est bloqué.');
      }
      transaction.update(ref, { status: RESULT_STATUS.PATIENT_VISIBLE, patientTransferredAt: timestamp, patientTransferredByUid: user.uid, updatedAt: timestamp });
      transaction.set(orderRef, { partnerResultStatus: RESULT_STATUS.PATIENT_VISIBLE, partnerResultTransferredAt: timestamp, updatedAt: timestamp }, { merge: true });
    });
    await audit(user.uid, 'partner_result_transferred_to_patient', `healthPartnerResults/${resultId}`, { orderId: result.orderId, providerType: result.providerType });
    await notifyUser(db, result.patientUid, 'health_exam_result_available', { title: 'Un résultat est disponible dans votre espace', body: 'Connectez-vous à Smart Cut Health pour consulter votre document.', url: './health-espace.html?tab=results', context: { orderId: result.orderId, resultId } });
    const paymentEligible = result.source !== 'smartcut-health' && result.providerUid !== 'smartcut-health';
    res.status(200).json({ ok: true, resultId, status: RESULT_STATUS.PATIENT_VISIBLE, patientVisible: true, paymentEligible });
  }));

  const healthAdminSetPartnerOrderResultStatus = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const orderId = clean(body(req).orderId, 200);
    const status = clean(body(req).status, 40).toUpperCase();
    const reason = clean(body(req).reason, 1000);
    if (!['NOT_PERFORMED', 'CANCELLED'].includes(status) || reason.length < 5) throw new HttpError(400, 'reason-required', 'Statut et motif détaillé requis.');
    const loaded = await loadOrder(orderId);
    if (!loaded) throw new HttpError(404, 'order-not-found', 'Commande introuvable.');
    await loaded.ref.set({ partnerResultStatus: status, partnerResultStatusReason: reason, partnerResultStatusUpdatedAt: nowIso(), partnerResultStatusUpdatedBy: user.uid, updatedAt: nowIso() }, { merge: true });
    await audit(user.uid, 'partner_order_result_status_changed', `healthOrders/${orderId}`, { status, reason, providerType: loaded.providerType });
    res.status(200).json({ ok: true, orderId, status });
  }));

  const healthAdminListResultRequirements = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const providerType = clean(req.query?.providerType, 30).toLowerCase();
    const snap = await db.collection('healthResultRequirements').limit(500).get();
    const requirements = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).filter((item) => !providerType || item.providerType === providerType).sort((a, b) => String(a.examName || a.examId).localeCompare(String(b.examName || b.examId)));
    res.status(200).json({ ok: true, requirements });
  }));

  const healthAdminSaveResultRequirements = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const payload = body(req);
    const providerType = clean(payload.providerType, 30).toLowerCase();
    const examId = clean(payload.examId, 200);
    const examName = clean(payload.examName, 180);
    const allowed = providerType === 'imaging' ? ['IMAGING', 'RADIOLOGY_REPORT', 'SUPPLEMENTAL'] : providerType === 'laboratory' ? ['LAB_RESULT', 'SUPPLEMENTAL'] : [];
    const requiredCategories = Array.isArray(payload.requiredCategories) ? [...new Set(payload.requiredCategories.map((item) => clean(item, 40).toUpperCase()))] : [];
    const maxFiles = Number(payload.maxFiles);
    const maxFileBytes = Number(payload.maxFileBytes);
    const allowedMimeTypes = Array.isArray(payload.allowedMimeTypes) ? [...new Set(payload.allowedMimeTypes.map((item) => clean(item, 80)))].filter((item) => ALLOWED_MIME.has(item)) : [...ALLOWED_MIME];
    if (!allowed.length || !examId || !examName || requiredCategories.some((item) => !allowed.includes(item)) || !requiredCategories.length || requiredCategories.includes('SUPPLEMENTAL') && payload.allowSupplemental !== true || !allowedMimeTypes.length || !Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > MAX_FILES || !Number.isInteger(maxFileBytes) || maxFileBytes < 1024 * 1024 || maxFileBytes > MAX_FILE_BYTES) {
      throw new HttpError(400, 'invalid-result-requirements', 'Indiquez le service, l’examen, au moins une pièce obligatoire et des limites de fichiers valides.');
    }
    const id = `${providerType}_${Buffer.from(examId).toString('base64url')}`;
    const requirements = { providerType, examId, examName, requiredCategories, allowSupplemental: payload.allowSupplemental === true, allowMultiplePerCategory: payload.allowMultiplePerCategory !== false, maxFiles, maxFileBytes, allowedMimeTypes, updatedAt: nowIso(), updatedByUid: user.uid };
    await db.collection('healthResultRequirements').doc(id).set(requirements, { merge: true });
    await audit(user.uid, 'result_requirements_configured', `healthResultRequirements/${id}`, { providerType, examId, requiredCategories, maxFiles, maxFileBytes });
    res.status(200).json({ ok: true, id, requirements });
  }));

  const healthAdminListPartnerResultSettlements = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const cursor = clean(req.query?.cursor, 200);
    let query = db.collection('healthPartnerResultSettlements').orderBy(adminSDK.firestore.FieldPath.documentId());
    if (cursor) {
      const cursorSnap = await db.collection('healthPartnerResultSettlements').doc(cursor).get();
      if (!cursorSnap.exists) throw new HttpError(400, 'invalid-settlement-cursor', 'Curseur de relevé invalide. Actualisez la liste.');
      query = query.startAfter(cursorSnap);
    }
    const snap = await query.limit(101).get();
    const pageDocs = snap.docs.slice(0, 100);
    const partnerUids = [...new Set(pageDocs.map((doc) => doc.data()?.partnerUid).filter(Boolean))];
    const partnerDocs = partnerUids.length ? await db.getAll(...partnerUids.map((uid) => db.collection('clients').doc(uid))) : [];
    const names = new Map(partnerUids.map((uid, index) => {
      const data = partnerDocs[index]?.data() || {};
      return [uid, data.partnerProfile?.businessName || data.displayName || uid];
    }));
    const settlements = pageDocs.map((doc) => ({ id: doc.id, ...doc.data(), partnerName: names.get(doc.data()?.partnerUid) || doc.data()?.partnerUid || 'Prestataire' })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const hasMore = snap.docs.length > 100;
    res.status(200).json({ ok: true, settlements, hasMore, nextCursor: hasMore ? pageDocs.at(-1)?.id || null : null });
  }));

  const healthAdminListPartnerResultsAudit = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const cursor = clean(req.query?.cursor, 200);
    let query = db.collection('healthAuditLogs').orderBy('createdAt', 'desc');
    if (cursor) {
      const cursorDoc = await db.collection('healthAuditLogs').doc(cursor).get();
      if (!cursorDoc.exists) throw new HttpError(400, 'invalid-cursor', 'Curseur d’historique invalide.');
      query = query.startAfter(cursorDoc);
    }
    const snap = await query.limit(501).get();
    const pageDocs = snap.docs.slice(0, 500);
    const events = pageDocs.map((doc) => ({ id: doc.id, ...doc.data() }))
      .filter((item) => /^(partner_portal_login|partner_result_|partner_order_|partner_results_|results_partner_|internal_order_)/.test(String(item.action || '')))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    res.status(200).json({ ok: true, events, hasMore: snap.docs.length > 500, nextCursor: snap.docs.length > 500 ? pageDocs.at(-1)?.id || null : null });
  }));

  const healthAdminListPartnerResultsAlerts = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const snap = await db.collection('healthAdminAlerts').where('module', '==', 'health-partner-results').limit(500).get();
    const alerts = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    await audit(user.uid, 'partner_results_alerts_listed', 'healthAdminAlerts', { count: alerts.length });
    res.status(200).json({ ok: true, alerts });
  }));

  const healthAdminCreatePartnerResultIssue = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const payload = body(req);
    const resultId = clean(payload.resultId, 200);
    const issueReason = clean(payload.reason, 1000);
    if (!resultId) throw new HttpError(400, 'result-id-required', 'Référence du résultat manquante.');
    if (issueReason.length < 5) throw new HttpError(400, 'reason-required', 'Un motif détaillé est obligatoire.');
    const resultSnap = await db.collection('healthPartnerResults').doc(resultId).get();
    if (!resultSnap.exists) throw new HttpError(404, 'result-not-found', 'Résultat introuvable.');
    const result = resultSnap.data() || {};
    const alertRef = await db.collection('healthAdminAlerts').add({ module: 'health-partner-results', type: 'RESULT_ISSUE', status: 'OPEN', resultId, orderId: result.orderId || null, examLineId: result.examLineId || null, partnerUid: result.partnerUid || null, providerType: result.providerType || null, actorUid: user.uid, issueReason, createdAt: nowIso(), updatedAt: nowIso(), title: 'Anomalie signalée sur un résultat' });
    await audit(user.uid, 'partner_results_issue_reported', `healthPartnerResults/${resultId}`, { alertId: alertRef.id, orderId: result.orderId || null, reason: issueReason });
    res.status(201).json({ ok: true, alertId: alertRef.id, status: 'OPEN' });
  }));

  const healthAdminResolvePartnerResultsAlert = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const payload = body(req);
    const alertId = clean(payload.alertId, 200);
    const reason = clean(payload.reason, 1000);
    if (!alertId) throw new HttpError(400, 'alert-id-required', 'Référence de l’alerte manquante.');
    if (reason.length < 5) throw new HttpError(400, 'reason-required', 'Un motif détaillé est obligatoire.');
    const ref = db.collection('healthAdminAlerts').doc(alertId);
    let alert;
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      alert = snap.data() || {};
      if (!snap.exists || alert.module !== 'health-partner-results') throw new HttpError(404, 'alert-not-found', 'Alerte introuvable.');
      if (alert.status === 'RESOLVED') return;
      transaction.update(ref, { status: 'RESOLVED', resolutionReason: reason, resolvedByUid: user.uid, resolvedAt: nowIso(), updatedAt: nowIso() });
    });
    await audit(user.uid, 'partner_results_alert_resolved', `healthAdminAlerts/${alertId}`, { type: alert.type, reason });
    res.status(200).json({ ok: true, alertId, status: 'RESOLVED' });
  }));

  const healthAdminCreatePartnerResultSettlement = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const resultIds = [...new Set((Array.isArray(body(req).resultIds) ? body(req).resultIds : []).map((id) => clean(id, 200)).filter(Boolean))];
    if (!resultIds.length || resultIds.length > 300) throw new HttpError(400, 'invalid-result-selection', 'Sélectionnez de 1 à 300 résultats éligibles.');
    const settlementRef = db.collection('healthPartnerResultSettlements').doc();
    const timestamp = nowIso();
    let settlement;
    await db.runTransaction(async (transaction) => {
      const refs = resultIds.map((id) => db.collection('healthPartnerResults').doc(id));
      const snapshots = [];
      for (const ref of refs) snapshots.push(await transaction.get(ref));
      const results = snapshots.map((snap) => snap.data() || {});
      if (snapshots.some((snap, index) => !snap.exists || !isPayoutEligible(results[index]))) throw new HttpError(409, 'result-no-longer-eligible', 'Un ou plusieurs résultats ne sont plus éligibles au paiement. Actualisez la liste.');
      const partnerUids = [...new Set(results.map((item) => item.partnerUid || item.providerUid))];
      if (partnerUids.length !== 1 || !partnerUids[0] || results.some((item) => item.partnerUid !== partnerUids[0])) throw new HttpError(400, 'mixed-partner-settlement', 'Un relevé de paiement doit concerner un seul partenaire externe.');
      const totals = payoutTotals(results);
      const lines = results.map((item, index) => ({ resultId: snapshots[index].id, orderId: item.orderId, examLineId: item.examLineId || null, examName: item.examName || null, providerType: item.providerType, partnerAmount: Number(item.partnerAmountSnapshot) || 0, validatedAt: item.reviewedAt || item.paymentEligibleAt }));
      settlement = { partnerUid: partnerUids[0], lineCount: totals.count, partnerAmount: totals.amount, lines, status: 'PENDING', currency: 'HTG', createdAt: timestamp, createdBy: user.uid, updatedAt: timestamp };
      snapshots.forEach((snap) => transaction.update(snap.ref, { settlementId: settlementRef.id, paymentStatus: 'PENDING', settlementCreatedAt: timestamp, settlementCreatedBy: user.uid, updatedAt: timestamp }));
      transaction.create(settlementRef, settlement);
    });
    await audit(user.uid, 'partner_result_settlement_created', `healthPartnerResultSettlements/${settlementRef.id}`, { partnerUid: settlement.partnerUid, lineCount: settlement.lineCount, partnerAmount: settlement.partnerAmount });
    res.status(200).json({ ok: true, settlementId: settlementRef.id, ...settlement });
  }));

  const healthAdminMarkPartnerResultSettlementPaid = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const id = clean(body(req).settlementId, 200);
    const paymentReference = clean(body(req).paymentReference, 200);
    if (!id || paymentReference.length < 3) throw new HttpError(400, 'payment-reference-required', 'Une référence de paiement valide est obligatoire.');
    const ref = db.collection('healthPartnerResultSettlements').doc(id);
    const timestamp = nowIso();
    let replay = false;
    await db.runTransaction(async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.data() || {};
      if (!snap.exists) throw new HttpError(404, 'settlement-not-found', 'Relevé de paiement introuvable.');
      if (current.status === 'PAID') { replay = true; return; }
      if (current.status !== 'PENDING') throw new HttpError(409, 'invalid-settlement-status', 'Seul un relevé en attente peut être payé.');
      const lines = Array.isArray(current.lines) ? current.lines : [];
      if (!lines.length || lines.length > 300) throw new HttpError(409, 'invalid-settlement-lines', 'Lignes du relevé invalides.');
      const results = [];
      for (const line of lines) results.push(await transaction.get(db.collection('healthPartnerResults').doc(line.resultId)));
      if (results.some((result, index) => !result.exists || result.data()?.settlementId !== id || result.data()?.paymentStatus !== 'PENDING' || result.data()?.partnerUid !== current.partnerUid)) throw new HttpError(409, 'settlement-lines-changed', 'Les résultats du relevé ont changé; contactez l’administration.');
      results.forEach((result) => transaction.update(result.ref, { paymentStatus: 'PAID', paidAt: timestamp, paidByUid: user.uid, paymentReference, updatedAt: timestamp }));
      transaction.update(ref, { status: 'PAID', paymentReference, paidAt: timestamp, paidByUid: user.uid, updatedAt: timestamp });
    });
    await audit(user.uid, 'partner_result_settlement_paid', `healthPartnerResultSettlements/${id}`, { paymentReference, idempotentReplay: replay });
    res.status(200).json({ ok: true, settlementId: id, status: 'PAID', idempotentReplay: replay });
  }));

  const healthAdminCreateResultsPartner = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const payload = body(req);
    let uid = clean(payload.uid, 200);
    const type = clean(payload.providerType, 30).toLowerCase();
    const name = clean(payload.name, 180);
    const email = clean(payload.email, 180).toLowerCase();
    const address = clean(payload.address, 400);
    const phone = clean(payload.phone, 80);
    const requestedStatus = clean(payload.status, 30).toLowerCase();
    const statusReason = clean(payload.reason, 800);
    const suppliedPassword = String(payload.initialPassword || '').trim().slice(0, 128);
    const selectedServices = Array.isArray(payload.services) ? [...new Set(payload.services.map((value) => clean(value, 30).toLowerCase()))] : null;
    if (!['laboratory', 'imaging', 'mixed'].includes(type) || !name || !clean(payload.responsibleName, 180) || !email || !address || !phone || !clean(payload.country, 100) || !clean(payload.department, 100) || !clean(payload.commune, 120)) throw new HttpError(400, 'invalid-partner-profile', 'Type, établissement, responsable, coordonnées et localisation sont requis.');
    if (selectedServices && (!selectedServices.length || selectedServices.some((service) => !['laboratory', 'imaging'].includes(service)) || (type === 'mixed') !== (selectedServices.length === 2) || type !== (selectedServices.length === 2 ? 'mixed' : selectedServices[0]))) throw new HttpError(400, 'invalid-partner-services', 'Sélectionnez des services autorisés valides.');
    if (requestedStatus && !['active', 'suspended', 'disabled'].includes(requestedStatus) || requestedStatus && requestedStatus !== 'active' && statusReason.length < 5) throw new HttpError(400, 'invalid-partner-status', 'Statut invalide ou motif trop court.');
    if (suppliedPassword && (suppliedPassword.length < 12 || !/[a-z]/.test(suppliedPassword) || !/[A-Z]/.test(suppliedPassword) || !/\d/.test(suppliedPassword) || !/[^A-Za-z0-9]/.test(suppliedPassword))) throw new HttpError(400, 'weak-partner-password', 'Le mot de passe doit compter au moins 12 caractères avec minuscule, majuscule, chiffre et symbole.');
    const initialStatus = requestedStatus || 'active';
    let partnerId = clean(payload.partnerId, 40).toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!uid) {
      if (partnerId && (await db.collection('healthPartnerLogins').doc(partnerId).get()).exists) throw new HttpError(409, 'partner-id-exists', 'Cet identifiant partenaire existe déjà.');
      while (!partnerId) {
        const candidate = `SCHP-${randomBytes(5).toString('hex').toUpperCase()}`;
        if (!(await db.collection('healthPartnerLogins').doc(candidate).get()).exists) partnerId = candidate;
      }
    }
    const generatedEmail = uid ? '' : `${partnerId.toLowerCase()}@partners.smartcuthealth.invalid`;
    let temporaryPassword = '';
    let authUser;
    let createdAuthUser = false;
    if (uid) {
      authUser = await adminSDK.auth().getUser(uid).catch(() => null);
      if (!authUser) throw new HttpError(404, 'partner-auth-user-not-found', 'Compte Firebase Auth introuvable.');
    } else {
      temporaryPassword = suppliedPassword || randomBytes(18).toString('base64url');
      try {
        authUser = await adminSDK.auth().createUser({ email: generatedEmail, password: temporaryPassword, displayName: name, emailVerified: false, disabled: initialStatus !== 'active' });
        uid = authUser.uid;
        createdAuthUser = true;
      } catch (error) {
        if (error?.code === 'auth/email-already-exists') throw new HttpError(409, 'partner-id-exists', 'Identifiant partenaire déjà utilisé. Réessayez la création.');
        throw error;
      }
    }
    const clientRef = db.collection('clients').doc(uid);
    const snap = await clientRef.get();
    const current = snap.data() || {};
    const typeToRole = type === 'imaging' ? 'imaging' : type === 'laboratory' ? 'laboratory' : current.role || 'health_partner';
    if (!typeToRole || !['imaging', 'laboratory', 'health_partner'].includes(String(typeToRole).toLowerCase())) {
      if (createdAuthUser) await adminSDK.auth().deleteUser(uid);
      throw new HttpError(400, 'partner-account-type-required', 'Type de compte partenaire invalide.');
    }
    const timestamp = nowIso();
    const status = requestedStatus || (createdAuthUser ? 'active' : String(current.partnerStatus || 'active').toLowerCase());
    const services = selectedServices || (type === 'mixed' ? ['laboratory', 'imaging'] : [type]);
    const profile = { ...(current.partnerProfile || {}), businessName: name, responsibleName: clean(payload.responsibleName, 180), email, address, country: clean(payload.country, 100), department: clean(payload.department, 100), commune: clean(payload.commune, 120), phones: Array.isArray(payload.phones) ? payload.phones.map((value) => clean(value, 80)).filter(Boolean).slice(0, 10) : [phone], services, openingHours: payload.openingHours && typeof payload.openingHours === 'object' ? payload.openingHours : {}, additionalInformation: clean(payload.additionalInformation, 1500), administrativeNotes: clean(payload.administrativeNotes, 3000), taxId: clean(payload.taxId, 80), contractDocuments: Array.isArray(current.partnerProfile?.contractDocuments) ? current.partnerProfile.contractDocuments : [], active: status === 'active', statusReason: statusReason || null, createdBy: current.partnerProfile?.createdBy || user.uid, updatedBy: user.uid, createdAt: current.partnerProfile?.createdAt || timestamp, updatedAt: timestamp };
    try {
      await clientRef.set({ role: typeToRole, partnerStatus: status, partnerType: type, partnerServices: services, partnerProfile: profile, displayName: name, email, phone, updatedAt: timestamp, ...(createdAuthUser ? { partnerId, partnerLoginEmail: generatedEmail } : {}) }, { merge: true });
      if (createdAuthUser) await db.collection('healthPartnerLogins').doc(partnerId).set({ uid, createdAt: timestamp, active: status === 'active' });
      else if (suppliedPassword || requestedStatus && requestedStatus !== String(current.partnerStatus || 'active').toLowerCase()) {
        await adminSDK.auth().updateUser(uid, { ...(suppliedPassword ? { password: suppliedPassword } : {}), ...(requestedStatus ? { disabled: status !== 'active' } : {}) });
        const updatedAuthUser = await adminSDK.auth().getUser(uid);
        await adminSDK.auth().setCustomUserClaims(uid, { ...(updatedAuthUser.customClaims || {}), healthPartner: status === 'active', healthPartnerType: type, healthPartnerStatus: status });
        if (status !== 'active') await adminSDK.auth().revokeRefreshTokens(uid);
        const existingPartnerId = clean(current.partnerId || authUser.customClaims?.healthPartnerId, 40);
        if (requestedStatus && existingPartnerId) await db.collection('healthPartnerLogins').doc(existingPartnerId).set({ uid, active: status === 'active', updatedAt: timestamp }, { merge: true });
      }
      const claims = { ...(authUser.customClaims || {}), healthPartner: status === 'active', healthPartnerId: partnerId || authUser.customClaims?.healthPartnerId || null, healthPartnerType: type, healthPartnerStatus: status, ...(createdAuthUser ? { healthPartnerMustChangePassword: true } : {}) };
      await adminSDK.auth().setCustomUserClaims(uid, claims);
      await audit(user.uid, createdAuthUser ? 'results_partner_account_created' : 'results_partner_profile_updated', `clients/${uid}`, { providerType: type, services });
    } catch (error) {
      if (createdAuthUser) await adminSDK.auth().deleteUser(uid).catch(() => {});
      throw error;
    }
    res.status(200).json({ ok: true, partner: { uid, partnerId: partnerId || authUser.customClaims?.healthPartnerId || null, name, email, phone, address, providerType: type, services, status, openingHours: profile.openingHours, responsibleName: profile.responsibleName, ...(createdAuthUser ? { temporaryPassword } : {}) } });
  }));

  const healthAdminListResultsPartners = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const [labs, imaging, mixed] = await Promise.all([
      db.collection('clients').where('role', '==', 'laboratory').limit(500).get(),
      db.collection('clients').where('role', '==', 'imaging').limit(500).get(),
      db.collection('clients').where('role', '==', 'health_partner').limit(500).get()
    ]);
    const docs = new Map([...labs.docs, ...imaging.docs, ...mixed.docs].filter((doc) => doc.data()?.partnerProfile).map((doc) => [doc.id, doc]));
    const partners = [...docs.values()].map((doc) => {
      const data = doc.data() || {}; const profile = data.partnerProfile || {};
      return { uid: doc.id, partnerId: data.partnerId || data.partnerProfile?.partnerId || null, providerType: data.partnerType || data.role || '', name: profile.businessName || data.displayName || doc.id, responsibleName: profile.responsibleName || '', email: profile.email || data.email || '', phones: profile.phones || [data.phone].filter(Boolean), address: profile.address || '', country: profile.country || '', department: profile.department || '', commune: profile.commune || '', taxId: profile.taxId || '', contractDocuments: Array.isArray(profile.contractDocuments) ? profile.contractDocuments.map(({ id, name, contentType, size, uploadedAt }) => ({ id, name, contentType, size, uploadedAt })) : [], administrativeNotes: profile.administrativeNotes || '', services: data.partnerServices || profile.services || [data.role], status: data.partnerStatus || data.labStatus || data.imagingStatus || 'pending', openingHours: profile.openingHours || {}, additionalInformation: profile.additionalInformation || '', createdAt: profile.createdAt || data.createdAt || null, updatedAt: profile.updatedAt || data.updatedAt || null };
    });
    await audit(user.uid, 'results_partners_admin_listed', 'clients', { count: partners.length });
    res.status(200).json({ ok: true, partners });
  }));

  const healthAdminSaveResultsPartnerContractDocuments = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const payload = body(req);
    const uid = clean(payload.uid, 200);
    const incoming = Array.isArray(payload.documents) ? payload.documents : [];
    if (!uid || !incoming.length || incoming.length > MAX_CONTRACT_FILES) throw new HttpError(400, 'invalid-contract-documents', 'Partenaire ou liste de documents invalide.');
    const partnerRef = db.collection('clients').doc(uid);
    const partnerSnap = await partnerRef.get();
    if (!partnerSnap.exists || !partnerSnap.data()?.partnerProfile) throw new HttpError(404, 'partner-not-found', 'Partenaire introuvable.');
    const current = partnerSnap.data().partnerProfile || {};
    const existing = Array.isArray(current.contractDocuments) ? current.contractDocuments : [];
    if (existing.length + incoming.length > MAX_CONTRACT_FILES) throw new HttpError(400, 'too-many-contract-documents', `Maximum ${MAX_CONTRACT_FILES} justificatifs par partenaire.`);
    const bucket = adminSDK.storage().bucket();
    const verified = [];
    for (const item of incoming) {
      const id = clean(item?.id, 100);
      const path = clean(item?.storagePath, 600);
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || path !== `health-partner-contracts/${user.uid}__${uid}/${id}` || existing.some((doc) => doc.storagePath === path) || verified.some((doc) => doc.storagePath === path)) {
        throw new HttpError(400, 'invalid-contract-document-path', 'Chemin de justificatif invalide.');
      }
      const file = bucket.file(path);
      const [exists] = await file.exists();
      if (!exists) throw new HttpError(400, 'contract-document-not-found', 'Un justificatif transmis est introuvable.');
      const [metadata] = await file.getMetadata();
      const mime = String(metadata?.contentType || '').toLowerCase();
      const size = Number(metadata?.size || 0);
      if (metadata?.metadata?.uploadedByUid !== user.uid || metadata?.metadata?.partnerUid !== uid || !ALLOWED_CONTRACT_MIME.has(mime) || !size || size > MAX_CONTRACT_FILE_BYTES) {
        throw new HttpError(400, 'invalid-contract-document', 'Format, taille ou propriétaire invalide pour un justificatif.');
      }
      verified.push({ id, storagePath: path, name: clean(item?.name, 180) || 'Justificatif', contentType: mime, size, uploadedByUid: user.uid, uploadedAt: nowIso() });
    }
    const timestamp = nowIso();
    await partnerRef.set({ partnerProfile: { contractDocuments: [...existing, ...verified], updatedBy: user.uid, updatedAt: timestamp }, updatedAt: timestamp }, { merge: true });
    await audit(user.uid, 'results_partner_contract_documents_added', `clients/${uid}`, { count: verified.length });
    res.status(200).json({ ok: true, documents: verified.map(({ id, name, contentType, size, uploadedAt }) => ({ id, name, contentType, size, uploadedAt })) });
  }));

  const healthAdminGetResultsPartnerContractDocumentUrl = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'GET') throw new HttpError(405, 'method-not-allowed', 'GET requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, false);
    const uid = clean(req.query?.uid, 200);
    const id = clean(req.query?.documentId, 100);
    const ref = db.collection('clients').doc(uid);
    const snap = await ref.get();
    const document = (snap.data()?.partnerProfile?.contractDocuments || []).find((item) => item.id === id);
    if (!snap.exists || !document?.storagePath || document.storagePath !== `health-partner-contracts/${document.uploadedByUid}__${uid}/${id}` || !document.uploadedByUid) throw new HttpError(404, 'contract-document-not-found', 'Justificatif introuvable.');
    const [url] = await adminSDK.storage().bucket().file(document.storagePath).getSignedUrl({ action: 'read', expires: Date.now() + 5 * 60 * 1000, responseDisposition: `attachment; filename="${String(document.name || 'justificatif').replace(/[\r\n"\\]/g, '_')}"` });
    await audit(user.uid, 'results_partner_contract_document_viewed', `clients/${uid}`, { documentId: id });
    res.status(200).json({ ok: true, url, expiresInSeconds: 300 });
  }));

  const healthAdminSetResultsPartnerStatus = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const uid = clean(body(req).uid, 200);
    const status = clean(body(req).status, 30).toLowerCase();
    const reason = clean(body(req).reason, 800);
    if (!uid || !['active', 'suspended', 'disabled'].includes(status) || status !== 'active' && reason.length < 5) throw new HttpError(400, 'invalid-partner-status', 'Statut invalide ou motif trop court.');
    const ref = db.collection('clients').doc(uid);
    const snap = await ref.get();
    if (!snap.exists || !snap.data()?.partnerProfile) throw new HttpError(404, 'results-partner-not-found', 'Partenaire résultats introuvable.');
    const timestamp = nowIso();
    await ref.set({ partnerStatus: status, partnerStatusReason: reason || null, partnerStatusUpdatedAt: timestamp, partnerStatusUpdatedBy: user.uid, partnerProfile: { ...snap.data().partnerProfile, active: status === 'active', updatedAt: timestamp } }, { merge: true });
    const authUser = await adminSDK.auth().getUser(uid).catch(() => null);
    if (authUser) {
      await adminSDK.auth().updateUser(uid, { disabled: status !== 'active' });
      if (status !== 'active') await adminSDK.auth().revokeRefreshTokens(uid);
      await adminSDK.auth().setCustomUserClaims(uid, { ...(authUser.customClaims || {}), healthPartner: status === 'active', healthPartnerStatus: status });
    }
    await audit(user.uid, 'results_partner_status_changed', `clients/${uid}`, { status, reason: reason || null });
    res.status(200).json({ ok: true, uid, status });
  }));

  const healthAdminResetResultsPartnerAccess = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    await authorizeAdmin(user, true);
    const uid = clean(body(req).uid, 200);
    const ref = db.collection('clients').doc(uid);
    const snap = await ref.get();
    if (!snap.exists || !snap.data()?.partnerProfile || !snap.data()?.partnerId) throw new HttpError(404, 'results-partner-not-found', 'Partenaire avec identifiant de connexion introuvable.');
    if (snap.data()?.partnerStatus !== 'active') throw new HttpError(409, 'partner-not-active', 'Réactivez le partenaire avant de réinitialiser son accès.');
    const partnerId = snap.data().partnerId;
    const temporaryPassword = randomBytes(18).toString('base64url');
    const authUser = await adminSDK.auth().getUser(uid);
    await adminSDK.auth().updateUser(uid, { password: temporaryPassword, disabled: false });
    await adminSDK.auth().setCustomUserClaims(uid, { ...(authUser.customClaims || {}), healthPartner: true, healthPartnerId: partnerId, healthPartnerStatus: 'active', healthPartnerMustChangePassword: true });
    await audit(user.uid, 'results_partner_access_reset', `clients/${uid}`, { partnerId });
    res.status(200).json({ ok: true, partnerId, temporaryPassword });
  }));

  const healthPartnerCompletePasswordChange = onRequest({ region }, withErrorHandling(async (req, res) => {
    if (req.method !== 'POST') throw new HttpError(405, 'method-not-allowed', 'POST requis.');
    const user = await requireBearerUser(req, { verifyBearerUser: verifyBearer });
    const password = String(body(req).newPassword || '');
    if (!isStrongPartnerPassword(password)) {
      throw new HttpError(400, 'weak-partner-password', 'Utilisez au moins 12 caractères avec une minuscule, une majuscule, un chiffre et un symbole.');
    }
    const snap = await db.collection('clients').doc(user.uid).get();
    const profile = snap.data() || {};
    if (!snap.exists || !profile.partnerId || profile.partnerStatus !== 'active') throw new HttpError(403, 'partner-account-inactive', 'Compte partenaire non autorisé.');
    const authUser = await adminSDK.auth().getUser(user.uid);
    await adminSDK.auth().updateUser(user.uid, { password });
    await adminSDK.auth().setCustomUserClaims(user.uid, { ...(authUser.customClaims || {}), healthPartner: true, healthPartnerId: profile.partnerId, healthPartnerType: profile.partnerType, healthPartnerStatus: profile.partnerStatus, healthPartnerMustChangePassword: false });
    await audit(user.uid, 'results_partner_temporary_password_changed', `clients/${user.uid}`, {});
    res.status(200).json({ ok: true });
  }));

  return { healthPartnerListOrders, healthPartnerGetResultsOverview, healthPartnerLookupOrder, healthPartnerSubmitResult, healthPartnerListResults, healthPartnerListOwnAudit, healthPartnerRecordPortalLogin, healthPartnerGetResultFileUrl, healthPartnerCompletePasswordChange, healthAdminListPartnerResults, healthAdminGetPartnerResultsOverview, healthAdminGetResultsPartnerReport, healthAdminGetPartnerResultHistory, healthAdminGetPartnerResultFileUrl, healthAdminReviewPartnerResult, healthAdminTransferPartnerResult, healthAdminSetPartnerOrderResultStatus, healthAdminListResultRequirements, healthAdminSaveResultRequirements, healthAdminListPartnerResultSettlements, healthAdminListPartnerResultsAudit, healthAdminListPartnerResultsAlerts, healthAdminCreatePartnerResultIssue, healthAdminResolvePartnerResultsAlert, healthAdminCreatePartnerResultSettlement, healthAdminMarkPartnerResultSettlementPaid, healthAdminCreateResultsPartner, healthAdminListResultsPartners, healthAdminSaveResultsPartnerContractDocuments, healthAdminGetResultsPartnerContractDocumentUrl, healthAdminSetResultsPartnerStatus, healthAdminResetResultsPartnerAccess };
}

module.exports = buildPartnerResults;
