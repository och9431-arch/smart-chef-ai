import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const PRIMARY_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";
const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "gemini-3.5-flash-lite";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    provider: "Google Gemini",
    primaryModel: PRIMARY_MODEL,
    fallbackModel: FALLBACK_MODEL,
    apiKeyConfigured: Boolean(process.env.GEMINI_API_KEY),
    version: "mealkit-v4.4-final"
  });
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function cleanIngredients(items = []) {
  return items.slice(0, 30).map(item => ({
    name: String(item?.name || "").slice(0, 60),
    quantity: Math.max(0, Number(item?.quantity || 0)),
    unit: item?.unit === "kg" ? "kg" : "g",
    purchaseDate: String(item?.purchaseDate || "").slice(0, 10)
  })).filter(item => item.name && item.quantity > 0 && /^\d{4}-\d{2}-\d{2}$/.test(item.purchaseDate));
}

const recipeSchema = {
  type: "object",
  properties: {
    mealkit: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        totalServings: { type: "number" },
        components: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              amount: { type: "number" },
              unit: { type: "string" },
              prep: { type: "string" }
            },
            required: ["name","amount","unit","prep"]
          }
        },
        allocation: {
          type: "array",
          items: {
            type: "object",
            properties: {
              group: { type: "string" },
              count: { type: "number" },
              amount: { type: "number" },
              unit: { type: "string" }
            },
            required: ["group","count","amount","unit"]
          }
        },
        baseSteps: {
          type: "array",
          items: { type: "string" }
        },
        storageLife: { type: "string" },
        ingredientStorage: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              storageLife: { type: "string" },
              note: { type: "string" }
            },
            required: ["name","storageLife","note"]
          }
        }
      },
      required: [
        "name","description","totalServings","components",
        "allocation","baseSteps","storageLife","ingredientStorage"
      ]
    },
    recipes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          summary: { type: "string" },
          cookTime: { type: "string" },
          ingredients: {
            type: "array",
            items: { type: "string" }
          },
          extraIngredients: {
            type: "array",
            items: { type: "string" }
          },
          steps: {
            type: "array",
            items: { type: "string" }
          },
          childTip: { type: "string" },
          adultFinish: { type: "string" },
          nutrition: { type: "string" },
          safetyNote: { type: "string" }
        },
        required: [
          "name","summary","cookTime","ingredients",
          "extraIngredients","steps","childTip",
          "adultFinish","nutrition","safetyNote"
        ]
      }
    }
  },
  required: ["mealkit","recipes"]
};

function extractText(raw) {
  return raw?.candidates?.[0]?.content?.parts
    ?.map(part => part?.text || "")
    .join("\n")
    .trim() || "";
}

function parseRecipeJSON(text) {
  const stripped = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "");

  const first = stripped.indexOf("{");
  const last = stripped.lastIndexOf("}");
  const candidate = first >= 0 && last > first
    ? stripped.slice(first, last + 1)
    : stripped;

  const parsed = JSON.parse(candidate);

  if (!parsed || !parsed.mealkit || !Array.isArray(parsed.recipes)) {
    throw new Error("Gemini가 밀키트 또는 recipes 배열을 반환하지 않았습니다.");
  }

  const recipes = parsed.recipes.slice(0, 3).map((r, index) => ({
    name: String(r?.name || `추천 메뉴 ${index + 1}`),
    summary: String(r?.summary || ""),
    cookTime: String(r?.cookTime || "약 20분"),
    ingredients: Array.isArray(r?.ingredients) ? r.ingredients.map(String) : [],
    extraIngredients: Array.isArray(r?.extraIngredients) ? r.extraIngredients.map(String) : [],
    steps: Array.isArray(r?.steps) ? r.steps.map(String) : [],
    childTip: String(r?.childTip || ""),
    adultFinish: String(r?.adultFinish || ""),
    nutrition: String(r?.nutrition || ""),
    safetyNote: String(r?.safetyNote || "")
  }));

  if (recipes.length !== 3) {
    throw new Error("Gemini가 메뉴를 3개 모두 생성하지 못했습니다.");
  }

  const mealkit = {
    name: String(parsed.mealkit?.name || "우리집 기본 밀키트"),
    description: String(parsed.mealkit?.description || ""),
    totalServings: Number(parsed.mealkit?.totalServings || 0),
    components: Array.isArray(parsed.mealkit?.components) ? parsed.mealkit.components : [],
    allocation: Array.isArray(parsed.mealkit?.allocation) ? parsed.mealkit.allocation : [],
    baseSteps: Array.isArray(parsed.mealkit?.baseSteps) ? parsed.mealkit.baseSteps.map(String) : [],
    storageLife: String(parsed.mealkit?.storageLife || ""),
    ingredientStorage: Array.isArray(parsed.mealkit?.ingredientStorage)
      ? parsed.mealkit.ingredientStorage.map(item => ({
          name: String(item?.name || ""),
          storageLife: String(item?.storageLife || ""),
          note: String(item?.note || "")
        }))
      : []
  };

  return { mealkit, recipes };
}


