import {
  bridgePool,
  contextualBridgeBeats,
  emotionPool,
  endingPool,
  keywordPool,
  naturalKeywordPool,
  openingPool,
  sample,
  styleOpeningPools,
  styleProfiles,
  takeRandom,
  twistPool
} from "./content.js";

let lastAIError = null;
let lastGeneration = null;

const OPENROUTER_DEFAULT_MODEL = "openrouter/free";
const OPENROUTER_FALLBACK_MODELS = [OPENROUTER_DEFAULT_MODEL, "meta-llama/llama-3.2-3b-instruct:free"];
const GROQ_DEFAULT_MODEL = "llama-3.3-70b-versatile";
const CHINESE_RE = /[\u3400-\u9fff]/g;
const LATIN_RE = /[A-Za-z]/g;
const DEFAULT_AI_TIMEOUT_MS = 12000;

export async function createOpeningOptions(count = 3, storyStyle = "suspense") {
  return createOpeningOptionsWithAI(count, storyStyle);
}

export async function createStoryTitle(storyText = "", storyStyle = "suspense") {
  const style = getStyleProfile(storyStyle);
  const fallback = createLocalStoryTitle(storyText, storyStyle);
  const title = await generateText({
    action: "故事标题",
    instructions:
      `你是故事接龙游戏《故事接龙工坊》的标题编辑。当前风格：${style.label}，${style.prompt}。请给当前故事起一个简体中文标题。标题要像作品名，不要像说明句；不要用书名号；不要输出英文；不要超过10个中文字。`,
    input: `当前故事：\n${storyText || "故事刚开始。"}\n\n只输出一个中文标题，不要解释。`,
    fallback,
    maxOutputTokens: 40
  });
  const cleaned = sanitizeStoryTitle(title);
  return isValidStoryTitle(cleaned) ? cleaned : fallback;
}

export async function createRequirement(roundNumber, storyText = "", storyStyle = "suspense") {
  const style = getStyleProfile(storyStyle);
  const fallbackRequirement = createFallbackRequirement(roundNumber, storyText, storyStyle);
  const aiRequirement = await generateJson({
    action: "写作要求",
    instructions:
      `你是多人故事接龙游戏《故事接龙工坊》的主持人。请生成一组简体中文写作要求，必须接住当前故事，而不是突然换题材。当前风格：${style.label}，${style.prompt}。关键词优先取自故事里已经出现的物件、地点、人物关系或相近意象；如果故事刚开始，就选日常、自然、好写的词。转折要像一条可继续写的剧情提示，不要写晦涩谜语，不要指定违和动物、稀有物品或过于具体的道具。禁止输出英文。只输出 JSON，不要解释。`,
    input: `当前轮数：${roundNumber}\n当前故事：${storyText || "故事刚开始。"}\n\n请输出 JSON：{"keyword":"一个1到4字的中文自然关键词","emotion":"一种中文情绪或氛围","twist":"一句中文剧情转折要求，以句号结尾"}。所有字段都必须是中文。关键词要能自然放进下一段，转折要和当前故事已有线索有关。`,
    fallback: null
  });

  if (
    aiRequirement &&
    typeof aiRequirement.keyword === "string" &&
    typeof aiRequirement.emotion === "string" &&
    typeof aiRequirement.twist === "string" &&
    isMostlyChinese(aiRequirement.keyword, 0.7) &&
    isMostlyChinese(aiRequirement.emotion, 0.7) &&
    isMostlyChinese(aiRequirement.twist, 0.6) &&
    isNaturalKeyword(aiRequirement.keyword) &&
    requirementFitsStory(aiRequirement, storyText, storyStyle) &&
    emotionFitsStory(aiRequirement.emotion, storyText, storyStyle)
  ) {
    return {
      id: `req_${Math.random().toString(36).slice(2, 10)}`,
      roundNumber,
      keyword: aiRequirement.keyword.slice(0, 12),
      emotion: aiRequirement.emotion.slice(0, 12),
      twist: ensureSentence(aiRequirement.twist.slice(0, 40))
    };
  }

  return fallbackRequirement;
}

function createFallbackRequirement(roundNumber, storyText = "", storyStyle = "suspense") {
  return {
    id: `req_${Math.random().toString(36).slice(2, 10)}`,
    roundNumber,
    keyword: chooseNaturalKeyword(storyText, storyStyle),
    emotion: chooseContextualEmotion(storyText, storyStyle),
    twist: chooseContextualTwist(storyText, storyStyle)
  };
}

function chooseNaturalKeyword(storyText = "", storyStyle = "suspense") {
  const style = getStyleProfile(storyStyle);
  const present = getContextualKeywords(storyText, storyStyle);
  if (present.length) {
    const preferred = present.filter((keyword) => (contextKeywordPreference[getDominantStoryContext(storyText)] || []).includes(keyword));
    return sample((preferred.length ? preferred : present).slice(0, 3));
  }
  if (style.openingHints?.length) return sample([...naturalKeywordPool, ...style.openingHints]);
  return sample(naturalKeywordPool);
}

