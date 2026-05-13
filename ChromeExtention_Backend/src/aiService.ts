import { DOMElement, ActionPlan } from './types';

interface PageContext {
  url: string;
  title: string;
}

export async function getAiPlan(
  userPrompt: string,
  domHtml: string,
  history: string[],
  pageContext?: PageContext,
  persona?: string,
  vaultFile?: string
): Promise<ActionPlan> {

  let systemPrompt = `You are a strict, methodical browser automation agent.
Your job is to complete the user's goal by taking deliberate, non-repetitive steps.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
GOAL DETECTION (check this FIRST every step)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You will receive the CURRENT PAGE URL and TITLE.
Before planning any action, ask: "Does this page already satisfy the user's goal?"
If the goal is met, return taskCompleted: true and an EMPTY actions array immediately.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ANTI-LOOP & FORM RULES (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. READ THE HISTORY: If your history says you clicked a link and the URL changed, YOU ARE ON A NEW PAGE. Stop and assess if the goal is met. Do not keep clicking links blindly.
2. CHECK 'currentValue': When filling forms, look at the 'currentValue' of elements. If an input already contains the correct information, DO NOT type into it again. Skip it.
3. DROPDOWNS: If an element is a <select>, it will have an 'options' property (e.g. "Male | Female"). To select one, use the 'type' action and provide the exact option text as the 'value'.
4. CHAIN ACTIONS: If you must fill 5 inputs, return all 5 'type' actions in ONE step.
5. HTML CONTEXT (CRITICAL): You are provided with a simplified HTML tree of the page. Use the surrounding HTML tags (like <span>, <div>, <label>, <p>) to understand what an input field is for. Look at the text immediately preceding or wrapping the input with the data-agent-id attribute.
6. FORM FIELD MAPPING (CRITICAL): When filling forms using a persona, CAREFULLY map the persona data to the correct input field by looking at the HTML structure around it. Do not fill fields sequentially or randomly. If a field expects an Age, give the age. If it asks for Birth Year, give birth year.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STATE MACHINE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
A: User wants to search → type query + click search (same step).
B: User wants to "find a video" or "watch a video" → Searching is only step 1. You must actually CLICK a video result to play it. The task is only complete when the video is playing.
C: History shows URL changed after clicking a video → check if current page title matches the video. If yes, taskCompleted: true.
D: Filling a form → type into all empty required fields. Ignore fields where 'currentValue' is already correct.`;

  if (persona) {
    systemPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nPERSONA ENGINE\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nYou are acting on behalf of the following user. If you need to fill out a form, USE EXACTLY THIS DATA. Do not invent random names or emails.\n\nUser Persona:\n${persona}`;
  }

  if (vaultFile) {
    systemPrompt += `\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nFILE VAULT\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nYou have access to the user's file: [${vaultFile}]. If you encounter a file upload input (type="file"), you can upload it by using the 'upload' action and setting 'value' to the exact filename.`;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OpenAI API Key is missing in backend.");

  const historyString = history.length > 0
    ? `PAST ACTIONS & RESULTS:\n${history.map((h) => `  - ${h}`).join('\n')}`
    : "Step 1 — no prior actions.";

  const pageString = pageContext
    ? `CURRENT PAGE\n  Title: ${pageContext.title}\n  URL:   ${pageContext.url}`
    : "CURRENT PAGE: unknown";

  const userMessage =
    `USER GOAL: ${userPrompt}\n\n` +
    `${pageString}\n\n` +
    `${historyString}\n\n` +
    `SIMPLIFIED HTML DOM:\n${domHtml}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userMessage  }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "action_plan",
          schema: {
            type: "object",
            properties: {
              thought: { type: "string" },
              taskCompleted: { type: "boolean" },
              actions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    actionType: { type: "string", enum: ["click", "type", "upload"] },
                    targetId:   { type: "string" },
                    value:      { type: ["string", "null"] }
                  },
                  required: ["actionType", "targetId", "value"],
                  additionalProperties: false
                }
              }
            },
            required: ["thought", "taskCompleted", "actions"],
            additionalProperties: false
          },
          strict: true
        }
      }
    })
  });

  const data = await response.json() as any;
  if (data.error) throw new Error(data.error.message);
  if (!data.choices || !data.choices[0]?.message?.content) {
    throw new Error("Invalid response from OpenAI API");
  }
  return JSON.parse(data.choices[0].message.content);
}