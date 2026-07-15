import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { DocumentProcessorServiceClient } from "@google-cloud/documentai";
import { GoogleAuth } from "google-auth-library";
import { PDFDocument } from "pdf-lib";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

const auth = new GoogleAuth({
  keyFilename: "./service-account.json",
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const client = new DocumentProcessorServiceClient({
  keyFilename: "./service-account.json",
});

const processorName = `projects/${process.env.GOOGLE_PROJECT_ID}/locations/${process.env.GOOGLE_LOCATION}/processors/${process.env.GOOGLE_PROCESSOR_ID}`;

const PDF_DIR = path.join(process.cwd(), "pdfs");
const INDEXED_FILE = path.join(process.cwd(), "indexed.json");

console.log("indexed.json موجود:", fs.existsSync(INDEXED_FILE));
const indexed: string[] = fs.existsSync(INDEXED_FILE)
  ? JSON.parse(fs.readFileSync(INDEXED_FILE, "utf-8"))
  : [];
console.log("عدد المفهرس:", indexed.length);

// ─── استخراج النص بـ Google Document AI ────
async function extractText(buffer: Buffer): Promise<string> {
  const encodedContent = buffer.toString("base64");
  const [result] = await client.processDocument({
    name: processorName,
    rawDocument: { content: encodedContent, mimeType: "application/pdf" },
    imagelessMode: true,
  });
  return result.document?.text || "";
}

// ─── اكتشاف عناوين الأقسام في النص ──────────
const SECTION_HEADING_REGEX = /(?:^|\n)\s*((?:Section\s+)?\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[A-Z][A-Za-z0-9\s,\-:()]{3,80})(?=\n|\s{2,})/g;

function extractSectionMap(fullText: string): { position: number; title: string }[] {
  const headings: { position: number; title: string }[] = [];
  let match;
  const regex = new RegExp(SECTION_HEADING_REGEX);
  while ((match = regex.exec(fullText)) !== null) {
    headings.push({ position: match.index, title: match[1].trim().replace(/\s+/g, " ") });
  }
  return headings;
}

function findNearestSection(
  sections: { position: number; title: string }[],
  chunkStartPosition: number
): string | null {
  let nearest: string | null = null;
  for (const s of sections) {
    if (s.position <= chunkStartPosition) {
      nearest = s.title;
    } else {
      break;
    }
  }
  return nearest;
}

// ─── استخراج روابط URL مطبوعة كنص عادي وربطها برقم المرجع القريب ──
// يبحث عن أنماط مثل "[7] ... https://www.sciencedirect.com/..." في نفس السطر أو السطر التالي
function extractPrintedReferenceLinks(fullText: string): Map<string, string> {
  const map = new Map<string, string>();
  const urlRegex = /https?:\/\/[^\s)\]"]+/g;
  const lines = fullText.split("\n");

  let lastSeenNumber: string | null = null;
  for (const line of lines) {
    const numberMatch = line.match(/^\s*\[(\d{1,3})\]/);
    if (numberMatch) {
      lastSeenNumber = numberMatch[1];
    }
    const urlMatches = line.match(urlRegex);
    if (urlMatches && lastSeenNumber) {
      // أول رابط فقط لكل رقم مرجع، نظّفه من علامات ترقيم لاحقة شائعة
      const cleanedUrl = urlMatches[0].replace(/[.,;]+$/, "");
      if (!map.has(lastSeenNumber)) {
        map.set(lastSeenNumber, cleanedUrl);
      }
    }
  }
  return map;
}

// ─── تحليل الصور والجداول بـ Gemini عبر Vertex AI (مع أرقام وعناوين) ──
async function analyzeWithGemini(buffer: Buffer): Promise<{
  figures: { number: string; caption: string; description: string; page: number | null }[];
  graphs: { number: string; caption: string; description: string; page: number | null }[];
  tables: { number: string; caption: string; description: string; page: number | null }[];
}> {
  const authClient = await auth.getClient();
  const token = await authClient.getAccessToken();

  const projectId = process.env.GOOGLE_PROJECT_ID;
  const location = "us-central1";
  const base64PDF = buffer.toString("base64");

  const response = await fetch(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: base64PDF } },
            {
              text: `Analyze this academic paper and extract visual content as JSON. For EVERY figure, graph, and table, extract its actual number and caption exactly as printed in the paper (e.g. "Figure 6", "Table 1"), plus the page number it appears on.

Return ONLY valid JSON with this exact structure:
{
  "figures": [
    {"number": "Figure 6", "caption": "exact caption text as printed", "description": "short description, max 40 words", "page": 8}
  ],
  "graphs": [
    {"number": "Figure 2", "caption": "exact caption text", "description": "axis labels and key finding, max 40 words", "page": 5}
  ],
  "tables": [
    {"number": "Table 1", "caption": "exact caption text", "description": "key data, max 40 words", "page": 3}
  ]
}

If a number or caption cannot be determined, use empty string "". If page cannot be determined, use null.
Be concise in description. Return ONLY valid, complete JSON — no truncation, no markdown fences.`,
            },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 32768 },
      }),
    }
  );

  const data = await response.json();

  if (data.error) {
    console.log(`    ⚠️ Gemini خطأ:`, data.error.message);
    return { figures: [], graphs: [], tables: [] };
  }

  try {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    console.log("    📝 طول الرد:", text.length, "| نهاية الرد:", text.slice(-100));
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);

    const normalize = (arr: any[]): { number: string; caption: string; description: string; page: number | null }[] => {
      if (!Array.isArray(arr)) return [];
      return arr.map(item => ({
        number: typeof item === "object" ? String(item.number || "") : "",
        caption: typeof item === "object" ? String(item.caption || "") : "",
        description: typeof item === "object" ? String(item.description || JSON.stringify(item)) : String(item),
        page: typeof item === "object" && item.page != null ? Number(item.page) : null,
      }));
    };

    return {
      figures: normalize(parsed.figures),
      graphs: normalize(parsed.graphs),
      tables: normalize(parsed.tables),
    };
  } catch (parseErr) {
    console.log("    ⚠️ فشل الـ JSON parse:", parseErr instanceof Error ? parseErr.message : parseErr);
    return { figures: [], graphs: [], tables: [] };
  }
}

