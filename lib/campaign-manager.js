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
  // 70 msg/s: por debajo del límite de 80 msg/s (throughput STANDARD del número
  // de WhatsApp MaquiCOL). El throttle global de waitForRateLimit lo hace cumplir
  // de verdad, aunque corran varios batches en paralelo.
  messagesPerSecond: 70,
  batchSize: 100,
  retryAttempts: 2,        // reintentos para errores normales
  retryDelay: 500,
  rateLimitRetries: 5,     // reintentos CON backoff para rate limit de Meta (130429)
  concurrentBatches: 3,
  pauseBetweenBatches: 100,
};

const DEFAULT_LANGUAGE = 'es_CO';

// Mutex a nivel de módulo: solo una campaña corre a la vez por instancia.
// Evita saturar el pool de Postgres cuando se lanzan campañas en paralelo
// (P2028 — Unable to start a transaction). Cada llamada a processCampaign
// se encola sobre la promesa anterior; la cadena no se rompe por errores
// porque el release siempre se ejecuta en el finally.
let _campaignChain = Promise.resolve();

// Throttle GLOBAL de envíos. Reserva slots de tiempo crecientes (de forma
// SÍNCRONA, sin await entre leer y escribir → sin race), así la tasa real nunca
// supera messagesPerSecond aunque haya batches en paralelo. El limitador anterior
// (por-campaña, con Map) era inefectivo bajo concurrencia: la tasa real llegó a
// ~109 msg/s y Meta devolvió 130429 "Rate limit hit" (5368 envíos del 03/06 → 706 fallas).
let _nextSendSlot = 0;

// Números a los que se intenta enviar, en orden. Si el principal falla, se
// reintenta con el alterno (pedido en la reunión del 11/08/2026). El alterno
// viene de clientes.telefono_3, que el CRM llena al crear la campaña.
const PHONE_SLOTS = [
  { n: 1, campo: 'telefono' },
  { n: 2, campo: 'telefono3' },
];

// Últimos 10 dígitos: sirve para no reintentar el mismo número cuando el
// alterno es igual al principal escrito distinto (con/sin 57, espacios, etc.).
const last10 = (valor) => String(valor || '').replace(/\D/g, '').slice(-10);

// Códigos de fallo ante los cuales vale la pena reintentar con el número alterno.
// Ojo: estos los reporta Meta por WEBHOOK, después de aceptar el envío — para
// entonces el motor ya terminó la campaña, por eso el reintento no puede salir
// del flujo normal de envío y necesita dispararse aparte.
//   131026 → el número no tiene WhatsApp / no se puede entregar
//   131049 → tope de frecuencia de marketing para ese destinatario
//   130472 → experimento de límites de marketing de Meta
// Excluidos a propósito:
//   131042 → problema de la CUENTA (método de pago): el alterno fallaría igual
//   131050 → el usuario hizo opt-out de marketing: no se esquiva por otra línea
export const RETRY_ALTERNO = {
  codigos: (process.env.RETRY_ALTERNO_CODES || '131026,131049,130472')
    .split(',').map((s) => s.trim()).filter(Boolean),
  maxPorLote: Number(process.env.RETRY_ALTERNO_MAX || 200),
};

// Aplana el resultado de cada intento a las columnas que lee el CRM.
function columnasPorNumero(intentos, phoneUsed) {
  return {
    phone1: intentos[1]?.phone ?? null,
    failureCode1: intentos[1]?.code ?? null,
    failureReason1: intentos[1]?.reason?.substring(0, 500) ?? null,
    phone2: intentos[2]?.phone ?? null,
    failureCode2: intentos[2]?.code ?? null,
    failureReason2: intentos[2]?.reason?.substring(0, 500) ?? null,
    phoneUsed: phoneUsed ?? null,
  };
}

