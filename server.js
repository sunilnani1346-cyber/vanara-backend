require("dotenv").config();

const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

if (!process.env.FIREBASE_KEY) {
  throw new Error("❌ FIREBASE_KEY is not set in environment variables!");
}
if (!process.env.RAZORPAY_WEBHOOK_SECRET) {
  console.warn("⚠️  RAZORPAY_WEBHOOK_SECRET not set — webhook verification will fail!");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());

// IMPORTANT: capture raw body for webhook signature verification,
// while still parsing JSON normally for all routes.
app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Keep alive — Render free tier sleep avvakunda
setInterval(() => {
  fetch("https://vanara-backend.onrender.com/").catch(() => {});
}, 14 * 60 * 1000);

app.get("/", (req, res) => {
  res.send("Vanara Backend Running 🚀");
});

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET
});

const PRICE_PER_UNIT = 499;

// Helper: idempotent order save — same payment_id never creates duplicates
async function saveOrderToFirestore(data, source) {
  const paymentId = data.razorpay_payment_id;
  if (!paymentId) throw new Error("Missing razorpay_payment_id, cannot save");

  await db.collection("orders").doc(paymentId).set({
    name:                data.name || "",
    phone:               data.phone || "",
    address:             data.address || "",
    city:                data.city || "",
    state:               data.state || "",
    country:             data.country || "",
    pincode:             data.pincode || "",
    qty:                 data.qty || "",
    amount:               data.amount || "",
    razorpay_order_id:    data.razorpay_order_id || "",
    razorpay_payment_id:  paymentId,
    razorpay_signature:   data.razorpay_signature || "",
    status:    "Order Confirmed",
    savedVia:  source, // "client" or "webhook" — helps you debug later
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  console.log(`✅ Order saved via [${source}] — payment_id: ${paymentId}`);
}

// CREATE ORDER — qty + delivery details తీసుకుని, notes లో attach చేస్తుంది
// (notes Razorpay order/payment తో పాటు webhook payload లో కూడా వస్తాయి —
//  అదే మన safety net పని చేయడానికి కీలకం)
app.post("/create-order", async (req, res) => {
  console.log("📥 /create-order hit:", JSON.stringify(req.body));
  try {
    const qty = Math.min(parseInt(req.body.qty) || 1, 20);
    const amount = qty * PRICE_PER_UNIT;

    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      receipt: "order_" + Date.now(),
      notes: {
        name:    req.body.name    || "",
        phone:   req.body.phone   || "",
        address: req.body.address || "",
        city:    req.body.city    || "",
        state:   req.body.state   || "",
        country: req.body.country || "",
        pincode: req.body.pincode || "",
        qty:     String(qty)
      }
    });

    console.log("✅ /create-order success:", order.id);
    res.json(order);
  } catch (err) {
    console.error("❌ create-order error:", err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// VERIFY PAYMENT (separate endpoint, client-side fast-path)
app.post("/verify-payment", async (req, res) => {
  console.log("📥 /verify-payment hit:", JSON.stringify(req.body));
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ /verify-payment signature mismatch");
      return res.status(400).json({ status: "failed", error: "Invalid signature" });
    }

    console.log("✅ /verify-payment success");
    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ verify-payment error:", err);
    res.status(500).json({ status: "failed", error: "Verification error" });
  }
});

// SAVE ORDER — client-side fast-path (works when browser stays alive, e.g. card payments)
app.post("/save-order", async (req, res) => {
  console.log("📥 /save-order hit. Body received:", JSON.stringify(req.body));
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      console.error("❌ /save-order signature mismatch");
      return res.status(400).json({ error: "Invalid payment" });
    }

    await saveOrderToFirestore(req.body, "client");
    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ save-order error (FULL):", err);
    res.status(500).json({ error: "Save failed", details: err.message });
  }
});

// ── 🔒 RAZORPAY WEBHOOK — SAFETY NET ──
// Razorpay server నుండి direct గా notify అవుతుంది, browser మీద depend అవ్వదు.
// UPI app switch, page reload, browser close — ఏదైనా జరిగినా ఇది order save చేస్తుంది.
app.post("/razorpay-webhook", async (req, res) => {
  try {
    const signature = req.headers["x-razorpay-signature"];
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ /razorpay-webhook invalid signature");
      return res.status(400).send("Invalid signature");
    }

    const event = req.body.event;
    console.log("📥 /razorpay-webhook event:", event);

    if (event === "payment.captured" || event === "order.paid") {
      const payment = req.body.payload?.payment?.entity;
      const order   = req.body.payload?.order?.entity;
      const notes   = payment?.notes || order?.notes || {};

      if (payment && payment.id) {
        await saveOrderToFirestore({
          name:                notes.name,
          phone:                notes.phone,
          address:              notes.address,
          city:                  notes.city,
          state:                notes.state,
          country:               notes.country,
          pincode:               notes.pincode,
          qty:                    notes.qty,
          amount:                 payment.amount / 100,
          razorpay_order_id:      payment.order_id,
          razorpay_payment_id:    payment.id,
          razorpay_signature:     ""  // not applicable for webhook path
        }, "webhook");
      }
    }

    // Razorpay కి వెంటనే 200 పంపాలి, లేదంటే retry చేస్తూ ఉంటుంది
    res.status(200).json({ status: "ok" });
  } catch (err) {
    console.error("❌ razorpay-webhook error:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));