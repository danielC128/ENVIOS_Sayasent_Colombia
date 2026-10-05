const META_GRAPH_VERSION = 'v23.0';
const DEFAULT_LANGUAGE = 'es_CO';

/**
 * Normaliza las keys del variableMappings al formato canónico numérico
 * ("1", "2", ...). Acepta keys como "1", "{{1}}", "{{ 1 }}", etc. y
 * siempre devuelve { "N": valor }. Descarta keys sin dígitos.
 */
function normalizeMappings(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    const digits = String(key).replace(/[^\d]/g, '');
    if (digits) out[digits] = value;
  }
  return out;
}

const MONTHS_ES = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

/**
 * Formatea el valor de una variable para un template de WhatsApp.
 * Las columnas @db.Date (fechaAsamblea, fechaVencimiento, fecUltPagCcap)
 * vienen como Date JS en UTC midnight. String(date) produce algo como
 * "Sun May 10 2026 00:00:00 GMT+0000 ..." — por eso se formatea explícito.
 * Se leen partes UTC para no recorrer el día según el TZ del server.
 */
function formatVariableValue(raw) {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) {
    const day = raw.getUTCDate();
    const month = MONTHS_ES[raw.getUTCMonth()];
    const year = raw.getUTCFullYear();
    return `${day} de ${month} de ${year}`;
  }
  return String(raw).trim().replace(/,+$/, '');
}

function getEnv() {
  const { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID } = process.env;
  if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
    throw new Error('Meta no configurado: falta META_ACCESS_TOKEN o META_PHONE_NUMBER_ID');
  }
  return { META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID };
}

/**
 * Normaliza un número a formato WhatsApp para Colombia.
 * Soporta formatos de Colombia y Perú (principalmente para testing con
 * ambos países durante la transición). Retorna número normalizado para
 * WhatsApp (sin + prefijo, solo dígitos) o null si no es válido.
 *
 * Colombia (prefijo 57): móviles de 10 dígitos empezando con 3.
 * Perú (prefijo 51): móviles de 9 dígitos empezando con 9.
 */
export function formatPhone(raw) {
  if (!raw) return null;
  const clean = String(raw).trim().replace(/[^0-9+]/g, '').replace(/^\+/, '');

  // Colombia — con o sin prefijo internacional
  if (/^57\d{10}$/.test(clean)) return clean;           // 57 + 10 dígitos
  if (/^3\d{9}$/.test(clean)) return `57${clean}`;      // móvil CO sin prefijo

  // Perú — con o sin prefijo internacional
  if (/^51\d{9}$/.test(clean)) return clean;            // 51 + 9 dígitos
  if (/^9\d{8}$/.test(clean)) return `51${clean}`;      // móvil PE sin prefijo

  // Fallback ambiguo: 10 dígitos sin prefijo → asumir Colombia
  if (/^\d{10}$/.test(clean)) return `57${clean}`;

  return null;
}

// Alias para compatibilidad con código que importaba la versión vieja.
export const formatPhoneColombia = formatPhone;

/**
 * Construye el payload para Meta con parámetros de template.
 */
export function prepareMessagePayload(template, cliente, mappings, phoneFormatted, languageCode = DEFAULT_LANGUAGE) {
  const normalizedMappings = normalizeMappings(mappings);
  const sortedIndices = Object.keys(normalizedMappings).sort((a, b) => parseInt(a) - parseInt(b));
  const bodyParams = [];

  for (const idx of sortedIndices) {
    const field = normalizedMappings[idx];
    const valor = formatVariableValue(cliente[field]);
    bodyParams.push({ type: 'text', text: valor });
  }

  const components = [];

  // Header media (IMAGE/VIDEO/DOCUMENT) — Meta requiere que se pase explícitamente
  // aunque la template ya tenga un sample aprobado. Usamos la URL guardada en
  // template.headerMediaUrl (subida al bucket GCS al crear la template).
  if (template.headerType === 'IMAGE' && template.headerMediaUrl) {
    components.push({
      type: 'header',
      parameters: [{ type: 'image', image: { link: template.headerMediaUrl } }],
    });
  } else if (template.headerType === 'VIDEO' && template.headerMediaUrl) {
    components.push({
      type: 'header',
      parameters: [{ type: 'video', video: { link: template.headerMediaUrl } }],
    });
  } else if (template.headerType === 'DOCUMENT' && template.headerMediaUrl) {
    components.push({
      type: 'header',
      parameters: [{ type: 'document', document: { link: template.headerMediaUrl } }],
    });
  }

  // Body parameters (variables {{1}}, {{2}}, ...)
  if (bodyParams.length > 0) {
    components.push({ type: 'body', parameters: bodyParams });
  }

  return {
    messaging_product: 'whatsapp',
    to: phoneFormatted,
    type: 'template',
    template: {
      name: template.nombre,
      // Usar el idioma real de la template (sincronizado desde Meta a la BD),
      // con fallback al languageCode pasado por argumento. Esto evita el error
      // Meta 132001 "Template name does not exist in the translation" que pasa
      // cuando la template solo está aprobada en un idioma distinto al default.
      language: { code: template.idioma || languageCode },
      components,
    },
  };
}

/**
 * Genera el mensaje final con variables reemplazadas (para guardar como referencia).
 */
export function processMessageText(template, cliente, mappings) {
  const normalizedMappings = normalizeMappings(mappings);
  const sortedIndices = Object.keys(normalizedMappings).sort((a, b) => parseInt(a) - parseInt(b));
  let texto = template.contenido || `Template: ${template.nombre}`;

  for (const idx of sortedIndices) {
    const field = normalizedMappings[idx];
    const valor = formatVariableValue(cliente[field]);
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
