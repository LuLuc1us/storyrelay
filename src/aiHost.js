import {
  bridgePool,
  emotionPool,
  endingPool,
  keywordPool,
  openingPool,
  sample,
  takeRandom,
  twistPool
} from "./content.js";

let lastAIError = null;

const OPENROUTER_DEFAULT_MODEL = "openrouter/free";
const OPENROUTER_FALLBACK_MODELS = [OPENROUTER_DEFAULT_MODEL, "meta-llama/llama-3.2-3b-instruct:free"];

export async function createOpeningOptions(count = 3) {
  return createOpeningOptionsWithAI(count);
}

export async function createRequirement(roundNumber, storyText = "") {
  const aiRequirement = await generateJson({
    instructions:
      "你是多人故事接龙游戏《故事接龙工坊》的主持人。请生成一组写作要求，必须适合中文短篇悬疑/奇幻故事接龙。只输出 JSON，不要解释。",
    input: `当前轮数：${roundNumber}\n当前故事：${storyText || "故事刚开始。"}\n\n请输出 JSON：{"keyword":"一个具体名词","emotion":"一种情绪或氛围","twist":"一句剧情转折要求，以句号结尾"}`,
    fallback: null
  });

  if (
    aiRequirement &&
    typeof aiRequirement.keyword === "string" &&
    typeof aiRequirement.emotion === "string" &&
    typeof aiRequirement.twist === "string"
  ) {
    return {
      id: `req_${Math.random().toString(36).slice(2, 10)}`,
      roundNumber,
      keyword: aiRequirement.keyword.slice(0, 12),
      emotion: aiRequirement.emotion.slice(0, 12),
      twist: ensureSentence(aiRequirement.twist.slice(0, 40))
    };
  }

  return {
    id: `req_${Math.random().toString(36).slice(2, 10)}`,
    roundNumber,
    keyword: sample(keywordPool),
    emotion: sample(emotionPool),
    twist: sample(twistPool)
  };
}

export async function createBridgeSegment(storyText = "") {
  const bridge = await generateText({
    instructions:
      "你是故事接龙游戏主持人。请写一段中文过渡段，帮助玩家故事更连贯。不要结束故事，不要否定玩家设定，不要抢走主角行动权。",
    input: `当前完整故事：\n${storyText}\n\n请写 80 到 150 字的系统中间段。只输出段落正文。`,
    fallback: sample(bridgePool),
    maxOutputTokens: 220
  });
  return trimToLength(bridge, 180);
}

export async function createEndingSegment(storyText = "") {
  const ending = await generateText({
    instructions:
      "你是故事接龙游戏主持人。请根据完整故事写一个有余味的中文结尾。不要解释太多，保留一点开放感。",
    input: `完整故事：\n${storyText}\n\n请写 150 到 250 字的最终结尾。只输出结尾正文。`,
    fallback: sample(endingPool),
    maxOutputTokens: 360
  });
  return trimToLength(ending, 300);
}