function toGrams(amount, unit) {
  const n = Number(amount || 0);
  return unit === "kg" ? n * 1000 : n;
}

function fromGrams(grams, preferredUnit = "g") {
  if (preferredUnit === "kg") {
    return { amount: Number((grams / 1000).toFixed(3)), unit: "kg" };
  }
  return { amount: Number(grams.toFixed(1)), unit: "g" };
}


function normalizeIngredientName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[()[\]{}]/g, "");
}

function resolveInventoryItem(componentName, ingredients) {
  const normalized = normalizeIngredientName(componentName);

  const exact = ingredients.find(
    item => normalizeIngredientName(item.name) === normalized
  );
  if (exact) return exact;

  const candidates = ingredients.filter(item => {
    const n = normalizeIngredientName(item.name);
    return n.includes(normalized) || normalized.includes(n);
  });

  return candidates.length === 1 ? candidates[0] : null;
}

function validateAndEnrichResult(result, ingredients, familyCounts) {
  if (!result?.mealkit || !Array.isArray(result?.recipes) || result.recipes.length !== 3) {
    const error = new Error("AI 결과에 밀키트 또는 추천 메뉴 3개가 없습니다.");
    error.status = 502;
    throw error;
  }

  const totalPeople = Object.values(familyCounts)
    .reduce((sum, n) => sum + Number(n || 0), 0);

  if (Number(result.mealkit.totalServings) !== totalPeople) {
    const error = new Error(
      `밀키트 인원 계산이 맞지 않습니다. 요청 ${totalPeople}명 / AI ${result.mealkit.totalServings}명`
    );
    error.status = 502;
    throw error;
  }

  const inventory = ingredients.map(item => ({
    ...item,
    grams: toGrams(item.quantity, item.unit)
  }));

  if (!Array.isArray(result.mealkit.components) || result.mealkit.components.length < 2) {
    const error = new Error("밀키트 구성 재료가 충분하지 않습니다.");
    error.status = 502;
    throw error;
  }

  const usedNames = new Set();

  result.mealkit.components = result.mealkit.components.map(component => {
    const aiName = String(component?.name || "").trim();
    const inv = resolveInventoryItem(aiName, inventory);

    if (!inv) {
      const error = new Error(
        `밀키트에 냉장고 재료와 매칭되지 않는 "${aiName}"이 포함되었습니다.`
      );
      error.status = 502;
      throw error;
    }

    const name = inv.name;
    const normalizedName = normalizeIngredientName(name);

    if (usedNames.has(normalizedName)) {
      const error = new Error(`밀키트에 "${name}" 재료가 중복되었습니다.`);
      error.status = 502;
      throw error;
    }
    usedNames.add(normalizedName);

    const usedGrams = toGrams(component.amount, component.unit);
    if (!Number.isFinite(usedGrams) || usedGrams <= 0) {
      const error = new Error(`"${name}" 사용량이 올바르지 않습니다.`);
      error.status = 502;
      throw error;
    }

    if (usedGrams > inv.grams + 0.001) {
      const error = new Error(
        `"${name}" 사용량이 보유량을 초과했습니다. 보유 ${inv.quantity}${inv.unit}, 제안 ${component.amount}${component.unit}`
      );
      error.status = 502;
      throw error;
    }

    const remainingGrams = Math.max(0, inv.grams - usedGrams);
    const remaining = fromGrams(remainingGrams, inv.unit);

    return {
      name,
      amount: Number(component.amount),
      unit: component.unit === "kg" ? "kg" : "g",
      prep: String(component.prep || ""),
      inventoryAmount: inv.quantity,
      inventoryUnit: inv.unit,
      remainingAmount: remaining.amount,
      remainingUnit: remaining.unit
    };
  });

  const expectedGroups = Object.entries(familyCounts)
    .filter(([, count]) => Number(count) > 0);

  const allocations = Array.isArray(result.mealkit.allocation)
    ? result.mealkit.allocation
    : [];

  for (const [group, count] of expectedGroups) {
    const found = allocations.find(a => String(a?.group || "") === group);
    if (!found || Number(found.count) !== Number(count)) {
      const error = new Error(
        `${group} 인원 배분이 맞지 않습니다. 요청 ${count}명`
      );
      error.status = 502;
      throw error;
    }
  }

  result.mealkit.allocation = allocations.filter(a =>
    expectedGroups.some(([group]) => group === String(a?.group || ""))
  );

  if (!Array.isArray(result.mealkit.baseSteps) || result.mealkit.baseSteps.length < 3) {
    const error = new Error("밀키트 준비 단계가 충분하지 않습니다.");
    error.status = 502;
    throw error;
  }

  const kitNames = result.mealkit.components.map(c => c.name);
  result.recipes = result.recipes.map((recipe, index) => {
    const refs = Array.isArray(recipe.ingredients) ? recipe.ingredients.map(String) : [];
    const linked = refs.some(text => kitNames.some(name => text.includes(name)));
    if (!linked) {
      const error = new Error(
        `추천 메뉴 ${index + 1}이 기본 밀키트 구성과 연결되지 않았습니다.`
      );
      error.status = 502;
      throw error;
    }
    return recipe;
  });

  if (!Array.isArray(result.mealkit.ingredientStorage)) {
    const error = new Error("재료별 보관기한 정보가 없습니다.");
    error.status = 502;
    throw error;
  }

  const normalizedStorage = [];
  for (const ingredient of ingredients) {
    const storage = result.mealkit.ingredientStorage.find(item =>
      normalizeIngredientName(item?.name) === normalizeIngredientName(ingredient.name)
    );

    if (!storage || !String(storage.storageLife || "").trim()) {
      const error = new Error(
        `"${ingredient.name}"의 보관기한 정보가 누락되었습니다.`
      );
      error.status = 502;
      throw error;
    }

    normalizedStorage.push({
      name: ingredient.name,
      storageLife: String(storage.storageLife || ""),
      note: String(storage.note || "")
    });
  }

  result.mealkit.ingredientStorage = normalizedStorage;

  if (!String(result.mealkit.storageLife || "").trim()) {
    const error = new Error("밀키트 보관기한 정보가 누락되었습니다.");
    error.status = 502;
    throw error;
  }

  return result;
}

