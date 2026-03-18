#!/usr/bin/env npx tsx
/**
 * Test pure LLM extraction — send pricing page text directly to LLM
 * Usage: npx tsx scripts/test-llm-extract.ts [provider]
 */

import { httpFetch, postJson } from './lib/http.js';
import { stripHtml } from './lib/pricing-core.js';

const PAGES: Record<string, string> = {
  anthropic: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing?latest-pricing=standard',
  google: 'https://ai.google.dev/gemini-api/docs/pricing',
  deepseek: 'https://api-docs.deepseek.com/quick_start/pricing',
};

interface AnthropicResponse {
  content?: Array<{ text?: string }>;
}

const SYSTEM_PROMPT = `You are a pricing data extractor. Given the text content of an AI provider's pricing page, extract ALL models and their pricing information.

Output ONLY valid JSON with this structure:
{
  "provider": "anthropic",
  "models": [
    {
      "modelId": "claude-opus-4-6",
      "displayName": "Claude Opus 4.6",
      "modelType": "chatCompletion",
      "inputPerMTok": 5.00,
      "outputPerMTok": 25.00,
      "cacheWrite5minPerMTok": 6.25,
      "cacheWrite1hPerMTok": 10.00,
      "cacheReadPerMTok": 0.50,
      "batchInputPerMTok": 2.50,
      "batchOutputPerMTok": 12.50
    }
  ]
}

Rules:
- Extract EVERY model found on the page with pricing info
- All token prices in $/MTok (millions of tokens)
- For image models, use "costPerImage" ($ per image)
- For video models, use "costPerSecond" ($ per second)
- For audio models, use "costPerMinute" if applicable
- Include cache pricing tiers if available (write-5min, write-1h, read)
- Include batch pricing if available
- Include context tier pricing if available (e.g. >200K tokens)
- Set null for any field not explicitly stated on the page
- Do NOT hallucinate or guess prices — only extract what is explicitly written
- modelId should be lowercase with hyphens (e.g. "claude-opus-4-6", "gpt-4.1")`;

async function main() {
  const provider = process.argv[2] || 'anthropic';
  const url = PAGES[provider];
  if (!url) {
    console.error(`Unknown provider: ${provider}. Available: ${Object.keys(PAGES).join(', ')}`);
    process.exit(1);
  }

  // 1. Fetch page
  console.error(`Fetching ${provider} pricing: ${url}`);
  const html = await httpFetch(url);
  console.error(`Raw HTML: ${html.length} chars`);

  // 2. Clean HTML → plain text
  const clean = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#?\w+;/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  console.error(`Clean text: ${clean.length} chars`);

  // 3. Truncate if too long
  const maxChars = 40000;
  const content = clean.length > maxChars ? clean.slice(0, maxChars) : clean;
  if (clean.length > maxChars) {
    console.error(`Truncated to ${maxChars} chars (from ${clean.length})`);
  }

  // 4. Choose API: prefer OpenAI (more reliable for JSON), fallback to Anthropic-compat
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
  const anthropicBaseUrl = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
  const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  if (!hasOpenAI && !hasAnthropic) {
    console.error('Error: Set OPENAI_API_KEY or ANTHROPIC_API_KEY');
    process.exit(1);
  }

  let text: string;
  const startTime = Date.now();

  if (hasOpenAI) {
    const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
    const baseUrl = (process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '');
    console.error(`Calling ${model} via ${baseUrl}...`);

    interface OpenAiResp { choices?: Array<{ message?: { content?: string } }> }
    const resp = await postJson<OpenAiResp>(
      `${baseUrl}/v1/chat/completions`,
      {
        model,
        temperature: 0,
        max_tokens: 8192,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
      },
      { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      { timeoutMs: 180000 },
    );
    text = resp.choices?.[0]?.message?.content || '';
  } else {
    console.error(`Calling ${anthropicModel} via ${anthropicBaseUrl}...`);
    const resp = await postJson<AnthropicResponse>(
      `${anthropicBaseUrl}/v1/messages`,
      {
        model: anthropicModel,
        max_tokens: 8192,
        thinking: { type: 'disabled' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content }],
      },
      {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
      },
      { timeoutMs: 180000 },
    );
    const rawText = resp.content?.[0]?.text || '';
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    text = jsonMatch ? jsonMatch[0] : rawText;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`LLM response: ${text.length} chars in ${elapsed}s`);

  // 5. Parse JSON from response
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[0]);
      const count = data.models?.length ?? Object.keys(data).length;
      console.error(`Extracted: ${count} models\n`);
      console.log(JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('JSON parse failed, raw output:');
      console.log(text);
    }
  } else {
    console.error('No JSON found in response:');
    console.log(text);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