const contextKeywordPreference = {
  letter: ["信", "信件", "信箱", "收件人", "邮局", "明信片", "来信", "纸"],
  memory: ["照片", "旧照片", "合照", "相册", "影像", "视频", "录音", "电影", "银幕"],
  space: ["门", "房间", "地下室", "车站", "街", "地图", "钥匙", "入口", "楼道"],
  time: ["钟", "手表", "时间", "明天", "昨天", "凌晨"],
  reflection: ["镜子", "玻璃", "影子", "反光", "倒影", "画"],
  signal: ["电台", "名单", "播音", "手机", "屏幕", "档案", "系统"]
};

function getContextualKeywords(storyText = "", storyStyle = "suspense") {
  const style = getStyleProfile(storyStyle);
  const story = String(storyText || "");
  const candidates = [
    ...naturalKeywordPool,
    ...keywordPool,
    ...(style.openingHints || []),
    "信箱",
    "收件人",
    "合照",
    "同学",
    "电台",
    "名单",
    "日记",
    "录音",
    "车站",
    "灯塔",
    "抽屉",
    "箱子",
    "便利店",
    "货架"
  ];

  const anchor = pickAnchorPhrase(story);
  if (anchor && anchor.length <= 4) candidates.push(anchor);

  const discovered = [...new Set(candidates)]
    .filter((keyword) => story.includes(keyword) && isNaturalKeyword(keyword))
    .map((keyword) => ({ keyword, score: story.lastIndexOf(keyword) }))
    .sort((a, b) => b.score - a.score || b.keyword.length - a.keyword.length)
    .map((item) => item.keyword);

  return discovered;
}

function chooseContextualEmotion(storyText = "", storyStyle = "suspense") {
  const story = String(storyText || "");
  const context = getDominantStoryContext(story);
  if (context === "letter" || context === "memory") return sample(["怀念", "不安", "释然", "温暖"]);
  if (context === "space" || context === "reflection" || context === "time" || context === "signal") {
    return sample(["紧张", "恐惧", "压抑", "不安", "好奇"]);
  }
  if (storyStyle === "warm") return sample(["温暖", "怀念", "希望", "平静"]);
  if (storyStyle === "absurd") return sample(["荒诞", "混乱", "惊讶", "好奇"]);
  if (storyStyle === "fantasy") return sample(["好奇", "希望", "紧张", "惊讶"]);
  if (storyStyle === "sciFi") return sample(["不安", "好奇", "紧张", "麻木"]);
  return sample(emotionPool);
}

function emotionFitsStory(emotion = "", storyText = "", storyStyle = "suspense") {
  if (!emotion) return true;
  const allowedByStyle = {
    suspense: ["恐惧", "压抑", "紧张", "孤独", "混乱", "平静", "惊讶", "悲伤", "好奇", "焦虑", "麻木", "不安", "怀念"],
    fantasy: ["紧张", "希望", "混乱", "平静", "惊讶", "好奇", "兴奋", "不安", "温暖"],
    warm: ["怀念", "温暖", "孤独", "希望", "平静", "悲伤", "释然", "好奇", "不安"],
    absurd: ["荒诞", "混乱", "平静", "愤怒", "羞耻", "惊讶", "好奇", "焦虑", "麻木", "兴奋"],
    sciFi: ["压抑", "紧张", "孤独", "希望", "混乱", "平静", "惊讶", "好奇", "焦虑", "麻木", "不安"]
  };
  const story = String(storyText || "");
  const context = getDominantStoryContext(story);
  if (context === "letter" || context === "memory") {
    return ["怀念", "不安", "释然", "温暖", "悲伤", "平静", "孤独"].includes(emotion);
  }
  if (context === "space" || context === "reflection" || context === "time" || context === "signal") {
    return ["紧张", "恐惧", "压抑", "不安", "惊讶", "好奇", "孤独", "平静"].includes(emotion);
  }
  return (allowedByStyle[storyStyle] || emotionPool).includes(emotion);
}

