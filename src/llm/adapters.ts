// LLM Adapter Layer for Multiple AI Providers
export type Provider = 'openai' | 'xai' | 'anthropic' | 'google' | 'glm' | 'deepseek' | 'kimi';

export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }
export interface ToolDef {
  name: string;
  description?: string;
  parameters?: any;
}
export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  tools?: ToolDef[];
  toolChoice?: 'auto' | 'none' | { type: 'tool'; name: string };
  jsonSchemaName?: string;
  jsonSchema?: any;
  stream?: boolean;
  // GPT-5 new parameters
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'minimal';
  reasoning_summary?: 'auto' | 'concise' | 'detailed';
  verbosity?: 'low' | 'medium' | 'high';
  // Responses API parameters (GPT-5.5+)
  store?: boolean;          // Whether to store response on OpenAI side (default false for benchmarks)
  truncation?: 'auto' | 'disabled'; // How to handle context overflow
  max_tool_calls?: number;  // Cap on tool calls per response
  instructions?: string;    // Developer-level system message (Responses API native)
}
export interface ChatResponse {
  text: string;
  tokensIn?: number;
  tokensOut?: number;
  toolCalls?: Array<{ name: string; arguments: any }>;
  raw: any;
}

export interface LLMAdapter {
  listModels(): Promise<string[]>;
  chat(req: ChatRequest): Promise<ChatResponse>;
}

// ---------- GPT-5.5 Pinned Snapshot ----------
// Use the pinned snapshot for reproducible benchmark results.
// The floating alias 'gpt-5.5' can change behavior without notice.
export const GPT55_PINNED_SNAPSHOT = 'gpt-5.5-2026-04-23';

// Helper: check if model is GPT-5.5 (including pinned snapshots)
export function isGPT55Model(modelName: string): boolean {
  return /^gpt-5\.5(?:-|$)/.test(modelName);
}

// ---------- DeepSeek Model Detection ----------
// DeepSeek V4 models support dual modes (thinking/non-thinking).
// Legacy aliases deepseek-chat/deepseek-reasoner map to V4-Flash and will be
// deprecated by mid-2026. We support both legacy and new model names.

// Helper: check if DeepSeek model uses thinking (chain-of-thought) mode.
// In thinking mode: temperature/top_p have no effect, reasoning_content is returned.
export function isDeepSeekThinkingModel(modelName: string): boolean {
  return modelName === 'deepseek-reasoner' ||
         /^deepseek-v4/.test(modelName);  // V4 models default to thinking mode
}

// Helper: check if model is any DeepSeek model
export function isDeepSeekModel(modelName: string): boolean {
  return /^deepseek-/.test(modelName);
}

// ---------- Kimi (Moonshot AI) Model Detection ----------
// Kimi K2.5/K2.6 are reasoning models (supports_reasoning: true from API).
// Thinking mode (default): temperature MUST be 1.0, returns reasoning_content + content.
// Disabled mode: thinking: {type: 'disabled'}, temperature MUST be 0.6.
// We always use thinking mode for K2 reasoning models in benchmarks.

// Helper: check if Kimi model uses thinking (chain-of-thought) mode.
export function isKimiThinkingModel(modelName: string): boolean {
  // K2.5, K2.6 and K2.7(-code) all run in forced thinking mode and require a
  // fixed temperature of 1.0 (the API rejects other values). kimi-k2.7-code in
  // particular cannot disable thinking. Keep this in sync when new K2.x land.
  return /^kimi-k2\.[567]/.test(modelName);
}

// Helper: check if model is any Kimi model
export function isKimiModel(modelName: string): boolean {
  return /^kimi-/.test(modelName);
}

