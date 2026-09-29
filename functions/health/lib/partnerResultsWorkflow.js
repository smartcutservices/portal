'use strict';

const { isPayoutEligible } = require('./partnerResultPayoutWorkflow');

const RESULT_STATUS = Object.freeze({
  PENDING_REVIEW: 'RESULT_PENDING_REVIEW',
  CORRECTION_REQUESTED: 'CORRECTION_REQUESTED',
  VALIDATED: 'VALIDATED',
  PATIENT_VISIBLE: 'RESULT_AVAILABLE',
  NOT_PERFORMED: 'NOT_PERFORMED',
  SUPERSEDED: 'SUPERSEDED'
});

const FILE_CATEGORIES = Object.freeze({
  LABORATORY: new Set(['LAB_RESULT', 'SUPPLEMENTAL']),
  IMAGING: new Set(['IMAGING', 'RADIOLOGY_REPORT', 'SUPPLEMENTAL'])
});
function isEligiblePaidOrder(order = {}) {
  const status = String(order.status || '').toUpperCase();
  const payment = String(order.paymentStatus || '').toUpperCase();
  if (payment) return ['PAID', 'OFFLINE', 'FREE'].includes(payment);
  return status === 'PAID';
}

function requiredCategories(order, providerType) {
  const configured = order?.resultRequirements?.requiredCategories;
  if (Array.isArray(configured) && configured.length) return [...new Set(configured.map((item) => String(item).trim().toUpperCase()))];
  const itemRequirements = (Array.isArray(order?.items) ? order.items : [])
    .flatMap((item) => Array.isArray(item?.resultRequirements?.requiredCategories) ? item.resultRequirements.requiredCategories : []);
  if (itemRequirements.length) return [...new Set(itemRequirements.map((item) => String(item).trim().toUpperCase()))];
  return providerType === 'imaging' ? ['IMAGING'] : ['LAB_RESULT'];
}

function validateResultFiles(files, providerType, required = []) {
  if (!Array.isArray(files) || files.length < 1 || files.length > 20) return { ok: false, code: 'invalid-file-count' };
  const allowed = FILE_CATEGORIES[providerType === 'imaging' ? 'IMAGING' : 'LABORATORY'];
  const categories = new Set();
  for (const file of files) {
    const category = String(file?.category || '').trim().toUpperCase();
    if (!allowed.has(category)) return { ok: false, code: 'invalid-file-category' };
    categories.add(category);
  }
  const missing = required.filter((category) => !categories.has(category));
  return missing.length ? { ok: false, code: 'required-file-missing', missing } : { ok: true };
}

function canReviewResult(status, action) {
  if (status !== RESULT_STATUS.PENDING_REVIEW) return false;
  return ['VALIDATE', 'REQUEST_CORRECTION', 'NOT_PERFORMED'].includes(action);
}

function canTransferResult(status, performed) {
  return status === RESULT_STATUS.VALIDATED && performed === true;
}

function adminViewedEveryResultFile(result = {}, adminUid) {
  const files = Array.isArray(result.files) ? result.files : [];
  const viewedIds = new Set(Array.isArray(result.adminViewedFileIds) ? result.adminViewedFileIds : []);
  return Boolean(result.adminViewedAt && adminUid && result.adminViewedByUid === adminUid && files.length
    && files.every((file) => typeof file?.id === 'string' && viewedIds.has(file.id)));
}

function recordAdminResultFileView(result = {}, adminUid, fileId, timestamp = new Date().toISOString()) {
  const viewedIds = result.adminViewedByUid === adminUid && Array.isArray(result.adminViewedFileIds) ? result.adminViewedFileIds : [];
  return { adminViewedAt: timestamp, adminViewedByUid: adminUid, adminViewedFileIds: [...new Set([...viewedIds, fileId])] };
}

function isAuthorizedOrderDoctor(uid, order = {}) {
  if (!uid) return false;
  const assignedAppointmentDoctor = order.providerUid === uid
    && (order.providerType === 'doctor' || order.kind === 'appointment' || ['teleconsultation', 'rendezvous'].includes(order.bookingType));
  return order.prescribingDoctorUid === uid || assignedAppointmentDoctor
    || (Array.isArray(order.authorizedDoctorUids) && order.authorizedDoctorUids.includes(uid));
}

function canDoctorReadRecordResults(uid, record = {}, appointment = {}) {
  return Boolean(uid && record.providerUid === uid && record.appointmentId
    && record.appointmentId === appointment.id && record.patientUid
    && record.patientUid === appointment.patientUid && appointment.providerUid === uid);
}