function chooseContextualTwist(storyText = "", storyStyle = "suspense") {
  const story = String(storyText || "");
  const matched = [];
  const context = getDominantStoryContext(story);
  if (context === "letter") matched.push("信里的某个细节被重新读出不同含义。", "收件人发现地址并不是现在的住处。");
  if (context === "memory") matched.push("画面里一个被忽略的细节突然变得重要。", "记录里出现了没人记得说过的话。");
  if (context === "space") matched.push("原本熟悉的地点出现了不该存在的入口。", "他们发现来时的路和记忆里不一样。");
  if (context === "time") matched.push("时间顺序里出现了一个对不上的空缺。", "角色发现自己已经经历过这一刻。");
  if (context === "reflection") matched.push("倒影或影子做出了和本人不同的动作。", "一个看似普通的反光暴露了新的线索。");
  if (context === "signal") matched.push("一段记录里出现了没人记得说过的话。", "某个播报内容提前说出了下一步。");
  if (storyStyle === "warm") matched.push("一个善意的隐瞒被慢慢看见。", "旧物带出了一段被误会的往事。");
  if (storyStyle === "absurd") matched.push("所有人都把异常当成日常，只有一个人觉得不对。", "规则突然换了一种荒唐却明确的说法。");
  if (storyStyle === "fantasy") matched.push("一个不起眼的物件显出真正用途。", "前方的路回应了角色刚说出口的话。");
  if (storyStyle === "sciFi") matched.push("系统记录和角色记忆出现了细微冲突。", "一条提示来自尚未发生的时刻。");
  return sample(matched.length ? matched : twistPool);
}

