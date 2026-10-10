// Gemini-backed tag suggestions (moved verbatim from the old server.js).
const fs = require("fs");
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { CONFIG_DIR } = require("./config");

const GEMINI_KEY_FILE = path.join(CONFIG_DIR, "gemini-api-key");
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.6-flash";

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    return fs.readFileSync(GEMINI_KEY_FILE, "utf8").trim();
  } catch {
    return "";
  }
}

const TAG_SUGGESTION_PROMPT = `You are helping tag photos of custom kitchen and joinery work for a
searchable photo library at a cabinet-making showroom. Look closely at this photo and identify 3-6
specific tags a customer might search for: the room type (e.g. kitchen, laundry, pantry, walk-in
robe, bathroom vanity, study), the design style (e.g. farmhouse, modern, shaker, hamptons,
industrial, scandinavian), and the visible materials, colours, or finishes (e.g. oak, matte black,
stone benchtop, white, walnut, two-tone, brass hardware). Base every tag only on what you can
actually see — don't guess at things outside the frame. Prefer specific, descriptive tags over
generic ones like "cabinet" or "wood" alone.`;

const TAG_SUGGESTION_SCHEMA = {
  type: "array",
  items: { type: "string" },
};

async function suggestTagsForImage(buffer, mimeType) {
  const apiKey = getGeminiApiKey();
  if (!apiKey) {
    const err = new Error("Tag suggestions aren't configured yet.");
    err.code = "NOT_CONFIGURED";
    throw err;
  }
  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: TAG_SUGGESTION_SCHEMA,
    },
  });
  const result = await model.generateContent([
    TAG_SUGGESTION_PROMPT,
    { inlineData: { data: buffer.toString("base64"), mimeType } },
  ]);
  const text = result.response.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`Gemini returned unparseable output: ${text.slice(0, 200)}`);
  }
  if (!Array.isArray(raw)) {
    throw new Error("Gemini didn't return a list of tags");
  }
  return [...new Set(
    raw
      .filter((t) => typeof t === "string")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean)
  )].slice(0, 8);
}

module.exports = { getGeminiApiKey, suggestTagsForImage };
