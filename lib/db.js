import { Connector } from '@google-cloud/cloud-sql-connector';
import { PrismaClient } from '@prisma/client';
import { resolve } from 'path';

let prisma = null;
let connector = null;

export async function initDb() {
  if (prisma) return prisma;

  const { INSTANCE_CONNECTION_NAME, DB_USER, DB_PASS, DB_NAME, DB_SCHEMA } = process.env;

  if (!INSTANCE_CONNECTION_NAME || !DB_USER || !DB_PASS || !DB_NAME) {
    throw new Error('Faltan env vars críticas: INSTANCE_CONNECTION_NAME, DB_USER, DB_PASS, DB_NAME');
  }

  connector = new Connector();
  const socketDir = process.env.NODE_ENV === 'production' ? '/tmp' : process.cwd();
  const socketPath = resolve(socketDir, '.s.PGSQL.5432');

  console.log(`🔧 [DB] Creando proxy Cloud SQL en: ${socketPath}`);

  await connector.startLocalProxy({
    instanceConnectionName: INSTANCE_CONNECTION_NAME,
    ipType: 'PRIVATE',
    listenOptions: { path: socketPath },
  });

  let datasourceUrl = `postgresql://${DB_USER}:${DB_PASS}@localhost/${DB_NAME}?host=${socketDir}`;
  if (DB_SCHEMA) datasourceUrl += `&schema=${DB_SCHEMA}`;
  datasourceUrl += `&connection_limit=1&pool_timeout=30`;

  console.log(`🔌 [DB] Conectando Prisma (schema: ${DB_SCHEMA || 'public'})`);
  prisma = new PrismaClient({ datasourceUrl });
  await prisma.$connect();
  console.log('✅ [DB] Conexión establecida');

  return prisma;
}

export function getPrisma() {
  if (!prisma) throw new Error('DB no inicializada. Llamar initDb() primero.');
  return prisma;
}

export async function closeDb() {
  if (prisma) await prisma.$disconnect();
  if (connector) connector.close();
  prisma = null;
  connector = null;
}
