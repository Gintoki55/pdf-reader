// scripts/generate-guides.ts
import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import { GoogleAuth } from "google-auth-library";

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const auth = new GoogleAuth({
  keyFilename: "./service-account.json",
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

const INDEXED_FILE = path.join(process.cwd(), "indexed.json");
const GUIDES_DIR = path.join(process.cwd(), "public", "source-guides");

// نفس أبعاد text-embedding-3-large
const ZERO_VECTOR = new Array(3072).fill(0);

type ParsedReference = { number: string; authors: string; title: string; url: string };

function parseReferencesFromText(text: string): ParsedReference[] {
  const refs: ParsedReference[] = [];
  for (const line of text.split("\n").filter(l => l.trim())) {
    const m = line.match(/^\[(\d+)\]\s*(.+)/);
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

async function fetchChunksByType(index: any, filename: string, chunkTypes: string[], topK: number) {
  const res = await index.query({
    vector: ZERO_VECTOR,
    topK,
    includeMetadata: true,
    filter: { filename, chunk_type: { $in: chunkTypes } },
  });
  return res.matches || [];
}

// ★ ترتيب الـ chunks حسب رقمها في الـ id (file-text-0, file-text-1, ...)
// بدون هذا، النص يصل لـ Gemini مبعثراً والعنوان (الموجود في chunk 0) قد يضيع
function sortChunksById(chunks: any[]): any[] {
  return [...chunks].sort((a: any, b: any) => {
    const na = parseInt(a.id?.match(/-text-(\d+)$/)?.[1] ?? "0");
    const nb = parseInt(b.id?.match(/-text-(\d+)$/)?.[1] ?? "0");
    return na - nb;
  });
}

async function askGeminiForMeta(fullText: string, filename: string) {
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const projectId = process.env.GOOGLE_PROJECT_ID;

  const response = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text:
`From this academic paper text, return ONLY valid JSON, no markdown fences:
{
  "title": "the paper title as printed at the very beginning of the paper",
  "summary": "3-4 sentences: what the paper studies and its main findings",
  "keyTopics": ["5-8 short key topics, 1-4 words each"]
}
The title usually appears in the first few lines, before author names and abstract.
Paper text:
${fullText.slice(0, 30000)}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
      }),
    }
  );

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  try {
    const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());
    return {
      title: String(parsed.title || filename),
      summary: String(parsed.summary || ""),
      keyTopics: Array.isArray(parsed.keyTopics) ? parsed.keyTopics.map(String).slice(0, 8) : [],
    };
  } catch {
    return { title: filename, summary: "", keyTopics: [] };
  }
}

// ★ فحص جودة نتيجة Gemini — عنوان = اسم الملف أو ملخص فارغ يعني نتيجة مكسورة
function isMetaBroken(meta: { title: string; summary: string }, filename: string): boolean {
  return meta.title === filename || meta.summary.trim().length === 0;
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!fs.existsSync(INDEXED_FILE)) {
    console.log("❌ لا يوجد indexed.json — لا ملفات مفهرسة.");
    return;
  }
  const files: string[] = JSON.parse(fs.readFileSync(INDEXED_FILE, "utf-8"));
  console.log(`📚 ${files.length} ملف مفهرس`);

  if (!fs.existsSync(GUIDES_DIR)) fs.mkdirSync(GUIDES_DIR, { recursive: true });

  const index = pinecone.index(process.env.PINECONE_INDEX!);

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const outPath = path.join(GUIDES_DIR, `${file}.json`);

    if (fs.existsSync(outPath)) {
      console.log(`[${i + 1}/${files.length}] ⏭️ موجود: ${file}`);
      continue;
    }

    console.log(`\n[${i + 1}/${files.length}] 🔨 ${file}`);
    try {
      // 1. نص الملف من text chunks — ★ مرتّبة حسب الـ id
      const rawChunks = await fetchChunksByType(index, file, ["text"], 200);
      const textChunks = sortChunksById(rawChunks);
      const fullText = textChunks
        .map((m: any) => String(m.metadata?.text ?? ""))
        .join("\n");
      console.log(`  📄 ${textChunks.length} text chunk (${fullText.length} حرف)`);

      if (fullText.length < 500) {
        console.log(`  ⚠️ نص قليل جداً — تخطي`);
        continue;
      }

      // 2. الأشكال والجداول من metadata
      const visualChunks = await fetchChunksByType(index, file, ["figure", "graph", "table"], 100);
      const figures = visualChunks
        .filter((m: any) => m.metadata?.chunk_type === "figure" || m.metadata?.chunk_type === "graph")
        .map((m: any) => ({
          number: String(m.metadata?.ref_number ?? ""),
          caption: String(m.metadata?.caption ?? ""),
          page: m.metadata?.page != null ? Number(m.metadata.page) : null,
        }));
      const tables = visualChunks
        .filter((m: any) => m.metadata?.chunk_type === "table")
        .map((m: any) => ({
          number: String(m.metadata?.ref_number ?? ""),
          caption: String(m.metadata?.caption ?? ""),
          page: m.metadata?.page != null ? Number(m.metadata.page) : null,
        }));
      console.log(`  🖼️ ${figures.length} شكل | 📊 ${tables.length} جدول`);

      // 3. المراجع من references_index
      const refChunks = await fetchChunksByType(index, file, ["references_index"], 3);
      const references = refChunks.flatMap((m: any) =>
        parseReferencesFromText(String(m.metadata?.text ?? ""))
      );
      console.log(`  📚 ${references.length} مرجع`);

      // 4. Gemini: عنوان + ملخص + مواضيع — ★ مع محاولة ثانية لو النتيجة مكسورة
      console.log(`  🤖 Gemini...`);
      let meta = await askGeminiForMeta(fullText, file);
      if (isMetaBroken(meta, file)) {
        console.log(`  ⚠️ نتيجة مكسورة (عنوان=اسم الملف أو ملخص فارغ) — محاولة ثانية...`);
        await sleep(1500);
        const retry = await askGeminiForMeta(fullText, file);
        if (!isMetaBroken(retry, file)) {
          meta = retry;
          console.log(`  ✅ المحاولة الثانية نجحت`);
        } else {
          console.log(`  ⚠️ المحاولة الثانية فشلت أيضاً — سيُحفظ بالقيم الناقصة (احذف الـ JSON وأعد التشغيل لاحقاً)`);
        }
      }
      console.log(`  ✅ "${meta.title.slice(0, 60)}"`);

      // 5. الحفظ
      const guide = {
        fileId: file,
        filename: file,
        title: meta.title,
        summary: meta.summary,
        keyTopics: meta.keyTopics,
        figures,
        tables,
        references,
        generatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(outPath, JSON.stringify(guide, null, 2));
      console.log(`  💾 محفوظ: public/source-guides/${file}.json`);

    } catch (err) {
      console.error(`  ❌ خطأ في ${file}:`, err instanceof Error ? err.message : err);
    }

    await sleep(500);
  }

  console.log("\n✅ انتهى توليد الأدلة.");
}

main();