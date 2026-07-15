"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type ImageResult = {
  url: string;
  page: number | string;
  type: string;
  description: string;
};

type ParsedReference = {
  number: string; // ★ الآن يمكن يكون صيغة مركّبة مثل "D1-12" لإجابات RAG، أو رقم عادي لـ source-guides
  authors: string;
  title: string;
  url: string;
};

type SourceGuide = {
  fileId: string;
  filename: string;
  title: string;
  summary: string;
  keyTopics: string[];
  figures: { number: string; caption: string; page: number | null }[];
  tables: { number: string; caption: string; page: number | null }[];
  references: ParsedReference[];
};

type ActiveEntity = {
  name: string;
  nameAr: string;
  type: string;
  document: string;
} | null;

type Message = {
  role: "user" | "assistant";
  content: string;
  images?: ImageResult[];
  isWelcome?: boolean;
  isArabic?: boolean;
  truncated?: boolean;
};

const commonQuestions = [
  { category: "MSF", questions: [
    "Do one page review about MSF development",
    "Do one page review about MSF configurations",
    "Do one page review about MSF modelling",
    "Do one page review about MSF water cost",
    "Do one page review about MSF simulation",
  ]},
  { category: "MED", questions: [
    "Do one page review about MED development",
    "Do one page review about MED configurations",
    "Do one page review about MED modelling",
    "Do one page review about MED water cost",
    "Do one page review about MED simulation",
  ]},
  { category: "RO", questions: [
    "Do one page review about RO development",
    "Do one page review about RO configurations",
    "Do one page review about RO modelling",
    "Do one page review about RO water cost",
    "Do one page review about RO simulation",
  ]},
];

const LOADING_STEPS = [
  "Analyzing your question...",
  "Searching documents...",
  "Generating answer...",
];

function isArabicText(text: string): boolean {
  const ar = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return ar / Math.max(text.replace(/\s/g, "").length, 1) > 0.3;
}

function isContinuationCommand(q: string): boolean {
  const t = q.trim();
  return (
    /^(continue|go on|keep going|carry on|finish|complete( the)? answer|continue (the )?answer|continue from where you stopped)\b/i.test(t) ||
    /^(أكمل|اكمل|كمل|كمّل|كمِّل|تابع|واصل|أكمل الإجابة|كمل الجواب|اكمل الجواب|أكمل من حيث توقفت|كمل من حيث توقفت)\b/.test(t)
  );
}

// ★ تحويل [D1-12] في نص الإجابة إلى روابط استشهاد داخلية
//   يدعم الصيغة المركّبة الجديدة (D{رقم الورقة}-{رقم المرجع})
function linkifyCitations(content: string): string {
  return content.replace(/\[(D\d+-\d+)\](?!\()/g, "[$1](#cite-$1)");
}

// ★ يستخرج الرقم "النظيف" من الصيغة المركّبة لعرضه للمستخدم فقط (D1-12 → 12)
function displayNumber(compoundId: string): string {
  const m = compoundId.match(/^D\d+-(\d+)$/);
  return m ? m[1] : compoundId;
}

// ★ يستخرج رقم الورقة من الصيغة المركّبة (D1-12 → 1)
function docIndexOf(compoundId: string): number {
  const m = compoundId.match(/^D(\d+)-\d+$/);
  return m ? parseInt(m[1]) : 0;
}

function RobotIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="8" width="18" height="12" rx="2" />
      <path d="M9 8V6a3 3 0 016 0v2" />
      <circle cx="9" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <circle cx="15" cy="14" r="1.5" fill="currentColor" stroke="none" />
      <path d="M9 18h6" strokeLinecap="round" />
      <path d="M12 2v2" strokeLinecap="round" />
      <path d="M3 12H1M23 12h-2" strokeLinecap="round" />
    </svg>
  );
}

