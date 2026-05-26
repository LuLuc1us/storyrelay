import test from "node:test";
import assert from "node:assert/strict";
import { aiQualityGuardsForTest } from "../src/aiHost.js";

const {
  ensureChineseText,
  isMostlyChinese,
  isNaturalKeyword,
  isValidChineseOpening,
  isVagueOpening,
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

test("keeps requirement keywords short and natural", () => {
  assert.equal(isNaturalKeyword("镜子"), true);
  assert.equal(isNaturalKeyword("一只突然出现的乌鸦"), false);
  assert.equal(isNaturalKeyword("门锁，红光"), false);
});
