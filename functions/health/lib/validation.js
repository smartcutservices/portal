'use strict';

/**
 * Pure business logic for Smart Cut Health — Phase 1 (Pharmacy). No Firestore/Admin
 * SDK dependency here so it can be unit-tested without the emulator, same principle
 * as functions/smartsolutiontek/lib/*.js. Cloud Functions in ../index.js call into
 * this module for anything that isn't a direct read/write, and never let a client
 * supply a price, a status, or a search index directly — everything here recomputes
 * or validates from trusted server-side inputs.
 */

const PRESCRIPTION_STATUSES = [
  'RECEIVED', 'UNDER_REVIEW', 'VALIDATED', 'PRICE_CONFIRMED', 'PAYMENT_PENDING',
  'PAID', 'PREPARING', 'READY', 'DELIVERING', 'DELIVERED',
  'NEEDS_CLARIFICATION', 'REJECTED', 'CANCELLED'
];

// Allowed next-status set per current status. A transition not listed here is refused —
// this is the single source of truth the Cloud Functions check before any status write,
// so a prescription can never skip steps (e.g. RECEIVED straight to PAID) regardless of
// what a client requests.
const PRESCRIPTION_TRANSITIONS = {
  RECEIVED: ['UNDER_REVIEW', 'REJECTED', 'CANCELLED'],
  UNDER_REVIEW: ['VALIDATED', 'NEEDS_CLARIFICATION', 'REJECTED', 'CANCELLED'],
  NEEDS_CLARIFICATION: ['UNDER_REVIEW', 'CANCELLED'],
  VALIDATED: ['PRICE_CONFIRMED', 'CANCELLED'],
  PRICE_CONFIRMED: ['PAYMENT_PENDING', 'CANCELLED'],
  PAYMENT_PENDING: ['PAID', 'CANCELLED'],
  PAID: ['PREPARING'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['DELIVERING', 'DELIVERED'],
  DELIVERING: ['DELIVERED'],
  DELIVERED: [],
  REJECTED: [],
  CANCELLED: []
};

// Nouvelle (PAID) -> Acceptée (ACCEPTED) -> En préparation (PREPARING) -> Prête (READY)
// -> Remise/Livrée (DELIVERED, via DELIVERING for an in-transit delivery) -> Terminée
// (COMPLETED). REFUNDED is a distinct terminal state from CANCELLED: a pharmacy
// always *requests* "CANCELLED" (the same action button either way), but the caller
// (healthUpdateOrderFulfillment) stores REFUNDED instead whenever payment had already
// been captured (order.status was already past PAYMENT_PENDING) — see its own comment.
const ORDER_FULFILLMENT_STATUSES = ['PAYMENT_PENDING', 'PAID', 'ACCEPTED', 'PREPARING', 'READY', 'DELIVERING', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'REFUNDED'];

const ORDER_TRANSITIONS = {
  PAYMENT_PENDING: ['PAID', 'CANCELLED'],
  PAID: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['READY', 'CANCELLED'],
  READY: ['DELIVERING', 'DELIVERED'],
  DELIVERING: ['DELIVERED'],
  DELIVERED: ['COMPLETED'],
  COMPLETED: [],
  CANCELLED: [],
  REFUNDED: []
};

function canTransitionPrescription(fromStatus, toStatus) {
  const allowed = PRESCRIPTION_TRANSITIONS[String(fromStatus || '')];
  return Array.isArray(allowed) && allowed.includes(String(toStatus || ''));
}

function canTransitionOrder(fromStatus, toStatus) {
  const allowed = ORDER_TRANSITIONS[String(fromStatus || '')];
  return Array.isArray(allowed) && allowed.includes(String(toStatus || ''));
}

/** User-facing French label for a prescription status — never show the raw enum to a patient. */
const PRESCRIPTION_STATUS_LABELS = {
  RECEIVED: 'Ordonnance reçue',
  UNDER_REVIEW: 'En cours de vérification',
  VALIDATED: "Vérifiée — en attente d'offres",
  PRICE_CONFIRMED: 'Prix confirmé',
  PAYMENT_PENDING: 'En attente de paiement',
  PAID: 'Payée',
  PREPARING: 'En préparation',
  READY: 'Prête',
  DELIVERING: 'En livraison',
  DELIVERED: 'Livrée',
  NEEDS_CLARIFICATION: 'Précision demandée',
  REJECTED: 'Non traitée',
  CANCELLED: 'Annulée'
};

function prescriptionStatusLabel(status) {
  return PRESCRIPTION_STATUS_LABELS[String(status || '')] || 'Statut inconnu';
}

/**
 * Computes an offer's total strictly from the pharmacy's own catalog prices — the
 * `items` a pharmacy submits (which productId, which quantity, available or not) are
 * trusted, but never a price on the item itself. `catalog` is a Map<productId, {price}>
 * built by the caller from a fresh Firestore read of that pharmacy's own products.
 * Throws if an item references a product not in the catalog (can't happen honestly —
 * either a stale id or an attempt to reference another pharmacy's product).
 */
function getEffectiveMedicinePrice(product = {}, now = Date.now(), promotionCode = "") {
  const price = Math.max(0, Number(product.price) || 0);
  const explicitPromotionPrice = Math.max(0, Number(product.promotionPrice) || 0);
  const promotionPercent = Math.min(100, Math.max(0, Number(product.promotionPercent) || 0));
  const promotionPrice = explicitPromotionPrice > 0 ? explicitPromotionPrice : (promotionPercent > 0 ? price * (1 - promotionPercent / 100) : 0);
  const configuredPromotionCode = normalizePromotionToken(product.promotionCode);
  if (configuredPromotionCode && configuredPromotionCode !== normalizePromotionToken(promotionCode)) return price;
  const start = Date.parse(String(product.promotionStartAt || ''));
  const end = Date.parse(String(product.promotionEndAt || ''));
  const hasPromotionWindow = Boolean(product.promotionStartAt || product.promotionEndAt);
  const promotionIsActive = !hasPromotionWindow || (Number.isFinite(start) && Number.isFinite(end) && now >= start && now < end);
  if (promotionPrice > 0 && promotionPrice < price && promotionIsActive) {
    return Math.round(promotionPrice * 100) / 100;
  }
  return price;
}

function normalizePromotionToken(value) {
  return String(value || '').trim().toLocaleLowerCase();
}

function getMedicinePromotionContext(product = {}, item = {}) {
  const tokens = new Set();
  [
    item.productId,
    product.id,
    product.category,
    product.subcategory,
    product.therapeuticClass,
    product.therapeuticSubclass,
    product.internalSku,
    product.gtin,
    ...(Array.isArray(product.tags) ? product.tags : [])
  ].forEach((value) => {
    const token = normalizePromotionToken(value);
    if (token) tokens.add(token);
  });
  return tokens;
}

function calculateMedicineLinePricing(product = {}, { qty = 1, promotionCode = '', item = {} } = {}, now = Date.now()) {
  const quantity = Math.max(1, Math.floor(Number(qty) || 1));
  const baseUnitPrice = Math.max(0, Number(product.price) || 0);
  const promotionUnitPrice = getEffectiveMedicinePrice(product, now, promotionCode);
  const configuredCode = normalizePromotionToken(product.promotionCode);
  const providedCode = normalizePromotionToken(promotionCode);
  const codeMatches = !configuredCode || configuredCode === providedCode;
  const exclusions = Array.isArray(product.promotionExclusions) ? product.promotionExclusions : [];
  const contextTokens = getMedicinePromotionContext(product, item);
  const excluded = exclusions.some((value) => contextTokens.has(normalizePromotionToken(value)));
  const promotionAvailable = promotionUnitPrice < baseUnitPrice && codeMatches && !excluded;
  const configuredLimit = Math.max(0, Math.floor(Number(product.promotionQuantityLimit) || 0));
  const promotionAppliedQty = promotionAvailable ? (configuredLimit > 0 ? Math.min(quantity, configuredLimit) : quantity) : 0;
  const regularQty = quantity - promotionAppliedQty;
  const lineTotal = (promotionAppliedQty * promotionUnitPrice) + (regularQty * baseUnitPrice);
  return {
    baseUnitPrice,
    promotionUnitPrice,
    effectiveUnitPrice: quantity > 0 ? Math.round((lineTotal / quantity) * 100) / 100 : baseUnitPrice,
    promotionAppliedQty,
    regularQty,
    lineTotal: Math.round(lineTotal * 100) / 100,
    promotionApplied: promotionAppliedQty > 0
  };
}

function computeOfferTotal(items, catalog) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error('at-least-one-item-required');
  }
  const lines = items.map((item) => {
    const productId = String(item?.productId || '').trim();
    const qty = Math.max(0, Math.floor(Number(item?.qty) || 0));
    const available = item?.available !== false;
    if (!productId) throw new Error('invalid-item-product-id');
    if (available && qty < 1) throw new Error('available-item-quantity-required');
    const product = catalog.get(productId);
    if (!product) throw new Error(`unknown-product:${productId}`);
    const unitPrice = getEffectiveMedicinePrice(product);
    const lineTotal = available ? unitPrice * qty : 0;
    return { productId, name: product.name || '', qty, available, unitPrice, lineTotal };
  });
  const subtotal = lines.reduce((sum, line) => sum + line.lineTotal, 0);
  const allAvailable = lines.every((line) => line.available);
  return { lines, subtotal, allAvailable };
}

