import { config } from "dotenv";
config({ path: ".env.local" });

import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { ImageAnnotatorClient } from "@google-cloud/vision";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const vision = new ImageAnnotatorClient({ keyFilename: "./service-account.json" });

const PDF_DIR = path.join(process.cwd(), "pdfs");
const IMAGES_DIR = path.join(process.cwd(), "extracted_images");
const IMAGES_INDEX = path.join(process.cwd(), "images_indexed.json");

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR);

const imagesIndexed: string[] = fs.existsSync(IMAGES_INDEX)
  ? JSON.parse(fs.readFileSync(IMAGES_INDEX, "utf-8"))
  : [];

// محاولة استخراج caption مثل "Fig. 6" أو "Table 1" من النص المستخرج بالصفحة
const CAPTION_REGEX = /(Fig(?:ure)?\.?\s*\d+[a-z]?|Table\s*\d+[a-z]?)[\s.:]*([A-Z][^\n]{0,120})?/i;

function extractCaptionFromText(text: string): { refNumber: string; caption: string } {
  const match = text.match(CAPTION_REGEX);
  if (!match) return { refNumber: "", caption: "" };
  const refNumber = match[1].replace(/\s+/g, " ").trim();
  const caption = (match[2] || "").trim();
  return { refNumber, caption };
}

// تحليل الصورة بـ Google Vision
async function analyzeImage(imagePath: string, filename: string, pageNum: number): Promise<{
  description: string;
  type: "chart" | "diagram" | "table" | "microscopy" | "flowchart" | "other";
  keywords: string[];
  refNumber: string;
  caption: string;
}> {
  const [result] = await vision.annotateImage({
    image: { source: { filename: imagePath } },
    features: [
      { type: "LABEL_DETECTION", maxResults: 10 },
      { type: "TEXT_DETECTION" },
      { type: "OBJECT_LOCALIZATION", maxResults: 10 },
    ],
  });

  const labels = result.labelAnnotations?.map(l => l.description || "") || [];
  const text = result.fullTextAnnotation?.text || "";
  const objects = result.localizedObjectAnnotations?.map(o => o.name || "") || [];

  const { refNumber, caption } = extractCaptionFromText(text);

  const allKeywords = [...labels, ...objects].map(k => k.toLowerCase());
  let type: "chart" | "diagram" | "table" | "microscopy" | "flowchart" | "other" = "other";

  if (allKeywords.some(k => ["chart", "graph", "plot", "bar", "line"].includes(k))) type = "chart";
  else if (allKeywords.some(k => ["diagram", "schematic", "flowchart"].includes(k))) type = "diagram";
  else if (allKeywords.some(k => ["table", "grid"].includes(k))) type = "table";
  else if (allKeywords.some(k => ["microscopy", "sem", "electron", "crystal"].includes(k))) type = "microscopy";
  else if (allKeywords.some(k => ["flow", "arrow", "process"].includes(k))) type = "flowchart";

  const description = `${refNumber ? refNumber + (caption ? `: ${caption}` : "") + ". " : ""}Page ${pageNum} from ${filename}.
Labels: ${labels.join(", ")}.
Objects: ${objects.join(", ")}.
Extracted text: ${text.slice(0, 500)}`;

  return {
    description,
    type,
    keywords: [...new Set([...labels, ...objects])].slice(0, 10),
    refNumber,
    caption,
  };
}

// تحويل PDF لصور باستخدام Google Document AI
async function extractPDFPages(buffer: Buffer, filename: string): Promise<string[]> {
  const { DocumentProcessorServiceClient } = await import("@google-cloud/documentai");
  const client = new DocumentProcessorServiceClient({ keyFilename: "./service-account.json" });

  const processorName = `projects/${process.env.GOOGLE_PROJECT_ID}/locations/${process.env.GOOGLE_LOCATION}/processors/${process.env.GOOGLE_PROCESSOR_ID}`;

  const [result] = await client.processDocument({
    name: processorName,
    rawDocument: {
      content: buffer.toString("base64"),
      mimeType: "application/pdf",
    },
  });

  const imagePaths: string[] = [];

  if (result.document?.pages) {
    for (let i = 0; i < result.document.pages.length; i++) {
      const page = result.document.pages[i];
      if (page.image?.content) {
        const imagePath = path.join(
          IMAGES_DIR,
          `${filename.replace(".pdf", "")}-page${i + 1}.png`
        );
        fs.writeFileSync(imagePath, Buffer.from(page.image.content as string, "base64"));
        imagePaths.push(imagePath);
        console.log(`    📸 صفحة ${i + 1}`);
      }
    }
  }

  return imagePaths;
}

// تحويل نص لـ embedding
async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: text.slice(0, 8000),
  });
  return response.data[0].embedding;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const files = fs.readdirSync(PDF_DIR)
    .filter(f => f.endsWith(".pdf") && !f.toLowerCase().includes("copy"));

  const newFiles = files.filter(f => !imagesIndexed.includes(f));
  console.log(`وجدت ${files.length} ملف | جديد: ${newFiles.length}\n`);

  if (newFiles.length === 0) {
    console.log("✅ كل الملفات معالجة!");
    return;
  }

  const index = pinecone.index(process.env.PINECONE_INDEX!);

  for (let i = 0; i < newFiles.length; i++) {
    const file = newFiles[i];
    console.log(`\n[${i + 1}/${newFiles.length}] ${file}`);

    try {
      const buffer = fs.readFileSync(path.join(PDF_DIR, file));

      // 1. استخراج صفحات PDF كصور
      console.log(`  🖼️ استخراج الصفحات...`);
      const imagePaths = await extractPDFPages(buffer, file);
      console.log(`  ✅ ${imagePaths.length} صفحة`);

      if (imagePaths.length === 0) {
        console.log(`  ⚠️ ما في صور — تحقق من الـ processor`);
        continue;
      }

      // 2. تحليل كل صورة بـ Google Vision
      const vectors: any[] = [];

      for (let j = 0; j < imagePaths.length; j++) {
        const imagePath = imagePaths[j];
        const pageNum = j + 1;

        console.log(`  🔍 Google Vision — صفحة ${pageNum}...`);
        const analysis = await analyzeImage(imagePath, file, pageNum);

        const embedding = await getEmbedding(analysis.description);
        vectors.push({
          id: `${file}-image-page${pageNum}`,
          values: embedding,
          metadata: {
            text: analysis.description.slice(0, 2000),
            filename: file,
            chunk_type: analysis.type,
            page: pageNum,
            image_path: imagePath,
            keywords: analysis.keywords.join(", "),
            ref_number: analysis.refNumber,
            caption: analysis.caption,
          },
        });

        await sleep(300);
      }

      // 3. تخزين في Pinecone
      const batchSize = 50;
      for (let b = 0; b < vectors.length; b += batchSize) {
        await index.upsert({ records: vectors.slice(b, b + batchSize) });
        await sleep(200);
      }

      console.log(`  🚀 تم تخزين ${vectors.length} صورة في Pinecone`);

      imagesIndexed.push(file);
      fs.writeFileSync(IMAGES_INDEX, JSON.stringify(imagesIndexed, null, 2));

    } catch (error) {
      console.error(`  ❌ خطأ:`, error);
    }

    await sleep(1000);
  }

  console.log("\n✅ انتهى استخراج الصور!");
}

main();