// ---------- OPENAI (Responses API) ----------
export class OpenAIAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.openai.com') {}
  async listModels() {
    try {
      const r = await fetch(`${this.base}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      const j: any = await r.json();
      return j.data
        .map((m: any) => m.id)
        .filter((id: string) =>
          /^(gpt-5|gpt-4o|o\d|o-mini|o-)/.test(id)
        );
    } catch {
      // Conservative fallback: only generally available models (May 2026)
      return ['gpt-4o', 'gpt-4o-mini', 'gpt-5.5', 'gpt-5.5-pro'];
    }
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Use Responses API for o-series reasoning models AND GPT-5 family
    // GPT-5 models are reasoning models and should use Responses API
    if (/^(gpt-5|o\d|o-mini|o[0-9]|o-)/.test(req.model)) {
      return this.chatResponsesAPI(req);
    }
    // Use Chat Completions for GPT-4 and other standard models
    return this.chatCompletionsAPI(req);
  }

  private async chatResponsesAPI(req: ChatRequest): Promise<ChatResponse> {
    const isReasoning = /^(gpt-5|o\d|o-mini|o-)/.test(req.model);
    const isGPT5 = /^gpt-5/.test(req.model);
    const isGPT55 = /^gpt-5\.5(?:-|$)/.test(req.model);

    // GPT-5 needs higher token limits because max_output_tokens includes reasoning tokens.
    // Each benchmark suite now sets its own appropriate budget; the adapter applies
    // a minimum floor to prevent accidental truncation of reasoning.
    let maxTokens = req.maxTokens ?? 1200;
    if (isGPT55) {
      // If the caller already set a high value (deep/tool benchmarks), respect it.
      // Otherwise apply a floor of 8000 (suitable for coding benchmarks where fairness
      // mode sends maxTokens=1500 — reasoning tokens need room to think).
      if (maxTokens < 8000) {
        maxTokens = 8000; // Minimum floor for GPT-5.5 (coding benchmarks)
      }
      // Cap at 128000 (GPT-5.5 max output limit)
      maxTokens = Math.min(maxTokens, 128000);
    } else if (isGPT5) {
      maxTokens = Math.max(8000, (req.maxTokens || 1200) * 3);
    }

    // Use instructions field for system messages (Responses API native) when available
    const systemMsg = req.instructions || req.messages.find(m => m.role === 'system')?.content;
    const nonSystemMessages = req.messages.filter(m => m.role !== 'system');

    const body: any = {
      model: req.model,
      // Proper content blocks for Responses API
      input: nonSystemMessages.map(m => ({
        role: m.role,
        content: [{
          type: m.role === 'assistant' ? "output_text" : "input_text",
          text: m.content
        }]
      })),
      max_output_tokens: maxTokens,
      // Benchmark safety: don't store responses on OpenAI servers
      store: req.store !== undefined ? req.store : false,
      // Fail loudly on context overflow instead of silent truncation
      truncation: req.truncation || 'disabled'
    };

    // Use instructions field for system-level prompt (Responses API best practice)
    if (systemMsg) {
      body.instructions = systemMsg;
    }

    // Cap tool calls per response to prevent runaway loops
    if (req.max_tool_calls) {
      body.max_tool_calls = req.max_tool_calls;
    }
    
    // Only non-reasoning models accept temperature
    if (!isReasoning && typeof req.temperature === 'number') {
      body.temperature = req.temperature;
    }
    // Reasoning models accept a reasoning config
    if (isReasoning) {
      const reasoningConfig: any = {};
      // GPT-5.5 defaults to medium; allow override
      if (req.reasoning_effort) {
        reasoningConfig.effort = req.reasoning_effort;
      } else if (isGPT55) {
        reasoningConfig.effort = 'medium'; // GPT-5.5 default per OpenAI docs
      }
      // GPT-5.5 supports reasoning summaries for observability
      if (req.reasoning_summary) {
        reasoningConfig.summary = req.reasoning_summary;
      } else if (isGPT55) {
        reasoningConfig.summary = 'auto'; // Enable reasoning summaries by default for GPT-5.5
      }
      if (Object.keys(reasoningConfig).length > 0) {
        body.reasoning = reasoningConfig;
      }
    }
    // GPT-5.5 supports text.verbosity for controlling output conciseness
    if (isGPT55) {
      body.text = {
        format: { type: 'text' },
        ...(req.verbosity ? { verbosity: req.verbosity } : { verbosity: 'medium' })
      };
    }
    if (req.tools?.length) {
      // Responses API uses flat structure with type at top level
      body.tools = req.tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description || '',
        parameters: t.parameters || { type: 'object', properties: {} }
      }));
      // Debug logging
      if (process.env.DEBUG_TOOLS) {
        console.log(`[OpenAI Responses API] Sending ${body.tools.length} tools:`,
          body.tools.map((t: any) => t.name).join(', '));
      }
    }
    if (req.toolChoice) {
      body.tool_choice = req.toolChoice === 'auto' ? 'auto' :
        (req.toolChoice === 'none' ? 'none' : {
          type: 'function',
          function: { name: req.toolChoice.name }
        });
    }
    if (req.jsonSchema) {
      // GPT-5.5 on Responses API uses text.format for structured outputs (not response_format)
      if (isGPT55) {
        body.text = {
          ...(body.text || {}),
          format: {
            type: 'json_schema',
            name: req.jsonSchemaName || 'Result',
            schema: req.jsonSchema,
            strict: true
          }
        };
      } else {
        body.response_format = {
          type: "json_schema",
          json_schema: {
            name: req.jsonSchemaName || 'Result',
            schema: req.jsonSchema
          }
        };
      }
    }

    if (process.env.DEBUG_TOOLS) {
      console.log('[OpenAI Responses API] Making request to:', `${this.base}/v1/responses`);
      console.log('[OpenAI Responses API] Request body keys:', Object.keys(body).join(', '));
    }

    const r = await fetch(`${this.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (process.env.DEBUG_TOOLS) {
      console.log('[OpenAI Responses API] Response status:', r.status, r.statusText);
    }

    if (!r.ok) {
      const errTxt = await r.text().catch(()=>'');
      if (process.env.DEBUG_TOOLS) {
        console.log('[OpenAI Responses API] Error response:', errTxt);
      }
      throw new Error(`OpenAI ${r.status} ${r.statusText}: ${errTxt}`);
    }

    const j: any = await r.json();

    // Debug: Log raw response
    if (process.env.DEBUG_TOOLS) {
      console.log('[OpenAI Responses API] Response status:', r.status);
      console.log('[OpenAI Responses API] Response keys:', Object.keys(j).join(', '));
      if (j.output) {
        console.log('[OpenAI Responses API] Output length:', j.output?.length);
        if (j.output[0]) {
          console.log('[OpenAI Responses API] Output[0] keys:', Object.keys(j.output[0]).join(', '));
          console.log('[OpenAI Responses API] Output[0].type:', j.output[0].type);
          console.log('[OpenAI Responses API] Output[0].name:', j.output[0].name);
          if (j.output[0].content) {
            console.log('[OpenAI Responses API] Output[0].content length:', j.output[0].content?.length);
            if (Array.isArray(j.output[0].content)) {
              console.log('[OpenAI Responses API] Content types:',
                j.output[0].content.map((c: any) => c.type).join(', '));
            }
          }
        }
      }
      if (j.choices) console.log('[OpenAI Responses API] Choices length:', j.choices?.length);
    }

    // --- Robust text aggregation across Responses API shapes ---
    function collectText(resp: any): string {
      const bucket: string[] = [];

      const pushContent = (arr: any[]) => {
        if (!Array.isArray(arr)) return;
        for (const c of arr) {
          if (typeof c?.text === 'string') bucket.push(c.text);
          // Some SDKs surface {type:'output_text', text:'...'} under different keys
          else if (typeof c?.output_text === 'string') bucket.push(c.output_text);
        }
      };

      // 1) Convenience field
      if (typeof resp?.output_text === 'string') bucket.push(resp.output_text);

      // 2) Primary output array
      if (Array.isArray(resp?.output)) {
        for (const o of resp.output) {
          pushContent(o?.content);
          // some SDKs mirror under message.content
          pushContent(o?.message?.content);
        }
      }

      // 3) Some responses nest under choices/message for compat
      const msg = resp?.choices?.[0]?.message;
      if (typeof msg?.content === 'string') bucket.push(msg.content);
      else pushContent(msg?.content);

      // 4) Fallback: resp.message?.content
      if (resp?.message?.content) {
        if (typeof resp.message.content === 'string') bucket.push(resp.message.content);
        else pushContent(resp.message.content);
      }

      // 5) Rare: resp.responses[*].output[0].content[*]
      if (Array.isArray(resp?.responses)) {
        for (const rr of resp.responses) {
          if (Array.isArray(rr?.output)) pushContent(rr.output?.[0]?.content);
          pushContent(rr?.content);
        }
      }

      return bucket.join('\n').trim();
    }

    const text = collectText(j);

    // Extract tool calls from Responses API
    const toolCalls: Array<{ name: string; arguments: any }> = [];
    
    // Debug logging
    if (process.env.DEBUG_TOOLS) {
      console.log('[OpenAI Responses API] Raw response structure:', {
        hasOutput: !!j?.output,
        hasChoices: !!j?.choices,
        hasMessage: !!j?.message,
        outputLength: Array.isArray(j?.output) ? j.output.length : 0,
        firstChoice: j?.choices?.[0] ? 'present' : 'absent'
      });
    }
    
    // Responses API returns tool calls directly in the output array
    // Each tool call has: { id, type, status, arguments, call_id, name }
    if (Array.isArray(j?.output)) {
      for (const item of j.output) {
        // Direct tool call format (Responses API uses 'function_call' type)
        if (item?.name && (item?.type === 'function_call' || item?.type === 'function')) {
          toolCalls.push({
            name: item.name,
            arguments: typeof item.arguments === 'string'
              ? JSON.parse(item.arguments)
              : item.arguments || {}
          });
        }
        // Nested content format
        else if (item?.content && Array.isArray(item.content)) {
          for (const contentItem of item.content) {
            if ((contentItem?.type === 'tool_use' || contentItem?.type === 'function') && contentItem?.name) {
              toolCalls.push({
                name: contentItem.name,
                arguments: contentItem.input || (typeof contentItem.arguments === 'string'
                  ? JSON.parse(contentItem.arguments)
                  : contentItem.arguments) || {}
              });
            }
          }
        }
      }
    }
    
    // Fallback: Check for tool_calls in Chat Completions format
    if (Array.isArray(j?.choices?.[0]?.message?.tool_calls)) {
      for (const tc of j.choices[0].message.tool_calls) {
        toolCalls.push({
          name: tc.function?.name,
          arguments: typeof tc.function?.arguments === 'string'
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {}
        });
      }
    }

    if (process.env.DEBUG_TOOLS) {
      console.log(`[OpenAI Responses API] Extracted ${toolCalls.length} tool calls:`,
        toolCalls.map(tc => tc.name).join(', '));
    }

    const usage = j?.usage ?? {};

    // --- Incomplete response detection (GPT-5.5 deep research fix) ---
    if (j?.incomplete_details || j?.status === 'incomplete') {
      const reason = j?.incomplete_details?.reason || 'unknown';
      const reasoningTokens = usage?.output_tokens_details?.reasoning_tokens ?? 0;
      console.warn(`⚠️ [GPT-5.5] Response incomplete! Reason: ${reason}`);
      console.warn(`   Model: ${req.model} | Status: ${j?.status}`);
      console.warn(`   Reasoning tokens used: ${reasoningTokens}`);
      console.warn(`   max_output_tokens was: ${maxTokens}`);
      if (reason === 'max_output_tokens') {
        console.warn(`   💡 Consider increasing max_output_tokens (currently ${maxTokens})`);
      }
    }

    return {
      text,
      tokensIn: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
      toolCalls,
      raw: {
        ...j,
        // Expose GPT-5.5 reasoning token telemetry for cost tracking and observability
        reasoningTokens: usage?.output_tokens_details?.reasoning_tokens ?? 0,
        cachedInputTokens: usage?.input_tokens_details?.cached_tokens ?? 0,
        // Expose response status and incomplete details for debugging truncated responses
        responseStatus: j?.status,
        incompleteDetails: j?.incomplete_details ?? null,
      }
    };
  }

  private async chatCompletionsAPI(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: req.model,
      messages: req.messages,
    };
    
    // GPT-5 models have specific parameter requirements
    if (/^gpt-5/.test(req.model)) {
      // GPT-5 uses reasoning tokens first, so we need a higher limit to allow for actual content
      body.max_completion_tokens = req.maxTokens ?? 2000;
      // GPT-5 only supports temperature=1 (default), so we omit it unless it's explicitly 1
      if (req.temperature === 1) {
        body.temperature = 1;
      }
    } else {
      body.max_tokens = req.maxTokens ?? 1200;
      body.temperature = req.temperature ?? 0.2;
    }
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      }));
    }
    if (req.toolChoice) body.tool_choice = req.toolChoice;
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.jsonSchemaName || 'Result',
          schema: req.jsonSchema
        }
      };
    }
    const r = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    
    if (!r.ok) {
      const errTxt = await r.text().catch(()=>'');
      throw new Error(`OpenAI ${r.status} ${r.statusText}: ${errTxt}`);
    }
    
    const j: any = await r.json();
    const msg = j.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls?.map((t: any) => ({
      name: t.function?.name,
      arguments: JSON.parse(t.function?.arguments || '{}')
    })) || [];
    
    const usage = j?.usage ?? {};
    return {
      text: msg?.content ?? '',
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      toolCalls,
      raw: j
    };
  }
}

