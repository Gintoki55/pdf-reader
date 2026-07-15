import sys, re
from pathlib import Path
import fitz  # PyMuPDF

SECTION_PATTERN = re.compile(
    r"^\s*(\d{1,2}(\.\d{1,2}){0,2}\.?\s+[A-Z][A-Za-z].{2,70}|Abstract|Introduction|Conclusions?|References|Acknowledg\w+|Appendix\s*\w*)\s*$",
    re.MULTILINE,
)
REF_LINE_PATTERN = re.compile(r"^\s*\[(\d{1,3})\]\s+(.+?)(?=\n\s*\[\d{1,3}\]\s|\Z)", re.MULTILINE | re.DOTALL)
YEAR_PATTERN = re.compile(r"(19|20)\d{2}")
UNOFFICIAL_STOP_PATTERN = re.compile(
    r"\n\s*(Appendix\s*[A-Z]?|Supplementary\s+\w+|Supporting\s+Information)\b",
    re.IGNORECASE,
)

def main():
    pdf_path = Path(sys.argv[1])
    doc = fitz.open(str(pdf_path))
    pages = doc.page_count
    raw = "\n".join(doc[i].get_text("text") for i in range(pages))
    md = SECTION_PATTERN.sub(lambda m: f"\n## {m.group(1).strip()}\n", raw)
    doc.close()

    ref_start = None
    for m in re.finditer(r"^##\s+References\s*$", md, re.MULTILINE | re.IGNORECASE):
        ref_start = m.end()
    if ref_start is None:
        print("⚠️ ما انلقط عنوان References إطلاقاً!")
        return

    block = md[ref_start:]
    cut_points = []
    official = re.search(r"\n##\s+", block)
    if official:
        cut_points.append(official.start())
    unofficial = UNOFFICIAL_STOP_PATTERN.search(block)
    if unofficial:
        cut_points.append(unofficial.start())
    if cut_points:
        print(f"نقطة القطع المستخدمة: {min(cut_points)} حرف (من {len(block)} حرف كلي بعد References)")
        block = block[:min(cut_points)]
    else:
        print(f"⚠️ ما فيه نقطة قطع — القسم أخذ كل الباقي: {len(block)} حرف")

    matches = list(REF_LINE_PATTERN.finditer(block))
    print(f"\nعدد الأسطر الخام الملتقطة بصيغة [رقم]: {len(matches)}\n")

    seen_bodies = {}  # للكشف عن تكرار نصي حتى لو الأرقام مختلفة
    for m in matches:
        num = int(m.group(1))
        body = re.sub(r"\s+", " ", m.group(2)).strip()
        preview = body[:90]
        has_year = "✅" if YEAR_PATTERN.search(body) else "❌ بدون سنة"

        # كشف تكرار نصي (أول 40 حرف كمفتاح تقريبي)
        key = body[:40].lower()
        dup_flag = ""
        if key in seen_bodies:
            dup_flag = f"  🔁 يشبه [{seen_bodies[key]}]"
        else:
            seen_bodies[key] = num

        print(f"[{num:3d}] len={len(body):4d} {has_year} {dup_flag}\n      {preview}")

    print(f"\n{'='*60}")
    print("لو أغلب الأرقام من 51 إلى 102 عندها 🔁 (تشبه مرجع سابق) → مشكلة تكرار نصي")
    print("لو كلها فريدة ومختلفة تمامًا → غالبًا الورقة فعلاً فيها 102 مرجع حقيقي")

if __name__ == "__main__":
    main()