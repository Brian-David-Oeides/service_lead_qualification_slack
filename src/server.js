// src/server.js
require("dotenv").config();

const express = require("express");
const { WebClient } = require("@slack/web-api");

const app = express();
app.use(express.json()); // for JSON bodies

const path = require("path");
app.use(express.static(path.join(__dirname, "..", "public")));

const PORT = process.env.PORT || 3000;

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

  // Weighted signals (points reflect importance)
  const highSignals = [
    // Timeline / urgency (strong intent)
    { key: "asap", points: 3, reason: "Urgent timeline" },
    { key: "next month", points: 3, reason: "Near-term intent" },
    { key: "starting", points: 2, reason: "Start date mentioned" },
    { key: "within", points: 2, reason: "Defined timeline window" },
    { key: "by", points: 1, reason: "Deadline mentioned" },

    // Serious service language
    { key: "premium", points: 2, reason: "Premium service language" },
    { key: "proposal", points: 2, reason: "Requesting a proposal" },
    { key: "quote", points: 2, reason: "Requesting a quote" },
    { key: "budget", points: 2, reason: "Budget mentioned" },
    { key: "scope", points: 2, reason: "Scope mentioned" },
    { key: "requirements", points: 2, reason: "Requirements mentioned" },
    { key: "deliverables", points: 2, reason: "Deliverables mentioned" },
    { key: "contract", points: 2, reason: "Contract language" },
    { key: "retainer", points: 2, reason: "Retainer language" },

    // Proof they’re a real buyer
    { key: "call", points: 1, reason: "Wants to discuss next steps" },
    { key: "meeting", points: 1, reason: "Wants to discuss next steps" }
  ];


  const lowSignals = [
    // Low intent / browsing
    { key: "just curious", points: 4, reason: "Low intent language" },
    { key: "maybe later", points: 3, reason: "Uncertain timeline" },
    { key: "not sure", points: 3, reason: "Uncertain intent" },
    { key: "whenever", points: 2, reason: "No urgency" },
    { key: "someday", points: 2, reason: "No timeline" },

    // Vague request
    { key: "someone nice", points: 2, reason: "Vague request language" },
    { key: "anything", points: 2, reason: "Vague request language" },

    // Misaligned expectations
    { key: "free", points: 4, reason: "Low budget / free request" },
    { key: "cheap", points: 3, reason: "Low investment signal" },
    { key: "urgent help pls", points: 3, reason: "Low-signal / spammy phrasing" }
  ];


  const matchedHigh = highSignals.filter(s => message.includes(s.key));
  const matchedLow = lowSignals.filter(s => message.includes(s.key));

  const highScore = matchedHigh.reduce((sum, s) => sum + s.points, 0);
  const lowScore = matchedLow.reduce((sum, s) => sum + s.points, 0);

  // Guardrail: must have at least one "intent" signal to be HIGH
  const intentSignals = [
    "asap", "next month", "starting", "within", "by",
    "proposal", "quote", "budget", "scope", "requirements", "deliverables",
    "contract", "retainer", "call", "meeting"
  ];

  const hasIntentSignal = intentSignals.some(k => message.includes(k));

  // Decision:
  // HIGH if (highScore - lowScore) >= 3 AND hasIntentSignal AND no hard-negative
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


// Receive lead submissions
app.post("/lead", async (req, res) => {
  const { email, phone, whatsapp, message } = req.body;

  const { label, reasons, scores } = classifyLead(message);

  let emailStatus = "not_sent";
  let emailError = null;

  if (label === "HIGH" && isLikelyEmail(email)) {
    try {
      await sendHighLeadAutoResponse(email);
      emailStatus = "sent";
    } catch (err) {
      emailStatus = "failed";
      emailError = err?.message || "unknown email error";
    }
  }


  // Very simple short summary: first 140 chars
  const summary = (message || "").trim().slice(0, 140) + ((message || "").length > 140 ? "…" : "");

  try {
    await slack.chat.postMessage({
      channel: slackChannelId,
      text: `${label === "HIGH" ? "🟢" : "🔴"} *LEAD: ${label}*\n` +
      `*Score:* ${scores.netScore} (high ${scores.highScore} / low ${scores.lowScore})\n` + `*Auto-response:* ${emailStatus}${emailError ? ` (${emailError})` : ""}\n` +
      `*Reasons:* ${(label === "HIGH" ? reasons.high : reasons.low).join(", ") || "No keyword match"}\n` +
      `*Email:* ${email || "N/A"}\n` +
      `*Phone:* ${phone || "N/A"}\n` +
      `*WhatsApp:* ${whatsapp || "N/A"}\n` +
      `*Summary:* ${summary}\n\n` +
      `*Full message:*\n${message || "N/A"}`
    });

    res.json({ ok: true, label });
  } catch (err) {
    console.error("Slack postMessage error:", err);
    res.status(500).json({ ok: false, error: err?.data || err?.message || "Unknown error" });
  }
});


app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