function makePrompt({ today, ingredients, familyCounts, style, goal }) {
  const totalPeople = Object.values(familyCounts).reduce((a, b) => a + Number(b || 0), 0);

  return `
당신은 한국 가정식, 가족 식단, 식재료 보관, 식재료 소분 및 밀키트 설계 전문가입니다.
오늘은 ${today}(한국 시간)입니다.

[앱의 핵심 목적]
사용자는 재료명과 현재 보유량만 입력합니다.
당신은 이 정보를 바탕으로:
1) 각 재료의 일반적인 냉장 보관 권장기한을 추정하고,
2) 기본 밀키트 1개를 설계하며,
3) 그 밀키트의 권장 냉장 보관기한을 추정하고,
4) 그 밀키트를 기반으로 추천 메뉴 3개를 만듭니다.

[냉장고 재료 및 현재 보유량]
${ingredients.map(x => {
  const purchased = new Date(`${x.purchaseDate}T00:00:00`);
  const todayDate = new Date(`${today}T00:00:00`);
  const ageDays = Math.max(0, Math.floor((todayDate - purchased) / 86400000));
  return `- ${x.name} | 보유량 ${x.quantity}${x.unit} | 구입일 ${x.purchaseDate} | 구입 후 약 ${ageDays}일 경과`;
}).join("\n")}

[가족 구성]
- 영아: ${familyCounts["영아"] || 0}명
- 유아: ${familyCounts["유아"] || 0}명
- 어린이: ${familyCounts["어린이"] || 0}명
- 성인: ${familyCounts["성인"] || 0}명
- 노인: ${familyCounts["노인"] || 0}명
- 총 인원: ${totalPeople}명

[희망 스타일]
${style}

[우선 목표]
${goal}

[밀키트 설계 원칙]
1. 냉장고에 실제 보유한 재료, 용량, 구입일자를 우선 활용합니다.
2. 구입일자와 일반적인 식품 보관 특성을 함께 고려해 오래된 재료부터 우선 사용하는 것이 합리적인지 판단합니다.
3. 구입일자가 오래되었다고 해서 안전하다고 단정하지 말고, 상태·포장·개봉 여부를 함께 확인해야 한다는 주의사항을 반영합니다.
3. 밀키트는 추천 메뉴 3개의 공통 바탕이 되는 기본 재료 세트여야 합니다.
4. 밀키트 components의 name은 반드시 위 냉장고 재료명을 글자 그대로 사용합니다.
5. 각 재료의 정확한 사용량(amount)과 단위(unit)를 기록합니다.
6. 냉장고 보유량을 초과하면 안 됩니다.
7. kg 재료는 필요하면 g 기준으로 환산하여 계산합니다.
8. 가족의 연령대별 인원 수를 고려해 전체 사용량과 배분량을 현실적으로 설정합니다.
9. 영아·유아는 성인과 동일한 양으로 계산하지 않습니다.
10. 노인은 질기거나 지나치게 자극적인 조리를 피하고 부드러운 조리 가능성을 고려합니다.
11. allocation에는 인원이 1명 이상인 그룹만 넣습니다.
12. baseSteps에는 밀키트를 미리 손질·소분하는 상세한 준비법을 3~6단계로 씁니다.
13. storageLife에는 "냉장 보관 기준 권장 사용기한"을 보수적으로 추정해 자연어로 적습니다. 예: "냉장 1~2일 이내 사용 권장".
14. ingredientStorage에는 입력된 모든 재료를 빠짐없이 포함합니다.
15. ingredientStorage 각 항목은 name, storageLife, note로 구성합니다.
16. name은 사용자가 입력한 재료명을 그대로 사용합니다.
17. storageLife에는 오늘 날짜와 구입일자를 함께 고려한 "지금부터의 권장 사용기간"을 적습니다. 예: "가능하면 1~2일 이내 사용 권장".
18. note에는 "구입 후 약 N일 경과" 여부와 함께 개봉 여부, 포장 상태, 냄새·색·점액 등 실제 상태 확인이 필요하다는 짧은 주의사항을 적습니다.
19. 보관기한은 절대적인 안전 보증이 아니라 구입일자와 일반적인 보관 특성을 바탕으로 한 보수적 추정치임을 반영합니다.

[추천 메뉴 원칙]
1. 추천 메뉴 3개는 반드시 위 기본 밀키트를 기반으로 합니다.
2. 메뉴별 ingredients에는 기본 밀키트에서 실제로 사용하는 구성 재료를 적습니다.
3. 추가 재료는 최소화합니다.
4. 영아/유아/어린이가 있으면 맵고 짜게 조리하지 않습니다.
5. 아이용은 간하기 전에 먼저 덜어낸 뒤 성인용에 추가 간합니다.
6. 생고기·달걀·생선은 충분히 익히도록 안내합니다.
7. 영양 설명은 과장하거나 질병 치료 효과를 단정하지 않습니다.
`;
}

