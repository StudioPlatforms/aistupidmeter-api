import { LLMAdapter, ChatRequest } from '../llm/adapters';
import { DeepTask, DeepStep } from './tasks';
import * as crypto from 'crypto';
import { exec as _exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
const exec = promisify(_exec);

export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface TurnResult {
  turnIndex: number;
  prompt: string;
  response: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  evaluation?: {
    passed: boolean;
    feedback?: string;
    artifacts?: any;
  };
}

export interface SessionResult {
  taskSlug: string;
  turns: number;
  totalLatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  conversation: Message[];
  artifacts: TurnResult[];
  finalScore: number;
  passed: boolean;
}

export interface ModelInfo {
  id: number;
  name: string;
  vendor: 'openai' | 'anthropic' | 'google' | 'xai';
}

// Detect credit/quota exhaustion so callers can swap in synthetic scores
function isCreditExhausted(error: any): boolean {
  const status = error?.status || error?.response?.status;
  const errorMsg = String(error?.message || error).toLowerCase();
  if (status === 402) return true;
  if (status === 429) {
    return errorMsg.includes('credit') ||
           errorMsg.includes('quota') ||
           errorMsg.includes('billing') ||
           errorMsg.includes('balance');
  }
  if (status === 403) {
    return errorMsg.includes('credit') ||
           errorMsg.includes('quota') ||
           errorMsg.includes('insufficient') ||
           errorMsg.includes('balance') ||
           errorMsg.includes('billing');
  }
  return errorMsg.includes('insufficient credits') ||
         errorMsg.includes('insufficient_quota') ||
         errorMsg.includes('quota exceeded') ||
         errorMsg.includes('quota_exceeded') ||
         (errorMsg.includes('credit') && errorMsg.includes('exhaust')) ||
         errorMsg.includes('billing') ||
         errorMsg.includes('payment required') ||
         errorMsg.includes('account_deactivated') ||
         errorMsg.includes('subscription');
}

export class MultiTurnSession {
  private conversation: Message[] = [];
  private artifacts: TurnResult[] = [];
  private totalLatencyMs = 0;
  private totalTokensIn = 0;
  private totalTokensOut = 0;

  constructor(private adapter: LLMAdapter, private model: ModelInfo) {}

  async runSession(task: DeepTask): Promise<SessionResult> {
    console.log(`🏗️ Starting deep session: ${task.slug} on ${this.model.name}`);
    
    // Generate unique session nonce for cache busting
    const sessionNonce = crypto.randomBytes(4).toString('hex');
    
    // Initialize with system message
    this.conversation.push({
      role: 'system',
      content: this.buildSystemPrompt(task, sessionNonce)
    });

    // Execute each step in sequence
    for (let turnIndex = 0; turnIndex < task.steps.length; turnIndex++) {
      const step = task.steps[turnIndex];
      console.log(`  🎯 Turn ${turnIndex + 1}/${task.steps.length}: ${step.id}`);
      
      try {
        const turnResult = await this.executeTurn(step, turnIndex, sessionNonce, task);
        this.artifacts.push(turnResult);
        
        // Add user and assistant messages to conversation
        this.conversation.push({
          role: 'user',
          content: turnResult.prompt
        });
        this.conversation.push({
          role: 'assistant', 
          content: turnResult.response
        });

        // Simulate realistic user feedback between turns
        if (step.expectsFeedback && turnResult.evaluation && turnIndex < task.steps.length - 1) {
          const feedback = this.generateFeedback(turnResult, step);
          if (feedback) {
            this.conversation.push({
              role: 'user',
              content: feedback
            });
          }
        }

        // Small delay between turns to simulate real usage
        await this.sleep(500);
        
      } catch (error) {
        console.error(`    ❌ Turn ${turnIndex + 1} failed: ${String(error).slice(0, 100)}`);

        // Bubble up credit exhaustion so the top-level runner can insert synthetic scores
        if (isCreditExhausted(error)) {
          throw error;
        }
        
        // Create failed turn result
        const failedTurn: TurnResult = {
          turnIndex,
          prompt: step.prompt({ nonce: sessionNonce, artifacts: this.artifacts }),
          response: `[TURN FAILED: ${String(error).slice(0, 200)}]`,
          tokensIn: 0,
          tokensOut: 0,
          latencyMs: 0,
          evaluation: { passed: false, feedback: `Turn failed: ${String(error)}` }
        };
        this.artifacts.push(failedTurn);
      }
    }

    // Calculate final session score
    const finalScore = await this.calculateSessionScore(task);
    const passed = finalScore >= 60; // 60% threshold for passing

    console.log(`  📊 Session completed: ${finalScore}/100 (${passed ? 'PASSED' : 'FAILED'})`);

    return {
      taskSlug: task.slug,
      turns: this.artifacts.length,
      totalLatencyMs: this.totalLatencyMs,
      totalTokensIn: this.totalTokensIn,
      totalTokensOut: this.totalTokensOut,
      conversation: [...this.conversation],
      artifacts: [...this.artifacts],
      finalScore,
      passed
    };
  }

  private async executeTurn(
    step: DeepStep, 
    turnIndex: number, 
    sessionNonce: string,
    task: DeepTask
  ): Promise<TurnResult> {
    
    // Generate the prompt for this turn
    const prompt = step.prompt({
      nonce: sessionNonce,
      prev: this.artifacts[turnIndex - 1],
      artifacts: this.artifacts
    });

    // Prepare chat request with anti-caching
    const chatRequest: ChatRequest = {
      model: this.model.name,
      messages: [...this.conversation, { role: 'user', content: prompt }],
      temperature: step.temperature || 0.1,
      maxTokens: step.maxTokens || 1500
    };

    // Add reasoning effort for OpenAI o-series models
    if (this.model.vendor === 'openai' && /^o\d|^o-mini|^o-/.test(this.model.name)) {
      (chatRequest as any).reasoning_effort = 'low'; // Minimal reasoning for speed
    }

    const startTime = Date.now();
    
    // Execute the API call with retries
    const response = await this.callLLMWithRetry(chatRequest);
    const latencyMs = Date.now() - startTime;

    if (!response) {
      throw new Error('Failed to get response from LLM after retries');
    }

    // Extract response text and token counts
    const responseText = this.extractResponseText(response);
    const tokensIn = this.extractTokensIn(response) || this.estimateTokens(
      chatRequest.messages.map(m => m.content).join('\n')
    );
    const tokensOut = this.extractTokensOut(response) || this.estimateTokens(responseText);

    // Update totals
    this.totalLatencyMs += latencyMs;
    this.totalTokensIn += tokensIn;
    this.totalTokensOut += tokensOut;

    // Evaluate the turn if judge is specified
    let evaluation;
    if (step.judge && step.judge !== 'none') {
      evaluation = await this.evaluateTurn(step, responseText, task);
    }

    return {
      turnIndex,
      prompt,
      response: responseText,
      tokensIn,
      tokensOut,
      latencyMs,
      evaluation
    };
  }

  private buildSystemPrompt(task: DeepTask, sessionNonce: string): string {
    const basePrompt = "You are an expert software engineer and problem solver. " +
      "Provide clear, practical solutions. Follow instructions precisely. " +
      "Give complete, working code when requested.";
    
    // Add task-specific context
    let taskContext = "";
    if (task.slug.includes('debug') || task.slug.includes('ide')) {
      taskContext = " Focus on systematic debugging and clear explanations of issues found.";
    } else if (task.slug.includes('spec') || task.slug.includes('api')) {
      taskContext = " Pay careful attention to requirements and ensure all specifications are met.";
    } else if (task.slug.includes('doc') || task.slug.includes('memory')) {
      taskContext = " Base answers strictly on provided documentation. Do not invent information.";
    } else if (task.slug.includes('refactor')) {
      taskContext = " Focus on clean architecture, separation of concerns, and maintainable code.";
    }

    return `${basePrompt}${taskContext} [Session: ${sessionNonce}]`;
  }

  private async callLLMWithRetry(request: ChatRequest, maxRetries = 3): Promise<any> {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.adapter.chat(request);
        return response;
      } catch (error: any) {
        console.log(`    ⚠️ API call attempt ${attempt + 1} failed: ${String(error).slice(0, 100)}`);
        
        if (attempt === maxRetries - 1) {
          throw error;
        }

        // Exponential backoff with jitter
        const delay = Math.min(8000, (1000 * Math.pow(2, attempt)) + Math.random() * 1000);
        await this.sleep(delay);
      }
    }
  }

  private extractResponseText(response: any): string {
    // Handle different response formats from various adapters
    if (typeof response.text === 'string') return response.text.trim();
    if (response.choices?.[0]?.message?.content) return response.choices[0].message.content.trim();
    if (typeof response.output_text === 'string') return response.output_text.trim();
    
    console.warn('⚠️ Unexpected response format:', Object.keys(response));
    return String(response.content || response.message || '').trim();
  }

  private extractTokensIn(response: any): number {
    return response.tokensIn ||
           response.usage?.prompt_tokens ||
           response.usage?.input_tokens ||
           response.usageMetadata?.promptTokenCount ||
           0;
  }

  private extractTokensOut(response: any): number {
    return response.tokensOut ||
           response.usage?.completion_tokens ||
           response.usage?.output_tokens ||
           response.usageMetadata?.candidatesTokenCount ||
           0;
  }

  private estimateTokens(text: string): number {
    // Rough estimation: ~4 characters per token
    return Math.max(1, Math.ceil(text.length / 4));
  }

  private async evaluateTurn(
    step: DeepStep, 
    response: string, 
    task: DeepTask
  ): Promise<{ passed: boolean; feedback?: string; artifacts?: any }> {
    
    switch (step.judge) {
      case 'code_tests':
        return await this.evaluateCodeResponse(response, task);
      
      case 'doc_qa_match':
        return this.evaluateDocQA(response, task);
      
      case 'plan_coherence':
        return this.evaluatePlanCoherence(response, task);
      
      case 'rule_memory':
        return this.evaluateRuleMemory(response, task);
      
      default:
        return { passed: true };
    }
  }

  private async evaluateCodeResponse(response: string, task: DeepTask): Promise<{ passed: boolean; feedback?: string; artifacts?: any }> {
    let dir: string | undefined;
    try {
      dir = await this.materializeResources(task.resources);
      await this.applyCodeIntoRepo(dir, response);

      // For deep/ide_assistant and deep/spec_follow, try to run actual tests
      const hasPytest = await fs.stat(path.join(dir, 'test_cart.py'))
        .then(() => true).catch(() => false);
      
      if (!hasPytest && !task.resources?.unitTests) {
        // Quick syntax check fallback
        try {
          await exec(`python3 -m py_compile *.py`, { cwd: dir, timeout: 20000 });
        } catch (e) {
          // Syntax errors are still failures
          return { passed: false, feedback: 'Syntax errors in code', artifacts: { runner: 'syntax_check', error: String(e).slice(0, 200) } };
        }
        // If no real tests available, do minimal structural check but don't give free points
        const hasStructure = /def\s+\w+|class\s+\w+/.test(response);
        return { passed: hasStructure, feedback: hasStructure ? undefined : 'Code lacks proper structure', artifacts: { runner: 'fallback', hasStructure } };
      }

      // Extract code quality metrics for all paths
      const code = this.extractCodeBlocks(response).join('\n\n');
      const hasCode = /def\s+\w+|class\s+\w+/.test(code);
      const hasStructure = /class\s+\w+|def\s+\w+\(.*\):/.test(code);
      const hasLogic = /\b(if|for|while|try)\b/.test(code);

      try {
        await this.runPyTests(dir);
        return { passed: true, artifacts: { runner: 'pytest', dir, passed: true, hasCode, hasStructure, hasLogic } };
      } catch (e: any) {
        const out = `${e.stdout || ''}\n${e.stderr || ''}`.slice(0, 4000);
        return { passed: false, feedback: 'Unit tests failed', artifacts: { runner: 'pytest', dir, log: out, hasCode, hasStructure, hasLogic } };
      }
    } catch (e: any) {
      return { passed: false, feedback: 'Runner error', artifacts: { error: String(e).slice(0, 200) } };
    } finally {
      // Cleanup temp directory
      if (dir) {
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (cleanupError) {
          console.warn('Failed to cleanup temp dir:', String(cleanupError).slice(0, 100));
        }
      }
    }
  }

  private async materializeResources(resources?: DeepTask['resources']): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepbench-'));
    
    // Initial files
    if (resources?.initialFiles) {
      for (const [fname, content] of Object.entries(resources.initialFiles)) {
        await fs.writeFile(path.join(dir, fname), content, 'utf8');
      }
    }
    
    // Unit tests
    if (resources?.unitTests) {
      await fs.writeFile(path.join(dir, 'test_suite.py'), resources.unitTests, 'utf8');
    }
    
    return dir;
  }

  private extractCodeBlocks(s: string): string[] {
    const blocks: string[] = [];
    const re = /```(?:python)?\s*([\s\S]*?)```/gi;
    let m;
    while ((m = re.exec(s)) !== null) blocks.push(m[1].trim());
    return blocks.length ? blocks : [s.trim()];
  }

  private async runPyTests(testDir: string) {
    const hasSuite = await fs.stat(path.join(testDir, 'test_suite.py')).then(() => true).catch(() => false);
    const baseEnv = { ...process.env, PYTHONPATH: '' }; // keep PATH!
    if (hasSuite) {
      // Run direct script first; it uses top-level asserts and prints pass
      await exec(`python3 -I test_suite.py`, { cwd: testDir, timeout: 120000, env: baseEnv });
      return; // success if it didn't throw
    }
    const cmd = `python3 -I -m pytest -q --disable-warnings --maxfail=1`;
    return await exec(cmd, { cwd: testDir, timeout: 120000, env: baseEnv });
  }

  private async applyCodeIntoRepo(dir: string, response: string) {
    // Naive strategy: if response contains edits to known files, patch them;
    // else try to detect primary module & append/overwrite main.py
    const code = this.extractCodeBlocks(response).join('\n\n');
    
    // Prefer editing known files
    const candidates = ['main.py', 'app.py', 'auth.py', 'router.py', 'models.py'];
    for (const c of candidates) {
      const p = path.join(dir, c);
      try {
        const exists = await fs.stat(p).then(() => true).catch(() => false);
        if (exists) {
          // Simple overwrite (safer than patching diffs for now)
          await fs.writeFile(p, code, 'utf8');
          return;
        }
      } catch {}
    }
    // Fallback: create modules the tests look for
    await fs.writeFile(path.join(dir, 'app.py'), code, 'utf8');
    await fs.writeFile(path.join(dir, 'auth.py'), code, 'utf8');
    // Optional: also create main.py for other tasks
    await fs.writeFile(path.join(dir, 'main.py'), code, 'utf8');
  }

  private evaluateDocQA(response: string, task: DeepTask): { passed: boolean; feedback?: string; artifacts?: any } {
    if (!task.resources?.document) {
      return { passed: true };
    }

    const doc = (task.resources.document || "").toLowerCase();
    const a = response.toLowerCase();

    const expect = {
      premiumRate: /premium users:\s*1000 requests\/hour/,
      accessTtl: /(access token|access tokens).*(60 minutes|60\s*minutes)/,
      webhookOK: /http\s*200-299/,
      retries: /retry.*(immediate|1 minute|5 minute|30 minute|2 hour)/s
    };

    const checks = [
      expect.premiumRate.test(doc) && /1000 requests\/hour/.test(a),
      expect.accessTtl.test(doc) && /(60 minutes|60\s*minutes)/.test(a),
      expect.webhookOK.test(doc) && /(200-299|2\d\d)/.test(a),
      expect.retries.test(doc) && /(immediate).*(1\s*minute).*(5\s*minute).*(30\s*minute).*(2\s*hour[s]?)/is.test(a),
    ];

    const accuracy = checks.reduce((s, c) => s + (c ? 1 : 0), 0) / checks.length;
    const passed = accuracy >= 0.75;
    
    const feedback = passed ? undefined :
      "Answer must be anchored to specific facts in the documentation. Avoid generic responses.";
    
    return { passed, feedback, artifacts: { accuracy, checks } };
  }

  private evaluatePlanCoherence(response: string, task: DeepTask): { passed: boolean; feedback?: string; artifacts?: any } {
    // Extract and score plan consistency instead of just keywords
    const currentClaims = this.extractClaims(response);
    let coherenceScore = 0.7; // Default if no previous context
    
    if (this.artifacts.length > 0) {
      const prevClaims = this.extractClaims(this.artifacts[this.artifacts.length - 1].response);
      coherenceScore = this.scoreConsistency(prevClaims, currentClaims);
    }
    
    // Still check for basic structure but don't make it the only factor
    const hasStructure = /\d+\.|•|-/.test(response);
    const hasDecisions = /will use|choose|implement|strategy/.test(response.toLowerCase());
    
    let structureScore = 0;
    if (hasStructure) structureScore += 0.5;
    if (hasDecisions) structureScore += 0.5;
    
    const finalScore = (coherenceScore * 0.7) + (structureScore * 0.3);
    const passed = finalScore >= 0.6;
    
    const feedback = passed ? undefined :
      "Plan needs to be consistent with previous decisions and include specific architectural choices.";
    
    return {
      passed,
      feedback,
      artifacts: { coherenceScore, structureScore, finalScore, currentClaims: Array.from(currentClaims) }
    };
  }

  private evaluateRuleMemory(response: string, task: DeepTask): { passed: boolean; feedback?: string; artifacts?: any } {
    // Check consistency with earlier responses instead of just format
    if (this.artifacts.length === 0) {
      // First response - just check basic relevance
      const hasRelevantContent = task.slug.includes('debug') ? 
        /bug|fix|error|issue|problem/.test(response.toLowerCase()) :
        /implement|create|build/.test(response.toLowerCase());
      return { passed: hasRelevantContent, feedback: hasRelevantContent ? undefined : "Response should be relevant to the task." };
    }
    
    // Check memory retention - are decisions from earlier turns maintained?
    const memoryScore = this.calculateMemoryRetention();
    const passed = memoryScore >= 0.6;
    
    const feedback = passed ? undefined : "Response doesn't maintain consistency with earlier decisions and context.";
    
    return { passed, feedback, artifacts: { memoryScore } };
  }

  private extractClaims(text: string): Set<string> {
    // Crude but effective: normalized lines that look like decisions/rules
    return new Set(
      text.split('\n')
        .map(s => s.toLowerCase().trim())
        .filter(s => /will|must|should|expires|limit|role|header|endpoint/.test(s))
        .map(s => s.replace(/\s+/g, ' '))
    );
  }

  private scoreConsistency(prev: Set<string>, later: Set<string>): number {
    if (!prev.size) return 0.7;
    let ok = 0;
    prev.forEach(c => { 
      if ([...later].some(x => x.includes(c.slice(0, 30)))) ok++; 
    });
    return ok / prev.size;
  }

  private calculateMemoryRetention(): number {
    if (this.artifacts.length < 2) return 0.7;
    
    const first = this.extractClaims(this.artifacts[0]?.response || '');
    let sum = 0, cnt = 0;
    
    for (let i = 1; i < this.artifacts.length; i++) {
      sum += this.scoreConsistency(first, this.extractClaims(this.artifacts[i].response));
      cnt++;
    }
    
    return cnt ? Math.max(0, Math.min(1, sum / cnt)) : 0.7;
  }

  private generateFeedback(turnResult: TurnResult, step: DeepStep): string | null {
    if (!turnResult.evaluation || turnResult.evaluation.passed) {
      return null; // No feedback needed for successful turns
    }

    // Generate realistic user feedback based on the failure
    if (step.judge === 'code_tests') {
      return "The code doesn't seem to work as expected. Can you revise your approach and try again?";
    } else if (step.judge === 'doc_qa_match') {
      return "Please make sure your answer is based on the documentation I provided. I need specific information from the document.";
    } else if (step.judge === 'plan_coherence') {
      return "The plan could be more detailed. Can you elaborate on the specific technologies and design decisions?";
    }

    return "Let's try a different approach to this problem.";
  }

  private async calculateSessionScore(task: DeepTask): Promise<number> {
    if (this.artifacts.length === 0) return 0;
    
    const ok = this.artifacts.filter(a => !a.evaluation || a.evaluation.passed).length;
    const success = ok / this.artifacts.length;

    // Pure completion: no verbosity bonus
    let score = success * 100;

    // Light penalty for very short answers that fail (not all short answers)
    const avgLen = this.artifacts.reduce((s, a) => s + a.response.length, 0) / this.artifacts.length;
    if (success < 0.7 && avgLen < 200) score *= 0.9;

    return Math.round(score);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