async function createOpeningOptionsWithAI(count) {
  const text = await generateText({
    instructions:
      "你是故事接龙游戏主持人。请生成中文故事开头，适合多人继续创作。每个开头要有悬念，但不要过长。",
    input: `请生成 ${count} 个不同的故事开头。每行一个，不要编号，不要解释。`,
    fallback: takeRandom(openingPool, count).join("\n"),
    maxOutputTokens: 260
  });
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
    .filter(Boolean)
    .slice(0, count);
  return lines.length >= count ? lines : takeRandom(openingPool, count);
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(text) {
  return text
    .replace(/\s+/g, "")
    .replace(/([。！？!?])+/g, "$1")
    .replace(/，+/g, "，")
    .replace(/([。！？!?])，/g, "$1")
    .replace(/，([。！？!?])/g, "$1")
    .trim();
}

const emotionHints = {
  恐惧: "那股寒意顺着脊背慢慢爬上来",
  怀念: "某种久违的熟悉感忽然浮上心头",
  压抑: "空气像被什么压低了一寸",
  温暖: "这微小的安定让人暂时松了一口气",
  荒诞: "一切都不合常理，却又真实得无法反驳",
  紧张: "每一次呼吸都变得小心起来",
  孤独: "四周明明有人，却像只剩下自己",
  希望: "但那一点微弱的可能性还没有熄灭",
  混乱: "所有线索挤在一起，谁也分不清先后",
  平静: "表面的平静反而让人更难安心",
  愤怒: "压住的怒意终于在声音里露出边角",
  羞耻: "那种难堪让人几乎不敢抬头",
  惊讶: "这个答案来得太突然，没人立刻说话",
  悲伤: "沉下去的悲伤没有声音，却一直在场",
  释然: "紧绷许久的东西终于松开了一点",
  好奇: "好奇心比恐惧更早迈出一步",
  焦虑: "等待把每一秒都拖得很长",
  麻木: "他甚至来不及判断自己该有什么反应",
  兴奋: "那种危险的兴奋让人忍不住继续靠近",
  不安: "不安像细小的针，藏在每个停顿里"
};

function trimEnding(text) {
  return text.replace(/[。！？!?]+$/, "");
}

function sentenceCount(text) {
  return text.split(/[。！？!?]/).filter(Boolean).length;
}

function hasEmotionTexture(text, emotion) {
  if (!emotion) return true;
  return text.includes(emotion) || Object.values(emotionHints).some((hint) => text.includes(hint));
}

function weaveKeyword(text, keyword) {
  if (!keyword || text.includes(keyword)) return text;
  const base = trimEnding(text);
  return `${base}。直到${keyword}再次出现，所有人都意识到这不是偶然。`;
}

function weaveEmotion(text, emotion) {
  if (!emotion || hasEmotionTexture(text, emotion)) return text;
  const hint = emotionHints[emotion];
  if (!hint) return text;

  if (sentenceCount(text) <= 1) {
    return `${trimEnding(text)}，${hint}。`;
  }
  return text.replace(/([。！？!?])$/, `，${hint}$1`);
}

function weaveTwist(text, twist) {
  if (!twist) return text;
  const plainTwist = trimEnding(twist);
  let next = text;

  if (next.includes(`怎么办${plainTwist}`)) {
    next = next.replace(`怎么办${plainTwist}`, `怎么办。就在这时，${plainTwist}`);
  }
  if (next.includes(`怎么办，${plainTwist}`)) {
    next = next.replace(`怎么办，${plainTwist}`, `怎么办。就在这时，${plainTwist}`);
  }
  if (next.includes(`因为${plainTwist}`)) {
    next = next.replace(`因为${plainTwist}`, `因为他们终于明白：${plainTwist}`);
  }
  if (next.includes(`因为${twist}`)) {
    next = next.replace(`因为${twist}`, `因为他们终于明白：${twist}`);
  }
  next = next.replace(/([^，。！？!?：；])因为他们终于明白/g, "$1，因为他们终于明白");

  const twistPattern = new RegExp(`([^，。！？!?：；])${escapeRegExp(twist)}`);
  next = next.includes(twist) ? next.replace(twistPattern, `$1，${twist}`) : next;

  return next;
}

export async function polishSegment(text, requirement, storyText = "") {
  const aiPolished = await generateText({
    instructions:
      "你是故事接龙游戏里的中文编辑助手。请轻度润色玩家段落，让句子更明确、更顺、更可读。必须保留玩家原意和剧情事实，不要扩写成另一段故事，不要替玩家新增重大设定。输出润色后的段落正文即可。",
    input: `当前故事上下文：\n${storyText || "暂无。"}\n\n本轮要求：关键词「${requirement?.keyword || "无"}」，情绪「${requirement?.emotion || "无"}」，转折「${requirement?.twist || "无"}」\n\n玩家原文：\n${text}\n\n请润色为一小段中文，尽量保留原文长度，确保关键词仍然出现。`,
    fallback: "",
    maxOutputTokens: 260
  });

  if (aiPolished && (!requirement?.keyword || aiPolished.includes(requirement.keyword))) {
    return {
      original: text,
      polished: trimToLength(ensureSentence(aiPolished), 220),
      notes: [
        "使用真实 AI 做了轻度润色，保留原意和剧情方向。",
        requirement?.keyword ? `检查了本轮关键词「${requirement.keyword}」。` : "检查了本轮要求。",
        "玩家仍可选择保留原文。"
      ]
    };
  }

  let polished = normalizeText(text);
  polished = weaveTwist(polished, requirement?.twist);
  polished = weaveKeyword(polished, requirement?.keyword);
  polished = weaveEmotion(polished, requirement?.emotion);
  if (polished && !/[。！？!?]$/.test(polished)) polished += "。";

  const notes = ["做了轻度润色，让句子更顺，但保留玩家原本的剧情方向。"];
  if (requirement?.keyword) notes.push(`检查了本轮关键词「${requirement.keyword}」。`);
  if (requirement?.emotion) notes.push(`补了一点「${requirement.emotion}」的氛围质感。`);
  if (requirement?.twist) notes.push("把转折处理成更自然的停顿和推进。");

  return {
    original: text,
    polished,
    notes
  };
}

function getStoryText(room) {
  if (!room?.story) return "";
  return [room.story.openingText, ...room.story.segments.map((segment) => segment.text)].filter(Boolean).join("\n");
}

export function getRoomStoryText(room) {
  return getStoryText(room);
}

function ensureSentence(text) {
  const cleaned = String(text || "").trim().replace(/^["“”]+|["“”]+$/g, "");
  if (!cleaned) return "";
  return /[。！？!?]$/.test(cleaned) ? cleaned : `${cleaned}。`;
}

function trimToLength(text, maxLength) {
  const cleaned = String(text || "").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

async function generateJson({ instructions, input, fallback }) {
  const text = await generateText({ instructions, input, fallback: "", maxOutputTokens: 220 });
  if (!text) return fallback;
  try {
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, "").trim());
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    try {
      return JSON.parse(match[0]);
    } catch {
      return fallback;
    }
  }
}