const MAX_TEXT_LENGTH = 200;

function sanitizeText(value, maxLen = MAX_TEXT_LENGTH) {
  return String(value ?? '').trim().slice(0, maxLen);
}

// Reference lists for the pharmacy product form — kept here (not hardcoded twice in
// the frontend) so the catalog UI and the server validation always agree. The server
// never rejects a form/class outside these lists (a pharmacist's own wording for a
// niche product is still accepted as free text) — they exist to populate a clean
// dropdown, not to gate what can be sold.
const medicineReferenceCatalog = require('./medicineReferenceCatalog.json');
const medicineFormCatalog = require('./medicineFormCatalog.json');
const medicineAdministrationRouteCatalog = require('./medicineAdministrationRouteCatalog.json');

// Keep the complete PDF annex as the single source for the pharmacy reference
// dropdowns. These lists are suggestions only: free-text product values remain valid.
const PHARMACEUTICAL_FORMS = medicineReferenceCatalog.forms;
const PHARMACEUTICAL_FORM_CATEGORIES = medicineFormCatalog.categories;
const ADMINISTRATION_ROUTE_CATEGORIES = medicineAdministrationRouteCatalog.categories;
const THERAPEUTIC_CLASSES = medicineReferenceCatalog.classes;
const ADMINISTRATION_ROUTES = Array.from(new Set([
  ...medicineReferenceCatalog.routes,
  ...ADMINISTRATION_ROUTE_CATEGORIES.flatMap((entry) => entry.subcategories)
]));
const MAX_PRODUCT_IMAGES = 6;

