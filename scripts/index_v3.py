#!/usr/bin/env python3
# فهرسة v3: PyMuPDF (محلي 100%) → تقسيم بنيوي + أشكال/جداول + صور + مراجع → Qdrant
import os, json, hashlib, re
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(".env.local")

import fitz  # PyMuPDF
from openai import OpenAI
from qdrant_client import QdrantClient
from qdrant_client.models import (
    VectorParams, SparseVectorParams, Distance, Modifier,
    PointStruct, SparseVector, PayloadSchemaType,
)

PDF_DIR = Path("pdfs")
GUIDES_DIR = Path("public/source-guides")
MANIFEST_PATH = Path("data/index-manifest-v3.json")
IMAGES_DIR = Path("extracted_images")
COLLECTION = "desaltai_chunks_v3"
DIMENSION = 3072
CHUNK_WORDS = 250
OVERLAP_WORDS = 40
IMAGE_ZOOM = 2.0

openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
qdrant = QdrantClient(url=os.environ.get("QDRANT_URL", "http://localhost:6333"))

# ─── BM25 tokens — متطابق مع bm25Tokens في lib/vectorstore.ts ───
def bm25_tokens(text: str):
    words = [w for w in re.sub(r"[^\w\s]", " ", text.lower(), flags=re.UNICODE).split() if len(w) > 1]
    counts = {}
    for w in words:
        h = int(hashlib.md5(w.encode()).hexdigest()[:8], 16)
        counts[h] = counts.get(h, 0) + 1
    return SparseVector(indices=list(counts.keys()), values=[float(v) for v in counts.values()])

def stable_uuid(original_id: str) -> str:
    h = hashlib.md5(original_id.encode()).hexdigest()
    return f"{h[:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"

def load_doc_meta(filename: str) -> dict:
    year_m = re.search(r"_(\d{4})_", filename)
    meta = {"doc_title": filename, "doc_year": int(year_m.group(1)) if year_m else 0,
            "doc_topics": [], "source_type": "journal"}
    guide_path = GUIDES_DIR / f"{filename}.json"
    if guide_path.exists():
        try:
            g = json.loads(guide_path.read_text())
            meta["doc_title"] = g.get("title", filename)
            meta["doc_topics"] = g.get("keyTopics", [])
        except Exception:
            pass
    return meta

# ─── عناوين الأقسام ───
SECTION_PATTERN = re.compile(
    r"^\s*(\d{1,2}(\.\d{1,2}){0,2}\.?\s+[A-Z][A-Za-z].{2,70}|Abstract|Introduction|Conclusions?|References|Acknowledg\w+|Appendix\s*\w*)\s*$",
    re.MULTILINE,
)

# ─── التقسيم البنيوي ───
def structural_chunks(md: str):
    sections = re.split(r"\n(?=## )", md)
    chunks = []
    for sec in sections:
        sec = sec.strip()
        if not sec:
            continue
        title_m = re.match(r"^##\s+(.+)", sec)
        section_title = title_m.group(1).strip()[:80] if title_m else ""
        words = sec.split()
        if len(words) <= CHUNK_WORDS + 50:
            chunks.append({"text": sec, "section": section_title})
        else:
            start = 0
            while start < len(words):
                end = min(start + CHUNK_WORDS, len(words))
                chunks.append({"text": " ".join(words[start:end]), "section": section_title})
                if end == len(words):
                    break
                start = end - OVERLAP_WORDS
    return [c for c in chunks if len(c["text"]) > 80]

# ─── ★ البند 2: الأشكال والجداول من captions النص ───
CAPTION_PATTERN = re.compile(
    r"^\s*((?:Fig(?:ure)?\.?|Table|Scheme)\s*\.?\s*(\d{1,2}))\s*[.:]?\s+(.{10,350}?)(?=\n|$)",
    re.MULTILINE | re.IGNORECASE,
)

