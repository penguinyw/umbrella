const express = require("express");
const multer = require("multer");
const path = require("path");

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const PORT = Number(process.env.PORT || 3000);
const ARK_API_KEY = normalizeEnvValue(process.env.ARK_API_KEY || "");
const ARK_BASE_URL = normalizeEnvValue(process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3");
const ARK_RESPONSES_PATH = normalizeEnvValue(process.env.ARK_RESPONSES_PATH || "/responses");
const ARK_MODEL = normalizeEnvValue(process.env.ARK_MODEL || "ep-20260316134751-xdsck");
const DEVELOPER_ID = "BIY27";
const DEFAULT_ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DEFAULT_ARK_RESPONSES_PATH = "/responses";

const SYSTEM_PROMPT = "你是一个资深的销售总监，对于潜在客户的心理和外在表现，有非常强的洞察，也有一套很厉害的销售技巧！擅长于输出简短但有效的分析和建议。";

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", (_, res) => {
  res.json({ ok: true, developer_id: DEVELOPER_ID });
});

app.post("/api/analyze", upload.array("images", 20), async (req, res) => {
  try {
    const files = req.files || [];
    if (files.length < 5) {
      return res.status(400).json({ error: "请至少上传 5 张图片" });
    }

    const extraContext = [req.body.industry, req.body.productType, req.body.goal]
      .filter(Boolean)
      .map((v, i) => ["行业", "产品类型", "销售目标"][i] + "：" + v)
      .join("\n");

    if (!ARK_API_KEY) {
      return res.json({
        mock: true,
        developer_id: DEVELOPER_ID,
        data: {
          persona_summary: "目标客户内容偏生活方式与消费体验，关注品质和社交表达，适合价值导向沟通。",
          interest_tags: ["生活方式", "品质消费", "社交表达", "效率工具"],
          need_hypothesis: [
            "希望提升生活品质并获得圈层认同",
            "对节省时间、提升效率类方案有潜在兴趣"
          ],
          sales_strategy: [
            "先共情对方近期关注内容，再引入产品价值点",
            "优先强调实际收益与可验证案例，避免空泛话术"
          ],
          communication_examples: [
            "看到你最近挺关注这类体验，我这边有个方案能在不增加投入太多的情况下，把效果稳定提升。",
            "如果你愿意，我可以用一个和你场景接近的真实案例，2 分钟给你看核心差异。"
          ],
          risk_points: ["避免过度推销语气", "避免否定其既有选择", "不要一次抛出过多信息"],
          raw: "未检测到 ARK_API_KEY，当前为本地演示数据。"
        }
      });
    }

    const userContent = [
      {
        type: "input_text",
        text:
          "请基于以下朋友圈截图，输出简短但有效的销售洞察。必须返回 JSON 对象，包含字段：persona_summary, interest_tags, need_hypothesis, sales_strategy, communication_examples, risk_points。字段值分别为字符串或字符串数组。" +
          (extraContext ? `\n补充信息：\n${extraContext}` : "")
      },
      ...files.map((file) => ({
        type: "input_image",
        image_url: `data:${file.mimetype};base64,${file.buffer.toString("base64")}`
      }))
    ];

    const requestBody = JSON.stringify({
      model: ARK_MODEL,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: SYSTEM_PROMPT
            }
          ]
        },
        { role: "user", content: userContent }
      ],
      temperature: 0.4
    });
    const primaryEndpoint = joinUrl(ARK_BASE_URL, ARK_RESPONSES_PATH);
    const fallbackEndpoint = joinUrl(DEFAULT_ARK_BASE_URL, DEFAULT_ARK_RESPONSES_PATH);
    let apiResponse = await requestArk(primaryEndpoint, ARK_API_KEY, requestBody);
    if (!apiResponse.ok) {
      const failedText = await apiResponse.text();
      const lowerFailed = failedText.toLowerCase();
      const shouldFallback =
        apiResponse.status === 404 &&
        (lowerFailed.includes("not_found") || lowerFailed.includes("could not be found")) &&
        primaryEndpoint !== fallbackEndpoint;
      if (shouldFallback) {
        apiResponse = await requestArk(fallbackEndpoint, ARK_API_KEY, requestBody);
      } else {
        return res.status(apiResponse.status).json({
          error: "模型调用失败",
          detail: failedText
        });
      }
    }

    const responseText = await apiResponse.text();
    if (!apiResponse.ok) {
      return res.status(apiResponse.status).json({
        error: "模型调用失败",
        detail: responseText
      });
    }

    let content = "";
    try {
      const parsed = JSON.parse(responseText);
      content = parsed?.output_text || extractOutputTextFromResponses(parsed);
    } catch {
      content = responseText;
    }

    const parsedJson = extractJson(content);
    if (parsedJson) {
      return res.json({ developer_id: DEVELOPER_ID, data: normalizeResult(parsedJson), raw: content });
    }

    return res.json({
      developer_id: DEVELOPER_ID,
      data: normalizeResult({
        persona_summary: content || "模型返回为空",
        interest_tags: [],
        need_hypothesis: [],
        sales_strategy: [],
        communication_examples: [],
        risk_points: []
      }),
      raw: content
    });
  } catch (error) {
    return res.status(500).json({ error: "服务异常", detail: String(error?.message || error) });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

function extractJson(text) {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {}
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const maybe = text.slice(first, last + 1);
  try {
    return JSON.parse(maybe);
  } catch {
    return null;
  }
}

function toStringArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x));
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function normalizeResult(result) {
  return {
    persona_summary: String(result.persona_summary || ""),
    interest_tags: toStringArray(result.interest_tags),
    need_hypothesis: toStringArray(result.need_hypothesis),
    sales_strategy: toStringArray(result.sales_strategy),
    communication_examples: toStringArray(result.communication_examples),
    risk_points: toStringArray(result.risk_points)
  };
}

function extractOutputTextFromResponses(parsed) {
  const outputs = Array.isArray(parsed?.output) ? parsed.output : [];
  const collected = [];
  for (const outputItem of outputs) {
    const contentArr = Array.isArray(outputItem?.content) ? outputItem.content : [];
    for (const part of contentArr) {
      if (part?.type === "output_text" && typeof part?.text === "string") {
        collected.push(part.text);
      }
    }
  }
  return collected.join("\n").trim();
}

function normalizeEnvValue(value) {
  return String(value || "")
    .trim()
    .replace(/^['"`\s]+|['"`\s]+$/g, "");
}

function joinUrl(baseUrl, pathPart) {
  const cleanBase = normalizeEnvValue(baseUrl).replace(/\/+$/, "");
  const cleanPath = normalizeEnvValue(pathPart).replace(/^\/+/, "");
  return `${cleanBase}/${cleanPath}`;
}

function requestArk(endpoint, apiKey, requestBody) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: requestBody
  });
}