/**
 * Validates and normalizes a medicine listing payload before it's written to
 * healthPharmacyProducts. Throws {code, message} on the first invalid field, in the
 * same shape functions/smartsolutiontek/lib/fieldTypes.js uses (caught by the Cloud
 * Function and turned into an HttpError). `pharmacyId` is never read from the payload
 * here — the caller (Cloud Function) always sets it from the verified auth token.
 */
function sanitizeMedicinePayload(raw = {}) {
  const name = sanitizeText(raw.name, 180);
  if (!name) throw { code: 'name-required', message: 'Le nom du médicament est requis.' };

  const price = Number(raw.price);
  if (!Number.isFinite(price) || price < 0) {
    throw { code: 'invalid-price', message: 'Le prix doit être un nombre positif.' };
  }

  const stock = Math.floor(Number(raw.stock));
  if (!Number.isFinite(stock) || stock < 0) {
    throw { code: 'invalid-stock', message: 'Le stock doit être un entier positif ou nul.' };
  }

  const images = Array.isArray(raw.images)
    ? raw.images.map((url) => sanitizeText(url, 500)).filter(Boolean).slice(0, MAX_PRODUCT_IMAGES)
    : [];

  const activeIngredientList = (Array.isArray(raw.activeIngredients) ? raw.activeIngredients : String(raw.activeIngredients || '').split(/[,;]+/)).map((value) => sanitizeText(value, 160)).filter(Boolean).slice(0, 12);

  return {
    name,
    dci: sanitizeText(raw.dci, 180),
    productType: ['single', 'fixed-combination'].includes(String(raw.productType || '').toLowerCase()) ? String(raw.productType).toLowerCase() : 'single',
    dosage: sanitizeText(raw.dosage, 60),
    dosageValue: sanitizeText(raw.dosageValue, 30),
    dosageUnit: sanitizeText(raw.dosageUnit, 30),
    concentrationValue: sanitizeText(raw.concentrationValue, 30),
    concentrationDenominator: sanitizeText(raw.concentrationDenominator, 30),
    pharmaceuticalForm: sanitizeText(raw.pharmaceuticalForm, 60),
    pharmaceuticalFormCategory: sanitizeText(raw.pharmaceuticalFormCategory, 160),
    administrationRouteCategory: sanitizeText(raw.administrationRouteCategory, 160),
    administrationRoutes: Array.isArray(raw.administrationRoutes)
      ? raw.administrationRoutes.map((value) => sanitizeText(value, 60)).filter(Boolean).slice(0, 8)
      : [],
    therapeuticClass: sanitizeText(raw.therapeuticClass, 120),
    therapeuticSubclass: sanitizeText(raw.therapeuticSubclass, 120),
    activeIngredients: activeIngredientList.join(', '),
    activeIngredientList,
    presentation: sanitizeText(raw.presentation, 200),
    packagingType: sanitizeText(raw.packagingType, 60),
    quantityPerPackage: Math.max(0, Math.floor(Number(raw.quantityPerPackage) || 0)),
    lotNumber: sanitizeText(raw.lotNumber, 80),
    expirationDate: sanitizeText(raw.expirationDate, 30),
    packageUnit: sanitizeText(raw.packageUnit, 40),
    manufacturer: sanitizeText(raw.manufacturer, 120),
    brand: sanitizeText(raw.brand, 120),
    countryOfManufacture: sanitizeText(raw.countryOfManufacture, 80),
    distributor: sanitizeText(raw.distributor, 160),
    volumeValue: sanitizeText(raw.volumeValue, 30),
    volumeUnit: sanitizeText(raw.volumeUnit, 20),
    unitsPerPackage: Math.max(0, Math.floor(Number(raw.unitsPerPackage) || 0)),
    gtin: sanitizeText(raw.gtin, 40),
    internalSku: sanitizeText(raw.internalSku, 80),
    regulatoryCategory: sanitizeText(raw.regulatoryCategory, 80),
    indication: sanitizeText(raw.indication, 1000),
    composition: sanitizeText(raw.composition, 1500),
    excipients: sanitizeText(raw.excipients, 1000),
    contraindications: sanitizeText(raw.contraindications, 1500),
    warnings: sanitizeText(raw.warnings, 1500),
    adverseEffects: sanitizeText(raw.adverseEffects, 1500),
    interactions: sanitizeText(raw.interactions, 1500),
    shortDescription: sanitizeText(raw.shortDescription, 500),
    detailedDescription: sanitizeText(raw.detailedDescription, 3000),
    altText: sanitizeText(raw.altText, 300),
    category: sanitizeText(raw.category, 120),
    subcategory: sanitizeText(raw.subcategory, 120),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((value) => sanitizeText(value, 60)).filter(Boolean).slice(0, 30)
      : String(raw.tags || '').split(/[,;]+/).map((value) => sanitizeText(value, 60)).filter(Boolean).slice(0, 30),
    slug: sanitizeText(raw.slug, 180),
    seoTitle: sanitizeText(raw.seoTitle, 180),
    seoDescription: sanitizeText(raw.seoDescription, 320),
    similarProductIds: Array.isArray(raw.similarProductIds)
      ? raw.similarProductIds.map((value) => sanitizeText(value, 200)).filter(Boolean).slice(0, 20)
      : [],
    substitutionAllowed: ['yes', 'no', 'prescription'].includes(String(raw.substitutionAllowed || '').toLowerCase()) ? String(raw.substitutionAllowed).toLowerCase() : 'prescription',
    sensitiveProduct: raw.sensitiveProduct === true,
    minimumAge: Math.max(0, Math.floor(Number(raw.minimumAge) || 0)),
    maxOrderQuantity: Math.max(0, Math.floor(Number(raw.maxOrderQuantity) || 0)),
    noticeUrl: sanitizeText(raw.noticeUrl, 500),
    authorizationNumber: sanitizeText(raw.authorizationNumber, 120),
    mainImageMatchesPresentation: raw.mainImageMatchesPresentation === true,
    promotionPrice: Math.max(0, Number(raw.promotionPrice) || 0),
    promotionStartAt: sanitizeText(raw.promotionStartAt, 30),
    promotionEndAt: sanitizeText(raw.promotionEndAt, 30),
    promotionPercent: Math.min(100, Math.max(0, Number(raw.promotionPercent) || 0)),
    promotionQuantityLimit: Math.max(0, Math.floor(Number(raw.promotionQuantityLimit) || 0)),
    promotionCode: sanitizeText(raw.promotionCode, 80),
    promotionExclusions: Array.isArray(raw.promotionExclusions) ? raw.promotionExclusions.map((value) => sanitizeText(value, 80)).filter(Boolean).slice(0, 20) : String(raw.promotionExclusions || '').split(/[,;]+/).map((value) => sanitizeText(value, 80)).filter(Boolean).slice(0, 20),
    publicationStatus: raw.active === false ? 'DRAFT' : 'PUBLISHED',
    images,
    lots: Array.isArray(raw.lots) ? raw.lots.slice(0, 100).map((lot) => ({
      lotNumber: sanitizeText(lot?.lotNumber, 80),
      quantityReceived: Math.max(0, Math.floor(Number(lot?.quantityReceived) || 0)),
      quantityAvailable: Math.min(
        Math.max(0, Math.floor(Number(lot?.quantityReceived) || 0)),
        Math.max(0, Math.floor(Number(lot?.quantityAvailable ?? lot?.quantityReceived) || 0))
      ),
      expirationDate: sanitizeText(lot?.expirationDate, 30),
      manufactureDate: sanitizeText(lot?.manufactureDate, 30),
      receivedAt: sanitizeText(lot?.receivedAt, 30),
      supplier: sanitizeText(lot?.supplier, 160),
      acquisitionCost: Math.max(0, Number(lot?.acquisitionCost) || 0),
      storageLocation: sanitizeText(lot?.storageLocation, 100),
      status: ['ACTIVE', 'RESERVED', 'LOW', 'QUARANTINE', 'RETIRED', 'EXPIRED', 'EXHAUSTED'].includes(String(lot?.status || '').toUpperCase()) ? String(lot.status).toUpperCase() : 'ACTIVE'
    })).filter((lot) => lot.lotNumber && lot.expirationDate) : [],
    price,
    stock,
    deliveryMode: ['pickup', 'delivery', 'both'].includes(String(raw.deliveryMode || '')) ? String(raw.deliveryMode) : 'pickup',
    deliveryZones: Array.isArray(raw.deliveryZones) ? raw.deliveryZones.slice(0, 30).map((zone) => ({
      department: sanitizeText(zone?.department, 100),
      commune: sanitizeText(zone?.commune, 100),
      price: Math.max(0, Number(zone?.price) || 0),
      subzone: sanitizeText(zone?.subzone, 120),
      etaLabel: sanitizeText(zone?.etaLabel, 100),
      conditions: sanitizeText(zone?.conditions, 300),
      coldChainSupported: zone?.coldChainSupported === true,
      active: zone?.active !== false
    })).filter((zone) => zone.department && zone.commune) : [],
    storageInstructions: sanitizeText(raw.storageInstructions, 500),
    storageCondition: sanitizeText(raw.storageCondition, 160),
    lightHumidityProtection: raw.lightHumidityProtection === true,
    ePrescriptionAllowed: raw.ePrescriptionAllowed === true,
    visibility: ['PUBLIC', 'HIDDEN'].includes(String(raw.visibility || '').toUpperCase()) ? String(raw.visibility).toUpperCase() : 'PUBLIC',
    publicationAt: sanitizeText(raw.publicationAt, 40),
    featured: raw.featured === true,
    badge: ['NEW', 'PROMOTION', 'LOW_STOCK'].includes(String(raw.badge || '').toUpperCase()) ? String(raw.badge).toUpperCase() : '',
    storageMinC: sanitizeText(raw.storageMinC, 20),
    storageMaxC: sanitizeText(raw.storageMaxC, 20),
    prescriptionRequired: raw.prescriptionRequired === true,
    coldChainRequired: raw.coldChainRequired === true,
    active: raw.active !== false,
    notes: sanitizeText(raw.notes, 500)
  };
}