function extractInteractionText(raw) {
  if (typeof raw?.output_text === "string" && raw.output_text.trim()) {
    return raw.output_text.trim();
  }

  return (raw?.steps || [])
    .filter(step => step?.type === "model_output")
    .flatMap(step => step?.content || [])
    .filter(content => content?.type === "text")
    .map(content => content?.text || "")
    .join("\n")
    .trim();
}

function extractGenerateContentText(raw) {
  return raw?.candidates?.[0]?.content?.parts
    ?.map(part => part?.text || "")
    .join("\n")
    .trim() || "";
}

async function fetchWithTimeout(url, options, timeoutMs = 45000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      const timeoutError = new Error("Gemini 응답 시간이 45초를 초과했습니다.");
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function callInteractions(model, prompt) {
  const url = "https://generativelanguage.googleapis.com/v1beta/interactions";

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      input: prompt,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: recipeSchema
      }
    })
  });

  let raw;
  try {
    raw = await response.json();
  } catch (error) {
    const parseError = new Error("Gemini Interactions 응답을 JSON으로 읽지 못했습니다.");
    parseError.status = response.status || 502;
    parseError.cause = error;
    throw parseError;
  }

  if (!response.ok) {
    const error = new Error(
      raw?.error?.message || `Gemini Interactions API 요청 실패 (${response.status})`
    );
    error.status = response.status;
    error.raw = raw;
    throw error;
  }

  const text = extractInteractionText(raw);

  if (!text) {
    const error = new Error("Gemini Interactions API가 빈 응답을 반환했습니다.");
    error.status = 502;
    throw error;
  }

  return parseRecipeJSON(text);
}

