const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

// 1. Conectar con Firebase usando las variables de entorno
const serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${serviceAccount.project_id}-default-rtdb.firebaseio.com`
});

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

// RUTA 1: Crear factura Lightning personalizada
app.get('/crear-factura', async (req, res) => {
  try {
    const centavos = parseInt(req.query.centavos) || 99; // $0.99 por defecto
    const memo = req.query.memo || 'Compra NovaStore';

    // Obtener Wallet ID
    const meQuery = `query Me { me { defaultAccount { defaultWalletId wallets { id walletCurrency } } } }`;
    const meRes = await consultarBlink(meQuery);
    
    let walletId = meRes?.data?.me?.defaultAccount?.defaultWalletId;
    const wallets = meRes?.data?.me?.defaultAccount?.wallets || [];
    const usdWallet = wallets.find(w => w.walletCurrency === 'USD');
    if (usdWallet) walletId = usdWallet.id;

    if (!walletId) {
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
      res.json({
        status: "success",
        invoice: invoice.paymentRequest,
        hash: invoice.paymentHash
      });
    } else {
      res.status(500).json({ error: "Error creando factura", detalle: invoiceRes });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RUTA 2: Verificar si el cliente ya pagó la factura en Blink
app.get('/verificar-pago', async (req, res) => {
  try {
    const { hash, uid, appId } = req.query;
    if (!hash || !uid || !appId) {
      return res.status(400).json({ error: "Faltan parámetros: hash, uid o appId" });
    }

    const query = `query LnInvoicePaymentStatusByHash($input: LnInvoicePaymentStatusByHashInput!) {
      lnInvoicePaymentStatusByHash(input: $input) {
        status
      }
    }`;

    const result = await consultarBlink(query, { input: { paymentHash: hash } });
    const status = result?.data?.lnInvoicePaymentStatusByHash?.status;

    if (status === "PAID") {
      // Registrar la compra en Firebase Realtime Database
      await db.ref(`usuarios/${uid}/compras/${appId}`).set({
        comprado: true,
        metodo: "Bitcoin Lightning (Blink)",
        paymentHash: hash,
        fecha: Date.now()
      });

      return res.json({ status: "PAID", message: "Pago completado y app desbloqueada" });
    }

    res.json({ status: "PENDING", message: "Esperando pago en la red Lightning" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RUTA 3: Webhook para Wompi (si luego lo activas)
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
    }
    res.sendStatus(200);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor activo en el puerto ${PORT}`);
});
