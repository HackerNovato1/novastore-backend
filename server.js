const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// Permitir peticiones cruzadas (CORS) y responder headers
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

// 1. Inicializar Firebase Admin
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
  });
}

const db = admin.database();
const BLINK_API_KEY = "blink_4IpaG7mgnmPFkyYC7tNGzKERSqj4vEpntcYqA58rFkDxdFenKhuviwjBIFw9ioHD";

// Función auxiliar para llamar a Blink GraphQL
async function consultarBlink(query, variables = {}) {
  const response = await fetch("https://api.blink.sv/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": BLINK_API_KEY
    },
    body: JSON.stringify({ query, variables })
  });
  return await response.json();
}

// RUTA DE PRUEBA: Comprobar que el servidor está despierto
app.get('/', (req, res) => {
  res.send("NovaStore Backend Activo en Render");
});

// RUTA 1: Crear factura Lightning en dólares / satoshis
app.get('/crear-factura', async (req, res) => {
  try {
    const centavos = parseInt(req.query.centavos) || 99; // $0.99 por defecto
    const memo = req.query.memo || 'Compra NovaStore';

    console.log(`[CREAR FACTURA] Centavos: ${centavos}, Memo: ${memo}`);

    const meQuery = `query Me { me { defaultAccount { defaultWalletId wallets { id walletCurrency } } } }`;
    const meRes = await consultarBlink(meQuery);
    
    let walletId = meRes?.data?.me?.defaultAccount?.defaultWalletId;
    const wallets = meRes?.data?.me?.defaultAccount?.wallets || [];
    const usdWallet = wallets.find(w => w.walletCurrency === 'USD');
    if (usdWallet) walletId = usdWallet.id;

    if (!walletId) {
      console.log("[ERROR] No se pudo obtener la billetera de Blink");
      return res.status(500).json({ error: "No se encontró billetera de Blink" });
    }

    const mutation = `mutation LnUsdInvoiceCreateOnBehalfOfRecipient($input: LnUsdInvoiceCreateOnBehalfOfRecipientInput!) {
      lnUsdInvoiceCreateOnBehalfOfRecipient(input: $input) {
        errors { message }
        invoice { paymentRequest paymentHash }
      }
    }`;

    const invoiceRes = await consultarBlink(mutation, {
      input: { recipientWalletId: walletId, amount: centavos, memo: memo }
    });

    const invoice = invoiceRes?.data?.lnUsdInvoiceCreateOnBehalfOfRecipient?.invoice;
    if (invoice) {
      console.log(`[FACTURA GENERADA] Hash: ${invoice.paymentHash}`);
      res.json({
        status: "success",
        invoice: invoice.paymentRequest,
        hash: invoice.paymentHash
      });
    } else {
      console.log("[ERROR FACTURA]", JSON.stringify(invoiceRes));
      res.status(500).json({ error: "Error creando factura", detalle: invoiceRes });
    }
  } catch (err) {
    console.error("[ERROR EN /crear-factura]", err);
    res.status(500).json({ error: err.message });
  }
});

// RUTA 2: Verificar si la factura ya fue pagada en Blink
app.get('/verificar-pago', async (req, res) => {
  const { hash, uid, appId } = req.query;
  console.log(`[SONDEO VERIFICAR] Hash: ${hash} | UID: ${uid} | AppId: ${appId}`);

  try {
    if (!hash || !uid || !appId) {
      console.log("[ERROR] Parámetros incompletos en petición");
      return res.status(400).json({ error: "Faltan parámetros: hash, uid o appId" });
    }

    const query = `query LnInvoicePaymentStatusByHash($input: LnInvoicePaymentStatusByHashInput!) {
      lnInvoicePaymentStatusByHash(input: $input) {
        status
      }
    }`;

    const result = await consultarBlink(query, { input: { paymentHash: hash } });
    const status = result?.data?.lnInvoicePaymentStatusByHash?.status;
    console.log(`[STATUS DESDE BLINK] ${status}`);

    if (status === "PAID" || status === "SUCCESS") {
      // Escribir en Firebase Realtime Database
      await db.ref(`usuarios/${uid}/compras/${appId}`).set({
        comprado: true,
        metodo: "Bitcoin Lightning (Blink)",
        paymentHash: hash,
        fecha: Date.now()
      });

      console.log(`[COMPRA GUARDADA] Usuario: ${uid}, App: ${appId}`);
      return res.json({ status: "PAID", message: "Pago liquidado y registrado con éxito" });
    }

    res.json({ status: "PENDING", message: "Esperando pago en la red Lightning" });
  } catch (err) {
    console.error("[ERROR EN /verificar-pago]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// RUTA 3: Webhook para Wompi
app.post('/webhook-wompi', async (req, res) => {
  try {
    const data = req.body;
    const tx = data?.data?.transaction || data;
    const estado = (tx?.status || tx?.resultado || "").toUpperCase();
    const referencia = tx?.reference || tx?.referencia || "";

    if ((estado === "APPROVED" || estado === "EXITOSA") && referencia.includes("_")) {
      const [uid, appId] = referencia.split("_");
      await db.ref(`usuarios/${uid}/compras/${appId}`).set({
        comprado: true,
        metodo: "Wompi",
        transaccionId: tx?.id || "N/A",
        fecha: Date.now()
      });
      console.log(`[WOMPI APROBADO] UID: ${uid}, App: ${appId}`);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("[ERROR WOMPI]", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