export class WhatsAppCampaignManager {
  async waitForRateLimit() {
    const interval = 1000 / RATE_LIMIT.messagesPerSecond;
    const now = Date.now();
    const slot = Math.max(now, _nextSendSlot);  // reserva atómica del próximo slot
    _nextSendSlot = slot + interval;
    const waitMs = slot - now;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  async sendMessageWithRetry(payload, phoneFormatted, attempt = 1) {
    try {
      const result = await sendTemplateMessage(payload);
      return { success: true, ...result, attemptsMade: attempt };
    } catch (error) {
      // Rate limit de Meta (130429, o HTTP 429): no descartar — esperar más y
      // reintentar con backoff exponencial + jitter, para darle tiempo al límite
      // a recuperarse. Para errores normales/permanentes: reintento corto.
      const isRateLimit = error.metaErrorCode === 130429 || error.httpStatus === 429;
      const maxAttempts = isRateLimit ? RATE_LIMIT.rateLimitRetries : RATE_LIMIT.retryAttempts;

      if (attempt < maxAttempts) {
        const delay = isRateLimit
          ? Math.min(1000 * 2 ** (attempt - 1), 8000) + Math.floor(Math.random() * 400)
          : RATE_LIMIT.retryDelay;
        await new Promise((resolve) => setTimeout(resolve, delay));
        return this.sendMessageWithRetry(payload, phoneFormatted, attempt + 1);
      }

      const classified = classifyError(error);
      return {
        success: false,
        status: classified.status,
        errorCode: classified.code,
        metaErrorCode: error.metaErrorCode,
        errorMessage: error.message,
        attemptsMade: attempt,
      };
    }
  }

  async recordSuccess(campaignContact, result, mensajeFinal, cliente, campaign, template, phoneFormatted, intentos = {}) {
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
          // Se conserva el error del 1er número aunque el envío haya salido por
          // el alterno: el CRM lo muestra como "falló con el teléfono 1".
          ...columnasPorNumero(intentos, phoneFormatted),
        },
      });

      // Upsert porque el webhook de Python puede haber insertado primero
      // con template_name='desconocida' (race entre status callback de Meta
      // y la transacción del motor). Si ya existe, sobrescribe el placeholder
      // con los datos reales; si no, lo crea normalmente.
      const mensajeOutData = {
        campaignContactId: campaignContact.id,
        campaignId: campaign.id,
        phoneTo: phoneFormatted,
        templateName: template.nombre,
        templateLang: DEFAULT_LANGUAGE,
        sentAt: now,
      };
      await tx.mensajeOut.upsert({
        where: { idMsg: result.messageId },
        create: { idMsg: result.messageId, ...mensajeOutData },
        update: mensajeOutData,
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

  async recordFailure(campaignContact, result, intentos = {}) {
    const prisma = getPrisma();
    await prisma.campaignContact.update({
      where: { id: campaignContact.id },
      data: {
        sendStatus: 'failed',
        // failureCode/failureReason quedan con el ÚLTIMO error, como siempre,
        // para no romper lo que el CRM ya lee. El detalle por número va aparte.
        failedAt: new Date(),
        failureCode: result.errorCode,
        failureReason: result.errorMessage?.substring(0, 500),
        retryCount: result.attemptsMade,
        ...columnasPorNumero(intentos, null),
      },
    });
  }

  /**
   * Envía a UN contacto, probando sus números en orden (principal y luego el
   * alterno). Corta apenas uno funciona. De cada número se guarda qué pasó,
   * para que el CRM pueda mostrar los errores separados por teléfono.
   */
  async procesarContacto(campaignContact, campaign, mappings) {
    const cliente = campaignContact.cliente;

    // El cliente pidió no recibir más mensajes (clientes.opt_out, lo marca el
    // bot educador). Se chequea al momento de enviar y no al crear la campaña,
    // porque puede haber pedido salir en el medio. No se llama a Meta.
    if (cliente?.opt_out) {
      const fallo = {
        status: 'failed',
        errorCode: 'OPT_OUT',
        errorMessage: 'El cliente pidió no recibir mensajes (opt_out)',
        attemptsMade: 0,
      };
      await this.recordFailure(campaignContact, fallo, {});
      return { ...fallo, success: false };
    }

    const mensajeFinal = processMessageText(campaign.template, cliente, mappings);

    const intentos = {};
    const yaIntentados = [];
    let exito = null;
    let phoneUsed = null;
    let ultimoFallo = null;

    for (const slot of PHONE_SLOTS) {
      const raw = cliente?.[slot.campo];
      if (!raw || !String(raw).trim()) continue;   // el cliente no tiene ese número

      const phoneFormatted = formatPhoneColombia(raw);
      if (!phoneFormatted) {
        intentos[slot.n] = {
          phone: String(raw).substring(0, 20),
          code: 'INVALID_PHONE',
          reason: `Teléfono inválido: ${raw}`,
        };
        continue;
      }

      if (yaIntentados.includes(last10(phoneFormatted))) continue;  // mismo número
      yaIntentados.push(last10(phoneFormatted));

      await this.waitForRateLimit();

      const payload = prepareMessagePayload(campaign.template, cliente, mappings, phoneFormatted);
      const result = await this.sendMessageWithRetry(payload, phoneFormatted);

      if (result.success) {
        exito = result;
        phoneUsed = phoneFormatted;
        intentos[slot.n] = { phone: phoneFormatted, code: null, reason: null };
        break;
      }

      ultimoFallo = result;
      intentos[slot.n] = {
        phone: phoneFormatted,
        code: result.errorCode,
        reason: result.errorMessage,
      };

      // El rate limit es del número emisor, no del destinatario: ya se reintentó
      // con backoff y probar el alterno daría exactamente el mismo error.
      if (result.metaErrorCode === 130429 || result.status === 'rate_limited') break;
    }

    if (exito) {
      await this.recordSuccess(campaignContact, exito, mensajeFinal, cliente, campaign, campaign.template, phoneUsed, intentos);
      return exito;
    }

    const fallo = ultimoFallo ?? {
      status: 'failed',
      errorCode: 'INVALID_PHONE',
      errorMessage: `Teléfono inválido: ${cliente?.telefono}`,
      attemptsMade: 0,
    };
    await this.recordFailure(campaignContact, fallo, intentos);
    return { ...fallo, success: false };
  }

  /**
   * Reintenta UN contacto por su número alterno (telefono_3). Lo dispara el
   * webhook cuando Meta avisa que el mensaje no se entregó: en ese momento la
   * campaña ya terminó, así que este camino es la única forma de rescatarlo.
   * Es idempotente — si llega dos veces (Meta reenvía webhooks), solo actúa una.
   */
  async retryAlternoContacto(campaignContactId) {
    const prisma = getPrisma();
    const schema = process.env.DB_SCHEMA || 'sayasend';

    const cc = await prisma.campaignContact.findUnique({
      where: { id: campaignContactId },
      include: { cliente: true, campaign: { include: { template: true } } },
    });
    if (!cc) return { retried: false, reason: 'contacto_no_encontrado' };
    if (cc.sendStatus !== 'failed') return { retried: false, reason: `estado_${cc.sendStatus}` };
    if (cc.phone2) return { retried: false, reason: 'alterno_ya_intentado' };
    if (cc.cliente?.opt_out) return { retried: false, reason: 'opt_out' };
    if (!RETRY_ALTERNO.codigos.includes(String(cc.failureCode))) {
      return { retried: false, reason: `codigo_no_reintentable_${cc.failureCode}` };
    }

    const alterno = formatPhoneColombia(cc.cliente?.telefono3);
    if (!alterno) return { retried: false, reason: 'sin_alterno_valido' };
    const principal = formatPhoneColombia(cc.cliente?.telefono);
    if (principal && last10(alterno) === last10(principal)) {
      return { retried: false, reason: 'alterno_igual_al_principal' };
    }

    // Reserva ATÓMICA del intento: si llegan dos webhooks duplicados a la vez,
    // solo uno se queda con el turno (el UPDATE exige phone_2 IS NULL). De paso
    // mueve el error del 1er número a failure_code_1 — el webhook lo había
    // escrito en failure_code a secas, porque no sabe de intentos por número.
    const claim = await prisma.$queryRawUnsafe(
      `UPDATE "${schema}".campaign_contacts
          SET phone_2 = $1,
              phone_1 = COALESCE(phone_1, $2),
              failure_code_1 = COALESCE(failure_code_1, failure_code),
              failure_reason_1 = COALESCE(failure_reason_1, failure_reason)
        WHERE id = $3::uuid AND phone_2 IS NULL
        RETURNING id`,
      alterno, principal ?? null, campaignContactId,
    );
    if (!claim.length) return { retried: false, reason: 'alterno_ya_intentado' };

    const template = cc.campaign.template;
    const mappings = cc.campaign.variableMappings || {};
    const mensajeFinal = processMessageText(template, cc.cliente, mappings);
    const payload = prepareMessagePayload(template, cc.cliente, mappings, alterno);

    await this.waitForRateLimit();
    const result = await this.sendMessageWithRetry(payload, alterno);
    const now = new Date();

    if (!result.success) {
      await prisma.campaignContact.update({
        where: { id: cc.id },
        data: {
          failureCode2: result.errorCode,
          failureReason2: result.errorMessage?.substring(0, 500),
          failedAt: now,
        },
      });
      console.log(`[RETRY-ALTERNO] ${cc.id} · el alterno también falló (${result.errorCode})`);
      return { retried: true, success: false, phone: alterno, errorCode: result.errorCode };
    }

    await prisma.$transaction(async (tx) => {
      await tx.campaignContact.update({
        where: { id: cc.id },
        data: {
          sendStatus: 'sent',
          sentAt: now,
          whatsappMessageId: result.messageId,
          personalizedMessage: mensajeFinal,
          phoneUsed: alterno,
          // El motivo del 1er fallo ya quedó guardado en failure_code_1.
          failedAt: null,
          failureCode: null,
          failureReason: null,
          failureCode2: null,
          failureReason2: null,
        },
      });

      const mensajeOutData = {
        campaignContactId: cc.id,
        campaignId: cc.campaignId,
        phoneTo: alterno,
        templateName: template.nombre,
        templateLang: DEFAULT_LANGUAGE,
        sentAt: now,
      };
      await tx.mensajeOut.upsert({
        where: { idMsg: result.messageId },
        create: { idMsg: result.messageId, ...mensajeOutData },
        update: mensajeOutData,
      });
      await tx.mensajeStatusEvent.create({
        data: {
          idMsg: result.messageId,
          estado: result.status || 'sent',
          tsUnix: BigInt(Math.floor(now.getTime() / 1000)),
          recipientId: alterno,
        },
      });
    });

    await logMessageToFirestore({
      cliente: cc.cliente,
      mensaje: mensajeFinal,
      template,
      messageId: result.messageId,
      campaignId: cc.campaignId,
      estado: result.status || 'sent',
    });

    console.log(`[RETRY-ALTERNO] ${cc.id} RESCATADO por ${alterno} (el 1º falló con ${cc.failureCode})`);
    return { retried: true, success: true, phone: alterno, messageId: result.messageId };
  }

  /**
   * Modo lote: recorre los fallidos que todavía tienen el alterno sin usar.
   * Sirve para recuperar el backlog anterior a este cambio y como botón manual.
   */
  async retryAlternosLote({ campaignId = null, limit = RETRY_ALTERNO.maxPorLote } = {}) {
    const prisma = getPrisma();
    const schema = process.env.DB_SCHEMA || 'sayasend';

    const filas = await prisma.$queryRawUnsafe(
      `SELECT cc.id::text AS id
         FROM "${schema}".campaign_contacts cc
         JOIN "${schema}".clientes cl ON cl.id = cc.cliente_id
        WHERE cc.send_status = 'failed'
          AND cc.phone_2 IS NULL
          AND cc.failure_code = ANY($1)
          AND NOT cl.opt_out
          AND cl.telefono_3 IS NOT NULL AND btrim(cl.telefono_3) <> ''
          AND right(regexp_replace(cl.telefono_3, '[^0-9]', '', 'g'), 10)
           <> right(regexp_replace(cl.telefono, '[^0-9]', '', 'g'), 10)
          AND ($2::uuid IS NULL OR cc.campaign_id = $2::uuid)
        ORDER BY cc.failed_at DESC NULLS LAST
        LIMIT $3`,
      RETRY_ALTERNO.codigos, campaignId, limit,
    );

    console.log(`[RETRY-ALTERNO] lote: ${filas.length} candidatos`);
    const resultados = [];
    for (const fila of filas) {
      resultados.push(await this.retryAlternoContacto(fila.id));
    }

    const rescatados = resultados.filter((r) => r.success).length;
    const fallaron = resultados.filter((r) => r.retried && !r.success).length;
    console.log(`[RETRY-ALTERNO] lote terminado | rescatados=${rescatados} | el alterno falló=${fallaron}`);
    return { candidatos: filas.length, rescatados, fallaron, omitidos: resultados.length - rescatados - fallaron };
  }

  async processCampaign(campaignId) {
    const previousChain = _campaignChain;
    let releaseLock;
    _campaignChain = new Promise((resolve) => { releaseLock = resolve; });

    const queueStart = Date.now();
    await previousChain;
    const waitedMs = Date.now() - queueStart;
    if (waitedMs > 50) {
      console.log(`[MUTEX] Campaign ${campaignId} esperó ${waitedMs}ms en cola`);
    }

    try {
      return await this._runCampaign(campaignId);
    } finally {
      releaseLock();
    }
  }

  async _runCampaign(campaignId) {
    const prisma = getPrisma();

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
        template: true,
        campaignContacts: {
          // Solo procesamos los que están 'pending' (nunca enviados).
          // Los que terminaron en 'failed' se pueden reintentar aparte.
          // 'sent', 'delivered', 'read' ya tuvieron un intento exitoso.
          where: { sendStatus: 'pending' },
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

    console.log(`[TIMING] Campaign ${campaignId} | ${campaign.campaignContacts.length} pending | ${batches.length} batches of ${RATE_LIMIT.batchSize} | started`);

    const processBatch = async (batch, batchIndex) => {
      const batchStart = Date.now();
      const batchPromises = batch.map((campaignContact) =>
        this.procesarContacto(campaignContact, campaign, mappings));

      const results = await Promise.all(batchPromises);
      const ok = results.filter((r) => r.success).length;
      const batchMs = Date.now() - batchStart;
      console.log(`[TIMING] Batch ${batchIndex + 1}/${batches.length} done in ${batchMs}ms | ${ok}/${batch.length} OK`);
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
    const optOut = allResults.filter((r) => r.errorCode === 'OPT_OUT').length;
    const rate = (allResults.length / (totalMs / 1000)).toFixed(1);
    console.log(`[TIMING] Campaign ${campaignId} finished in ${(totalMs / 1000).toFixed(2)}s | sent=${sent}/${allResults.length} | failed=${failed} (opt_out=${optOut}) | rate=${rate}msg/s`);

    return {
      total: allResults.length,
      sent,
      failed,
      optOut,
      batchesProcessed: batches.length,
      totalTimeMinutes: (totalMs / 60000).toFixed(2),
      messagesPerSecond: (allResults.length / (totalMs / 1000)).toFixed(2),
      successRate: ((sent / allResults.length) * 100).toFixed(1),
    };
  }
}
