---
description: How to train and serve the AI chatbot for the StartUP Weekend portal
---

# Training & Serving the StartUP Weekend AI Mentor

This skill documents how the AI chatbot for the StartUP Weekend 2025 portal is configured, "trained" (via prompt engineering), and served to teams.

---

## Architecture Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────┐
│   Browser/Team  │────▶│  Express Server   │────▶│  OpenAI API │
│   (index.html)  │◀────│  (server.js)      │◀────│  (GPT-5.2)  │
└─────────────────┘     └──────────────────┘     └─────────────┘
                              │
                         .env (API key)
```

- **Frontend** (`public/index.html`) — static HTML served by Express
- **Backend** (`server.js`) — proxies requests to OpenAI, hides the API key
- **Knowledge** — embedded in the system prompt (not fine-tuned)

---

## How the AI is "Trained"

We use **system prompt engineering**, not fine-tuning. This is the recommended approach for custom knowledge chatbots because:

| Method | Best For | Our Use Case |
|---|---|---|
| **System Prompt** (✅ what we use) | Injecting factual knowledge, event details, rules | ✅ Perfect — we have specific criteria, schedule, event context |
| **Fine-tuning** | Changing model *style/tone*, not adding facts | ❌ Overkill — we don't need a custom tone |
| **Assistants API** | Document search over many files | ❌ Being deprecated (Aug 2026), over-engineered for 4 docs |
| **RAG** | Large/changing knowledge bases | ❌ Our knowledge is small and static |

### The System Prompt

The system prompt in `server.js` contains:

1. **Role definition** — radically honest startup mentor (YC/Techstars style)
2. **Judges Criteria** — all 3 categories with every sub-question and scoring philosophy
3. **Event Schedule** — full 3-day timeline with locations
4. **Event Context** — AUBG, StartUP@Blagoevgrad, English-language event
5. **Team context** — dynamically injected team name + idea
6. **Behavioral instructions** — be brutally honest, demand evidence, use markdown
7. **Tool usage instructions** — when to call each of the 5 analysis tools

### Tool Functions (5 enabled)

The server defines 5 OpenAI function tools that provide structured analysis:

| Tool | Triggers When | Output |
|---|---|---|
| `evaluate_startup_idea` | Team shares idea or asks for evaluation | Scored breakdown (1-10) per criterion with judge questions |
| `analyze_competitive_landscape` | Team asks about competitors | Direct/indirect competitors, moat analysis, market size |
| `build_pitch_structure` | Team needs pitch help | Minute-by-minute 7-min pitch outline with Q&A prep |
| `customer_interview_guide` | Team needs interview help | Mom Test-based guide with segments, questions, red flags |
| `revenue_model_analysis` | Team asks about money/pricing | Revenue models, unit economics, path to 100 customers |

### Updating Knowledge

To update the AI's knowledge (e.g., schedule change, new rules):

1. Open `server.js`
2. Find the `SYSTEM_PROMPT` constant
3. Edit the relevant section
4. Restart the server (`npm start`)

No retraining, no API calls, no waiting — changes take effect immediately.

---

## Serving

### Prerequisites
- Node.js 18+
- An OpenAI API key with GPT-5.2 access

### Setup

```bash
# 1. Navigate to the project
cd startup-portal

# 2. Install dependencies
npm install

# 3. Configure the API key
# Edit .env and replace sk-your-api-key-here with your real key
nano .env

# 4. Start the server
npm start
```

The server will start at `http://localhost:3000`.

### Environment Variables (.env)

| Variable | Description | Default |
|---|---|---|
| `OPENAI_API_KEY` | Your OpenAI API key | `sk-your-api-key-here` |
| `OPENAI_MODEL` | Model to use | `gpt-5.2` |
| `PORT` | Server port | `3000` |

### Available Models

| Model | Speed | Quality | Cost | Best For |
|---|---|---|---|---|
| `gpt-5.2` | Medium | Excellent | $$$ | Default — best quality, tool use |
| `gpt-5` | Medium | Excellent | $$ | Previous gen, still strong |
| `gpt-4.1` | Medium | Good | $$ | Older but still in API |
| `gpt-4.1-mini` | Fast | Good | $ | Budget-conscious / high traffic |

### API Compatibility Notes (GPT-5.x)

| Parameter | Old (GPT-4o) | New (GPT-5.x) |
|---|---|---|
| Token limit | `max_tokens` | `max_completion_tokens` |
| Instructions role | `system` | `developer` |
| Tool results | Same | Same (`tool` role) |

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `GET /api/health` | GET | Server health check, shows model and API key status |
| `POST /api/chat` | POST | Send text messages, returns AI response |
| `POST /api/chat/image` | POST | Upload an image (presentation slide) for AI evaluation |

### Production Deployment

For the actual event, you can deploy via:

// turbo
```bash
# Option A: Run on a VPS/VM
ssh user@server
git clone <repo>
cd startup-portal
npm install
echo "OPENAI_API_KEY=sk-real-key" > .env
PORT=80 node server.js

# Option B: Render/Railway/Fly.io
# Push to GitHub, connect to Render, set env vars in dashboard

# Option C: Docker
docker build -t startup-mentor .
docker run -p 3000:3000 -e OPENAI_API_KEY=sk-... startup-mentor
```

---

## Cost Estimation

For 14 teams over a weekend:

| Item | Estimate |
|---|---|
| Messages per team | ~50-100 |
| Avg tokens per exchange | ~1,500 (prompt+completion) |
| Total tokens | ~1.5M - 3M |
| GPT-4o cost | ~$5-15 total |
| GPT-4o-mini cost | ~$0.50-1.50 total |

This is very affordable. Image evaluation uses more tokens but teams will likely upload 5-10 slides each max.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Server not running" on landing page | Run `npm start` in the `startup-portal` directory |
| "API key missing" | Edit `.env` and add your real OpenAI key |
| Slow responses | Switch to `gpt-4o-mini` in `.env` |
| Image upload fails | Make sure file is an image (PNG/JPG), max 20MB |
| Chat errors after many messages | Conversation history may be too long; refresh the page to reset |
