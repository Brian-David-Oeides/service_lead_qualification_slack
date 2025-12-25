// src/server.js
require("dotenv").config();

const express = require("express");
const { WebClient } = require("@slack/web-api");
const { Client } = require("@notionhq/client");

const notion = new Client({
  auth: process.env.NOTION_TOKEN
});

const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_DATABASE_ID) {
  console.error("Missing NOTION_DATABASE_ID in .env");
  process.exit(1);
}

const app = express();
app.use(express.json()); // for JSON bodies

// DEBUG: confirm we are pointing at the intended Notion database
app.get("/debug-notion-db", async (req, res) => {
  try {
    const dbId = process.env.NOTION_DATABASE_ID;

    const db = await notion.databases.retrieve({ database_id: dbId });

    const title =
      Array.isArray(db?.title) && db.title[0]?.plain_text
        ? db.title[0].plain_text
        : "(no title returned)";

    const props = db?.properties;
    const keys = props ? Object.keys(props) : [];

    res.json({
      ok: true,
      database_id: db?.id,
      title,
      url: db?.url,
      object: db?.object,
      hasProperties: !!props,
      propertyCount: keys.length,
      propertyKeys: keys
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || String(err),
      code: err?.code,
      status: err?.status
    });
  }
});


const path = require("path");
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

const fs = require("fs");
const nodemailer = require("nodemailer");

const slackToken = process.env.SLACK_BOT_TOKEN;
const slackChannelId = process.env.SLACK_CHANNEL_ID;

if (!slackToken || !slackChannelId) {
  console.error("Missing SLACK_BOT_TOKEN or SLACK_CHANNEL_ID in .env");
  process.exit(1);
}

const slack = new WebClient(slackToken);

const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpFrom = process.env.SMTP_FROM;

if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
  console.error("Missing SMTP_* vars in .env");
  process.exit(1);
}

const mailer = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: smtpPort === 465, // true only for 465
  auth: {
    user: smtpUser,
    pass: smtpPass
  }
});

function isLikelyEmail(value = "") {
  const v = String(value).trim();
  return v.includes("@") && v.includes(".") && v.length >= 6;
}

async function sendHighLeadAutoResponse(toEmail) {
  const subject = "Thanks — we received your inquiry";
  const text =
`Hi,

Thanks for reaching out. We’ve received your message and will review it shortly.

If everything looks aligned, someone from our team will follow up within one business day.

Best regards,`;

  return mailer.sendMail({
    from: smtpFrom,
    to: toEmail,
    subject,
    text
  });
}

// Health check
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

// Sends a test message to Slack
app.get("/test-slack", async (req, res) => {
  try {
    const result = await slack.chat.postMessage({
      channel: slackChannelId,
      text: "✅ LeadQualifierBot is connected. Test message successful."
    });

    res.json({ ok: true, ts: result.ts });
  } catch (err) {
    console.error("Slack postMessage error:", err);
    res.status(500).json({ ok: false, error: err?.data || err?.message || "Unknown error" });
  }
});

