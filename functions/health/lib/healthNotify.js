'use strict';

/**
 * Shared by every functions/health/*.js module that needs to fan out an in-app
 * notification (healthNotifications — read/unread inbox, see firestore.rules).
 * Never throws: a notification failing to write must never take down the operation
 * that triggered it. Never put medical content beyond what's already safe to show in
 * a short title/body — same discipline as healthAuditLogs.
 */
function configuredDeliveryChannels() {
  const configured = String(process.env.HEALTH_NOTIFICATION_CHANNELS || '')
    .split(',')
    .map((channel) => channel.trim().toLowerCase())
    .filter((channel) => ['email', 'whatsapp', 'sms'].includes(channel));
  return [...new Set(configured)];
}

async function notifyUser(db, userId, type, { title, body, url, context = {}, channels = [] } = {}) {
  if (!userId) return;
  const createdAt = new Date().toISOString();
  const notification = {
    userId, type,
    title: title || 'Notification',
    body: body || '',
    url: url || './health-espace.html',
    context, read: false, readAt: null, createdAt
  };
  try {
    const notificationRef = await db.collection('healthNotifications').add(notification);
    const requestedChannels = Array.isArray(channels) ? channels : [];
    const deliveryChannels = [...new Set([...configuredDeliveryChannels(), ...requestedChannels
      .map((channel) => String(channel).trim().toLowerCase())
      .filter((channel) => ['email', 'whatsapp', 'sms'].includes(channel))])];
    if (deliveryChannels.length) {
      const batch = db.batch();
      deliveryChannels.forEach((channel) => {
        const deliveryRef = db.collection('healthNotificationDeliveries').doc();
        batch.set(deliveryRef, {
          notificationId: notificationRef.id, userId, type, channel,
          title: notification.title, body: notification.body, url: notification.url,
          context, status: 'PENDING', attempts: 0, createdAt, updatedAt: createdAt
        });
      });
      await batch.commit();
    }
  } catch (error) {
    // eslint-disable-next-line global-require
    require('firebase-functions').logger.error('healthNotifications write failed', { type, message: error?.message });
  }
}

module.exports = { notifyUser };
