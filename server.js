/**
 * WTS Backend Server (Final Version)
 * ----------------------------------
 * Supports:
 * - Admin login
 * - User login (email + password)
 * - Razorpay payment → user + license auto-creation
 * - License activation
 * - Demo system (1-hour limit)
 * - Admin dashboard endpoints
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const Razorpay = require("razorpay");
const fs = require("fs");
const path = require("path");

// ----------------------
// ENV CONFIG
// ----------------------
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "veer@trydo.com";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "supersecret";

const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "rzp_live_Rro6u2W3PK2IXg";
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "d4RvGmN7biALUbJ7Pxoe6xMC";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "trydo_wts_2025";

const PRICE_INR = 499;

// ----------------------
// APP INIT
// ----------------------
const app = express();
app.use(cors());
app.use(express.json());

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// ----------------------
// DATABASE
// ----------------------
const DB_FILE = path.join(__dirname, "database.json");

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE));
  } catch {
    return { users: [], payments: [], licenses: [], demoUsage: {} };
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// ----------------------
// HELPERS
// ----------------------
function generatePassword() {
  return Math.random().toString(36).substring(2, 10);
}

function generateLicenseKey() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const seg = () => Array(5).fill(0).map(() => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `WTS-${seg()}-${seg()}-${seg()}-${seg()}`;
}

// ----------------------
// STATUS CHECK
// ----------------------
app.get("/api/status", (req, res) => {
  res.json({ status: "running", mode: "LIVE", price: PRICE_INR });
});

// ----------------------
// ADMIN LOGIN
// ----------------------
app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body;

  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    return res.json({ success: true });
  }

  return res.status(401).json({ success: false, message: "Invalid admin credentials" });
});

// ----------------------
// ADMIN DASHBOARD ENDPOINTS
// ----------------------
app.get("/api/admin/users", (req, res) => {
  res.json(readDB().users);
});

app.get("/api/admin/payments", (req, res) => {
  res.json(readDB().payments);
});

app.get("/api/admin/licenses", (req, res) => {
  res.json(readDB().licenses);
});

app.get("/api/admin/demo-usage", (req, res) => {
  res.json(readDB().demoUsage);
});

// ----------------------
// USER LOGIN (email + password)
// ----------------------
app.post("/api/user/login", (req, res) => {
  const { email, password } = req.body;
  const db = readDB();

  const user = db.users.find((u) => u.email === email && u.password === password);
  if (!user) return res.status(401).json({ success: false, message: "Invalid credentials" });

  return res.json({
    success: true,
    user: {
      email: user.email,
      licenseKey: user.licenseKey || null,
      activated: user.activated || false,
    },
  });
});

// ----------------------
// LICENSE ACTIVATION
// ----------------------
app.post("/api/user/activate-license", (req, res) => {
  const { email, licenseKey } = req.body;
  const db = readDB();

  const lic = db.licenses.find((l) => l.key === licenseKey);
  if (!lic) return res.status(400).json({ success: false, message: "Invalid license key" });

  lic.activated = true;

  // link to user
  let user = db.users.find((u) => u.email === email);
  if (!user) {
    user = { email, password: null };
    db.users.push(user);
  }
  user.licenseKey = licenseKey;
  user.activated = true;
  user.activationDate = new Date();

  writeDB(db);

  return res.json({ success: true, message: "License activated" });
});

// ----------------------
// DEMO SYSTEM
// ----------------------
app.post("/api/demo/check", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const db = readDB();

  if (db.demoUsage[ip]) {
    const elapsed = Date.now() - db.demoUsage[ip];
    if (elapsed < 60 * 60 * 1000) {
      return res.json({ allowed: false, remaining: 60 * 60 * 1000 - elapsed });
    }
  }

  return res.json({ allowed: true });
});

app.post("/api/demo/start", (req, res) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  const db = readDB();

  db.demoUsage[ip] = Date.now();
  writeDB(db);

  res.json({ success: true });
});

// ----------------------
// ADMIN RESET DEMO (for you)
// ----------------------
app.post("/api/admin/reset-demo", (req, res) => {
  const ip = req.body.ip;
  const db = readDB();

  delete db.demoUsage[ip];
  writeDB(db);

  res.json({ success: true });
});

// ----------------------
// RAZORPAY ORDER
// ----------------------
app.post("/api/payment/create-order", async (req, res) => {
  try {
    const order = await razorpay.orders.create({
      amount: PRICE_INR * 100,
      currency: "INR",
      receipt: `rcpt_${Date.now()}`,
      payment_capture: 1,
    });

    res.json(order);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ----------------------
// RAZORPAY WEBHOOK
// ----------------------
app.post("/api/payment/webhook", (req, res) => {
  const signature = req.headers["x-razorpay-signature"];

  const shasum = crypto.createHmac("sha256", WEBHOOK_SECRET);
  shasum.update(JSON.stringify(req.body));
  const digest = shasum.digest("hex");

  if (digest !== signature) {
    return res.status(400).json({ status: "failure" });
  }

  const event = req.body.event;

  if (event === "payment.captured") {
    const payment = req.body.payload.payment.entity;
    const email = payment.email;

    const db = readDB();

    const password = generatePassword();
    const licenseKey = generateLicenseKey();

    // Save payment
    db.payments.push({
      id: payment.id,
      email,
      amount: payment.amount,
      status: payment.status,
      date: new Date(),
    });

    // Save license
    db.licenses.push({
      key: licenseKey,
      email,
      payment_id: payment.id,
      activated: false,
    });

    // Save user
    db.users.push({
      email,
      password,
      licenseKey,
      activated: false,
    });

    writeDB(db);
  }

  return res.json({ status: "ok" });
});
// ---------------------------------------------
// ADMIN LOGIN ENDPOINT
// ---------------------------------------------
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;

  const db = readDB();
  const admin = db.users.find(
    (u) => u.email === email && u.role === "admin"
  );

  if (!admin) {
    return res.status(404).json({ success: false, message: "Admin not found" });
  }

  if (admin.password !== password) {
    return res.status(401).json({ success: false, message: "Invalid password" });
  }

  return res.json({ success: true, message: "Admin login successful" });
});


// ----------------------
// START SERVER
// ----------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`WTS Backend Live on Port: ${PORT}`);
});
