import React, { useEffect, useMemo, useRef, useState } from "react";

// --- Utility: load YouTube IFrame API once ---
const loadYouTubeAPI = () => {
  if (typeof window === "undefined") return;
  if ((window as any).YT && (window as any).YT.Player) return;
  const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
  if (existing) return;
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
};

// --- Types ---
interface Segment { word: string; start: number; end: number; }

// Parse mm:ss(.ms) or seconds string → seconds number
const parseTime = (raw: string): number => {
  const s = raw.trim();
  if (!s) return 0;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const mmss = s.split(":");
  if (mmss.length === 2) {
    const [m, sec] = mmss;
    return parseInt(m, 10) * 60 + parseFloat(sec);
  }
  if (mmss.length === 3) {
    const [h, m, sec] = mmss;
    return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec);
  }
  return Number(s) || 0;
};

// Storage keys per video
const storeKey = (videoId: string) => `yt-word-loop:v3:${videoId}`;

export default function App() {
  const [videoId, setVideoId] = useState<string>("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [knownWords, setKnownWords] = useState<Record<string, boolean>>({}); // level==1 → known
  const [rate, setRate] = useState<number>(1);
  const [loops, setLoops] = useState<number>(2);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);
  const [pipSupported, setPipSupported] = useState<boolean>(false);
  const [windowSec, setWindowSec] = useState<number>(1.8); // 秒数からこの長さを再生

  const playerRef = useRef<any>(null);
  const iframeWrap = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<any>(null);
  const currentRef = useRef<{ idx: number; loop: number } | null>(null);
  const csvFileInput = useRef<HTMLInputElement>(null);

  // Extract videoId from various formats
  const extractVideoId = (urlOrId: string): string => {
    const s = urlOrId.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
      if (u.searchParams.get("v")) return u.searchParams.get("v") || "";
    } catch {}
    return s;
  };

  // Load YT API
  useEffect(() => {
    loadYouTubeAPI();
    setPipSupported(!!(document as any).pictureInPictureEnabled);
  }, []);

  // Rebuild player when videoId changes
  const buildPlayer = () => {
    if (!iframeWrap.current) return;
    if (!(window as any).YT || !(window as any).YT.Player) return;
    if (playerRef.current) {
      try { playerRef.current.destroy(); } catch {}
      playerRef.current = null;
    }
    playerRef.current = new (window as any).YT.Player(iframeWrap.current, {
      videoId,
      width: "100%",
      height: "220",
      playerVars: { controls: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          try { playerRef.current.setPlaybackRate(rate); } catch {}
        },
      }
    });
  };

  useEffect(() => {
    if (!videoId) return;
    const tm = setInterval(() => {
      if ((window as any).YT && (window as any).YT.Player) {
        clearInterval(tm);
        buildPlayer();
      }
    }, 100);
    return () => clearInterval(tm);
  }, [videoId]);

  // Load from storage on video change
  useEffect(() => {
    if (!videoId) return;
    try {
      const raw = localStorage.getItem(storeKey(videoId));
      if (raw) {
        const saved = JSON.parse(raw);
        setKnownWords(saved.knownWords || {});
        if (saved.segments) setSegments(saved.segments);
        if (saved.selectedWords) setSelectedWords(saved.selectedWords);
        if (typeof saved.windowSec === 'number') setWindowSec(saved.windowSec);
      }
    } catch {}
  }, [videoId]);

  // Persist
  useEffect(() => {
    if (!videoId) return;
    const data = { knownWords, segments, selectedWords, windowSec };
    try { localStorage.setItem(storeKey(videoId), JSON.stringify(data)); } catch {}
  }, [videoId, knownWords, segments, selectedWords, windowSec]);

  // --- CSV upload (new format only) ---
  // 1行目: URL/ID, 2行目: 列名(例: 秒数,見出し語,習熟度), 3行目以降: 秒数,見出し語(任意),習熟度(空白=0)
  const parseUploadedCSV = (text: string) => {
    const lines = text.split(/\r?\n/).map(l => l.trim());
    // drop BOM-only or empty lines at top/bottom
    const cleaned = lines.filter(l => l && l !== "\ufeff");
    if (cleaned.length < 3) throw new Error("CSVは3行以上（URL+ヘッダ+データ）にしてください。");

    const urlLine = cleaned[0].split(',')[0].trim();
    const vid = extractVideoId(urlLine);
    if (!vid) throw new Error("1行目に有効なYouTube URL/IDを入力してください。");

    const dataLines = cleaned.slice(2); // skip header line entirely

    const rows: { t: number; word: string; level: number }[] = [];
    for (const line of dataLines) {
      const parts = line.split(/,|\t/).map(s => s.trim());
      if (!parts[0]) continue; // 秒数必須
      const t = parseTime(parts[0]);
      const word = (parts[1] || ``).trim();      // 任意
      const lvlRaw = (parts[2] ?? "").trim();    // 空白は0
      const level = lvlRaw === "" ? 0 : (parseInt(lvlRaw, 10) ? 1 : 0);
      if (!Number.isFinite(t)) continue;
      rows.push({ t, word, level });
    }

    // rows -> segments (windowSec)
    const segs: Segment[] = rows.map(r => ({
      word: r.word || `t=${r.t}`,
      start: r.t,
      end: r.t + Math.max(0.3, windowSec),
    }));

    // knownWords: level==1
    const kw: Record<string, boolean> = {};
    rows.forEach(r => { const w = r.word || `t=${r.t}`; if (r.level === 1) kw[w] = true; });

    return { vid, segs, kw };
  };

  const onCsvFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || '');
        const { vid, segs, kw } = parseUploadedCSV(text);
        setVideoId(vid); // 自動ロード
        setSegments(segs);
        setKnownWords(kw);
        setSelectedWords(segs.map(s => s.word).filter(w => !kw[w]));
      } catch (err: any) {
        alert(err?.message || 'CSVの読み込みに失敗しました');
      }
    };
    reader.readAsText(file);
    e.currentTarget.value = '';
  };

  // CSV download (same format)
  const downloadCSV = () => {
    const url = videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
    const lines: string[] = [];
    lines.push(url);
    lines.push('秒数,見出し語,習熟度');
    const masteryOf = (w: string) => (knownWords[w] ? 1 : 0);
    segments.forEach(seg => {
      lines.push(`${seg.start},${seg.word || ''},${masteryOf(seg.word)}`);
    });
    const csvText = lines.join('\n');
    const filename = `segments-${videoId || 'data'}.csv`;
    const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
    const urlObj = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = urlObj; a.download = filename; a.click();
    URL.revokeObjectURL(urlObj);
  };

  // Controls
  const playSegmentAt = (index: number) => {
    if (!playerRef.current || index < 0 || index >= selectedWords.length) return;
    const word = selectedWords[index];
    const seg = segments.find(s => s.word === word);
    if (!seg) return;
    currentRef.current = { idx: index, loop: 0 };
    try { playerRef.current.setPlaybackRate(rate); } catch {}
    playerRef.current.seekTo(seg.start, true);
    playerRef.current.playVideo();
    clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      const cur = currentRef.current; if (!cur) return;
      const t = playerRef.current?.getCurrentTime?.() ?? 0;
      if (t >= seg.end) {
        cur.loop += 1;
        if (cur.loop < loops) {
          playerRef.current.seekTo(seg.start, true);
          playerRef.current.playVideo();
        } else {
          clearInterval(pollingRef.current);
          pollingRef.current = null;
          if (autoAdvance) {
            playSegmentAt(index + 1);
          } else {
            playerRef.current.pauseVideo();
          }
        }
      }
    }, 120);
  };

  const stopAll = () => {
    clearInterval(pollingRef.current);
    pollingRef.current = null;
    currentRef.current = null;
    try { playerRef.current?.pauseVideo?.(); } catch {}
  };

  const handlePlaySelected = () => {
    if (selectedWords.length === 0) return;
    playSegmentAt(0);
  };

  const handleNext = () => {
    const cur = currentRef.current; if (!cur) return;
    playSegmentAt(cur.idx + 1);
  };

  const handlePrev = () => {
    const cur = currentRef.current; if (!cur) return;
    playSegmentAt(Math.max(0, cur.idx - 1));
  };

  const toggleKnown = (w: string) => {
    setKnownWords(prev => ({ ...prev, [w]: !prev[w] }));
    setSelectedWords(prev => prev.filter(x => x !== w));
  };

  const toggleSelect = (w: string) => {
    setSelectedWords(prev => prev.includes(w) ? prev.filter(x => x !== w) : [...prev, w]);
  };

  const knownCount = useMemo(() => Object.values(knownWords).filter(Boolean).length, [knownWords]);

  // UI
  return (
    <div className="min-h-screen bg-white text-gray-900 px-4 pb-28">
      <div className="max-w-screen-sm mx-auto">
        <h1 className="text-2xl font-bold mt-4">YouTube 単語ループ（スマホ向けMVP）</h1>
        <p className="text-sm text-gray-600 mt-1">
          CSV形式：1行目=動画URL/ID、2行目=列名（例：秒数,見出し語,習熟度）、3行目以降=データ行。見出し語は空でもOK、習熟度の空白は0（未習）。
        </p>

        {/* CSV Only: Upload & Download */}
        <div className="mt-4 p-3 border rounded-2xl">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm font-medium">CSVをアップロード</div>
            <div className="flex gap-2">
              <input ref={csvFileInput} type="file" accept=".csv,text/csv" className="hidden" onChange={onCsvFileSelected} />
              <button className="rounded-xl px-4 py-2 border" onClick={() => csvFileInput.current?.click()}>CSVファイルを選択</button>
              <button className="rounded-xl px-4 py-2 border" onClick={downloadCSV} disabled={!segments.length}>CSVをダウンロード</button>
            </div>
          </div>
          <div className="mt-2 text-xs text-gray-500">
            <p>例：</p>
            <pre className="whitespace-pre-wrap bg-gray-50 p-2 rounded-md border text-[12px]">
{`https://www.youtube.com/watch?v=Rp5WVODIGZ0
秒数,見出し語,習熟度
12.3,apple,0
25,banana,1
40.5,cat,0
63,development,0`}
            </pre>
          </div>
          <div className="mt-3 flex items-center gap-3 text-sm">
            <label className="flex items-center gap-2">
              <span className="text-gray-600">ウィンドウ長（秒）</span>
              <input
                type="number"
                min={0.3}
                step={0.1}
                value={windowSec}
                onChange={e => setWindowSec(Math.max(0.3, parseFloat(e.target.value || '1.8')))}
                className="w-24 border rounded-xl px-3 py-1"
              />
            </label>
            <span className="text-gray-500">※ 各行の秒数からこの長さだけ再生</span>
          </div>
        </div>

        {/* Player */}
        <div className="mt-4 rounded-2xl overflow-hidden border">
          <div ref={iframeWrap} className="w-full"></div>
        </div>

        {/* Controls */}
        <div className="mt-4 grid grid-cols-3 gap-2 items-end">
          <div>
            <label className="block text-sm">ループ回数/単語</label>
            <input type="number" min={1} value={loops} onChange={e => setLoops(Math.max(1, parseInt(e.target.value || "1", 10)))} className="w-full border rounded-xl px-3 py-2" />
          </div>
          <div>
            <label className="block text-sm">再生速度</label>
            <select value={rate} onChange={e => setRate(parseFloat(e.target.value))} className="w-full border rounded-xl px-3 py-2">
              {[0.75, 1, 1.25, 1.5, 1.75, 2].map(r => <option key={r} value={r}>{r}x</option>)}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <input id="autoNext" type="checkbox" checked={autoAdvance} onChange={e => setAutoAdvance(e.target.checked)} />
            <label htmlFor="autoNext" className="text-sm">自動で次へ</label>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-3 gap-2">
          <button className="rounded-2xl py-3 bg-black text-white" onClick={handlePlaySelected}>選択を再生</button>
          <button className="rounded-2xl py-3 border" onClick={handlePrev}>前へ</button>
          <button className="rounded-2xl py-3 border" onClick={handleNext}>次へ</button>
          <button className="rounded-2xl py-3 border col-span-2" onClick={stopAll}>一時停止</button>
          {pipSupported ? (
            <button className="rounded-2xl py-3 border">PiP</button>
          ) : (
            <button className="rounded-2xl py-3 border opacity-60" disabled>PiP非対応</button>
          )}
        </div>

        {/* Words list */}
        <div className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm text-gray-600">総単語 {segments.length} ／ 既知 {knownCount}</div>
            <button className="text-xs underline" onClick={() => setKnownWords({})}>既知リセット</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {segments.map(seg => {
              const selected = selectedWords.includes(seg.word);
              const known = !!knownWords[seg.word];
              return (
                <div key={seg.word} className={`flex items-center gap-2 border rounded-full pl-2 pr-3 py-1 ${selected ? 'border-black' : ''}`}>
                  <button
                    className={`w-5 h-5 rounded-full border flex items-center justify-center ${selected ? 'bg-black text-white' : ''}`}
                    title={selected ? '選択解除' : '選択'}
                    onClick={() => toggleSelect(seg.word)}
                  >{selected ? '✓' : ''}</button>
                  <span className={`text-sm ${known ? 'line-through text-gray-400' : ''}`}>{seg.word}</span>
                  <button className={`text-xs px-2 py-1 rounded-full ${known ? 'bg-gray-200' : 'bg-amber-100'}`} onClick={() => toggleKnown(seg.word)}>
                    {known ? '既知' : '未習'}
                  </button>
                  <button className="text-xs underline" onClick={() => { setSelectedWords([seg.word]); playSegmentAt(0); }}>▶︎</button>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer tips */}
        <div className="mt-8 text-xs text-gray-500 pb-8">
          <p>・CSV以外の入力欄は廃止しました。1行目URL/ID、2行目ヘッダ、3行目以降データでアップロードしてください。</p>
          <p>・広告や埋め込み不可設定の動画では制御が中断されることがあります。</p>
          <p>・第三者のコンテンツを利用する際は権利・利用規約にご注意ください。自作教材や許諾を得た動画の利用を推奨します。</p>
        </div>
      </div>
    </div>
  );
}
