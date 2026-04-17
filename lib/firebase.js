import admin from 'firebase-admin';

let firestoreDb = null;
const FIRESTORE_COLLECTION = 'sayasend';
const ID_BOT = 'sayasend';

export function initFirebase() {
  if (admin.apps.length) {
    firestoreDb = admin.firestore();
    return firestoreDb;
  }

  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firestoreDb = admin.firestore();
    console.log('✅ [FIREBASE] Inicializado');
  } catch (error) {
    console.warn('⚠️ [FIREBASE] Init falló:', error.message);
    firestoreDb = null;
  }

  return firestoreDb;
}

export function getFirestore() {
  return firestoreDb;
}

export async function logMessageToFirestore({ cliente, mensaje, template, messageId, campaignId, estado }) {
  if (!firestoreDb) return;

  try {
    const doc = {
      telefono: cliente.telefono,
      fecha: admin.firestore.Timestamp.fromDate(new Date()),
      id_bot: ID_BOT,
      id_cliente: cliente.id,
      mensaje,
      template_name: template.nombre,
      sender: 'false',
      message_id: messageId,
      campaign_id: campaignId,
      estado,
    };
    await firestoreDb.collection(FIRESTORE_COLLECTION).doc(cliente.telefono).set(doc, { merge: true });
  } catch (error) {
    console.warn('⚠️ [FIREBASE] Error guardando log:', error.message);
  }
}
