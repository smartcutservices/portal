'use strict';

const SMART_CUT_PROVIDER_ID = 'smartcut-health';

const MANAGED_PROVIDER_LABELS = {
  pharmacy: 'Pharmacie Smart Cut Health',
  laboratory: 'Laboratoire Smart Cut Health',
  imaging: 'Imagerie médicale Smart Cut Health'
};

function managedProvider(type, overrides = {}) {
  return {
    id: SMART_CUT_PROVIDER_ID,
    type,
    name: MANAGED_PROVIDER_LABELS[type] || 'Smart Cut Health',
    businessName: MANAGED_PROVIDER_LABELS[type] || 'Smart Cut Health',
    address: 'Smart Cut Health',
    department: '',
    commune: '',
    phone: '',
    managedBySmartCut: true,
    ...overrides
  };
}

function isManagedProviderId(value) {
  return String(value || '').trim() === SMART_CUT_PROVIDER_ID;
}

module.exports = { SMART_CUT_PROVIDER_ID, MANAGED_PROVIDER_LABELS, managedProvider, isManagedProviderId };