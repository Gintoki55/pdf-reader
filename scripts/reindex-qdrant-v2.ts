// scripts/reindex-qdrant-v2.ts
// فهرسة محسّنة: تقسيم أصغر مع تداخل + metadata موسّعة + hybrid (dense + BM25)
// يكتب في collection جديدة v2 — لا يلمس الحالية

import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { QdrantClient } from "@qdrant/js-client-rest";
import { extractText } from "unpdf";
import { stableUuid, bm25Tokens } from "../lib/vectorstore";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333" });

const V1_COLLECTION = "desaltai_chunks";
const V2_COLLECTION = "desaltai_chunks_v2";
const DIMENSION = 3072;

const PDF_DIR = path.join(process.cwd(), "pdfs");
const GUIDES_DIR = path.join(process.cwd(), "public", "source-guides");
const IMAGES_DIR = path.join(process.cwd(), "extracted_images");

// ─────────────────────────────────────────────
// التقسيم المحسّن: ~250 كلمة مع تداخل 15%
// ─────────────────────────────────────────────
function chunkTextV2(text: string, chunkWords = 250, overlapWords = 40): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  if (words.length <= chunkWords) return [words.join(" ")];

  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkWords, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start = end - overlapWords; // ★ التداخل — يمنع ضياع المعلومة على الحدود
  }
  return chunks;
}

// ─────────────────────────────────────────────
// metadata المستند من دليله الجاهز
// ─────────────────────────────────────────────
function loadDocMeta(filename: string) {
  const yearMatch = filename.match(/_(\d{4})_/);
  const doc_year = yearMatch ? parseInt(yearMatch[1]) : 0;

  try {
    const guide = JSON.parse(
      fs.readFileSync(path.join(GUIDES_DIR, `${filename}.json`), "utf-8")
    );
    return {
      doc_title: String(guide.title || filename),
      doc_year,
      doc_topics: Array.isArray(guide.keyTopics) ? guide.keyTopics.map(String) : [],
      source_type: "journal",
    };
  } catch {
    return { doc_title: filename, doc_year, doc_topics: [] as string[], source_type: "journal" };
  }
}

function imageUrlIfExists(filename: string, page: number | null): string | null {
  if (page == null) return null;
  const base = filename.replace(/\.pdf$/i, "");
  const imgName = `${base}-page${page}.png`;
  return fs.existsSync(path.join(IMAGES_DIR, imgName))
    ? `/api/images/${encodeURIComponent(imgName)}`
    : null;
}

