# AI Model Pricing Data

Up-to-date pricing data for major AI model providers, scraped daily from official sources.

## Data Sources

| Provider | Source | Method |
|----------|--------|--------|
| OpenAI | developers.openai.com | Regex + LLM fallback |
| Anthropic | docs.anthropic.com | Regex + LLM fallback |
| Google | ai.google.dev | Markdown regex |
| xAI | docs.x.ai | Next.js RSC JSON |
| DeepSeek | api-docs.deepseek.com | HTML table regex |
| OpenRouter | openrouter.ai/api | REST API |

## Usage

### Raw URL (recommended)

```
https://raw.githubusercontent.com/blocklet/model-pricing-data/main/data/pricing.json
```

### Available Files

| File | Format | Description |
|------|--------|-------------|
| `data/pricing.json` | Provider-grouped | Full pricing data with caching, tiers, batch pricing |
| `data/pricing-litellm.json` | LiteLLM-compatible | Key-value format compatible with LiteLLM ecosystem |
| `data/providers/{name}.json` | Per-provider | Individual provider data files |

### Data Format

`pricing.json` uses a provider-grouped structure:

```json
{
  "_meta": {
    "generatedAt": "2026-03-18T10:00:00Z",
    "version": "2.0.0",
    "totalModels": 369,
    "sources": { "..." : "..." },
    "failedProviders": []
  },
  "providers": {
    "openai": {
      "gpt-4.1": {
        "modelType": "chatCompletion",
        "pricingUnit": "per-token",
        "inputCostPerToken": 2e-6,
        "outputCostPerToken": 8e-6,
        "caching": { "write": 1e-6, "read": 5e-7 },
        "sourceUrl": "..."
      }
    }
  }
}
```

All token prices are in **$/token** (not $/MTok).

### Caching Keys

| Key | Description |
|-----|-------------|
| `write-5min` | Anthropic 5-minute prompt caching write |
| `write-1h` | Anthropic 1-hour prompt caching write |
| `write` | General cache write (Google, OpenAI) |
| `read` | Cache read / cached input |

## Local Development

```bash
npm install
npx tsx scripts/index.ts              # Full scrape
npx tsx scripts/index.ts --dry-run    # Scrape without writing
npx tsx scripts/scrape-openai.ts --json  # Single provider
```

## CI/CD

Runs daily via GitHub Actions at UTC 02:00. Changes are auto-committed.

Required secrets: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`

## License

MIT
