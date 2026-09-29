'use strict';

/**
 * Central authorization helpers for the SmartSolutionTek shared core.
 *
 * Per SECURITY_MODEL.md §2: no Cloud Function trusts an organizationId supplied by
 * the client without checking, against Firestore, that the authenticated caller is
 * a member of that organization with a sufficient role. This module centralizes
 * that check (the audited legacy code in functions/index.js repeats the equivalent
 * check inline in ~20 handlers — see ARCHITECTURE_SMARTSOLUTIONTEK.md §1.1/§4 — this
 * is the fix for that pattern going forward).
 */

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

/**
 * Verifies the Firebase ID token on the request. Reuses the exact same verification
 * used throughout the existing codebase (functions/index.js `verifyBearerUser`,
 * exposed via module.exports.__sstInternals) rather than reimplementing it.
 * @throws {HttpError} 401 if missing/invalid.
 */
async function requireBearerUser(req, sstInternals) {
  const decoded = await sstInternals.verifyBearerUser(req);
  if (!decoded?.uid) {
    throw new HttpError(401, 'auth-required', 'Authentification requise.');
  }
  return decoded;
}

async function getBearerUserOrNull(req, sstInternals) {
  const header = String(req.headers?.authorization || req.headers?.Authorization || '');
  if (!header.startsWith('Bearer ')) return null;
  return requireBearerUser(req, sstInternals);
}

/**
 * Verifies the caller belongs to `organizationId` with one of `allowedRoles`.
 * Reads organizationMembers/{organizationId}_{uid} — never trusts a role claimed by
 * the client in the request body.
 * @throws {HttpError} 403 if not a member or role insufficient.
 */
async function requireOrgRole(db, decodedUser, organizationId, allowedRoles) {
  if (!organizationId || typeof organizationId !== 'string') {
    throw new HttpError(400, 'organization-id-required', 'organizationId manquant.');
  }
  const memberRef = db.collection('organizationMembers').doc(`${organizationId}_${decodedUser.uid}`);
  const memberSnap = await memberRef.get();
  if (!memberSnap.exists) {
    throw new HttpError(403, 'not-a-member', "Vous n'appartenez pas a cette organisation.");
  }
  const member = memberSnap.data();
  if (member.status !== 'active') {
    throw new HttpError(403, 'member-disabled', 'Acces desactive pour cette organisation.');
  }
  if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(member.role)) {
    throw new HttpError(403, 'insufficient-role', 'Role insuffisant pour cette action.');
  }
  return member;
}

/**
 * Verifies the caller has one of the given platform-wide roles
 * (platform_admin, finance_admin, support_agent, partner_admin).
 * @throws {HttpError} 403 if not authorized.
 */
async function requirePlatformRole(db, decodedUser, allowedRoles) {
  const roleRef = db.collection('platformRoles').doc(decodedUser.uid);
  const roleSnap = await roleRef.get();
  if (!roleSnap.exists) {
    throw new HttpError(403, 'not-platform-staff', 'Acces reserve au personnel SmartCut.');
  }
  const record = roleSnap.data();
  if (record.status !== 'active') {
    throw new HttpError(403, 'platform-role-disabled', 'Compte desactive.');
  }
  if (Array.isArray(allowedRoles) && allowedRoles.length && !allowedRoles.includes(record.role)) {
    throw new HttpError(403, 'insufficient-platform-role', 'Role insuffisant pour cette action.');
  }
  return record;
}

/**
 * Applies the same CORS headers as the existing functions/index.js `applyCors`
 * helper (Access-Control-Allow-Origin: *, matching how the browser-facing pages
 * in smartsolutiontek/ call these functions) and short-circuits the browser's
 * preflight OPTIONS request. Without this, every sst* function is unreachable
 * from a browser regardless of how correct its own logic is — found by actually
 * exercising the public pages against the (undeployed) function URLs, which
 * surfaced a CORS-blocked fetch instead of a clean 404/response.
 */
function applyCorsAndHandleOptions(req, res) {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return true;
  }
  return false;
}

/** Wraps an async handler: CORS + OPTIONS preflight, then converts HttpError into the correct JSON error response. */
function withErrorHandling(handler) {
  return async (req, res) => {
    if (applyCorsAndHandleOptions(req, res)) return;
    try {
      await handler(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        res.status(error.status).json({ ok: false, error: error.code, message: error.message });
        return;
      }
      // eslint-disable-next-line global-require
      const { logger } = require('firebase-functions');
      logger.error('smartsolutiontek handler failed', error);
      res.status(500).json({ ok: false, error: 'internal-error', message: 'Une erreur est survenue.' });
    }
  };
}

module.exports = { HttpError, requireBearerUser, getBearerUserOrNull, requireOrgRole, requirePlatformRole, withErrorHandling };