function getDominantStoryContext(storyText = "") {
  const story = String(storyText || "");
  const contexts = [
    { key: "letter", words: ["信件", "那封信", "信箱", "收件人", "邮局", "明信片", "来信", "信"] },
    { key: "memory", words: ["照片", "旧照片", "合照", "相册", "影像", "视频", "录音", "电影", "银幕", "童年"] },
    { key: "space", words: ["门", "房间", "地下室", "车站", "街", "地图", "钥匙", "入口", "楼道"] },
    { key: "time", words: ["钟", "手表", "时间", "明天", "昨天", "凌晨", "重复", "十年前"] },
    { key: "reflection", words: ["镜子", "玻璃", "影子", "反光", "倒影", "画"] },
    { key: "signal", words: ["电台", "名单", "播音", "手机", "屏幕", "档案", "系统"] }
  ];

  return contexts
    .map((context) => ({
      key: context.key,
      score: Math.max(...context.words.map((word) => story.lastIndexOf(word)))
    }))
    .filter((context) => context.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.key || "";
}

function requirementFitsStory(requirement, storyText = "", storyStyle = "suspense") {
  const keyword = String(requirement.keyword || "").trim();
  const twist = String(requirement.twist || "").trim();
  if (!isNaturalKeyword(keyword)) return false;
  if (!storyText) return true;
  const style = getStyleProfile(storyStyle);
  const allowed = new Set([...naturalKeywordPool, ...keywordPool, ...(style.openingHints || []), ...getContextualKeywords(storyText, storyStyle)]);
  if (!storyText.includes(keyword) && !allowed.has(keyword)) return false;
  if (/谜题|命运|真相浮现|某种力量|未知存在|神秘气息|谁也说不清/.test(twist)) return false;
  return true;
}

function toneInstruction(tone = "balanced") {
  if (tone === "restrained") return "语气更克制，少用形容词，像清楚的叙事推进。";
  if (tone === "dramatic") return "可以更有戏剧张力，但仍然要具体，不要堆抽象比喻。";
  return "语气自然，既要有悬念，也要清楚可接。";
}

export async function createBridgeSegmentResult(storyText = "", storyStyle = "suspense", tone = "balanced") {
  const style = getStyleProfile(storyStyle);
  const fallback = createLocalBridgeFallback(storyText, storyStyle);
  const bridge = await generateText({
    action: tone === "balanced" ? "系统中间段" : `系统中间段-${tone}`,
    instructions:
      `你是故事接龙游戏主持人。当前风格：${style.label}，${style.prompt}。请用简体中文写一段过渡段，帮助玩家故事更连贯。${toneInstruction(tone)}要求：只接住最近2段的具体线索；少用抽象比喻；不要堆砌“无形、命运、世界、真相”等大词；不要结束故事，不要否定玩家设定，不要抢走主角行动权。禁止输出英文。`,
    input: `当前完整故事：\n${storyText}\n\n请写 70 到 130 个中文字的系统中间段。只输出中文段落正文，不要解释。`,
    fallback,
    maxOutputTokens: 170
  });
  const cleanedBridge = cleanBridgeText(bridge);
  const acceptedBridge = isBridgeUsable(cleanedBridge) ? cleanedBridge : fallback;
  return {
    text: trimToLength(ensureChineseText(acceptedBridge, fallback), 160),
    sourceLabel: getGenerationSourceLabel(acceptedBridge, fallback)
  };
}

export async function createBridgeSegment(storyText = "", storyStyle = "suspense") {
  return (await createBridgeSegmentResult(storyText, storyStyle)).text;
}

export async function createEndingSegmentResult(storyText = "", storyStyle = "suspense", tone = "balanced") {
  const style = getStyleProfile(storyStyle);
  const fallback = createLocalEndingFallback(storyText, storyStyle);
  const ending = await generateText({
    action: tone === "balanced" ? "系统结尾" : `系统结尾-${tone}`,
    instructions:
      `你是故事接龙游戏主持人。当前风格：${style.label}，${style.prompt}。请根据完整故事写一个有余味的简体中文结尾。${toneInstruction(tone)}不要解释太多，保留一点开放感。禁止输出英文。`,
    input: `完整故事：\n${storyText}\n\n请写 150 到 250 个中文字的最终结尾。只输出中文结尾正文，不要解释。`,
    fallback,
    maxOutputTokens: 360
  });
  return {
    text: trimToLength(ensureChineseText(ending, fallback), 300),
    sourceLabel: getGenerationSourceLabel(ending, fallback)
  };
}

export async function createEndingSegment(storyText = "", storyStyle = "suspense") {
  return (await createEndingSegmentResult(storyText, storyStyle)).text;
}

function getGenerationSourceLabel(rawText, fallback) {
  const usedProvider = getAIProvider() !== "local" && rawText && rawText !== fallback && ensureChineseText(rawText, fallback) !== fallback;
  return usedProvider ? "AI 主持人" : "工坊主持人";
}

function createLocalBridgeFallback(storyText = "", storyStyle = "suspense") {
  const story = String(storyText || "");
  const matched = contextualBridgeBeats
    .map((entry) => ({
      entry,
      score: Math.max(...entry.match.map((word) => story.lastIndexOf(word)))
    }))
    .filter((item) => item.score >= 0)
    .sort((a, b) => b.score - a.score)[0]?.entry;
  if (matched) return sample(matched.beats);

  const anchor = pickAnchorPhrase(story);
  if (anchor) {
    const styleTone = {
      suspense: `关于${anchor}的线索并没有立刻解释自己。它只是安静地留在众人之间，让每一次停顿都显得更重。下一步无论怎么选，都像会碰到某个早已等在暗处的答案。`,
      fantasy: `${anchor}像被故事轻轻点亮，露出一点原本藏住的方向。众人还没来得及弄清它真正指向哪里，周围的景象已经开始回应他们的迟疑。`,
      warm: `${anchor}让气氛慢慢安静下来。那些没说完的话并没有消失，只是换成了更柔和的形状，等着下一个人把它接住。`,
      absurd: `${anchor}暂时成为了所有人都无法忽视的问题。更麻烦的是，周围的人似乎已经接受了这一点，只有他们还在试图把事情讲明白。`,
      sciFi: `关于${anchor}的记录出现了细微偏差。偏差很小，小到几乎可以被忽略，却刚好足够证明：当前的故事并不完全属于现在。`
    };
    return styleTone[storyStyle] || styleTone.suspense;
  }

  return sample(bridgePool);
}

function cleanBridgeText(text = "") {
  return sanitizePolishedSegment(text)
    .replace(/^\s*(过渡段|系统中间段|系统段落)[:：]\s*/, "")
    .replace(/\s+/g, "")
    .trim();
}

function isBridgeUsable(text = "") {
  const cleaned = String(text || "");
  if (!isMostlyChinese(cleaned, 0.55)) return false;
  if (cleaned.length < 35 || cleaned.length > 180) return false;
  if (hasMetaExplanation(cleaned)) return false;
  if (/无形的钥匙|毫无共鸣|命运的齿轮|真相终于浮现|世界的背面|某种不可名状|无法言说的力量/.test(cleaned)) {
    return false;
  }
  return true;
}

function createLocalEndingFallback(storyText = "", storyStyle = "suspense") {
  const style = getStyleProfile(storyStyle);
  const sentences = extractStorySentences(storyText);
  const last = sentences.at(-1) || "故事停在了一个尚未说完的瞬间。";
  const previous = sentences.at(-2) || sentences.at(0) || "";
  const anchor = pickAnchorPhrase(storyText) || pickAnchorPhrase(last) || pickAnchorPhrase(previous) || "那件事";

  if (!sentences.length) return sample(endingPool);

  const styleClose = {
    suspense: `后来，${anchor}没有再被任何人主动提起。可每当相似的声音在夜里响起，他们都会想起最后那一刻：${trimEnding(last)}。答案也许已经出现过，只是没人敢把它念完。`,
    fantasy: `他们最终离开了那里，却没有真正告别${anchor}。临走前，最后的线索安静地留在原处，像一扇没有关严的门。若有人再次沿着这段故事走下去，也许会发现，结局只是另一条路的开端。`,
    warm: `很久以后，${anchor}仍被他们记得。那些紧张和误会慢慢沉下来，只剩下最后那个片刻：${trimEnding(last)}。故事没有给出所有答案，却让每个人都带走了一点可以继续生活的光。`,
    absurd: `事情就这样暂时结束了，虽然没人能完全解释${anchor}到底算什么。大家试着把一切当成普通的一天，可最后那句话总会在不合时宜的时候冒出来。于是他们明白，故事只是学会了换一种方式继续。`,
    sciFi: `系统记录在这里中断，关于${anchor}的解释没有被保存。多年后，有人重新打开那份残缺档案，只看到最后一行仍在闪烁：${trimEnding(last)}。它不像答案，更像一次尚未完成的回信。`
  };

  return styleClose[storyStyle] || styleClose.suspense;
}

async function createOpeningOptionsWithAI(count, storyStyle = "suspense") {
  const style = getStyleProfile(storyStyle);
  const fallbackOptions = takeRandom(styleOpeningPools[storyStyle] || openingPool, count);
  const text = await generateText({
    action: "故事开头",
    instructions:
      `你是故事接龙游戏主持人。当前风格：${style.label}，${style.prompt}。请生成简体中文故事开头，适合多人继续创作。每个开头必须是具体场景陈述句，有清楚的人、地点、物件或事件。不要写成谜语、宣传语、问题、设定简介或“一个……的……”模板。禁止输出英文、拼音和任何拉丁字母。`,
    input: `请生成 ${count} 个不同的中文故事开头。每行一个，不要编号，不要解释，不要英文。句式要多样，尽量像“凌晨三点，整座城市的钟同时停在了同一秒。”这种具体陈述句。`,
    fallback: fallbackOptions.join("\n"),
    maxOutputTokens: 260
  });
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^[-*\d.、\s]+/, "").trim())
    .filter((line) => isValidChineseOpening(line))
    .slice(0, count);
  return lines.length >= count ? lines : fallbackOptions;
}

