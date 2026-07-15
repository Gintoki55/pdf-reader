// scripts/migrate-to-qdrant.ts
import { config } from "dotenv";
config({ path: ".env.local" });

import { Pinecone } from "@pinecone-database/pinecone";
import { QdrantClient } from "@qdrant/js-client-rest";
import crypto from "crypto";

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const qdrant = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333" });
const COLLECTION = process.env.QDRANT_COLLECTION || "desaltai_chunks";
const DIMENSION = 3072;

function stableUuid(originalId: string): string {
  const hash = crypto.createHash("md5").update(originalId).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

async function main() {
  // 1. إنشاء الـ collection إن لم توجد
  const collections = await qdrant.getCollections();
  if (!collections.collections.some(c => c.name === COLLECTION)) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: DIMENSION, distance: "Cosine" },
    });
    await qdrant.createPayloadIndex(COLLECTION, { field_name: "chunk_type", field_schema: "keyword" });
    await qdrant.createPayloadIndex(COLLECTION, { field_name: "filename", field_schema: "keyword" });
    console.log(`✅ أنشئت collection: ${COLLECTION}`);
  } else {
    console.log(`⏭️ collection موجودة: ${COLLECTION}`);
  }

  const index = pinecone.index(process.env.PINECONE_INDEX!);

  // 2. جلب كل الـ vectors باستعلام zero-vector واحد
  //    (يتجاوز list/fetch كلياً — نعرف أن query يعمل لأن retrieve يستخدمه)
  console.log("📥 جلب كل الـ vectors من Pinecone (query شامل)...");
  const res = await index.query({
    vector: new Array(DIMENSION).fill(0),
    topK: 1000, // أكبر بكثير من 112
    includeMetadata: true,
    includeValues: true, // ★ المفتاح: نبي الـ embeddings نفسها
  });

  const matches = (res.matches || []).filter(
    m => Array.isArray(m.values) && m.values.length === DIMENSION
  );
  console.log(`📊 ${matches.length} vector جاهز للنقل`);

  if (matches.length === 0) {
    console.log("❌ لا vectors — تحقق من PINECONE_INDEX");
    return;
  }

  // 3. نسخ دفعات إلى Qdrant
  let migrated = 0;
  for (let i = 0; i < matches.length; i += 100) {
    const batch = matches.slice(i, i + 100);
    const points = batch.map(m => ({
      id: stableUuid(String(m.id)),
      vector: m.values as number[],
      payload: { ...(m.metadata || {}), original_id: String(m.id) },
    }));

    await qdrant.upsert(COLLECTION, { wait: true, points });
    migrated += points.length;
    console.log(`  🚚 ${migrated}/${matches.length}`);
  }

  // 4. تحقق نهائي
  const info = await qdrant.getCollection(COLLECTION);
  console.log(`\n✅ انتهى الترحيل: ${info.points_count} نقطة في Qdrant`);
}

main().catch(err => { console.error("❌", err); process.exit(1); });