/**
 * Turns a medicine name into a set of lowercase, accent-stripped tokens for a basic
 * Firestore array-contains search (Firestore has no native full-text search). Applied
 * identically at write time (indexing) and read time (query) by the Cloud Functions —
 * never trust a client-submitted token list.
 */
function validateMedicinePublication(product) {
  const missing = [];
  const activeIngredientList = Array.isArray(product.activeIngredientList) ? product.activeIngredientList : String(product.activeIngredients || '').split(/[,;]+/).map((value) => value.trim()).filter(Boolean);
  if (product.productType === 'fixed-combination' && activeIngredientList.length < 2) missing.push('au moins deux principes actifs pour une association fixe');
  if (!product.therapeuticClass) missing.push('classe thérapeutique');
  if (!product.dosageValue && !product.dosage) missing.push('dosage/concentration');
  if (!product.pharmaceuticalForm) missing.push('forme pharmaceutique');
  if (!product.presentation && !(product.quantityPerPackage > 0 && product.packageUnit) && !product.packagingType) missing.push('presentation');
  if (!product.manufacturer) missing.push('fabricant');
  if (!product.storageCondition && !product.storageInstructions) missing.push('conditions de conservation');
  if (product.visibility === 'PUBLIC' && product.publicationAt) { const publicationAt = Date.parse(String(product.publicationAt)); if (!Number.isFinite(publicationAt)) missing.push('date de publication valide'); }
  if (!Array.isArray(product.images) || !product.images[0]) missing.push('photo principale');
  if (product.mainImageMatchesPresentation !== true) missing.push('confirmation de correspondance de la photo avec le conditionnement');
  if (!(Number(product.price) > 0)) missing.push('prix');
  if (!(getSellableStock(product) > 0)) missing.push('stock vendable');
  if (['delivery', 'both'].includes(product.deliveryMode) && !(product.deliveryZones || []).some((zone) => zone.active !== false)) missing.push('zone de livraison active');
  const hasLegacyLot = Array.isArray(product.lots) && product.lots.length > 0;
  if (!hasLegacyLot) {
    if (!product.lotNumber) missing.push('numéro de lot');
    const expirationValue = String(product.expirationDate || '');
    const expirationMs = /^\d{4}-\d{2}-\d{2}$/.test(expirationValue)
      ? Date.parse(expirationValue + 'T23:59:59.999Z')
      : Date.parse(expirationValue);
    if (!Number.isFinite(expirationMs) || expirationMs <= Date.now()) missing.push('date d’expiration valide et future');
  }
  const hasPromotion = Number(product.promotionPrice) > 0 || Number(product.promotionPercent) > 0 || product.promotionStartAt || product.promotionEndAt;
  if (hasPromotion) {
    const start = Date.parse(String(product.promotionStartAt || ''));
    const end = Date.parse(String(product.promotionEndAt || ''));
    if ((product.promotionStartAt || product.promotionEndAt) && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) missing.push('dates de promotion valides');
    const validPromotionPrice = Number(product.promotionPrice) > 0 && Number(product.promotionPrice) < Number(product.price);
    const validPromotionPercent = Number(product.promotionPercent) > 0 && Number(product.promotionPercent) < 100;
    if (!validPromotionPrice && !validPromotionPercent) missing.push('prix promotionnel ou remise valide');
  }
  if (missing.length) throw { code: 'publication-incomplete', message: 'Publication impossible : ' + missing.join(', ') + '.' };
  return true;
}


