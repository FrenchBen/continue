import { BaseLLM } from "..";
import type {
  ChatMessage,
  CompletionOptions,
  CompletionsEndpointType,
  LLMOptions,
  ModelProvider,
} from "../../index.js";
import { stripImages } from "../countTokens.js";
import { BaseLLM } from "../index.js";
import { streamSse } from "../stream.js";

const NON_CHAT_MODELS = [
  "text-davinci-002",
  "text-davinci-003",
  "code-davinci-002",
  "text-ada-001",
  "text-babbage-001",
  "text-curie-001",
  "davinci",
  "curie",
  "babbage",
  "ada",
];

const CHAT_ONLY_MODELS = [
  "gpt-3.5-turbo",
  "gpt-3.5-turbo-0613",
  "gpt-3.5-turbo-16k",
  "gpt-4",
  "gpt-4-turbo",
  "gpt-35-turbo-16k",
  "gpt-35-turbo-0613",
  "gpt-35-turbo",
  "gpt-4-32k",
  "gpt-4-turbo-preview",
  "gpt-4-vision",
  "gpt-4-0125-preview",
  "gpt-4-1106-preview",
];

class OpenAI extends BaseLLM {
  public forceCompletionsEndpointType: CompletionsEndpointType | undefined =
    undefined;

  constructor(options: LLMOptions) {
    super(options);
    this.forceCompletionsEndpointType = options.forceCompletionsEndpointType;
  }

  static providerName: ModelProvider = "openai";
  static defaultOptions: Partial<LLMOptions> = {
    apiBase: "https://api.openai.com/v1/",
  };

  protected _convertMessage(message: ChatMessage) {
    if (typeof message.content === "string") {
      return message;
    }

    const parts = message.content.map((part) => {
      const msg: any = {
        type: part.type,
        text: part.text,
      };
      if (part.type === "imageUrl") {
        msg.image_url = { ...part.imageUrl, detail: "low" };
        msg.type = "image_url";
      }
      return msg;
    });
    return {
      ...message,
      content: parts,
    };
  }

  protected _convertModelName(model: string): string {
    return model;
  }

  protected _convertArgs(options: any, messages: ChatMessage[]) {
    const url = new URL(this.apiBase!);
    const finalOptions = {
      messages: messages.map(this._convertMessage),
      model: this._convertModelName(options.model),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      stop:
        // Jan + Azure OpenAI don't truncate and will throw an error
        url.port === "1337" ||
        url.host === "api.openai.com" ||
        this.apiType === "azure"
          ? options.stop?.slice(0, 4)
          : options.stop,
    };

    return finalOptions;
  }

  protected _getHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "api-key": this.apiKey ?? "", // For Azure
    };
  }

  protected async _complete(
    prompt: string,
    options: CompletionOptions,
  ): Promise<string> {
    let completion = "";
    for await (const chunk of this._streamChat(
      [{ role: "user", content: prompt }],
      options,
    )) {
      completion += chunk.content;
    }

    return completion;
  }

  private _getEndpoint(
    endpoint: "chat/completions" | "completions" | "models",
  ) {
    if (this.apiType === "azure") {
      return new URL(
        `openai/deployments/${this.engine}/${endpoint}?api-version=${this.apiVersion}`,
        this.apiBase,
      );
    }
    if (!this.apiBase) {
      throw new Error(
        "No API base URL provided. Please set the 'apiBase' option in config.json",
      );
    }

    return new URL(endpoint, this.apiBase);
  }

  protected async *_streamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    const completionsEndpointType = this._completionsEndpointType(options);
    if (completionsEndpointType === "/completions") {
      for await (const update of this._legacystreamComplete(prompt, options)) {
        yield update;
      }
    } else {
      for await (const chunk of this._streamChat(
        [{ role: "user", content: prompt }],
        options,
      )) {
        yield stripImages(chunk.content);
      }
    }
  }

  protected async *_legacystreamComplete(
    prompt: string,
    options: CompletionOptions,
  ): AsyncGenerator<string> {
    const args: any = this._convertArgs(options, []);
    args.prompt = prompt;
    args.messages = undefined;

    const response = await this.fetch(this._getEndpoint("completions"), {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify({
        ...args,
        stream: true,
      }),
    });

    for await (const value of streamSse(response)) {
      if (value.choices?.[0]?.text && value.finish_reason !== "eos") {
        yield value.choices[0].text;
      }
    }
  }

  private _completionsEndpointType(
    options: CompletionOptions,
  ): CompletionsEndpointType {
    // If this is set, the user's choice overrides whatever other logic we may have
    if (this.forceCompletionsEndpointType) {
      return this.forceCompletionsEndpointType;
    }

    // Distinguish between models that require one endpoint or the other,
    // check for providers that don't support the legacy /completions,
    // and allow `"raw": true` to be used to call /completions
    const shouldUseRawCompletions =
      !CHAT_ONLY_MODELS.includes(options.model) &&
      this.supportsCompletions() &&
      (NON_CHAT_MODELS.includes(options.model) || options.raw);

    return shouldUseRawCompletions ? "/completions" : "/chat/completions";
  }

  protected async *_streamChat(
    messages: ChatMessage[],
    options: CompletionOptions,
  ): AsyncGenerator<ChatMessage> {
    // Decision point for /completions vs. /chat/completions
    if (this._completionsEndpointType(options) === "/completions") {
      for await (const content of this._legacystreamComplete(
        stripImages(messages[messages.length - 1]?.content || ""),
        options,
      )) {
        yield {
          role: "assistant",
          content,
        };
      }
      return;
    }

    const body = {
      ...this._convertArgs(options, messages),
      stream: true,
    };
    // Empty messages cause an error in LM Studio
    body.messages = body.messages.map((m) => ({
      ...m,
      content: m.content === "" ? " " : m.content,
    })) as any;
    const response = await this.fetch(this._getEndpoint("chat/completions"), {
      method: "POST",
      headers: this._getHeaders(),
      body: JSON.stringify(body),
    });

    for await (const value of streamSse(response)) {
      if (value.choices?.[0]?.delta?.content) {
        yield value.choices[0].delta;
      }
    }
  }

  async listModels(): Promise<string[]> {
    const response = await this.fetch(this._getEndpoint("models"), {
      method: "GET",
      headers: this._getHeaders(),
    });

    const data = await response.json();
    return data.data.map((m: any) => m.id);
  }
}

export default OpenAI;