def extract_figures_tables(doc):
    items, seen = [], set()
    for page_num in range(doc.page_count):
        page_text = doc[page_num].get_text("text")
        for m in CAPTION_PATTERN.finditer(page_text):
            label, num, caption = m.group(1).strip(), m.group(2), m.group(3).strip()
            is_table = label.lower().startswith("table")
            ref_number = f"{'Table' if is_table else 'Figure'} {num}"
            key = ref_number.lower()
            if key in seen:
                continue  # أول ظهور = الـ caption الحقيقي
            seen.add(key)
            items.append({
                "ref_number": ref_number,
                "chunk_type": "table" if is_table else "figure",
                "caption": caption,
                "page": page_num + 1,
                "text": f"{ref_number}: {caption}",
            })
    return items

# ─── ★ البند 2: صور صفحات الأشكال — نفس نمط تسمية v2 ───
def render_figure_pages(doc, filename: str, pages: set) -> int:
    IMAGES_DIR.mkdir(exist_ok=True)
    base = re.sub(r"\.pdf$", "", filename, flags=re.IGNORECASE)
    rendered = 0
    for p in sorted(pages):
        out = IMAGES_DIR / f"{base}-page{p}.png"
        if out.exists():
            continue
        pix = doc[p - 1].get_pixmap(matrix=fitz.Matrix(IMAGE_ZOOM, IMAGE_ZOOM))
        pix.save(str(out))
        rendered += 1
    return rendered

# ─── قسم المراجع — نمط مشدد: يشترط نصاً حقيقياً ويرفض التسريبات ───
REF_LINE_PATTERN = re.compile(r"^\s*\[(\d{1,3})\]\s+(.+?)(?=\n\s*\[\d{1,3}\]\s|\Z)", re.MULTILINE | re.DOTALL)

# ★ مرجع أكاديمي حقيقي شبه دائمًا يحتوي سنة نشر
YEAR_PATTERN = re.compile(r"(19|20)\d{2}")

# ★ نقاط توقف غير رسمية — تمنع القسم من "ابتلاع" كل باقي الملف
UNOFFICIAL_STOP_PATTERN = re.compile(
    r"\n\s*(Appendix\s*[A-Z]?|Supplementary\s+\w+|Supporting\s+Information)\b",
    re.IGNORECASE,
)

def extract_references_block(md: str) -> str:
    # آخر ظهور لعنوان References (الأول قد يكون في جدول المحتويات)
    ref_start = None
    for m in re.finditer(r"^##\s+References\s*$", md, re.MULTILINE | re.IGNORECASE):
        ref_start = m.end()
    if ref_start is None:
        return ""
    block = md[ref_start:]

    # ★ نهاية القسم: إما "##" رسمي، أو Appendix/Supplementary غير رسمي — أيهما أقرب
    cut_points = []
    official = re.search(r"\n##\s+", block)
    if official:
        cut_points.append(official.start())
    unofficial = UNOFFICIAL_STOP_PATTERN.search(block)
    if unofficial:
        cut_points.append(unofficial.start())
    if cut_points:
        block = block[:min(cut_points)]

    entries = {}
    for m in REF_LINE_PATTERN.finditer(block):
        num = int(m.group(1))
        body = re.sub(r"\s+", " ", m.group(2)).strip()

        # ★ فلاتر الجودة — ترفض التسريبات:
        if len(body) < 30:                    # مرجع حقيقي = مؤلفون + عنوان (30+ حرف)
            continue
        if not re.search(r"[A-Za-z]{3}", body):  # لازم فيه كلمات حقيقية
            continue
        if num > 300:                          # رقم مرجع منطقي
            continue
        if not YEAR_PATTERN.search(body):       # ★ لازم فيه سنة نشر — أقوى فلتر ضد المعادلات/الحواشي
            continue
        if num in entries:                     # التكرار = التقاط خاطئ، نبقي الأطول
            if len(body) <= len(entries[num][0]):
                continue

        url_m = re.search(r"(https?://\S+|doi\.org/\S+)", body, re.IGNORECASE)
        link = url_m.group(1).rstrip(".,;)") if url_m else ""
        if link and not link.lower().startswith("http"):
            link = "https://" + link
        body_clean = re.sub(r"(https?://\S+|doi\.org/\S+)", "", body, flags=re.IGNORECASE).strip(" .,;")
        entries[num] = (body_clean, link)

    # ★ فحص تسلسل حقيقي: أوقف عند أول فجوة كبيرة بالترقيم (بدل الفلتر الوهمي القديم)
    if entries:
        nums = sorted(entries.keys())
        kept = [nums[0]]
        for n in nums[1:]:
            if n - kept[-1] > 5:   # فجوة كبيرة = هذا ليس امتداداً طبيعياً لقائمة المراجع
                break
            kept.append(n)
        entries = {n: v for n, v in entries.items() if n in kept}

    lines = []
    for num in sorted(entries.keys()):
        body_clean, link = entries[num]
        lines.append(f"[{num}] {body_clean}" + (f" Link: {link}" if link else ""))
    return "\n".join(lines)