function isLotSellable(lot, now = Date.now()) {
  if (!lot || String(lot.status || 'ACTIVE').toUpperCase() !== 'ACTIVE') return false;
  const expirationMs = Date.parse(String(lot.expirationDate || ''));
  return Number.isFinite(expirationMs) && expirationMs > now && Number(lot.quantityAvailable || 0) > 0;
}

function getSellableLots(product = {}, now = Date.now()) {
  const lots = Array.isArray(product.lots) ? product.lots : [];
  return lots.map((lot) => ({ ...lot }))
    .filter((lot) => isLotSellable(lot, now))
    .sort((a, b) => Date.parse(String(a.expirationDate)) - Date.parse(String(b.expirationDate)));
}

function getSellableStock(product = {}, now = Date.now()) {
  const lots = Array.isArray(product.lots) ? product.lots : [];
  if (!lots.length) {
    if (product.expirationDate) {
      const value = String(product.expirationDate);
      const expiration = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(value + 'T23:59:59.999Z') : Date.parse(value);
      if (!Number.isFinite(expiration) || expiration <= now) return 0;
    }
    return Math.max(0, Math.floor(Number(product.stock) || 0));
  }
  return getSellableLots(product, now).reduce((sum, lot) => sum + Math.max(0, Math.floor(Number(lot.quantityAvailable) || 0)), 0);
}