// ---------- XAI (Grok) ----------
export class XAIAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.x.ai') {}

  async listModels() {
    try {
      const r = await fetch(`${this.base}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      return (j?.data ?? []).map((m: any) => m.id).filter((id: string) => /^grok(-|$)/.test(id));
    } catch {
      // May 2026: grok-4-0709, grok-code-fast-1, grok-2-latest all retired May 15 2026
      // grok-code-fast-1 redirects to grok-build-0.1 (NOT grok-4.3)
      return ['grok-4.3', 'grok-build-0.1'];
    }
  }

  private toBlocks(text: string) {
    return [{ type: 'text', text }];
  }

  private toOpenAIChat(msgs: ChatMessage[], systemMsg?: string) {
    const turns = msgs.filter(m => m.role !== 'system');
    const system = systemMsg ? [{ role: 'system' as const, content: this.toBlocks(systemMsg) }] : [];
    return [
      ...system,
      ...turns.map(m => ({ role: m.role as 'user' | 'assistant', content: this.toBlocks(m.content) }))
    ];
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const systemMsg = req.messages.find(m => m.role === 'system')?.content;

    const buildBody = (messages: any[]) => ({
      model: req.model,
      messages,
      temperature: typeof req.temperature === 'number' ? req.temperature : 0.2,
      max_tokens: req.maxTokens ?? 1500,  // Increased for deep benchmarks
      stream: false
    });

    const callOnce = async (body: any) => {
      const r = await fetch(`${this.base}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      });
      const rawText = await r.text().catch(()=>'');
      let j: any = {};
      try { j = rawText ? JSON.parse(rawText) : {}; } catch {}
      if (!r.ok) {
        const msg = (j?.error?.message || j?.message || rawText || `HTTP ${r.status}`).slice(0, 400);
        throw new Error(`XAI ${r.status}: ${msg}`);
      }

      const choice = Array.isArray(j?.choices) ? j.choices[0] : undefined;
      const message = choice?.message ?? {};
      const mc = message?.content;

      // extract text from string or block-array
      let content = '';
      if (typeof mc === 'string') content = mc;
      else if (Array.isArray(mc)) {
        content = mc.map((part: any) => {
          if (typeof part === 'string') return part;
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.content === 'string') return part.content;
          if (Array.isArray(part?.content)) return part.content.map((pp: any) => pp?.text ?? '').join('');
          return '';
        }).join('');
      } else if (message?.content?.[0]?.text) {
        content = String(message.content[0].text);
      }
      content = (content || '').trim();

      const usage = j?.usage || {};
      const tokensIn  = usage?.prompt_tokens     ?? usage?.input_tokens     ?? 0;
      const tokensOut = usage?.completion_tokens ?? usage?.output_tokens    ?? 0;

      const toolCalls = (message?.tool_calls ?? []).map((t: any) => {
        let args: any = {};
        if (typeof t?.function?.arguments === 'string') {
          try { args = JSON.parse(t.function.arguments); } catch {}
        }
        return { name: t?.function?.name, arguments: args };
      });

      return { content, tokensIn, tokensOut, toolCalls, j, rawText };
    };

    // Attempt A: strict OpenAI blocks + system role
    const bodyA = buildBody(this.toOpenAIChat(req.messages, systemMsg));
    try {
      const { content, tokensIn, tokensOut, toolCalls, j } = await callOnce(bodyA);
      if (content) return { text: content, tokensIn, tokensOut, toolCalls, raw: j };
    } catch (e) {
      // fall through
    }

    // Attempt B: no system role; prepend system as first user line
    if (systemMsg) {
      const merged = [
        { role: 'user' as const, content: this.toBlocks(`[SYSTEM]\n${systemMsg}`) },
        ...this.toOpenAIChat(req.messages.filter(m => m.role !== 'system'))
      ];
      try {
        const { content, tokensIn, tokensOut, toolCalls, j } = await callOnce(buildBody(merged));
        if (content) return { text: content, tokensIn, tokensOut, toolCalls, raw: j };
      } catch (e) {
        // fall through
      }
    }

    // Attempt C: single-turn fallback (concat tot contextul într-un singur mesaj)
    const oneTurn = (() => {
      const parts: string[] = [];
      if (systemMsg) parts.push(`[SYSTEM]\n${systemMsg}`);
      for (const m of req.messages.filter(m => m.role !== 'system')) {
        parts.push(`${m.role.toUpperCase()}: ${m.content}`);
      }
      return [{ role: 'user' as const, content: this.toBlocks(parts.join('\n\n')) }];
    })();

    try {
      const { content, tokensIn, tokensOut, toolCalls, j } = await callOnce(buildBody(oneTurn));
      if (content) return { text: content, tokensIn, tokensOut, toolCalls, raw: j };
    } catch {
      // fall through
    }

    // Attempt D: model auto-downgrade (e.g., grok-2-latest)
    try {
      const avail = await this.listModels();
      const alt = avail.find((id: string) => id !== req.model);
      if (alt) {
        const bodyAlt = { ...buildBody(this.toOpenAIChat(req.messages, systemMsg)), model: alt };
        const { content, tokensIn, tokensOut, toolCalls, j } = await callOnce(bodyAlt);
        if (content) return { text: content, tokensIn, tokensOut, toolCalls, raw: j };
      }
    } catch {
      // ignore
    }

    throw new Error('XAI adapter: Empty content');
  }
}

