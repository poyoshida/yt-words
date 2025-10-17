import React, { useEffect, useMemo, useRef, useState } from "react";

// ---- Material Symbols loader (Outlined) ----
const ensureMaterialSymbols = () => {
  const id = "ms-outlined-css";
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href =
    "https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,400,0..1,0";
  document.head.appendChild(link);
};

// --- Utility: load YouTube IFrame API once ---
const loadYouTubeAPI = () => {
  if (typeof window === "undefined") return;
  if ((window as any).YT && (window as any).YT.Player) return;
  const existing = document.querySelector(
    'script[src="https://www.youtube.com/iframe_api"]'
  );
  if (existing) return;
  const tag = document.createElement("script");
  tag.src = "https://www.youtube.com/iframe_api";
  document.head.appendChild(tag);
};

// --- Types ---
interface Segment {
  word: string;
  start: number;
  end: number;
}
interface DatasetMeta {
  id: string;
  name: string;
  createdAt: number;
}
interface DatasetData {
  id: string;
  name: string;
  videoId: string;
  segments: Segment[];
  known: Record<string, boolean>;
  windowSec: number;
  createdAt: number;
}

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
    return (
      parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseFloat(sec)
    );
  }
  return Number(s) || 0;
};

// Extract videoId from various formats
const extractVideoId = (urlOrId: string): string => {
  const s = urlOrId.trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.includes("youtu.be"))
      return u.pathname.replace("/", "");
    if (u.searchParams.get("v")) return u.searchParams.get("v") || "";
  } catch {}
  return s;
};

// CSV upload (new format)
// 1行目: URL/ID, 2行目: 列名(例: 秒数,見出し語,習熟度),
// 3行目以降: 秒数,見出し語(任意),習熟度(空白=0)
const parseUploadedCSV = (text: string, windowSec: number) => {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const cleaned = lines.filter((l) => l && l !== "\ufeff");
  if (cleaned.length < 3)
    throw new Error("CSVは3行以上（URL+ヘッダ+データ）にしてください。");

  const urlLine = cleaned[0].split(",")[0].trim();
  const videoId = extractVideoId(urlLine);
  if (!videoId)
    throw new Error(
      "1行目に有効なYouTube URL/IDを入力してください。"
    );

  const dataLines = cleaned.slice(2);
  const rows: { t: number; word: string; level: number }[] = [];
  for (const line of dataLines) {
    const parts = line.split(/,|\t/).map((s) => s.trim());
    if (!parts[0]) continue; // 秒数必須
    const t = parseTime(parts[0]);
    const word = (parts[1] || ``).trim();
    const lvlRaw = (parts[2] ?? "").trim();
    const level = lvlRaw === "" ? 0 : parseInt(lvlRaw, 10) ? 1 : 0; // 空白→0, 二値0/1
    if (!Number.isFinite(t)) continue;
    rows.push({ t, word, level });
  }

  const segments: Segment[] = rows.map((r) => ({
    word: r.word || `t=${r.t}`,
    start: r.t,
    end: r.t + Math.max(0.3, windowSec),
  }));
  const known: Record<string, boolean> = {};
  rows.forEach((r) => {
    const w = r.word || `t=${r.t}`;
    if (r.level === 1) known[w] = true;
  });

  return { videoId, segments, known };
};

// --- LocalStorage helpers ---
const INDEX_KEY = "yt-word-loop:index"; // DatasetMeta[]
const DS_KEY = (id: string) => `yt-word-loop:ds:${id}`; // DatasetData

