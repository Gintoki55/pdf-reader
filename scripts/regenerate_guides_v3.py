#!/usr/bin/env python3
# إعادة توليد source-guides من بيانات v3 — ترقيم موحد + روابط DOI حقيقية
import os, json, re
from pathlib import Path
from dotenv import load_dotenv
load_dotenv(".env.local")

from qdrant_client import QdrantClient

qdrant = QdrantClient(url=os.environ.get("QDRANT_URL", "http://localhost:6333"))
COLLECTION = "desaltai_chunks_v3"
GUIDES_DIR = Path("public/source-guides")

def parse_ref_line(line: str):
    m = re.match(r"^\[(\d+)\]\s*(.+)", line.strip())
    if not m:
        return None
    number, rest = m.group(1), m.group(2)
    url_m = re.search(r"Link:\s*(https?://\S+)", rest, re.IGNORECASE)
    url = url_m.group(1).rstrip(".,;") if url_m else ""
    body = re.sub(r"Link:\s*https?://\S+", "", rest, flags=re.IGNORECASE).strip()
    dot = body.find(". ")
    authors = body[:dot].strip() if dot > 0 else ""
    title = body[dot+2:].strip() if dot > 0 else body
    return {"number": number, "authors": authors, "title": title, "url": url}

def scroll_by_file():
    """يجمع كل نقاط v3 مصنفة حسب الملف والنوع."""
    files = {}
    offset = None
    while True:
        res, offset = qdrant.scroll(COLLECTION, limit=100, offset=offset,
                                     with_payload=True, with_vectors=False)
        if not res:
            break
        for p in res:
            pl = p.payload
            fn = pl.get("filename", "")
            files.setdefault(fn, {"figures": [], "tables": [], "refs_text": "",
                                   "title": pl.get("doc_title", fn),
                                   "topics": pl.get("doc_topics", [])})
            ct = pl.get("chunk_type", "")
            if ct in ("figure", "graph"):
                files[fn]["figures"].append({"number": pl.get("ref_number", ""),
                    "caption": pl.get("caption", ""), "page": pl.get("page"),
                    })
            elif ct == "table":
                files[fn]["tables"].append({"number": pl.get("ref_number", ""),
                    "caption": pl.get("caption", ""), "page": pl.get("page")})
            elif ct == "references_index":
                files[fn]["refs_text"] = pl.get("text", "")
        if offset is None:
            break
    return files

def main():
    GUIDES_DIR.mkdir(parents=True, exist_ok=True)
    files = scroll_by_file()
    print(f"📚 {len(files)} ملف في v3")

    for fn, data in files.items():
        refs = [r for r in (parse_ref_line(l) for l in data["refs_text"].split("\n") if l.strip()) if r]
        # حافظ على الملخص القديم إن وُجد (تولد بـ Gemini سابقاً — ثمين)
        old_path = GUIDES_DIR / f"{fn}.json"
        summary = ""
        if old_path.exists():
            try:
                summary = json.loads(old_path.read_text()).get("summary", "")
            except Exception:
                pass

        guide = {
            "fileId": fn, "filename": fn,
            "title": data["title"], "summary": summary,
            "keyTopics": data["topics"],
            "figures": sorted(data["figures"], key=lambda f: (f["page"] or 0)),
            "tables": sorted(data["tables"], key=lambda t: (t["page"] or 0)),
            "references": sorted(refs, key=lambda r: int(r["number"])),
            "generatedFrom": "v3",
        }
        old_path.write_text(json.dumps(guide, ensure_ascii=False, indent=2))
        print(f"  📖 {fn}: {len(data['figures'])} شكل | {len(data['tables'])} جدول | {len(refs)} مرجع")

    print("✅ الأدلة موحدة مع v3")

if __name__ == "__main__":
    main()