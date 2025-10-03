const { MongoClient } = require("mongodb");
const express = require("express");
const cors = require("cors");
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const mm = require('music-metadata');
require('dotenv').config();

const uri = process.env.MONGODB_URI || "";
const port = process.env.PORT || 5000;

const app = express();
app.use(cors());
app.use(express.json());

// storage for uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, unique + '-' + file.originalname);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
  fileFilter: function (req, file, cb) {
    // accept only audio mime types
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only audio files are allowed'));
  }
});

// nodemailer test account (ethereal) — for real env replace with SMTP credentials
let mailTransporter;
(async () => {
  try {
    const testAccount = await nodemailer.createTestAccount();
    mailTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    console.log('Nodemailer configured with ethereal test account');
  } catch (err) {
    console.error('Failed to create mail transporter', err);
  }
})();

let client = null;
let postcollection = null;
let usercollection = null;
let _inMemory = {
  posts: [],
  users: [],
};

// simple in-memory stores for OTPs and forgot-password rate limit
const otpStore = {}; // { email: { code, expiresAt } }
const forgotPasswordRequests = {}; // { email: timestampOfLastRequest }

if (uri) {
  client = new MongoClient(uri);
}

async function run() {
  try {
    if (client) {
      await client.connect();
      postcollection = client.db("database").collection("posts");
      usercollection = client.db("database").collection("users");
      console.log('Connected to MongoDB');
    } else {
      console.warn('No MONGODB_URI provided. Using in-memory storage for users and posts.');
    }

    // register
    app.post("/register", async (req, res) => {
      const user = req.body;
      if (usercollection) {
        const result = await usercollection.insertOne(user);
        return res.send(result);
      }
      user._id = Date.now().toString();
      _inMemory.users.push(user);
      return res.send({ acknowledged: true, insertedId: user._id });
    });

    // login helper endpoints remain as before
    app.get("/loggedinuser", async (req, res) => {
      const email = req.query.email;
      if (usercollection) {
        const user = await usercollection.find({ email: email }).toArray();
        return res.send(user);
      }
      const user = _inMemory.users.filter((u) => u.email === email);
      return res.send(user);
    });

    // text post
    app.post("/post", async (req, res) => {
      const post = req.body;
      if (postcollection) {
        const result = await postcollection.insertOne(post);
        return res.send(result);
      }
      post._id = Date.now().toString();
      _inMemory.posts.push(post);
      return res.send({ acknowledged: true, insertedId: post._id });
    });

    // get posts
    app.get("/post", async (req, res) => {
      if (postcollection) {
        const post = (await postcollection.find().toArray()).reverse();
        return res.send(post);
      }
      return res.send([..._inMemory.posts].reverse());
    });

    app.get("/userpost", async (req, res) => {
      const email = req.query.email;
      if (postcollection) {
        const post = (await postcollection.find({ email: email }).toArray()).reverse();
        return res.send(post);
      }
      const post = _inMemory.posts.filter((p) => p.email === email).reverse();
      return res.send(post);
    });

    app.get("/user", async (req, res) => {
      if (usercollection) {
        const user = await usercollection.find().toArray();
        return res.send(user);
      }
      return res.send(_inMemory.users);
    });

    app.patch("/userupdate/:email", async (req, res) => {
      const email = req.params.email;
      const profile = req.body;
      const options = { upsert: true };
      const updateDoc = { $set: profile };
      if (usercollection) {
        const filter = { email: email };
        const result = await usercollection.updateOne(filter, updateDoc, options);
        return res.send(result);
      }
      // in-memory update
      let updated = false;
      _inMemory.users = _inMemory.users.map((u) => {
        if (u.email === email) {
          updated = true;
          return { ...u, ...profile };
        }
        return u;
      });
      if (!updated && options.upsert) {
        const newUser = { email, ...profile, _id: Date.now().toString() };
        _inMemory.users.push(newUser);
        return res.send({ acknowledged: true, upsertedId: newUser._id });
      }
      return res.send({ acknowledged: true, modifiedCount: updated ? 1 : 0 });
    });

    // OTP endpoints: requestOTP and verifyOTP
    app.post('/request-otp', async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).send({ error: 'email required' });
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes
      otpStore[email] = { code, expiresAt };
      // send email via nodemailer (ethereal)
      if (mailTransporter) {
        const info = await mailTransporter.sendMail({
          from: 'no-reply@twiller.test',
          to: email,
          subject: 'Your OTP for Twiller',
          text: `Your OTP is ${code}. It expires in 5 minutes.`
        });
        console.log('OTP sent preview URL:', nodemailer.getTestMessageUrl(info));
      }
      return res.send({ acknowledged: true, expiresAt });
    });

    app.post('/verify-otp', (req, res) => {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).send({ error: 'email and code required' });
      const entry = otpStore[email];
      if (!entry) return res.status(400).send({ error: 'no otp requested' });
      if (Date.now() > entry.expiresAt) return res.status(400).send({ error: 'otp expired' });
      if (entry.code !== code) return res.status(400).send({ error: 'invalid otp' });
      delete otpStore[email];
      return res.send({ acknowledged: true });
    });

    // audio upload endpoint with constraints
    // - only 2pm to 7pm IST allowed (IST = UTC+5:30)
    // - max 100MB enforced by multer fileSize
    // - duration <= 5 minutes enforced by music-metadata
    app.post('/upload-audio', upload.single('audio'), async (req, res) => {
      try {
        const { email, otp } = req.body;
        if (!email || !otp) return res.status(400).send({ error: 'email and otp required' });
        // verify otp
        const entry = otpStore[email];
        if (!entry || entry.code !== otp || Date.now() > entry.expiresAt) return res.status(403).send({ error: 'invalid or expired otp' });

        // time window check: IST 14:00 - 19:00
        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000; // ms
        const istOffset = 5.5 * 60 * 60 * 1000;
        const ist = new Date(utc + istOffset);
        const hour = ist.getHours();
        const minutes = ist.getMinutes();
        const totalMinutes = hour * 60 + minutes;
        const start = 14 * 60; // 14:00
        const end = 19 * 60; // 19:00
        if (totalMinutes < start || totalMinutes >= end) {
          // delete uploaded file if any
          if (req.file && req.file.path) fs.unlinkSync(req.file.path);
          return res.status(403).send({ error: 'audio uploads allowed only between 14:00 and 19:00 IST' });
        }

        if (!req.file) return res.status(400).send({ error: 'no audio file uploaded' });

        // check duration
        const metadata = await mm.parseFile(req.file.path);
        const durationSec = metadata.format.duration || 0;
        if (durationSec > 5 * 60) {
          fs.unlinkSync(req.file.path);
          return res.status(400).send({ error: 'audio longer than 5 minutes not allowed' });
        }

        // pass: save post entry
        const post = { type: 'audio', email, file: path.basename(req.file.path), duration: durationSec, createdAt: new Date() };
        if (postcollection) {
          await postcollection.insertOne(post);
        } else {
          post._id = Date.now().toString();
          _inMemory.posts.push(post);
        }

        return res.send({ acknowledged: true, post });
      } catch (err) {
        console.error(err);
        if (req.file && req.file.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        return res.status(500).send({ error: err.message });
      }
    });

    // forgot-password: rate limit 1 request/day and password generator
    app.post('/forgot-password', async (req, res) => {
      const { email } = req.body;
      if (!email) return res.status(400).send({ error: 'email required' });
      const last = forgotPasswordRequests[email];
      const now = Date.now();
      if (last && (now - last) < 24 * 60 * 60 * 1000) {
        return res.status(429).send({ error: 'You can request forgot password only once per day' });
      }
      forgotPasswordRequests[email] = now;

      // generate password: combination of small and upper case letters only (no digits/special)
      function generatePassword(len = 12) {
        const lowers = 'abcdefghijklmnopqrstuvwxyz';
        const uppers = lowers.toUpperCase();
        let pwd = '';
        // ensure mix
        for (let i = 0; i < len; i++) {
          const pool = (i % 2 === 0) ? lowers : uppers;
          pwd += pool[Math.floor(Math.random() * pool.length)];
        }
        return pwd;
      }

      const newPassword = generatePassword(12);

      // send email with newPassword
      if (mailTransporter) {
        const info = await mailTransporter.sendMail({
          from: 'no-reply@twiller.test',
          to: email,
          subject: 'Password reset for Twiller',
          text: `Your temporary password is: ${newPassword}`
        });
        console.log('Forgot-password email preview URL:', nodemailer.getTestMessageUrl(info));
      }

      // In a real app, you'd hash and write newPassword to DB and force user to change on next login.
      return res.send({ acknowledged: true, note: 'Password reset email sent (ethereal)' });
    });

    // mock subscription/payment endpoint
    // enforce payment only between 10:00-11:00 IST
    app.post('/subscribe', async (req, res) => {
      const { email, plan } = req.body; // plan: free/bronze/silver/gold
      if (!email || !plan) return res.status(400).send({ error: 'email and plan required' });

      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const istOffset = 5.5 * 60 * 60 * 1000;
      const ist = new Date(utc + istOffset);
      const hour = ist.getHours();
      const minute = ist.getMinutes();
      const totalMinutes = hour * 60 + minute;
      const start = 10 * 60;
      const end = 11 * 60;
      if (totalMinutes < start || totalMinutes >= end) return res.status(403).send({ error: 'Payments allowed only between 10:00 and 11:00 IST' });

      // mock invoice email
      const invoice = { email, plan, amount: plan === 'free' ? 0 : plan === 'bronze' ? 100 : plan === 'silver' ? 300 : 1000, date: new Date() };
      if (mailTransporter) {
        const info = await mailTransporter.sendMail({
          from: 'billing@twiller.test',
          to: email,
          subject: 'Your Twiller subscription',
          text: `Thank you for subscribing. Invoice: ${JSON.stringify(invoice)}`
        });
        console.log('Subscription invoice preview URL:', nodemailer.getTestMessageUrl(info));
      }

      // in a real app, you'd call a payment gateway, verify webhook, and persist subscription in DB
      return res.send({ acknowledged: true, invoice });
    });

  } catch (error) {
    console.error(error);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Twiller is working");
});

app.listen(port, () => {
  console.log(`Twiller clone is working on ${port}`);
});