function classifyLead(messageRaw = "") {
  const message = String(messageRaw).toLowerCase();

  const highSignals = [
    { key: "asap", points: 3, reason: "Urgent timeline" },
    { key: "next month", points: 3, reason: "Near-term intent" },
    { key: "starting", points: 2, reason: "Start date mentioned" },
    { key: "within", points: 2, reason: "Defined timeline window" },
    { key: "by", points: 1, reason: "Deadline mentioned" },

    { key: "premium", points: 2, reason: "Premium service language" },
    { key: "proposal", points: 2, reason: "Requesting a proposal" },
    { key: "quote", points: 2, reason: "Requesting a quote" },
    { key: "budget", points: 2, reason: "Budget mentioned" },
    { key: "scope", points: 2, reason: "Scope mentioned" },
    { key: "requirements", points: 2, reason: "Requirements mentioned" },
    { key: "deliverables", points: 2, reason: "Deliverables mentioned" },
    { key: "contract", points: 2, reason: "Contract language" },
    { key: "retainer", points: 2, reason: "Retainer language" },

    { key: "call", points: 1, reason: "Wants to discuss next steps" },
    { key: "meeting", points: 1, reason: "Wants to discuss next steps" }
  ];

  const lowSignals = [
    { key: "just curious", points: 4, reason: "Low intent language" },
    { key: "maybe later", points: 3, reason: "Uncertain timeline" },
    { key: "not sure", points: 3, reason: "Uncertain intent" },
    { key: "whenever", points: 2, reason: "No urgency" },
    { key: "someday", points: 2, reason: "No timeline" },

    { key: "someone nice", points: 2, reason: "Vague request language" },
    { key: "anything", points: 2, reason: "Vague request language" },

    { key: "free", points: 4, reason: "Low budget / free request" },
    { key: "cheap", points: 3, reason: "Low investment signal" },
    { key: "urgent help pls", points: 3, reason: "Low-signal / spammy phrasing" }
  ];

  const matchedHigh = highSignals.filter(s => message.includes(s.key));
  const matchedLow = lowSignals.filter(s => message.includes(s.key));

  const highScore = matchedHigh.reduce((sum, s) => sum + s.points, 0);
  const lowScore = matchedLow.reduce((sum, s) => sum + s.points, 0);

  const intentSignals = [
    "asap", "next month", "starting", "within", "by",
    "proposal", "quote", "budget", "scope", "requirements", "deliverables",
    "contract", "retainer", "call", "meeting"
  ];

  const hasIntentSignal = intentSignals.some(k => message.includes(k));

  const hardNegatives = ["hookups", "free dating app"];
  const hasHardNegative = hardNegatives.some(k => message.includes(k));

  const netScore = highScore - lowScore;

  const label =
    !hasHardNegative && hasIntentSignal && netScore >= 3
      ? "HIGH"
      : "LOW";

  return {
    label,
    scores: { highScore, lowScore, netScore },
    reasons: {
      high: matchedHigh.map(s => `${s.reason} (+${s.points})`),
      low: matchedLow.map(s => `${s.reason} (-${s.points})`)
    }
  };
}