# ─── Quality Score ───
def quality_score(md: str, chunks: list, pages: int):
    issues = []
    score = 1.0
    if len(md) < pages * 400:
        score -= 0.3; issues.append("low_text_density")
    bad_chars = md.count("\ufffd") + md.count("□")
    if bad_chars > len(md) * 0.001:
        score -= 0.2; issues.append("encoding_artifacts")
    expected = pages * 2
    if not (expected * 0.3 <= len(chunks) <= expected * 4):
        score -= 0.15; issues.append(f"chunk_count_odd({len(chunks)}/p{pages})")
    if not re.search(r"references", md, re.IGNORECASE):
        score -= 0.1; issues.append("no_references_section")
    if not re.search(r"a\s*b\s*s\s*t\s*r\s*a\s*c\s*t", md[:5000], re.IGNORECASE):
        score -= 0.1; issues.append("no_abstract")
    return max(round(score, 2), 0.0), issues

def embed_batch(texts: list):
    res = openai_client.embeddings.create(model="text-embedding-3-large", input=texts)
    return [d.embedding for d in res.data]

def ensure_collection():
    names = [c.name for c in qdrant.get_collections().collections]
    if COLLECTION in names:
        print(f"⏭️ {COLLECTION} موجودة")
        return
    qdrant.create_collection(
        COLLECTION,
        vectors_config={"dense": VectorParams(size=DIMENSION, distance=Distance.COSINE)},
        sparse_vectors_config={"bm25": SparseVectorParams(modifier=Modifier.IDF)},
    )
    for field, schema in [("chunk_type", PayloadSchemaType.KEYWORD), ("filename", PayloadSchemaType.KEYWORD),
                          ("section", PayloadSchemaType.KEYWORD), ("doc_topics", PayloadSchemaType.KEYWORD),
                          ("doc_year", PayloadSchemaType.INTEGER), ("page", PayloadSchemaType.INTEGER)]:
        qdrant.create_payload_index(COLLECTION, field_name=field, field_schema=schema)
    print(f"✅ أنشئت {COLLECTION}")