function getAvailableSellableStock(product = {}, now = Date.now()) {
  return Math.max(0, getSellableStock(product, now) - Math.max(0, Math.floor(Number(product.reservedStock) || 0)));
}

function consumeSellableLots(product = {}, quantity, now = Date.now()) {
  const qty = Math.max(1, Math.floor(Number(quantity) || 0));
  const lots = Array.isArray(product.lots) ? product.lots.map((lot) => ({ ...lot })) : [];
  if (!lots.length) {
    if (getSellableStock(product, now) < qty) throw new Error('insufficient-sellable-stock');
    return { lots, allocations: [], stock: Math.max(0, Math.floor(Number(product.stock) || 0)) - qty };
  }
  let remaining = qty;
  const allocations = [];
  for (const lot of getSellableLots({ lots }, now)) {
    if (remaining <= 0) break;
    const available = Math.max(0, Math.floor(Number(lot.quantityAvailable) || 0));
    const taken = Math.min(remaining, available);
    if (!taken) continue;
    remaining -= taken;
    allocations.push({ lotNumber: lot.lotNumber, quantity: taken });
    const target = lots.find((candidate) => candidate.lotNumber === lot.lotNumber);
    target.quantityAvailable = available - taken;
    target.status = target.quantityAvailable > 0 ? 'ACTIVE' : 'EXHAUSTED';
  }
  if (remaining > 0) throw new Error('insufficient-sellable-stock');
  return { lots, allocations, stock: getSellableStock({ lots }) };
}

