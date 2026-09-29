'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RESULT_STATUS, requiredCategories, validateResultFiles, canReviewResult, canTransferResult, adminViewedEveryResultFile, recordAdminResultFileView, isAuthorizedOrderDoctor, isAuthorizedResultDoctor, canDoctorReadRecordResults, isAuthorizedRecordDoctor, isEligiblePaidOrder, maskPatientName, isStrongPartnerPassword, matchesAdminResultFilters, countOrdersAwaitingResults, summarizePartnerResults, nextPartnerLookupAbuseAttempt } = require('./partnerResultsWorkflow');

test('uses order-specific requirements and safe defaults for lab/imaging', () => {
  assert.deepEqual(requiredCategories({}, 'laboratory'), ['LAB_RESULT']);
  assert.deepEqual(requiredCategories({}, 'imaging'), ['IMAGING']);
  assert.deepEqual(requiredCategories({ resultRequirements: { requiredCategories: ['IMAGING', 'RADIOLOGY_REPORT'] } }, 'imaging'), ['IMAGING', 'RADIOLOGY_REPORT']);
});

test('requires every configured category and rejects cross-service file types', () => {
  assert.deepEqual(validateResultFiles([{ category: 'IMAGING' }], 'imaging', ['IMAGING', 'RADIOLOGY_REPORT']), { ok: false, code: 'required-file-missing', missing: ['RADIOLOGY_REPORT'] });
  assert.equal(validateResultFiles([{ category: 'RADIOLOGY_REPORT' }], 'laboratory').code, 'invalid-file-category');
  assert.equal(validateResultFiles([{ category: 'LAB_RESULT' }], 'laboratory').ok, true);
  assert.equal(validateResultFiles([], 'laboratory').code, 'invalid-file-count');
});

test('result review and patient transfer are separate guarded transitions', () => {
  assert.equal(canReviewResult(RESULT_STATUS.PENDING_REVIEW, 'VALIDATE'), true);
  assert.equal(canReviewResult(RESULT_STATUS.VALIDATED, 'VALIDATE'), false);
  assert.equal(canReviewResult(RESULT_STATUS.PENDING_REVIEW, 'REQUEST_CORRECTION'), true);
  assert.equal(canTransferResult(RESULT_STATUS.VALIDATED, true), true);
  assert.equal(canTransferResult(RESULT_STATUS.PENDING_REVIEW, true), false);
  assert.equal(canTransferResult(RESULT_STATUS.VALIDATED, false), false);
});

test('admin must preview every result file before reviewing the result', () => {
  const result = { adminViewedAt: '2026-09-29T12:00:00Z', adminViewedByUid: 'admin-1', adminViewedFileIds: ['file-1'], files: [{ id: 'file-1' }] };
  assert.equal(adminViewedEveryResultFile(result, 'admin-1'), true);
  assert.equal(adminViewedEveryResultFile(result, 'admin-2'), false);
  assert.equal(adminViewedEveryResultFile({ ...result, adminViewedFileIds: [] }, 'admin-1'), false);
  assert.equal(adminViewedEveryResultFile({ ...result, files: [{ id: 'file-1' }, { id: 'file-2' }] }, 'admin-1'), false);
  assert.equal(adminViewedEveryResultFile({ ...result, files: [] }, 'admin-1'), false);
});

test('result file previews are tracked separately for each administrator', () => {
  const prior = { adminViewedByUid: 'admin-1', adminViewedFileIds: ['file-1', 'file-2'], files: [{ id: 'file-1' }, { id: 'file-2' }] };
  const afterSecondAdminViewsOne = recordAdminResultFileView(prior, 'admin-2', 'file-1', '2026-09-29T12:00:00Z');
  assert.deepEqual(afterSecondAdminViewsOne.adminViewedFileIds, ['file-1']);
  assert.equal(adminViewedEveryResultFile({ ...prior, ...afterSecondAdminViewsOne }, 'admin-2'), false);
  const afterSecondAdminViewsBoth = recordAdminResultFileView({ ...prior, ...afterSecondAdminViewsOne }, 'admin-2', 'file-2');
  assert.equal(adminViewedEveryResultFile({ ...prior, ...afterSecondAdminViewsBoth }, 'admin-2'), true);
});