const loadIndex = (): DatasetMeta[] => {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
};
const saveIndex = (list: DatasetMeta[]) => {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  } catch {}
};
const saveDataset = (ds: DatasetData) => {
  try {
    localStorage.setItem(DS_KEY(ds.id), JSON.stringify(ds));
  } catch {}
};
const loadDataset = (id: string): DatasetData | null => {
  try {
    const raw = localStorage.getItem(DS_KEY(id));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
};
const rid = () => Math.random().toString(36).slice(2, 10);

export default function App() {
  // landing/list
  const [landing, setLanding] = useState(true);
  const [datasetList, setDatasetList] = useState<DatasetMeta[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  // active learning state
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [knownWords, setKnownWords] = useState<Record<string, boolean>>({});
  const [windowSec, setWindowSec] = useState(1.8);
  const [rate, setRate] = useState(1);
  const [loops, setLoops] = useState(2);
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [pipSupported, setPipSupported] = useState(false);

  const playerRef = useRef<any>(null);
  const iframeWrap = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<any>(null);
  const currentRef = useRef<{ idx: number; loop: number } | null>(null);
  const csvFileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ensureMaterialSymbols();
    loadYouTubeAPI();
    setPipSupported(!!(document as any).pictureInPictureEnabled);
    setDatasetList(loadIndex());
  }, []);

  const buildPlayer = () => {
    if (!iframeWrap.current || !videoId) return;
    if (!(window as any).YT || !(window as any).YT.Player) return;
    if (playerRef.current) {
      try {
        playerRef.current.destroy();
      } catch {}
      playerRef.current = null;
    }
    playerRef.current = new (window as any).YT.Player(iframeWrap.current, {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: { controls: 1, rel: 0, modestbranding: 1 },
      events: {
        onReady: () => {
          try {
            playerRef.current.setPlaybackRate(rate);
          } catch {}
        },
      },
    });
  };

  useEffect(() => {
    if (!landing && videoId) {
      const tm = setInterval(() => {
        if ((window as any).YT && (window as any).YT.Player) {
          clearInterval(tm);
          buildPlayer();
        }
      }, 100);
      return () => clearInterval(tm);
    }
  }, [landing, videoId]);

  // persist active dataset updates
  useEffect(() => {
    if (!activeId) return;
    const data = loadDataset(activeId);
    if (!data) return;
    data.segments = segments;
    data.known = knownWords;
    data.windowSec = windowSec;
    saveDataset(data);
  }, [activeId, segments, knownWords, windowSec]);

  // --- Landing actions ---
  const onUploadClicked = () => csvFileInput.current?.click();

  const handleUpload: React.ChangeEventHandler<HTMLInputElement> = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = String(reader.result || "");
        const { videoId: vid, segments: segs, known } = parseUploadedCSV(
          text,
          windowSec
        );
        const id = rid();
        const meta: DatasetMeta = {
          id,
          name: "NoName",
          createdAt: Date.now(),
        };
        const data: DatasetData = {
          id,
          name: meta.name,
          videoId: vid,
          segments: segs,
          known,
          windowSec,
          createdAt: meta.createdAt,
        };
        const nextList = [meta, ...datasetList];
        setDatasetList(nextList);
        saveIndex(nextList);
        saveDataset(data);
      } catch (err: any) {
        alert(err?.message || "CSVの読み込みに失敗しました");
      }
    };
    reader.readAsText(file);
    e.currentTarget.value = "";
  };

  const startLearning = (id: string) => {
    const data = loadDataset(id);
    if (!data) return;
    setActiveId(id);
    setVideoId(data.videoId);
    setSegments(data.segments);
    setKnownWords(data.known || {});
    setWindowSec(data.windowSec || 1.8);
    setLanding(false);
  };

  const downloadCSV = (id: string) => {
    const data = loadDataset(id);
    if (!data) return;
    const url = data.videoId
      ? `https://www.youtube.com/watch?v=${data.videoId}`
      : "";
    const lines: string[] = [];
    lines.push(url);
    lines.push("秒数,見出し語,習熟度");
    const masteryOf = (w: string) => (data.known[w] ? 1 : 0);
    data.segments.forEach((seg) => {
      lines.push(`${seg.start},${seg.word || ""},${masteryOf(seg.word)}`);
    });
    const csvText = lines.join("\n");
    const filename = `${data.name || "dataset"}-${data.id}.csv`;
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const urlObj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = urlObj;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(urlObj);
  };

  const beginEdit = (id: string) => {
    const meta = datasetList.find((m) => m.id === id);
    if (!meta) return;
    setEditingId(id);
    setEditName(meta.name || "NoName");
  };

  const confirmEdit = (id: string) => {
    const name = (editName || "NoName").trim() || "NoName";
    const next = datasetList.map((m) => (m.id === id ? { ...m, name } : m));
    setDatasetList(next);
    saveIndex(next);
    const data = loadDataset(id);
    if (data) {
      data.name = name;
      saveDataset(data);
    }
    setEditingId(null);
    setEditName("");
  };

  // --- Learning controls ---
  const selectedWords = useMemo(
    () => segments.map((s) => s.word).filter((w) => !knownWords[w]),
    [segments, knownWords]
  );

  const playSegmentAt = (index: number) => {
    if (!playerRef.current || index < 0 || index >= selectedWords.length)
      return;
    const word = selectedWords[index];
    const seg = segments.find((s) => s.word === word);
    if (!seg) return;
    currentRef.current = { idx: index, loop: 0 };
    try {
      playerRef.current.setPlaybackRate(rate);
    } catch {}
    playerRef.current.seekTo(seg.start, true);
    playerRef.current.playVideo();
    clearInterval(pollingRef.current);
    pollingRef.current = setInterval(() => {
      const cur = currentRef.current;
      if (!cur) return;
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
    try {
      playerRef.current?.pauseVideo?.();
    } catch {}
  };
  const handlePlaySelected = () => {
    if (selectedWords.length === 0) return;
    playSegmentAt(0);
  };
  const handleNext = () => {
    const cur = currentRef.current;
    if (!cur) return;
    playSegmentAt(cur.idx + 1);
  };
  const handlePrev = () => {
    const cur = currentRef.current;
    if (!cur) return;
    playSegmentAt(Math.max(0, cur.idx - 1));
  };
  const toggleKnown = (w: string) => {
    setKnownWords((prev) => ({ ...prev, [w]: !prev[w] }));
  };

  const knownCount = useMemo(
    () => Object.values(knownWords).filter(Boolean).length,
    [knownWords]
  );

  // --- UI ---
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-screen-sm mx-auto px-4 pb-28">
        <h1 className="text-2xl font-bold py-3">
          YouTube 単語ループ（スマホ向けMVP）
        </h1>

        {/* Top area 16:9 */}
        <div
          className="w-full rounded-2xl overflow-hidden border bg-black/5"
          style={{ aspectRatio: "16 / 9" }}
        >
          {landing ? (
            <div className="h-full w-full flex flex-col">
              {/* Toolbar */}
              <div className="p-3 flex items-center justify-between">
                <div className="text-sm font-medium">ローカルの学習データ</div>
                <div className="flex items-center gap-2">
                  <input
                    ref={csvFileInput}
                    type="file"
                    accept=".csv,text/csv"
                    className="hidden"
                    onChange={handleUpload}
                  />
                  <button
                    onClick={onUploadClicked}
                    className="w-10 h-10 rounded-full border bg-white flex items-center justify-center"
                    title="アップロード"
                  >
                    <span className="material-symbols-outlined">upload</span>
                  </button>
                </div>
              </div>

              {/* List */}
              <div className="flex-1 overflow-auto px-3 pb-3">
                {datasetList.length === 0 ? (
                  <div className="h-full w-full flex items-center justify-center text-sm text-gray-500">
                    まだ学習データがありません。右上の{" "}
                    <span className="material-symbols-outlined mx-1">
                      upload
                    </span>{" "}
                    からCSVを追加してください。
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {datasetList.map((meta) => (
                      <li
                        key={meta.id}
                        className="bg-white border rounded-xl px-3 py-2 flex items-center justify-between"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          {editingId === meta.id ? (
                            <input
                              className="border rounded-lg px-2 py-1 text-sm w-40"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                            />
                          ) : (
                            <div
                              className="text-sm font-medium truncate max-w-[12rem]"
                              title={meta.name || "NoName"}
                            >
                              {meta.name || "NoName"}
                            </div>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {editingId === meta.id ? (
                            <button
                              className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                              title="確定"
                              onClick={() => confirmEdit(meta.id)}
                            >
                              <span className="material-symbols-outlined">
                                check
                              </span>
                            </button>
                          ) : (
                            <button
                              className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                              title="編集"
                              onClick={() => beginEdit(meta.id)}
                            >
                              <span className="material-symbols-outlined">
                                edit
                              </span>
                            </button>
                          )}
                          <button
                            className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                            title="学習開始"
                            onClick={() => startLearning(meta.id)}
                          >
                            <span className="material-symbols-outlined">
                              play_arrow
                            </span>
                          </button>
                          <button
                            className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                            title="ダウンロード"
                            onClick={() => downloadCSV(meta.id)}
                          >
                            <span className="material-symbols-outlined">
                              download
                            </span>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            // Player mounted here (fills 16:9 area)
            <div ref={iframeWrap} className="w-full h-full" />
          )}
        </div>

        {/* Controls & lists: visible only when learning */}
        {!landing && (
          <>
            <div className="mt-4 grid grid-cols-3 gap-2 items-end">
              <div>
                <label className="block text-sm">ループ回数/単語</label>
                <input
                  type="number"
                  min={1}
                  value={loops}
                  onChange={(e) =>
                    setLoops(
                      Math.max(1, parseInt(e.target.value || "1", 10))
                    )
                  }
                  className="w-full border rounded-xl px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm">再生速度</label>
                <select
                  value={rate}
                  onChange={(e) => setRate(parseFloat(e.target.value))}
                  className="w-full border rounded-xl px-3 py-2"
                >
                  {[0.75, 1, 1.25, 1.5, 1.75, 2].map((r) => (
                    <option key={r} value={r}>
                      {r}x
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="autoNext"
                  type="checkbox"
                  checked={autoAdvance}
                  onChange={(e) => setAutoAdvance(e.target.checked)}
                />
                <label htmlFor="autoNext" className="text-sm">
                  自動で次へ
                </label>
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                className="rounded-2xl py-3 bg-black text-white"
                onClick={handlePlaySelected}
              >
                選択を再生
              </button>
              <button className="rounded-2xl py-3 border" onClick={handlePrev}>
                前へ
              </button>
              <button className="rounded-2xl py-3 border" onClick={handleNext}>
                次へ
              </button>
              <button className="rounded-2xl py-3 border col-span-2" onClick={stopAll}>
                一時停止
              </button>
              {pipSupported ? (
                <button className="rounded-2xl py-3 border">PiP</button>
              ) : (
                <button className="rounded-2xl py-3 border opacity-60" disabled>
                  PiP非対応
                </button>
              )}
            </div>

            {/* Words list */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-gray-600">
                  総単語 {segments.length} ／ 既知 {knownCount}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {segments.map((seg) => {
                  const known = !!knownWords[seg.word];
                  return (
                    <div
                      key={seg.word}
                      className={`flex items-center gap-2 border rounded-full pl-2 pr-3 py-1 ${
                        !known ? "border-black" : ""
                      }`}
                    >
                      <span
                        className={`text-sm ${
                          known ? "line-through text-gray-400" : ""
                        }`}
                      >
                        {seg.word}
                      </span>
                      <button
                        className={`w-8 h-8 rounded-full border flex items-center justify-center ${
                          known ? "bg-gray-100" : "bg-amber-100"
                        }`}
                        onClick={() => toggleKnown(seg.word)}
                        title={known ? "既知→未習" : "未習→既知"}
                      >
                        <span className="material-symbols-outlined text-[18px]">
                          {known ? "task_alt" : "radio_button_unchecked"}
                        </span>
                      </button>
                      <button
                        className="text-xs underline"
                        onClick={() => {
                          const pool = segments
                            .map((s) => s.word)
                            .filter((w) => !knownWords[w]);
                          const i = pool.indexOf(seg.word);
                          if (i >= 0) playSegmentAt(i);
                        }}
                      >
                        ▶︎
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}

        {/* Footer tips */}
        <div className="mt-8 text-xs text-gray-500 pb-8">
          <p>
            ・ページ上部は 16:9 の動画表示エリアです。学習開始前はローカルの学習データ一覧とアップロードボタンを表示します。
          </p>
          <p>
            ・CSV形式：1行目=動画URL/ID、2行目=ヘッダ（例：秒数,見出し語,習熟度）、3行目以降=データ。見出し語は空でもOK、習熟度の空白は0（未習）。
          </p>
        </div>
      </div>
    </div>
  );
}
