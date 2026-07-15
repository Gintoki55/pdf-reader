import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { GoogleAuth } from "google-auth-library";
import { Langfuse } from "langfuse";
import { vectorSearch } from "@/lib/vectorstore";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ★ LF: تهيئة Langfuse
const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
});

const auth = new GoogleAuth({
  keyFilename: "./service-account.json",
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

type HistoryMsg = { role: "user" | "assistant"; content: string };

type ActiveEntity = {
  name: string;
  nameAr: string;
  type: string;
  document: string;
} | null;

export type ParsedReference = {
  number: string;
  authors: string;
  title: string;
  url: string;
};

type QuestionType =
  | "definition" | "simple_qa" | "comparison" | "calculation"
  | "recommendation" | "research_critique" | "analytical_short" | "brevity_requested";

type EntityMatch = {
  entity: ActiveEntity;
  confidence: number;
};

type MessageType = "research" | "followup" | "chat" | "greeting";

type ConversationMemory = {
  entity: ActiveEntity;
  topic: string;
  focus: string;
  lastQuestion: string;
  lastAnswer: string;
  lastChunks: string;
  intent: string;
};

// ─────────────────────────────────────────────────────────────
//  Embedding + Gemini
// ─────────────────────────────────────────────────────────────
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: text,
  });
  return response.data[0].embedding;
}