function restoreConsumedLots(product = {}, allocations = []) {
  const lots = Array.isArray(product.lots) ? product.lots.map((lot) => ({ ...lot })) : [];
  if (!lots.length) return { lots, stock: Math.max(0, Math.floor(Number(product.stock) || 0)) };
  for (const allocation of allocations || []) {
    const lot = lots.find((candidate) => candidate.lotNumber === allocation.lotNumber);
    if (!lot) continue;
    lot.quantityAvailable = Math.min(
      Math.max(0, Math.floor(Number(lot.quantityReceived) || 0)),
      Math.max(0, Math.floor(Number(lot.quantityAvailable) || 0)) + Math.max(0, Math.floor(Number(allocation.quantity) || 0))
    );
    if (lot.quantityAvailable > 0 && lot.status === 'EXHAUSTED') lot.status = 'ACTIVE';
  }
  return { lots, stock: getSellableStock({ lots }) };
}

function tokenizeSearchName(name) {
  const normalized = String(name || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip accents (combining diacritical marks)
    .replace(/[^a-z0-9\s]/g, ' ');
  const tokens = normalized.split(/\s+/).filter((token) => token.length >= 2);
  return Array.from(new Set(tokens)).slice(0, 20);
}

// ---------- Availability slots: no double-booking, no back-to-back overload ----------
//
// A provider (doctor/laboratory/imaging center) can never have two overlapping slots,
// and two consecutive slots must leave at least MIN_GAP_MINUTES between the end of one
// and the start of the next — this is what actually enforces "un rendez-vous ne peut
// commencer que 5 minutes après le précédent" from the spec. Pure function: takes the
// candidate range and the provider's other slots (already fetched from Firestore by the
// caller), returns whether publishing the candidate is allowed.

const MIN_SLOT_GAP_MINUTES = 5;

function slotConflictsWithExisting(candidateStartsAt, candidateEndsAt, existingSlots, gapMinutes = MIN_SLOT_GAP_MINUTES) {
  const start = new Date(candidateStartsAt).getTime();
  const end = new Date(candidateEndsAt).getTime();
  const gapMs = Math.max(0, gapMinutes) * 60_000;
  return (existingSlots || []).some((slot) => {
    const slotStart = new Date(slot.startsAt).getTime();
    const slotEnd = new Date(slot.endsAt).getTime();
    if (![slotStart, slotEnd].every(Number.isFinite)) return false;
    // Two ranges conflict if they overlap OR sit closer together than the required gap —
    // equivalent to padding each existing slot by `gapMinutes` on both sides before
    // testing for overlap with the candidate.
    return start < slotEnd + gapMs && end > slotStart - gapMs;
  });
}

function isSelfBooking(patientUid, providerUid, providerType) {
  const patient = String(patientUid || '').trim();
  const provider = String(providerUid || '').trim();
  return String(providerType || '').trim().toLowerCase() === 'doctor'
    && Boolean(patient)
    && patient === provider;
}

// ---------- Teleconsultation session messaging: per-patient media caps ----------
//
// The plan the appointment was booked under caps how many photos/voice notes the
// PATIENT may send during a session (see teleconsultation-config.js — essential:1/1,
// advanced:5/3). The doctor's own messages never count against this cap. Pure
// function: given the patient's existing message docs for this appointment and the
// plan limits, says whether one more of `kind` is still allowed.
function canSendSessionMedia(existingPatientMessages, kind, limits) {
  const cap = kind === 'photo' ? Number(limits?.maxPhotos) : Number(limits?.maxVoiceMessages);
  if (!Number.isFinite(cap)) return false;
  const used = (existingPatientMessages || []).filter((message) => message.kind === kind).length;
  return used < cap;
}

const SESSION_MESSAGE_KINDS = ['text', 'photo', 'voice'];
const MAX_SESSION_TEXT_LENGTH = 2000;

function sanitizeSessionMessageText(value) {
  return sanitizeText(value, MAX_SESSION_TEXT_LENGTH);
}

// ---------- No-show handling ----------
//
// The booked appointment slot, not the acceptance or click time, controls access.
const CONSULTATION_ACCESS_LEAD_MINUTES = 5;
const NO_SHOW_GRACE_MINUTES = 5;

function getConsultationTiming(startsAtIso) {
  const startsAt = new Date(startsAtIso).getTime();
  if (!Number.isFinite(startsAt)) return null;
  return { startsAt, accessAt: startsAt - CONSULTATION_ACCESS_LEAD_MINUTES * 60_000, noShowAt: startsAt + NO_SHOW_GRACE_MINUTES * 60_000 };
}

function isConsultationAccessOpen(startsAtIso, now = new Date()) {
  const timing = getConsultationTiming(startsAtIso);
  return Boolean(timing && now.getTime() >= timing.accessAt);
}

function isPastConsultationNoShowDeadline(startsAtIso, now = new Date()) {
  const timing = getConsultationTiming(startsAtIso);
  return Boolean(timing && now.getTime() >= timing.noShowAt);
}

// If the patient never joins within NO_SHOW_GRACE_MINUTES of the booked start,
// the session auto-closes:
// the professional is credited 0, the patient wallet is credited 0, Smart Cut Health
// keeps the full amount already paid — no ledger entry is created for anyone.
function isPastNoShowDeadline(sessionStartedAtIso, now = new Date()) {
  const startedAt = new Date(sessionStartedAtIso).getTime();
  if (!Number.isFinite(startedAt)) return false;
  return now.getTime() - startedAt >= NO_SHOW_GRACE_MINUTES * 60_000;
}

// ---------- Health professional payout cooldown ----------
//
// Distinct from the generic "one open request at a time" rule already enforced by
// functions/smartsolutiontek/payouts.js: Smart Cut Health additionally allows only one
// PAID payout per rolling 30-day window per professional.
const PAYOUT_COOLDOWN_DAYS = 30;

function isWithinPayoutCooldown(lastPaidAtIso, now = new Date()) {
  if (!lastPaidAtIso) return false;
  const lastPaidAt = new Date(lastPaidAtIso).getTime();
  if (!Number.isFinite(lastPaidAt)) return false;
  return now.getTime() - lastPaidAt < PAYOUT_COOLDOWN_DAYS * 24 * 60 * 60_000;
}

module.exports = {
  PRESCRIPTION_STATUSES,
  PRESCRIPTION_TRANSITIONS,
  ORDER_FULFILLMENT_STATUSES,
  ORDER_TRANSITIONS,
  canTransitionPrescription,
  canTransitionOrder,
  prescriptionStatusLabel,
  computeOfferTotal,
  sanitizeMedicinePayload,
  validateMedicinePublication,
  getEffectiveMedicinePrice,
  calculateMedicineLinePricing,
  isLotSellable,
  getSellableLots,
  getSellableStock,
  getAvailableSellableStock,
  consumeSellableLots,
  restoreConsumedLots,
  tokenizeSearchName,
  sanitizeText,
  PHARMACEUTICAL_FORMS,
  PHARMACEUTICAL_FORM_CATEGORIES,
  ADMINISTRATION_ROUTE_CATEGORIES,
  THERAPEUTIC_CLASSES,
  ADMINISTRATION_ROUTES,
  MAX_PRODUCT_IMAGES,
  MIN_SLOT_GAP_MINUTES,
  slotConflictsWithExisting,
  isSelfBooking,
  SESSION_MESSAGE_KINDS,
  MAX_SESSION_TEXT_LENGTH,
  sanitizeSessionMessageText,
  canSendSessionMedia,
  NO_SHOW_GRACE_MINUTES,
  isPastNoShowDeadline,
  CONSULTATION_ACCESS_LEAD_MINUTES,
  getConsultationTiming,
  isConsultationAccessOpen,
  isPastConsultationNoShowDeadline,
  PAYOUT_COOLDOWN_DAYS,
  isWithinPayoutCooldown
};