function isAuthorizedRecordDoctor(uid, record = {}, appointment = {}, order = {}, result = {}, prescription = null) {
  const appointmentOrder = order.appointmentId === appointment.id && order.patientUid === record.patientUid;
  const prescriptionOrder = Boolean(prescription && order.prescriptionId === prescription.id
    && prescription.appointmentId === appointment.id && prescription.patientUid === record.patientUid
    && prescription.providerUid === uid);
  return canDoctorReadRecordResults(uid, record, appointment) && (appointmentOrder || prescriptionOrder)
    && result.orderId === order.id && result.patientUid === record.patientUid
    && result.status === RESULT_STATUS.PATIENT_VISIBLE && Boolean(result.patientTransferredAt);
}

function isAuthorizedResultDoctor(uid, result = {}, order = {}) {
  return Boolean(result.orderId && result.orderId === order.id && result.patientUid === order.patientUid
    && result.status === RESULT_STATUS.PATIENT_VISIBLE && result.patientTransferredAt
    && (isAuthorizedOrderDoctor(uid, order) || result.prescribingDoctorUid === uid
      || (Array.isArray(result.authorizedDoctorUids) && result.authorizedDoctorUids.includes(uid))));
}

function maskPatientName(profile = {}) {
  const first = String(profile.firstName || profile.prenom || '').trim();
  const last = String(profile.lastName || profile.nom || '').trim();
  const firstName = first ? `${first.slice(0, 1)}${'*'.repeat(Math.min(Math.max(first.length - 1, 2), 5))}` : '';
  const lastName = last ? `${last.slice(0, 1)}${'*'.repeat(Math.min(Math.max(last.length - 1, 2), 5))}` : '';
  return [firstName, lastName].filter(Boolean).join(' ') || 'Patient';
}

function isStrongPartnerPassword(password) {
  const value = String(password || '');
  return value.length >= 12 && value.length <= 128 && /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value) && /[^A-Za-z0-9]/.test(value);
}

function matchesAdminResultFilters(item = {}, filters = {}) {
  const query = String(filters.q || '').toLowerCase();
  const createdAt = String(item.createdAt || '').slice(0, 10);
  const paymentStatus = String(filters.paymentStatus || '').toUpperCase();
  if (filters.status && item.status !== filters.status) return false;
  if (filters.providerType && item.providerType !== filters.providerType) return false;
  if (filters.partnerUid && item.partnerUid !== filters.partnerUid) return false;
  if (filters.examId && item.examId !== filters.examId) return false;
  if (filters.from && (!createdAt || createdAt < filters.from)) return false;
  if (filters.to && (!createdAt || createdAt > filters.to)) return false;
  if (paymentStatus === 'ELIGIBLE' && !isPayoutEligible(item)) return false;
  if (paymentStatus === 'BLOCKED' && (item.source === 'smartcut-health' || item.paymentStatus === 'PAID' || item.paymentStatus === 'PENDING' || isPayoutEligible(item))) return false;
  if (paymentStatus === 'PAID' && String(item.paymentStatus || '').toUpperCase() !== 'PAID') return false;
  if (query && ![item.orderId, item.patientName, item.patientLabel, item.partnerName, item.examName, item.examId, item.patientUid].some((value) => String(value || '').toLowerCase().includes(query))) return false;
  return true;
}

function countOrdersAwaitingResults(orders = [], results = []) {
  const resultsByOrder = new Map();
  for (const result of results) {
    const key = String(result.orderId || '');
    if (!key) continue;
    if (!resultsByOrder.has(key)) resultsByOrder.set(key, []);
    resultsByOrder.get(key).push(result);
  }
  let missing = 0;
  for (const order of orders) {
    const items = Array.isArray(order.items) && order.items.length ? order.items : [order];
    const lines = items.map((item, index) => ({
      item,
      id: String(item.resultLineId || item.lineId || item.id || item.orderItemId || (order.id ? `${order.id}_${index + 1}` : `line_${index}`))
    }));
    const orderResults = resultsByOrder.get(String(order.id || '')) || [];
    for (const line of lines) {
      const realization = String(line.item.realizationStatus || '').toUpperCase();
      if (['NOT_PERFORMED', 'CANCELLED', 'REFUNDED'].includes(realization)) continue;
      const hasResult = orderResults.some((result) => result.examLineId
        ? result.examLineId === line.id
        : lines.length === 1)
        || (lines.length === 1 && Boolean(order.partnerResultId || order.resultId));
      if (!hasResult) missing += 1;
    }
  }
  return missing;
}

