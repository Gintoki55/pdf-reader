"use client";

import { useState } from "react";

export default function Home() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);

  const handleUpload = async (e: any) => {
    const file = e.target.files[0];
    if (!file) return;

    setLoading(true);

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch("/api/upload", {
      method: "POST",
      body: formData,
    });

    const data = await res.json();

    setText(data.text || "ما تم استخراج نص");
    setLoading(false);
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-10 bg-gray-50">
      <h1 className="text-2xl font-bold mb-6">📄 PDF Reader</h1>

      <input type="file" accept="application/pdf" onChange={handleUpload} />

      {loading && <p className="mt-4">جاري قراءة الملف...</p>}

      <pre className="mt-6 p-4 bg-white border rounded w-full max-w-3xl h-96 overflow-auto whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}