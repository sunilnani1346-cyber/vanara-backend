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

// ── PRODUCT PRICES (server lo ne decide avthundi — frontend nundi nammaddu) ──
const PRODUCTS = {
  "400g": { price: 599, label: "VANARA Mix 400 g" },
  "200g": { price: 320, label: "VANARA Mix 200 g" }
};
const DEFAULT_PRODUCT = "400g"; // product pampakapothe (old cached page) idi vaadataru

// Helper: idempotent order save — same payment_id never creates duplicates
async function saveOrderToFirestore(data, source) {
  const paymentId = data.razorpay_payment_id;
  if (!paymentId) throw new Error("Missing razorpay_payment_id, cannot save");

  await db.collection("orders").doc(paymentId).set({
    product:             data.product || "",
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

// CREATE ORDER — product + qty + delivery details తీసుకుని, notes లో attach చేస్తుంది
// (notes Razorpay order/payment తో పాటు webhook payload లో కూడా వస్తాయి —
//  అదే మన safety net పని చేయడానికి కీలకం)
app.post("/create-order", async (req, res) => {
  console.log("📥 /create-order hit:", JSON.stringify(req.body));
  try {
    const productKey = PRODUCTS[req.body.product] ? req.body.product : DEFAULT_PRODUCT;
    const qty = Math.min(parseInt(req.body.qty) || 1, 20);
    const amount = qty * PRODUCTS[productKey].price;

    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      receipt: "order_" + Date.now(),
      notes: {
        product: productKey,
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
            // 🎁 Sample order aite separate collection lo save chesi aagipo
      if (notes.type === "sample" && payment && payment.id) {
        await saveSampleOrder({
          ...notes,
          razorpay_order_id:   payment.order_id,
          razorpay_payment_id: payment.id
        }, "webhook");
        return res.status(200).json({ status: "ok" });
      }

      if (payment && payment.id) {
        await saveOrderToFirestore({
          product:              notes.product,
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
/* ══════════ SAMPLE ORDERS (new) ══════════ */
function sampleCharge(state){
  // Hyderabad nundi distance batti: TG/AP ₹100 · nearby states ₹120 · migatha ₹140
  const s = (state || "").trim().toLowerCase();
  const NEAR = ["karnataka", "tamil nadu", "maharashtra", "odisha", "chhattisgarh", "kerala", "goa", "puducherry"];
  if (s === "telangana" || s === "andhra pradesh") return 100;
  if (NEAR.includes(s)) return 120;
  return 140;
}

async function saveSampleOrder(data, source){
  const paymentId = data.razorpay_payment_id;
  if (!paymentId) throw new Error("Missing razorpay_payment_id");
  await db.collection("sampleOrders").doc(paymentId).set({
    name:    data.name    || "",
    phone:   data.phone   || "",
    address: data.address || "",
    city:    data.city    || "",
    state:   data.state   || "",
    pincode: data.pincode || "",
    charge:  sampleCharge(data.state),
    razorpay_order_id:   data.razorpay_order_id || "",
    razorpay_payment_id: paymentId,
    status:   "paid",
    savedVia: source,
    createdAt: new Date().toISOString()
  }, { merge: true });
  console.log(`✅ Sample order saved via [${source}] — ${paymentId}`);
}

app.post("/create-sample-order", async (req, res) => {
  try {
    const b = req.body;
    if (!b.state) return res.status(400).json({ error: "state required" });
    const charge = sampleCharge(b.state);
    const order = await razorpay.orders.create({
      amount: charge * 100,
      currency: "INR",
      receipt: "sample_" + Date.now(),
      notes: {
        type: "sample",
        name: b.name || "", phone: b.phone || "", address: b.address || "",
        city: b.city || "", state: b.state || "", pincode: b.pincode || ""
      }
    });
    res.json({ id: order.id, amount: order.amount, charge });
  } catch (err) {
    console.error("❌ create-sample-order error:", err);
    res.status(500).json({ error: "failed" });
  }
});

app.post("/save-sample-order", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const expected = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest("hex");
    if (expected !== razorpay_signature)
      return res.status(400).json({ status: "failed" });

    await saveSampleOrder(req.body, "client");
    res.json({ status: "success" });
  } catch (err) {
    console.error("❌ save-sample-order error:", err);
    res.status(500).json({ status: "error" });
  }
});

app.get("/sample-orders", async (req, res) => {
  try {
    if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY)
      return res.status(401).json({ error: "wrong key" });
    const snap = await db.collection("sampleOrders").orderBy("createdAt", "desc").get();
    res.json(snap.docs.map(d => d.data()));
  } catch (err) {
    console.error("❌ sample-orders error:", err);
    res.status(500).json({ error: "failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));