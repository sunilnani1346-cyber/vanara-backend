require("dotenv").config();

const express = require("express");
const Razorpay = require("razorpay");
const cors = require("cors");
const crypto = require("crypto");
const admin = require("firebase-admin");

if (!process.env.FIREBASE_KEY) {
  throw new Error("❌ FIREBASE_KEY is not set in environment variables!");
}

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

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

// CREATE ORDER — qty తీసుకుని amount calculate చేస్తుంది
app.post("/create-order", async (req, res) => {
  try {
    const qty = Math.min(parseInt(req.body.qty) || 1, 20);
    const amount = qty * PRICE_PER_UNIT;

    const order = await razorpay.orders.create({
      amount: amount * 100, // paise
      currency: "INR",
      receipt: "order_" + Date.now()
    });

    res.json(order);
  } catch (err) {
    console.error("create-order error:", err);
    res.status(500).json({ error: "Order creation failed" });
  }
});

// VERIFY PAYMENT (separate endpoint)
app.post("/verify-payment", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ status: "failed", error: "Invalid signature" });
    }

    res.json({ status: "success" });
  } catch (err) {
    console.error("verify-payment error:", err);
    res.status(500).json({ status: "failed", error: "Verification error" });
  }
});

// SAVE ORDER — Firebase lo save cheyyi
app.post("/save-order", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    // Double check signature
    const body = razorpay_order_id + "|" + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest("hex");

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ error: "Invalid payment" });
    }

    await db.collection("orders").add({
      name:               req.body.name,
      phone:              req.body.phone,
      address:            req.body.address,
      city:               req.body.city,
      state:              req.body.state,
      country:            req.body.country,
      pincode:            req.body.pincode,
      qty:                req.body.qty,
      amount:             req.body.amount,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      status:    "Order Confirmed",  // admin panel match avutundi
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ status: "success" });
  } catch (err) {
    console.error("save-order error:", err);
    res.status(500).json({ error: "Save failed" });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));