/**
 * BACKEND SERVER (Node.js + Express)
 * 
 * ---------------------------------------------------------
 * COMMAND TO START SERVER:
 * cd backend
 * npm install
 * npm start
 * ---------------------------------------------------------
 */

require('dotenv').config(); // Load environment variables
const express = require('express');
const cors = require('cors');
const Razorpay = require('razorpay');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');

// --- YOUR LIVE CONFIGURATION ---
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_live_Rro6u2W3PK2IXg';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'd4RvGmN7biALUbJ7Pxoe6xMC';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'trydo_wts_2025';

// EMAIL CONFIGURATION
// You MUST generate an App Password: https://myaccount.google.com/apppasswords
// Do NOT use your regular Gmail login password.
const EMAIL_USER = process.env.EMAIL_USER || 'grow@trydoschool.com'; 
const EMAIL_PASS = process.env.EMAIL_PASS || 'YOUR_GMAIL_APP_PASSWORD'; // <--- REPLACE THIS BEFORE RUNNING

const PRICE_INR = 499;

const app = express();
// Enable CORS for all origins to prevent 'Failed to fetch' due to security blocking
app.use(cors({ origin: true }));
app.use(express.json());

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});

// --- DATABASE (File Based) ---
const DB_FILE = path.join(__dirname, 'database.json');
if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ payments: [], licenses: [], demoUsage: {} }, null, 2));
}

function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch (e) { return { payments: [], licenses: [], demoUsage: {} }; }
}
function writeDB(data) { fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2)); }

// --- HELPERS ---
function generateLicenseKey() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; 
  const segment = () => Array(5).fill(0).map(() => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
  return `WTS-${segment()}-${segment()}-${segment()}-${segment()}`;
}

async function sendLicenseEmail(email, licenseKey, paymentId) {
  if (EMAIL_PASS === 'YOUR_GMAIL_APP_PASSWORD') {
    console.error("!!! EMAIL NOT SENT: Password not configured in backend/server.js !!!");
    return false;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS }
  });

  const mailOptions = {
    from: `"WTS By Trydo" <${EMAIL_USER}>`,
    to: email,
    subject: 'Your What The Speech License Key',
    html: `
      <div style="font-family: sans-serif; padding: 20px; color: #333;">
        <h2>Thank you for your purchase!</h2>
        <p>Your license key for What The Speech is below:</p>
        <div style="background: #f4f4f4; padding: 15px; margin: 20px 0; border-radius: 5px;">
          <code style="font-size: 20px; font-weight: bold; letter-spacing: 2px;">${licenseKey}</code>
        </div>
        <p>To activate, open the app, go to Settings, and enter this key.</p>
        <p>Payment ID: ${paymentId}</p>
        <p>- WTS By Trydo Team</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`[EMAIL] Sent to ${email}`);
    return true;
  } catch (error) {
    console.error('[EMAIL ERROR]', error);
    return false;
  }
}

// --- ENDPOINTS ---

// 1. STATUS CHECK
app.get('/api/status', (req, res) => {
  res.json({ status: 'running', mode: 'LIVE', price: PRICE_INR });
});

// 2. CREATE ORDER
app.post('/api/payment/create-order', async (req, res) => {
  console.log("[API] Create Order Request Received");
  try {
    const options = {
      amount: PRICE_INR * 100, 
      currency: 'INR',
      receipt: `rcpt_${Date.now()}`,
      payment_capture: 1 
    };
    const order = await razorpay.orders.create(options);
    console.log(`[RAZORPAY] Order Created: ${order.id}`);
    res.json(order);
  } catch (error) {
    console.error('[RAZORPAY ERROR]', error);
    res.status(500).json({ error: error.message });
  }
});

// 3. WEBHOOK
app.post('/api/payment/webhook', async (req, res) => {
  const secret = WEBHOOK_SECRET;
  const shasum = crypto.createHmac('sha256', secret);
  shasum.update(JSON.stringify(req.body));
  const digest = shasum.digest('hex');

  if (digest !== req.headers['x-razorpay-signature']) {
    console.error('[WEBHOOK] Invalid Signature');
    return res.status(400).json({ status: 'failure' });
  }

  const event = req.body.event;
  console.log(`[WEBHOOK] Event: ${event}`);

  if (event === 'payment.captured') {
    const { id, email, amount, status } = req.body.payload.payment.entity;
    const licenseKey = generateLicenseKey();
    
    // Save to DB
    const db = readDB();
    if (!db.payments.find(p => p.payment_id === id)) {
      db.payments.push({ id, email, amount, status, date: new Date() });
      db.licenses.push({ key: licenseKey, email, payment_id: id, activated: false });
      writeDB(db);
      
      if (email) await sendLicenseEmail(email, licenseKey, id);
    }
  }
  res.json({ status: 'ok' });
});

// DEMO Endpoints
app.post('/api/check-demo', (req, res) => {
  const { fingerprint } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const db = readDB();
  if (db.demoUsage[ip] || db.demoUsage[fingerprint]) return res.status(403).json({ allowed: false });
  return res.json({ allowed: true });
});

app.post('/api/record-demo', (req, res) => {
  const { fingerprint } = req.body;
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const db = readDB();
  db.demoUsage[ip] = Date.now();
  db.demoUsage[fingerprint] = Date.now();
  writeDB(db);
  res.json({ success: true });
});

// Start Server on 0.0.0.0 to ensure external access in containers
const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Backend running on port ${PORT}`);
  console.log(`Testing URL: http://localhost:${PORT}/api/status`);
});
