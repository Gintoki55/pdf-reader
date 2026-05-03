import { NextRequest, NextResponse } from "next/server";
import { extractText } from "unpdf";
import { HfInference } from "@huggingface/inference";
import { Pinecone } from "@pinecone-database/pinecone";

const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

function chunkText(text: string, chunkSize: number = 700): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    const words = (current + " " + para).trim().split(/\s+/);
    if (words.length >= chunkSize) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = (current + " " + para).trim();
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

async function getEmbedding(text: string): Promise<number[]> {
  const result = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text,
  });
  
  // النتيجة array أحادية مباشرة
  return result as unknown as number[];
}
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File;

    console.log("الملف:", file?.name, file?.size);

    if (!file) {
      return NextResponse.json({ error: "لم يتم إرسال ملف" }, { status: 400 });
    }

    const buffer = await file.arrayBuffer();
    console.log("حجم الـ buffer:", buffer.byteLength);

    const result = await extractText(new Uint8Array(buffer), { mergePages: true });
    console.log("النتيجة:", result);

    if (!result.text) {
      return NextResponse.json({ error: "⚠️ هذا الملف مسكن ولا يحتوي نص" }, { status: 400 });
    }

    const chunks = chunkText(result.text, 700);
    console.log("النص المستخرج:", result.text.substring(0, 200)); // ← أضف هنا
    console.log(`عدد الأجزاء: ${chunks.length}`);

    const embeddings: number[][] = [];
    for (const chunk of chunks) {
      const embedding = await getEmbedding(chunk);
      embeddings.push(embedding);
    }

    const index = pinecone.index(process.env.PINECONE_INDEX!);

    const vectors = chunks.map((chunk, i) => ({
      id: `${file.name}-chunk-${i}`,
      values: embeddings[i],
      metadata: {
        text: chunk,
        filename: file.name,
        chunkIndex: i,
      },
    }));
    console.log("عدد الـ vectors:", vectors.length);
console.log("حجم أول embedding:", vectors[0]?.values?.length);

    await index.upsert({ records: vectors });
    console.log(`✅ تم تخزين ${vectors.length} جزء في Pinecone`);

    return NextResponse.json({
      text: result.text,
      chunks,
      totalChunks: chunks.length,
      pages: result.totalPages,
      filename: file.name,
      message: `✅ تم تخزين ${chunks.length} جزء في Pinecone`,
    });

  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "فشل في معالجة الملف" }, { status: 500 });
  }
}