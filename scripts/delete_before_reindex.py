from qdrant_client import QdrantClient
from qdrant_client.models import Filter, FieldCondition, MatchValue
import os
from dotenv import load_dotenv
load_dotenv(".env.local")

qdrant = QdrantClient(url=os.environ.get("QDRANT_URL", "http://localhost:6333"))
FILENAME = "Vapor-induced-phase-separation-PVDF-membranes-incorporating-alky_2025_Desali.pdf"

qdrant.delete(
    collection_name="desaltai_chunks_v3",
    points_selector=Filter(
        must=[FieldCondition(key="filename", match=MatchValue(value=FILENAME))]
    ),
)
print(f"✅ تم حذف كل نقاط {FILENAME}")
