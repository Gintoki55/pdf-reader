"use client";

import { useState, useRef, useEffect } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type UploadedFile = {
  name: string;
  done: boolean;
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

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: "مرحباً! أنا مساعدك الذكي. يمكنني الإجابة على أسئلتك بناءً على المستندات المرفوعة." }
  ]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [activeCategory, setActiveCategory] = useState("MSF");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploadLoading(true);
    setSidebarOpen(false);
    setFiles(prev => [...prev, { name: file.name, done: false }]);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/api/upload", { method: "POST", body: formData });
    await res.json();

    setFiles(prev => prev.map(f => f.name === file.name ? { ...f, done: true } : f));
    setUploadLoading(false);

    setMessages(prev => [...prev, {
      role: "assistant",
      content: `✅ تم رفع "${file.name}" بنجاح! يمكنك الآن السؤال عنه.`,
    }]);
  };

  const askQuestion = async (q: string) => {
    if (loading) return;
    setSidebarOpen(false);
    setMessages(prev => [...prev, { role: "user", content: q }]);
    setLoading(true);

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: q }),
    });

    const data = await res.json();
    setMessages(prev => [...prev, {
      role: "assistant",
      content: data.answer || data.error,
    }]);
    setLoading(false);
  };

  const handleAsk = async () => {
    if (!question.trim() || loading) return;
    const userMessage = question.trim();
    setQuestion("");
    await askQuestion(userMessage);
  };

  const currentQuestions = commonQuestions.find(c => c.category === activeCategory)?.questions || [];

  return (
    <div className="flex h-screen bg-[#0f0f13] text-white overflow-hidden relative">

      {/* Overlay للموبايل */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <div className={`
        fixed md:relative z-30 md:z-auto
        w-64 h-full
        bg-[#18181f] border-r border-[#2a2a35]
        flex flex-col p-4 gap-2
        transition-transform duration-300
        ${sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"}
      `}>

        {/* Logo */}
        <div className="flex items-center justify-between pb-4 mb-2 border-b border-[#2a2a35]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-base">📄</div>
            <span className="text-[15px] font-semibold text-[#e8e8f0]">DocChat</span>
          </div>
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-[#555568] hover:text-white text-xl leading-none"
          >✕</button>
        </div>

        {/* Upload Button */}
        <label className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2.5 rounded-xl cursor-pointer transition font-medium">
          <span className="text-lg leading-none">+</span>
          {uploadLoading ? "جاري الرفع..." : "رفع PDF"}
          <input type="file" accept="application/pdf" onChange={handleUpload} className="hidden" />
        </label>

        {/* Files List */}
        {files.length > 0 && (
          <>
            <p className="text-[11px] text-[#555568] font-semibold uppercase tracking-wide px-1 pt-3">المستندات</p>
            <div className="flex flex-col gap-1 overflow-y-auto max-h-64">
              {files.map((f, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[#22222e] border border-[#3a3a50]">
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${f.done ? "bg-emerald-500" : "bg-indigo-400 animate-pulse"}`} />
                  <span className="text-[12px] text-[#9898b0] truncate">{f.name}</span>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="flex-1" />
        <p className="text-[11px] text-[#3a3a50] text-center">{files.length} مستند مرفوع</p>
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Topbar */}
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-[#2a2a35] bg-[#18181f]">
          <div className="flex items-center gap-3">
            {/* Hamburger للموبايل */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden text-[#9898b0] hover:text-white"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-sm font-semibold text-[#e8e8f0]">المساعد الذكي</span>
          </div>
          <span className="text-[11px] text-[#9898b0] bg-[#1e1e2e] border border-[#3a3a50] rounded-full px-3 py-1 hidden sm:block">
            Groq · llama-3.3-70b
          </span>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-5 flex flex-col gap-4">
          {messages.map((msg, i) => (
            <div key={i} className={`flex gap-3 items-start ${msg.role === "user" ? "flex-row-reverse" : ""}`}>
              <div className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-[#1e1e2e] border border-[#3a3a50] text-indigo-400"
              }`}>
                {msg.role === "user" ? "أ" : "AI"}
              </div>
              <div className={`max-w-[85%] sm:max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-7 ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white rounded-br-sm"
                  : "bg-[#1e1e2e] border border-[#2a2a35] text-[#e0e0f0] rounded-bl-sm"
              }`}>
                {msg.content}
              </div>
            </div>
          ))}

          {/* Typing */}
          {loading && (
            <div className="flex gap-3 items-start">
              <div className="w-8 h-8 rounded-full bg-[#1e1e2e] border border-[#3a3a50] flex items-center justify-center text-xs text-indigo-400 font-semibold flex-shrink-0">AI</div>
              <div className="bg-[#1e1e2e] border border-[#2a2a35] rounded-2xl rounded-bl-sm px-4 py-3 flex gap-1.5 items-center">
                <span className="w-1.5 h-1.5 rounded-full bg-[#555568] animate-bounce" style={{animationDelay:"0ms"}} />
                <span className="w-1.5 h-1.5 rounded-full bg-[#555568] animate-bounce" style={{animationDelay:"150ms"}} />
                <span className="w-1.5 h-1.5 rounded-full bg-[#555568] animate-bounce" style={{animationDelay:"300ms"}} />
              </div>
            </div>
          )}

          {/* أسئلة شائعة */}
          {messages.length === 1 && !loading && (
            <div className="flex flex-col gap-3 mt-2">
              <p className="text-[11px] text-[#555568] font-semibold uppercase tracking-wide">أسئلة شائعة</p>

              {/* Category Tabs */}
              <div className="flex gap-2">
                {commonQuestions.map(c => (
                  <button
                    key={c.category}
                    onClick={() => setActiveCategory(c.category)}
                    className={`text-xs px-4 py-1.5 rounded-full border transition ${
                      activeCategory === c.category
                        ? "bg-indigo-600 border-indigo-600 text-white"
                        : "bg-transparent border-[#3a3a50] text-[#9898b0] hover:border-indigo-500 hover:text-indigo-400"
                    }`}
                  >
                    {c.category}
                  </button>
                ))}
              </div>

              {/* Questions */}
              <div className="flex flex-wrap gap-2">
                {currentQuestions.map((q, i) => (
                  <button
                    key={i}
                    onClick={() => askQuestion(q)}
                    className="bg-[#1e1e2e] hover:bg-[#2a2a40] border border-[#3a3a50] hover:border-indigo-500 text-[#9898b0] hover:text-indigo-400 text-xs px-4 py-2 rounded-full transition cursor-pointer text-left"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-4 border-t border-[#2a2a35] bg-[#18181f] flex gap-3 items-center">
          <input
            type="text"
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === "Enter" && handleAsk()}
            placeholder="اكتب سؤالك هنا..."
            className="flex-1 bg-[#0f0f13] border border-[#2a2a35] rounded-xl px-4 py-3 text-sm text-[#e8e8f0] placeholder-[#555568] outline-none focus:border-indigo-500 transition"
          />
          <button
            onClick={handleAsk}
            disabled={loading || !question.trim()}
            className="w-10 h-10 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-xl flex items-center justify-center transition flex-shrink-0"
          >
            <svg className="w-4 h-4 fill-white" viewBox="0 0 24 24"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>
          </button>
        </div>

      </div>
    </div>
  );
}