// ─── استخراج قائمة References وبناء روابطها ──
async function extractReferences(buffer: Buffer): Promise<{ number: string; authors: string; title: string; doi: string; url: string }[]> {
  const authClient = await auth.getClient();
  const token = await authClient.getAccessToken();

  const projectId = process.env.GOOGLE_PROJECT_ID;
  const location = "us-central1";
  const base64PDF = buffer.toString("base64");

  const response = await fetch(
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inlineData: { mimeType: "application/pdf", data: base64PDF } },
            {
              text: `Find the "References" or "Bibliography" section, usually near the end of this academic paper — the numbered list of cited external works (other papers, books, reports).

For EVERY numbered entry in that list, extract:
- number: the reference number as printed (e.g. "7")
- authors: author names as printed, even abbreviated (e.g. "X. Ruan, M. Song, Z. Fang, et al.")
- title: the title of the cited work as printed
- doi: the bare DOI string only if explicitly printed (no "https://doi.org/" prefix), otherwise ""
- url: any full URL explicitly printed for that entry, otherwise ""

Return ONLY valid JSON array, no markdown fences:
[
  {"number": "7", "authors": "X. Ruan, M. Song, Z. Fang, et al.", "title": "Methods to treat industrial salted waste: a review", "doi": "", "url": ""}
]

Rules:
- Include every entry that has a title and/or author names, even if some fields are empty — do not skip entries just because DOI or URL is missing
- Only skip an entry if it has NEITHER a title NOR any author/initial — i.e. skip only clearly broken/empty entries
- Do not guess or construct DOIs/URLs — leave empty if not literally printed
- Return ONLY the JSON array, no explanation, no truncation`,
            },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 16384 },
      }),
    }
  );

  const data = await response.json();
  if (data.error) {
    console.log(`    ⚠️ Gemini خطأ (references):`, data.error.message);
    return [];
  }

  try {
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
    const cleaned = text.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((r: any) => ({
        number: String(r.number || ""),
        authors: String(r.authors || "").trim(),
        title: String(r.title || "").trim(),
        doi: String(r.doi || "").trim(),
        url: String(r.url || "").trim(),
      }))
      // فلتر مخفّف: ارفض فقط إذا لا يوجد عنوان ولا مؤلفين معاً (إدخال فارغ فعلياً)
      .filter(r => (r.title.length > 0 || r.authors.length > 0));
  } catch (parseErr) {
    console.log("    ⚠️ فشل parse للمراجع:", parseErr instanceof Error ? parseErr.message : parseErr);
    return [];
  }
}