function CopyButton({ text, small = false }: { text: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <button onClick={handleCopy} title={copied ? "Copied!" : "Copy"}
      className={`flex items-center gap-1.5 transition-colors rounded-md ${
        small
          ? "text-[10px] px-2 py-1 border border-[#444] hover:border-[#666] text-[#8e8ea0]"
          : "text-xs text-[#8e8ea0] hover:text-[#ececf1] px-2 py-1.5 hover:bg-[#2f2f2f]"
      } ${copied ? "text-green-400" : ""}`}>
      {copied
        ? <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        : <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      }
      {!small && (copied ? "Copied" : "Copy")}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────
// ★ ResourcesPanel — كل شيء تحت بعض: صور ← روابط ← مراجع
//   المراجع الآن تُبنى من answerReferences (القادمة مباشرة من رد /api/chat
//   بصيغة D{ورقة}-{رقم} الفريدة عالمياً)، مو من sourceGuides
// ─────────────────────────────────────────────────────────────
function ResourcesPanel({
  guides,
  relatedImages,
  answerReferences,
  docIndexMap,
  highlightRef,
  onHighlightDone,
}: {
  guides: SourceGuide[];
  relatedImages: ImageResult[];
  answerReferences: ParsedReference[];
  docIndexMap: Record<number, string>;
  highlightRef: string | null;
  onHighlightDone: () => void;
}) {
  const [flashRef, setFlashRef] = useState<string | null>(null);
  const [brokenImgs, setBrokenImgs] = useState<Set<string>>(new Set());

  // روابط مفيدة فقط (نستبعد scholar المولّدة والروابط المكسورة)
  const links = guides.flatMap(g =>
    (g.references || [])
      .filter(r => {
        if (!r.url || r.url.includes("scholar.google")) return false;
        try {
          const u = new URL(r.url);
          return u.hostname.includes(".");
        } catch { return false; }
      })
      .map(r => ({ label: r.title.slice(0, 60) || `Reference ${r.number}`, url: r.url }))
  ).slice(0, 8);

  const seenUrls = new Set<string>();
  const images = relatedImages.filter(img => {
    if (seenUrls.has(img.url)) return false;
    seenUrls.add(img.url);
    return true;
  });

  // ★ المراجع تجي جاهزة ومفلترة من الـ backend (references الخاصة بهذا الرد فقط)
  //   نرتبها فقط حسب رقم الورقة ثم رقم المرجع داخلها
  const refs = [...answerReferences].sort((a, b) => {
    const aDoc = docIndexOf(a.number), bDoc = docIndexOf(b.number);
    if (aDoc !== bDoc) return aDoc - bDoc;
    const aNum = parseInt(a.number.split("-")[1] || "0");
    const bNum = parseInt(b.number.split("-")[1] || "0");
    return aNum - bNum;
  });

  // ★ نعرض اسم الورقة تحت كل مرجع فقط لو الإجابة استخدمت أكثر من ورقة وحدة
  const uniqueDocCount = new Set(refs.map(r => docIndexOf(r.number))).size;

  useEffect(() => {
    if (!highlightRef) return;
    setFlashRef(highlightRef);
    setTimeout(() => {
      document.getElementById(`ref-${highlightRef}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 100);
    const t = setTimeout(() => { setFlashRef(null); onHighlightDone(); }, 2500);
    return () => clearTimeout(t);
  }, [highlightRef, onHighlightDone]);

  const isEmpty = images.length === 0 && links.length === 0 && refs.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-center px-4 py-10">
        <svg className="w-9 h-9 text-[#3a3a3a] mb-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        <p className="text-xs text-[#555] font-medium">No resources yet</p>
        <p className="text-[11px] text-[#444] mt-1 leading-4">Figures, links and references related to your question appear here</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">

      {/* الصور المرتبطة بالسؤال — مباشرة، بلا عنوان */}
      {images.filter(img => !brokenImgs.has(img.url)).map((img, i) => (
        <figure key={`img-${i}`} className="rounded-lg border border-[#333] overflow-hidden bg-[#1c1c1c]">
          <img
            src={img.url}
            alt={img.description}
            loading="lazy"
            className="w-full h-auto bg-white"
            onError={() => setBrokenImgs(prev => new Set(prev).add(img.url))}
          />
          <figcaption className="px-2.5 py-2 text-[10px] text-[#a8a8b3] leading-[1.5]">
            {img.description}
            {img.page && <span className="text-[#666]"> · p.{img.page}</span>}
          </figcaption>
        </figure>
      ))}

      {/* الروابط — مباشرة بعد الصور */}
      {links.map((l, i) => (
        <a key={`link-${i}`} href={l.url} target="_blank" rel="noopener noreferrer"
          className="flex items-center gap-2 text-[11px] text-[#a8a8b3] hover:text-[#10a37f] rounded-md px-2 py-1.5 hover:bg-[#2a2a2a] transition">
          <svg className="w-3 h-3 shrink-0 text-[#10a37f]" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" strokeLinecap="round"/>
          </svg>
          <span className="truncate">{l.label}</span>
        </a>
      ))}

      {/* المراجع — مباشرة بعد الروابط */}
      {refs.map((r, i) => {
        const docIdx = docIndexOf(r.number);
        const docName = docIndexMap[docIdx];
        return (
          <div key={`ref-${i}`} id={`ref-${r.number}`}
            className={`flex flex-col gap-0.5 text-[11px] leading-[1.55] rounded-md px-2 py-1.5 transition-colors duration-500 ${
              flashRef === r.number ? "bg-[#10a37f]/25" : ""
            }`}>
            <div className="flex gap-2">
              <span className="shrink-0 text-[#10a37f] font-bold">[{displayNumber(r.number)}]</span>
              <span className="flex-1 text-[#a8a8b3] min-w-0">
                {r.title || r.authors}
                {r.url && (
                  <a href={r.url} target="_blank" rel="noopener noreferrer"
                    className="text-[#10a37f] hover:text-[#1abc91] ml-1 whitespace-nowrap">↗</a>
                )}
              </span>
            </div>
            {/* ★ اسم الورقة يظهر فقط لو فيه أكثر من مصدر وحد بهذا الرد */}
            {uniqueDocCount > 1 && docName && (
              <span className="text-[9px] text-[#666] pl-5 truncate">
                {docName.replace(/\.pdf$/i, "")}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([{
    role: "assistant",
    content: "Hello! I'm **DesaltAI**, your research assistant for desalination technology. Ask me anything about MSF, MED, RO, or related studies.",
    isWelcome: true,
    isArabic: false,
  }]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [loadingStep, setLoadingStep] = useState(0);
  const [activeCategory, setActiveCategory] = useState("MSF");
  const [sourceGuides, setSourceGuides] = useState<SourceGuide[]>([]);
  const [relatedImages, setRelatedImages] = useState<ImageResult[]>([]);
  // ★ مراجع الرد الحالي بالضبط (بالصيغة المركّبة D{ورقة}-{رقم}) — تحل تعارض الترقيم بين الأوراق
  const [answerReferences, setAnswerReferences] = useState<ParsedReference[]>([]);
  // ★ خريطة: رقم الورقة الداخلي (1، 2، ...) → اسم الملف الفعلي، لعرضه تحت كل مرجع عند تعدد المصادر
  const [docIndexMap, setDocIndexMap] = useState<Record<number, string>>({});
  const [showQuickQueries, setShowQuickQueries] = useState(false);
  const [entityHistory, setEntityHistory] = useState<ActiveEntity[]>([]);
  const [highlightRef, setHighlightRef] = useState<string | null>(null);
  const [sidebarWidth, setSidebarWidth] = useState(300);
  const draggingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const activeEntity: ActiveEntity = entityHistory.length > 0
    ? entityHistory[entityHistory.length - 1]
    : null;

  useEffect(() => {
    setSidebarWidth(Math.max(window.innerWidth * 0.5, 260));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (!loading) { setTimeout(() => setLoadingStep(0), 0); return; }
    const iv = setInterval(() => {
      setLoadingStep(p => p < LOADING_STEPS.length - 1 ? p + 1 : p);
    }, 1800);
    return () => clearInterval(iv);
  }, [loading]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const max = window.innerWidth * 0.7;
      setSidebarWidth(Math.min(Math.max(e.clientX, 260), max));
    };
    const onUp = () => {
      draggingRef.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
  }, []);

  const startDrag = () => {
    draggingRef.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const resizeTextarea = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "24px";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  useEffect(() => { resizeTextarea(); }, [question]);

  const stopGeneration = () => {
    abortController?.abort();
    setLoading(false);
    setAbortController(null);
  };

  const askQuestion = useCallback(async (q: string) => {
    if (loading) return;
    const continuation = isContinuationCommand(q);
    const questionIsArabic = isArabicText(q);

    const history = [
      ...messages.filter(m => !m.isWelcome).slice(-10)
        .map(m => ({ role: m.role, content: m.content })),
      { role: "user" as const, content: q }
    ];

    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant" && !m.isWelcome);

    if (!continuation) {
      setMessages(prev => [...prev, { role: "user", content: q, isArabic: questionIsArabic }]);
    }

    const controller = new AbortController();
    setAbortController(controller);
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, history, entityHistory }),
        signal: controller.signal,
      });
      const data = await res.json();

      if (Array.isArray(data.entityHistory)) {
        setEntityHistory(data.entityHistory);
      }

      // قاعدة تحديث الموارد: وجود sourceFileIds = رد بحثي → حدّث؛ غيابها → لا تلمس
      if (Array.isArray(data.sourceFileIds)) {
        setRelatedImages(Array.isArray(data.images) ? data.images : []);

        // ★ مراجع هذا الرد بالضبط، بالصيغة المركّبة الجاهزة من الـ backend
        setAnswerReferences(Array.isArray(data.references) ? data.references : []);

        // ★ خريطة docIdx → filename، مبنية من نفس ترتيب sourceFileIds
        //   (يطابق docIndexMap اللي بناها الـ backend بنفس الترتيب بالضبط)
        const newDocIndexMap: Record<number, string> = {};
        data.sourceFileIds.forEach((filename: string, idx: number) => {
          newDocIndexMap[idx + 1] = filename;
        });
        setDocIndexMap(newDocIndexMap);

        if (data.sourceFileIds.length === 0) {
          setSourceGuides([]);
        } else {
          fetch(`/api/source-guides?ids=${data.sourceFileIds.map((id: string) => encodeURIComponent(id)).join(",")}`)
            .then(r => r.json())
            .then(d => { if (Array.isArray(d.guides)) setSourceGuides(d.guides); })
            .catch(() => {});
        }
      }

      if (data.merge && lastAssistant) {
        setMessages(prev => {
          const copy = [...prev];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].role === "assistant" && !copy[i].isWelcome) {
              copy[i] = {
                ...copy[i],
                content: copy[i].content + "\n\n" + (data.answer || ""),
                truncated: !!data.truncated,
              };
              break;
            }
          }
          return copy;
        });
      } else {
        setMessages(prev => [...prev, {
          role: "assistant",
          content: data.answer || data.error || "Something went wrong.",
          images: data.images || [],
          isArabic: continuation ? (lastAssistant?.isArabic ?? questionIsArabic) : questionIsArabic,
          truncated: !!data.truncated,
        }]);
      }
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "Connection error. Please try again.",
        isArabic: false,
      }]);
    } finally {
      setLoading(false);
      setAbortController(null);
    }
  }, [loading, messages, entityHistory]);

  const handleAsk = async () => {
    if (!question.trim() || loading) return;
    const msg = question.trim();
    setQuestion("");
    await askQuestion(msg);
  };

  const handleContinue = () => {
    askQuestion("أكمل");
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleAsk(); }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData("text");
    const ta = textareaRef.current;
    if (!ta) return;
    const s = ta.selectionStart, en = ta.selectionEnd;
    setQuestion(prev => prev.slice(0, s) + pasted + prev.slice(en));
    setTimeout(() => {
      if (ta) { ta.selectionStart = ta.selectionEnd = s + pasted.length; resizeTextarea(); }
    }, 0);
  };

  const currentQuestions = commonQuestions.find(c => c.category === activeCategory)?.questions || [];
  const canSend = question.trim().length > 0 && !loading;

  return (
    <div className="flex h-screen bg-[#212121] text-[#ececf1]">

      {/* Sidebar — عرض ديناميكي، يبدأ 50% */}
      <div className="hidden md:flex shrink-0 bg-[#171717] flex-col relative"
        style={{ width: sidebarWidth }}>
        <div className="px-4 py-4 border-b border-[#2f2f2f]">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-[#10a37f] flex items-center justify-center">
              <RobotIcon className="w-5 h-5 text-white" />
            </div>
            <div>
              <p className="text-sm font-semibold text-[#ececf1]">DesaltAI</p>
              <p className="text-[10px] text-[#8e8ea0]">Desalination Research</p>
            </div>
          </div>
        </div>

        {activeEntity && (
          <div className="px-3 pt-3">
            <div className="flex items-center gap-2 bg-[#10a37f]/10 border border-[#10a37f]/20 rounded-lg px-3 py-2">
              <div className="w-1.5 h-1.5 rounded-full bg-[#10a37f] shrink-0 animate-pulse"></div>
              <div className="min-w-0 flex-1">
                <p className="text-[9px] text-[#10a37f] uppercase tracking-wider font-semibold">Active Topic</p>
                <p className="text-[11px] text-[#ececf1] font-medium truncate">{activeEntity.name}</p>
              </div>
              <button onClick={() => setEntityHistory([])}
                className="shrink-0 text-[#8e8ea0] hover:text-[#ececf1] transition">
                <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M18 6L6 18M6 6l12 12" strokeLinecap="round"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        <div className="px-3 pt-3">
          <button onClick={() => setShowQuickQueries(v => !v)}
            className="w-full flex items-center justify-between px-3 py-2 rounded-lg text-[#8e8ea0] hover:text-[#ececf1] hover:bg-[#2f2f2f] transition">
            <span className="text-[10px] font-semibold uppercase tracking-wider">Quick Queries</span>
            <svg className={`w-3 h-3 transition-transform ${showQuickQueries ? "rotate-180" : ""}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
          {showQuickQueries && (
            <div className="mt-1 mb-2">
              <div className="flex gap-1 mb-2 bg-[#2f2f2f] p-1 rounded-lg">
                {commonQuestions.map(c => (
                  <button key={c.category} onClick={() => setActiveCategory(c.category)}
                    className={`flex-1 text-[11px] py-1.5 rounded-md transition font-medium ${
                      activeCategory === c.category ? "bg-[#10a37f] text-white" : "text-[#8e8ea0] hover:text-[#ececf1]"
                    }`}>
                    {c.category}
                  </button>
                ))}
              </div>
              <div className="flex flex-col gap-0.5">
                {currentQuestions.map((q, i) => (
                  <button key={i} onClick={() => { askQuestion(q); setShowQuickQueries(false); }}
                    className="text-left text-[11px] text-[#8e8ea0] hover:text-[#ececf1] hover:bg-[#2f2f2f] px-3 py-2 rounded-lg transition">
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* ★ Research Resources — لوحة واحدة، كل شيء تحت بعض */}
        <div className="flex flex-col flex-1 min-h-0 px-3 pt-2 pb-3">
          <div className="mb-2 px-1">
            <p className="text-[10px] font-semibold text-[#8e8ea0] uppercase tracking-wider">Research Resources</p>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0">
            <ResourcesPanel
              guides={sourceGuides}
              relatedImages={relatedImages}
              answerReferences={answerReferences}
              docIndexMap={docIndexMap}
              highlightRef={highlightRef}
              onHighlightDone={() => setHighlightRef(null)}
            />
          </div>
        </div>

        <div className="px-3 py-3 border-t border-[#2f2f2f]">
          <div className="flex items-center gap-2 px-2">
            <div className="w-1.5 h-1.5 rounded-full bg-[#10a37f] animate-pulse"></div>
            <span className="text-[10px] text-[#8e8ea0]">Gemini 2.5 Flash · GPT Embeddings</span>
          </div>
        </div>

        <div onMouseDown={startDrag}
          className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize group z-10">
          <div className="absolute inset-y-0 right-0 w-px bg-[#2f2f2f] group-hover:bg-[#10a37f] group-hover:w-0.5 transition-all" />
        </div>
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">

        <div className="flex md:hidden items-center justify-between px-4 py-3 border-b border-[#2f2f2f] bg-[#171717]">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[#10a37f] flex items-center justify-center">
              <RobotIcon className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-sm">DesaltAI</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[#10a37f] animate-pulse"></div>
            <span className="text-[10px] text-[#8e8ea0]">Online</span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-3xl mx-auto px-4 py-6 flex flex-col">
            {messages.map((msg, i) => {
              const isUser = msg.role === "user";
              const textAlign = msg.isArabic ? "text-right" : "text-left";
              const dir = msg.isArabic ? "rtl" : "ltr";
              const isLastMessage = i === messages.length - 1;

              return (
                <div key={i} className={`group flex gap-4 py-5 ${isUser ? "flex-row-reverse" : "flex-row"}`}>
                  <div className={`shrink-0 w-8 h-8 rounded-full flex items-center justify-center mt-0.5 ${
                    isUser ? "bg-[#19c37d]" : "bg-[#10a37f]"
                  }`}>
                    {isUser
                      ? <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z"/></svg>
                      : <RobotIcon className="w-4 h-4 text-white" />
                    }
                  </div>

                  <div className={`flex-1 min-w-0 ${isUser ? "flex justify-end" : ""}`}>
                    {isUser ? (
                      <div className={`max-w-[85%] bg-[#2f2f2f] rounded-2xl rounded-tr-sm px-4 py-3 text-[15px] leading-7 ${textAlign}`} dir={dir}>
                        <p className="whitespace-pre-wrap">{msg.content}</p>
                      </div>
                    ) : (
                      <div className={`text-[15px] leading-7 text-[#ececf1] ${textAlign}`} dir={dir}>
                        <ReactMarkdown
                          remarkPlugins={[remarkGfm]}
                          components={{
                            table: (props: React.TableHTMLAttributes<HTMLTableElement> & {children?: React.ReactNode}) => (
                              <div className="overflow-x-auto my-4 rounded-xl border border-[#3f3f3f]" dir="ltr">
                                <table className="w-full text-sm" {...props} />
                              </div>
                            ),
                            thead: (props: React.HTMLAttributes<HTMLTableSectionElement>) => <thead className="bg-[#2f2f2f]" {...props} />,
                            th: (props: React.ThHTMLAttributes<HTMLTableHeaderCellElement>) => <th className="px-4 py-3 text-left text-xs font-semibold text-[#8e8ea0] uppercase tracking-wide border-b border-[#3f3f3f]" {...props} />,
                            td: (props: React.TdHTMLAttributes<HTMLTableDataCellElement>) => <td className="px-4 py-2.5 text-[#ececf1] border-b border-[#2f2f2f] text-sm" {...props} />,
                            p: (props: React.HTMLAttributes<HTMLParagraphElement>) => <p className="mb-4 last:mb-0 leading-7" {...props} />,
                            strong: (props: React.HTMLAttributes<HTMLElement>) => <strong className="font-semibold text-white" {...props} />,
                            em: (props: React.HTMLAttributes<HTMLElement>) => <em className="text-[#8e8ea0] not-italic text-sm" {...props} />,
                            // ★ روابط الاستشهاد #cite-D{n}-{m} → chip يفتح المرجع الصحيح بالضبط في اللوحة
                            a: (props: React.ComponentPropsWithoutRef<'a'> & {children?: React.ReactNode}) => {
                              const href = props.href || "";
                              const citeMatch = href.match(/^#cite-(D\d+-\d+)$/);
                              if (citeMatch) {
                                const fullId = citeMatch[1];
                                return (
                                  <button
                                    onClick={(e) => { e.preventDefault(); setHighlightRef(fullId); }}
                                    title={`Show reference [${displayNumber(fullId)}]`}
                                    className="inline-flex items-center justify-center align-super text-[10px] font-bold text-[#10a37f] bg-[#10a37f]/15 hover:bg-[#10a37f]/30 rounded px-1 mx-0.5 min-w-[16px] h-[16px] transition cursor-pointer border-0">
                                    {displayNumber(fullId)}
                                  </button>
                                );
                              }
                              return (
                                <a {...props} target="_blank" rel="noopener noreferrer"
                                  className="text-[#10a37f] underline underline-offset-2 hover:text-[#1abc91] transition">
                                  {props.children}
                                </a>
                              );
                            },
                            h1: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h1 className={`text-xl font-bold text-white mt-6 mb-3 ${textAlign}`} {...props} />,
                            h2: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h2 className={`text-lg font-bold text-white mt-5 mb-2 ${textAlign}`} {...props} />,
                            h3: (props: React.HTMLAttributes<HTMLHeadingElement>) => <h3 className={`text-base font-semibold text-[#ececf1] mt-4 mb-2 ${textAlign}`} {...props} />,
                            ul: (props: React.HTMLAttributes<HTMLUListElement>) => <ul className={`space-y-1.5 my-3 ${msg.isArabic ? "list-inside list-disc pr-1" : "list-disc list-outside ms-5"}`} {...props} />,
                            ol: (props: React.HTMLAttributes<HTMLOListElement>) => <ol className={`space-y-1.5 my-3 ${msg.isArabic ? "list-inside list-decimal pr-1" : "list-decimal list-outside ms-5"}`} {...props} />,
                            li: (props: React.LiHTMLAttributes<HTMLLIElement>) => <li className={`${textAlign} text-[#ececf1] leading-7`} {...props} />,
                            hr: () => <hr className="my-5 border-[#3f3f3f]" />,
                            blockquote: (props: React.BlockquoteHTMLAttributes<HTMLElement>) => (
                              <blockquote className="border-l-4 border-[#10a37f] pl-4 my-3 text-[#8e8ea0] italic" {...props} />
                            ),
                            code: ({ className, children, ...props }: { className?: string; children?: React.ReactNode }) => {
                              const isBlock = /language-/.test(className || "") || String(children).includes("\n");
                              if (!isBlock) return (
                                <code className="bg-[#2f2f2f] text-[#10a37f] px-1.5 py-0.5 rounded text-[13px] font-mono" {...props}>
                                  {children}
                                </code>
                              );
                              const codeText = String(children).replace(/\n$/, "");
                              return (
                                <div className="my-4 bg-[#1e1e1e] border border-[#3f3f3f] rounded-xl overflow-hidden" dir="ltr">
                                  <div className="flex items-center justify-between px-4 py-2 bg-[#2f2f2f] border-b border-[#3f3f3f]">
                                    <span className="text-[10px] text-[#8e8ea0] font-medium uppercase tracking-wide">Formula / Calculation</span>
                                    <CopyButton text={codeText} small />
                                  </div>
                                  <pre className="p-4 overflow-x-auto">
                                    <code className="text-[13px] font-mono text-[#10a37f]">{codeText}</code>
                                  </pre>
                                </div>
                              );
                            },
                            pre: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
                          }}
                        >
                          {linkifyCitations(msg.content)}
                        </ReactMarkdown>

                        {msg.truncated && isLastMessage && !loading && (
                          <button
                            onClick={handleContinue}
                            className="mt-1 mb-3 inline-flex items-center gap-1.5 text-[12px] text-[#10a37f] hover:text-[#1abc91] border border-[#10a37f]/30 hover:border-[#10a37f]/60 rounded-lg px-3 py-1.5 transition bg-[#10a37f]/5"
                          >
                            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M9 18l6-6-6-6" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                            {msg.isArabic ? "الإجابة غير مكتملة — اضغط للمتابعة" : "Answer incomplete — click to continue"}
                          </button>
                        )}

                        {!msg.isWelcome && (
                          <div className={`mt-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity ${msg.isArabic ? "justify-end" : ""}`}>
                            <CopyButton text={msg.content} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {loading && (
              <div className="flex gap-4 py-5">
                <div className="shrink-0 w-8 h-8 rounded-full bg-[#10a37f] flex items-center justify-center mt-0.5">
                  <RobotIcon className="w-4 h-4 text-white" />
                </div>
                <div className="flex flex-col gap-1 pt-1">
                  <div className="flex items-center gap-1">
                    {[0,1,2].map(i => (
                      <span key={i} className="block w-2 h-2 rounded-full bg-[#8e8ea0]"
                        style={{ animation: `typing-bounce 1.4s ease-in-out ${i * 0.16}s infinite` }} />
                    ))}
                  </div>
                  <p className="text-[11px] text-[#555]">{LOADING_STEPS[loadingStep]}</p>
                </div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>
        </div>

        {/* Input */}
        <div className="px-4 pb-4 pt-2">
          <div className="max-w-3xl mx-auto">
            <div className={`relative flex items-end gap-2 bg-[#2f2f2f] border rounded-2xl px-4 py-3 transition-colors ${
              loading ? "border-[#3f3f3f]" : "border-[#4f4f4f] hover:border-[#5f5f5f] focus-within:border-[#10a37f]"
            }`}>
              <textarea
                ref={textareaRef}
                value={question}
                onChange={e => setQuestion(e.target.value)}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                placeholder="Message DesaltAI..."
                rows={1}
                disabled={loading}
                className="flex-1 bg-transparent text-[#ececf1] placeholder-[#8e8ea0] outline-none resize-none text-[15px] leading-6 max-h-[200px] overflow-y-auto disabled:opacity-50"
                style={{ minHeight: "24px" }}
              />
              <div className="shrink-0 pb-0.5">
                {loading ? (
                  <button onClick={stopGeneration}
                    className="w-8 h-8 rounded-lg bg-white/10 hover:bg-white/20 flex items-center justify-center transition">
                    <svg className="w-4 h-4 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <rect x="6" y="6" width="12" height="12" rx="2"/>
                    </svg>
                  </button>
                ) : (
                  <button onClick={handleAsk} disabled={!canSend}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition ${
                      canSend ? "bg-[#10a37f] hover:bg-[#0d8f6f] text-white" : "bg-[#3f3f3f] text-[#6f6f6f] cursor-not-allowed"
                    }`}>
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 19V5M5 12l7-7 7 7"/>
                    </svg>
                  </button>
                )}
              </div>
            </div>
            <p className="text-center text-[11px] text-[#8e8ea0] mt-2">
              DesaltAI can make mistakes. Verify important information.
            </p>
          </div>
        </div>
      </div>

      <style jsx global>{`
        @keyframes typing-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
        ::-webkit-scrollbar { width: 5px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb:hover { background: #5f5f5f; }
        * { box-sizing: border-box; }
      `}</style>
    </div>
  );
}