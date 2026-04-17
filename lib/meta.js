const META_GRAPH_VERSION = 'v23.0';
const DEFAULT_LANGUAGE = 'es_CO';

function getEnv() {
  const { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID } = process.env;
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
    throw new Error('Meta no configurado: falta META_ACCESS_TOKEN o META_PHONE_NUMBER_ID');
  }
  return { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID };
}

/**
 * Normaliza un número a formato WhatsApp para Colombia.
 * Colombia: código país 57, móviles de 10 dígitos empezando con 3.
 * Retorna número normalizado o null si no es válido.
 */
export function formatPhoneColombia(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().replace(/[^0-9+]/g, '').replace(/^\+/, '');

  if (/^57\d{10}$/.test(clean)) return clean;
  if (/^3\d{9}$/.test(clean)) return `57${clean}`;
  if (/^\d{10}$/.test(clean)) return `57${clean}`;
  return null;
}

/**
 * Construye el payload para Meta con parámetros de template.
 */
export function prepareMessagePayload(template, cliente, mappings, phoneFormatted, languageCode = DEFAULT_LANGUAGE) {
  const sortedIndices = Object.keys(mappings).sort((a, b) => parseInt(a) - parseInt(b));
  const bodyParams = [];

  for (const idx of sortedIndices) {
    const field = mappings[idx];
    let valor = cliente[field] ?? '';
    valor = String(valor).trim().replace(/,+$/, '');
    bodyParams.push({ type: 'text', text: valor });
  }

  return {
    messaging_product: 'whatsapp',
    to: phoneFormatted,
    type: 'template',
    template: {
      name: template.nombre,
      language: { code: languageCode },
      components: bodyParams.length > 0 ? [{ type: 'body', parameters: bodyParams }] : [],
    },
  };
}

/**
 * Genera el mensaje final con variables reemplazadas (para guardar como referencia).
 */
export function processMessageText(template, cliente, mappings) {
  const sortedIndices = Object.keys(mappings).sort((a, b) => parseInt(a) - parseInt(b));
  let texto = template.contenido || `Template: ${template.nombre}`;

  for (const idx of sortedIndices) {
    const field = mappings[idx];
    let valor = cliente[field] ?? '';
    valor = String(valor).trim().replace(/,+$/, '');
    texto = texto.replace(new RegExp(`{{\\s*${idx}\\s*}}`, 'g'), valor);
  }

  return texto;
}

/**
 * Envía un mensaje a Meta. Retorna { success, messageId, status } o { success: false, ... }.
 */
export async function sendTemplateMessage(payload) {
  const { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID } = getEnv();

  const response = await fetch(`https://graph.facebook.com/${META_GRAPH_VERSION}/${META_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${META_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const data = await response.json();

  if (response.ok && data.messages?.length > 0) {
    const msg = data.messages[0];
    return { success: true, messageId: msg.id, status: msg.message_status || 'sent' };
  }

  const err = new Error(`Meta API Error (${response.status}): ${data.error?.message || 'Unknown'}`);
  err.httpStatus = response.status;
  err.metaErrorCode = data.error?.code;
  throw err;
}

/**
 * Verifica si una template está APROBADA en Meta Business.
 * Returns { approved: boolean, status: string } o null si no se pudo verificar.
 */
export async function verifyTemplateApproved(templateName) {
  const { META_ACCESS_TOKEN, META_BUSINESS_ACCOUNT_ID } = getEnv();
  if (!META_BUSINESS_ACCOUNT_ID) return null;

  try {
    const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${META_BUSINESS_ACCOUNT_ID}/message_templates?name=${encodeURIComponent(templateName)}`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } });
    if (!response.ok) return null;
    const data = await response.json();
    const template = data.data?.[0];
    if (!template) return null;
    return { approved: template.status === 'APPROVED', status: template.status };
  } catch (error) {
    console.warn('⚠️ [META] Error verificando template:', error.message);
    return null;
  }
}

/**
 * Clasifica un error en un código simbólico.
 */
export function classifyError(error) {
  const msg = error.message || '';
  const status = error.httpStatus;

  if (status === 400) return { code: 'META_REJECTED', status: 'rejected' };
  if (status === 401 || status === 403) return { code: 'META_UNAUTHORIZED', status: 'unauthorized' };
  if (status === 429) return { code: 'META_RATE_LIMITED', status: 'rate_limited' };
  if (status >= 500) return { code: 'META_SERVER_ERROR', status: 'server_error' };
  if (msg.includes('timeout') || msg.includes('fetch')) return { code: 'NETWORK_ERROR', status: 'network_failed' };
  return { code: 'UNKNOWN_ERROR', status: 'failed' };
}