// ---------- ANTHROPIC (Claude) ----------
export class AnthropicAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.anthropic.com') {}
  async listModels() {
    try {
      const r = await fetch(`${this.base}/v1/models`, {
        headers: { 
          'x-api-key': this.apiKey, 
          'anthropic-version': '2023-06-01' 
        }
      });
      const j: any = await r.json();
      return (j?.data ?? [])
        .map((m: any) => m.id)
        // include 3.5, 3.7 sonnet + sonnet-4/opus/haiku/fable families
        .filter((id: string) =>
          /^claude-(3-5-sonnet|3-5-haiku|3-7-sonnet|sonnet-4|opus-4|haiku-4|fable)/.test(id)
        );
    } catch {
      // Fallback to known models (May 2026)
      // REMOVED: claude-sonnet-4-20250514, claude-opus-4-20250514 — retire June 15, 2026
      // KEPT: claude-opus-4-1-20250805 and claude-opus-4-5-20251101 — still live (verify deprecation dates)
      return [
        'claude-3-5-haiku',
        'claude-haiku-4-5',           // Current Haiku — fast & cheap
        'claude-sonnet-4-5',          // Dateless alias (replaces -20250929 dated ID)
        'claude-sonnet-4-5-20250929', // Pinned snapshot — still live
        'claude-sonnet-4-6',          // February 2026
        'claude-opus-4-5-20251101',   // November 2025 — verify deprecation date
        'claude-opus-4-6',            // February 2026
        'claude-opus-4-7',            // April 2026 reasoning model
        'claude-opus-4-8',            // May 2026 reasoning model (adaptive thinking, $5/$25 per MTok)
        'claude-fable-5'              // June 2026 Mythos-class reasoning model (always-on thinking, $10/$50 per MTok, refusal/fallback)
      ];
    }
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Split out system from turns and map content blocks correctly
    const systemMsg = req.messages.find(m => m.role === 'system')?.content;
    const turns = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: [{ type: 'text', text: m.content }]
      }));

    // Anthropic reasoning models:
    // - claude-opus-4-7+ reject temperature/top_p/top_k, support adaptive thinking + effort
    // - claude-fable-5: always-on adaptive thinking, cannot disable, Mythos-class model
    const isOpusReasoning = /^claude-opus-4-([7-9]|\d{2,})/.test(req.model);
    const isFable = /^claude-fable/.test(req.model);
    const isReasoningModel = isOpusReasoning || isFable;

    const body: any = {
      model: req.model,
      messages: turns
    };

    if (isReasoningModel) {
      // REASONING MODEL CONFIG (Opus 4.7/4.8 + Fable 5):
      // 1. Higher token limits — thinking tokens count toward max_tokens on Anthropic
      //    Fable 5 needs large budgets (128k max output); Opus 4.7/4.8 get scaled budget
      if (isFable) {
        // Fable 5: 128k max output, 1M context. Use caller budget if >= 64k, else default 64k.
        body.max_tokens = req.maxTokens && req.maxTokens >= 64000
          ? req.maxTokens
          : Math.max(64000, (req.maxTokens || 1200) * 5);
      } else {
        body.max_tokens = req.maxTokens && req.maxTokens >= 8000
          ? req.maxTokens
          : Math.max(16384, (req.maxTokens || 1200) * 4);
      }
      
      // 2. Adaptive thinking — the only thinking mode on Opus 4.7/4.8/Fable 5
      //    display: 'summarized' is required to receive thinking text (default is 'omitted')
      //    Fable 5: thinking CANNOT be disabled (returns 400). For cheap pings, use effort:'low'.
      if (isFable && (req as any).thinking_disabled) {
        // Fable cannot disable thinking — log a warning and force adaptive with low effort instead
        console.warn('[AnthropicAdapter] Fable 5 does not support thinking:disabled — using adaptive with low effort for canary-style request');
        body.thinking = { type: 'adaptive', display: 'summarized' };
        // Override effort to low for cheap canary pings
        body.output_config = { effort: 'low' };
      } else if ((req as any).thinking_disabled && !isFable) {
        // Opus 4.7/4.8: thinking can be disabled for canary pings
        body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'adaptive', display: 'summarized' };
      }
      
      // 3. Effort level — controls reasoning depth; allow caller to override via reasoning_effort
      //    Valid values: low, medium, high (default), xhigh, max (all supported on Fable 5 + Opus 4.7/4.8)
      if (!body.output_config) {
        const effort = req.reasoning_effort || 'high';
        body.output_config = { effort };
      }
      
      // 4. No temperature/top_p/top_k — these are rejected with 400 on reasoning models
      // (intentionally omitted)
    } else {
      // Standard model config
      body.max_tokens = req.maxTokens ?? 1200;
      body.temperature = req.temperature ?? 0.2;
    }

    if (systemMsg) body.system = systemMsg;
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters || { type: 'object', properties: {} }
      }));
    }

    const r = await fetch(`${this.base}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(()=>'');
      throw new Error(`Anthropic ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();

    // Extract thinking blocks (reasoning models return these with display:'summarized')
    // Must also preserve redacted_thinking blocks — they carry cryptographic signatures
    // that MUST be passed back unchanged in multi-turn tool conversations
    const thinkingTexts = (j?.content ?? [])
      .filter((c: any) => c.type === 'thinking' && typeof c.thinking === 'string')
      .map((c: any) => c.thinking);
    
    // Preserve all thinking + redacted_thinking blocks for multi-turn tool-use flows
    const thinkingBlocks = (j?.content ?? [])
      .filter((c: any) => c.type === 'thinking' || c.type === 'redacted_thinking');

    // Extract text content blocks
    const text =
      (j?.content ?? [])
        .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n') || '';

    // Extract tool calls
    const toolCalls =
      (j?.content ?? [])
        .filter((c: any) => c.type === 'tool_use')
        .map((c: any) => ({ name: c.name, arguments: c.input })) || [];

    return {
      text,
      tokensIn: j?.usage?.input_tokens ?? 0,
      tokensOut: j?.usage?.output_tokens ?? 0, // NOTE: output_tokens includes thinking tokens on Anthropic
      toolCalls,
      raw: {
        ...j,
        thinkingTexts,
        thinkingBlocks, // Preserved for multi-turn tool-use (must pass back unchanged)
        stopReason: j?.stop_reason, // 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'refusal'
        cacheCreationTokens: j?.usage?.cache_creation_input_tokens ?? 0,
        cacheReadTokens: j?.usage?.cache_read_input_tokens ?? 0
      }
    };
  }
}