async function generateText({ instructions, input, fallback, maxOutputTokens = 300 }) {
  const provider = getAIProvider();
  if (provider === "gemini") {
    return generateGeminiText({ instructions, input, fallback, maxOutputTokens });
  }
  if (provider === "openrouter") {
    return generateOpenRouterText({ instructions, input, fallback, maxOutputTokens });
  }
  if (provider === "openai") {
    return generateOpenAIText({ instructions, input, fallback, maxOutputTokens });
  }
  return fallback;
}

export function getAIProvider() {
  const requested = String(process.env.AI_PROVIDER || "").toLowerCase();
  if (requested === "local") return "local";
  if (requested === "gemini" && process.env.GEMINI_API_KEY) return "gemini";
  if (requested === "openrouter" && process.env.OPENROUTER_API_KEY) return "openrouter";
  if (requested === "openai" && process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OPENROUTER_API_KEY) return "openrouter";
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "local";
}

export function getAIModelName() {
  const provider = getAIProvider();
  if (provider === "gemini") return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (provider === "openrouter") return process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
  if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-5.2";
  return "local-fallback";
}

export function getAIStatusSnapshot() {
  return {
    ai: getAIProvider() !== "local",
    provider: getAIProvider(),
    model: getAIModelName(),
    lastError: lastAIError
  };
}