def main():
    MANIFEST_PATH.parent.mkdir(exist_ok=True)
    manifest = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {"files": []}
    done = {f["filename"] for f in manifest["files"] if f.get("status") == "indexed"}

    ensure_collection()
    pdfs = sorted(PDF_DIR.glob("*.pdf"))
    print(f"📚 {len(pdfs)} ملف PDF")

    for pdf in pdfs:
        if pdf.name in done:
            print(f"⏭️ مفهرس: {pdf.name}")
            continue
        print(f"\n🔨 {pdf.name}")
        entry = {"filename": pdf.name, "sha256": hashlib.sha256(pdf.read_bytes()).hexdigest(),
                 "parser": "pymupdf", "status": "failed", "pages": 0, "chunks": 0,
                 "figures": 0, "references": 0, "qualityScore": 0.0, "errors": []}
        try:
            # 1. استخراج محلي — الـ doc يبقى مفتوحاً للأشكال والصور
            doc = fitz.open(str(pdf))
            pages = doc.page_count
            raw = "\n".join(doc[i].get_text("text") for i in range(pages))
            md = SECTION_PATTERN.sub(lambda m: f"\n## {m.group(1).strip()}\n", raw)
            entry["pages"] = pages
            print(f"  📄 {pages} صفحة، {len(md)} حرف")

            # 2. تقسيم بنيوي
            chunks = structural_chunks(md)
            entry["chunks"] = len(chunks)
            sections_found = len({c["section"] for c in chunks if c["section"]})
            print(f"  ✂️ {len(chunks)} chunk عبر {sections_found} قسم")

            # ★ 2ب. الأشكال والجداول + صور صفحاتها
            figures = extract_figures_tables(doc)
            entry["figures"] = len(figures)
            fig_pages = {f["page"] for f in figures}
            rendered = render_figure_pages(doc, pdf.name, fig_pages)
            doc.close()
            print(f"  🖼️ {len(figures)} شكل/جدول عبر {len(fig_pages)} صفحة ({rendered} صورة جديدة)")

            # ★ 2ج. المراجع
            refs_text = extract_references_block(md)
            refs_count = len(refs_text.split("\n")) if refs_text else 0
            entry["references"] = refs_count
            print(f"  📚 {refs_count} مرجع")

            # 3. جودة
            q, issues = quality_score(md, chunks, pages)
            entry["qualityScore"] = q
            entry["errors"] = issues
            print(f"  🏅 جودة: {q}" + (f" ⚠️ {issues}" if issues else ""))
            if q < 0.5:
                entry["status"] = "needs_review"
                print(f"  🛑 جودة منخفضة — لن يُفهرس")
                manifest["files"].append(entry)
                continue

            # 4. embeddings + upsert — نصوص + أشكال + مراجع في مسار واحد
            meta = load_doc_meta(pdf.name)
            base_name = re.sub(r"\.pdf$", "", pdf.name, flags=re.IGNORECASE)

            all_items = []
            for idx, c in enumerate(chunks):
                all_items.append({"oid": f"{pdf.name}-v3-text-{idx}", "text": c["text"],
                    "payload": {"chunk_type": "text", "section": c["section"], "page": 0,
                                "caption": "", "ref_number": "", "image_url": None}})
            for idx, f in enumerate(figures):
                all_items.append({"oid": f"{pdf.name}-v3-fig-{idx}", "text": f["text"],
                    "payload": {"chunk_type": f["chunk_type"], "section": "", "page": f["page"],
                                "caption": f["caption"], "ref_number": f["ref_number"],
                                "image_url": f"/api/images/{base_name}-page{f['page']}.png"}})
            if refs_text:
                all_items.append({"oid": f"{pdf.name}-v3-refs", "text": refs_text,
                    "payload": {"chunk_type": "references_index", "section": "References",
                                "page": 0, "caption": "", "ref_number": "", "image_url": None}})

            for i in range(0, len(all_items), 20):
                batch = all_items[i:i+20]
                vectors = embed_batch([it["text"] for it in batch])
                points = []
                for k, (it, v) in enumerate(zip(batch, vectors)):
                    points.append(PointStruct(
                        id=stable_uuid(it["oid"]),
                        vector={"dense": v, "bm25": bm25_tokens(it["text"])},
                        payload={"text": it["text"], "filename": pdf.name,
                                 "chunk_index": i + k, **meta, **it["payload"],
                                 "original_id": it["oid"]},
                    ))
                qdrant.upsert(COLLECTION, points=points, wait=True)
                print(f"  🚚 {min(i+20, len(all_items))}/{len(all_items)}")

            entry["status"] = "indexed"
            print(f"  ✅ تم")
        except Exception as e:
            entry["errors"].append(str(e)[:200])
            print(f"  ❌ {e}")

        manifest["files"].append(entry)
        MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False))

    info = qdrant.get_collection(COLLECTION)
    print(f"\n✅ v3 جاهزة: {info.points_count} نقطة (مكتفية ذاتياً — بلا استعارة من v2)")
    print(f"👉 QDRANT_COLLECTION={COLLECTION} ثم أعد تشغيل السيرفر")

if __name__ == "__main__":
    main()