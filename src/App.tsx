import React, { useEffect, useMemo, useRef, useState } from "react";

/** Material Symbols（Outlined）を読み込み */
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

/** YouTube IFrame API を一度だけ読み込み */
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

/** 型 */
interface Segment {
  word: string; // 単語名（空でもOK）
  start: number; // 秒
  end: number; // 秒（start + windowSec）
}
interface DatasetMeta {
  id: string;
  title: string; // YouTube動画タイトル（自動取得）
  createdAt: number;
}
interface DatasetData {
  id: string;
  title: string;
  videoId: string;
  segments: Segment[];
  known: Record<string, boolean>; // key: word||t=sec
  windowSec: number;
  createdAt: number;
}

/** mm:ss(.ms) or seconds → seconds number */
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

/** CSV（軽量フォーマット）
 *  1行目: URL/ID
 *  2行目: 列名（例: 秒数,見出し語,習熟度）
 *  3行目以降: 秒数,見出し語(任意),習熟度(空白=0)
 */
const parseUploadedCSV = (text: string, windowSec: number) => {
  const BOM = String.fromCharCode(65279);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(new RegExp("^" + BOM), "").trim());
  const cleaned = lines.filter((l) => l);
  if (cleaned.length < 3)
    throw new Error("CSVは3行以上（URL+ヘッダ+データ）にしてください。");

  const urlLine = cleaned[0].split(",")[0].trim();
  const videoId = extractVideoId(urlLine);
  if (!videoId)
    throw new Error("1行目に有効なYouTube URL/IDを入力してください。");

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

  rows.sort((a, b) => a.t - b.t);

  const segments: Segment[] = rows.map((r) => ({
    word: r.word || ``,
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

/** URL/ID → videoId */
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

/** YouTubeタイトル取得（oEmbed） */
const fetchVideoTitle = async (videoId: string): Promise<string> => {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("oEmbed fetch failed");
    const json = await res.json();
    return (json?.title as string) || "NoName";
  } catch {
    return "NoName";
  }
};

/** LocalStorage helpers */
const INDEX_KEY = "yt-word-loop:index";
const DS_KEY = (id: string) => `yt-word-loop:ds:${id}`;
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
const deleteDataset = (id: string) => {
  try {
    localStorage.removeItem(DS_KEY(id));
  } catch {}
};
const rid = () => Math.random().toString(36).slice(2, 10);

/** 16:9トップエリアのモード */
type TopMode = "select" | "help" | "video";

export default function App() {
  /** トップエリア */
  const [topMode, setTopMode] = useState<TopMode>("select");
  const [datasetList, setDatasetList] = useState<DatasetMeta[]>([]);
  const [windowSec, setWindowSec] = useState(1.8);

  /** 再生関連 */
  const [activeId, setActiveId] = useState<string | null>(null);
  const [videoId, setVideoId] = useState("");
  const [segments, setSegments] = useState<Segment[]>([]);
  const [knownWords, setKnownWords] = useState<Record<string, boolean>>({});
  const [loops, setLoops] = useState(2);
  const [pipSupported, setPipSupported] = useState(false);

  const playerRef = useRef<any>(null);
  const iframeWrap = useRef<HTMLDivElement>(null);
  const pollingRef = useRef<any>(null);
  const currentRef = useRef<{ idx: number; loop: number } | null>(null);
  const csvFileInput = useRef<HTMLInputElement>(null);

  /** 起動 */
  useEffect(() => {
    ensureMaterialSymbols();
    loadYouTubeAPI();
    setPipSupported(!!(document as any).pictureInPictureEnabled);
    setDatasetList(loadIndex());
  }, []);

  /** プレイヤー構築（videoモード時） */
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
            playerRef.current.setPlaybackRate(1);
          } catch {}
        },
      },
    });
  };

  useEffect(() => {
    if (topMode !== "video" || !videoId) return;
    const tm = setInterval(() => {
      if ((window as any).YT && (window as any).YT.Player) {
        clearInterval(tm);
        buildPlayer();
      }
    }, 100);
    return () => clearInterval(tm);
  }, [topMode, videoId]);

  /** アップロード（CSV） */
  const onUploadClicked = () => csvFileInput.current?.click();

  const handleUpload: React.ChangeEventHandler<HTMLInputElement> = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const text = String(reader.result || "");
        const { videoId: vid, segments: segs, known } = parseUploadedCSV(
          text,
          windowSec
        );
        const id = rid();
        const title = await fetchVideoTitle(vid);
        const meta: DatasetMeta = { id, title, createdAt: Date.now() };
        const data: DatasetData = {
          id,
          title,
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

  /** 学習開始 */
  const startLearning = (id: string) => {
    const data = loadDataset(id);
    if (!data) return;
    setActiveId(id);
    setVideoId(data.videoId);
    setSegments(data.segments);
    setKnownWords(data.known || {});
    setWindowSec(data.windowSec || 1.8);
    setTopMode("video");
  };

  /** ダウンロード（保存） */
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
    const filename = `${data.title || "dataset"}-${data.id}.csv`;
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const urlObj = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = urlObj;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(urlObj);
  };

  /** 削除 */
  const removeDataset = (id: string, title: string) => {
    if (!confirm(`「${title}」を本当に削除しますか？`)) return;
    const next = datasetList.filter((m) => m.id !== id);
    setDatasetList(next);
    saveIndex(next);
    deleteDataset(id);
    if (activeId === id) {
      setActiveId(null);
      setVideoId("");
      setSegments([]);
      setKnownWords({});
      setTopMode("select");
    }
  };

  /** 進捗の永続化 */
  useEffect(() => {
    if (!activeId) return;
    const data = loadDataset(activeId);
    if (!data) return;
    data.segments = segments;
    data.known = knownWords;
    data.windowSec = windowSec;
    saveDataset(data);
  }, [activeId, segments, knownWords, windowSec]);

  /** 未知語リスト（自動で次へ＝常にtrue） */
  const unknownWords = useMemo(
    () =>
      segments.filter(
        (s) => !knownWords[s.word ? s.word : `t=${s.start}`]
      ),
    [segments, knownWords]
  );

  /** 指定秒へジャンプ */
  const playAtTime = (t: number) => {
    if (!playerRef.current) return;
    try {
      playerRef.current.setPlaybackRate(1);
    } catch {}
    playerRef.current.seekTo(t, true);
    playerRef.current.playVideo();
  };

  /** 未知語だけ順送りループ再生（自動進行） */
  const playSequenceFrom = (index: number) => {
    const list = unknownWords;
    if (!playerRef.current || index < 0 || index >= list.length) return;
    const seg = list[index];
    currentRef.current = { idx: index, loop: 0 };
    try {
      playerRef.current.setPlaybackRate(1);
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
          // 常に自動で次へ
          playSequenceFrom(index + 1);
        }
      }
    }, 120);
  };

  /** 再生制御（シンプル化：未習を再生のみ） */
  const handlePlayUnknown = () => {
    if (unknownWords.length === 0) return;
    playSequenceFrom(0);
  };

  /** ✅ 既知トグル（既知⇄未知） */
  const toggleKnown = (w: string) => {
    setKnownWords((prev) => ({ ...prev, [w]: !prev[w] }));
  };

  const knownCount = useMemo(
    () => Object.values(knownWords).filter(Boolean).length,
    [knownWords]
  );

  /** UI */
  return (
    <div className="min-h-screen bg-white text-gray-900">
      <div className="max-w-screen-sm mx-auto px-4 pb-28">

        {/* 最上部：16:9エリア（select / help / video） */}
        <div
          className="w-full rounded-2xl overflow-hidden border bg-black/5 mt-3"
          style={{ aspectRatio: "16 / 9" }}
        >
          {topMode === "select" && (
            <div className="h-full w-full flex flex-col">
              {/* Toolbar */}
              <div className="p-3 flex items-center justify-between">
                <div className="text-sm font-medium">ローカルの学習データ</div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setTopMode("help")}
                    className="w-10 h-10 rounded-full border bg-white flex items-center justify-center"
                    title="ヘルプ"
                  >
                    <span className="material-symbols-outlined">help</span>
                  </button>
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
                    <span className="material-symbols-outlined mx-1">upload</span>{" "}
                    からCSVを追加してください。
                  </div>
                ) : (
                  <ul className="space-y-2">
                    {datasetList.map((meta) => (
                      <li
                        key={meta.id}
                        className="bg-white border rounded-xl px-3 py-2 flex items-center justify-between"
                      >
                        {/* 行の非ボタン部分をクリックで確認→開始 */}
                        <div
                          className="min-w-0 pr-2 flex-1 cursor-pointer"
                          onClick={() => {
                            if (confirm(`「${meta.title}」の学習を開始しますか？`)) {
                              startLearning(meta.id);
                            }
                          }}
                        >
                          <div
                            className="text-sm font-medium truncate"
                            title={meta.title || "NoName"}
                          >
                            {meta.title || "NoName"}
                          </div>
                        </div>

                        <div className="flex items-center gap-2">
                          {/* ダウンロード */}
                          <button
                            className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                            title="ダウンロード"
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadCSV(meta.id);
                            }}
                          >
                            <span className="material-symbols-outlined">
                              download
                            </span>
                          </button>

                          {/* 削除 */}
                          <button
                            className="w-9 h-9 rounded-full border bg-white flex items-center justify-center"
                            title="削除"
                            onClick={(e) => {
                              e.stopPropagation();
                              removeDataset(meta.id, meta.title || "NoName");
                            }}
                          >
                            <span className="material-symbols-outlined">
                              delete
                            </span>
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {topMode === "help" && (
            <div className="h-full w-full bg-white flex flex-col">
              <div className="px-3 py-2 flex items-center justify-between border-b">
                <div className="text-sm font-semibold">ヘルプ</div>
                <button
                  className="text-sm underline"
                  onClick={() => setTopMode("select")}
                >
                  戻る
                </button>
              </div>
              <div className="p-3 text-sm leading-relaxed overflow-auto">
                <p className="mb-2">
                  このサイトは、YouTubeの読み上げ教材などから
                  <span className="font-semibold">苦手な単語だけ</span>
                  を抽出して繰り返し再生するためのツールです。
                </p>
                <ul className="list-disc pl-5 space-y-1 mb-3">
                  <li>画面右上の <span className="material-symbols-outlined align-middle text-base">upload</span> からCSVをアップロードします。</li>
                  <li>1行目に動画URL/ID、2行目にヘッダ（例：<code>秒数,見出し語,習熟度</code>）、3行目以降にデータを記述。</li>
                  <li>見出し語は空でもOK。習熟度は空白=0(未習)／1(既知)。</li>
                  <li>アップ後、一覧の行をタップ → 確認で学習開始。</li>
                  <li>学習画面下の一覧で単語名をタップすると、その位置へジャンプします。</li>
                  <li>「知ってる」ボタンで未知⇄既知を切替できます。</li>
                  <li>未習のみを自動で順送り再生します（各単語のループ回数は設定可能）。</li>
                  <li>保存はブラウザのローカルストレージを利用します。</li>
                </ul>
                <p className="text-xs text-gray-500">
                  ※ 広告や埋め込み不可設定の動画では制御が中断される場合があります。第三者のコンテンツを利用する際は権利・利用規約にご注意ください。
                </p>
              </div>
            </div>
          )}

          {topMode === "video" && (
            <div ref={iframeWrap} className="w-full h-full" />
          )}
        </div>

        {/* 学習時の操作群（videoモードのみ表示） */}
        {topMode === "video" && (
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
              <div />
              <div className="flex items-end justify-end">
                {/* 右側余白（今後の拡張用） */}
              </div>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2">
              <button
                className="rounded-2xl py-3 bg-black text-white"
                onClick={handlePlayUnknown}
              >
                未習を再生
              </button>
              {/* ▼ 「前へ」「次へ」「一時停止」ボタンを削除しました */}
              <div className="col-span-2" />
            </div>

            {/* Words list → 2列（左=単語名 / 右=知ってる） */}
            <div className="mt-6">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-gray-600">
                  総単語 {segments.length} ／ 既知 {knownCount}
                </div>
              </div>

              <div className="border rounded-xl overflow-hidden">
                {/* header row */}
                <div className="grid grid-cols-[1fr_auto] gap-2 bg-gray-50 px-3 py-2 text-xs text-gray-500">
                  <div className="text-left">単語名</div>
                  <div className="text-right">知ってる</div>
                </div>

                <div className="max-h-80 overflow-auto divide-y">
                  {segments.map((seg, idx) => {
                    const key = seg.word || `t=${seg.start}`;
                    const known = !!knownWords[key];
                    return (
                      <div
                        key={idx}
                        className="grid grid-cols-[1fr_auto] items-center gap-2 px-3 py-2"
                      >
                        <button
                          className="text-left text-sm truncate"
                          onClick={() => playAtTime(seg.start)}
                        >
                          {seg.word || ""}
                        </button>
                        <button
                          className={`w-9 h-9 rounded-full border flex items-center justify-center ${
                            known ? "bg-gray-100" : "bg-amber-100"
                          }`}
                          onClick={() => toggleKnown(key)}
                          title={known ? "未知に戻す" : "知ってるにする"}
                        >
                          <span className="material-symbols-outlined text-[18px]">
                            {known ? "task_alt" : "radio_button_unchecked"}
                          </span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