// ★ LF: askGemini تستقبل trace اختيارياً — كل نداءات Gemini تتسجل من هنا
async function askGemini(
  prompt: string,
  maxTokens: number,
  trace?: any,
  name?: string
): Promise<{ text: string; truncated: boolean }> {
  const gen = trace?.generation({
    name: name || "gemini-call",
    model: "gemini-2.5-flash",
    input: prompt,
    modelParameters: { temperature: 0.1, maxOutputTokens: maxTokens },
  });

  try {
    const client = await auth.getClient();
    const token = await client.getAccessToken();
    const projectId = process.env.GOOGLE_PROJECT_ID;
    const location = "us-central1";

    const response = await fetch(
      `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: maxTokens },
        }),
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const finishReason = data.candidates?.[0]?.finishReason;

    gen?.end({
      output: text,
      usage: {
        input: data.usageMetadata?.promptTokenCount,
        output: data.usageMetadata?.candidatesTokenCount,
      },
    });

    return { text, truncated: finishReason === "MAX_TOKENS" };
  } catch (err) {
    gen?.end({ output: String(err), level: "ERROR" });
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────
//  Utilities
// ─────────────────────────────────────────────────────────────
function sanitizeRepetition(text: string): string {
  if (text.length < 8000) return text;
  const m = text.match(/(.{15,200}?)\1{4,}/);
  if (m) {
    const cut = text.indexOf(m[0]) + m[1].length;
    return text.slice(0, cut).trim() + "\n\n*(Auto-truncated repeated content)*";
  }
  return text;
}

function buildSourceLabel(metadata: any): string {
  const t = metadata?.chunk_type;
  const r = metadata?.ref_number;
  const s = metadata?.section;
  const p = metadata?.page;
  if (t === "table" && r) return `[${r}${p ? `, p.${p}` : ""}]`;
  if ((t === "figure" || t === "graph") && r) return `[${r}${p ? `, p.${p}` : ""}]`;
  if (t === "text" && s) return `[Section ${s.replace(/^Section\s+/i, "")}]`;
  if (t === "links") return `[Links]`;
  return `[Document excerpt${p ? `, p.${p}` : ""}]`;
}

function cleanAnswerForUser(text: string): string {
  return text
    .replace(/\*{0,2}Confidence Level\*{0,2}[\s\S]*?(?=\n\n|\n##|\n\*\*|$)/gi, "")
    .replace(/\*{0,2}مستوى الثقة\*{0,2}[\s\S]*?(?=\n\n|\n##|\n\*\*|$)/gi, "")
    .replace(/\[Section [^\]]+\]/g, "")
    .replace(/\[Table [^\]]+\]/g, "")
    .replace(/\[Figure [^\]]+\]/g, "")
    .replace(/\[Document excerpt[^\]]*\]/g, "")
    .replace(/\[Links\]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isContinuationCommand(q: string): boolean {
  const t = (q || "").trim();
  return (
    /^(continue|go on|keep going|carry on|finish|complete( the)? answer|continue (the )?answer)\b/i.test(t) ||
    /^(أكمل|اكمل|كمل|كمّل|كمِّل|تابع|واصل|أكمل الإجابة|كمل الجواب|اكمل الجواب|أكمل من حيث توقفت|كمل من حيث توقفت)\b/.test(t)
  );
}

function isReferencesRequested(q: string): boolean {
  return /references?|citations?|sources?|bibliography|cite|cited|proof|evidence|مراجع|مرجع|مصادر|مصدر|دليل|أدلة|اقتبس|استشهد/i.test(q);
}

function detectLanguage(text: string): "ar" | "en" {
  const ar = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return ar / Math.max(text.replace(/\s/g, "").length, 1) > 0.3 ? "ar" : "en";
}

// ★ يقبل الآن id عادي (أرقام) أو مركّب (D1-12)
function parseReferencesFromText(text: string): ParsedReference[] {
  const refs: ParsedReference[] = [];
  for (const line of text.split("\n").filter(l => l.trim())) {
    const m = line.match(/^\[([\w-]+)\]\s*(.+)/);
    if (!m) continue;
    const number = m[1];
    const rest = m[2].trim();
    const urlMatch = rest.match(/Link:\s*(https?:\/\/\S+)/i);
    const url = urlMatch ? urlMatch[1].replace(/[.,;]+$/, "") : "";
    const withoutLink = rest.replace(/Link:\s*https?:\/\/\S+/i, "").trim();
    const dotIdx = withoutLink.indexOf(". ");
    const authors = dotIdx > 0 ? withoutLink.slice(0, dotIdx).trim() : "";
    const title = dotIdx > 0 ? withoutLink.slice(dotIdx + 2).trim() : withoutLink;
    if (title || authors || url) refs.push({ number, authors, title, url });
  }
  return refs;
}

function normalizeInput(text: string): string {
  return text
    .trim()
    .replace(/([؟?!،,.]){2,}/g, "$1")
    .replace(/(ما|من|في|هو|هي|ماهو|ماهي)([^\s])/gi, "$1 $2")
    .replace(/ال([a-zA-Z])/g, "ال $1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────
//  Entity Detection
// ─────────────────────────────────────────────────────────────
const ENTITY_PATTERNS: { regex: RegExp; type: string }[] = [
  { regex: /(methanol|ميثانول|الميثانول)/i, type: "chemical" },
  { regex: /(WSA|waste salt A|ملح النفايات A)/i, type: "waste_salt" },
  { regex: /(WSB|waste salt B|ملح النفايات B)/i, type: "waste_salt" },
  { regex: /(WSC|waste salt C|ملح النفايات C)/i, type: "waste_salt" },
  { regex: /(NaCl|sodium chloride|كلوريد الصوديوم)/i, type: "chemical" },
  { regex: /(Na2SO4|sodium sulfate|كبريتات الصوديوم)/i, type: "chemical" },
  { regex: /(PVDF|polyvinylidene fluoride)/i, type: "material" },
  { regex: /(ASC|anti.?solvent crystallization|التبلور بالمذيبات المضادة|التبلور بمضاد المذيبات)/i, type: "process" },
  { regex: /(MSF|multi.?stage flash|التقطير متعدد المراحل)/i, type: "technology" },
  { regex: /(MED|multi.?effect distillation|التقطير متعدد التأثير)/i, type: "technology" },
  { regex: /(RO|reverse osmosis|التناضح العكسي)/i, type: "technology" },
  { regex: /(VIPS|vapor.?induced phase separation)/i, type: "process" },
  { regex: /(NIPS|non.?solvent induced phase separation)/i, type: "process" },
  { regex: /(TIPS|thermally induced phase separation)/i, type: "process" },
  { regex: /(DCMD|direct contact membrane distillation)/i, type: "technology" },
  { regex: /(membrane|غشاء|الغشاء|أغشية)/i, type: "material" },
];

const PARTIAL_PATTERNS: { partial: RegExp; name: string; type: string }[] = [
  { partial: /(ميثانو|ميثان|methano|الميث|ميث)/i, name: "methanol", type: "chemical" },
  { partial: /(wsa)/i, name: "WSA", type: "waste_salt" },
  { partial: /(wsb)/i, name: "WSB", type: "waste_salt" },
  { partial: /(wsc)/i, name: "WSC", type: "waste_salt" },
  { partial: /(nacl|كلوريد الصود)/i, name: "NaCl", type: "chemical" },
  { partial: /(na2so|كبريتات الصود)/i, name: "Na2SO4", type: "chemical" },
  { partial: /(pvdf|polyviny)/i, name: "PVDF", type: "material" },
  { partial: /(antisolvent|anti.solvent|التبلور بالمذيب|التبلور بمضاد)/i, name: "ASC", type: "process" },
  { partial: /(multi.*stage|متعدد المراح)/i, name: "MSF", type: "technology" },
  { partial: /(multi.*effect|متعدد التأث)/i, name: "MED", type: "technology" },
  { partial: /(reverse osmo|التناضح)/i, name: "RO", type: "technology" },
  { partial: /(vapor.*induced)/i, name: "VIPS", type: "process" },
  { partial: /(non.*solvent.*induced)/i, name: "NIPS", type: "process" },
  { partial: /(thermal.*induced)/i, name: "TIPS", type: "process" },
  { partial: /(direct.*contact.*membrane)/i, name: "DCMD", type: "technology" },
  { partial: /(membran|غشاء|أغشية)/i, name: "membrane", type: "material" },
];

function detectEntityWithConfidence(text: string): EntityMatch {
  const q = text.trim();
  for (const { regex, type } of ENTITY_PATTERNS) {
    const match = q.match(regex);
    if (match) return { entity: { name: match[0], nameAr: match[0], type, document: "" }, confidence: 0.99 };
  }
  for (const { partial, name, type } of PARTIAL_PATTERNS) {
    const match = q.match(partial);
    if (match) {
      const confidence = Math.min(0.50 + (match[0].length / name.length) * 0.35, 0.88);
      return { entity: { name, nameAr: name, type, document: "" }, confidence };
    }
  }
  return { entity: null, confidence: 0 };
}

function detectEntityFromText(text: string): ActiveEntity {
  const { entity, confidence } = detectEntityWithConfidence(text);
  return confidence >= 0.99 ? entity : null;
}

// ─────────────────────────────────────────────────────────────
//  Conversation Memory
// ─────────────────────────────────────────────────────────────
function detectResearchIntent(q: string): string {
  if (/(مميزات|مزايا|ميزة|advantages?|benefits?)/i.test(q)) return "advantages";
  if (/(عيوب|سلبيات|disadvantages?|drawbacks?|limitations?)/i.test(q)) return "disadvantages";
  if (/(مقارنة|قارن|compare|versus|difference|رابط|علاقة)/i.test(q)) return "comparison";
  if (/(لماذا|سبب|تأثير|why|effect|reason)/i.test(q)) return "analysis";
  if (/(كم|عدد|نسبة|how many|how much|count|number)/i.test(q)) return "fact";
  if (/^(ما هو|ماهو|what is|define)/i.test(q)) return "definition";
  return "other";
}

function extractFocus(question: string): string {
  const numericMatch = question.match(/(عدد|كم|نسبة|درجة|تكلفة|سعر|وقت|مدة|كمية|count|number|rate|cost|price|temperature|time|duration)\s+\S+/i);
  if (numericMatch) return numericMatch[0].trim();

  if (/(دور|cycle|treatment)/i.test(question)) return "treatment cycles";
  if (/(تكلفة|cost|price)/i.test(question)) return "cost";
  if (/(بيئ|carbon|emission|CO2)/i.test(question)) return "environmental impact";
  if (/(نقاء|purity)/i.test(question)) return "purity";
  if (/(إنتاج|yield|recovery)/i.test(question)) return "yield";
  if (/(درجة.*حرارة|temperature)/i.test(question)) return "temperature";

  return "";
}

function buildMemory(history: HistoryMsg[]): ConversationMemory {
  const userMsgs = history.filter(m => m.role === "user").reverse();
  const assistantMsgs = history.filter(m => m.role === "assistant").reverse();

  let entity: ActiveEntity = null;
  let topic = "";
  let focus = "";
  let intent = "other";
  let lastQuestion = userMsgs[0]?.content || "";

  for (const msg of userMsgs) {
    const { entity: e, confidence } = detectEntityWithConfidence(msg.content);
    if (e && confidence >= 0.90) {
      if (!entity) entity = e;
      if (!topic && msg.content.trim().split(/\s+/).length >= 3) {
        topic = msg.content.trim();
        focus = extractFocus(topic);
        intent = detectResearchIntent(topic);
      }
      if (entity && topic) break;
    }
  }

  const lastAnswer = assistantMsgs[0]
    ? assistantMsgs[0].content.split(/(?<=[.؟?])\s+/).slice(0, 3).join(" ").slice(0, 500)
    : "";

  const lastChunks = assistantMsgs[0]?.content.slice(0, 1000) || "";

  return { entity, topic, focus, lastQuestion, lastAnswer, lastChunks, intent };
}

// ─────────────────────────────────────────────────────────────
//  Conversation Manager — ★ ROOT: الذاكرة تقلب الافتراض
// ─────────────────────────────────────────────────────────────
async function classifyMessage(
  question: string,
  history: HistoryMsg[],
  memory: ConversationMemory,
  trace?: any
): Promise<MessageType> {
  const hasContext = !!memory.entity;

  if (detectEntityFromText(question)) {
    console.log(`[Manager] Quick: "research" (entity detected) ← "${question}"`);
    return "research";
  }

  if (/^(hi|hello|hey|اهلا|أهلا|هلا|مرحبا|السلام عليكم)\b/i.test(question.trim())) {
    console.log(`[Manager] Quick: "greeting" ← "${question}"`);
    return "greeting";
  }

  const topicAlive = hasContext && !!memory.topic;

  if (topicAlive) {
    const isExplicitSocial = /^(هه+|ها+|لو+ل|خخ+|شكرا|مشكور|تمام$|حسنا$|اوك+|طيب$|هلا|مرحبا|مساء|صباح|سلام|باي|اراك|تصبح|سانام|سأنام|بنام|اريد ان انام|thanks|thank you|ok+$|bye|good ?night|lol|haha)/i
      .test(question.trim());

    if (isExplicitSocial) {
      console.log(`[Manager] Quick: "chat" (explicit social, topic alive) ← "${question}"`);
      return "chat";
    }
  }

  const prompt = `You are the conversation manager for a desalination research assistant.
Your ONLY job: decide if this message needs searching the research documents.

CONVERSATION MEMORY:
- Active entity: ${memory.entity?.name || "none"}
- Research topic: "${memory.topic || "none"}"
- Current focus: "${memory.focus || "none"}"
- Last answer summary: "${memory.lastAnswer.slice(0, 200) || "none"}"

RECENT EXCHANGE:
${history.slice(-4).map(m => `[${m.role}]: "${m.content.slice(0, 120)}"`).join("\n")}

NEW MESSAGE: "${question}"

CLASSIFY:
- "research" — needs document search (new research question with its own topic)
- "followup" — continues the ACTIVE research topic: asks about an aspect, detail, comparison, or data related to it — needs documents
- "chat" — clearly social, emotional, or random with NO topical content — does NOT need documents
- "greeting" — pure greeting with no research content

KEY RULES:
1. If a Research topic exists in memory, the DEFAULT for any topical, vague, aspect, or data question is "followup" — chat detours (sleep, jokes, thanks) do NOT erase the research context.
2. "chat" requires the message itself to be clearly social/emotional/random with NO topical content.
3. "followup" requires an ACTIVE entity in memory. If Active entity is "none" → "research".
4. A message with its own NEW research topic (different entity) is "research", not "followup".

Return ONLY: {"type": "research"} or {"type": "followup"} or {"type": "chat"} or {"type": "greeting"}`;

  try {
    const { text } = await askGemini(prompt, 60, trace, "classify-message");
    const clean = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    if (["research", "followup", "chat", "greeting"].includes(parsed.type)) {
      let type = parsed.type as MessageType;
      if (type === "followup" && !hasContext) type = "research";
      console.log(`[Manager] LLM: "${type}" topicAlive=${topicAlive} ← "${question}"`);
      return type;
    }
    return topicAlive ? "followup" : "chat";
  } catch {
    console.log(`[Manager] Fallback: "${topicAlive ? "followup" : "chat"}" (parse failed) ← "${question}"`);
    return topicAlive ? "followup" : "chat";
  }
}

// ─────────────────────────────────────────────────────────────
//  Chat Response
// ─────────────────────────────────────────────────────────────
async function generateChatResponse(
  question: string,
  memory: ConversationMemory,
  lang: "ar" | "en",
  trace?: any
): Promise<{ text: string; truncated: boolean }> {
  const isFirstMessage = !memory.topic && !memory.lastAnswer;

  const prompt = `You are a friendly desalination research assistant.

ACTIVE CONTEXT:
- Research topic: "${memory.topic || "none"}"
- Last answer: "${memory.lastAnswer.slice(0, 300) || "none"}"

USER: "${question}"

Respond in ${lang === "ar" ? "Arabic" : "English"}:
${isFirstMessage
  ? "- If greeting: greet warmly and briefly, offer research help."
  : "- Do NOT start with a greeting like 'أهلاً' or 'Hello' — the conversation is already ongoing. Jump straight to the response."
}
- Social/casual → respond naturally, 1-2 sentences max.
- Unknown word/typo → ask what they meant with mild curiosity.
- Off-topic → acknowledge briefly, redirect to research.
- "هل هذا صحيح؟" / "is that right?" → confirm or clarify based on last answer above.
- Unclear research question → make your best guess and answer, or ask ONE simple question.
- NEVER say "I didn't understand" as your main response.
- Do NOT invent research facts.
- NEVER provide specific numbers, percentages, or data values.
  If the user needs numbers, say: "هذا سؤال بحثي، اسألني عنه وسأبحث في الوثائق."`;

  try {
    const { text, truncated } = await askGemini(prompt, 1024, trace, "chat-response");
    return {
      text: text.trim() || (lang === "ar" ? "كيف يمكنني مساعدتك؟" : "How can I help?"),
      truncated,
    };
  } catch {
    return { text: lang === "ar" ? "كيف يمكنني مساعدتك؟" : "How can I help?", truncated: false };
  }
}

// ─────────────────────────────────────────────────────────────
//  Query Builder
// ─────────────────────────────────────────────────────────────
function buildSearchQuery(question: string, memory: ConversationMemory, isFollowup: boolean): string {
  if (!isFollowup || !memory.entity?.name) return question;

  const entityName = memory.entity.name;
  const intent = detectResearchIntent(question) || memory.intent;
  const focusHint = memory.focus ? ` ${memory.focus}` : "";

  const queries: Record<string, string> = {
    advantages:    `advantages benefits strengths of ${entityName}`,
    disadvantages: `disadvantages drawbacks limitations of ${entityName}`,
    comparison:    `comparison relationship ${entityName} ${question}`,
    definition:    `what is ${entityName} definition overview`,
    analysis:      `${entityName}${focusHint} ${question} reason why effect`,
    fact:          `${entityName}${focusHint} ${question}`,
    other:         `${entityName}${focusHint}: ${question}`,
  };

  return queries[intent] || `${entityName}: ${question}`;
}

// ─────────────────────────────────────────────────────────────
//  Retrieval
// ─────────────────────────────────────────────────────────────
async function retrieve(query: string, trace?: any) {
  const embSpan = trace?.span({ name: "embedding", input: query });
  const vec = await getEmbedding(query);
  embSpan?.end();

  const pcSpan = trace?.span({ name: "vector-search", input: query });

  const searchResults = await vectorSearch(vec, { topK: 20, queryText: query }, trace);

  const filenames = [...new Set(searchResults.map(m => m.metadata?.filename).filter(Boolean))] as string[];

  const imageResults = filenames.length > 0
    ? await vectorSearch(vec, {
        topK: 5,
        queryText: query,
        filter: {
          chunk_type: ["figure", "graph", "table", "chart", "diagram", "microscopy", "flowchart"],
          filename: filenames,
        },
      }, trace)
    : [];

  let referencesContext = "";
  let references: ParsedReference[] = [];

  if (filenames.length > 0) {
    const refResults = await vectorSearch(vec, {
      topK: filenames.length,
      filter: { chunk_type: "references_index", filename: filenames },
    }, trace);

    // ★ ترقيم مركّب فريد عالمياً: D{رقم الورقة}-{الرقم الأصلي للمرجع داخلها}
    // يمنع تصادم الأرقام لما تستخدم الإجابة أكثر من ورقة بحثية بنفس الوقت
    // (كل ورقة ترقّم مراجعها من 1 بشكل مستقل، فـ [12] بورقة A ≠ [12] بورقة B)
    const docIndexMap = new Map<string, number>();
    filenames.forEach((f, idx) => docIndexMap.set(f, idx + 1));

    const remappedBlocks = refResults.map(m => {
      const filename = String(m.metadata?.filename ?? "");
      const docIdx = docIndexMap.get(filename) ?? 0;
      const rawText = String(m.metadata?.text ?? "");
      return rawText.replace(/^\[(\d{1,3})\]/gm, `[D${docIdx}-$1]`);
    });

    referencesContext = remappedBlocks.join("\n\n");
    references = remappedBlocks.flatMap(text => parseReferencesFromText(text));

    const seen = new Set<string>();
    references = references.filter(r => { if (seen.has(r.number)) return false; seen.add(r.number); return true; });

    // ترتيب: رقم الورقة أولاً، ثم رقم المرجع داخلها
    references.sort((a, b) => {
      const am = a.number.match(/^D(\d+)-(\d+)$/);
      const bm = b.number.match(/^D(\d+)-(\d+)$/);
      const aDoc = am ? parseInt(am[1]) : 0, aNum = am ? parseInt(am[2]) : 0;
      const bDoc = bm ? parseInt(bm[1]) : 0, bNum = bm ? parseInt(bm[2]) : 0;
      return (aDoc - bDoc) || (aNum - bNum);
    });
  }

  const context = searchResults
    .map(m => `${buildSourceLabel(m.metadata)} ${String(m.metadata?.text ?? "").slice(0, 4000)}`)
    .join("\n\n");

  pcSpan?.end({
    output: {
      store: "qdrant",
      collection: process.env.QDRANT_COLLECTION,
      textMatches: searchResults.length,
      imageMatches: imageResults.length,
      files: filenames,
      topScore: searchResults[0]?.score ?? 0,
    },
  });

  return { context, referencesContext, imageResults, references, filenames };
}

// ─────────────────────────────────────────────────────────────
//  Prompt Router
// ─────────────────────────────────────────────────────────────
function classifyQuestionType(q: string): QuestionType {
  const t = q.trim();
  if (/one sentence|one line|briefly|in short|بسطر واحد|بكلمة|بإيجاز|باختصار|جواب قصير/i.test(t)) return "brevity_requested";
  if (/^(what is|what are|define|ما هو|ما هي|ماهو|ماهي|عرّف|عرف)\b/i.test(t) && !/compare|versus|رابط|علاقة/i.test(t)) return "definition";
  if (/احسب|حساب|calculate|compute|كم يساوي|كم سيكون|quantify|annual|سنوي/i.test(t)) return "calculation";
  if (/critique|critically|evaluate|انتقد|نقد|تقييم نقدي/i.test(t)) return "research_critique";
  if (/compare|comparison|versus|vs\.?|قارن|مقارنة|أيهما أفضل|الفرق بين|رابط|علاقة|relation|connection/i.test(t)) return "comparison";
  if (/\b(should|recommend|best|optimal|يجب|أفضل|توصية|اختر)\b/i.test(t) && /\b(factor|consider|عامل|اعتبار)\b/i.test(t)) return "recommendation";
  const analytical = /(لماذا|ليش|سبب|تأثير|why|effect|impact|implication)/i.test(t);
  if (analytical && t.split(/\s+/).length < 50) return "analytical_short";
  return "simple_qa";
}

function buildResearchPrompt(params: {
  type: QuestionType;
  question: string;
  context: string;
  referencesContext: string;
  memory: ConversationMemory;
  refsRequested: boolean;
  lang: "ar" | "en";
}): { prompt: string; maxTokens: number } {
  const { type, question, context, referencesContext, memory, refsRequested, lang } = params;

  const langRule = lang === "ar"
    ? "أجب بالعربية. احتفظ بالأسماء الكيميائية والاختصارات العلمية بالإنجليزية."
    : "Answer in English. Keep chemical names and abbreviations in English.";

  const memCtx = [
    memory.entity    ? `ACTIVE ENTITY: "${memory.entity.name}" (${memory.entity.type})` : "",
    memory.topic     ? `RESEARCH TOPIC: "${memory.topic}"` : "",
    memory.focus     ? `CURRENT FOCUS: "${memory.focus}" — answer specifically about this sub-topic` : "",
    memory.lastAnswer? `LAST ANSWER (what you just said): "${memory.lastAnswer}"` : "",
  ].filter(Boolean).join("\n");

  const intentGuide: Record<string, string> = {
    advantages:    "Focus on STRENGTHS and POSITIVE ASPECTS only.",
    disadvantages: "Focus on WEAKNESSES, LIMITATIONS, and RISKS only.",
    comparison:    "Compare items or explain their RELATIONSHIP clearly.",
    definition:    "Provide a clear, concise definition.",
    analysis:      "Explain CAUSE, EFFECT, and REASONING.",
    fact:          "Provide the SPECIFIC FACT or NUMBER from the source. Do NOT reinterpret the focus.",
    other:         "Answer directly from the source documents.",
  };

  const intentHint = memory.intent !== "other"
    ? `ANSWER INTENT: ${intentGuide[memory.intent] || intentGuide.other}`
    : "";

  // ★ يوجّه Gemini يستخدم صيغة الاستشهاد المركّبة بالضبط كما هي، بدون اختراع أو تبسيط
  const noClutter = `OUTPUT RULES:
- No [Section x], [Table x], [Figure x], [Document excerpt] labels.
- No "Confidence Level" section.
- ${refsRequested ? "Cite ONLY reference IDs copied EXACTLY as written in the REFERENCES list below (format looks like [D1-4], [D2-12]). Do NOT strip the 'D#-' prefix, do NOT invent new IDs, do NOT renumber. NEVER cite section numbers like [2.3] — sections are not citable references." : "No reference labels or bibliography."}`;

  const noFabrication = `DATA RULE: NEVER invent numbers. Hypotheticals: qualitative only. Missing data: say so explicitly.`;

  const sources = `
REFERENCES: ${referencesContext || "None."}
SOURCE DOCUMENTS:
${context}`;

  const contextFlag = `CONTEXT USAGE FLAG (MANDATORY): End your answer with exactly one marker on its own line:
[CTX:USED] if your answer is based on the SOURCE DOCUMENTS above.
[CTX:NONE] if the documents lack relevant information and you answered from general knowledge.`;

  const base = `${langRule}\n${memCtx}\n${intentHint}\nAnswer directly without re-introducing entities already discussed.\n${noClutter}\n${noFabrication}\n${contextFlag}`;

  const tasks: Record<QuestionType, { maxTokens: number; task: string }> = {
    definition:        { maxTokens: 1024,  task: "Define clearly in 2–5 sentences. Plain prose only." },
    brevity_requested: { maxTokens: 512,   task: "Answer in 1–2 sentences only." },
    simple_qa:         { maxTokens: 2048,  task: "Answer directly. 3–8 sentences or short bullets. No fabricated numbers." },
    analytical_short:  { maxTokens: 4096,  task: "cause → effect → evidence. Mark inferences with *(inference)*. One conclusion." },
    calculation:       { maxTokens: 4096,  task: "Final result FIRST. Steps in code block. Source values only. State missing data if any." },
    comparison:        { maxTokens: 6000,  task: "1–2 sentences upfront. Table if numerical (max 6×5). 3–5 qualitative bullets." },
    recommendation:    { maxTokens: 8000,  task: "1.Bottom Line 2.Evidence(bullets) 3.Table 4.Risk🔴/🟡/🟢 5.Recommendation" },
    research_critique: { maxTokens: 10000, task: "1.Claim 2.Evidence 3.Limitations🔴/🟡/🟢 4.Overall Assessment" },
  };

  const { maxTokens, task } = tasks[type];
  return {
    maxTokens,
    prompt: `You are a desalination research assistant.\n${base}\n\nTASK: ${task}\n${sources}\n\nQUESTION: ${question}`,
  };
}

// ─────────────────────────────────────────────────────────────
//  POST handler
// ─────────────────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  let trace: any = null;
  try {
    const body = await req.json();
    const question: string = body.question;
    const history: HistoryMsg[] = Array.isArray(body.history) ? body.history : [];
    const entityHistory: ActiveEntity[] = Array.isArray(body.entityHistory) ? body.entityHistory : [];

    if (!question) {
      return NextResponse.json({ error: "No question provided" }, { status: 400 });
    }

    const lang = detectLanguage(question);
    const normalized = normalizeInput(question);

    trace = langfuse.trace({
      name: "desalt-question",
      input: question,
      metadata: { lang },
    });

    const memory = buildMemory(history);

    // ── مسار الإكمال ────────────────────────────────────────────
    if (isContinuationCommand(normalized)) {
      trace?.update({ metadata: { path: "continuation" } });
      const lastMsg = [...history].reverse().find(m => m.role === "assistant");
      const partialAnswer = lastMsg?.content || "";
      const ar = detectLanguage(partialAnswer) === "ar";

      if (!partialAnswer) {
        return NextResponse.json({
          merge: false,
          answer: ar ? "لا توجد إجابة سابقة لإكمالها." : "There's no previous answer to continue.",
          references: [], entityHistory,
        });
      }

      const contPrompt = `Continue ONLY this exact answer. Same topic, same language, same tone. Output ONLY the missing part.

ANSWER SO FAR:
"${partialAnswer}"

LAST PART:
"…${partialAnswer.slice(-1500)}"

Rules:
- Do not repeat anything above.
- Stay on exact same subject.
- Language: ${ar ? "Arabic" : "English"}
- If complete: "${ar ? "✅ الإجابة مكتملة." : "✅ Answer complete."}"
- Never invent numbers.`;

      const { text, truncated: st } = await askGemini(
        contPrompt,
        Math.min(Math.max(8000, Math.ceil(partialAnswer.length / 2)), 32000),
        trace, "continuation"
      );
      const contAnswer = cleanAnswerForUser(sanitizeRepetition(text)) || (ar ? "تعذّر إكمال الإجابة." : "Could not continue.");
      trace?.update({ output: contAnswer });
      return NextResponse.json({
        merge: true,
        answer: contAnswer,
        truncated: st,
        references: [],
        entityHistory,
      });
    }

    // ── Conversation Manager ─────────────────────────────────────
    const messageType = await classifyMessage(normalized, history, memory, trace);
    trace?.update({ metadata: { messageType, entity: memory.entity?.name || "none" } });

    // ── Chat → Gemini مباشرة بدون RAG ───────────────────────────
    if (messageType === "chat" || messageType === "greeting") {
      const { text: reply, truncated: chatTrunc } = await generateChatResponse(normalized, memory, lang, trace);
      trace?.update({ output: reply });
      return NextResponse.json({ merge: false, answer: reply, truncated: chatTrunc, references: [], entityHistory });
    }

    // ── Research / Followup → RAG ────────────────────────────────
    const isFollowup = messageType === "followup";
    const entityFromQ = detectEntityFromText(normalized);
    const currentEntity = entityFromQ || (isFollowup ? memory.entity : null);
    const isNewEntity = !!entityFromQ;

    const searchQuery = buildSearchQuery(normalized, memory, isFollowup);
    console.log(`[RAG] type="${messageType}" entity="${currentEntity?.name}" focus="${memory.focus}" query="${searchQuery}"`);
    trace?.update({ metadata: { searchQuery } });

    const { context, referencesContext, imageResults, references, filenames } = await retrieve(searchQuery, trace);

    if (!context.trim() && imageResults.length === 0) {
      const { text: noDataReply, truncated: noDataTrunc } = await generateChatResponse(normalized, {
        ...memory,
        lastAnswer: "لا تتوفر معلومات عن هذا الموضوع في المستندات.",
      }, lang, trace);
      trace?.update({ output: noDataReply, metadata: { noResults: true } });
      return NextResponse.json({ merge: false, answer: noDataReply, truncated: noDataTrunc, references: [], entityHistory, sourceFileIds: [], usedContext: false });
    }

    const updatedMemory: ConversationMemory = {
      entity: currentEntity,
      topic: isFollowup ? memory.topic : normalized,
      focus: isFollowup ? (memory.focus || extractFocus(normalized)) : extractFocus(normalized),
      lastQuestion: normalized,
      lastAnswer: memory.lastAnswer,
      lastChunks: context.slice(0, 1000),
      intent: detectResearchIntent(normalized) || memory.intent,
    };

    const type = classifyQuestionType(normalized);
    const refsRequested = isReferencesRequested(normalized);

    const { prompt, maxTokens } = buildResearchPrompt({
      type,
      question: normalized,
      context,
      referencesContext,
      memory: updatedMemory,
      refsRequested,
      lang,
    });

    const { text, truncated } = await askGemini(prompt, maxTokens, trace, "research-answer");

    const usedContext = !/\[CTX:NONE\]/.test(text);
    const cleanedText = text.replace(/\[CTX:(USED|NONE)\]/g, "").trim();
    const answer = cleanAnswerForUser(sanitizeRepetition(cleanedText));

    const newEntityHistory = isNewEntity && currentEntity
      ? [...entityHistory, currentEntity]
      : entityHistory;

    const relevantImages = imageResults
      .filter(m => (m.score ?? 0) > 0.2)
      .slice(0, 3)
      .map(m => ({
        url: `/api/images/${encodeURIComponent(`${String(m.metadata?.filename).replace(/\.pdf$/i, "")}-page${m.metadata?.page}.png`)}`,
        page: m.metadata?.page,
        type: m.metadata?.chunk_type,
        description: String(m.metadata?.text ?? "").slice(0, 150),
      }));

    trace?.update({
      output: answer,
      metadata: { usedContext, questionType: type, sourceFiles: filenames, imagesReturned: usedContext ? relevantImages.length : 0 },
    });

    return NextResponse.json({
      merge: false,
      answer: answer || (lang === "ar" ? "تعذّر توليد إجابة." : "Could not generate an answer."),
      images: usedContext ? relevantImages : [],
      references,
      truncated,
      entityHistory: newEntityHistory,
      detectedEntity: currentEntity,
      sourceFileIds: usedContext ? filenames : [],
      usedContext,
    });

  } catch (error) {
    console.error(error);
    trace?.update({ output: "error", metadata: { error: String(error) } });
    if (error instanceof Error && error.message === "VECTOR_STORE_DOWN") {
      return NextResponse.json({
        merge: false,
        answer: "قاعدة البيانات المحلية غير متاحة حالياً. تأكد من تشغيل Qdrant ثم أعد المحاولة.",
        references: [],
        entityHistory: [],
      });
    }
    if (error instanceof Error && /resource exhausted|429/i.test(error.message)) {
      return NextResponse.json({
        merge: false,
        answer: "الخدمة مشغولة مؤقتاً بسبب كثرة الطلبات. انتظر دقيقة ثم أعد سؤالك.",
        references: [],
        entityHistory: [],
      });
    }
    return NextResponse.json({ error: "Failed to process the question." }, { status: 500 });
  } finally {
    await langfuse.flushAsync();
  }
}