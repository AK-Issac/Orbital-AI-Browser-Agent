import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { getAiPlan } from './aiService';

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

// The main endpoint for your Chrome extension
app.post('/api/plan', async (req, res) => {
  try {
    const { prompt, domHtml, history, pageContext, persona, vaultFile } = req.body;

    if (!prompt || !domHtml) {
      return res.status(400).json({ error: "Missing 'prompt' or 'domHtml' in request body." });
    }

    // Call the AI service, passing the history (or an empty array if none is provided)
    const plan = await getAiPlan(prompt, domHtml, history || [], pageContext, persona, vaultFile);
    
    // Send the plan back to the Chrome extension
    res.json({ status: "success", plan });

  } catch (error: any) {
    console.error("Error getting AI plan:", error.message);
    res.status(500).json({ status: "error", message: error.message });
  }
});

import { getAiPlanStream } from './aiService';

app.post('/api/plan/stream', async (req, res) => {
  const { prompt, domHtml, history, pageContext, persona, vaultFile } = req.body;

  if (!prompt || !domHtml) {
    res.status(400).json({ error: "Missing 'prompt' or 'domHtml' in request body." });
    return;
  }

  // Set headers for JSONL
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const abortController = new AbortController();

  req.on('close', () => {
    console.log("Client disconnected, aborting OpenAI request...");
    abortController.abort();
  });

  try {
    await getAiPlanStream(prompt, domHtml, history || [], pageContext, persona, vaultFile, res, abortController.signal);
  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.log('Stream aborted successfully.');
    } else {
      console.error("Error streaming AI plan:", error.message);
      res.write(`event: error\ndata: ${JSON.stringify(error.message)}\n\n`);
      res.end();
    }
  }
});

// Start the server
app.listen(port, () => {
  console.log(`🚀 Server is running on http://localhost:${port}`);
});