function safeId() {
  return "lead_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

function appendLeadToDisk(leadObj) {
  const dir = path.join(__dirname, "..", "data");
  const file = path.join(dir, "leads.jsonl");

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.appendFileSync(file, JSON.stringify(leadObj) + "\n", "utf8");
}

async function createNotionLeadPage({
  lead_id,
  created_at,
  label,
  scores,
  email,
  phone,
  whatsapp,
  message
}) {
  if (!process.env.NOTION_TOKEN || !process.env.NOTION_DATABASE_ID) {
    return { ok: false, skipped: true };
  }

  const dbId = process.env.NOTION_DATABASE_ID;

    // Build Notion properties (names must match your database columns EXACTLY)
  const properties = {
    "Name": { title: [{ text: { content: `Lead ${lead_id}` } }] },

    "Lead ID": { rich_text: [{ text: { content: lead_id } }] },
    "Label": { select: { name: label } },
    "Created At": { date: { start: created_at } },

    "Message": { rich_text: [{ text: { content: message } }] },

    "Score (net)": { number: scores?.netScore ?? 0 },
    "Score (High)": { number: scores?.highScore ?? 0 },
    "Score (Low)": { number: scores?.lowScore ?? 0 }
  };

  // Optional contact fields (only include if present)
  if (email) properties["Email"] = { email };
  if (phone) properties["Phone"] = { phone_number: phone };

  // WhatsApp is Text in Notion (recommended)
  if (whatsapp) properties["WhatsApp"] = {
    rich_text: [{ text: { content: whatsapp } }]
  };

  const page = await notion.pages.create({
    parent: { database_id: dbId },
    properties
  });

  return { ok: true, page_id: page.id };
}

// Receive lead submissions
app.post("/lead", async (req, res) => {
  const { email, phone, whatsapp, message, company_website } = req.body;

  // Honeypot: if filled, treat as bot and silently accept (no Slack/email/Notion)
  if (String(company_website || "").trim().length > 0) {
    return res.json({ ok: true, ignored: true });
  }

  const cleanMessage = String(message || "").trim();
  const cleanEmail = String(email || "").trim();
  const cleanPhone = String(phone || "").trim();
  const cleanWhatsapp = String(whatsapp || "").trim();

  if (!cleanMessage) {
    return res.status(400).json({ ok: false, error: "Message is required." });
  }

  if (!cleanEmail && !cleanPhone && !cleanWhatsapp) {
    return res
      .status(400)
      .json({ ok: false, error: "Provide at least one contact method: Email, Phone, or WhatsApp." });
  }

  const { label, reasons, scores } = classifyLead(cleanMessage);

  let emailStatus = "not_sent";
  let emailError = null;

  if (label === "HIGH" && isLikelyEmail(cleanEmail)) {
    try {
      await sendHighLeadAutoResponse(cleanEmail);
      emailStatus = "sent";
    } catch (err) {
      emailStatus = "failed";
      emailError = err?.message || "unknown email error";
    }
  }

  const summary = cleanMessage.slice(0, 140) + (cleanMessage.length > 140 ? "…" : "");

    // === SAVE LEAD TO DISK (baseline storage) ===
  const lead_id = safeId();
  const created_at = new Date().toISOString();

  appendLeadToDisk({
    lead_id,
    created_at,
    label,
    scores,
    reasons,
    email: cleanEmail || null,
    phone: cleanPhone || null,
    whatsapp: cleanWhatsapp || null,
    company_website: null,
    message: cleanMessage
  });

  // === NOTION (HIGH ONLY) ===
  let notionStatus = "skipped";
  let notionPageId = null;

  if (label === "HIGH") {
    try {
      const notionResp = await createNotionLeadPage({
        lead_id,
        created_at,
        label,
        scores,
        email: cleanEmail || null,
        phone: cleanPhone || null,
        whatsapp: cleanWhatsapp || null,
        message: cleanMessage
      });

      if (notionResp?.ok) {
        notionStatus = "ok";
        notionPageId = notionResp.page_id || null;
      } else if (notionResp?.skipped) {
        notionStatus = "skipped";
      } else {
        notionStatus = "failed";
      }
    } catch (err) {
      notionStatus = "failed";
      console.error("Notion write error:", err?.message || err);
    }
  }

  try {
    await slack.chat.postMessage({
      channel: slackChannelId,
      text:
        `${label === "HIGH" ? "🟢" : "🔴"} *LEAD: ${label}*\n` +
        `*Score:* ${scores.netScore} (high ${scores.highScore} / low ${scores.lowScore})\n` +
        `*Auto-response:* ${emailStatus}${emailError ? ` (${emailError})` : ""}\n` +
        `*Notion:* ${notionStatus}${notionPageId ? ` (${notionPageId})` : ""}\n` +
        `*Reasons:* ${(label === "HIGH" ? reasons.high : reasons.low).join(", ") || "No keyword match"}\n` +
        `*Email:* ${cleanEmail || "N/A"}\n` +
        `*Phone:* ${cleanPhone || "N/A"}\n` +
        `*WhatsApp:* ${cleanWhatsapp || "N/A"}\n` +
        `*Summary:* ${summary}\n\n` +
        `*Full message:*\n${cleanMessage}`
    });

    return res.json({ ok: true, label, lead_id, notionStatus, notionPageId });
  } catch (err) {
    console.error("Slack postMessage error:", err);
    return res.status(500).json({ ok: false, error: err?.data || err?.message || "Unknown error" });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
