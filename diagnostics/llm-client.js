/**
 * Multi-provider LLM Client
 * Uses native fetch() - no external SDK dependency.
 * Supports: OpenAI, Anthropic, Google Gemini, Custom (OpenAI-compatible)
 */

const LLM_TIMEOUT_MS = 300_000; // 5 minutes

// Block server-supplied LLM base_urls that point at SSRF-sensitive targets
// (cloud metadata, loopback, and — unless explicitly allowed — private/cluster
// addresses). Prevents a compromised server from exfiltrating the LLM API key
// or pivoting into the cluster network via a crafted custom base_url.
function assertSafeLlmEndpoint(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (_) {
    throw new Error(`Invalid LLM base_url: ${rawUrl}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`LLM base_url must be http(s): ${rawUrl}`);
  }
  const host = u.hostname.toLowerCase();
  // Always-blocked: cloud metadata + loopback + link-local
  const alwaysBlocked =
    host === "169.254.169.254" ||
    host === "metadata.google.internal" ||
    host === "localhost" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("169.254.") ||
    host.startsWith("fd00:ec2") ;
  if (alwaysBlocked) {
    throw new Error(`LLM base_url host is blocked (metadata/loopback): ${host}`);
  }
  // Private / cluster-internal — blocked unless operator opts in
  const allowPrivate = process.env.DOCTOR_ALLOW_PRIVATE_LLM_ENDPOINT === "true";
  const isPrivate =
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".svc") ||
    host.endsWith(".svc.cluster.local") ||
    host.endsWith(".cluster.local") ||
    host.endsWith(".internal");
  if (isPrivate && !allowPrivate) {
    throw new Error(
      `LLM base_url points to a private/cluster address (${host}); set DOCTOR_ALLOW_PRIVATE_LLM_ENDPOINT=true to permit`,
    );
  }
}

class LLMClient {
  constructor(config) {
    this.provider = config.provider; // openai, anthropic, google, custom
    this.model = config.model;
    this.apiKey = config.api_key;
    this.baseUrl = config.base_url;
  }

  /** fetch with timeout via AbortController */
  async _fetch(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LLM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      return res;
    } catch (err) {
      if (err.name === "AbortError") {
        throw new Error(`LLM request timed out after ${LLM_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async analyze(systemPrompt, userPrompt) {
    const startTime = Date.now();

    try {
      let result;
      switch (this.provider) {
        case "openai":
          result = await this._callOpenAI(systemPrompt, userPrompt);
          break;
        case "anthropic":
          result = await this._callAnthropic(systemPrompt, userPrompt);
          break;
        case "google":
          result = await this._callGoogle(systemPrompt, userPrompt);
          break;
        case "zhipu":
          result = await this._callZhipu(systemPrompt, userPrompt);
          break;
        case "deepseek":
          result = await this._callDeepSeek(systemPrompt, userPrompt);
          break;
        case "custom":
          result = await this._callCustom(systemPrompt, userPrompt);
          break;
        default:
          throw new Error(`Unsupported LLM provider: ${this.provider}`);
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[Doctor] LLM analysis completed in ${elapsed}ms (${this.provider}/${this.model}, ${result.tokens_used || "?"} tokens)`
      );

      return result;
    } catch (error) {
      const elapsed = Date.now() - startTime;
      console.error(
        `[Doctor] LLM analysis failed after ${elapsed}ms:`,
        error.message
      );
      throw error;
    }
  }

  // --- OpenAI ---
  async _callOpenAI(systemPrompt, userPrompt) {
    const url = "https://api.openai.com/v1/chat/completions";

    const response = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const tokensUsed =
      (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);

    return {
      analysis: this._parseJSON(content),
      tokens_used: tokensUsed,
      raw_response: content,
    };
  }

  // --- Anthropic ---
  async _callAnthropic(systemPrompt, userPrompt) {
    const url = "https://api.anthropic.com/v1/messages";

    const response = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;
    const tokensUsed =
      (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);

    return {
      analysis: this._parseJSON(content),
      tokens_used: tokensUsed,
      raw_response: content,
    };
  }

  // --- Google Gemini ---
  async _callGoogle(systemPrompt, userPrompt) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const response = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Google API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
    const tokensUsed =
      (data.usageMetadata?.promptTokenCount || 0) +
      (data.usageMetadata?.candidatesTokenCount || 0);

    return {
      analysis: this._parseJSON(content),
      tokens_used: tokensUsed,
      raw_response: content,
    };
  }

  // --- Zhipu AI (GLM) ---
  async _callZhipu(systemPrompt, userPrompt) {
    const baseUrl = this.baseUrl || "https://api.z.ai/api/coding/paas/v4";
    // SSRF guard: zhipu base_url may come from server config (default is public).
    assertSafeLlmEndpoint(baseUrl);
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

    const response = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Zhipu API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const tokensUsed =
      (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);

    return {
      analysis: this._parseJSON(content),
      tokens_used: tokensUsed,
      raw_response: content,
    };
  }

  // --- DeepSeek (OpenAI-compatible) ---
  async _callDeepSeek(systemPrompt, userPrompt) {
    const baseUrl = this.baseUrl || "https://api.deepseek.com/v1";
    // SSRF guard: deepseek base_url may come from server config (default is public).
    assertSafeLlmEndpoint(baseUrl);
    const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;

    const response = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`DeepSeek API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const tokensUsed =
      (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);

    return {
      analysis: this._parseJSON(content),
      tokens_used: tokensUsed,
      raw_response: content,
    };
  }

  // --- Custom (OpenAI-compatible) ---
  async _callCustom(systemPrompt, userPrompt) {
    if (!this.baseUrl) {
      throw new Error("base_url required for custom provider");
    }

    // SSRF guard: custom base_url is fully server-supplied — validate first.
    assertSafeLlmEndpoint(this.baseUrl);
    const url = `${this.baseUrl.replace(/\/$/, "")}/chat/completions`;

    const response = await this._fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.2,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Custom API error (${response.status}): ${err}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    const tokensUsed =
      (data.usage?.prompt_tokens || 0) + (data.usage?.completion_tokens || 0);

    return {
      analysis: this._parseJSON(content),
      tokens_used: tokensUsed,
      raw_response: content,
    };
  }

  // --- Parse JSON from LLM response ---
  _parseJSON(text) {
    if (!text) return null;

    // Try direct parse
    try {
      return JSON.parse(text);
    } catch {}

    // Try extracting from markdown code block
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[1].trim());
      } catch {}
    }

    // Try finding JSON object in text
    const braceMatch = text.match(/\{[\s\S]*\}/);
    if (braceMatch) {
      try {
        return JSON.parse(braceMatch[0]);
      } catch {}
    }

    console.error("[Doctor] Failed to parse LLM response as JSON");
    return null;
  }
}

module.exports = { LLMClient };
