import express from 'express';
import cors from 'cors';
import { initDb, getPrisma, closeDb } from './lib/db.js';
import { initFirebase } from './lib/firebase.js';
import { WhatsAppCampaignManager } from './lib/campaign-manager.js';
import { verifyWebhook, processWebhook } from './lib/webhook-handler.js';

const SERVICE_NAME = 'sayasent-colombia-envios';

function jsonSafe(obj) {
  return JSON.parse(
    JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? Number(v) : v))
  );
}

async function main() {
  await initDb();
  initFirebase();

  const app = express();
  const PORT = process.env.PORT || 8080;
  const campaignManager = new WhatsAppCampaignManager();

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  // ===== Health / info =====
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: SERVICE_NAME, timestamp: new Date().toISOString() });
  });

  app.get('/', (_req, res) => {
    res.json({
      service: 'Sayasent Colombia — motor de envíos WhatsApp',
      version: '1.0.0',
      endpoints: [
        'GET  /health',
        'GET  /api/campaigns',
        'GET  /api/campaigns/:id',
        'POST /api/campaigns/:id/send',
        'GET  /api/campaigns/:id/metrics',
        'GET  /api/templates',
        'GET  /api/templates/:id',
        'POST /api/templates',
        'GET  /api/contacts?segmento=&estrategia=',
        'GET  /webhook/whatsapp',
        'POST /webhook/whatsapp',
      ],
    });
  });

  // ===== Campañas =====
  app.get('/api/campaigns', async (_req, res) => {
    try {
      const prisma = getPrisma();
      const campaigns = await prisma.campaign.findMany({
        include: {
          template: true,
          _count: { select: { campaignContacts: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: campaigns });
    } catch (e) {
      console.error('[GET /campaigns] Error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/campaigns/:id', async (req, res) => {
    try {
      const prisma = getPrisma();
      const campaign = await prisma.campaign.findUnique({
        where: { id: req.params.id },
        include: {
          template: true,
          campaignContacts: {
            include: { cliente: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (!campaign) return res.status(404).json({ success: false, error: 'Campaign not found' });
      res.json({ success: true, data: campaign });
    } catch (e) {
      console.error('[GET /campaigns/:id] Error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/campaigns/:id/send', async (req, res) => {
    const campaignId = req.params.id;
    console.log(`🚀 [SEND] Iniciando campaña ${campaignId}`);
    try {
      const result = await campaignManager.processCampaign(campaignId);
      console.log(`✅ [SEND] Campaña ${campaignId} terminada:`, result);
      res.json({ success: true, summary: { campaignId, ...result } });
    } catch (e) {
      console.error(`❌ [SEND] Error en campaña ${campaignId}:`, e);
      res.status(500).json({ success: false, error: e.message, campaignId });
    }
  });

  app.get('/api/campaigns/:id/metrics', async (req, res) => {
    try {
      const prisma = getPrisma();
      const schema = process.env.DB_SCHEMA || 'sayasend';
      const rows = await prisma.$queryRawUnsafe(
        `SELECT * FROM "${schema}".vw_campaign_metrics WHERE campaign_id = $1::uuid`,
        req.params.id
      );
      if (!rows || rows.length === 0) {
        return res.status(404).json({ success: false, error: 'Metrics not found' });
      }
      res.json({ success: true, data: jsonSafe(rows[0]) });
    } catch (e) {
      console.error('[GET /campaigns/:id/metrics] Error:', e);
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Templates =====
  app.get('/api/templates', async (_req, res) => {
    try {
      const prisma = getPrisma();
      const templates = await prisma.template.findMany({ orderBy: { nombre: 'asc' } });
      res.json({ success: true, data: templates });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/api/templates/:id', async (req, res) => {
    try {
      const prisma = getPrisma();
      const t = await prisma.template.findUnique({ where: { id: req.params.id } });
      if (!t) return res.status(404).json({ success: false, error: 'Template not found' });
      res.json({ success: true, data: t });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/api/templates', async (req, res) => {
    try {
      const { nombre, descripcion, contenido } = req.body;
      if (!nombre || !contenido) {
        return res.status(400).json({ success: false, error: 'nombre y contenido son requeridos' });
      }
      const prisma = getPrisma();
      const t = await prisma.template.create({
        data: { nombre, descripcion: descripcion || null, contenido },
      });
      res.status(201).json({ success: true, data: t });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Contacts =====
  app.get('/api/contacts', async (req, res) => {
    try {
      const { segmento, estrategia } = req.query;
      const where = {};
      if (segmento) where.segmento = String(segmento);
      if (estrategia) where.estrategia = String(estrategia);
      const prisma = getPrisma();
      const contacts = await prisma.cliente.findMany({
        where,
        orderBy: { nombre: 'asc' },
      });
      res.json({ success: true, data: contacts });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ===== Webhook Meta =====
  app.get('/webhook/whatsapp', verifyWebhook);

  app.post('/webhook/whatsapp', async (req, res) => {
    // Responder 200 siempre para que Meta no reintente; procesamos best-effort.
    res.json({ received: true, timestamp: new Date().toISOString() });
    try {
      await processWebhook(req.body);
    } catch (e) {
      console.error('❌ [WEBHOOK] Error procesando:', e);
    }
  });

  // ===== Start / graceful shutdown =====
  const server = app.listen(PORT, () => {
    console.log(`🚀 ${SERVICE_NAME} corriendo en puerto ${PORT}`);
  });

  const shutdown = async (signal) => {
    console.log(`🛑 [${signal}] Shutting down...`);
    server.close(async () => {
      await closeDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  console.error('💥 Error fatal al arrancar:', e);
  process.exit(1);
});
