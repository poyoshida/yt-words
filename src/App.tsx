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

// CSV parser: word,start,end (header optional)
const parseCSV = (text: string): Segment[] => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];
  // Skip header if it contains non-time tokens
  const startIdx = /word|start|end|単語/i.test(lines[0]) ? 1 : 0;
  const rows = lines.slice(startIdx);
  const segs: Segment[] = [];
  for (const line of rows) {
    const parts = line.split(/,|\t/).map(x => x.trim());
    if (parts.length < 3) continue;
    const [word, start, end] = parts;
    const s = parseTime(start);
    const e = parseTime(end);
    if (!word) continue;
    if (Number.isFinite(s) && Number.isFinite(e) && e > s) segs.push({ word, start: s, end: e });
  }
  return segs;
};

// Storage keys per video
const storeKey = (videoId: string) => `yt-word-loop:v1:${videoId}`;

export default function App() {
  const [videoInput, setVideoInput] = useState("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  const [videoId, setVideoId] = useState<string>("");
  const [csv, setCsv] = useState<string>("word,start,end\napple,12.3,14.1\nbanana,25,27.2\ncat,40.5,42\ndevelopment,1:03,1:07.5");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [selectedWords, setSelectedWords] = useState<string[]>([]);
  const [knownWords, setKnownWords] = useState<Record<string, boolean>>({});
  const [rate, setRate] = useState<number>(1);
  const [loops, setLoops] = useState<number>(2);
  const [autoAdvance, setAutoAdvance] = useState<boolean>(true);
  const [pipSupported, setPipSupported] = useState<boolean>(false);

  const playerRef = useRef<any>(null);
  const iframeWrap = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<any>(null);
  const currentRef = useRef<{ idx: number; loop: number } | null>(null);

  // Extract videoId from various formats
  const extractVideoId = (urlOrId: string): string => {
    const s = urlOrId.trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
    try {
      const u = new URL(s);
      if (u.hostname.includes("youtu.be")) return u.pathname.replace("/", "");
      if (u.searchParams.get("v")) return u.searchParams.get("v") || "";
      // youtu.be with extra
    } catch {}
    return s;
  };

  // Load YT API
  useEffect(() => {
    loadYouTubeAPI();
    // PiP availability (not guaranteed)
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
        onStateChange: (e: any) => {
          // Handle END / PAUSE if needed
        }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Load from storage on video change
  useEffect(() => {
    if (!videoId) return;
    try {
      const raw = localStorage.getItem(storeKey(videoId));
      if (raw) {
        const saved = JSON.parse(raw);
        setKnownWords(saved.knownWords || {});
        if (saved.csv) setCsv(saved.csv);
        if (saved.segments) setSegments(saved.segments);
        if (saved.selectedWords) setSelectedWords(saved.selectedWords);
      }
    } catch {}
  }, [videoId]);

  // Persist
  useEffect(() => {
    if (!videoId) return;
    const data = { knownWords, csv, segments, selectedWords };
    try { localStorage.setItem(storeKey(videoId), JSON.stringify(data)); } catch {}
  }, [videoId, knownWords, csv, segments, selectedWords]);

  // Parse CSV button handler
  const applyCSV = () => {
    const segs = parseCSV(csv);
    setSegments(segs);
    const words = segs.map(s => s.word);
    setSelectedWords(words.filter(w => !knownWords[w]));
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

  // Attempt PiP (works only if user interacted and browser allows)
  const tryPiP = async () => {
    const iframe = iframeWrap.current?.querySelector('iframe') as HTMLIFrameElement | null;
    if (!iframe) return;
    // @ts-ignore - non-standard but widely supported via experimental API when allowed
    const video: HTMLVideoElement | undefined = (iframe as any)?.contentWindow?.document?.querySelector('video');
    try {
      // Most browsers disallow cross-origin access; PiP may require built-in button instead.
      // We keep this as a best-effort hook; gracefully no-op on failure.
      // Some Chromium builds expose requestPictureInPicture on the HTMLVideoElement.
      if (video && (video as any).requestPictureInPicture) {
        await (video as any).requestPictureInPicture();
      }
    } catch {}
  };

  // UI
  return (
    <div className="min-h-screen bg-white text-gray-900 px-4 pb-28">
      <div className="max-w-screen-sm mx-auto">
        <h1 className="text-2xl font-bold mt-4">YouTube 単語ループ（スマホ向けMVP）</h1>
        <p className="text-sm text-gray-600 mt-1">※ 初回は必ず画面をタップして再生開始してください（自動再生ポリシー対策）。第三者動画の利用は権利に注意。</p>

        {/* Video input */}
        <div className="mt-4 space-y-2">
          <label className="text-sm font-medium">動画URLまたはID</label>
          <div className="flex gap-2">
            <input
              className="flex-1 border rounded-xl px-3 py-2"
              placeholder="https://www.youtube.com/watch?v=..."
              value={videoInput}
              onChange={e => setVideoInput(e.target.value)}
            />
            <button
              className="rounded-xl px-4 py-2 bg-black text-white"
              onClick={() => setVideoId(extractVideoId(videoInput))}
            >読み込む</button>
          </div>
        </div>

        {/* Player */}
        <div className="mt-4 rounded-2xl overflow-hidden border">
          <div ref={iframeWrap} className="w-full"></div>
        </div>

        {/* CSV input */}
        <div className="mt-4">
          <div className="flex items-center justify-between">
            <label className="text-sm font-medium">区間リスト CSV（word,start,end）</label>
            <button className="text-xs underline" onClick={() => setCsv("word,start,end\napple,12.3,14.1\nbanana,25,27.2\ncat,40.5,42\ndevelopment,1:03,1:07.5")}>サンプル</button>
          </div>
          <textarea
            className="w-full border rounded-xl p-3 h-32 mt-1"
            value={csv}
            onChange={e => setCsv(e.target.value)}
          />
          <div className="flex gap-2 mt-2">
            <button className="rounded-xl px-4 py-2 border" onClick={applyCSV}>CSVを反映</button>
            <button className="rounded-xl px-4 py-2 border" onClick={() => setSelectedWords(segments.map(s => s.word))}>全選択</button>
            <button className="rounded-xl px-4 py-2 border" onClick={() => setSelectedWords(segments.filter(s => !knownWords[s.word]).map(s => s.word))}>苦手のみ選択</button>
          </div>
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
            <button className="rounded-2xl py-3 border" onClick={tryPiP}>PiP</button>
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
          <p>・広告や埋め込み不可設定の動画では制御が中断されることがあります。</p>
          <p>・第三者のコンテンツを利用する際は権利・利用規約にご注意ください。自作教材や許諾を得た動画の利用を推奨します。</p>
          <p>・バックグラウンド再生はアカウントやOS仕様の影響を受けます（Premium推奨、PiP併用など）。</p>
        </div>
      </div>
    </div>
  );
}