function getStyleProfile(storyStyle = "suspense") {
  return styleProfiles[storyStyle] || styleProfiles.suspense;
}

function createLocalStoryTitle(storyText = "", storyStyle = "suspense") {
  const anchor = getContextualKeywords(storyText, storyStyle)[0] || pickAnchorPhrase(storyText);
  if (anchor) {
    const patterns = {
      suspense: [`${anchor}之后`, `${anchor}回声`, `${anchor}背面`, `${anchor}未寄`],
      fantasy: [`${anchor}之路`, `${anchor}尽头`, `${anchor}与门`, `${anchor}远行`],
      warm: [`${anchor}小事`, `${anchor}余温`, `${anchor}来信`, `${anchor}仍在`],
      absurd: [`${anchor}通知`, `${anchor}今日`, `${anchor}交错`, `${anchor}请确认`],
      sciFi: [`${anchor}偏差`, `${anchor}记录`, `${anchor}回路`, `${anchor}未同步`]
    };
    return sample(patterns[storyStyle] || patterns.suspense).slice(0, 10);
  }

  return {
    suspense: "未寄之夜",
    fantasy: "雾后车站",
    warm: "旧信仍暖",
    absurd: "星期三上交",
    sciFi: "明日回声"
  }[storyStyle] || "故事接龙";
}

function sanitizeStoryTitle(title = "") {
  return String(title || "")
    .trim()
    .replace(/^["“”《]+|["“”》]+$/g, "")
    .replace(/^标题[:：]\s*/, "")
    .replace(/[。！？!?，,：:；;\s]/g, "")
    .slice(0, 12);
}

