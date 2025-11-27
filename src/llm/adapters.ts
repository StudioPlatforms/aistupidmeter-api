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
  reasoning_effort?: 'low' | 'medium' | 'high' | 'minimal';
  verbosity?: 'low' | 'medium' | 'high';
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
      // Conservative fallback: only generally available models
      return ['gpt-4o', 'gpt-4o-mini'];
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

    // GPT-5 needs much higher token limits due to reasoning consumption
    let maxTokens = req.maxTokens ?? 1200;
    if (isGPT5) {
      // GPT-5 can consume 1000+ tokens for reasoning alone, so we need much higher limits
      maxTokens = Math.max(8000, (req.maxTokens || 1200) * 5);
    }

    const body: any = {
      model: req.model,
      // Proper content blocks for Responses API
      input: req.messages.map(m => ({
        role: m.role,
        content: [{ 
          type: m.role === 'assistant' ? "output_text" : "input_text", 
          text: m.content 
        }]
      })),
      max_output_tokens: maxTokens
    };
    
    // Only non-reasoning models accept temperature
    if (!isReasoning && typeof req.temperature === 'number') {
      body.temperature = req.temperature;
    }
    // Reasoning models accept a reasoning config instead
    if (isReasoning && req.reasoning_effort) {
      body.reasoning = { effort: req.reasoning_effort }; // "low" | "medium" | "high" | "minimal"
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
    if (req.toolChoice) {
      body.tool_choice = req.toolChoice === 'auto' ? 'auto' :
        (req.toolChoice === 'none' ? 'none' : {
          type: 'function',
          function: { name: req.toolChoice.name }
        });
    }
    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.jsonSchemaName || 'Result',
          schema: req.jsonSchema
        }
      };
    }

    const r = await fetch(`${this.base}/v1/responses`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const errTxt = await r.text().catch(()=>'');
      throw new Error(`OpenAI ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();

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

    const usage = j?.usage ?? {};
    return {
      text,
      tokensIn: usage?.prompt_tokens ?? usage?.input_tokens ?? 0,
      tokensOut: usage?.completion_tokens ?? usage?.output_tokens ?? 0,
      toolCalls: [],
      raw: j
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
    const j: any = await r.json();
    const msg = j.choices?.[0]?.message;
    const toolCalls = msg?.tool_calls?.map((t: any) => ({
      name: t.function?.name,
      arguments: JSON.parse(t.function?.arguments || '{}')
    })) || [];
    return { text: msg?.content ?? '', toolCalls, raw: j };
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
      return ['grok-4-latest', 'grok-2-latest', 'grok-code-fast-1'];
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
        // include 3.5, 3.7 sonnet + sonnet-4/opus/haiku families
        .filter((id: string) =>
          /^claude-(3-5-sonnet|3-5-haiku|3-7-sonnet|sonnet-4|opus)/.test(id)
        );
    } catch {
      // Fallback to known models including 2025 ones
      return [
        'claude-3-5-sonnet',
        'claude-3-5-haiku',
        'claude-3-7-sonnet',         // rely on live list for exact suffixes
        'claude-sonnet-4-20250514',
        'claude-sonnet-4-5-20250929',
        'claude-opus-4-20250514',
        'claude-opus-4-1-20250805',
        'claude-opus-4-1',
        'claude-opus-4-5-20251101'   // New flagship model - November 2025
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

    const body: any = {
      model: req.model,
      max_tokens: req.maxTokens ?? 1200,
      temperature: req.temperature ?? 0.2,
      messages: turns
    };
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
    const text =
      (j?.content ?? [])
        .filter((c: any) => c.type === 'text' && typeof c.text === 'string')
        .map((c: any) => c.text)
        .join('\n') || '';

    const toolCalls =
      (j?.content ?? [])
        .filter((c: any) => c.type === 'tool_use')
        .map((c: any) => ({ name: c.name, arguments: c.input })) || [];

    return {
      text,
      tokensIn: j?.usage?.input_tokens ?? 0,
      tokensOut: j?.usage?.output_tokens ?? 0,
      toolCalls,
      raw: j
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
      // Only return models your key is actually entitled to
      const discovered = (j.models ?? [])
        .map((m: any) => String(m.name).replace('models/', ''));
      return discovered;
    } catch {
      // Conservative fallback: 1.5 family only
      return ['gemini-1.5-flash', 'gemini-1.5-pro'];
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

    // If 2.5, give each request a harmless unique salt to avoid prompt dedupe
    let salt = '';
    if (req.model.includes('gemini-2.5')) {
      salt = `\n\n<!-- salt:${Math.random().toString(36).slice(2, 8)} -->`;
    }

    // Adjust thinking config for Gemini 2.5 models
    if (req.model.includes("gemini-2.5-pro")) {
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

    if (!text && req.model.includes('gemini-2.5')) {
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
export class DeepSeekAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.deepseek.com') {}
  
  async listModels() {
    // DeepSeek doesn't have a models endpoint, return known models
    return [
      'deepseek-chat',
      'deepseek-reasoner'
    ];
  }
  
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 1.0, // DeepSeek default is 1.0
      max_tokens: req.maxTokens ?? 4096,
      stream: req.stream ?? false
    };

    // Add tools if provided (but note: deepseek-reasoner doesn't support tools)
    if (req.tools?.length && req.model !== 'deepseek-reasoner') {
      body.tools = req.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters || { type: 'object', properties: {} }
        }
      }));
    }

    if (req.toolChoice && req.model !== 'deepseek-reasoner') {
      body.tool_choice = req.toolChoice;
    }

    if (req.jsonSchema) {
      body.response_format = {
        type: "json_schema",
        json_schema: {
          name: req.jsonSchemaName || 'Result',
          schema: req.jsonSchema
        }
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
    // Handle reasoning models that put content in reasoning_content field
    let text = message?.content || '';
    if (!text && message?.reasoning_content) {
      text = message.reasoning_content;
    }
    
    // Extract tool calls if present
    const toolCalls = (message?.tool_calls ?? []).map((t: any) => ({
      name: t.function?.name,
      arguments: typeof t.function?.arguments === 'string' 
        ? JSON.parse(t.function.arguments) 
        : t.function?.arguments
    }));

    return {
      text,
      tokensIn: j?.usage?.prompt_tokens ?? 0,
      tokensOut: j?.usage?.completion_tokens ?? 0,
      toolCalls,
      raw: j
    };
  }
}

// ---------- KIMI (Moonshot AI) ----------
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
      // Fallback to known working models
      return [
        'kimi-k2-0905-preview',
        'kimi-latest',
        'kimi-thinking-preview'
      ];
    }
  }
  
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 0.6, // Kimi recommended default
      max_tokens: req.maxTokens ?? 4096,
      stream: req.stream ?? false
    };

    // Add tools if provided
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
      const errTxt = await r.text().catch(() => '');
      throw new Error(`Kimi ${r.status}: ${errTxt}`);
    }

    const j: any = await r.json();
    
    const choice = j?.choices?.[0];
    const message = choice?.message;
    // Handle reasoning models that put content in reasoning_content field
    let text = message?.content || '';
    if (!text && message?.reasoning_content) {
      text = message.reasoning_content;
    }
    
    // Extract tool calls if present
    const toolCalls = (message?.tool_calls ?? []).map((t: any) => ({
      name: t.function?.name,
      arguments: typeof t.function?.arguments === 'string' 
        ? JSON.parse(t.function.arguments) 
        : t.function?.arguments
    }));

    return {
      text,
      tokensIn: j?.usage?.prompt_tokens ?? 0,
      tokensOut: j?.usage?.completion_tokens ?? 0,
      toolCalls,
      raw: j
    };
  }
}

// ---------- GLM (Z.AI) ----------
export class GLMAdapter implements LLMAdapter {
  constructor(private apiKey: string, private base = 'https://api.z.ai/api/paas/v4') {}
  
  async listModels() {
    // GLM doesn't have a models endpoint, return known models
    return ['glm-4.6'];
  }
  
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const body: any = {
      model: req.model,
      messages: req.messages,
      temperature: req.temperature ?? 1.0, // GLM-4.6 default is 1.0
      max_tokens: req.maxTokens ?? 4096,
      stream: req.stream ?? false
    };

    // Enable thinking mode for GLM-4.6 reasoning capabilities (as per docs)
    if (req.model === 'glm-4.6') {
      body.thinking = { type: 'enabled' };
    }

    // Add tools if provided
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
    // Handle reasoning models that put content in reasoning_content field
    let text = message?.content || '';
    if (!text && message?.reasoning_content) {
      text = message.reasoning_content;
    }
    
    // Extract tool calls if present
    const toolCalls = (message?.tool_calls ?? []).map((t: any) => ({
      name: t.function?.name,
      arguments: typeof t.function?.arguments === 'string' 
        ? JSON.parse(t.function.arguments) 
        : t.function?.arguments
    }));

    return {
      text,
      tokensIn: j?.usage?.prompt_tokens ?? 0,
      tokensOut: j?.usage?.completion_tokens ?? 0,
      toolCalls,
      raw: j
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
