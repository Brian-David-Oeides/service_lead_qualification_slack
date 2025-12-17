# Service Business Lead Intake + Qualification → Slack Alerts (Rule-Based)


A lightweight Node.js webhook service that receives website leads, classifies them as HIGH or LOW intent using explainable rule-based scoring, and posts a formatted alert to Slack.  
This system is domain-agnostic and can be adapted for agencies, consulting, legal intake, real estate, or any service business.


## Why this exists
Small service agencies often get flooded with unqualified inquiries. This tool reduces manual review by:
- tagging leads as HIGH/LOW
- showing *why* the label was assigned (reasons + score)
- routing alerts directly to a Slack channel

## How it works
**Flow:**
1. Website form submits to `POST /lead`
2. Server computes `HIGH` or `LOW` using keyword scoring + guardrails
3. Slack message is posted to the configured channel with:
   - label
   - score breakdown
   - reasons
   - contact fields
   - summary + full message

## Proof (Screenshots)

### Slack alert — HIGH intent
![Slack HIGH](screenshots/slack-high.png)

### Slack alert — LOW intent
![Slack LOW](screenshots/slack-low.png)

### Server running locally
![Server Running](screenshots/server-running.png)

## Customization (Per Industry / Business)
> Note: The example message below is industry-neutral. Classification rules are configurable per business or domain.

## Example payload
```json
{
  "email": "test@example.com",
  "phone": "+66812345678",
  "whatsapp": "+66812345678",
  "message": "I’m looking for a premium service. Starting January, I need a verified, high-quality offering with clear scope and requirements."
}