async function callGenerateContent(model, prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": process.env.GEMINI_API_KEY,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: recipeSchema,
        maxOutputTokens: 8192
      }
    })
  });

  let raw;
  try {
    raw = await response.json();
  } catch (error) {
    const parseError = new Error("Gemini generateContent 응답을 JSON으로 읽지 못했습니다.");
    parseError.status = response.status || 502;
    parseError.cause = error;
    throw parseError;
  }

  if (!response.ok) {
    const error = new Error(
      raw?.error?.message || `Gemini generateContent API 요청 실패 (${response.status})`
    );
    error.status = response.status;
    error.raw = raw;
    throw error;
  }

  const finishReason = raw?.candidates?.[0]?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    const error = new Error(`Gemini 응답이 중간에 종료되었습니다. (${finishReason})`);
    error.status = 502;
    throw error;
  }

  const text = extractGenerateContentText(raw);
  if (!text) {
    const error = new Error("Gemini generateContent API가 빈 응답을 반환했습니다.");
    error.status = 502;
    throw error;
  }

  return parseRecipeJSON(text);
}

async function callGemini(model, prompt) {
  try {
    console.log(`[Gemini] Interactions API — ${model}`);
    return await callInteractions(model, prompt);
  } catch (interactionError) {
    console.error(
      `[Gemini] Interactions 실패 → generateContent fallback:`,
      interactionError?.status || "",
      interactionError?.message || interactionError
    );

    const canFallback =
      interactionError instanceof SyntaxError ||
      interactionError?.status === 400 ||
      interactionError?.status === 404 ||
      interactionError?.status === 429 ||
      interactionError?.status === 500 ||
      interactionError?.status === 502 ||
      interactionError?.status === 503 ||
      interactionError?.status === 504 ||
      /JSON|Expected|Unexpected|빈 응답|중간에 종료/i.test(interactionError?.message || "");

    if (!canFallback) throw interactionError;

    console.log(`[Gemini] generateContent fallback — ${model}`);
    return await callGenerateContent(model, prompt);
  }
}

async function callWithRetry(prompt, ingredients, familyCounts) {
  const attempts = [
    { model: PRIMARY_MODEL, wait: 0 },
    { model: PRIMARY_MODEL, wait: 1200 },
    { model: PRIMARY_MODEL, wait: 2800 },
    { model: FALLBACK_MODEL, wait: 900 }
  ];

  let lastError;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i];

    if (attempt.wait) await sleep(attempt.wait);

    try {
      console.log(`[Gemini] attempt ${i + 1}/${attempts.length} — ${attempt.model}`);
      const result = await callGemini(attempt.model, prompt);
      const checked = validateAndEnrichResult(result, ingredients, familyCounts);
      return { ...checked, model: attempt.model, attempts: i + 1 };
    } catch (error) {
      lastError = error;

      console.error(
        `[Gemini] ${attempt.model} 실패:`,
        error?.status || "",
        error?.message || error
      );

      const retryable =
        error instanceof SyntaxError ||
        error?.status === 429 ||
        error?.status === 500 ||
        error?.status === 502 ||
        error?.status === 503 ||
        error?.status === 504 ||
        /JSON|Expected|Unexpected|중간에 종료|메뉴를 3개|응답 시간이|보유량|인원 계산|인원 배분|냉장고|중복|준비 단계|밀키트 구성|연결되지 않았|보관기한|누락/i.test(error?.message || "");

      if (!retryable) throw error;
    }
  }

  throw lastError || new Error("Gemini 요청에 반복적으로 실패했습니다.");
}

