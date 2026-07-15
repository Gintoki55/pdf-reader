// lib/vectorstore.ts
import { QdrantClient } from "@qdrant/js-client-rest";
import crypto from "crypto";

export type VectorPoint = {
  id: string;
  vector: number[];
  payload: Record<string, any>;
};

export type SearchOptions = {
  topK: number;
  filter?: {
    chunk_type?: string | string[];
    filename?: string | string[];
    doc_year?: number;
    doc_topics?: string[];
  };
  /** نص السؤال الخام — لو مُرّر ودعمت الـ collection الـ hybrid، يُفعَّل BM25 */
  queryText?: string;
};

export type SearchResult = {
  id: string;
  score: number;
  metadata: Record<string, any>;
};

export function stableUuid(originalId: string): string {
  const hash = crypto.createHash("md5").update(originalId).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

// ─── tokenizer بسيط لـ BM25 sparse (يدعم العربية والإنجليزية) ───
export function bm25Tokens(text: string): { indices: number[]; values: number[] } {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(w => w.length > 1);

  const counts = new Map<number, number>();
  for (const w of words) {
    // hash الكلمة إلى index ثابت
    const h = parseInt(crypto.createHash("md5").update(w).digest("hex").slice(0, 8), 16);
    counts.set(h, (counts.get(h) || 0) + 1);
  }
  return {
    indices: [...counts.keys()],
    values: [...counts.values()],
  };
}

const COLLECTION = () => process.env.QDRANT_COLLECTION || "desaltai_chunks";

class QdrantStore {
  client: QdrantClient;
  private hybridSupported: boolean | null = null;

  constructor() {
    this.client = new QdrantClient({ url: process.env.QDRANT_URL || "http://localhost:6333" });
  }

  /** يكتشف مرة واحدة هل الـ collection الحالية تدعم hybrid (named vectors + sparse) */
  private async supportsHybrid(): Promise<boolean> {
    if (this.hybridSupported !== null) return this.hybridSupported;
    try {
      const info: any = await this.client.getCollection(COLLECTION());
      const vectors = info.config?.params?.vectors;
      const sparse = info.config?.params?.sparse_vectors;
      this.hybridSupported = !!(vectors?.dense && sparse?.bm25);
    } catch {
      this.hybridSupported = false;
    }
    return this.hybridSupported;
  }

  private buildFilter(f?: SearchOptions["filter"]) {
    if (!f) return undefined;
    const must: any[] = [];
    if (f.chunk_type) {
      const types = Array.isArray(f.chunk_type) ? f.chunk_type : [f.chunk_type];
      must.push({ key: "chunk_type", match: { any: types } });
    }
    if (f.filename) {
      const files = Array.isArray(f.filename) ? f.filename : [f.filename];
      must.push({ key: "filename", match: { any: files } });
    }
    if (f.doc_year) must.push({ key: "doc_year", match: { value: f.doc_year } });
    if (f.doc_topics?.length) must.push({ key: "doc_topics", match: { any: f.doc_topics } });
    return must.length > 0 ? { must } : undefined;
  }

  async search(queryVector: number[], options: SearchOptions): Promise<SearchResult[]> {
    const filter = this.buildFilter(options.filter);
    const hybrid = options.queryText && (await this.supportsHybrid());

    if (hybrid) {
      // ★ Hybrid: dense + BM25 مدموجة بـ RRF
      const sparse = bm25Tokens(options.queryText!);
      const res: any = await this.client.query(COLLECTION(), {
        prefetch: [
          { query: queryVector, using: "dense", limit: options.topK * 2, filter },
          { query: sparse, using: "bm25", limit: options.topK * 2, filter },
        ],
        query: { fusion: "rrf" },
        limit: options.topK,
        with_payload: true,
      });
      return (res.points || []).map((m: any) => ({
        id: String(m.payload?.original_id ?? m.id),
        score: m.score ?? 0,
        metadata: m.payload ?? {},
      }));
    }

    // dense فقط (collection قديمة أو بلا queryText)
    const res = await this.client.search(COLLECTION(), {
      vector: (await this.supportsHybrid()) ? ({ name: "dense", vector: queryVector } as any) : queryVector,
      limit: options.topK,
      with_payload: true,
      filter,
    });
    return res.map(m => ({
      id: String((m.payload as any)?.original_id ?? m.id),
      score: m.score ?? 0,
      metadata: (m.payload ?? {}) as Record<string, any>,
    }));
  }

  /** ★ جلب كل chunks ملف معيّن — scroll نظيف بدل حيلة zero-vector */
  async getAllByFile(filename: string, chunkTypes?: string[]): Promise<SearchResult[]> {
    const must: any[] = [{ key: "filename", match: { value: filename } }];
    if (chunkTypes?.length) must.push({ key: "chunk_type", match: { any: chunkTypes } });

    const all: SearchResult[] = [];
    let offset: any = undefined;
    do {
      const res: any = await this.client.scroll(COLLECTION(), {
        filter: { must },
        limit: 100,
        offset,
        with_payload: true,
        with_vector: false,
      });
      for (const p of res.points || []) {
        all.push({ id: String(p.payload?.original_id ?? p.id), score: 1, metadata: p.payload ?? {} });
      }
      offset = res.next_page_offset;
    } while (offset != null);
    return all;
  }

  async deleteByFile(filename: string): Promise<void> {
    await this.client.delete(COLLECTION(), {
      wait: true,
      filter: { must: [{ key: "filename", match: { value: filename } }] },
    });
  }
}

let _store: QdrantStore | null = null;
export function getVectorStore(): QdrantStore {
  if (_store) return _store;
  _store = new QdrantStore();
  return _store;
}

/** البحث الرئيسي — Qdrant فقط. عند الفشل يرمي خطأ واضحاً (لا fallback). */
export async function vectorSearch(
  queryVector: number[],
  options: SearchOptions,
  trace?: any
): Promise<SearchResult[]> {
  try {
    return await getVectorStore().search(queryVector, options);
  } catch (err) {
    console.error("[VectorStore] Qdrant search failed:", err);
    trace?.event({
      name: "vector-store-error",
      level: "ERROR",
      input: { reason: String(err), hint: "Is Qdrant running? colima start && docker start qdrant" },
    });
    throw new Error("VECTOR_STORE_DOWN");
  }
}