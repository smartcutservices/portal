'use strict';

function isPayoutEligible(result = {}) {
  return result.source !== 'smartcut-health' && result.providerUid !== 'smartcut-health' &&
    Boolean(result.paymentEligibleAt) && ['VALIDATED', 'RESULT_AVAILABLE'].includes(String(result.status || '').toUpperCase()) &&
    !result.settlementId && String(result.paymentStatus || '').toUpperCase() !== 'PAID' &&
    result.examPerformed === true && Number.isFinite(Number(result.partnerAmountSnapshot)) && Number(result.partnerAmountSnapshot) > 0;
}

function payoutTotals(results = []) {
  return results.reduce((totals, result) => ({
    amount: Math.round((totals.amount + (Number(result.partnerAmountSnapshot) || 0)) * 100) / 100,
    count: totals.count + 1
  }), { amount: 0, count: 0 });
}

module.exports = { isPayoutEligible, payoutTotals };
