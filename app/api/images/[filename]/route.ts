import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ filename: string }> }
) {
  const { filename } = await params;
  const safe = path.basename(decodeURIComponent(filename));
  const imagePath = path.join(process.cwd(), "extracted_images", safe);

  if (!fs.existsSync(imagePath)) {
    return NextResponse.json({ error: "الصورة غير موجودة" }, { status: 404 });
  }

  const imageBuffer = fs.readFileSync(imagePath);
  return new NextResponse(imageBuffer, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
}