function summarizePartnerResults(orders = [], results = [], { todayStart, monthStart } = {}) {
  const activeStatuses = new Set(['PAID', 'ACCEPTED', 'PROVIDER_ACCEPTED', 'PATIENT_PRESENTED', 'SAMPLE_COLLECTED', 'SAMPLE_RECEIVED', 'ANALYSIS_IN_PROGRESS', 'EXAM_COMPLETED', 'RESULT_PENDING_REVIEW', 'CORRECTION_REQUESTED']);
  const eligibleOrders = orders.filter((order) => {
    const kindMatches = (order.kind === 'laboratory_exam' && order.providerType === 'laboratory') || (order.kind === 'imaging' && order.providerType === 'imaging');
    const status = String(order.status || '').toUpperCase();
    const completedLabLine = order.kind === 'laboratory_exam' && (Array.isArray(order.items) ? order.items : []).some((item) => ['PERFORMED', 'COMPLETED', 'EXAM_COMPLETED'].includes(String(item.realizationStatus || '').toUpperCase()));
    return kindMatches && isEligiblePaidOrder(order) && (activeStatuses.has(status) || completedLabLine);
  });
  const latestByLine = new Map();
  for (const result of results) {
    const key = `${result.orderId || ''}:${result.examLineId || ''}`;
    const previous = latestByLine.get(key);
    if (!previous || Number(result.version || 1) > Number(previous.version || 1)
      || Number(result.version || 1) === Number(previous.version || 1) && String(result.createdAt || '') > String(previous.createdAt || '')) latestByLine.set(key, result);
  }
  let awaitingUpload = 0;
  for (const order of eligibleOrders) {
    const items = Array.isArray(order.items) && order.items.length ? order.items : [order];
    items.forEach((item, index) => {
      const realization = String(item.realizationStatus || '').toUpperCase();
      if (['NOT_PERFORMED', 'CANCELLED', 'REFUNDED'].includes(realization)) return;
      const lineId = String(item.resultLineId || item.lineId || item.id || item.orderItemId || `${order.id}_${index + 1}`);
      const result = latestByLine.get(`${order.id}:${lineId}`) || (items.length === 1 ? latestByLine.get(`${order.id}:`) : null);
      if (!result || result.status === RESULT_STATUS.CORRECTION_REQUESTED) awaitingUpload += 1;
    });
  }
  const resultDate = (result) => {
    const value = result.createdAt?.toDate ? result.createdAt.toDate().toISOString() : String(result.createdAt || '');
    return value;
  };
  const latest = [...latestByLine.values()];
  return {
    assignedOrders: eligibleOrders.length,
    awaitingUpload,
    resultsUploadedToday: todayStart ? results.filter((result) => resultDate(result) >= todayStart).length : 0,
    resultsUploadedThisMonth: monthStart ? results.filter((result) => resultDate(result) >= monthStart).length : 0,
    correctionsPending: latest.filter((result) => result.status === RESULT_STATUS.CORRECTION_REQUESTED).length,
    awaitingAdminReview: latest.filter((result) => result.status === RESULT_STATUS.PENDING_REVIEW).length,
    examsValidated: latest.filter((result) => [RESULT_STATUS.VALIDATED, RESULT_STATUS.PATIENT_VISIBLE].includes(result.status)).length
  };
}

function nextPartnerLookupAbuseAttempt(previous = {}, windowKey, threshold = 5) {
  const sameWindow = Number(previous.windowKey) === Number(windowKey);
  const attemptCount = sameWindow ? Number(previous.attemptCount || 0) + 1 : 1;
  const shouldAlert = attemptCount >= threshold && !(sameWindow && previous.alertCreated === true);
  return { attemptCount, shouldAlert, alertCreated: Boolean((sameWindow && previous.alertCreated) || shouldAlert) };
}

module.exports = { RESULT_STATUS, FILE_CATEGORIES, requiredCategories, validateResultFiles, canReviewResult, canTransferResult, adminViewedEveryResultFile, recordAdminResultFileView, isAuthorizedOrderDoctor, isAuthorizedResultDoctor, canDoctorReadRecordResults, isAuthorizedRecordDoctor, isEligiblePaidOrder, maskPatientName, isStrongPartnerPassword, matchesAdminResultFilters, countOrdersAwaitingResults, summarizePartnerResults, nextPartnerLookupAbuseAttempt };