function isValidStoryTitle(title = "") {
  const cleaned = String(title || "");
  return cleaned.length >= 2 && cleaned.length <= 10 && isMostlyChinese(cleaned, 0.75) && !hasMetaExplanation(cleaned);
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

function extractStorySentences(storyText = "") {
  return String(storyText || "")
    .split(/(?<=[。！？!?])|\n+/)
    .map((line) => line.replace(/^>+\s*/, "").trim())
    .filter((line) => isMostlyChinese(line, 0.45) && line.length >= 6)
    .slice(-8);
}

function pickAnchorPhrase(text = "") {
  const cleaned = String(text || "").replace(/[“”"'\s]/g, "");
  const directAnchor = cleaned.match(/那封信|收件人|自己|日记|镜子|那扇门|旧照片|声音|名单|车站|手表|地图|钥匙|房间|城市/);
  if (directAnchor) return directAnchor[0];

  const strongPhrases = cleaned.match(/[\u4e00-\u9fff]{2,8}(信|日记|镜子|门|照片|声音|名单|车站|手表|地图|钥匙|房间|城市|收件人|自己)/g);
  if (strongPhrases?.length) return strongPhrases[0].replace(/^(只有|只见|一个|那位|这个|那个)/, "").slice(-8);

  const words = cleaned.match(/[\u4e00-\u9fff]{2,6}/g) || [];
  return words.find((word) => !/他们|我们|一切|故事|后来|最后|只是|没有|那个|这个/.test(word)) || "";
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

export async function polishSegment(text, requirement, storyText = "", maxLength = 220) {
  const aiPolished = await generateText({
    action: "段落润色",
    instructions:
      "你是故事接龙游戏里的中文编辑助手。玩家原文可能来自语音识别，可能有错字、断句错误、同音误识别或表达含混。请先根据上下文理解玩家想表达的剧情，再把它整理成更明确、更顺、更可读的一小段中文。必须保留玩家原意、人物行动和剧情事实，不要扩写成另一段故事，不要替玩家新增重大设定。只输出润色后的段落正文，不要写标题、解释、评价、理由、项目符号或修改说明。",
    input: `当前故事上下文：\n${storyText || "暂无。"}\n\n本轮要求：关键词「${requirement?.keyword || "无"}」，情绪「${requirement?.emotion || "无"}」，转折「${requirement?.twist || "无"}」\n\n玩家原文：\n${text}\n\n请先理解原意，再整理为一小段中文。长度尽量接近原文，确保关键词仍然出现。`,
    fallback: "",
    maxOutputTokens: 260
  });

  const cleanedAIPolished = sanitizePolishedSegment(aiPolished);
  if (
    cleanedAIPolished &&
    isMostlyChinese(cleanedAIPolished, 0.45) &&
    (!requirement?.keyword || cleanedAIPolished.includes(requirement.keyword))
  ) {
    return {
      original: text,
      polished: trimToLength(ensureSentence(cleanedAIPolished), maxLength),
      source: "AI 主持人",
      sourceLabel: "AI 主持人",
      notes: [
        "AI 主持人先按上下文理解原意，再做了轻度润色。",
        requirement?.keyword ? `检查了本轮关键词「${requirement.keyword}」。` : "检查了本轮要求。",
        "玩家仍可选择保留原文。"
      ]
    };
  }

  let polished = normalizeText(repairDictationText(text, requirement, storyText));
  polished = weaveTwist(polished, requirement?.twist);
  polished = weaveKeyword(polished, requirement?.keyword);
  polished = weaveEmotion(polished, requirement?.emotion);
  if (polished && !/[。！？!?]$/.test(polished)) polished += "。";

  const notes = ["工坊主持人做了基础整理，让句子更顺，并尽量保留玩家原本的剧情方向。"];
  if (requirement?.keyword) notes.push(`检查了本轮关键词「${requirement.keyword}」。`);
  if (requirement?.emotion) notes.push(`补了一点「${requirement.emotion}」的氛围质感。`);
  if (requirement?.twist) notes.push("把转折处理成更自然的停顿和推进。");

  return {
    original: text,
    polished: trimToLength(polished, maxLength),
    source: "工坊主持人",
    sourceLabel: "工坊主持人",
    notes
  };
}

function repairDictationText(text = "", requirement, storyText = "") {
  const classifiers = {
    玻璃: "一片玻璃",
    镜子: "一面镜子",
    照片: "一张照片",
    旧照片: "一张旧照片",
    信: "一封信",
    信件: "一封信件",
    钥匙: "一把钥匙",
    地图: "一张地图",
    纸: "一张纸",
    书: "一本书",
    日记: "一本日记",
    手表: "一块手表",
    录音: "一段录音",
    门锁: "一只门锁",
    书页: "一页书页"
  };
  let repaired = String(text || "");
  for (const [word, phrase] of Object.entries(classifiers)) {
    repaired = repaired.replace(new RegExp(`(拿出|捡起|发现|看到)${escapeRegExp(word)}`, "g"), `$1${phrase}`);
  }

  if (requirement?.keyword && !repaired.includes(requirement.keyword)) {
    const anchor = pickAnchorPhrase(storyText);
    if (anchor && anchor.includes(requirement.keyword)) repaired += ` ${requirement.keyword}`;
  }

  return repaired
    .replace(/翻来翻去/g, "反复翻看")
    .replace(/回头看/g, "回头确认")
    .replace(/不知道为什么/g, "说不清原因")
    .replace(/那个东西/g, "那件东西");
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

function chineseRatio(text) {
  const cleaned = String(text || "").replace(/\s+/g, "");
  const chineseCount = (cleaned.match(CHINESE_RE) || []).length;
  const latinCount = (cleaned.match(LATIN_RE) || []).length;
  const signalCount = chineseCount + latinCount;
  if (!signalCount) return 0;
  return chineseCount / signalCount;
}

function isMostlyChinese(text, minimumRatio = 0.5) {
  const cleaned = String(text || "").trim();
  return Boolean(cleaned) && chineseRatio(cleaned) >= minimumRatio;
}

function hasMetaExplanation(text) {
  return /^(Here|Sure|Okay|The|This)\b/i.test(String(text || "").trim()) || /润色说明|修改说明|优化说明/.test(text);
}

function ensureChineseText(text, fallback) {
  const cleaned = sanitizePolishedSegment(text);
  if (isMostlyChinese(cleaned, 0.45) && !hasMetaExplanation(cleaned)) return cleaned;
  return fallback;
}

function isValidChineseOpening(text) {
  const cleaned = String(text || "").trim();
  if (cleaned.length < 12 || cleaned.length > 90) return false;
  if ((cleaned.match(LATIN_RE) || []).length > 0) return false;
  if (!isMostlyChinese(cleaned, 0.55)) return false;
  if (hasMetaExplanation(cleaned)) return false;
  if (isVagueOpening(cleaned)) return false;
  return true;
}

function isVagueOpening(text) {
  return [
    /^一个[^，。！？]{0,18}的[^，。！？]{1,18}[，。]/,
    /^一段[^，。！？]{0,18}的/,
    /^某个/,
    /^某种/,
    /^某人/,
    /^传说有/,
    /^古老的[^，。！？]{0,12}中，传说/,
    /^身在/,
    /whoever/i,
    /遇到谜题/,
    /等待着某人的发现/,
    /失落的宝藏/,
    /未解的气息/,
    /陈旧的钟声/,
    /吊尺/,
    /指尖留下一道细线/,
    /一个角落/,
    /偏远村落的房屋窗户/
  ].some((pattern) => pattern.test(text));
}

function isNaturalKeyword(keyword) {
  const cleaned = String(keyword || "").trim();
  if (cleaned.length < 1 || cleaned.length > 4) return false;
  if (/[，。！？、；：\s]/.test(cleaned)) return false;
  if (/^(一个|一位|一只|一种|某个|那个|这个|所有|最后|正在|突然)/.test(cleaned)) return false;
  if (/(之后|以前|之前|时候|当时|后来|以内|之外|之中|之下|之上|里面|外面|黑暗中|沉默中|下车后|醒来后)$/.test(cleaned)) return false;
  if (/(看到|发现|走进|推开|下车|恢复|变成|正在|等待|藏着|听见)$/.test(cleaned)) return false;
  return true;
}

export const aiQualityGuardsForTest = {
  cleanBridgeText,
  createLocalStoryTitle,
  ensureChineseText,
  emotionFitsStory,
  isBridgeUsable,
  isValidStoryTitle,
  isMostlyChinese,
  isValidChineseOpening,
  isVagueOpening,
  isNaturalKeyword,
  requirementFitsStory,
  sanitizePolishedSegment
};

function sanitizePolishedSegment(text) {
  let cleaned = String(text || "")
    .trim()
    .replace(/^```(?:text|markdown|md)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();

  if (!cleaned) return "";

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      cleaned = String(parsed.polished || parsed.text || parsed.result || cleaned).trim();
    } catch {
      // Keep the raw text when the model returned prose that merely contains braces.
    }
  }

  cleaned = cleaned
    .split(/\n{2,}/)[0]
    .replace(/^润色(?:后|版|结果)?[:：]\s*/i, "")
    .replace(/^正文[:：]\s*/i, "")
    .trim();

  const explanationMarkers = [
    "\n说明",
    "\n理由",
    "\n为什么",
    "\n修改",
    "\n评价",
    "\n这段",
    "\n这一段",
    "\n注：",
    "\n注:",
    "这一段非常好",
    "这段非常好",
    "这一版",
    "这个版本",
    "这一段润色",
    "这段润色",
    "这段文字",
    "这样润色",
    "润色说明",
    "修改说明",
    "优化说明",
    "因为这样",
    "这样写"
  ];

  for (const marker of explanationMarkers) {
    const index = cleaned.indexOf(marker);
    if (index > 0) cleaned = cleaned.slice(0, index).trim();
  }

  return cleaned
    .replace(/^[-*•]\s*/, "")
    .replace(/^["“”]+|["“”]+$/g, "")
    .trim();
}

async function generateJson({ action = "JSON 生成", instructions, input, fallback }) {
  const text = await generateText({ action, instructions, input, fallback: "", maxOutputTokens: 220 });
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

async function generateText({ action = "AI 生成", instructions, input, fallback, maxOutputTokens = 300, providerOverride = "" }) {
  const providers = getAIProviderChain(providerOverride);
  const started = Date.now();

  for (const provider of providers) {
    const text = await generateProviderText(provider, { instructions, input, fallback: "", maxOutputTokens });
    if (text) {
      recordGeneration({
        action,
        provider,
        model: getAIModelName(provider),
        durationMs: Date.now() - started,
        usedFallback: false,
        ok: true
      });
      return text;
    }
  }

  recordGeneration({
    action,
    provider: providers.length ? providers.join(" -> ") : "local",
    model: providers.length ? providers.map((provider) => getAIModelName(provider)).join(" -> ") : "local-fallback",
    durationMs: Date.now() - started,
    usedFallback: true,
    ok: false
  });
  return fallback;
}

async function generateProviderText(provider, options) {
  if (provider === "gemini") return generateGeminiText(options);
  if (provider === "openrouter") return generateOpenRouterText(options);
  if (provider === "groq") return generateGroqText(options);
  if (provider === "openai") return generateOpenAIText(options);
  return "";
}

export function getAIProvider() {
  return getAIProviderChain()[0] || "local";
}

function getAIProviderChain(providerOverride = "") {
  const override = String(providerOverride || "").toLowerCase();
  const requested = String(process.env.AI_PROVIDER || "").toLowerCase();
  if (requested === "local" && !override) return [];

  const configuredProviders = {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY)
  };
  const defaultOrder = ["openrouter", "groq", "gemini", "openai"];
  const requestedOrder = process.env.AI_FALLBACK_PROVIDERS
    ? String(process.env.AI_FALLBACK_PROVIDERS)
        .split(",")
        .map((provider) => provider.trim().toLowerCase())
        .filter(Boolean)
    : defaultOrder;
  const ordered = [];

  if (configuredProviders[override]) ordered.push(override);
  if (configuredProviders[requested]) ordered.push(requested);
  for (const provider of requestedOrder) {
    if (configuredProviders[provider] && !ordered.includes(provider)) ordered.push(provider);
  }
  for (const provider of defaultOrder) {
    if (configuredProviders[provider] && !ordered.includes(provider)) ordered.push(provider);
  }

  return ordered;
}

export function getAIModelName(provider = getAIProvider()) {
  if (provider === "gemini") return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  if (provider === "openrouter") return process.env.OPENROUTER_MODEL || OPENROUTER_DEFAULT_MODEL;
  if (provider === "groq") return process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
  if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-5.2";
  return "local-fallback";
}

export function getAIStatusSnapshot() {
  const providers = getAIProviderChain();
  return {
    ai: providers.length > 0,
    provider: providers[0] || "local",
    fallbackProviders: providers.slice(1),
    model: providers.length ? providers.map((provider) => getAIModelName(provider)).join(" -> ") : "local-fallback",
    timeoutMs: getAITimeoutMs(),
    lastError: lastAIError,
    lastGeneration
  };
}

export async function checkAIConnection(providerOverride = "") {
  const providers = getAIProviderChain(providerOverride);
  if (!providers.length) {
    return {
      ok: false,
      ...getAIStatusSnapshot(),
      message: "No AI API key configured. Local fallback is active."
    };
  }

  lastAIError = null;
  const text = await generateText({
    action: "AI 连通检查",
    instructions: "You are a connectivity checker. Reply with exactly OK.",
    input: "Reply with OK.",
    fallback: "",
    maxOutputTokens: 8,
    providerOverride
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

function recordGeneration({ action, provider, model, durationMs, usedFallback, ok }) {
  lastGeneration = {
    action,
    provider,
    model,
    durationMs,
    sourceLabel: usedFallback ? "工坊主持人" : "AI 主持人",
    usedFallback,
    ok,
    at: new Date().toISOString()
  };
}

function getAITimeoutMs() {
  const configured = Number(process.env.AI_TIMEOUT_MS || DEFAULT_AI_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return DEFAULT_AI_TIMEOUT_MS;
  return Math.min(30000, Math.max(3000, configured));
}

async function fetchWithTimeout(url, options = {}, label = "AI request") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`${label} timed out after ${getAITimeoutMs()}ms`)), getAITimeoutMs());
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function generateGeminiText({ instructions, input, fallback, maxOutputTokens }) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  try {
    const response = await fetchWithTimeout(
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
      },
      "Gemini"
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

async function generateGroqText({ instructions, input, fallback, maxOutputTokens }) {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || GROQ_DEFAULT_MODEL;
  try {
    const response = await fetchWithTimeout("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: instructions },
          { role: "user", content: input }
        ],
        max_completion_tokens: maxOutputTokens,
        temperature: 0.8
      })
    }, `Groq ${model}`);

    if (!response.ok) {
      const message = await response.text();
      recordAIError("groq", response.status, `${model}: ${message}`);
      console.warn(`Groq request failed for ${model}: ${response.status} ${message}`);
      return fallback;
    }

    const data = await response.json();
    const text = extractChatCompletionText(data);
    if (text) lastAIError = null;
    return text || fallback;
  } catch (error) {
    recordAIError("groq", "NETWORK", `${model}: ${error.message}`);
    console.warn(`Groq request failed for ${model}: ${error.message}`);
    return fallback;
  }
}

async function requestOpenRouterModel({ apiKey, model, instructions, input, maxOutputTokens }) {
  try {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
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
    }, `OpenRouter ${model}`);

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
    const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
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
    }, "OpenAI");

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