async function embed(texts: string[]): Promise<number[][]> {
  const res = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: texts,
  });
  return res.data.map(d => d.embedding);
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  // ═══ 1. إنشاء collection v2 بمخطط hybrid ═══
  const collections = await qdrant.getCollections();
  if (collections.collections.some(c => c.name === V2_COLLECTION)) {
    console.log(`⚠️ ${V2_COLLECTION} موجودة — سيُعاد استخدامها (احذفها من الداشبورد لبداية نظيفة)`);
  } else {
    await qdrant.createCollection(V2_COLLECTION, {
      vectors: { dense: { size: DIMENSION, distance: "Cosine" } },
      sparse_vectors: { bm25: { modifier: "idf" } },
    });
    for (const field of ["chunk_type", "filename", "section", "source_type", "doc_topics"]) {
      await qdrant.createPayloadIndex(V2_COLLECTION, { field_name: field, field_schema: "keyword" });
    }
    await qdrant.createPayloadIndex(V2_COLLECTION, { field_name: "doc_year", field_schema: "integer" });
    await qdrant.createPayloadIndex(V2_COLLECTION, { field_name: "page", field_schema: "integer" });
    await qdrant.createPayloadIndex(V2_COLLECTION, { field_name: "text", field_schema: "text" });
    console.log(`✅ أنشئت ${V2_COLLECTION} (hybrid: dense + bm25)`);
  }

  // ═══ 2. النصوص: إعادة تقسيم وembedding من الـ PDFs ═══
  const pdfFiles = fs.readdirSync(PDF_DIR).filter(f => f.toLowerCase().endsWith(".pdf"));
  console.log(`\n📚 ${pdfFiles.length} ملف PDF`);

  for (const file of pdfFiles) {
    console.log(`\n🔨 ${file}`);
    const docMeta = loadDocMeta(file);
    console.log(`  📖 "${docMeta.doc_title.slice(0, 50)}" (${docMeta.doc_year})`);

    const buffer = fs.readFileSync(path.join(PDF_DIR, file));
    const result = await extractText(new Uint8Array(buffer), { mergePages: true });
    const fullText = typeof result.text === "string" ? result.text : String(result.text ?? "");

    if (fullText.length < 500) {
      console.log(`  ⚠️ نص قليل — تخطي`);
      continue;
    }

    const chunks = chunkTextV2(fullText);
    console.log(`  ✂️ ${chunks.length} chunk (250 كلمة، تداخل 40)`);

    // embeddings بدفعات
    for (let i = 0; i < chunks.length; i += 20) {
      const batch = chunks.slice(i, i + 20);
      const vectors = await embed(batch);

      const points = batch.map((text, j) => {
        const originalId = `${file}-v2-text-${i + j}`;
        return {
          id: stableUuid(originalId),
          vector: { dense: vectors[j], bm25: bm25Tokens(text) },
          payload: {
            text,
            filename: file,
            chunk_type: "text",
            chunk_index: i + j,
            page: 0,
            section: "",
            ...docMeta,
            image_url: null,
            original_id: originalId,
          },
        };
      });

      await qdrant.upsert(V2_COLLECTION, { wait: true, points });
      console.log(`  🚚 نصوص ${Math.min(i + 20, chunks.length)}/${chunks.length}`);
      await sleep(200);
    }
  }

  // ═══ 3. الأشكال/الجداول/المراجع: نسخ من v1 (تحليل Gemini السابق) ═══
  console.log(`\n📷 نسخ chunks الأشكال والجداول والمراجع من v1...`);
  let copied = 0;
  let offset: any = undefined;
  do {
    const res: any = await qdrant.scroll(V1_COLLECTION, {
      filter: {
        must: [{
          key: "chunk_type",
          match: { any: ["figure", "graph", "table", "chart", "diagram", "microscopy", "flowchart", "references_index", "links"] },
        }],
      },
      limit: 50,
      offset,
      with_payload: true,
      with_vector: true,
    });

    const points = (res.points || []).map((p: any) => {
      const payload = p.payload || {};
      const filename = String(payload.filename || "");
      const page = payload.page != null ? Number(payload.page) : null;
      const docMeta = loadDocMeta(filename);
      const text = String(payload.text || "");
      // vector قد يكون مصفوفة مباشرة (v1 بلا أسماء)
      const denseVec = Array.isArray(p.vector) ? p.vector : p.vector?.dense;

      return {
        id: p.id, // نفس UUID من v1
        vector: { dense: denseVec, bm25: bm25Tokens(text) },
        payload: {
          ...payload,
          ...docMeta,
          caption: text.slice(0, 300),
          image_url: imageUrlIfExists(filename, page),
        },
      };
    }).filter((p: any) => Array.isArray(p.vector.dense) && p.vector.dense.length === DIMENSION);

    if (points.length > 0) {
      await qdrant.upsert(V2_COLLECTION, { wait: true, points });
      copied += points.length;
      console.log(`  🚚 موارد ${copied}`);
    }
    offset = res.next_page_offset;
  } while (offset != null);

  // ═══ 4. تحقق نهائي ═══
  const info = await qdrant.getCollection(V2_COLLECTION);
  console.log(`\n✅ v2 جاهزة: ${info.points_count} نقطة`);
  console.log(`\n👉 للتبديل: QDRANT_COLLECTION=${V2_COLLECTION} في .env.local ثم أعد تشغيل السيرفر`);
}

main().catch(err => { console.error("❌", err); process.exit(1); });