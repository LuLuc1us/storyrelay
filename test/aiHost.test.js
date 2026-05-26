import test from "node:test";
import assert from "node:assert/strict";
import { aiQualityGuardsForTest } from "../src/aiHost.js";

const { ensureChineseText, isMostlyChinese, isNaturalKeyword, isValidChineseOpening, sanitizePolishedSegment } =
  aiQualityGuardsForTest;

test("rejects English story openings", () => {
  assert.equal(isValidChineseOpening("The letter arrived at midnight, and everyone screamed."), false);
  assert.equal(isValidChineseOpening("凌晨三点，整座城市的钟同时停在了同一秒。"), true);
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