// ---------- GOOGLE (Gemini) ----------
export class GoogleAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://generativelanguage.googleapis.com') {}
  async listModels() {
    try {
      const r = await fetch(`${this.base}/v1beta/models?key=${this.apiKey}`);
      const j: any = await r.json();
      // Filter to only Gemini chat LLM models (exclude embeddings, imagen, veo, gemma, etc.)
      const discovered = (j.models ?? [])
        .map((m: any) => String(m.name).replace('models/', ''))
        .filter((id: string) => /^gemini-/.test(id) &&
          !id.includes('embedding') && !id.includes('-tts') &&
          !id.includes('-live') && !id.includes('-image') &&
          !id.includes('native-audio') && !id.includes('robotics') &&
          !id.includes('computer-use'));
      return discovered;
    } catch {
      // Fallback to current recommended models (May 2026)
      // REMOVED: gemini-1.5-pro, gemini-1.5-flash — shut down June 1, 2026
      // ADDED: gemini-3.5-flash — GA May 19, 2026 (strongest agentic/coding model)
      return ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-flash-lite', 'gemini-2.5-flash'];
    }
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const modelPath = req.model.startsWith('models/') ? req.model : `models/${req.model}`;

    // Preserve conversation turns; map assistant→model
    const contents = req.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }]
      }));

    const systemMsg = req.messages.find(m => m.role === 'system')?.content;

    const body: any = {
      contents,
      generationConfig: {
        temperature: req.temperature ?? 0.2,
        maxOutputTokens: req.maxTokens ?? 1200,
        responseMimeType: "text/plain",
        candidateCount: 1  // Force single candidate, and keep it plain text
      },
      // Loosen default blocks so code isn't silently filtered
      safetySettings: [
        { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
        { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
      ]
    };

    // Give each request a harmless unique salt to avoid prompt dedupe (2.5+ and 3.x)
    let salt = '';
    if (req.model.includes('gemini-2.5') || req.model.includes('gemini-3')) {
      salt = `\n\n<!-- salt:${Math.random().toString(36).slice(2, 8)} -->`;
    }

    // Adjust thinking config per Gemini generation:
    // - Gemini 2.5: uses integer thinkingBudget (still supported)
    // - Gemini 3.x: Google switched to enum thinking_level (none/low/medium/high)
    //   3.5 Flash and 3.1 Pro are thinking models — configure appropriate level.
    //   3.1 Pro does NOT support "minimal" level.
    if (req.model.includes("gemini-3.5") || req.model.includes("gemini-3.1-pro")) {
      body.generationConfig.thinkingConfig = { thinkingLevel: 'medium' };
    } else if (req.model.includes("gemini-3.1-flash")) {
      body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };
    } else if (req.model.includes("gemini-2.5-pro")) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 128 };
    } else if (req.model.includes("gemini-2.5-flash")) {
      body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    // Handle system message if present
    if (systemMsg) {
      let finalSystemMsg = systemMsg + salt;
      body.systemInstruction = { role: 'system', parts: [{ text: finalSystemMsg }] };
    }

    if (req.tools?.length) {
      body.tools = [{
        functionDeclarations: req.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }))
      }];
    }

    const r = await fetch(`${this.base}/v1beta/${modelPath}:generateContent?key=${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(()=>'');
      throw new Error(`Gemini ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();

    const extract = (cand: any) =>
      (cand?.content?.parts ?? [])
        .map((p: any) => p?.text || p?.code || p?.executableCode?.code || '')
        .join('');
    let text = (j?.candidates?.length ? extract(j.candidates[0]) : '') || '';

    // === Smart retries for Gemini 2.5 that occasionally return EMPTY ===
    const trySmartRetry = async (phase: 1 | 2) => {
      const merged = [
        systemMsg ? `${systemMsg}${salt}\n` : '',
        ...req.messages.filter(m => m.role !== 'system').map(m => `${m.role.toUpperCase()}: ${m.content}`)
      ].join('\n\n');

      const retryBody: any = {
        contents: [{ role: 'user', parts: [{ text: merged }] }],
        generationConfig: {
          temperature: req.temperature ?? 0.2,
          maxOutputTokens: req.maxTokens ?? 1200,
          responseMimeType: "text/plain",
          candidateCount: 1
        },
        safetySettings: body.safetySettings
      };

      // Phase-tune thinking for 2.5
      if (req.model.includes('gemini-2.5-pro')) {
        // Phase 1: small budget; Phase 2: even smaller (or off if allowed)
        retryBody.generationConfig.thinkingConfig = { thinkingBudget: phase === 1 ? 128 : 32 };
      } else if (req.model.includes('gemini-2.5-flash')) {
        retryBody.generationConfig.thinkingConfig = { thinkingBudget: 0 };
      }

      const r2 = await fetch(`${this.base}/v1beta/${modelPath}:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(retryBody)
      });

      const j2: any = await r2.json().catch(() => ({}));
      const extract = (cand: any) =>
        (cand?.content?.parts ?? [])
          .map((p: any) => p?.text || p?.code || p?.executableCode?.code || '')
          .join('');
      const t2 = (j2?.candidates?.length ? extract(j2.candidates[0]) : '') || '';
      return { t2, j2 };
    };

    if (!text && (req.model.includes('gemini-2.5') || req.model.includes('gemini-3'))) {
      const { t2, j2 } = await trySmartRetry(1);
      text = t2;
      if (!text) {
        const { t2: t3, j2: j3 } = await trySmartRetry(2);
        text = t3;
        if (!text) {
          const fb = j3?.promptFeedback?.blockReason ?? j2?.promptFeedback?.blockReason ?? j?.promptFeedback?.blockReason ?? 'EMPTY';
          throw new Error(`Gemini empty/blocked: ${fb}`);
        }
      }
    }

    const toolCalls =
      ((j?.candidates?.[0]?.content?.parts ?? [])
        .filter((p: any) => p.functionCall)
        .map((p: any) => ({ name: p.functionCall.name, arguments: p.functionCall.args }))) || [];

    return {
      text,
      tokensIn: j?.usageMetadata?.promptTokenCount ?? 0,
      tokensOut: j?.usageMetadata?.candidatesTokenCount ?? 0,
      toolCalls,
      raw: j
    };
  }
}

// ---------- DEEPSEEK ----------
// Supports both legacy models (deepseek-chat, deepseek-reasoner) and
// new V4 models (deepseek-v4-flash, deepseek-v4-pro) with thinking mode.
// V4 models support dual modes: thinking (chain-of-thought) and non-thinking.
// In thinking mode, temperature/top_p have no effect per DeepSeek docs.
export class DeepSeekAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.deepseek.com') {}
  
  async listModels() {
    // DeepSeek doesn't have a models endpoint, return known models
    // REMOVED: deepseek-chat, deepseek-reasoner — hard retire July 24, 2026 15:59 UTC
    // (currently routing to deepseek-v4-flash non-thinking/thinking, will hard-fail after deadline)
    return [
      'deepseek-v4-flash',     // 284B total / 13B active, dual mode, 1M context
      'deepseek-v4-pro'        // 1.6T total / 49B active, dual mode, 1M context
    ];
  }
  
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Detect model capabilities
    const isThinkingModel = isDeepSeekThinkingModel(req.model);
    const isV4 = /^deepseek-v4/.test(req.model);

    // V4 models support higher token limits (up to 1M context)
    let maxTokens = req.maxTokens ?? 4096;
    if (isThinkingModel && maxTokens < 8192) {
      // Thinking models need room for chain-of-thought reasoning tokens
      maxTokens = Math.max(8192, maxTokens);
    }

    const body: any = {
      model: req.model,
      messages: req.messages,
      max_tokens: maxTokens,
      stream: req.stream ?? false
    };

    // --- Temperature handling ---
    // In thinking mode, temperature has no effect (DeepSeek docs).
    // Only set temperature for non-thinking models.
    if (!isThinkingModel) {
      body.temperature = req.temperature ?? 0.0; // Use 0 for deterministic benchmark results
    }

    // --- Thinking mode configuration (V4 models) ---
    // V4 models support explicit thinking toggle via extra parameter.
    // Legacy deepseek-reasoner always uses thinking mode implicitly.
    if (isV4) {
      body.thinking = { type: 'enabled' };
      // V4 supports reasoning_effort for controlling thinking depth
      if (req.reasoning_effort) {
        body.reasoning_effort = req.reasoning_effort;
      }
    }

    // Add tools if provided - DeepSeek V4 models support tool calling in both modes
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      }));
    }

    if (req.toolChoice) {
      body.tool_choice = req.toolChoice;
    }

    if (req.jsonSchema) {
      body.response_format = {
        type: 'json_object'  // DeepSeek uses json_object, not json_schema
      };
    }

    const r = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      throw new Error(`DeepSeek ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();
    
    const choice = j?.choices?.[0];
    const message = choice?.message;

    // --- Response text extraction ---
    // Thinking models return reasoning in message.reasoning_content (CoT)
    // and the final answer in message.content.
    // IMPORTANT: Do NOT feed reasoning_content back as input — the API errors.
    let text = message?.content || '';
    const reasoningContent = message?.reasoning_content || '';

    // Only use reasoning_content as fallback if content is completely empty
    if (!text && reasoningContent) {
      text = reasoningContent;
    }
    
    // Extract tool calls if present
    const toolCalls = (message?.tool_calls ?? []).map((t: any) => ({
      name: t.function?.name,
      arguments: typeof t.function?.arguments === 'string'
        ? JSON.parse(t.function.arguments)
        : t.function?.arguments
    }));

    // --- Token usage extraction ---
    const usage = j?.usage ?? {};
    // DeepSeek V4 reports reasoning_tokens separately in completion_tokens_details
    const reasoningTokens = usage?.completion_tokens_details?.reasoning_tokens ?? 0;

    // Log reasoning token telemetry for thinking models
    if (reasoningTokens > 0) {
      console.log(`🧠 [DeepSeek] ${req.model}: ${reasoningTokens} reasoning tokens, ${usage?.completion_tokens ?? 0} total output`);
    }

    // Detect truncated responses
    if (choice?.finish_reason === 'length') {
      console.warn(`⚠️ [DeepSeek] ${req.model} response truncated (finish_reason=length). max_tokens was ${maxTokens}`);
    }

    return {
      text,
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      toolCalls,
      raw: {
        ...j,
        // Expose reasoning token telemetry for cost tracking
        reasoningTokens,
        reasoningContent: reasoningContent || null,
        // Expose cache hit info if available
        cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0
      }
    };
  }
}

// ---------- KIMI (Moonshot AI) ----------
// K2.5/K2.6 are thinking models (supports_reasoning: true).
// Thinking mode (default): temperature MUST be 1.0, returns reasoning_content + content.
// Disabled mode: thinking: {type: 'disabled'}, temperature MUST be 0.6.
// IMPORTANT: Do NOT feed reasoning_content back as conversation input.
export class KimiAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.moonshot.ai') {}
  
  async listModels() {
    try {
      const r = await fetch(`${this.base}/v1/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` }
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j: any = await r.json();
      return (j?.data ?? [])
        .map((m: any) => m.id)
        .filter((id: string) => /^kimi/.test(id));
    } catch {
      // Fallback to current recommended model (K2.7 Code is latest as of Jun 2026)
      return [
        'kimi-k2.7-code'
      ];
    }
  }
  
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // Detect model capabilities
    const isThinking = isKimiThinkingModel(req.model);

    // Thinking models need room for chain-of-thought reasoning tokens
    let maxTokens = req.maxTokens ?? 4096;
    if (isThinking && maxTokens < 8192) {
      maxTokens = Math.max(8192, maxTokens);
    }

    const body: any = {
      model: req.model,
      messages: req.messages,
      max_tokens: maxTokens,
      stream: req.stream ?? false
    };

    // --- Temperature handling ---
    // Kimi K2.5/K2.6 thinking mode: temperature MUST be 1.0 (API rejects anything else).
    // Kimi K2.5/K2.6 disabled mode: temperature MUST be 0.6.
    // Older models (kimi-latest, etc.): accept normal temperature range.
    if (isThinking) {
      // Always use thinking mode with forced temp=1.0
      body.temperature = 1.0;
    } else {
      body.temperature = req.temperature ?? 0.6;  // Kimi recommended default for non-thinking
    }

    // --- Thinking mode configuration (K2.5/K2.6 models) ---
    // K2.5/K2.6 default to thinking mode (reasoning_content returned).
    // We keep thinking enabled for all benchmarks — it's their natural mode.
    // To disable: body.thinking = { type: 'disabled' } + temp=0.6.

    // Add tools if provided — K2.5/K2.6 support tool calling in thinking mode
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      }));
    }

    if (req.toolChoice) {
      body.tool_choice = req.toolChoice;
    }

    if (req.jsonSchema) {
      body.response_format = {
        type: 'json_object'  // Kimi supports json_object (not full json_schema)
      };
    }

    const r = await fetch(`${this.base}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      throw new Error(`Kimi ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();
    
    const choice = j?.choices?.[0];
    const message = choice?.message;

    // --- Response text extraction ---
    // Thinking models return reasoning in message.reasoning_content (CoT)
    // and the final answer in message.content.
    // IMPORTANT: Do NOT feed reasoning_content back as input — it's internal CoT.
    let text = message?.content || '';
    const reasoningContent = message?.reasoning_content || '';

    // Only use reasoning_content as fallback if content is completely empty
    if (!text && reasoningContent) {
      text = reasoningContent;
    }
    
    // Extract tool calls if present
    const toolCalls = (message?.tool_calls ?? []).map((t: any) => ({
      name: t.function?.name,
      arguments: typeof t.function?.arguments === 'string'
        ? JSON.parse(t.function.arguments)
        : t.function?.arguments
    }));

    // --- Token usage extraction ---
    const usage = j?.usage ?? {};
    // Kimi K2.5/K2.6 do NOT report reasoning_tokens separately (all in completion_tokens)

    // Log reasoning content telemetry for thinking models
    if (reasoningContent) {
      const reasoningChars = reasoningContent.length;
      console.log(`🧠 [Kimi] ${req.model}: ~${reasoningChars} chars reasoning, ${usage?.completion_tokens ?? 0} total output tokens`);
    }

    // Detect truncated responses
    if (choice?.finish_reason === 'length') {
      console.warn(`⚠️ [Kimi] ${req.model} response truncated (finish_reason=length). max_tokens was ${maxTokens}`);
    }

    return {
      text,
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0,
      toolCalls,
      raw: {
        ...j,
        // Expose reasoning content for cost tracking and debugging
        reasoningContent: reasoningContent || null
      }
    };
  }
}

