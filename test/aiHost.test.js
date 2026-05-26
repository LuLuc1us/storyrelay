import test from "node:test";
import assert from "node:assert/strict";
import { aiQualityGuardsForTest, createEndingSegment } from "../src/aiHost.js";

const {
  cleanBridgeText,
  createLocalStoryTitle,
  ensureChineseText,
  emotionFitsStory,
  isBridgeUsable,
  isValidStoryTitle,
  isMostlyChinese,
  isNaturalKeyword,
  isValidChineseOpening,
  isVagueOpening,
  requirementFitsStory,
  sanitizePolishedSegment
} = aiQualityGuardsForTest;

test("rejects English story openings", () => {
  assert.equal(isValidChineseOpening("The letter arrived at midnight, and everyone screamed."), false);
  assert.equal(isValidChineseOpening("一个阴云密布的夜晚，whoever 遇到谜题。"), false);
  assert.equal(isValidChineseOpening("凌晨三点，整座城市的钟同时停在了同一秒。"), true);
});

test("rejects vague riddle-like opening templates", () => {
  assert.equal(isVagueOpening("一个阴云密布的夜晚，隐藏着某人的秘密。"), true);
  assert.equal(isVagueOpening("古老的森林中，传说有一间失落的宝藏。"), true);
  assert.equal(isVagueOpening("身在老街上的一个角落，空气中竟有一丝未解的气息。"), true);
  assert.equal(isVagueOpening("清晨的吊尺在楼里摇摇晃晃，指尖留下一道细线。"), true);
  assert.equal(isValidChineseOpening("停电后的第十分钟，楼道里的感应灯自己亮了起来。"), true);
});

test("falls back when generated text is not mostly Chinese", () => {
  const fallback = "事情没有立刻变得清楚，只是多了一种难以忽视的重量。";
  assert.equal(ensureChineseText("This is a suspenseful transition in English.", fallback), fallback);
});

test("keeps Chinese story text and removes polish explanations", () => {
  assert.equal(isMostlyChinese("镜子里多出了一封没有署名的信。", 0.7), true);
  assert.equal(
    sanitizePolishedSegment("镜子里多出了一封没有署名的信。\n\n说明：这一段更明确。"),
    "镜子里多出了一封没有署名的信。"
  );
});

test("rejects overblown bridge narration", () => {
  assert.equal(cleanBridgeText("系统中间段：那片玻璃停在桌上。"), "那片玻璃停在桌上。");
  assert.equal(isBridgeUsable("脚步声停在身后，像一把无形的钥匙在寻找另一扇门。"), false);
  assert.equal(isBridgeUsable("那片光亮安静地留在原处，把刚才发生的一切照得更清楚。可越清楚，越像有什么东西正从故事背面看回来。"), true);
});

test("keeps requirement keywords short and natural", () => {
  assert.equal(isNaturalKeyword("镜子"), true);
  assert.equal(isNaturalKeyword("一只突然出现的乌鸦"), false);
  assert.equal(isNaturalKeyword("门锁，红光"), false);
});

test("rejects requirements that drift away from the current story", () => {
  const story = "那封信没有寄件人，只有一句话：不要相信醒来后的自己。";
  assert.equal(requirementFitsStory({ keyword: "信", twist: "信里的某个细节被重新读出不同含义。" }, story), true);
  assert.equal(requirementFitsStory({ keyword: "龙骨", twist: "神秘气息让真相浮现。" }, story), false);
});

test("rejects emotions that fight the current story tone", () => {
  const story = "博物馆闭馆后，最老的一幅画开始轻轻敲玻璃。";
  assert.equal(emotionFitsStory("紧张", story, "suspense"), true);
  assert.equal(emotionFitsStory("兴奋", story, "suspense"), false);
});

test("local ending fallback uses current story details", async () => {
  const ending = await createEndingSegment(
    "那封信没有寄件人，只有一句话：不要相信醒来后的自己。\n我从信箱中拿出那封信，翻来翻去，只见一个收件人是我。瞬间警惕起来，一切都回头看。",
    "suspense"
  );
  assert.match(ending, /信|收件人|自己/);
  assert.equal(ending.includes("天亮时，一切看上去都回到了原处"), false);
});

test("local story titles use current story anchors", () => {
  const title = createLocalStoryTitle("那封信没有寄件人，只有一句话：不要相信醒来后的自己。", "suspense");
  assert.equal(isValidStoryTitle(title), true);
  assert.match(title, /信|收件人|自己/);
});
