import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getAiPlanStream, getNavigationDecision } from './aiService';

// Load environment variables from .env file
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors()); // Allows your Chrome extension to make requests to this server
app.use(express.json({ limit: '10mb' })); // Allows parsing of incoming JSON payloads

// Health check route
app.get('/', (req, res) => {
  res.send('AI Agent Backend is running!');
});

app.post('/api/navcheck', async (req, res) => {
  const { prompt, pageContext, history } = req.body;
  try {
    const result = await getNavigationDecision(prompt, pageContext, history || []);
    res.json(result);
  } catch (error: any) {
    console.error("Navigation decision failed:", error.message);
    // Safe fallback: treat as correct domain, proceed to full scan
    res.json({ goalMet: false, correctDomain: true, suggestedUrl: null });
  }
});

app.post('/api/plan/stream', async (req, res) => {
  const { prompt, domHtml, history, pageContext, persona, vaultFile } = req.body;

  if (!prompt || !domHtml) {
    res.status(400).json({ error: "Missing 'prompt' or 'domHtml' in request body." });
    return;
  }

  // Set headers for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const abortController = new AbortController();

  res.on('close', () => {
    console.log("Client disconnected, aborting OpenAI request...");
    abortController.abort();
  });

  try {
    await getAiPlanStream(prompt, domHtml, history || [], pageContext, persona, vaultFile, res, abortController.signal);
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log('Stream aborted successfully.');
      if (!res.writableEnded) res.end();
    } else {
      console.error("Error streaming AI plan:", error.message);
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "error", data: error.message })}\n\n`);
        res.end();
      }
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`🚀 Server is running on http://localhost:${port}`);
});