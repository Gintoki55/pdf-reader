import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

const GUIDES_DIR = path.join(process.cwd(), "public", "source-guides");

export async function GET(req: NextRequest) {
  const ids = req.nextUrl.searchParams.get("ids")?.split(",").filter(Boolean) || [];

  const guides = ids
    .map(id => {
      try {
        const safe = path.basename(decodeURIComponent(id));
        const raw = fs.readFileSync(path.join(GUIDES_DIR, `${safe}.json`), "utf-8");
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  return NextResponse.json({ guides });
}