export async function checkAIConnection() {
  if (getAIProvider() === "local") {
    return {
      ok: false,
      ...getAIStatusSnapshot(),
      message: "No AI API key configured. Local fallback is active."
    };
  }

  lastAIError = null;
  const text = await generateText({
    instructions: "You are a connectivity checker. Reply with exactly OK.",
    input: "Reply with OK.",
    fallback: "",
    maxOutputTokens: 8
  });

  return {
    ok: /^ok\.?$/i.test(String(text).trim()),
    ...getAIStatusSnapshot(),
    sample: text || null,
    message: lastAIError ? "AI provider returned an error." : "AI provider responded."
  };
}

function recordAIError(provider, status, message) {
  lastAIError = {
    provider,
    status,
    message: String(message || "").slice(0, 500),
    at: new Date().toISOString()
  };
}

async function generateGeminiText({ instructions, input, fallback, maxOutputTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: instructions }]
          },
          contents: [
            {
              role: "user",
              parts: [{ text: input }]
            }
          ],
          generationConfig: {
            maxOutputTokens,
            temperature: 0.8
          }
        })
      }
    );

    if (!response.ok) {
      const message = await response.text();
      recordAIError("gemini", response.status, message);
      console.warn(`Gemini request failed: ${response.status} ${message}`);
      return fallback;
    }

    const data = await response.json();
    const text = extractGeminiText(data);
    if (text) lastAIError = null;
    return text || fallback;
  } catch (error) {
    recordAIError("gemini", "NETWORK", error.message);
    console.warn(`Gemini request failed: ${error.message}`);
    return fallback;
  }
}

async function generateOpenRouterText({ instructions, input, fallback, maxOutputTokens }) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const models = [
    process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL,
    ...OPENROUTER_FALLBACK_MODELS
  ].filter((model, index, all) => model && all.indexOf(model) === index);

  for (const model of models) {
    const text = await requestOpenRouterModel({ apiKey, model, instructions, input, maxOutputTokens });
    if (text) {
      lastAIError = null;
      return text;
    }
  }

  return fallback;
}

async function requestOpenRouterModel({ apiKey, model, instructions, input, maxOutputTokens }) {
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_PUBLIC_URL || "https://story-relay.onrender.com",
        "X-Title": "Story Relay"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: input }
        ],
        max_tokens: maxOutputTokens,
        temperature: 0.8
      })
    });

    if (!response.ok) {
      const message = await response.text();
      recordAIError("openrouter", response.status, `${model}: ${message}`);
      console.warn(`OpenRouter request failed for ${model}: ${response.status} ${message}`);
      return "";
    }

    const data = await response.json();
    return extractChatCompletionText(data);
  } catch (error) {
    recordAIError("openrouter", "NETWORK", `${model}: ${error.message}`);
    console.warn(`OpenRouter request failed for ${model}: ${error.message}`);
    return "";
  }
}

async function generateOpenAIText({ instructions, input, fallback, maxOutputTokens }) {
  const apiKey = process.env.OPENAI_API_KEY;
  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || "gpt-5.2",
        instructions,
        input,
        max_output_tokens: maxOutputTokens,
        store: false
      })
    });

    if (!response.ok) {
      const message = await response.text();
      recordAIError("openai", response.status, message);
      console.warn(`OpenAI request failed: ${response.status} ${message}`);
      return fallback;
    }

    const data = await response.json();
    const text = extractOutputText(data);
    if (text) lastAIError = null;
    return text || fallback;
  } catch (error) {
    recordAIError("openai", "NETWORK", error.message);
    console.warn(`OpenAI request failed: ${error.message}`);
    return fallback;
  }
}

function extractGeminiText(data) {
  const chunks = [];
  for (const candidate of data?.candidates || []) {
    for (const part of candidate.content?.parts || []) {
      if (typeof part.text === "string") chunks.push(part.text);
    }
  }
  return chunks.join("\n").trim();
}

function extractChatCompletionText(data) {
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string") return data.output_text.trim();
  const chunks = [];
  for (const item of data?.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
    }
  }
  return chunks.join("\n").trim();
}