function buildReferenceLink(
  ref: { number: string; authors: string; title: string; doi: string; url: string },
  printedLinksMap: Map<string, string>
): string {
  // الأولوية: رابط مطبوع فعلياً بجانب نفس الرقم في النص (الأدق)
  const printedLink = printedLinksMap.get(ref.number);
  if (printedLink) return printedLink;
  if (ref.doi) return `https://doi.org/${ref.doi}`;
  if (ref.url) return ref.url;
  const query = encodeURIComponent(`${ref.authors} ${ref.title}`.trim());
  return `https://scholar.google.com/scholar?q=${query}`;
}

// ─── استخراج الروابط المضمّنة (hyperlink annotations) ──
async function extractLinks(buffer: Buffer): Promise<string[]> {
  try {
    const pdfDoc = await PDFDocument.load(buffer);
    const links: string[] = [];
    for (const page of pdfDoc.getPages()) {
      try {
        const annotations = (page.node as any).Annots();
        if (!annotations) continue;
        for (let i = 0; i < annotations.size(); i++) {
          try {
            const annot = annotations.lookup(i) as any;
            const uri = annot?.get(annot.context.obj("URI"));
            if (uri) links.push(uri.toString());
          } catch {}
        }
      } catch {}
    }
    return links;
  } catch {
    return [];
  }
}

// ─── تحويل نص لـ embedding ──────────────────
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

