/**
 * eBay OAuth via Cloud Functions + Secret Manager.
 *
 * IMPORTANT:
 * - EBAY_REDIRECT_URI doit contenir le RuName eBay (pas une URL HTTP).
 * - Dans le portail eBay, ce RuName doit pointer vers:
 *   https://us-central1-phil-b1d11.cloudfunctions.net/ebayOAuth/callback
 */
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret, defineString } = require('firebase-functions/params');

const ebayClientId = defineSecret('EBAY_CLIENT_ID');
const ebayClientSecret = defineSecret('EBAY_CLIENT_SECRET');
const ebayRedirectUri = defineSecret('EBAY_REDIRECT_URI');

/** Origine de l’app (sans slash final) — redirection navigateur après OAuth vers app.html */
const publicAppUrl = defineString('PUBLIC_APP_URL', {
  default: 'https://willgb.com',
});

const ebayEnv = defineString('EBAY_ENV', {
  default: 'sandbox',
});

const ebayScopesParam = defineString('EBAY_SCOPES', {
  default:
    'https://api.ebay.com/oauth/api_scope/sell.inventory https://api.ebay.com/oauth/api_scope/sell.account',
});

if (!admin.apps.length) {
  admin.initializeApp();
}

function ebayCredDocId(ownerUid, workspaceId) {
  return `${ownerUid}_${workspaceId}`;
}

function getEbayEndpoints() {
  const env = ebayEnv.value() === 'production' ? 'production' : 'sandbox';
  return {
    env,
    authBase:
      env === 'production'
        ? 'https://auth.ebay.com/oauth2/authorize'
        : 'https://auth.sandbox.ebay.com/oauth2/authorize',
    tokenUrl:
      env === 'production'
        ? 'https://api.ebay.com/identity/v1/oauth2/token'
        : 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
  };
}

function appBaseForRedirects() {
  const base = (publicAppUrl.value() || '').replace(/\/$/, '');
  if (base) return base;
  return 'https://willgb.com';
}

function getEbayRuNameOrThrow() {
  const raw = String(ebayRedirectUri.value() || '').trim();
  if (!raw) {
    throw new Error('Secret EBAY_REDIRECT_URI vide. Mettez le RuName eBay.');
  }
  if (raw.startsWith('http://') || raw.startsWith('https://')) {
    throw new Error(
      'EBAY_REDIRECT_URI doit etre le RuName eBay (pas une URL). Configurez le callback URL dans le portail eBay.'
    );
  }
  return raw;
}