app.post("/api/recipe", async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({
        error: ".env 파일에서 GEMINI_API_KEY를 찾지 못했습니다."
      });
    }

    const ingredients = cleanIngredients(req.body?.ingredients);
    const rawFamilyCounts = req.body?.familyCounts || {};
    const familyCounts = {
      "영아": Math.max(0, Number(rawFamilyCounts["영아"] || 0)),
      "유아": Math.max(0, Number(rawFamilyCounts["유아"] || 0)),
      "어린이": Math.max(0, Number(rawFamilyCounts["어린이"] || 0)),
      "성인": Math.max(0, Number(rawFamilyCounts["성인"] || 0)),
      "노인": Math.max(0, Number(rawFamilyCounts["노인"] || 0))
    };
    const style = String(req.body?.style || "한식").slice(0, 30);
    const goal = String(req.body?.goal || "냉장고 재료 최대 활용").slice(0, 80);

    if (ingredients.length < 2) {
      return res.status(400).json({
        error: "재료명, 용량, 구입일자가 있는 재료를 2개 이상 입력해 주세요."
      });
    }

    const todayIso = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());

    if (ingredients.some(item => item.purchaseDate > todayIso)) {
      return res.status(400).json({
        error: "구입일자는 오늘보다 미래일 수 없습니다."
      });
    }

    const totalPeople = Object.values(familyCounts).reduce((a,b)=>a+b,0);
    if (totalPeople < 1) {
      return res.status(400).json({
        error: "가족 인원을 1명 이상 지정해 주세요."
      });
    }

    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date());

    const prompt = makePrompt({
      today,
      ingredients,
      familyCounts,
      style,
      goal
    });

    const result = await callWithRetry(prompt, ingredients, familyCounts);

    res.json({
      mealkit: result.mealkit,
      recipes: result.recipes,
      model: result.model,
      provider: "Gemini",
      attempts: result.attempts
    });
  } catch (error) {
    console.error("최종 Gemini 오류:", error?.message || error);

    let friendly = error?.message || "레시피 생성 중 오류가 발생했습니다.";

    if (error?.status === 429) {
      friendly =
        "Gemini 무료 사용량 또는 요청 속도 제한에 걸렸습니다. 잠시 후 다시 시도해 주세요.";
    } else if (
      error instanceof SyntaxError ||
      /JSON|Expected|Unexpected/i.test(error?.message || "")
    ) {
      friendly =
        "Gemini가 레시피 형식을 완성하지 못했습니다. 자동 재시도까지 실패했습니다. 다시 한 번 눌러 주세요.";
    } else if (error?.status === 503) {
      friendly =
        "현재 Gemini 이용자가 많아 서버가 혼잡합니다. 자동 재시도와 예비 모델 전환도 실패했습니다.";
    } else if (error?.status === 504) {
      friendly =
        "Gemini 응답이 너무 늦어 자동으로 다시 시도했지만 완료하지 못했습니다.";
    } else if (
      error?.status === 400 &&
      /API key|API_KEY_INVALID/i.test(error?.message || "")
    ) {
      friendly =
        "Gemini API 키가 올바르지 않습니다. .env의 GEMINI_API_KEY를 확인해 주세요.";
    }

    const status =
      error?.status === 429 ? 429 :
      error?.status === 400 ? 400 :
      500;

    res.status(status).json({ error: friendly });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Smart Chef AI: http://localhost:${PORT}`);
  console.log(`Gemini primary: ${PRIMARY_MODEL}`);
  console.log(`Gemini fallback: ${FALLBACK_MODEL}`);
});
