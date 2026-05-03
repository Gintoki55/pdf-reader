import { NextRequest, NextResponse } from "next/server";
import { HfInference } from "@huggingface/inference";
import { Pinecone } from "@pinecone-database/pinecone";
import Groq from "groq-sdk";

const hf = new HfInference(process.env.HUGGINGFACE_API_KEY);
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// تحويل سؤال العميل لـ embedding
async function getEmbedding(text: string): Promise<number[]> {
  const result = await hf.featureExtraction({
    model: "sentence-transformers/all-MiniLM-L6-v2",
    inputs: text,
  });
  if (Array.isArray(result[0])) return result[0] as number[];
  return result as unknown as number[];
}

export async function POST(req: NextRequest) {
  try {
    const { question } = await req.json();

    if (!question) {
      return NextResponse.json({ error: "لم يتم إرسال سؤال" }, { status: 400 });
    }

    // 1. تحويل السؤال لـ embedding
    const questionEmbedding = await getEmbedding(question);

    // 2. البحث في Pinecone عن أقرب أجزاء
    const index = pinecone.index(process.env.PINECONE_INDEX!);
    const searchResults = await index.query({
      vector: questionEmbedding,
      topK: 5,
      includeMetadata: true,
    });

    // 3. تجميع النصوص المسترجعة
    const context = searchResults.matches
      .map((match, i) => `[${i + 1}] ${match.metadata?.text}`)
      .join("\n\n");

    if (!context) {
      return NextResponse.json({ answer: "⚠️ لم أجد معلومات كافية للإجابة." });
    }

    // 4. إرسال السؤال + السياق لـ Groq
    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: `أنت مساعد متخصص. أجب على أسئلة العملاء بناءً على المستندات المتاحة فقط.
إذا لم تجد الإجابة في المستندات، قل ذلك بوضوح.
أجب دائماً باللغة العربية.`,
        },
        {
          role: "user",
          content: `المستندات:\n${context}\n\nالسؤال: ${question}`,
        },
      ],
      temperature: 0.3,
      max_tokens: 1024,
    });

    const answer = completion.choices[0].message.content;

    return NextResponse.json({ answer, context });

  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: "فشل في معالجة السؤال" }, { status: 500 });
  }
}