function buildRouter() {
  const router = express.Router();
  router.use(express.json());

  router.get('/health', (req, res) => {
    const { env } = getEbayEndpoints();
    const base = appBaseForRedirects();
    let ruName = null;
    let ruNameOk = false;
    try {
      ruName = getEbayRuNameOrThrow();
      ruNameOk = true;
    } catch (e) {
      ruName = e.message || 'invalid';
      ruNameOk = false;
    }
    return res.json({
      ok: true,
      env,
      publicAppUrl: base,
      ruNameOk,
      ruNamePreview: ruNameOk ? ruName.slice(0, 10) + '...' : ruName,
    });
  });

  router.post('/auth-url', async (req, res) => {
    try {
      const { idToken, ownerUid, workspaceId } = req.body || {};
      if (!idToken || !ownerUid || !workspaceId) {
        return res.status(400).json({ error: 'idToken, ownerUid and workspaceId are required' });
      }

      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }

      if (decoded.uid !== ownerUid) {
        return res.status(403).json({
          error:
            'Seul le propriétaire du workspace peut lier un compte eBay (le compte vendeur est celui du workspace).',
        });
      }

      const state = crypto.randomBytes(24).toString('hex');
      await admin.firestore().collection('ebayOAuthState').doc(state).set({
        ownerUid,
        workspaceId,
        firebaseUid: decoded.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      const { authBase, env } = getEbayEndpoints();
      const ruName = getEbayRuNameOrThrow();
      const scopes = (ebayScopesParam.value() || '').trim();
      const params = new URLSearchParams({
        client_id: ebayClientId.value(),
        response_type: 'code',
        redirect_uri: ruName,
        scope: scopes,
        state,
      });
      const url = `${authBase}?${params.toString()}`;
      res.json({ url, env });
    } catch (e) {
      console.error('ebay auth-url', e);
      res.status(500).json({ error: e.message || 'Could not start OAuth' });
    }
  });

  router.get('/callback', async (req, res) => {
    const hostBase = appBaseForRedirects();
    const appPath = '/app.html';
    const { code, state, error, error_description: errorDesc } = req.query;

    if (error) {
      const msg = encodeURIComponent(String(errorDesc || error || 'OAuth error'));
      return res.redirect(`${hostBase}${appPath}?ebay_error=${msg}&settings=services`);
    }
    if (!code || !state) {
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent('Réponse OAuth invalide')}&settings=services`
      );
    }

    const stateRef = admin.firestore().collection('ebayOAuthState').doc(String(state));
    let stateSnap;
    try {
      stateSnap = await stateRef.get();
    } catch (e) {
      console.error(e);
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent('Erreur serveur')}&settings=services`
      );
    }

    if (!stateSnap.exists) {
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent('Session OAuth expirée ou invalide — réessayez.')}&settings=services`
      );
    }

    const { ownerUid, workspaceId } = stateSnap.data();
    await stateRef.delete().catch(() => {});

    const { tokenUrl, env } = getEbayEndpoints();
    let ruName;
    try {
      ruName = getEbayRuNameOrThrow();
    } catch (e) {
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent(e.message || 'RuName eBay invalide')}&settings=services`
      );
    }
    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(`${ebayClientId.value()}:${ebayClientSecret.value()}`).toString('base64'),
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: String(code),
          redirect_uri: ruName,
        }).toString(),
      });
    } catch (e) {
      console.error('eBay token fetch:', e);
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent('Impossible de joindre eBay')}&settings=services`
      );
    }

    const tokenJson = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok) {
      console.error('eBay token exchange:', tokenJson);
      const msg = encodeURIComponent(
        tokenJson.error_description || tokenJson.error || 'Échec échange de jeton'
      );
      return res.redirect(`${hostBase}${appPath}?ebay_error=${msg}&settings=services`);
    }

    if (!tokenJson.refresh_token) {
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent('eBay na pas renvoyé de refresh token')}&settings=services`
      );
    }

    const credId = ebayCredDocId(ownerUid, workspaceId);
    const batch = admin.firestore().batch();
    const credRef = admin.firestore().collection('ebayCredentials').doc(credId);
    batch.set(credRef, {
      refreshToken: tokenJson.refresh_token,
      accessToken: tokenJson.access_token,
      accessTokenExpiresAt: Date.now() + (Number(tokenJson.expires_in) || 7200) * 1000,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      env,
    });
    const wsRef = admin.firestore().collection('users').doc(ownerUid).collection('workspaces').doc(workspaceId);
    batch.set(
      wsRef,
      {
        ebay: {
          linked: true,
          linkedAt: new Date().toISOString(),
          env,
        },
      },
      { merge: true }
    );
    try {
      await batch.commit();
    } catch (e) {
      console.error('eBay Firestore save:', e);
      return res.redirect(
        `${hostBase}${appPath}?ebay_error=${encodeURIComponent("Impossible d'enregistrer la liaison")}&settings=services`
      );
    }

    return res.redirect(`${hostBase}${appPath}?ebay_connected=1&settings=services`);
  });

  router.post('/disconnect', async (req, res) => {
    try {
      const { idToken, ownerUid, workspaceId } = req.body || {};
      if (!idToken || !ownerUid || !workspaceId) {
        return res.status(400).json({ error: 'idToken, ownerUid and workspaceId are required' });
      }
      let decoded;
      try {
        decoded = await admin.auth().verifyIdToken(idToken);
      } catch {
        return res.status(401).json({ error: 'Invalid or expired session' });
      }
      if (decoded.uid !== ownerUid) {
        return res.status(403).json({ error: 'Only the workspace owner can disconnect eBay' });
      }

      const credId = ebayCredDocId(ownerUid, workspaceId);
      await admin.firestore().collection('ebayCredentials').doc(credId).delete();
      await admin
        .firestore()
        .collection('users')
        .doc(ownerUid)
        .collection('workspaces')
        .doc(workspaceId)
        .update({
          ebay: admin.firestore.FieldValue.delete(),
        });
      res.json({ ok: true });
    } catch (e) {
      console.error('ebay disconnect', e);
      res.status(500).json({ error: 'Disconnect failed' });
    }
  });

  return router;
}

const ebayApp = express();
ebayApp.use(cors({ origin: true }));
ebayApp.use(buildRouter());

exports.ebayOAuth = onRequest(
  {
    region: 'us-central1',
    secrets: [ebayClientId, ebayClientSecret, ebayRedirectUri],
    invoker: 'public',
    timeoutSeconds: 60,
    memory: '256MiB',
  },
  ebayApp
);