test('only the prescribing or explicitly authorized doctor can access a transferred linked result', () => {
  const order = { id: 'order-1', patientUid: 'patient-1', prescribingDoctorUid: 'doctor-1', authorizedDoctorUids: ['doctor-2'] };
  const result = { orderId: 'order-1', patientUid: 'patient-1', status: RESULT_STATUS.PATIENT_VISIBLE, patientTransferredAt: '2026-09-29T12:00:00Z' };
  assert.equal(isAuthorizedOrderDoctor('doctor-1', order), true);
  assert.equal(isAuthorizedOrderDoctor('doctor-2', order), true);
  assert.equal(isAuthorizedResultDoctor('doctor-1', result, order), true);
  assert.equal(isAuthorizedResultDoctor('doctor-2', result, order), true);
  assert.equal(isAuthorizedResultDoctor('doctor-3', result, order), false);
  assert.equal(isAuthorizedResultDoctor('doctor-1', { ...result, status: RESULT_STATUS.PENDING_REVIEW }, order), false);
  assert.equal(isAuthorizedResultDoctor('doctor-1', { ...result, patientUid: 'other-patient' }, order), false);
  assert.equal(isAuthorizedResultDoctor('doctor-1', { ...result, orderId: 'other-order' }, order), false);
  const appointmentOrder = { id: 'appointment-order', patientUid: 'patient-1', providerUid: 'doctor-1', providerType: 'doctor', kind: 'appointment' };
  assert.equal(isAuthorizedOrderDoctor('doctor-1', appointmentOrder), true);
  assert.equal(isAuthorizedOrderDoctor('doctor-2', appointmentOrder), false);
  assert.equal(isAuthorizedOrderDoctor('doctor-1', { ...appointmentOrder, providerType: 'laboratory', kind: 'lab' }), false);
});

test('record result access requires the same doctor, appointment and patient on both records', () => {
  const record = { providerUid: 'doctor-1', appointmentId: 'appointment-1', patientUid: 'patient-1' };
  const appointment = { id: 'appointment-1', providerUid: 'doctor-1', patientUid: 'patient-1' };
  assert.equal(canDoctorReadRecordResults('doctor-1', record, appointment), true);
  assert.equal(canDoctorReadRecordResults('doctor-2', record, appointment), false);
  assert.equal(canDoctorReadRecordResults('doctor-1', record, { ...appointment, patientUid: 'patient-2' }), false);
  assert.equal(canDoctorReadRecordResults('doctor-1', record, { ...appointment, id: 'appointment-2' }), false);
  const order = { id: 'order-1', patientUid: 'patient-1', appointmentId: 'appointment-1' };
  const result = { orderId: 'order-1', patientUid: 'patient-1', status: RESULT_STATUS.PATIENT_VISIBLE, patientTransferredAt: '2026-09-29T12:00:00Z' };
  assert.equal(isAuthorizedRecordDoctor('doctor-1', record, appointment, order, result), true);
  assert.equal(isAuthorizedRecordDoctor('doctor-1', record, appointment, order, { ...result, status: RESULT_STATUS.PENDING_REVIEW }), false);
  assert.equal(isAuthorizedRecordDoctor('doctor-1', record, appointment, { ...order, appointmentId: null }, result), false);
  const prescription = { id: 'prescription-1', appointmentId: 'appointment-1', patientUid: 'patient-1', providerUid: 'doctor-1' };
  assert.equal(isAuthorizedRecordDoctor('doctor-1', record, appointment, { ...order, appointmentId: null, prescriptionId: prescription.id }, result, prescription), true);
  assert.equal(isAuthorizedRecordDoctor('doctor-2', record, appointment, order, result), false);
});

test('masks partner-facing patient identity', () => {
  assert.equal(maskPatientName({ firstName: 'Aurora', lastName: 'Mauresse' }), 'A***** M*****');
  assert.equal(maskPatientName({}), 'Patient');
});

test('partners cannot process payment-pending or unpaid orders', () => {
  assert.equal(isEligiblePaidOrder({ status: 'PAYMENT_PENDING', paymentStatus: 'PENDING' }), false);
  assert.equal(isEligiblePaidOrder({ status: 'EXAM_COMPLETED', paymentStatus: 'PENDING' }), false);
  assert.equal(isEligiblePaidOrder({ status: 'PROVIDER_ACCEPTED' }), false);
  assert.equal(isEligiblePaidOrder({ status: 'ACCEPTED' }), false);
  assert.equal(isEligiblePaidOrder({ status: 'PAID', paymentStatus: 'PAID' }), true);
  assert.equal(isEligiblePaidOrder({ status: 'PROVIDER_ACCEPTED', paymentStatus: 'OFFLINE' }), true);
  assert.equal(isEligiblePaidOrder({ status: 'PAID' }), true);
});

test('partner passwords require length, mixed case, a number, and a symbol', () => {
  assert.equal(isStrongPartnerPassword('Aa123456789!'), true);
  assert.equal(isStrongPartnerPassword('aA123456789'), false);
  assert.equal(isStrongPartnerPassword('AA123456789!'), false);
  assert.equal(isStrongPartnerPassword('Aaabcdefgh!'), false);
  assert.equal(isStrongPartnerPassword('Aa123456789!' + 'x'.repeat(117)), false);
});