// ---------- GLM (Z.AI / Zhipu AI) ----------
// GLM-5.1: 744B MoE (40B active), 200K context, 128K max output, GA April 7, 2026
// Thinking mode: { type: 'enabled' } / { type: 'disabled' } — compulsory when enabled
// Thinking tokens count toward max_tokens (Anthropic-like, NOT OpenAI-like)
// Auth: raw Bearer token (NOT legacy JWT)
// Base URL: https://api.z.ai/api/paas/v4 (verified)
// tool_choice: only 'auto' is officially supported
export class GLMAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.z.ai/api/paas/v4') {}
  
  async listModels() {
    // Z.AI has no /models discovery endpoint — hardcode known models
    // DEPRECATED: glm-4.6, glm-4.7, glm-4.7-flash, glm-4.7-flashx — replaced by GLM-5.1
    // GLM-5.1 is GA default model, leads SWE-Bench Pro at 58.4
    return [
      'glm-5.1'            // GA April 2026 — 744B MoE, SWE-Bench Pro 58.4, $1.40/$4.40 per MTok
    ];
  }
  
  async chat(req: ChatRequest): Promise<ChatResponse> {
    // GLM-5.1 is a thinking model — thinking tokens count toward max_tokens (like Anthropic)
    // Need generous budget to avoid truncation from reasoning overhead
    const isThinkingModel = /^glm-5/.test(req.model);

    const body: any = {
      model: req.model,
      messages: req.messages,
      stream: req.stream ?? false
    };

    if (isThinkingModel) {
      // THINKING MODEL CONFIG (GLM-5 / GLM-5.1):
      // 1. Higher token limits — thinking tokens count toward max_tokens
      //    Use caller-provided budget if large enough; otherwise scale up
      body.max_tokens = req.maxTokens && req.maxTokens >= 8000
        ? req.maxTokens
        : Math.max(16384, (req.maxTokens || 4096) * 4);
      // Cap at 128K (GLM-5.1 max output ceiling = 131072)
      body.max_tokens = Math.min(body.max_tokens, 131072);

      // 2. Thinking mode — compulsory when enabled on GLM-5.1 (all inputs trigger reasoning)
      //    Allow caller to disable thinking (e.g., for canary pings) via thinking_disabled flag
      if ((req as any).thinking_disabled) {
        body.thinking = { type: 'disabled' };
      } else {
        body.thinking = { type: 'enabled' };
      }

      // 3. Temperature — still applies in thinking mode on GLM-5.1
      //    Z.AI recommended default is 1.0; valid range [0.0, 1.0]
      //    For benchmarks, use lower values for more deterministic output
      body.temperature = typeof req.temperature === 'number' ? req.temperature : 0.6;
    } else {
      // Standard (non-thinking) model config
      body.max_tokens = req.maxTokens ?? 4096;
      body.temperature = req.temperature ?? 1.0;
    }

    // Add tools if provided — OpenAI-compatible format, up to 128 functions
    if (req.tools?.length) {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      }));
      // Z.AI only officially supports tool_choice: 'auto' — do NOT send 'none' or forced function
      body.tool_choice = 'auto';
    }

    if (req.jsonSchema) {
      body.response_format = {
        type: "json_object"
      };
    }

    const r = await fetch(`${this.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(() => '');
      throw new Error(`GLM ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();
    
    const choice = j?.choices?.[0];
    const message = choice?.message;

    // Extract text content (answer)
    let text = message?.content || '';
    // Extract reasoning content (chain-of-thought) — at message.reasoning_content
    const reasoningContent = message?.reasoning_content || '';

    // Only use reasoning_content as fallback if content is completely empty
    if (!text && reasoningContent) {
      text = reasoningContent;
    }
    
    // Extract tool calls if present — arguments are JSON strings (must parse)
    const toolCalls = (message?.tool_calls ?? []).map((t: any) => ({
      name: t.function?.name,
      arguments: typeof t.function?.arguments === 'string'
        ? JSON.parse(t.function.arguments)
        : t.function?.arguments
    }));

    // Token usage — reasoning tokens are folded into completion_tokens (no separate field)
    const usage = j?.usage ?? {};

    // Log reasoning content telemetry for thinking models
    if (reasoningContent) {
      const reasoningChars = reasoningContent.length;
      console.log(`🧠 [GLM] ${req.model}: ~${reasoningChars} chars reasoning, ${usage?.completion_tokens ?? 0} total output tokens`);
    }

    // Detect truncated responses
    if (choice?.finish_reason === 'length') {
      console.warn(`⚠️ [GLM] ${req.model} response truncated (finish_reason=length). max_tokens was ${body.max_tokens}`);
    }
    // Detect content filter
    if (choice?.finish_reason === 'sensitive') {
      console.warn(`⚠️ [GLM] ${req.model} content filtered (finish_reason=sensitive)`);
    }

    return {
      text,
      tokensIn: usage?.prompt_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? 0, // NOTE: completion_tokens includes thinking tokens
      toolCalls,
      raw: {
        ...j,
        // Expose reasoning content for debugging and multi-turn preserved thinking
        reasoningContent: reasoningContent || null,
        // Expose cache hit info
        cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
        // Expose finish reason for truncation/filter detection
        finishReason: choice?.finish_reason
      }
    };
  }
}

// Factory function to create adapters
export function createAdapter(provider: Provider, apiKey: string): LLMAdapter {
  switch (provider) {
    case 'openai': return new OpenAIAdapter(apiKey);
    case 'xai': return new XAIAdapter(apiKey);
    case 'anthropic': return new AnthropicAdapter(apiKey);
    case 'google': return new GoogleAdapter(apiKey);
    case 'glm': return new GLMAdapter(apiKey);
    case 'deepseek': return new DeepSeekAdapter(apiKey);
    case 'kimi': return new KimiAdapter(apiKey);
    default: throw new Error(`Unknown provider: ${provider}`);
  }
}
