import { getPrisma } from './db.js';

/**
 * GET handshake con Meta para verificar el webhook.
 */
export function verifyWebhook(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  if (!VERIFY_TOKEN) {
    console.error('❌ [WEBHOOK] WHATSAPP_VERIFY_TOKEN no está configurado');
    return res.status(500).send('Server misconfigured');
  }

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ [WEBHOOK] Verificado');
    return res.status(200).send(challenge);
  }
  return res.status(403).send('Forbidden');
}

/**
 * Procesa un payload POST de Meta: statuses, messages entrantes, errors.
 */
export async function processWebhook(body) {
  const prisma = getPrisma();

  try {
    await prisma.webhookLog.create({
      data: {
        eventType: body.entry?.[0]?.changes?.[0]?.field || 'unknown',
        payload: body,
      },
    });
  } catch (e) {
    console.warn('⚠️ [WEBHOOK] No se pudo guardar log:', e.message);
  }

  const entries = body.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      if (value.statuses?.length) await handleStatuses(prisma, value.statuses);
      if (value.messages?.length) await handleIncomingMessages(prisma, value.messages);
      if (value.errors?.length) handleErrors(value.errors);
    }
  }
}

async function handleStatuses(prisma, statuses) {
  for (const s of statuses) {
    const messageId = s.id;
    const statusType = s.status;
    const tsUnix = parseInt(s.timestamp);
    const ts = new Date(tsUnix * 1000);

    try {
      await prisma.mensajeStatusEvent.create({
        data: {
          idMsg: messageId,
          estado: statusType,
          tsUnix: BigInt(tsUnix),
          recipientId: s.recipient_id || null,
          pricingJson: s.pricing || null,
          conversationJson: s.conversation || null,
          errorsJson: s.errors || null,
        },
      });
    } catch (e) {
      console.warn(`⚠️ [WEBHOOK] Error insertando status_event para ${messageId}:`, e.message);
    }

    const data = {};
    if (statusType === 'sent') data.sentAt = ts;
    else if (statusType === 'delivered') data.deliveredAt = ts;
    else if (statusType === 'read') data.readAt = ts;
    else if (statusType === 'failed') {
      data.failedAt = ts;
      data.sendStatus = 'failed';
      if (s.errors?.[0]) {
        data.failureCode = String(s.errors[0].code || '').substring(0, 50);
        data.failureReason = s.errors[0].message?.substring(0, 500) || null;
      }
    }
    if (statusType === 'delivered' || statusType === 'read') data.sendStatus = statusType;

    if (Object.keys(data).length > 0) {
      try {
        const updated = await prisma.campaignContact.updateMany({
          where: { whatsappMessageId: messageId },
          data,
        });
        if (updated.count > 0) {
          console.log(`📊 [WEBHOOK] ${messageId} → ${statusType}`);
        }
      } catch (e) {
        console.warn(`⚠️ [WEBHOOK] Error actualizando campaign_contact:`, e.message);
      }
    }
  }
}

async function handleIncomingMessages(prisma, messages) {
  for (const msg of messages) {
    const from = msg.from;
    const text = msg.text?.body || msg.interactive?.button_reply?.title || '[non-text]';
    console.log(`📨 [WEBHOOK] Incoming de ${from}: "${text}"`);

    const cleanPhone = from.replace(/[^0-9]/g, '');
    const last10 = cleanPhone.slice(-10);

    try {
      const cliente = await prisma.cliente.findFirst({
        where: { telefono: { endsWith: last10 } },
      });
      if (!cliente) continue;

      const latestContact = await prisma.campaignContact.findFirst({
        where: { clienteId: cliente.id },
        orderBy: { sentAt: 'desc' },
      });
      if (latestContact) {
        await prisma.campaignContact.update({
          where: { id: latestContact.id },
          data: { repliedAt: new Date() },
        });
        console.log(`✅ [WEBHOOK] Cliente ${cliente.nombre} marcado como respondió`);
      }
    } catch (e) {
      console.warn(`⚠️ [WEBHOOK] Error procesando incoming:`, e.message);
    }
  }
}

function handleErrors(errors) {
  for (const err of errors) {
    console.error(`❌ [WEBHOOK] Error ${err.code}: ${err.title} — ${err.message}`);
  }
}