test('admin result filters cover partner, exam, date, status, and payable state', () => {
  const item = { orderId: 'ORD-1', patientName: 'Patient Test', patientUid: 'patient-1', partnerUid: 'lab-1', partnerName: 'Lab One', examId: 'CBC', examName: 'Hémogramme', providerType: 'laboratory', status: 'VALIDATED', createdAt: '2026-09-12T10:00:00.000Z', source: 'external-partner', paymentEligibleAt: '2026-09-12T10:00:00.000Z', examPerformed: true, partnerAmountSnapshot: 500 };
  assert.equal(matchesAdminResultFilters(item, { q: 'patient test', partnerUid: 'lab-1', examId: 'CBC', from: '2026-09-01', to: '2026-09-30', status: 'VALIDATED', providerType: 'laboratory', paymentStatus: 'ELIGIBLE' }), true);
  assert.equal(matchesAdminResultFilters(item, { partnerUid: 'other-lab' }), false);
  assert.equal(matchesAdminResultFilters(item, { examId: 'CHEM' }), false);
  assert.equal(matchesAdminResultFilters(item, { from: '2026-09-13' }), false);
  assert.equal(matchesAdminResultFilters({ ...item, settlementId: 'settlement-1' }, { paymentStatus: 'ELIGIBLE' }), false);
  assert.equal(matchesAdminResultFilters({ ...item, source: 'smartcut-health' }, { paymentStatus: 'BLOCKED' }), false);
});

test('counts pending result lines independently and excludes cancelled or refunded exams', () => {
  const orders = [
    { id: 'order-1', items: [{ id: 'cbc', realizationStatus: 'PERFORMED' }, { id: 'urine', realizationStatus: 'PAID' }] },
    { id: 'order-2', items: [{ id: 'xray', realizationStatus: 'CANCELLED' }] },
    { id: 'order-3', resultId: 'legacy-result', examName: 'Glycémie' }
  ];
  const results = [{ orderId: 'order-1', examLineId: 'cbc' }];
  assert.equal(countOrdersAwaitingResults(orders, results), 1);
});

test('partner dashboard metrics count every paid exam line and the latest correction state', () => {
  const orders = [
    { id: 'order-1', kind: 'laboratory_exam', providerType: 'laboratory', status: 'PAID', paymentStatus: 'PAID', items: [{ resultLineId: 'line-1' }, { resultLineId: 'line-2' }] },
    { id: 'order-2', kind: 'imaging', providerType: 'imaging', status: 'PAYMENT_PENDING', paymentStatus: 'PENDING', items: [{ resultLineId: 'line-3' }] }
  ];
  const results = [
    { orderId: 'order-1', examLineId: 'line-1', version: 1, status: RESULT_STATUS.CORRECTION_REQUESTED, createdAt: '2026-09-29T13:00:00.000Z' },
    { orderId: 'order-1', examLineId: 'line-1', version: 2, status: RESULT_STATUS.PENDING_REVIEW, createdAt: '2026-09-29T14:00:00.000Z' },
    { orderId: 'order-1', examLineId: 'line-2', version: 1, status: RESULT_STATUS.VALIDATED, createdAt: '2026-09-29T12:00:00.000Z' }
  ];
  assert.deepEqual(summarizePartnerResults(orders, results, { todayStart: '2026-09-29T04:00:00.000Z', monthStart: '2026-09-01T04:00:00.000Z' }), {
    assignedOrders: 1,
    awaitingUpload: 0,
    resultsUploadedToday: 3,
    resultsUploadedThisMonth: 3,
    correctionsPending: 0,
    awaitingAdminReview: 1,
    examsValidated: 1
  });
});

test('partner metrics leave only missing and current correction lines to upload', () => {
  const orders = [{ id: 'order-1', kind: 'imaging', providerType: 'imaging', status: 'ACCEPTED', paymentStatus: 'PAID', items: [{ resultLineId: 'image-line' }, { resultLineId: 'report-line' }] }];
  const results = [{ orderId: 'order-1', examLineId: 'image-line', version: 2, status: RESULT_STATUS.CORRECTION_REQUESTED, createdAt: '2026-09-29T10:00:00.000Z' }];
  const summary = summarizePartnerResults(orders, results);
  assert.equal(summary.awaitingUpload, 2);
  assert.equal(summary.correctionsPending, 1);
});

test('raises one partner lookup alert per window and resets the counter in a new window', () => {
  let counter = {};
  const alerts = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const next = nextPartnerLookupAbuseAttempt(counter, 100);
    if (next.shouldAlert) alerts.push(attempt + 1);
    counter = { ...next, windowKey: 100 };
  }
  assert.deepEqual(alerts, [5]);
  assert.deepEqual(nextPartnerLookupAbuseAttempt(counter, 101), { attemptCount: 1, shouldAlert: false, alertCreated: false });
});