// ─── تقطيع النص مع تتبع الموضع الأصلي (لربط القسم) ──
function chunkTextWithPosition(text: string, chunkSize = 300): { text: string; startPosition: number }[] {
  const words = text.split(/\s+/).filter(w => w.length > 0);
  const chunks: { text: string; startPosition: number }[] = [];
  let cursor = 0;

  for (let i = 0; i < words.length; i += chunkSize) {
    const chunkWords = words.slice(i, i + chunkSize);
    const chunkStr = chunkWords.join(" ");
    const startPosition = cursor;
    cursor += chunkStr.length + 1;
    if (chunkStr.trim().length > 0) {
      chunks.push({ text: chunkStr, startPosition });
    }
  }
  return chunks;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Main ────────────────────────────────────
async function main() {
  const files = fs.readdirSync(PDF_DIR)
    .filter(f => f.endsWith(".pdf") && !f.toLowerCase().includes("copy"));
  console.log(`وجدت ${files.length} ملف PDF`);

  const newFiles = files.filter(f => !indexed.includes(f));
  console.log(`جديد: ${newFiles.length} | تم فهرسته: ${indexed.length}\n`);

  if (newFiles.length === 0) {
    console.log("✅ كل الملفات مفهرسة بالفعل!");
    return;
  }

  const index = pinecone.index(process.env.PINECONE_INDEX!);

  for (let i = 0; i < newFiles.length; i++) {
    const file = newFiles[i];
    console.log(`\n[${i + 1}/${newFiles.length}] معالجة: ${file}`);

    try {
      const filePath = path.join(PDF_DIR, file);
      const buffer = fs.readFileSync(filePath);
      const vectors: any[] = [];
      let chunkCounter = 0;

      // 1. استخراج النص بـ Google Document AI
      console.log(`  📄 Google Document AI...`);
      const text = await extractText(buffer);
      console.log(`  ✅ ${text.length} حرف`);

      const sectionMap = extractSectionMap(text);
      console.log(`  📑 وجدت ${sectionMap.length} عنوان قسم محتمل`);

      // استخراج روابط مطبوعة كنص بجانب رقم مرجعها مباشرة من نفس النص
      const printedLinksMap = extractPrintedReferenceLinks(text);
      console.log(`  🔗 وجدت ${printedLinksMap.size} رابط URL مطبوع كنص بجانب رقم مرجع`);

      const textChunks = chunkTextWithPosition(text);
      for (const chunkObj of textChunks) {
        const sectionTitle = findNearestSection(sectionMap, chunkObj.startPosition);
        const embedding = await getEmbedding(chunkObj.text);
        vectors.push({
          id: `${file}-text-${chunkCounter++}`,
          values: embedding,
          metadata: {
            text: chunkObj.text.slice(0, 2000),
            filename: file,
            chunk_type: "text",
            section: sectionTitle || "",
          },
        });
        await sleep(100);
      }
      console.log(`  📦 ${textChunks.length} chunk نصي`);

      // 2. تحليل الصور والجداول بـ Gemini عبر Vertex AI
      console.log(`  🔍 Gemini Vision (Vertex AI)...`);
      const visual = await analyzeWithGemini(buffer);
      console.log(`  ✅ figures: ${visual.figures.length} | graphs: ${visual.graphs.length} | tables: ${visual.tables.length}`);

      for (const fig of visual.figures) {
        const fullText = `${fig.number}${fig.caption ? `: ${fig.caption}` : ""}. ${fig.description}`;
        const embedding = await getEmbedding(fullText);
        vectors.push({
          id: `${file}-figure-${chunkCounter++}`,
          values: embedding,
          metadata: {
            text: fullText.slice(0, 2000),
            filename: file,
            chunk_type: "figure",
            ref_number: fig.number,
            caption: fig.caption,
            page: fig.page,
          },
        });
        await sleep(100);
      }

      for (const graph of visual.graphs) {
        const fullText = `${graph.number}${graph.caption ? `: ${graph.caption}` : ""}. ${graph.description}`;
        const embedding = await getEmbedding(fullText);
        vectors.push({
          id: `${file}-graph-${chunkCounter++}`,
          values: embedding,
          metadata: {
            text: fullText.slice(0, 2000),
            filename: file,
            chunk_type: "graph",
            ref_number: graph.number,
            caption: graph.caption,
            page: graph.page,
          },
        });
        await sleep(100);
      }

      for (const table of visual.tables) {
        const fullText = `${table.number}${table.caption ? `: ${table.caption}` : ""}. ${table.description}`;
        const embedding = await getEmbedding(fullText);
        vectors.push({
          id: `${file}-table-${chunkCounter++}`,
          values: embedding,
          metadata: {
            text: fullText.slice(0, 2000),
            filename: file,
            chunk_type: "table",
            ref_number: table.number,
            caption: table.caption,
            page: table.page,
          },
        });
        await sleep(100);
      }

      // 3. استخراج الروابط المضمّنة (hyperlink annotations)
      console.log(`  🔗 استخراج الروابط المضمّنة...`);
      const links = await extractLinks(buffer);
      if (links.length > 0) {
        const linksText = `Links and URLs:\n${links.join("\n")}`;
        const embedding = await getEmbedding(linksText);
        vectors.push({
          id: `${file}-links-${chunkCounter++}`,
          values: embedding,
          metadata: { text: linksText.slice(0, 2000), filename: file, chunk_type: "links" },
        });
        console.log(`  ✅ ${links.length} رابط مضمّن`);
      }

      // 3.5 استخراج قائمة المراجع وبناء روابطها (مع أولوية للروابط المطبوعة فعلياً)
      console.log(`  📚 استخراج قائمة المراجع...`);
      const references = await extractReferences(buffer);
      if (references.length > 0) {
        const refsWithLinks = references.map(r => ({
          ...r,
          link: buildReferenceLink(r, printedLinksMap),
        }));
        const refsText = refsWithLinks
          .map(r => `[${r.number}] ${r.authors ? r.authors + ". " : ""}${r.title}${r.title ? ". " : ""}Link: ${r.link}`)
          .join("\n");
        const embedding = await getEmbedding(refsText);
        vectors.push({
          id: `${file}-references-index`,
          values: embedding,
          metadata: {
            text: refsText.slice(0, 4000),
            filename: file,
            chunk_type: "references_index",
          },
        });
        console.log(`  ✅ ${references.length} مرجع مستخرج (${[...printedLinksMap.keys()].length} برابط مطبوع فعلي)`);
      }

      // 4. تخزين في Pinecone
      console.log(`  📊 إجمالي الـ chunks: ${vectors.length}`);
      const batchSize = 50;
      for (let b = 0; b < vectors.length; b += batchSize) {
        await index.upsert({ records: vectors.slice(b, b + batchSize) });
        await sleep(200);
      }

      console.log(`  🚀 تم تخزين ${vectors.length} chunk في Pinecone`);
      indexed.push(file);
      fs.writeFileSync(INDEXED_FILE, JSON.stringify(indexed, null, 2));

    } catch (error) {
      console.error(`  ❌ خطأ في ${file}:`, error);
    }

    await sleep(1000);
  }

  console.log("\n✅ انتهت الفهرسة كاملاً!");
  console.log(`📊 إجمالي المفهرس: ${indexed.length} ملف`);
}

main();