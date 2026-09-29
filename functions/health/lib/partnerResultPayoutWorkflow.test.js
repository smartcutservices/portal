'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isPayoutEligible, payoutTotals } = require('./partnerResultPayoutWorkflow');

test('only externally performed, reviewed and unsettled results qualify for payout', () => {
  const eligible = { source: 'external-partner', providerUid: 'lab-1', paymentEligibleAt: 'now', status: 'VALIDATED', examPerformed: true, partnerAmountSnapshot: 125 };
  assert.equal(isPayoutEligible(eligible), true);
  assert.equal(isPayoutEligible({ ...eligible, source: 'smartcut-health' }), false);
  assert.equal(isPayoutEligible({ ...eligible, status: 'RESULT_PENDING_REVIEW' }), false);
  assert.equal(isPayoutEligible({ ...eligible, examPerformed: false }), false);
  assert.equal(isPayoutEligible({ ...eligible, settlementId: 'S1' }), false);
  assert.equal(isPayoutEligible({ ...eligible, paymentStatus: 'PAID' }), false);
});

test('payout totals are calculated from immutable partner amount snapshots', () => {
  assert.deepEqual(payoutTotals([{ partnerAmountSnapshot: 100 }, { partnerAmountSnapshot: 25.55 }]), { amount: 125.55, count: 2 });
});
