import { getPrisma } from './db.js';
import { logMessageToFirestore } from './firebase.js';
import {
  sendTemplateMessage,
  prepareMessagePayload,
  processMessageText,
  formatPhoneColombia,
  classifyError,
} from './meta.js';

export const RATE_LIMIT = {
  messagesPerSecond: 50,
  batchSize: 100,
  retryAttempts: 2,
  retryDelay: 500,
  concurrentBatches: 3,
  pauseBetweenBatches: 100,
};

const DEFAULT_LANGUAGE = 'es_CO';

export class WhatsAppCampaignManager {
  constructor() {
    this.rateLimiter = new Map();
  }

  async waitForRateLimit(campaignId) {
    const now = Date.now();
    const lastSent = this.rateLimiter.get(campaignId) || 0;
    const minInterval = 1000 / RATE_LIMIT.messagesPerSecond;
    const timeDiff = now - lastSent;

    if (timeDiff < minInterval) {
      await new Promise((resolve) => setTimeout(resolve, minInterval - timeDiff));
    }
    this.rateLimiter.set(campaignId, Date.now());
  }

  async sendMessageWithRetry(payload, phoneFormatted, attempt = 1) {
    try {
      const result = await sendTemplateMessage(payload);
      return { success: true, ...result, attemptsMade: attempt };
    } catch (error) {
      if (attempt < RATE_LIMIT.retryAttempts) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT.retryDelay));
        return this.sendMessageWithRetry(payload, phoneFormatted, attempt + 1);
      }
      const classified = classifyError(error);
      return {
        success: false,
        status: classified.status,
        errorCode: classified.code,
        errorMessage: error.message,
        attemptsMade: attempt,
      };
    }
  }

  async recordSuccess(campaignContact, result, mensajeFinal, cliente, campaign, template, phoneFormatted) {
    const prisma = getPrisma();
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.campaignContact.update({
        where: { id: campaignContact.id },
        data: {
          whatsappMessageId: result.messageId,
          sendStatus: 'sent',
          sentAt: now,
          personalizedMessage: mensajeFinal,
          failureCode: null,
          failureReason: null,
          retryCount: result.attemptsMade - 1,
        },
      });

      await tx.mensajeOut.create({
        data: {
          idMsg: result.messageId,
          campaignContactId: campaignContact.id,
          campaignId: campaign.id,
          phoneTo: phoneFormatted,
          templateName: template.nombre,
          templateLang: DEFAULT_LANGUAGE,
          sentAt: now,
        },
      });

      await tx.mensajeStatusEvent.create({
        data: {
          idMsg: result.messageId,
          estado: result.status || 'sent',
          tsUnix: BigInt(Math.floor(now.getTime() / 1000)),
          recipientId: phoneFormatted,
        },
      });
    });

    await logMessageToFirestore({
      cliente,
      mensaje: mensajeFinal,
      template,
      messageId: result.messageId,
      campaignId: campaign.id,
      estado: result.status || 'sent',
    });
  }

  async recordFailure(campaignContact, result) {
    const prisma = getPrisma();
    await prisma.campaignContact.update({
      where: { id: campaignContact.id },
      data: {
        sendStatus: 'failed',
        failedAt: new Date(),
        failureCode: result.errorCode,
        failureReason: result.errorMessage?.substring(0, 500),
        retryCount: result.attemptsMade,
      },
    });
  }

  async processCampaign(campaignId) {
    const prisma = getPrisma();

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        template: true,
        campaignContacts: {
          where: {
            OR: [{ sendStatus: { not: 'sent' } }, { sendStatus: null }],
          },
          include: { cliente: true },
        },
      },
    });

    if (!campaign) throw new Error(`Campaña no encontrada: ${campaignId}`);
    if (!campaign.template) throw new Error('Campaña sin template');
    if (campaign.campaignContacts.length === 0) {
      return { total: 0, sent: 0, failed: 0, message: 'No hay contactos pendientes' };
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'sending', startedAt: new Date() },
    });

    const mappings = campaign.variableMappings || {};
    const startTs = Date.now();

    const batches = [];
    for (let i = 0; i < campaign.campaignContacts.length; i += RATE_LIMIT.batchSize) {
      batches.push(campaign.campaignContacts.slice(i, i + RATE_LIMIT.batchSize));
    }

    console.log(`📦 Procesando ${batches.length} lotes de ${RATE_LIMIT.batchSize} contactos`);

    const processBatch = async (batch, batchIndex) => {
      const batchPromises = batch.map(async (campaignContact) => {
        const cliente = campaignContact.cliente;
        const phoneFormatted = formatPhoneColombia(cliente?.telefono);

        if (!phoneFormatted) {
          await this.recordFailure(campaignContact, {
            errorCode: 'INVALID_PHONE',
            errorMessage: `Teléfono inválido: ${cliente?.telefono}`,
            attemptsMade: 0,
          });
          return { success: false, cause: 'invalid_phone' };
        }

        await this.waitForRateLimit(campaignId);

        const payload = prepareMessagePayload(campaign.template, cliente, mappings, phoneFormatted);
        const mensajeFinal = processMessageText(campaign.template, cliente, mappings);

        const result = await this.sendMessageWithRetry(payload, phoneFormatted);

        if (result.success) {
          await this.recordSuccess(campaignContact, result, mensajeFinal, cliente, campaign, campaign.template, phoneFormatted);
        } else {
          await this.recordFailure(campaignContact, result);
        }
        return result;
      });

      const results = await Promise.all(batchPromises);
      const ok = results.filter((r) => r.success).length;
      console.log(`✅ Lote ${batchIndex + 1}/${batches.length}: ${ok}/${batch.length} OK`);
      return results;
    };

    const allResults = [];
    for (let i = 0; i < batches.length; i += RATE_LIMIT.concurrentBatches) {
      const group = batches.slice(i, i + RATE_LIMIT.concurrentBatches);
      const groupResults = await Promise.all(group.map((batch, idx) => processBatch(batch, i + idx)));
      allResults.push(...groupResults.flat());
      if (i + RATE_LIMIT.concurrentBatches < batches.length) {
        await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT.pauseBetweenBatches));
      }
    }

    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'completed', finishedAt: new Date() },
    });

    const totalMs = Date.now() - startTs;
    const sent = allResults.filter((r) => r.success).length;
    const failed = allResults.length - sent;

    return {
      total: allResults.length,
      sent,
      failed,
      batchesProcessed: batches.length,
      totalTimeMinutes: (totalMs / 60000).toFixed(2),
      messagesPerSecond: (allResults.length / (totalMs / 1000)).toFixed(2),
      successRate: ((sent / allResults.length) * 100).toFixed(1),
    };
  }
}
